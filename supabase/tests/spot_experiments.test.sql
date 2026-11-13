-- Manual Spot experiments (20261114120000): who can read and add them, what
-- the database refuses, and that nothing else is touched. SYNTHETIC rows only:
-- ZCT* pairs, invented IDs, prices and times.
begin;

create extension if not exists pgtap with schema extensions;

select plan(75);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000041'),
  ('00000000-0000-4000-8000-000000000042');

-- Another user's experiment, made by the database owner: no client could.
insert into public.spot_experiments
  (id, user_id, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
values (
  '60000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000042', 'main', 'ZCTAUSDT',
  '20261101T000000Z-0000abcd', repeat('b', 64), 'match', '{}', 'SYNTHETIC other user'
);

create temp table separation_before as
select
  (select count(*) from public.paper_transactions) as fills,
  (select count(*) from public.paper_order_batches) as batches,
  (select count(*) from public.user_portfolios) as portfolios,
  (select count(*) from public.trading_signals) as signals,
  (select count(*) from public.trading_signal_dismissals) as dismissals;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000041', true);

-- ── Access: nobody until an administrator names the owner ──────────────────

select is(public.is_binance_spot_owner(), false, 'with no configured owner, nobody is the owner');
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC unconfigured')$$,
  '42501', null,
  'with no configured owner, a signed-in user cannot record an experiment'
);

reset role;
insert into public.binance_spot_owner (user_id) values ('00000000-0000-4000-8000-000000000041');
set local role authenticated;

select is(public.is_binance_spot_owner(), true, 'the configured user is the owner');
select throws_ok(
  $$insert into public.binance_spot_owner (user_id) values ('00000000-0000-4000-8000-000000000042')$$,
  '42501', null,
  'the owner cannot name another owner'
);
select throws_ok(
  $$update public.binance_spot_owner set user_id = '00000000-0000-4000-8000-000000000042'$$,
  '42501', null,
  'the owner cannot change the configuration'
);

select lives_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, decision_stated_at)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match',
            '{"rank": 1, "long": false, "risk": false}', 'SYNTHETIC E1', now() - interval '2 days')$$,
  'the owner records an experiment, with a decision time two days before recording'
);
select results_eq(
  $$select user_id, recorded_at >= now(), decision_stated_at < recorded_at
    from public.spot_experiments where decision = 'SYNTHETIC E1'$$,
  $$values ('00000000-0000-4000-8000-000000000041'::uuid, true, true)$$,
  'the owner and the recorded time come from the database; the earlier stated time is kept as stated'
);
select lives_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261111T120000Z-0000abcd', repeat('c', 64), 'not_checked', '{}', 'SYNTHETIC E2'),
           ('sub', 'ZCTAUSDT', '20261111T120000Z-0000abcd', repeat('c', 64), 'not_checked', '{}', 'SYNTHETIC E3')$$,
  'a second and third experiment, one under another account label; no decision time is stated'
);

select throws_ok(
  $$insert into public.spot_experiments (user_id, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('00000000-0000-4000-8000-000000000041', 'main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC owner')$$,
  '42501', null,
  'a client cannot name the owner'
);
select throws_ok(
  $$insert into public.spot_experiments (recorded_at, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values (now() - interval '1 year', 'main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC backdated')$$,
  '42501', null,
  'a client cannot set the recorded time'
);
select throws_ok(
  $$insert into public.spot_experiments (id, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('60000000-0000-4000-8000-000000000001', 'main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC id')$$,
  '42501', null,
  'a client cannot choose the ID'
);

-- ── Other signed-in users and anon ─────────────────────────────────────────

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000042', true);
select is(public.is_binance_spot_owner(), false, 'another signed-in user is not the owner');
select is_empty(
  $$select user_id from public.binance_spot_owner$$,
  'another signed-in user cannot read who the owner is'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC intruder')$$,
  '42501', null,
  'a signed-in user who is not the owner cannot record an experiment, even their own'
);
select results_eq(
  $$select (select count(*) from public.spot_experiments)::int,
           (select count(*) from public.spot_experiment_entries)::int,
           (select count(*) from public.spot_experiment_fills)::int$$,
  $$values (0, 0, 0)$$,
  'a user who is not the owner reads nothing, not even an experiment stored under their own ID'
);

reset role;
set local role anon;
select throws_ok($$select 1 from public.spot_experiments$$, '42501', null, 'anon cannot read experiments');
select throws_ok($$select public.is_binance_spot_owner()$$, '42501', null, 'anon cannot ask who the owner is');

-- ── The configuration decides, not the row's owner ID ──────────────────────

reset role;
update public.binance_spot_owner set user_id = '00000000-0000-4000-8000-000000000042';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000041', true);
select is_empty(
  $$select id from public.spot_experiments$$,
  'after the owner changes, the previous owner reads none of their experiments'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC former owner')$$,
  '42501', null,
  'after the owner changes, the previous owner cannot record'
);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000042', true);
select results_eq(
  $$select decision from public.spot_experiments$$,
  $$values ('SYNTHETIC other user')$$,
  'the new owner reads only experiments stored under their own ID'
);

reset role;
delete from public.binance_spot_owner;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000041', true);
select is_empty($$select id from public.spot_experiments$$, 'with the owner removed, access closes again');

reset role;
insert into public.binance_spot_owner (user_id) values ('00000000-0000-4000-8000-000000000041');
set local role authenticated;

-- ── Experiment validation ──────────────────────────────────────────────────

select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTABTC', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC x')$$,
  '23514', null, 'only a USDT pair'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'zctausdt', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC x')$$,
  '23514', null, 'the pair as Binance names it, in capitals'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '2026-11-10-scan', repeat('a', 64), 'match', '{}', 'SYNTHETIC x')$$,
  '23514', null, 'a scan ID in the scanner''s format'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('A', 64), 'match', '{}', 'SYNTHETIC x')$$,
  '23514', null, 'a SHA-256 as 64 lowercase hex digits'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'mismatch', '{}', 'SYNTHETIC x')$$,
  '23514', null, 'a snapshot reported as not reproducing cannot start an experiment'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '[]', 'SYNTHETIC x')$$,
  '23514', null, 'the evidence is an object'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', '   ')$$,
  '23514', null, 'a blank decision is refused'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, decision_stated_at)
    values ('main', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC x', now() + interval '1 day')$$,
  '23514', null, 'a decision time after the recorded time is refused'
);
select throws_ok(
  $$insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('Main Account', 'ZCTAUSDT', '20261110T120000Z-0000abcd', repeat('a', 64), 'match', '{}', 'SYNTHETIC x')$$,
  '23514', null, 'an account label is a short lowercase slug'
);

-- ── Append-only for every application role ─────────────────────────────────

select throws_ok(
  $$update public.spot_experiments set decision = 'rewritten' where decision = 'SYNTHETIC E1'$$,
  '42501', null, 'the owner cannot rewrite an experiment'
);
select throws_ok(
  $$delete from public.spot_experiments where decision = 'SYNTHETIC E1'$$,
  '42501', null, 'the owner cannot delete an experiment'
);
select throws_ok(
  $$truncate public.spot_experiment_fills$$,
  '42501', null, 'the owner cannot truncate fills'
);

-- ── Rules: stated, never inferred ──────────────────────────────────────────

select lives_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, statement, stated_at)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'allocation_ceiling', 'approved', 'SYNTHETIC ceiling', now() - interval '2 days'),
           ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'stop', 'proposed', 'SYNTHETIC stop A', null)$$,
  'the owner records an approved ceiling and a proposed stop'
);
select lives_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, supersedes, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'stop', 'approved',
            (select id from public.spot_experiment_entries where statement = 'SYNTHETIC stop A'), 'SYNTHETIC stop B')$$,
  'a later entry replaces the proposed stop with an approved one'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, supersedes, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'stop', 'approved',
            (select id from public.spot_experiment_entries where statement = 'SYNTHETIC stop A'), 'SYNTHETIC stop C')$$,
  '23505', null, 'an entry is replaced at most once, so a rule has one current version'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'stop', 'approved', 'SYNTHETIC second stop')$$,
  '23505', null, 'a second, unrelated stop rule is refused: a named rule has one line of entries'
);
select lives_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'other', 'proposed', 'SYNTHETIC other A'),
           ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'other', 'approved', 'SYNTHETIC other B')$$,
  'several unrelated other rules can stand side by side'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, supersedes, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'exit', 'approved',
            (select id from public.spot_experiment_entries where statement = 'SYNTHETIC stop B'), 'SYNTHETIC exit')$$,
  '23503', null, 'an exit rule cannot replace a stop rule'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, supersedes, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E2'), 'rule', 'stop', 'approved',
            (select id from public.spot_experiment_entries where statement = 'SYNTHETIC stop B'), 'SYNTHETIC stop E2')$$,
  '23503', null, 'a rule cannot replace another experiment''s rule'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'horizon', 'withdrawn', 'SYNTHETIC x')$$,
  '23514', null, 'a withdrawal names the entry it withdraws'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'rule', 'target', 'SYNTHETIC x')$$,
  '23514', null, 'a rule has a status: approved, proposed or withdrawn'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, observed_in, statement, stated_at)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'observation', 'stop', 'approved', 'binance_interface', 'SYNTHETIC x', now())$$,
  '23514', null, 'an observation cannot carry a rule approval'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, rule, rule_status, statement)
    values ('60000000-0000-4000-8000-000000000099', 'rule', 'stop', 'approved', 'SYNTHETIC x')$$,
  '23503', null, 'the owner cannot add an entry to another user''s experiment'
);
select results_eq(
  $$select e.rule, e.rule_status, e.statement
    from public.spot_experiment_entries e
    where e.experiment_id = (select id from public.spot_experiments where decision = 'SYNTHETIC E1')
      and e.kind = 'rule'
      and not exists (select 1 from public.spot_experiment_entries s where s.supersedes = e.id)
    order by e.rule, e.statement$$,
  $$values ('allocation_ceiling', 'approved', 'SYNTHETIC ceiling'), ('other', 'proposed', 'SYNTHETIC other A'),
           ('other', 'approved', 'SYNTHETIC other B'), ('stop', 'approved', 'SYNTHETIC stop B')$$,
  'current rules are the entries not replaced; horizon, target and exit have none, so nothing is decided for them'
);

-- ── Observations: dated, never a current status ────────────────────────────

select lives_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, observed_in, statement, stated_at)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'observation', 'binance_interface', 'SYNTHETIC stop order seen open', now() - interval '1 day')$$,
  'the owner records what they saw in Binance, and when'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, observed_in, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'observation', 'binance_interface', 'SYNTHETIC x')$$,
  '23514', null, 'an observation without the time it was made is refused'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, observed_in, statement, stated_at)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'observation', 'elsewhere', 'SYNTHETIC x', now() + interval '1 hour')$$,
  '23514', null, 'an observation cannot be dated after it was recorded'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, statement, stated_at)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'observation', 'SYNTHETIC x', now())$$,
  '23514', null, 'an observation says where it was made'
);

-- ── Fills: client-submitted copies, exact strings, one experiment per trade ─

select lives_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9001', '7001', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0.00050000', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  'the owner links a buy fill'
);
select results_eq(
  $$select quantity, price, quote_quantity, commission, commission_asset, user_id
    from public.spot_experiment_fills where trade_id = '9001'$$,
  $$values ('0.50000000', '100.00000000', '50.00000000', '0.00050000', 'ZCTA', '00000000-0000-4000-8000-000000000041'::uuid)$$,
  'decimal strings are stored exactly as sent, trailing zeros included'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9001', '7001', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0.00050000', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23505', null, 'linking the same fill again is refused'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E2'), 'main', 'ZCTAUSDT', '9001', '7001', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0.00050000', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23505', null, 'one trade cannot belong to two experiments under the same account label'
);
select lives_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E3'), 'sub', 'ZCTAUSDT', '9001', '7001', 'sell', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0.05000000', 'USDT', now(), 1762000000000, 1762000600000, false)$$,
  'the same trade ID under another account label is another fill'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTBUSDT', '9002', '7002', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0', 'ZCTB', now(), 1762000000000, 1762000600000, true)$$,
  '23503', null, 'a fill on another pair cannot join the experiment'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'sub', 'ZCTAUSDT', '9003', '7003', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23503', null, 'a fill under another account label cannot join the experiment'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9004', '7004', 'buy', 1762000700000,
            '0.50000000', '100.00000000', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23514', null, 'a fill outside the window it was read in is refused'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9004', '7004', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762086400001, true)$$,
  '23514', null, 'a read window longer than 24 hours is refused, as Binance refuses it'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9004', '7004', 'buy', 1762000060000,
            '5e-1', '100.00000000', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23514', null, 'a quantity with an exponent is refused'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9004', '7004', 'buy', 1762000060000,
            '0.00000000', '100.00000000', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23514', null, 'a zero quantity is refused'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9004', '7004', 'buy', 1762000060000,
            '0.50000000', '-100', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23514', null, 'a negative price is refused'
);
select throws_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ('60000000-0000-4000-8000-000000000099', 'main', 'ZCTAUSDT', '9005', '7005', 'buy', 1762000060000,
            '0.50000000', '100.00000000', '50.00000000', '0', 'ZCTA', now(), 1762000000000, 1762000600000, true)$$,
  '23503', null, 'the owner cannot link a fill to another user''s experiment'
);

-- ── Partial exits and closing ──────────────────────────────────────────────

select lives_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9010', '7010', 'buy', 1762000120000,
            '0.25000000', '101.00000000', '25.25000000', '0', 'USDT', now(), 1762000000000, 1762000600000, true),
           ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9011', '7011', 'sell', 1762000180000,
            '0.30000000', '99.00000000', '29.70000000', '0.02970000', 'USDT', now(), 1762000000000, 1762000600000, true),
           ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9012', '7011', 'sell', 1762000180000,
            '0.45000000', '99.00000000', '44.55000000', '0.04455000', 'USDT', now(), 1762000000000, 1762000600000, true)$$,
  'a second buy and two sells from one order, a partial exit and then the rest, are linked'
);
select is(
  (select count(*)::int from public.spot_experiment_entries
   where kind = 'close' and experiment_id = (select id from public.spot_experiments where decision = 'SYNTHETIC E1')),
  0,
  'sells matching every unit bought do not close the experiment'
);
select lives_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, statement, stated_at)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'close', 'SYNTHETIC closed by the owner', now())$$,
  'the owner closes the experiment explicitly'
);
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, kind, statement)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'close', 'SYNTHETIC closed again')$$,
  '23505', null, 'an experiment is closed once'
);
select lives_ok(
  $$insert into public.spot_experiment_fills (experiment_id, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete)
    values ((select id from public.spot_experiments where decision = 'SYNTHETIC E1'), 'main', 'ZCTAUSDT', '9013', '7013', 'sell', 1762000240000,
            '0.00100000', '99.00000000', '0.09900000', '0', 'USDT', now(), 1762000000000, 1762000600000, true)$$,
  'a fill found after the close can still be linked; its recorded time shows it came later'
);

-- ── The service role reads and never writes ────────────────────────────────

reset role;
set local role service_role;
select isnt_empty($$select id from public.spot_experiments$$, 'the service role can read experiments');
select throws_ok(
  $$insert into public.spot_experiment_entries (experiment_id, user_id, kind, statement)
    values ('60000000-0000-4000-8000-000000000099', '00000000-0000-4000-8000-000000000042', 'close', 'SYNTHETIC x')$$,
  '42501', null, 'the service role cannot add an entry'
);
select throws_ok(
  $$update public.spot_experiment_fills set quantity = '1'$$,
  '42501', null, 'the service role cannot rewrite a fill'
);
select throws_ok(
  $$delete from public.spot_experiment_entries$$,
  '42501', null, 'the service role cannot delete an entry'
);
select throws_ok(
  $$select user_id from public.binance_spot_owner$$,
  '42501', null, 'the service role cannot read or change the owner configuration'
);

-- ── Separate from paper trading, tracked holdings and simulations ──────────

reset role;
select results_eq(
  $$select distinct confrelid::regclass::text
    from pg_constraint
    where contype = 'f'
      and conrelid in ('public.spot_experiments'::regclass, 'public.spot_experiment_entries'::regclass,
                       'public.spot_experiment_fills'::regclass, 'public.binance_spot_owner'::regclass)
    order by 1$$,
  $$values ('auth.users'), ('spot_experiment_entries'), ('spot_experiments')$$,
  'the new tables reference only users and each other'
);
select is_empty(
  $$select tgname from pg_trigger
    where not tgisinternal
      and tgrelid in ('public.spot_experiments'::regclass, 'public.spot_experiment_entries'::regclass,
                      'public.spot_experiment_fills'::regclass, 'public.binance_spot_owner'::regclass)$$,
  'no trigger on the new tables can write anywhere else'
);
select results_eq(
  $$select (select count(*) from public.paper_transactions), (select count(*) from public.paper_order_batches),
           (select count(*) from public.user_portfolios), (select count(*) from public.trading_signals),
           (select count(*) from public.trading_signal_dismissals)$$,
  $$select fills, batches, portfolios, signals, dismissals from separation_before$$,
  'paper fills, batches, portfolios, signals and dismissals are unchanged'
);

select * from finish();
rollback;
