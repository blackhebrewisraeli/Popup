begin;

create extension if not exists pgtap with schema extensions;
select plan(17);

set local role service_role;

-- SYNTHETIC rows only. The plan JSON is minimal: the database checks only symbol and expiry.
select lives_ok(
  $$insert into public.futures_demo_proposals
      (id, expires_at, environment, symbol, synthetic, plan, plan_sha256, telegram_chat_id)
    values ('70000000-0000-4000-8000-000000000001', clock_timestamp() + interval '5 minutes',
            'binance_futures_demo', 'ZCTAUSDT', true,
            '{"symbol": "ZCTAUSDT", "expiresAt": "synthetic"}', repeat('a', 64), 42)$$,
  'the function stores a synthetic Demo proposal'
);
select throws_ok(
  $$insert into public.futures_demo_proposals
      (id, expires_at, environment, symbol, synthetic, plan, plan_sha256, telegram_chat_id)
    values ('70000000-0000-4000-8000-000000000002', clock_timestamp() + interval '5 minutes',
            'binance_futures_demo', 'ZCTAUSDT', true,
            '{"symbol": "ZCTAUSDT", "expiresAt": "synthetic"}', repeat('b', 64), 42)$$,
  '23505', null, 'only one proposal can be pending'
);
select throws_ok(
  $$insert into public.futures_demo_proposals
      (id, expires_at, environment, symbol, synthetic, plan, plan_sha256, telegram_chat_id, leverage)
    values ('70000000-0000-4000-8000-000000000003', clock_timestamp() + interval '5 minutes',
            'binance_futures_live', 'ZCTAUSDT', true,
            '{"symbol": "ZCTAUSDT", "expiresAt": "synthetic"}', repeat('b', 64), 42, 5)$$,
  '42501', null, 'the function cannot choose leverage, side or margin type columns'
);
select throws_ok(
  $$update public.futures_demo_proposals set plan = '{"symbol": "ZCTAUSDT", "expiresAt": "x"}'$$,
  '42501', null, 'proposal terms cannot be rewritten'
);
update public.futures_demo_proposals set telegram_message_id = 7;
select throws_ok(
  $$update public.futures_demo_proposals set telegram_message_id = 8$$,
  '42501', null, 'the Telegram message is bound once'
);
select throws_ok(
  $$insert into public.futures_demo_executions (proposal_id, state, entry_client_order_id)
    values ('70000000-0000-4000-8000-000000000001', 'claimed', 'pd-' || repeat('1', 28))$$,
  '42501', null, 'a pending proposal cannot be executed'
);
select results_eq(
  $$update public.futures_demo_proposals set status = 'approved', decided_by = 42
    where status = 'pending' returning status, decided_at is not null$$,
  $$values ('approved'::text, true)$$,
  'approval is recorded with the database clock'
);
select throws_ok(
  $$update public.futures_demo_proposals set status = 'rejected'$$,
  '42501', null, 'a decided proposal is never decided again'
);
select throws_ok(
  $$insert into public.futures_demo_executions (proposal_id, state, entry_client_order_id)
    values ('70000000-0000-4000-8000-000000000001', 'protected', 'pd-' || repeat('1', 28))$$,
  '42501', null, 'an execution starts claimed'
);
select lives_ok(
  $$insert into public.futures_demo_executions (proposal_id, state, entry_client_order_id)
    values ('70000000-0000-4000-8000-000000000001', 'claimed', 'pd-' || repeat('1', 28))$$,
  'an approved proposal gets one execution'
);

-- A second approved proposal while the first execution is open.
insert into public.futures_demo_proposals
  (id, expires_at, environment, symbol, synthetic, plan, plan_sha256, telegram_chat_id)
values ('70000000-0000-4000-8000-000000000004', clock_timestamp() + interval '5 minutes',
        'binance_futures_demo', 'ZCTAUSDT', true,
        '{"symbol": "ZCTAUSDT", "expiresAt": "synthetic"}', repeat('c', 64), 42);
update public.futures_demo_proposals set status = 'approved'
  where id = '70000000-0000-4000-8000-000000000004';
select throws_ok(
  $$insert into public.futures_demo_executions (proposal_id, state, entry_client_order_id)
    values ('70000000-0000-4000-8000-000000000004', 'claimed', 'pd-' || repeat('2', 28))$$,
  '23505', null, 'an open (or unresolved) execution blocks any new entry'
);
update public.futures_demo_executions set state = 'closed'
  where proposal_id = '70000000-0000-4000-8000-000000000001';
select throws_ok(
  $$update public.futures_demo_executions set state = 'protected'
    where proposal_id = '70000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'a final state is never left'
);
select lives_ok(
  $$insert into public.futures_demo_executions (proposal_id, state, entry_client_order_id)
    values ('70000000-0000-4000-8000-000000000004', 'claimed', 'pd-' || repeat('2', 28))$$,
  'once the open execution is final, the next approved entry may start'
);

-- Approval at or after expiry, judged by the database clock.
insert into public.futures_demo_proposals
  (id, expires_at, environment, symbol, synthetic, plan, plan_sha256, telegram_chat_id)
values ('70000000-0000-4000-8000-000000000005', clock_timestamp() + interval '20 milliseconds',
        'binance_futures_demo', 'ZCTAUSDT', true,
        '{"symbol": "ZCTAUSDT", "expiresAt": "synthetic"}', repeat('d', 64), 42);
select pg_sleep(0.05);
select throws_ok(
  $$update public.futures_demo_proposals set status = 'approved'
    where id = '70000000-0000-4000-8000-000000000005'$$,
  'P0001', 'futures_demo_proposal_expired', 'an expired proposal cannot be approved'
);
select lives_ok(
  $$update public.futures_demo_proposals set status = 'expired'
    where id = '70000000-0000-4000-8000-000000000005'$$,
  'the tick marks it expired'
);
select throws_ok(
  $$delete from public.futures_demo_events$$,
  '42501', null, 'no row is ever deleted'
);

reset role;
set local role authenticated;
select throws_ok(
  $$select id from public.futures_demo_proposals$$,
  '42501', null, 'browser roles have no access'
);

select * from finish();
rollback;
