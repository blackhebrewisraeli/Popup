-- Daily discovery (20261119120000): who can add and read batches and attempts, what the
-- database refuses, and that history can't change. SYNTHETIC rows only: ZCT pairs,
-- invented hashes, times and IDs.
begin;

create extension if not exists pgtap with schema extensions;

select plan(73);

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


-- Complete evidence shaped like the collector's, whose columns agree (SYNTHETIC values).
create function pg_temp.at(slot date, clock text) returns text language sql as $$
  select to_char(slot + clock::time, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
create function pg_temp.evidence(slot date, members int default 1, status text default 'complete')
returns jsonb language sql as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'policy', jsonb_build_object('id', 'binance-spot-usdt-liquidity-v1', 'sha256', repeat('b', 64)),
    'slot', jsonb_build_object(
      'date', to_char(slot, 'YYYY-MM-DD'),
      'scheduledFor', pg_temp.at(slot, '00:30'),
      'retryDeadline', pg_temp.at(slot, '06:00')
    ),
    'collection', jsonb_build_object(
      'exchangeInfo', jsonb_build_object(
        'endpoint', 'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT',
        'requestedAt', pg_temp.at(slot, '00:33:00'),
        'receivedAt', pg_temp.at(slot, '00:33:01'),
        'serverTime', (extract(epoch from (slot + time '00:33:01') at time zone 'UTC') * 1000)::bigint
      ),
      'ticker', jsonb_build_object(
        'endpoint', 'https://api.binance.com/api/v3/ticker/24hr?type=MINI',
        'requestedAt', pg_temp.at(slot, '00:33:02'),
        'receivedAt', pg_temp.at(slot, '00:33:03')
      ),
      'cutoff', pg_temp.at(slot, '00:33:02')
    ),
    'inputs', jsonb_build_object(
      'listedSymbols', members, 'malformedInstruments', 0,
      'usdtInstruments', '[]'::jsonb, 'tickers', '[]'::jsonb, 'invalidTickers', '[]'::jsonb
    ),
    'result', jsonb_build_object(
      'status', upper(status),
      'coverage', '{}'::jsonb,
      'members', (select coalesce(jsonb_agg(jsonb_build_object('symbol', 'ZCT' || n || 'USDT')), '[]')
                  from generate_series(1, members) n),
      'exclusions', '[]'::jsonb
    )
  );
$$;
-- An insert of this evidence, with the columns of a complete one-member batch unless given.
create function pg_temp.batch_with(
  slot date, evidence jsonb, members int default 1, status text default 'complete'
) returns text language sql as $$
  select format(
    $f$insert into public.discovery_batches
      (policy_id, slot_date, scheduled_for, collected_at, status, member_count, evidence, evidence_sha256)
      values ('binance-spot-usdt-liquidity-v1', %1$L, %2$L, %3$L, %4$L, %5$s, %6$L, %7$L)$f$,
    slot,
    (slot + time '00:30') at time zone 'UTC',
    (slot + time '00:33:03') at time zone 'UTC',
    status,
    members,
    evidence,
    repeat('a', 64)
  );
$$;
create function pg_temp.batch_sql(slot date, members int default 1, status text default 'complete')
returns text language sql as $$
  select pg_temp.batch_with(slot, pg_temp.evidence(slot, members, status), members, status);
$$;
-- A required-field regression: the slot's own evidence with one change, refused as a check.
-- An insert the database accepts is undone and reported as 'accepted', so each case is
-- judged on its own and none can occupy the slot for the next.
create function pg_temp.try_insert(statement text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'accepted' using errcode = 'P0001';
end;
$$;
create function pg_temp.refused(change jsonb, label text) returns text language sql as $$
  select throws_ok(
    format('select pg_temp.try_insert(%L)', pg_temp.batch_with('2026-11-23', change)),
    '23514', null, label
  );
$$;

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

-- ── Required evidence fails closed: missing, JSON null or the wrong type ─────
-- A database check proves the evidence is structurally consistent with its columns. It does
-- not authenticate what Binance sent; the board's verifier re-derives that separately.

select pg_temp.refused('{}', 'an empty evidence object is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') - 'schemaVersion', 'missing schemaVersion is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{policy,id}', 'missing policy.id is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{policy,sha256}', 'missing policy.sha256 is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{slot,date}', 'missing slot.date is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{slot,scheduledFor}', 'missing slot.scheduledFor is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{slot,retryDeadline}', 'missing slot.retryDeadline is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{collection,ticker,receivedAt}', 'missing collection.ticker.receivedAt is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{collection,exchangeInfo}', 'missing collection.exchangeInfo is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{inputs}', 'missing inputs is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{result,status}', 'missing result.status is refused');
select pg_temp.refused(pg_temp.evidence('2026-11-23') #- '{result,members}', 'missing result.members is refused');

select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{schemaVersion}', 'null'), 'a null schemaVersion is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{policy,id}', 'null'), 'a null policy.id is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{slot,date}', 'null'), 'a null slot.date is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{collection,ticker,receivedAt}', 'null'), 'a null receipt time is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{result,status}', 'null'), 'a null result.status is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{result,members}', 'null'), 'null result.members is refused');

select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{schemaVersion}', '"1"'), 'schemaVersion as text is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{policy}', '"binance-spot-usdt-liquidity-v1"'), 'policy as text is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{slot}', '[]'), 'slot as a list is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{collection,ticker,receivedAt}', '1795107530000'), 'a receipt time as a number is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{collection,ticker,receivedAt}', '"2026-11-23T25:61:00.000Z"'), 'an impossible receipt time is refused, not an error');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{collection,exchangeInfo,serverTime}', '"1795107530000"'), 'serverTime as text is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{inputs,tickers}', '{}'), 'inputs.tickers as an object is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{result,status}', '1'), 'result.status as a number is refused');
select pg_temp.refused(jsonb_set(pg_temp.evidence('2026-11-23'), '{result,members}', '{"0": {}}'), 'result.members as an object is refused');

select pg_temp.refused(
  jsonb_set(pg_temp.evidence('2026-11-23'), '{collection,ticker,requestedAt}', to_jsonb(pg_temp.at('2026-11-23', '00:33:04'))),
  'a ticker requested after it was received is refused'
);
select pg_temp.refused(
  jsonb_set(pg_temp.evidence('2026-11-23'), '{collection,cutoff}', to_jsonb(pg_temp.at('2026-11-23', '00:33:01'))),
  'a cutoff other than the ticker request is refused'
);

select is(
  (select count(*)::int from public.discovery_batches where slot_date = '2026-11-23'), 0,
  'no refused insert stored anything'
);
select lives_ok(pg_temp.batch_sql('2026-11-23'), 'the slot stays free: a valid batch for it follows');

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
  (select count(*)::int from public.discovery_batches), 3, 'the owner reads every batch'
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
  (select count(*)::int from public.discovery_batches), 3, 'every batch is still there'
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
