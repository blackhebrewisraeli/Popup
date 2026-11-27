-- Telegram smoke tests for the futures-execution bot (docs/FUTURES_EXECUTION.md#telegram-smoke-test).
--
-- A TEST message's one-time decision, kept apart from futures_proposals so a smoke test can never
-- become a trading proposal or an execution. Only the futures-execution Edge Function reads or
-- writes it, with the project's secret key (service_role). The migration only adds.
--
-- What the database guarantees: a TEST's identity never changes; its Telegram message is bound
-- once; it is decided once; no decision is accepted at or after its expiry (database clock); at
-- most one TEST is pending; no row is deleted.

create table public.futures_telegram_tests (
  id uuid primary key,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  telegram_chat_id bigint not null,
  telegram_message_id bigint,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz,
  decided_by bigint,
  check (expires_at > created_at),
  check ((status = 'pending') = (decided_at is null))
);

create unique index futures_telegram_tests_one_pending
  on public.futures_telegram_tests ((true)) where status = 'pending';

create function public.futures_guard_telegram_test()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.id, new.created_at, new.expires_at, new.telegram_chat_id)
     is distinct from (old.id, old.created_at, old.expires_at, old.telegram_chat_id) then
    raise exception 'futures_telegram_test_immutable' using errcode = '42501';
  end if;
  if old.telegram_message_id is not null
     and new.telegram_message_id is distinct from old.telegram_message_id then
    raise exception 'futures_telegram_test_immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if old.status <> 'pending' then
      raise exception 'futures_telegram_test_decided' using errcode = '42501';
    end if;
    new.decided_at := clock_timestamp();
    if new.status in ('approved', 'rejected') and new.decided_at >= old.expires_at then
      raise exception 'futures_telegram_test_expired' using errcode = 'P0001';
    end if;
    if new.status = 'expired' then
      new.decided_by := null;
    end if;
  elsif (new.decided_at, new.decided_by) is distinct from (old.decided_at, old.decided_by) then
    raise exception 'futures_telegram_test_decided' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger futures_guard_telegram_test
  before update on public.futures_telegram_tests
  for each row execute function public.futures_guard_telegram_test();

alter table public.futures_telegram_tests enable row level security;
revoke all on table public.futures_telegram_tests from public, anon, authenticated, service_role;
revoke all on function public.futures_guard_telegram_test()
  from public, anon, authenticated, service_role;

grant select on table public.futures_telegram_tests to service_role;
grant insert (id, expires_at, telegram_chat_id) on table public.futures_telegram_tests
  to service_role;
grant update (telegram_message_id, status, decided_by) on table public.futures_telegram_tests
  to service_role;
