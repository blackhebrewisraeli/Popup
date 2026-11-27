begin;

create extension if not exists pgtap with schema extensions;
select plan(9);

set local role service_role;

select lives_ok(
  $$insert into public.futures_telegram_tests (id, expires_at, telegram_chat_id)
    values ('71000000-0000-4000-8000-000000000001', clock_timestamp() + interval '10 minutes', 42)$$,
  'the function stores a TEST'
);
select throws_ok(
  $$insert into public.futures_telegram_tests (id, expires_at, telegram_chat_id)
    values ('71000000-0000-4000-8000-000000000002', clock_timestamp() + interval '10 minutes', 42)$$,
  '23505', null, 'only one TEST can be pending'
);
update public.futures_telegram_tests set telegram_message_id = 7;
select throws_ok(
  $$update public.futures_telegram_tests set telegram_message_id = 8$$,
  '42501', null, 'the Telegram message is bound once'
);
select results_eq(
  $$update public.futures_telegram_tests set status = 'approved', decided_by = 42
    where status = 'pending' returning status, decided_at is not null$$,
  $$values ('approved'::text, true)$$,
  'the first press decides, with the database clock'
);
select is_empty(
  $$update public.futures_telegram_tests set status = 'rejected'
    where status = 'pending' returning id$$,
  'a second press changes nothing'
);
select throws_ok(
  $$update public.futures_telegram_tests set status = 'rejected'$$,
  '42501', null, 'a decided TEST is never decided again'
);

insert into public.futures_telegram_tests (id, expires_at, telegram_chat_id)
values ('71000000-0000-4000-8000-000000000003', clock_timestamp() + interval '20 milliseconds', 42);
select pg_sleep(0.05);
select throws_ok(
  $$update public.futures_telegram_tests set status = 'approved'
    where id = '71000000-0000-4000-8000-000000000003'$$,
  'P0001', 'futures_telegram_test_expired', 'an expired TEST accepts no decision'
);
select throws_ok(
  $$delete from public.futures_telegram_tests$$,
  '42501', null, 'no row is ever deleted'
);

reset role;
set local role authenticated;
select throws_ok(
  $$select id from public.futures_telegram_tests$$,
  '42501', null, 'browser roles have no access'
);

select * from finish();
rollback;
