-- An owner-reviewed decision to stay out, with the saved scan evidence it used.
create table public.spot_no_entry_decisions (
  -- Generated once per submission by the browser so a lost response can be retried safely.
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  recorded_at timestamptz not null default clock_timestamp(),
  symbol text not null check (symbol ~ '^[A-Z0-9]{1,20}USDT$'),
  source_scan_id text not null check (source_scan_id ~ '^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$'),
  source_snapshot_sha256 text not null check (source_snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  source_evidence jsonb not null check (
    jsonb_typeof(source_evidence) = 'object' and octet_length(source_evidence::text) <= 8192
  ),
  reason text not null check (
    reason ~ '[^[:space:]]' and char_length(reason) <= 1000
  )
);

create index spot_no_entry_decisions_history_idx
  on public.spot_no_entry_decisions (user_id, recorded_at desc, id desc);

alter table public.spot_no_entry_decisions enable row level security;
revoke all on table public.spot_no_entry_decisions from public, anon, authenticated, service_role;
grant select on table public.spot_no_entry_decisions to authenticated;
grant insert (id, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason)
  on table public.spot_no_entry_decisions to authenticated;

create policy "The configured Binance owner reads their no-entry decisions"
  on public.spot_no_entry_decisions for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_binance_spot_owner()));

create policy "The configured Binance owner records their no-entry decisions"
  on public.spot_no_entry_decisions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_binance_spot_owner()));
