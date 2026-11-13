-- Manual Spot experiments (docs/MANUAL_SPOT_EXPERIMENTS.md): one real Binance
-- Spot experiment, traced from the scan it came from, through the owner's
-- decision and rules, to the fills and dated observations the owner adds.
--
-- Only the configured Binance owner can read or add rows, and no application
-- role can change or delete one. Nothing here references, reads or writes
-- paper trading, tracked holdings or simulations. The migration only adds:
-- it changes no existing table, policy, grant or function.

-- The Popup user whose Binance Spot account this is. It must name the same user
-- as the binance-spot-account function's BINANCE_SPOT_OWNER_USER_ID, which the
-- database cannot read. A database administrator sets it in the SQL editor.
-- While it is empty, nobody can read or add an experiment.
create table public.binance_spot_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users (id) on delete cascade
);

alter table public.binance_spot_owner enable row level security;
revoke all on table public.binance_spot_owner from anon, authenticated, service_role;
-- Signed-in users can see the row only when it names them, so a caller learns
-- whether they are the owner and nothing about who else is.
grant select on table public.binance_spot_owner to authenticated;

create policy "The configured Binance owner sees their own configuration"
  on public.binance_spot_owner for select to authenticated
  using (user_id = (select auth.uid()));

-- Security invoker: it reads the configuration under the policy above.
create function public.is_binance_spot_owner()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.binance_spot_owner o where o.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_binance_spot_owner() from public, anon;
grant execute on function public.is_binance_spot_owner() to authenticated;

create table public.spot_experiments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- The database's clock when the row was stored. Clients can't set it.
  recorded_at timestamptz not null default clock_timestamp(),
  -- The caller's name for the Binance account the fills come from. It scopes
  -- fill identity; it does not prove which Binance account that is.
  account_label text not null check (account_label ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  -- The Binance Spot USDT pair. The scan's instrument is BINANCE:<symbol>.
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,20}USDT$'),
  source_scan_id text not null check (source_scan_id ~ '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'),
  -- Identifies the snapshot file's bytes. It neither authenticates the scan nor
  -- shows that it reproduces.
  source_snapshot_sha256 text not null check (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  -- What the local offline reproduction reported when the record was made. The
  -- database can't re-run it.
  source_reproduction text not null check (source_reproduction in ('match', 'not_checked')),
  -- The candidate's evidence as the browser showed it.
  source_evidence jsonb not null check (
    jsonb_typeof(source_evidence) = 'object' and octet_length(source_evidence::text) <= 8192
  ),
  decision text not null check (btrim(decision) <> '' and char_length(decision) <= 1000),
  -- When the owner says the decision was made; null when not stated. Earlier
  -- than recorded_at means it was recorded afterwards, which is allowed.
  decision_stated_at timestamptz,
  check (decision_stated_at <= recorded_at),
  -- Targets for the children's composite foreign keys.
  unique (id, user_id),
  unique (id, user_id, account_label, symbol)
);

create index spot_experiments_user_id_idx on public.spot_experiments (user_id);

-- Rules, observations and the owner's close, in the owner's words.
create table public.spot_experiment_entries (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null,
  user_id uuid not null default auth.uid(),
  recorded_at timestamptz not null default clock_timestamp(),
  kind text not null check (kind in ('rule', 'observation', 'close')),
  rule text check (rule in ('allocation_ceiling', 'stop', 'horizon', 'target', 'exit', 'other')),
  rule_status text check (rule_status in ('approved', 'proposed', 'withdrawn')),
  -- The earlier rule entry of the same experiment and rule that this one
  -- replaces. Each entry is replaced at most once, so a rule's history is a line.
  supersedes uuid unique,
  -- Where the owner saw what an observation describes.
  observed_in text check (observed_in in ('binance_interface', 'elsewhere')),
  statement text not null check (btrim(statement) <> '' and char_length(statement) <= 1000),
  -- The owner's time: when a rule was set, something was observed, or the
  -- experiment ended. Required for an observation.
  stated_at timestamptz,
  check (stated_at <= recorded_at),
  check ((kind = 'rule') = (rule is not null)),
  check ((kind = 'rule') = (rule_status is not null)),
  check (kind = 'rule' or supersedes is null),
  check (rule_status <> 'withdrawn' or supersedes is not null),
  check ((kind = 'observation') = (observed_in is not null)),
  check (kind <> 'observation' or stated_at is not null),
  foreign key (experiment_id, user_id)
    references public.spot_experiments (id, user_id) on delete cascade,
  unique (id, experiment_id, rule),
  foreign key (supersedes, experiment_id, rule)
    references public.spot_experiment_entries (id, experiment_id, rule)
);

create index spot_experiment_entries_experiment_idx
  on public.spot_experiment_entries (experiment_id, user_id);
-- A named rule starts one line of entries, so it has one current version.
-- 'other' may hold several unrelated rules.
create unique index spot_experiment_entries_one_rule_line
  on public.spot_experiment_entries (experiment_id, rule)
  where kind = 'rule' and supersedes is null and rule <> 'other';
-- Closing is one explicit act. No fill or quantity closes an experiment.
create unique index spot_experiment_entries_one_close
  on public.spot_experiment_entries (experiment_id) where kind = 'close';

-- Fills copied by the browser from a Popup Binance read: client-submitted
-- evidence, not verified by the server against Binance. Values are Binance's
-- decimal strings, stored exactly as sent.
create table public.spot_experiment_fills (
  id uuid primary key default gen_random_uuid(),
  experiment_id uuid not null,
  user_id uuid not null default auth.uid(),
  -- Must equal the experiment's (foreign key below).
  account_label text not null,
  symbol text not null,
  recorded_at timestamptz not null default clock_timestamp(),
  trade_id text not null check (trade_id ~ '^[0-9]{1,20}$'),
  order_id text not null check (order_id ~ '^[0-9]{1,20}$'),
  side text not null check (side in ('buy', 'sell')),
  -- Binance's trade time, in milliseconds since the epoch.
  trade_time_ms bigint not null check (trade_time_ms > 0),
  quantity text not null check (quantity ~ '^[0-9]{1,20}(\.[0-9]{1,20})?$' and quantity ~ '[1-9]'),
  price text not null check (price ~ '^[0-9]{1,20}(\.[0-9]{1,20})?$' and price ~ '[1-9]'),
  quote_quantity text not null check (
    quote_quantity ~ '^[0-9]{1,20}(\.[0-9]{1,20})?$' and quote_quantity ~ '[1-9]'
  ),
  commission text not null check (commission ~ '^[0-9]{1,20}(\.[0-9]{1,20})?$'),
  commission_asset text not null check (char_length(commission_asset) between 1 and 32),
  -- The read it was copied from, as the browser reports it: the function's
  -- clock, the requested window, and whether every page of it was read.
  retrieved_at timestamptz not null,
  window_start_ms bigint not null,
  window_end_ms bigint not null,
  coverage_complete boolean not null,
  check (window_start_ms > 0 and window_start_ms < window_end_ms),
  check (window_end_ms - window_start_ms <= 86400000),
  check (trade_time_ms between window_start_ms and window_end_ms),
  foreign key (experiment_id, user_id, account_label, symbol)
    references public.spot_experiments (id, user_id, account_label, symbol) on delete cascade,
  -- One trade belongs to one experiment, within one owner and account label.
  unique (user_id, account_label, symbol, trade_id)
);

create index spot_experiment_fills_experiment_idx
  on public.spot_experiment_fills (experiment_id, user_id, account_label, symbol);

comment on table public.spot_experiment_fills is
  'Client-submitted copies of fills from a Popup Binance read. Not verified by the server against Binance.';

alter table public.spot_experiments enable row level security;
alter table public.spot_experiment_entries enable row level security;
alter table public.spot_experiment_fills enable row level security;

-- Append-only for every application role. The service role may read but never
-- write. A database administrator can still bypass these privileges.
revoke all on table
  public.spot_experiments,
  public.spot_experiment_entries,
  public.spot_experiment_fills
from anon, authenticated, service_role;

grant select on table
  public.spot_experiments,
  public.spot_experiment_entries,
  public.spot_experiment_fills
to authenticated, service_role;

-- Clients name the content only. The id, owner and recorded time come from the
-- database.
grant insert (
  account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction,
  source_evidence, decision, decision_stated_at
) on public.spot_experiments to authenticated;

grant insert (
  experiment_id, kind, rule, rule_status, supersedes, observed_in, statement, stated_at
) on public.spot_experiment_entries to authenticated;

grant insert (
  experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price,
  quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms,
  coverage_complete
) on public.spot_experiment_fills to authenticated;

create policy "The configured Binance owner reads their experiments"
  on public.spot_experiments for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_binance_spot_owner()));

create policy "The configured Binance owner records experiments"
  on public.spot_experiments for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_binance_spot_owner()));

create policy "The configured Binance owner reads their experiment entries"
  on public.spot_experiment_entries for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_binance_spot_owner()));

create policy "The configured Binance owner records experiment entries"
  on public.spot_experiment_entries for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_binance_spot_owner()));

create policy "The configured Binance owner reads their experiment fills"
  on public.spot_experiment_fills for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_binance_spot_owner()));

create policy "The configured Binance owner links experiment fills"
  on public.spot_experiment_fills for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_binance_spot_owner()));
