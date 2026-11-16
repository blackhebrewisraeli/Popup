-- Scenario snapshots on Manual Spot experiments (20261117120000): optional,
-- shape-checked, owner-only and append-only. SYNTHETIC rows only: ZCT* pairs,
-- invented IDs; the snapshots are what the planner gives for invented inputs.
begin;

create extension if not exists pgtap with schema extensions;

select plan(54);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000051'),
  ('00000000-0000-4000-8000-000000000052');
insert into public.binance_spot_owner (user_id) values ('00000000-0000-4000-8000-000000000051');

-- planSpotScenario's output for invented inputs: a small-price pair with the fee
-- unspecified, the same with an explicit zero fee, and the planner's extremes.
create function pg_temp.snap(name text) returns jsonb language sql immutable as $$
  select case name
    when 'no fee' then '{"version":1,"calculationVersion":"spot-scenario-1","inputs":{"allocation":"15","maxLoss":"1","entry":"0.00000612","stop":"0.0000055","feePercent":null},"figures":{"quantity":"1,612,903.22580645","limitedBy":"maxLoss","notional":"9.87","unallocated":"5.13","stopDistance":"0.00000062","stopDistancePercent":"10.13%","lossAtStop":"1.00","fees":null}}'
    when 'zero fee' then '{"version":1,"calculationVersion":"spot-scenario-1","inputs":{"allocation":"15","maxLoss":"1","entry":"0.00000612","stop":"0.0000055","feePercent":"0"},"figures":{"quantity":"1,612,903.22580645","limitedBy":"maxLoss","notional":"9.87","unallocated":"5.13","stopDistance":"0.00000062","stopDistancePercent":"10.13%","lossAtStop":"1.00","fees":{"entry":"0.00","exit":"0.00","lossWithFees":"1.00"}}}'
    when 'extreme' then '{"version":1,"calculationVersion":"spot-scenario-1","inputs":{"allocation":"1000","maxLoss":"1000","entry":"1000000000","stop":"0.00000001","feePercent":"1"},"figures":{"quantity":"0.00000099","limitedBy":"both","notional":"990.00","unallocated":"0.10","stopDistance":"999,999,999.99999999","stopDistancePercent":"100.00%","lossAtStop":"990.00","fees":{"entry":"9.90","exit":"<0.01","lossWithFees":"999.90"}}}'
  end::jsonb
$$;

-- The insert a client sends, with a snapshot.
create function pg_temp.record(decision text, snapshot jsonb) returns text language sql immutable as $$
  select format(
    'insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, scenario_snapshot)
     values (%L, %L, %L, repeat(%L, 64), %L, %L, %L, %L)',
    'main', 'ZCTSUSDT', '20261110T120000Z-0000abcd', 'a', 'match', '{}', decision, snapshot
  )
$$;

-- ── The column and who may write it ────────────────────────────────────────

select has_column('public', 'spot_experiments', 'scenario_snapshot', 'experiments have a scenario snapshot column');
select col_type_is('public', 'spot_experiments', 'scenario_snapshot', 'jsonb', 'the snapshot is JSON');
select col_is_null('public', 'spot_experiments', 'scenario_snapshot', 'the snapshot is optional: null means no scenario recorded');
select col_hasnt_default('public', 'spot_experiments', 'scenario_snapshot', 'nothing fills a snapshot in by default');
select is(
  has_column_privilege('authenticated', 'public.spot_experiments', 'scenario_snapshot', 'INSERT'), true,
  'signed-in clients may send a snapshot with a new experiment'
);
select results_eq(
  $$select has_column_privilege('authenticated', 'public.spot_experiments', 'scenario_snapshot', 'UPDATE'),
           has_table_privilege('authenticated', 'public.spot_experiments', 'UPDATE'),
           has_table_privilege('authenticated', 'public.spot_experiments', 'DELETE'),
           has_table_privilege('authenticated', 'public.spot_experiments', 'TRUNCATE'),
           has_column_privilege('authenticated', 'public.spot_experiments', 'recorded_at', 'INSERT'),
           has_column_privilege('authenticated', 'public.spot_experiments', 'user_id', 'INSERT'),
           has_column_privilege('authenticated', 'public.spot_experiments', 'id', 'INSERT'),
           has_column_privilege('service_role', 'public.spot_experiments', 'scenario_snapshot', 'INSERT'),
           has_column_privilege('service_role', 'public.spot_experiments', 'scenario_snapshot', 'UPDATE'),
           has_column_privilege('anon', 'public.spot_experiments', 'scenario_snapshot', 'SELECT'),
           has_column_privilege('anon', 'public.spot_experiments', 'scenario_snapshot', 'INSERT')$$,
  $$values (false, false, false, false, false, false, false, false, false, false, false)$$,
  'no role may change or delete a snapshot, server-set columns stay server-set, the service role and anon may not write it'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'spot_experiments'), 2,
  'experiments keep their two owner-only policies'
);
select is(
  (select count(*)::int from pg_constraint
    where conrelid = 'public.spot_experiments'::regclass and contype = 'f'), 1,
  'the snapshot adds no reference to another table'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000051', true);

-- ── Recording with and without a scenario ──────────────────────────────────

select lives_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTSUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC no scenario')$$,
  'an insert that leaves the snapshot out, as earlier frontends send, still records'
);
select is(
  (select scenario_snapshot is null from public.spot_experiments where decision = 'SYNTHETIC no scenario'), true,
  'and has no scenario recorded'
);
select lives_ok(pg_temp.record('SYNTHETIC no fee', pg_temp.snap('no fee')), 'the owner records an experiment with a scenario');
select is(
  (select scenario_snapshot from public.spot_experiments where decision = 'SYNTHETIC no fee'), pg_temp.snap('no fee'),
  'the snapshot is stored exactly as sent'
);
select results_eq(
  $$select scenario_snapshot #>> '{inputs,allocation}', scenario_snapshot #>> '{inputs,entry}',
           scenario_snapshot #>> '{inputs,stop}', jsonb_typeof(scenario_snapshot #> '{inputs,entry}'),
           jsonb_typeof(scenario_snapshot #> '{inputs,feePercent}'), jsonb_typeof(scenario_snapshot #> '{figures,fees}')
    from public.spot_experiments where decision = 'SYNTHETIC no fee'$$,
  $$values ('15', '0.00000612', '0.0000055', 'string', 'null', 'null')$$,
  'small-price inputs stay strings with every digit; an unspecified fee is null, with no fees in the figures'
);
select lives_ok(pg_temp.record('SYNTHETIC zero fee', pg_temp.snap('zero fee')), 'an explicit zero fee is recorded');
select results_eq(
  $$select scenario_snapshot #>> '{inputs,feePercent}', jsonb_typeof(scenario_snapshot #> '{inputs,feePercent}'),
           scenario_snapshot #>> '{figures,fees,entry}'
    from public.spot_experiments where decision = 'SYNTHETIC zero fee'$$,
  $$values ('0', 'string', '0.00')$$,
  'an explicit zero fee stays "0" with fees in the figures: not the same as unspecified'
);
select lives_ok(
  pg_temp.record('SYNTHETIC extremes', pg_temp.snap('extreme')),
  'the planner''s extremes fit: a 1 billion entry, a 100.00% distance and a "<0.01" fee'
);
select is(
  (select count(*)::int from public.spot_experiment_entries e
    join public.spot_experiments x on x.id = e.experiment_id
    where x.scenario_snapshot is not null), 0,
  'including a scenario writes no rule or any other entry'
);

-- ── The shape check refuses anything else ──────────────────────────────────

select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{version}', '2')),
  '23514', null, 'another snapshot format is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', pg_temp.snap('no fee') - 'calculationVersion'),
  '23514', null, 'a snapshot that names no calculation is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{calculationVersion}', '1')),
  '23514', null, 'a calculation version that is not text is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{calculationVersion}', '"1.0.0-pw200"')),
  '23514', null, 'the signal model''s version is not a scenario calculation');
select throws_ok(pg_temp.record('SYNTHETIC x', pg_temp.snap('no fee') || '{"approved": true}'),
  '23514', null, 'a snapshot with an extra field is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', 'null'::jsonb),
  '23514', null, 'a JSON null is refused: only a missing snapshot means none');
select throws_ok(pg_temp.record('SYNTHETIC x', '[]'::jsonb),
  '23514', null, 'a snapshot that is not an object is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,allocation}', '15')),
  '23514', null, 'an input sent as a JSON number is refused: inputs stay strings');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,entry}', '"0.000006123"')),
  '23514', null, 'an input with more than 8 decimals is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,stop}', '"0.00"')),
  '23514', null, 'a zero input is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,allocation}', '"-15"')),
  '23514', null, 'a signed input is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,allocation}', '"1.5e1"')),
  '23514', null, 'an input with an exponent is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,allocation}', '"1,000"')),
  '23514', null, 'a grouped input is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{inputs,allocation}', to_jsonb(repeat('0', 32) || '15'))),
  '23514', null, 'an input longer than 32 characters is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('zero fee'), '{inputs,feePercent}', '"0.07500"')),
  '23514', null, 'a fee with more than 4 decimals is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', pg_temp.snap('no fee') #- '{inputs,feePercent}'),
  '23514', null, 'inputs that leave the fee out are refused: unspecified is an explicit null');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('zero fee'), '{inputs,feePercent}', 'null')),
  '23514', null, 'fees in the figures with no fee assumed are refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('zero fee'), '{figures,fees}', 'null')),
  '23514', null, 'a stated fee with no fees in the figures is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', pg_temp.snap('no fee') #- '{figures,lossAtStop}'),
  '23514', null, 'figures with one missing are refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{figures,limitedBy}', '"target"')),
  '23514', null, 'an unknown limit is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{figures,notional}', '9.87')),
  '23514', null, 'a figure sent as a JSON number is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{figures,notional}', '"buy 9.87 USDT"')),
  '23514', null, 'a figure that is not display arithmetic is refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('no fee'), '{figures,pnl}', '"1.00"')),
  '23514', null, 'figures with an extra field are refused');
select throws_ok(pg_temp.record('SYNTHETIC x', jsonb_set(pg_temp.snap('zero fee'), '{figures,fees,total}', '"0.00"')),
  '23514', null, 'fees with an extra field are refused');

-- ── Owner-only and append-only ─────────────────────────────────────────────

select throws_ok(
  $$insert into public.spot_experiments (recorded_at, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, scenario_snapshot)
    values (now() - interval '1 year', 'main', 'ZCTSUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC backdated', null)$$,
  '42501', null, 'a client still cannot set the recorded time, snapshot or not'
);
select throws_ok(
  $$update public.spot_experiments set scenario_snapshot = jsonb_set(scenario_snapshot, '{inputs,stop}', '"0.000006"')
    where decision = 'SYNTHETIC no fee'$$,
  '42501', null, 'the owner cannot change a recorded snapshot'
);
select throws_ok(
  $$update public.spot_experiments set scenario_snapshot = pg_temp.snap('no fee') where decision = 'SYNTHETIC no scenario'$$,
  '42501', null, 'the owner cannot add a snapshot to an experiment recorded without one'
);
select throws_ok(
  $$update public.spot_experiments set scenario_snapshot = null where decision = 'SYNTHETIC no fee'$$,
  '42501', null, 'the owner cannot remove a recorded snapshot'
);
select throws_ok(
  $$delete from public.spot_experiments where decision = 'SYNTHETIC no fee'$$,
  '42501', null, 'the owner cannot delete an experiment with a snapshot'
);
select is(
  (select scenario_snapshot from public.spot_experiments where decision = 'SYNTHETIC no fee'), pg_temp.snap('no fee'),
  'the owner reads the snapshot back unchanged'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000052', true);
select throws_ok(pg_temp.record('SYNTHETIC intruder', pg_temp.snap('no fee')),
  '42501', null, 'a signed-in user who is not the owner cannot record a snapshot');
select is_empty($$select scenario_snapshot from public.spot_experiments$$,
  'a signed-in user who is not the owner reads no snapshot');

reset role;
set local role anon;
select throws_ok(pg_temp.record('SYNTHETIC anon', pg_temp.snap('no fee')),
  '42501', null, 'anon cannot record a snapshot');
select throws_ok($$select scenario_snapshot from public.spot_experiments$$,
  '42501', null, 'anon cannot read snapshots');

reset role;
set local role service_role;
select is(
  (select count(*)::int from public.spot_experiments where scenario_snapshot is not null), 3,
  'the service role can read snapshots'
);
select throws_ok(
  $$insert into public.spot_experiments (user_id, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, scenario_snapshot)
    values ('00000000-0000-4000-8000-000000000051', 'main', 'ZCTSUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC service', null)$$,
  '42501', null, 'the service role cannot record an experiment'
);
select throws_ok(
  $$update public.spot_experiments set scenario_snapshot = null$$,
  '42501', null, 'the service role cannot change a snapshot'
);

select * from finish();
rollback;
