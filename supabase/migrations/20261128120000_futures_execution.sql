-- Owner-approved Binance USDⓈ-M Futures execution (docs/FUTURES_EXECUTION.md).
--
-- Only the futures-execution Edge Function reads or writes these tables, with the project's secret
-- key (service_role). No browser role has any privilege. Nothing here references Spot experiments
-- or paper trading. The migration only adds; it places no order and enables nothing.
--
-- What the database guarantees, whatever the function does:
--   * a proposal's terms never change after it is stored, and it is decided once;
--   * approval is refused by the database clock at or after the proposal's expiry;
--   * at most one proposal is pending and at most one execution is not final, so an unresolved
--     execution blocks every new entry;
--   * an execution exists only for an approved proposal, one per proposal, and a final state is
--     never left;
--   * no row is ever deleted.

create table public.futures_proposals (
  id uuid primary key,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  environment text not null check (environment = 'binance_usdm_futures'),
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,20}USDT$'),
  side text not null default 'LONG' check (side = 'LONG'),
  leverage smallint not null default 5 check (leverage = 5),
  margin_type text not null default 'ISOLATED' check (margin_type = 'ISOLATED'),
  -- Every approved term, exactly as hashed and shown in Telegram.
  plan jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 8192),
  plan_sha256 text not null check (plan_sha256 ~ '^[0-9a-f]{64}$'),
  telegram_chat_id bigint not null,
  telegram_message_id bigint,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  decided_by bigint,
  check (expires_at > created_at),
  check ((status = 'pending') = (decided_at is null)),
  check (plan ->> 'symbol' = symbol and plan ->> 'expiresAt' is not null)
);

create unique index futures_one_pending_proposal
  on public.futures_proposals ((true)) where status = 'pending';

create function public.futures_guard_proposal()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.created_at, new.expires_at, new.environment, new.symbol, new.side, new.leverage,
      new.margin_type, new.plan, new.plan_sha256, new.telegram_chat_id)
     is distinct from
     (old.id, old.created_at, old.expires_at, old.environment, old.symbol, old.side, old.leverage,
      old.margin_type, old.plan, old.plan_sha256, old.telegram_chat_id) then
    raise exception 'futures_proposal_immutable' using errcode = '42501';
  end if;
  if old.telegram_message_id is not null
     and new.telegram_message_id is distinct from old.telegram_message_id then
    raise exception 'futures_proposal_immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'futures_proposal_decided' using errcode = '42501';
    end if;
    new.decided_at := clock_timestamp();
    if new.status = 'approved' and new.decided_at >= old.expires_at then
      raise exception 'futures_proposal_expired' using errcode = 'P0001';
    end if;
    if new.status = 'expired' then
      new.decided_by := null;
    end if;
  elsif (new.decided_at, new.decided_by) is distinct from (old.decided_at, old.decided_by) then
    raise exception 'futures_proposal_decided' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger futures_guard_proposal
  before update on public.futures_proposals
  for each row execute function public.futures_guard_proposal();

create table public.futures_executions (
  proposal_id uuid primary key references public.futures_proposals (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  state text not null check (state in (
    'claimed', 'refused', 'entry_unknown', 'not_filled', 'protecting', 'protected',
    'unresolved', 'closed', 'abandoned'
  )),
  -- Binance newClientOrderId of the single entry order, derived from the proposal id.
  entry_client_order_id text not null unique check (entry_client_order_id ~ '^pf-[0-9a-f]{28}$'),
  entry_submitted_at timestamptz,
  filled_qty text check (filled_qty ~ '^[0-9]+(\.[0-9]+)?$'),
  avg_price text check (avg_price ~ '^[0-9]+(\.[0-9]+)?$'),
  protection jsonb not null default '{}'
    check (jsonb_typeof(protection) = 'object' and octet_length(protection::text) <= 4096),
  close_attempts smallint not null default 0 check (close_attempts between 0 and 10),
  detail text check (char_length(detail) <= 1000),
  alerted text check (char_length(alerted) <= 200),
  -- Held by the invocation driving this row; the scheduled tick skips it until it lapses.
  lease_until timestamptz,
  -- Net USDT from Binance income once closed (realized PnL, commission, funding). Written once.
  realized_pnl text check (realized_pnl ~ '^-?[0-9]+(\.[0-9]+)?$'),
  check (realized_pnl is null or (state = 'closed' and filled_qty is not null))
);

create unique index futures_one_open_execution
  on public.futures_executions ((true))
  where state not in ('refused', 'not_filled', 'closed', 'abandoned');

create function public.futures_guard_execution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'claimed' then
      raise exception 'futures_execution_starts_claimed' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.futures_proposals p
      where p.id = new.proposal_id and p.status = 'approved'
    ) then
      raise exception 'futures_execution_not_approved' using errcode = '42501';
    end if;
  else
    if (new.proposal_id, new.created_at, new.entry_client_order_id)
       is distinct from (old.proposal_id, old.created_at, old.entry_client_order_id) then
      raise exception 'futures_execution_immutable' using errcode = '42501';
    end if;
    if old.state in ('refused', 'not_filled', 'closed', 'abandoned')
       and new.state is distinct from old.state then
      raise exception 'futures_execution_final' using errcode = '42501';
    end if;
    if old.realized_pnl is not null and new.realized_pnl is distinct from old.realized_pnl then
      raise exception 'futures_execution_result_recorded' using errcode = '42501';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger futures_guard_execution
  before insert or update on public.futures_executions
  for each row execute function public.futures_guard_execution();

-- Append-only audit of decisions and Binance outcomes (secret-free summaries).
create table public.futures_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  proposal_id uuid references public.futures_proposals (id),
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  detail jsonb not null default '{}'
    check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 4096)
);

create index futures_events_proposal_idx on public.futures_events (proposal_id, at);

alter table public.futures_proposals enable row level security;
alter table public.futures_executions enable row level security;
alter table public.futures_events enable row level security;

revoke all on table public.futures_proposals, public.futures_executions,
  public.futures_events from public, anon, authenticated, service_role;
revoke all on function public.futures_guard_proposal(), public.futures_guard_execution()
  from public, anon, authenticated, service_role;

grant select on table public.futures_proposals to service_role;
grant insert (id, expires_at, environment, symbol, plan, plan_sha256, telegram_chat_id)
  on table public.futures_proposals to service_role;
grant update (telegram_message_id, status, decided_by)
  on table public.futures_proposals to service_role;

grant select on table public.futures_executions to service_role;
grant insert (proposal_id, state, entry_client_order_id, lease_until)
  on table public.futures_executions to service_role;
grant update (state, entry_submitted_at, filled_qty, avg_price, protection, close_attempts, detail,
  alerted, lease_until, realized_pnl)
  on table public.futures_executions to service_role;

grant select on table public.futures_events to service_role;
grant insert (proposal_id, kind, detail) on table public.futures_events to service_role;
