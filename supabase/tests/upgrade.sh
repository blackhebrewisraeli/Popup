#!/usr/bin/env bash
# Upgrade check: builds the database as the base commit left it, fills it with
# rows shaped like production's, applies this branch's new migrations on top,
# then proves the old rows survived and still work with the new code.
# Usage: supabase/tests/upgrade.sh <base git ref> [postgres URL]
# Set SUPABASE_WORKDIR to run against a stack started with --workdir.
#
# It wipes and rebuilds the local database, so outside CI it needs
# ALLOW_DB_RESET=1. Run it from the stack's own folder: from inside the repo
# the CLI resolves the linked project instead and resets that local stack.
set -euo pipefail

if [[ "${CI:-}" != "true" && "${ALLOW_DB_RESET:-}" != "1" ]]; then
  echo "upgrade.sh resets the local database; rerun with ALLOW_DB_RESET=1 if that is intended." >&2
  exit 2
fi

BASE_REF="${1:?base git ref, e.g. origin/main}"
DB="${2:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
WORKDIR=(${SUPABASE_WORKDIR:+--workdir "$SUPABASE_WORKDIR"})
BASE_WORKDIR=$(mktemp -d)
USER_ID=00000000-0000-4000-8000-0000000000e1
failures=0
cleanup_base() { rm -rf "$BASE_WORKDIR"; }
trap cleanup_base EXIT

base=$(git ls-tree --name-only "$BASE_REF" supabase/migrations/ | sed -En 's#.*/([0-9]{14})_.*#\1#p' | tail -1)
echo "# base $BASE_REF is at migration $base"
git archive "$BASE_REF" supabase | tar -x -C "$BASE_WORKDIR"
if [[ -n "${SUPABASE_WORKDIR:-}" ]]; then
  cp "$SUPABASE_WORKDIR/supabase/config.toml" "$BASE_WORKDIR/supabase/config.toml"
fi
supabase db reset --workdir "$BASE_WORKDIR" --local --version "$base" >/dev/null

sql() {
  local query=$1
  psql "$DB" -X -q -At -v ON_ERROR_STOP=1 -c "$query"
}
check() {
  local name=$1 got=$2 want=$3
  if [[ "$got" == "$want" ]]; then echo "ok - $name"; else echo "not ok - $name: got '$got', want '$want'"; failures=$((failures + 1)); fi
}

# Only columns every released schema has: the seed must load on the base.
sql "
insert into auth.users (id) values ('$USER_ID');
insert into public.signal_webhook_tokens (user_id, token_hash)
values ('$USER_ID', encode(sha256(convert_to('tok-upgrade', 'UTF8')), 'hex'));
insert into public.assets_status (ticker, current_price, updated_at) values ('UPGRADECOIN', 200, now());
insert into public.paper_transactions (user_id, action, ticker, quantity, price, fees) values
  ('$USER_ID', 'DEPOSIT', null, 5000, null, 0),
  ('$USER_ID', 'BUY', 'UPGRADECOIN', 10, 200, 5),
  ('$USER_ID', 'SELL', 'UPGRADECOIN', 4, 200, 2);
insert into public.trading_signals (id, user_id, ticker, action, signal_score, quantity, price, event_id, status) values
  ('40000000-0000-4000-8000-0000000000e1', '$USER_ID', 'UPGRADECOIN', 'SELL', 20, 6, 200, 'upgrade-pending', 'PENDING'),
  ('40000000-0000-4000-8000-0000000000e2', '$USER_ID', 'UPGRADECOIN', 'BUY', 90, 10, 200, 'upgrade-done', 'EXECUTED'),
  ('40000000-0000-4000-8000-0000000000e3', '$USER_ID', 'UPGRADECOIN', 'BUY', 50, 1, 200, 'upgrade-dismissed', 'DISMISSED');
"

# Manual Spot experiments exist from 20261114120000. On a base that has them,
# seed a production-shaped SYNTHETIC record (invented pair, IDs and times):
# an experiment with an approved rule, an observation and a linked buy.
SPOT_EXPERIMENT=60000000-0000-4000-8000-0000000000e1
spot_base=$(sql "select to_regclass('public.spot_experiments') is not null")
spot_rows="
select md5(string_agg(row, '|' order by row)) from (
  select (to_jsonb(e) - 'scenario_snapshot')::text as row from public.spot_experiments e where user_id = '$USER_ID'
  union all select to_jsonb(n)::text from public.spot_experiment_entries n where user_id = '$USER_ID'
  union all select to_jsonb(f)::text from public.spot_experiment_fills f where user_id = '$USER_ID'
) rows"
if [[ "$spot_base" == t ]]; then
  sql "
insert into public.binance_spot_owner (user_id) values ('$USER_ID');
insert into public.spot_experiments
  (id, user_id, recorded_at, account_label, symbol, source_scan_id, source_snapshot_sha256,
   source_reproduction, source_evidence, decision, decision_stated_at)
values ('$SPOT_EXPERIMENT', '$USER_ID', '2026-11-09T08:00:00Z', 'main', 'ZCTUPGRADEUSDT',
  '20261109T070000Z-0000beef', repeat('d', 64), 'match',
  '{\"version\":1,\"instrument\":\"BINANCE:ZCTUPGRADEUSDT\",\"facts\":[[\"Technical rank\",\"#3 of 23\"]],\"rank\":3,\"evaluated\":23,\"long\":false,\"risk\":true,\"stale\":false}',
  'SYNTHETIC upgrade decision', '2026-11-09T07:30:00Z');
insert into public.spot_experiment_entries
  (experiment_id, user_id, recorded_at, kind, rule, rule_status, observed_in, statement, stated_at)
values
  ('$SPOT_EXPERIMENT', '$USER_ID', '2026-11-09T08:05:00Z', 'rule', 'stop', 'approved', null, 'SYNTHETIC stop rule', null),
  ('$SPOT_EXPERIMENT', '$USER_ID', '2026-11-09T08:10:00Z', 'observation', null, null, 'binance_interface', 'SYNTHETIC observation', '2026-11-09T08:09:00Z');
insert into public.spot_experiment_fills
  (experiment_id, user_id, account_label, symbol, recorded_at, trade_id, order_id, side, trade_time_ms,
   quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms,
   window_end_ms, coverage_complete)
values ('$SPOT_EXPERIMENT', '$USER_ID', 'main', 'ZCTUPGRADEUSDT', '2026-11-09T08:20:00Z', '9001', '8001', 'buy',
  1794211200000, '1234.00000000', '0.00000612', '0.00755208', '1.23400000', 'ZCTUPGRADE',
  '2026-11-09T08:15:00Z', 1794182400000, 1794268800000, true);
"
  spot_before=$(sql "$spot_rows")
else
  echo "# base $BASE_REF has no Manual Spot experiment tables: their upgrade checks are skipped"
fi

supabase migration up "${WORKDIR[@]}" --local >/dev/null

check "every fill survived" \
  "$(sql "select count(*) from public.paper_transactions where user_id = '$USER_ID'")" 3
check "every signal survived with its status" \
  "$(sql "select string_agg(status, ',' order by event_id) from public.trading_signals where user_id = '$USER_ID'")" \
  'DISMISSED,EXECUTED,PENDING'
check "legacy signal identifiers survived unchanged" \
  "$(sql "select count(*) from public.trading_signals where id in ('40000000-0000-4000-8000-0000000000e1', '40000000-0000-4000-8000-0000000000e2', '40000000-0000-4000-8000-0000000000e3')")" 3
check "a signal dismissed before the upgrade gets no made-up dismissal record" \
  "$(sql "select count(*) from public.trading_signal_dismissals where signal_id = '40000000-0000-4000-8000-0000000000e3'")" 0
# 100,000 + 5,000 - (2,000 + 5) + (800 - 2): the book replays the old ledger unchanged.
check "the new account book replays the old ledger" \
  "$(sql "select cash from public.paper_account_book('$USER_ID')")" 103793
check "an existing token still authenticates the webhook" \
  "$(sql "select public.ingest_tradingview_signal(encode(sha256(convert_to('tok-upgrade', 'UTF8')), 'hex'), null)")" \
  authorized
rejected=$(psql "$DB" -X -q -At 2>&1 <<SQL || true
select public.ingest_tradingview_signal(
  encode(sha256(convert_to('tok-upgrade', 'UTF8')), 'hex'),
  '{"ticker":"UPGRADECOIN","action":"BUY","signal_score":90,"price":200,"quantity":1,"event_id":"upgrade-missing-kind"}'::jsonb
);
SQL
)
check "a missing signal_kind is rejected after upgrade" \
  "$(grep -o 'signal_kind must be strategy or transport_test' <<<"$rejected")" \
  'signal_kind must be strategy or transport_test'
check "a legacy event retry keeps its original identity behavior" \
  "$(sql "select public.ingest_tradingview_signal(encode(sha256(convert_to('tok-upgrade', 'UTF8')), 'hex'), '{\"signal_kind\":\"strategy\",\"ticker\":\"UPGRADECOIN\",\"action\":\"SELL\",\"signal_score\":21,\"price\":201,\"quantity\":6,\"event_id\":\"upgrade-pending\"}'::jsonb)")" \
  duplicate
executed=$(psql "$DB" -X -q -At 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$USER_ID', true);
select action || ' ' || quantity from public.execute_tactical_signal(
  (select id from public.trading_signals where event_id = 'upgrade-pending'), '$USER_ID', 200
);
commit;
SQL
)
check "a signal left pending by the old release is not executable" \
  "$(grep -o 'Only verified strategy signals can be executed' <<<"$executed")" \
  'Only verified strategy signals can be executed'
check "the unverified legacy signal stays pending without a fill" \
  "$(sql "select status || '/' || count(p.signal_id) from public.trading_signals s left join public.paper_transactions p on p.signal_id = s.id where s.event_id = 'upgrade-pending' group by status")" \
  'PENDING/0'
dismissed=$(psql "$DB" -X -q -At 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$USER_ID', true);
select 'reason=' || coalesce(reason, 'none') from public.dismiss_tactical_signal(
  (select id from public.trading_signals where event_id = 'upgrade-pending')
);
commit;
SQL
)
check "a signal left pending by the old release can be dismissed" "$(grep -o 'reason=.*' <<<"$dismissed")" reason=none
check "its dismissal is recorded with the owner as actor" \
  "$(sql "select s.status || '/' || (d.actor_id = s.user_id) from public.trading_signals s join public.trading_signal_dismissals d on d.signal_id = s.id where s.event_id = 'upgrade-pending'")" \
  'DISMISSED/true'

if [[ "$spot_base" == t ]]; then
  check "existing experiments, entries and fills are unchanged" "$(sql "$spot_rows")" "$spot_before"
  check "an existing experiment has no scenario recorded" \
    "$(sql "select count(*) from public.spot_experiments where id = '$SPOT_EXPERIMENT' and scenario_snapshot is null")" 1
  as_owner() {
    psql "$DB" -X -q -At 2>&1 <<SQL || true
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '$USER_ID', true);
$1
commit;
SQL
  }
  old_insert=$(as_owner "insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision)
    values ('main', 'ZCTUPGRADEUSDT', '20261109T070000Z-0000beef', repeat('d', 64), 'match', '{}', 'SYNTHETIC old client')
    returning 'snapshot=' || coalesce(scenario_snapshot::text, 'none');")
  check "an insert that leaves the snapshot out still records, with no scenario" \
    "$(grep -o 'snapshot=.*' <<<"$old_insert")" 'snapshot=none'
  new_insert=$(as_owner "insert into public.spot_experiments (account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, scenario_snapshot)
    values ('main', 'ZCTUPGRADEUSDT', '20261109T070000Z-0000beef', repeat('d', 64), 'match', '{}', 'SYNTHETIC new client',
      '{\"version\":1,\"calculationVersion\":\"spot-scenario-1\",\"inputs\":{\"allocation\":\"15\",\"maxLoss\":\"1\",\"entry\":\"0.00000612\",\"stop\":\"0.0000055\",\"feePercent\":null},\"figures\":{\"quantity\":\"1,612,903.22580645\",\"limitedBy\":\"maxLoss\",\"notional\":\"9.87\",\"unallocated\":\"5.13\",\"stopDistance\":\"0.00000062\",\"stopDistancePercent\":\"10.13%\",\"lossAtStop\":\"1.00\",\"fees\":null}}')
    returning 'entry=' || (scenario_snapshot #>> '{inputs,entry}');")
  check "the owner records a new experiment with a scenario snapshot" \
    "$(grep -o 'entry=.*' <<<"$new_insert")" 'entry=0.00000612'
fi

sql "delete from auth.users where id = '$USER_ID'; delete from public.assets_status where ticker = 'UPGRADECOIN';" >/dev/null
exit "$failures"
