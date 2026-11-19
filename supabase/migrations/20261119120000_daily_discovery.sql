-- Daily discovery (docs/MARKET_SCANNER.md#daily-discovery-binance-spot-unattended): dated
-- batches of a liquidity-based shortlist of Binance Spot USDT pairs, and one row per
-- collection attempt. A dedicated Auth user whose app_metadata role is
-- 'discovery_automation' adds them; only the configured owner (is_binance_spot_owner())
-- reads them. No client can change or delete a row, and no client sets who recorded it or
-- when. The migration only adds: it changes no existing table, policy, grant or function,
-- and nothing here reads or writes assets_status, campaigns, signals or experiments.

-- Whether a batch's evidence has every field its columns repeat, each of the right JSON type and
-- agreeing with them, with every collection time in the collector's exact form and in order.
-- A missing key, a JSON null, a wrong type or an unreadable time is false, never null, so the
-- check fails closed. This is structural consistency only: it does not authenticate what
-- Binance sent. The board re-derives membership from the stored inputs before showing any.
create function public.discovery_evidence_consistent(
  evidence jsonb,
  policy_id text,
  slot_date date,
  scheduled_for timestamptz,
  collected_at timestamptz,
  status text,
  member_count integer
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  iso constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  path text;
  info_requested timestamptz;
  info_received timestamptz;
  ticker_requested timestamptz;
  ticker_received timestamptz;
begin
  if not coalesce(
    jsonb_typeof(evidence) = 'object'
    and evidence -> 'schemaVersion' = '1'::jsonb
    and jsonb_typeof(evidence -> 'policy') = 'object'
    and jsonb_typeof(evidence #> '{policy,id}') = 'string'
    and evidence #>> '{policy,id}' = policy_id
    and jsonb_typeof(evidence #> '{policy,sha256}') = 'string'
    and evidence #>> '{policy,sha256}' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(evidence -> 'slot') = 'object'
    and jsonb_typeof(evidence #> '{slot,date}') = 'string'
    and evidence #>> '{slot,date}' = to_char(slot_date, 'YYYY-MM-DD')
    and jsonb_typeof(evidence -> 'collection') = 'object'
    and jsonb_typeof(evidence #> '{collection,exchangeInfo}') = 'object'
    and jsonb_typeof(evidence #> '{collection,exchangeInfo,endpoint}') = 'string'
    and jsonb_typeof(evidence #> '{collection,exchangeInfo,serverTime}') = 'number'
    and jsonb_typeof(evidence #> '{collection,ticker}') = 'object'
    and jsonb_typeof(evidence #> '{collection,ticker,endpoint}') = 'string'
    and jsonb_typeof(evidence -> 'inputs') = 'object'
    and jsonb_typeof(evidence #> '{inputs,listedSymbols}') = 'number'
    and jsonb_typeof(evidence #> '{inputs,malformedInstruments}') = 'number'
    and jsonb_typeof(evidence #> '{inputs,usdtInstruments}') = 'array'
    and jsonb_typeof(evidence #> '{inputs,tickers}') = 'array'
    and jsonb_typeof(evidence #> '{inputs,invalidTickers}') = 'array'
    and jsonb_typeof(evidence -> 'result') = 'object'
    and jsonb_typeof(evidence #> '{result,status}') = 'string'
    and evidence #>> '{result,status}' = upper(status)
    and jsonb_typeof(evidence #> '{result,coverage}') = 'object'
    and jsonb_typeof(evidence #> '{result,members}') = 'array'
    and jsonb_typeof(evidence #> '{result,exclusions}') = 'array',
    false
  ) then
    return false;
  end if;
  -- Only an array reaches here, so its length can be taken.
  if jsonb_array_length(evidence #> '{result,members}') <> member_count then
    return false;
  end if;
  -- Every time is text in the collector's exact form before any is parsed.
  foreach path in array array[
    '{slot,scheduledFor}', '{slot,retryDeadline}', '{collection,cutoff}',
    '{collection,exchangeInfo,requestedAt}', '{collection,exchangeInfo,receivedAt}',
    '{collection,ticker,requestedAt}', '{collection,ticker,receivedAt}'
  ] loop
    if jsonb_typeof(evidence #> path::text[]) is distinct from 'string'
      or (evidence #>> path::text[]) !~ iso then
      return false;
    end if;
  end loop;
  info_requested := (evidence #>> '{collection,exchangeInfo,requestedAt}')::timestamptz;
  info_received := (evidence #>> '{collection,exchangeInfo,receivedAt}')::timestamptz;
  ticker_requested := (evidence #>> '{collection,ticker,requestedAt}')::timestamptz;
  ticker_received := (evidence #>> '{collection,ticker,receivedAt}')::timestamptz;
  return coalesce(
    (evidence #>> '{slot,scheduledFor}')::timestamptz = scheduled_for
    and (scheduled_for at time zone 'UTC')::date = slot_date
    and ticker_received = collected_at
    and evidence #>> '{collection,cutoff}' = evidence #>> '{collection,ticker,requestedAt}'
    -- The slot, then exchangeInfo, then the ticker, all before the retry deadline.
    and scheduled_for <= info_requested
    and info_requested <= info_received
    and info_received <= ticker_requested
    and ticker_requested <= ticker_received
    and ticker_received < (evidence #>> '{slot,retryDeadline}')::timestamptz,
    false
  );
exception
  -- A time in the right form but impossible ('25:61') is refused like any other, never an error.
  when others then
    return false;
end;
$$;

-- The check runs with the inserting role's privileges, so the automation's role needs it.
revoke all on function public.discovery_evidence_consistent(
  jsonb, text, date, timestamptz, timestamptz, text, integer
) from public, anon;
grant execute on function public.discovery_evidence_consistent(
  jsonb, text, date, timestamptz, timestamptz, text, integer
) to authenticated;

create table public.discovery_batches (
  policy_id text not null check (policy_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  slot_date date not null,
  scheduled_for timestamptz not null,
  -- When the 24-hour ticker response arrived: the batch's collection time.
  collected_at timestamptz not null,
  status text not null check (status in ('complete', 'partial', 'empty')),
  member_count integer not null check (member_count between 0 and 50),
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 1048576
  ),
  -- SHA-256 of the evidence's stable serialization, computed by the collector and checked
  -- again by the board. It identifies the bytes; it does not authenticate them.
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid not null default auth.uid(),
  recorded_at timestamptz not null default clock_timestamp(),
  -- One batch per policy and slot: a retry or a concurrent run can't add a second one.
  primary key (policy_id, slot_date),
  -- The columns repeat the evidence, so a reader is never shown one thing and stored another.
  constraint discovery_batches_evidence_consistent check (
    public.discovery_evidence_consistent(
      evidence, policy_id, slot_date, scheduled_for, collected_at, status, member_count
    )
  ),
  check (collected_at >= scheduled_for)
);

create table public.discovery_attempts (
  -- gh-<run id>-<run attempt> from GitHub Actions, local-<uuid> otherwise.
  attempt_id text primary key check (attempt_id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  policy_id text not null check (policy_id ~ '^[a-z0-9][a-z0-9.-]{0,63}$'),
  slot_date date not null,
  scheduled_for timestamptz not null,
  -- When the runner actually started and finished: never the scheduled time.
  started_at timestamptz not null,
  finished_at timestamptz not null,
  status text not null check (
    status in (
      'complete', 'partial', 'empty', 'already_collected', 'unchanged', 'conflict', 'failed',
      'missed'
    )
  ),
  failure_code text check (failure_code ~ '^[A-Z][A-Z_]{1,39}$'),
  detail text check (char_length(detail) <= 500),
  evidence_sha256 text check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by uuid not null default auth.uid(),
  recorded_at timestamptz not null default clock_timestamp(),
  check (finished_at >= started_at),
  check ((status = 'failed') = (failure_code is not null)),
  check ((status in ('failed', 'missed')) = (evidence_sha256 is null))
);

create index discovery_attempts_latest_idx
  on public.discovery_attempts (policy_id, finished_at desc);

alter table public.discovery_batches enable row level security;
alter table public.discovery_attempts enable row level security;

revoke all on table public.discovery_batches, public.discovery_attempts
  from anon, authenticated, service_role;
grant select on table public.discovery_batches, public.discovery_attempts to authenticated;
-- Column grants: recorded_by and recorded_at always take the database's values.
grant insert (
  policy_id, slot_date, scheduled_for, collected_at, status, member_count, evidence,
  evidence_sha256
) on table public.discovery_batches to authenticated;
grant insert (
  attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status,
  failure_code, detail, evidence_sha256
) on table public.discovery_attempts to authenticated;

-- app_metadata is set by an administrator, never by the user, as for the
-- private-campaign-evidence storage policies.
create policy "The configured owner reads discovery batches"
  on public.discovery_batches for select to authenticated
  using ((select public.is_binance_spot_owner()));
create policy "Discovery automation reads discovery batches"
  on public.discovery_batches for select to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'discovery_automation');
create policy "Discovery automation records batches"
  on public.discovery_batches for insert to authenticated
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'discovery_automation');

create policy "The configured owner reads discovery attempts"
  on public.discovery_attempts for select to authenticated
  using ((select public.is_binance_spot_owner()));
create policy "Discovery automation reads discovery attempts"
  on public.discovery_attempts for select to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'discovery_automation');
create policy "Discovery automation records attempts"
  on public.discovery_attempts for insert to authenticated
  with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'discovery_automation');

-- History stays as recorded, for every role: a wrong batch is answered by the next slot,
-- never by editing this one.
create function public.refuse_discovery_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Daily discovery evidence is immutable: % on % refused', tg_op, tg_table_name
    using errcode = '42501';
end;
$$;

revoke all on function public.refuse_discovery_change() from public, anon, authenticated;

create trigger discovery_batches_immutable
  before update or delete on public.discovery_batches
  for each row execute function public.refuse_discovery_change();
create trigger discovery_batches_no_truncate
  before truncate on public.discovery_batches
  for each statement execute function public.refuse_discovery_change();
create trigger discovery_attempts_immutable
  before update or delete on public.discovery_attempts
  for each row execute function public.refuse_discovery_change();
create trigger discovery_attempts_no_truncate
  before truncate on public.discovery_attempts
  for each statement execute function public.refuse_discovery_change();
