begin;

create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000041'),
  ('00000000-0000-4000-8000-000000000042');

insert into public.binance_spot_owner (user_id) values ('00000000-0000-4000-8000-000000000041');

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000041', true);

select lives_ok(
  $$insert into public.spot_no_entry_decisions
      (id, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason)
    values ('60000000-0000-4000-8000-000000000099', 'ZCTAUSDT',
            '20261101T000000Z-0000abcd', repeat('b', 64), '{"long": false}', 'SYNTHETIC review')
    returning id, recorded_at$$,
  'the owner can record a named saved-scan review and get a receipt'
);
select results_eq(
  $$select user_id, recorded_at >= now(), source_evidence, reason from public.spot_no_entry_decisions$$,
  $$values ('00000000-0000-4000-8000-000000000041'::uuid, true, '{"long": false}'::jsonb, 'SYNTHETIC review'::text)$$,
  'history returns the database-owned identity and time alongside the supplied evidence'
);
select throws_ok(
  $$insert into public.spot_no_entry_decisions
      (id, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason)
    values ('60000000-0000-4000-8000-000000000099', 'ZCTAUSDT',
            '20261101T000000Z-0000abcd', repeat('b', 64), '{"long": false}', 'SYNTHETIC review')$$,
  '23505', null, 'retrying the same submission ID leaves one row'
);
select throws_ok(
  $$insert into public.spot_no_entry_decisions
      (id, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason)
    values ('60000000-0000-4000-8000-000000000098', 'ZCTAUSDT',
            '20261101T000000Z-0000abcd', repeat('b', 64), '{}', E' \t\n')$$,
  '23514', null, 'the reason must contain non-whitespace'
);
select throws_ok(
  $$insert into public.spot_no_entry_decisions
      (id, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason, recorded_at)
    values ('60000000-0000-4000-8000-000000000098', 'ZCTAUSDT',
            '20261101T000000Z-0000abcd', repeat('b', 64), '{}', 'SYNTHETIC time', now())$$,
  '42501', null, 'the owner cannot set the recording time'
);
select throws_ok(
  $$update public.spot_no_entry_decisions set reason = 'SYNTHETIC rewrite'$$,
  '42501', null, 'recorded reasons are append-only'
);
select throws_ok(
  $$delete from public.spot_no_entry_decisions$$,
  '42501', null, 'the client cannot delete a decision'
);

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000042', true);
select is_empty($$select id from public.spot_no_entry_decisions$$, 'another user cannot read history');
select throws_ok(
  $$insert into public.spot_no_entry_decisions
      (id, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason)
    values ('60000000-0000-4000-8000-000000000098', 'ZCTAUSDT',
            '20261101T000000Z-0000abcd', repeat('b', 64), '{}', 'SYNTHETIC other user')$$,
  '42501', null, 'another user cannot record a decision'
);

reset role;
set local role anon;
select throws_ok(
  $$select id from public.spot_no_entry_decisions$$,
  '42501', null, 'anonymous sessions cannot query the table'
);
reset role;

delete from public.binance_spot_owner;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000041', true);
select is_empty($$select id from public.spot_no_entry_decisions$$, 'a former owner loses access');
reset role;

select * from finish();
rollback;
