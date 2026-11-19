-- Daily discovery (20261119120000): who can add and read batches and attempts, what the
-- database refuses, and that history can't change. SYNTHETIC rows only: ZCT pairs,
-- invented hashes, times and IDs.
begin;

create extension if not exists pgtap with schema extensions;

select plan(42);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-0000000000d1'), -- the configured owner
  ('00000000-0000-4000-8000-0000000000d2'), -- the discovery automation user
  ('00000000-0000-4000-8000-0000000000d3'); -- anyone else
insert into public.binance_spot_owner (user_id) values ('00000000-0000-4000-8000-0000000000d1');

create temp table separation_before as
select
  (select count(*) from public.assets_status) as assets,
  (select count(*) from public.trading_signals) as signals,
  (select count(*) from public.spot_experiments) as experiments,
  (select count(*) from public.paper_transactions) as fills;


-- A batch row whose columns agree with its evidence.
create function pg_temp.batch_sql(slot date, members int default 1, status text default 'complete')
returns text language sql as $$
  select format(
    $f$insert into public.discovery_batches
      (policy_id, slot_date, scheduled_for, collected_at, status, member_count, evidence, evidence_sha256)
      values ('binance-spot-usdt-liquidity-v1', %1$L, %2$L, %3$L, %4$L, %5$s, %6$L, %7$L)$f$,
    slot,
    (slot + time '00:30') at time zone 'UTC',
    (slot + time '00:33') at time zone 'UTC',
    status,
    members,
    jsonb_build_object(
      'schemaVersion', 1,
      'policy', jsonb_build_object('id', 'binance-spot-usdt-liquidity-v1'),
      'slot', jsonb_build_object(
        'date', slot,
        'scheduledFor', to_char((slot + time '00:30'), 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"')
      ),
      'collection', jsonb_build_object('ticker', jsonb_build_object(
        'receivedAt', to_char((slot + time '00:33'), 'YYYY-MM-DD"T"HH24:MI:SS.000"Z"')
      )),
      'result', jsonb_build_object(
        'status', upper(status),
        'members', (select coalesce(jsonb_agg(jsonb_build_object('symbol', 'ZCT' || n || 'USDT')), '[]')
                    from generate_series(1, members) n)
      )
    ),
    repeat('a', 64)
  );
$$;
grant execute on function pg_temp.batch_sql(date, int, text) to authenticated, anon;

create function pg_temp.as_user(id uuid, role text default null) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', id, 'role', 'authenticated',
    'app_metadata', case when role is null then '{}'::jsonb else jsonb_build_object('role', role) end
  )::text, true);
$$;

-- ── Nobody but the automation user adds rows ─────────────────────────────────

set local role anon;
select throws_ok(pg_temp.batch_sql('2026-11-20'), '42501', null, 'anon cannot add a batch');
select throws_ok(
  $$select count(*) from public.discovery_batches$$, '42501', null, 'anon cannot read batches'
);

set local role authenticated;
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
select throws_ok(pg_temp.batch_sql('2026-11-20'), '42501', null, 'a signed-in user cannot add a batch');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select throws_ok(pg_temp.batch_sql('2026-11-20'), '42501', null, 'the owner cannot add a batch');
-- user_metadata is the user's to edit: it grants nothing.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', '00000000-0000-4000-8000-0000000000d3', 'role', 'authenticated',
  'user_metadata', jsonb_build_object('role', 'discovery_automation')
)::text, true);
select throws_ok(
  pg_temp.batch_sql('2026-11-20'), '42501', null,
  'a role claimed in user_metadata does not make a user the automation'
);

-- ── The automation user adds one batch per slot ──────────────────────────────

select pg_temp.as_user('00000000-0000-4000-8000-0000000000d2', 'discovery_automation');
select lives_ok(pg_temp.batch_sql('2026-11-20', 2), 'the automation user adds a batch');
select results_eq(
  $$select recorded_by, recorded_at <= clock_timestamp() from public.discovery_batches$$,
  $$values ('00000000-0000-4000-8000-0000000000d2'::uuid, true)$$,
  'who recorded it and when come from the database'
);
select throws_ok(
  pg_temp.batch_sql('2026-11-20', 2), '23505', null,
  'an identical retry for the same slot is a duplicate, never a second row'
);
select throws_ok(
  pg_temp.batch_sql('2026-11-20', 3), '23505', null,
  'a conflicting retry for the same slot is a duplicate and changes nothing'
);
select is(
  (select member_count from public.discovery_batches where slot_date = '2026-11-20'), 2,
  'the first batch stands'
);
select throws_ok(
  $$insert into public.discovery_batches
      (policy_id, slot_date, scheduled_for, collected_at, status, member_count, evidence, evidence_sha256, recorded_at)
    select policy_id, '2026-11-21', scheduled_for, collected_at, status, member_count, evidence, evidence_sha256, now() - interval '1 day'
    from public.discovery_batches$$,
  '42501', null, 'the automation user cannot backdate recorded_at'
);
select throws_ok(
  $$insert into public.discovery_batches
      (policy_id, slot_date, scheduled_for, collected_at, status, member_count, evidence, evidence_sha256, recorded_by)
    select policy_id, '2026-11-21', scheduled_for, collected_at, status, member_count, evidence, evidence_sha256, '00000000-0000-4000-8000-0000000000d1'
    from public.discovery_batches$$,
  '42501', null, 'the automation user cannot name another recorder'
);

-- ── Columns must agree with the evidence ─────────────────────────────────────

select throws_ok(
  replace(pg_temp.batch_sql('2026-11-22'), '''complete'', 1,', '''complete'', 2,'),
  '23514', null, 'a member count that disagrees with the evidence is refused'
);
select throws_ok(
  replace(pg_temp.batch_sql('2026-11-22'), '''complete'', 1,', '''partial'', 1,'),
  '23514', null, 'a status that disagrees with the evidence is refused'
);
select throws_ok(
  replace(pg_temp.batch_sql('2026-11-22'), 'values (''binance-spot-usdt-liquidity-v1'', ''2026-11-22''', 'values (''binance-spot-usdt-liquidity-v1'', ''2026-11-23'''),
  '23514', null, 'a slot date that disagrees with the evidence is refused'
);
select throws_ok(
  replace(pg_temp.batch_sql('2026-11-22'), 'values (''binance-spot-usdt-liquidity-v1''', 'values (''another-policy-v1'''),
  '23514', null, 'a policy that disagrees with the evidence is refused'
);
select throws_ok(
  replace(pg_temp.batch_sql('2026-11-22'), repeat('a', 64), 'not-a-hash'),
  '23514', null, 'a malformed evidence hash is refused'
);
select throws_ok(
  pg_temp.batch_sql('2026-11-22', 51), '23514', null, 'more than 50 members is refused'
);
select lives_ok(pg_temp.batch_sql('2026-11-22', 0, 'empty'), 'an empty batch is a valid result');

-- ── Attempts ─────────────────────────────────────────────────────────────────

select lives_ok(
  $$insert into public.discovery_attempts
      (attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status, failure_code, detail)
    values ('gh-9-1', 'binance-spot-usdt-liquidity-v1', '2026-11-21', '2026-11-21T00:30Z',
            '2026-11-21T00:41Z', '2026-11-21T00:41:09Z', 'failed', 'RATE_LIMITED', 'HTTP 429')$$,
  'the automation user records a failed attempt'
);
select throws_ok(
  $$insert into public.discovery_attempts
      (attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status)
    values ('gh-9-1', 'binance-spot-usdt-liquidity-v1', '2026-11-21', '2026-11-21T00:30Z',
            '2026-11-21T00:41Z', '2026-11-21T00:41:09Z', 'missed')$$,
  '23505', null, 'an attempt ID is recorded once'
);
select throws_ok(
  $$insert into public.discovery_attempts
      (attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status)
    values ('gh-9-2', 'binance-spot-usdt-liquidity-v1', '2026-11-21', '2026-11-21T00:30Z',
            '2026-11-21T00:41Z', '2026-11-21T00:41:09Z', 'failed')$$,
  '23514', null, 'a failed attempt needs its failure code'
);
select throws_ok(
  $$insert into public.discovery_attempts
      (attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status)
    values ('gh-9-3', 'binance-spot-usdt-liquidity-v1', '2026-11-21', '2026-11-21T00:30Z',
            '2026-11-21T00:41Z', '2026-11-21T00:41:09Z', 'complete')$$,
  '23514', null, 'a successful attempt names the evidence it stored'
);
select throws_ok(
  $$insert into public.discovery_attempts
      (attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status)
    values ('gh-9-4', 'binance-spot-usdt-liquidity-v1', '2026-11-21', '2026-11-21T00:30Z',
            '2026-11-21T00:41Z', '2026-11-21T00:40Z', 'missed')$$,
  '23514', null, 'an attempt cannot finish before it started'
);
select throws_ok(
  $$insert into public.discovery_attempts
      (attempt_id, policy_id, slot_date, scheduled_for, started_at, finished_at, status)
    values ('gh-9-5', 'binance-spot-usdt-liquidity-v1', '2026-11-21', '2026-11-21T00:30Z',
            '2026-11-21T06:01Z', '2026-11-21T06:01Z', 'late')$$,
  '23514', null, 'an unknown attempt status is refused'
);

-- ── History can't change ─────────────────────────────────────────────────────

select throws_ok(
  $$update public.discovery_batches set member_count = 1$$, '42501', null,
  'the automation user cannot change a batch'
);
select throws_ok(
  $$delete from public.discovery_batches$$, '42501', null, 'the automation user cannot delete a batch'
);
select throws_ok(
  $$update public.discovery_attempts set status = 'complete'$$, '42501', null,
  'the automation user cannot change an attempt'
);

-- ── Who reads ────────────────────────────────────────────────────────────────

select pg_temp.as_user('00000000-0000-4000-8000-0000000000d3');
select is_empty($$select * from public.discovery_batches$$, 'anyone else reads no batch');
select is_empty($$select * from public.discovery_attempts$$, 'anyone else reads no attempt');

select pg_temp.as_user('00000000-0000-4000-8000-0000000000d1');
select is(
  (select count(*)::int from public.discovery_batches), 2, 'the owner reads every batch'
);
select is(
  (select count(*)::int from public.discovery_attempts), 1, 'the owner reads every attempt'
);
select throws_ok(
  $$delete from public.discovery_batches$$, '42501', null, 'the owner cannot delete a batch'
);
select throws_ok(
  $$update public.discovery_attempts set detail = null$$, '42501', null,
  'the owner cannot change an attempt'
);

reset role;
select throws_ok(
  $$update public.discovery_batches set member_count = 1 where slot_date = '2026-11-20'$$,
  '42501', 'Daily discovery evidence is immutable: UPDATE on discovery_batches refused',
  'even a database administrator cannot change a batch'
);
select throws_ok(
  $$delete from public.discovery_attempts$$,
  '42501', 'Daily discovery evidence is immutable: DELETE on discovery_attempts refused',
  'even a database administrator cannot delete an attempt'
);
select throws_ok(
  $$truncate public.discovery_batches$$,
  '42501', 'Daily discovery evidence is immutable: TRUNCATE on discovery_batches refused',
  'nobody can truncate the history'
);
select is(
  (select count(*)::int from public.discovery_batches), 2, 'both batches are still there'
);

set local role service_role;
select throws_ok(
  $$select count(*) from public.discovery_batches$$, '42501', null,
  'the service role has no grant on discovery tables'
);
reset role;

select ok(
  not has_function_privilege('authenticated', 'public.refuse_discovery_change()', 'execute'),
  'clients cannot execute the trigger function'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.discovery_batches'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.discovery_attempts'::regclass),
  true, 'both tables enforce row-level security'
);

select results_eq(
  $$select
      (select count(*) from public.assets_status),
      (select count(*) from public.trading_signals),
      (select count(*) from public.spot_experiments),
      (select count(*) from public.paper_transactions)$$,
  $$select assets, signals, experiments, fills from separation_before$$,
  'nothing outside discovery changed: assets_status, signals, experiments and fills'
);

select * from finish();
rollback;
