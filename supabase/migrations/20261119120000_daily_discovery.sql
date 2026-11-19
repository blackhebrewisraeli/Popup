-- Daily discovery (docs/MARKET_SCANNER.md#daily-discovery-binance-spot-unattended): dated
-- batches of a liquidity-based shortlist of Binance Spot USDT pairs, and one row per
-- collection attempt. A dedicated Auth user whose app_metadata role is
-- 'discovery_automation' adds them; only the configured owner (is_binance_spot_owner())
-- reads them. No client can change or delete a row, and no client sets who recorded it or
-- when. The migration only adds: it changes no existing table, policy, grant or function,
-- and nothing here reads or writes assets_status, campaigns, signals or experiments.

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
  check (evidence ->> 'schemaVersion' = '1'),
  check (evidence -> 'policy' ->> 'id' = policy_id),
  check ((evidence -> 'slot' ->> 'date')::date = slot_date),
  check ((evidence -> 'slot' ->> 'scheduledFor')::timestamptz = scheduled_for),
  check ((evidence -> 'collection' -> 'ticker' ->> 'receivedAt')::timestamptz = collected_at),
  check (evidence -> 'result' ->> 'status' = upper(status)),
  check (
    jsonb_typeof(evidence -> 'result' -> 'members') = 'array'
    and jsonb_array_length(evidence -> 'result' -> 'members') = member_count
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
