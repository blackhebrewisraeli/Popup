# 24-hour Spot target-before-stop evaluation: protocol v1

**Status: proposed method, offline prototype.** The machine-readable protocol is
[`spot-24h-probability.v1.json`](spot-24h-probability.v1.json), id
`popup-spot-24h-target-before-stop-v1`. Its identity is the SHA-256 of its canonical content,
printed by every run. Where this page and the JSON differ, the JSON governs. Any change after the
first run is a v2 file, never an edit.

**Recorded before any outcome.** This page and the JSON were committed after the universe step
below and before any 1h candle inside the evaluation period was retrieved (`9a3b2d5`, then
[revision 2](#revision-2-recorded-before-any-real-data)). Nothing here was chosen after seeing an
outcome, a probability or a calibration figure.

**Run once, 2026-11-22, at `2d848fb`: insufficient evidence, no shortlist.** No scenario's
probability met the support criteria, and no scenario's expectancy did. Probability estimation is
not supported under this protocol. See [Recorded run](#recorded-run-2026-11-22). This is research
output only: nothing here proposes or sizes a trade.

## The question

Daily Discovery ranks liquidity, and the existing 0–100 model score is not a calibrated
probability. This protocol measures one event:

> A long Binance Spot position opened at the evaluation time reaches its target before its stop,
> within 24 hours.

Spot only, no leverage. The exit is the target, the stop or the 24-hour deadline, whichever comes
first. The eventual use is one real-money experiment of about 43.92 USDT (the last account read).
This study never reads, uses or spends that balance.

## Fixed in advance

| Choice      | Value                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data        | Binance Spot public klines, `1h`, through the existing `fetchSymbolCandles`. Collection cutoff **2026-11-22T00:00:00Z**: the last candle opens at 23:00Z on 21 Nov. History from 2024-11-13T16:00Z (200 warm-up hours before the first decision). Stored in the git-ignored `.zerochart-market-data/spot-24h-v1/`, public market data only. Nothing is filled, interpolated, deduplicated or repaired |
| Universe    | The Daily Discovery policy `binance-spot-usdt-liquidity-v1`, collected locally with `collectDiscoveryEvidence` at 2026-11-21T21:03:18Z (COMPLETE, 50 of 520 eligible). Walk the 50 members in rank order. Skip stablecoin or fiat bases, leveraged products, tokenized commodities and tokenized stocks or ETFs, and any pair whose first 1h candle opens after the history start. Keep the first 20  |
| Pairs       | BTC, ETH, SOL, ZEC, XRP, NEAR, BNB, UNI, DOGE, SUI, ENA, PEPE, ADA, TRX, LINK, TAO, LTC, WLD, AVAX, AAVE (all USDT)                                                                                                                                                                                                                                                                                   |
| Decisions   | Every 4 hours at 00, 04, 08, 12, 16 and 20 UTC, from 2024-11-22T00:00Z. A decision at T uses only candles closed by T                                                                                                                                                                                                                                                                                 |
| Features    | The existing `rsi(14)`, `macd(12, 26, 9)` histogram and `atr(14)` from `src/lib/indicators.ts`, on the 200 closed 1h candles ending at T. Any gap or invalid candle means no decision                                                                                                                                                                                                                 |
| Cells       | RSI below 40, 40 to 60, above 60 × MACD histogram above 0 or not: 6 cells                                                                                                                                                                                                                                                                                                                             |
| Scenarios   | v = ATR14 ÷ close. Targets 3, 5 or 8 v above entry × stops 3 or 5 v below: T3S3, T5S3, T8S3, T3S5, T5S5, T8S5                                                                                                                                                                                                                                                                                         |
| Entry, exit | Entry at the open of the candle opening at T. Scan the 24 candles opening T to T+23h                                                                                                                                                                                                                                                                                                                  |
| Costs       | Assumed 0.10% fee per fill (regular-user rate, no BNB discount), 0.05% slippage on the entry, stop and timeout fills, none on the target limit                                                                                                                                                                                                                                                        |
| Method      | Conditional empirical frequency: TARGET count ÷ observations for each scenario and cell over the fit set. At least 300 observations on 30 distinct days, or no probability                                                                                                                                                                                                                            |
| Benchmark   | The scenario's base rate over the same fit set, ignoring the cells                                                                                                                                                                                                                                                                                                                                    |
| Splits      | Train to 2025-11-22, validation to 2026-05-22, test to the cutoff. A decision whose 24-hour label crosses a boundary is dropped                                                                                                                                                                                                                                                                       |
| Ranking     | score = 0.55 × p + 0.45 × min(max(net gain, 0), 10%) ÷ 10%                                                                                                                                                                                                                                                                                                                                            |

The universe step first exposed FDUSD (a stablecoin the discovery policy does not list) and six
tokenized stock or ETF products (SOXLB tracks a 3× leveraged ETF). The exclusion list was
completed by exact base asset code, and the selection was recomputed from the same saved evidence.
That happened before any candle history was read. Only HYPE, U, ASTER and PUMP were skipped for
short history, and only XAUT for the discovery label.

## Outcome of one decision

Bars are read in order. A bar that opens at or below the stop is a STOP filled at the open. One that
opens at or above the target is a TARGET filled at the target. Otherwise, a bar touching both levels
is **AMBIGUOUS**: 1h candles cannot say which came first. It is never counted as a success, and its
net return is taken as a stop. A bar touching only the stop is a STOP at the stop, one touching
only the target a TARGET. No touch in 24 bars is a TIMEOUT at the 24th close. A missing or invalid
forward candle makes the outcome missing; it is excluded and counted, never filled.

Net return = (1 − 0.001)² × exit × (1 − exit slippage) ÷ (entry × 1.0005) − 1. The potential net
gain is that figure for a TARGET exit.

## Splits, overlap and fits

Labels from decisions 4 hours apart overlap for 20 hours, and pairs move together. So:

- **No label crosses a boundary.** Decisions in the last 24 hours before each boundary belong to no
  split. Features may use earlier candles: they were known at the decision.
- **Development:** fit on train, report on validation.
- **Confirmatory:** fit on train and validation, evaluate on test. Only test decides support.
- **Current:** fit on every decision whose label ended by the cutoff, then score 2026-11-22T00:00Z.
- **Uncertainty:** a moving block bootstrap over UTC days, whole days with every pair and hour,
  blocks of 7 days, 2,000 replicates, seeded draws reused from the swing-structure study. Test
  ΔBrier gets a 95% percentile interval with the fit held fixed. A current probability gets a 90%
  interval from re-estimating its cell on replicates of the fit days.

## When a probability counts as supported

Per scenario, on test only, all four must hold. Otherwise it is NOT_SUPPORTED, with each failing
criterion named.

1. **Evidence:** at least 2,000 test observations with a probability on at least 90 days, covering
   at least 95% of the scenario's test observations.
2. **Skill:** Brier(method) − Brier(base rate) < 0, with its 95% upper bound < 0.
3. **Calibration:** calibration in the large ≤ 0.03, and the observation-weighted cell error ≤ 0.05.
4. **Consistency:** ΔBrier < 0 on validation as well.

A supported probability says the frequencies are calibrated and beat the base rate. It does not say
a trade pays: a calibrated 40% can still lose money after costs.

## When expectancy counts as supported (revision 2)

Also per scenario, on test only. Take the test observations whose cell, in the confirmatory fit,
has a probability and a positive mean realized net return. It is SUPPORTED if there are at least 300
of them on at least 30 days, and their mean realized net return is above zero with its 95%
block-bootstrap lower bound above zero. This is one out-of-sample test of the selection rule per
scenario, rather than 36 in-sample point estimates.

## Qualification

A current candidate qualifies only if its scenario's probability and expectancy are both supported,
its window is complete, its cell has a probability, its potential net gain is positive and the
current fit's mean realized net return for that scenario and cell is positive. With no supported
probability the result is **insufficient evidence** and no shortlist. Otherwise, with nothing that
meets every rule, the result is **no qualifying candidate**. A shortlist entry is a research
probability at a reference price, never an order.

## Revision 2, recorded before any real data

The first commit of this protocol (`9a3b2d5`) qualified candidates on the current fit's point
estimate alone, over 36 scenario-cells. Before any real candle was retrieved, a synthetic check
showed that this point estimate was the only guard against noise. Expectancy above was added as a
second test-only gate. It can only remove candidates. The JSON's `revisions` records the change.

**What that synthetic check really showed.** Its generator was a floating-point linear
congruential generator, and `x × 1103515245` passes 2^53. The draws were therefore not
independent, and the "random walks" carried predictable structure that persisted from train to
test. That structure is why both gates passed on some seeds; it was not a flaw in the protocol.
With an exact 32-bit generator (mulberry32), five seeds of 20 i.i.d. walks over the protocol's
dates give no supported probability, no cell with a positive mean net return, and **insufficient
evidence** each time. The gate stays because the reason for it stands on its own.

## Synthetic verification

[`scripts/spot24h.test.ts`](../scripts/spot24h.test.ts) checks, on synthetic candles only:

- event order: target before a later stop and the reverse, gaps through either level, equality as
  a touch, AMBIGUOUS when one bar touches both, TIMEOUT at the 24th close;
- fees and slippage, the potential net gain, and a gain wiped out by costs;
- causal features: changing or dropping any candle from T onward, or before the window, changes
  nothing. Changing the last closed candle changes the features, and a gap refuses the decision;
- invalid, duplicate, misaligned and open candles, refused and never repaired. A missing candle
  removes exactly the decisions that need it: 6 outcomes and 50 feature windows;
- purging at both boundaries, and that test-period candles change neither the development nor the
  confirmatory fit;
- the evidence floors, both gates with each failing criterion named, and ranking ties resolved the
  same way for any input order;
- a **negative control**: four i.i.d. walks over the protocol's dates give no supported
  probability, no supported expectancy and no shortlist. A one-hour look-ahead in the features
  makes this test fail on its own.

Mutations that let features see the entry bar, drop the purge, fit on test data, count an
ambiguous bar as a success or loosen expectancy to a point estimate each fail at least one test.

## Recorded run (2026-11-22)

Run once, after the cutoff, under the frozen protocol. Nothing was tuned, rerun or revised after
the outcomes were read. Aggregates only: per-observation rows and candidates stay in the
git-ignored result.

### Identity and inputs

| Item         | Value                                                                                                                                                                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run commit   | `2d848fb1b5584d64f9892cd44627366246adf359`; no tracked file differed from it                                                                                                                                                                                                                                                                                                    |
| Protocol     | `popup-spot-24h-target-before-stop-v1`, SHA-256 `b3aa90fb891275eb6ca03ef89038670783a00d7a7a449a45229de8728369a62a` (revision 2), blob `9abc1531…`                                                                                                                                                                                                                               |
| Source blobs | `scripts/spot24h.ts` `5d6a9cfc…`, `scripts/spot24hRun.ts` `97e762b0…`, `scripts/swingStructureEvaluation.ts` `390fe8c6…`, `scripts/scannerResearch.ts` `676882e3…`, `src/lib/indicators.ts` `38bf08a0…`, `src/lib/candleValidation.ts` `f2d11061…`, `src/lib/stableSerialize.ts` `4cf67020…`, `_shared/stableSerialize.ts` `563d6d33…`, `_shared/dailyDiscovery.ts` `5251ad95…` |
| Universe     | `universe.json` SHA-256 `b43acfda…`, as recorded in the protocol; members recomputed and matched                                                                                                                                                                                                                                                                                |
| Candles      | 20 files, 17,720 candles each (2024-11-13T16:00Z to 2026-11-21T23:00Z), retrieved 2026-11-22T00:01:53Z to 00:05:09Z. The manifest holds each file's SHA-256                                                                                                                                                                                                                     |
| Result       | `.zerochart-reports/spot-24h-probability-b3aa90fb8912.json`, 172,362 bytes, SHA-256 `662c5d7d2eec69ac62c736701a63e00b565e642fdcb813823aa00ab43fa6ec1e`, `CREATED`; the saved bytes' hash equals the run's                                                                                                                                                                       |

**Reproducing it.** The commit is in the result, so reproduce at `2d848fb`, with the same data
files: the command reports `UNCHANGED`, or `CREATED` with the same SHA-256 where no result exists.
At any other commit it reports `CONFLICT` and overwrites nothing. No reproduction rerun was made,
so the evaluation ran exactly once.

### Coverage

No candle issue of any kind, no missing hour, no unavailable feature window and no missing outcome:
all 87,500 decisions (20 pairs × 4,375) became observations. Train 43,700 on 365 days, validation
21,620 on 181 days, test 21,980 on 184 days. 200 decisions were purged at the boundaries. The
current fit used all 87,500, on 730 days. Every test observation had a probability, so coverage was
100% in every scenario.

### All six scenarios

Test split (2026-05-22 to the cutoff), 21,980 observations per scenario. ΔBrier is
Brier(method) − Brier(base rate); negative favours the method.

| Scenario | TARGET | STOP   | TIMEOUT | AMBIGUOUS  | Test ΔBrier [95%]              | Skill score | Validation ΔBrier | Calibration (large / cells) | Mean net per trade | Probability                       | Expectancy                 |
| -------- | ------ | ------ | ------- | ---------- | ------------------------------ | ----------- | ----------------- | --------------------------- | ------------------ | --------------------------------- | -------------------------- |
| T3S3     | 29.25% | 34.12% | 36.60%  | 6 (0.027%) | −0.00130 [−0.00296, +0.000002] | 0.63%       | +0.00002          | 0.022 / 0.027               | −0.41%             | Not supported: skill, consistency | Not supported (0 selected) |
| T5S3     | 13.21% | 35.60% | 51.16%  | 5 (0.023%) | −0.00105 [−0.00273, +0.00005]  | 0.92%       | +0.00015          | 0.009 / 0.019               | −0.39%             | Not supported: skill, consistency | Not supported (0 selected) |
| T8S3     | 4.95%  | 35.92% | 59.11%  | 4 (0.018%) | −0.00040 [−0.00108, +0.00004]  | 0.86%       | +0.00003          | 0.002 / 0.005               | −0.37%             | Not supported: skill, consistency | Not supported (0 selected) |
| T3S5     | 30.62% | 14.42% | 54.95%  | 2 (0.009%) | −0.00128 [−0.00292, −0.00003]  | 0.60%       | +0.00011          | 0.020 / 0.027               | −0.44%             | Not supported: consistency        | Not supported (0 selected) |
| T5S5     | 13.80% | 15.09% | 71.10%  | 1 (0.005%) | −0.00106 [−0.00274, +0.00004]  | 0.89%       | +0.00023          | 0.007 / 0.018               | −0.42%             | Not supported: skill, consistency | Not supported (0 selected) |
| T8S5     | 5.12%  | 15.25% | 79.62%  | 1 (0.005%) | −0.00041 [−0.00110, +0.00004]  | 0.85%       | +0.00003          | 0.002 / 0.005               | −0.40%             | Not supported: skill, consistency | Not supported (0 selected) |

- **Skill.** On test the cells beat the base rate by 0.6% to 0.9% of its Brier score, a small
  margin. Only T3S5's 95% upper bound is below zero; T3S3's sits just above it.
- **Consistency.** On validation the method was slightly worse than the base rate in all six
  scenarios. That alone rules out support everywhere, T3S5 included.
- **Calibration.** Every scenario passes both calibration limits. The cells' errors are not
  random, though. On test, both high-RSI cells and the rare `low/positive` cell were
  under-predicted in all six scenarios, and `low/nonPositive` was over-predicted in all six. The
  two mid cells were over-predicted at targets of 3 and 5 v and within 0.003 at 8 v. In T3S5, for
  example, `high/nonPositive` was predicted at 0.366 and observed at 0.437 (597 observations), and
  `mid/nonPositive` at 0.332 against 0.299 (6,248).
- **Expectancy.** In the confirmatory fit (train and validation), no scenario-cell had a positive
  mean realized net return, so the selection rule selected no test observation in any scenario.
  The mean net return per trade, across all cells, was negative everywhere: −0.37% to −0.44% on
  test and −0.36% to −0.39% on validation. Assumed costs alone take about 0.25% (target exit) to 0.30% (stop or timeout) per round trip.

### AMBIGUOUS bars

| Scenario | Validation (21,620) | Test (21,980) |
| -------- | ------------------- | ------------- |
| T3S3     | 4 (0.019%)          | 6 (0.027%)    |
| T5S3     | 3 (0.014%)          | 5 (0.023%)    |
| T8S3     | 2 (0.009%)          | 4 (0.018%)    |
| T3S5     | 0                   | 2 (0.009%)    |
| T5S5     | 0                   | 1 (0.005%)    |
| T8S5     | 0                   | 1 (0.005%)    |

An AMBIGUOUS bar touched both levels within one hour, so 1h data cannot say which came first. The
protocol counts it as a failure and books its net return as a stop. The probability is therefore a
conservative operational estimate: the chance that the target is confirmed first, not the chance
that it was first. Here the choice barely matters. Counting every AMBIGUOUS bar as a success would
raise a test rate by at most 0.027 percentage points. The result file does not hold train-period
counts.

### The current evaluation, 2026-11-22T00:00Z

**Verdict: insufficient evidence. Shortlist: empty.** All 120 candidates (20 pairs × 6 scenarios)
had a complete window. Each fails three rules: the scenario's probability is not supported, its
expectancy is not supported, and the current fit's mean realized net return for its cell is not
positive. Nineteen pairs were in `mid/positive` and one in `high/positive`.

One in-sample figure is disclosed so it is not misread later. In the current fit, which includes
the test period, the rare `high/nonPositive` cell (2,223 observations) has a positive mean net
return in four scenarios, from +0.03% to +0.19%. These point estimates were never tested out of
sample, no pair is in that cell now, and the protocol gives them no standing. They are not a
finding.

### Reading the result

- **Pooled, not per coin.** Each probability is the frequency of one scenario and indicator cell,
  pooled across all 20 pairs. Every pair in the same cell gets the same number. It is not an
  individual forecast for any coin. Pair differences enter only through the ATR-scaled levels.
- **Per-scenario, no multiplicity adjustment.** Each scenario has its own 95% interval and its own
  gates, and nothing corrects for having six. Had one scenario passed, the chance of at least one
  pass arising by luck would have been higher than one test's 5%. T3S5's lone skill pass, which
  failed consistency anyway, should be read in that light.
- **Gates are not validation of a shortlist.** The gates are predeclared tests of the method and
  of the selection rule on the test split. A shortlist would be chosen with the current fit, which
  includes the test period, so it would not itself be validated by them. Validating a shortlist
  needs outcomes it never saw: a later period, under a protocol frozen before that period starts.
- **The random-walk control is a diagnostic.** It showed that, on synthetic i.i.d. data, these
  gates found nothing, and that a one-hour look-ahead makes it fail. It does not prove independence
  of the real observations, the absence of every kind of leakage, or statistical significance of
  any result.

### Is probability estimation supported?

**No, not under protocol v1.** The pooled cell frequencies are reasonably calibrated in the large,
but they do not beat the base rate consistently: they lost to it on validation in all six
scenarios, and beat it on test by under 1% of the Brier score. Expectancy was negative in every
scenario. This is a measured negative for this method on this data, not evidence that no method
could work.

### What remains before a real trade can be considered

This study proposes no trade. Before one could be considered:

1. **A new protocol (v2), frozen before its evaluation period.** This v1 file stays as it is; any
   new features, cells, scenarios or thresholds belong in v2.
2. **Untouched data.** A prospective period after v2 is frozen, not a re-split of this history,
   which has now been seen.
3. **Both gates passed,** including positive out-of-sample expectancy after costs. The
   probability gate alone is not enough.
4. **Independent validation of the selected shortlist** on outcomes it never saw, as above.
5. **Execution checked rather than assumed:** the account's actual fee tier, measured slippage and
   spread, lot-size and minimum-notional rounding at about 43.92 USDT, and how a resting target and
   a stop would actually be placed.
6. **The owner's own decision,** recorded as a new Manual Spot experiment. The closed TRX record
   stays untouched.

## Limitations known in advance

- **Survivorship.** Pairs are chosen by today's liquidity and listed history, then evaluated on two
  years before today.
- **One venue, one bar size.** 1h bars hide the order inside a bar (hence AMBIGUOUS), and the 0.05%
  slippage is an assumption, not a measurement.
- **Dependence.** Overlapping labels and correlated pairs leave far fewer independent observations
  than rows. The block bootstrap addresses this only approximately.
- **Coarse evidence.** Six cells from two indicators. A supported result would be a retrospective
  association, not proof of an edge.
- **Not the closed TRX record.** TRXUSDT is a member here, but the closed Manual Spot experiment is
  neither read nor changed.

## Running it

Code: [`scripts/spot24h.ts`](../scripts/spot24h.ts) (pure: validation, features, outcomes, fits,
evaluation, bootstrap, ranking) and [`scripts/spot24hRun.ts`](../scripts/spot24hRun.ts) (the three
local steps). Tests: [`scripts/spot24h.test.ts`](../scripts/spot24h.test.ts), synthetic candles
only. The commands take no options; the protocol fixes every input, path and output.

```bash
npm run evaluate -- spot-24h-universe
```

```bash
npm run evaluate -- spot-24h-collect
```

```bash
npm run evaluate -- spot-24h-evaluate
```

1. **Universe**, before the cutoff: the discovery evidence and each candidate's first 1h candle,
   saved once. Done for v1; its SHA-256 is in the JSON, and every later step refuses another file
   or a selection that differs from the recorded pairs.
2. **History**, only after the cutoff: each member's 1h candles from the history start, paged by
   open time, saved once per pair. A saved pair is never fetched again.
3. **Evaluation**, offline: refuses to start while any tracked file differs from `HEAD`, so the
   commit names all the code that runs. It reads the saved files, runs the protocol and writes
   `.zerochart-reports/spot-24h-probability-<12 hex>.json` once. The file's manifest records the
   run commit, the protocol's id and SHA-256, the git blob of each source file the evaluation
   loads, the universe evidence's SHA-256 and each candle file's SHA-256. It also holds per-pair
   coverage, every evaluation table and all 120 current candidates with their reasons. A rerun
   prints `UNCHANGED` for identical bytes, or `CONFLICT` and overwrites nothing. Because the commit
   is in the file, a rerun at any other commit reports `CONFLICT` by design: reproduce at the run
   commit.

Nothing here reads an account, places an order, sets an alert, writes an experiment record or
touches a production store.
