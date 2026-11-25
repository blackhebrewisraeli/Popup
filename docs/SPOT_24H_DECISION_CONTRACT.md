# 24-hour Spot long: decision contract and one proposed experiment (PROPOSED / NOT RUN)

**Status: PROPOSED / NOT RUN.** A design document. Nothing here was fitted, scored, downloaded or
computed on real outcomes; every figure quoted comes from an earlier recorded report. It changes
no earlier specification, result or document. The experiment below runs only after the owner
settles the [unresolved decisions](#unresolved-design-decisions) and its machine-readable
specification is committed on its own, before stage D computes anything.

## The gap, in brief

- **Event ordering exists.** [Protocol v1](SPOT_24H_PROBABILITY.md)'s `resolveOutcome` already
  resolves TARGET, STOP, TIMEOUT and AMBIGUOUS on hourly bars, and the diagnosis, breadth filter,
  channel breakout and structure entry (#216–#219) all build on it. Nothing here recreates it.
- **No forecast has supported a decision.** v1's RSI × MACD cell frequencies were calibrated but
  did not beat the base rate consistently, and no cell cleared the 0.28–0.30% cost
  ([diagnosis](SPOT_24H_V1_DIAGNOSTIC.md)). [#220](QUANTILE_FORECAST_24H_DEV_V1.md)'s quantiles are
  marginal and unordered: they give no joint event order, no target-before-stop probability and no
  recovery probability, and they are not combined into one here.
- **The decision quantity was never forecast.** v1 forecast P(TARGET) only. Entering needs the
  expected net return after costs, which also depends on P(STOP), P(TIMEOUT) and the timeout
  return. Timeouts were 36–81% of v1's validation and test outcomes.
- **No untouched data remains.** 2024-11-22 to 2026-11-22 has been examined by six studies (v1,
  its diagnosis, breadth filter, channel breakout, structure entry, quantile forecast). Anything
  computed on it again is development evidence.

## Gap map

| Decision need                               | What exists                                                                               | Status                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| Ordered outcome within 24 h                 | v1 `resolveOutcome`; reconciled exactly by the diagnosis; built on by #216–#219           | Exists, reuse unchanged                 |
| P(TARGET before STOP)                       | v1's six-cell frequencies: calibrated, not consistently better than the base rate         | Exists, no established skill            |
| P(STOP), P(TIMEOUT), jointly with P(TARGET) | Outcome counts per split and the diagnosis's attribution; no forecast                     | **Missing as a forecast**               |
| Timeout return                              | Inside each observation's net return; the diagnosis shows it sets the sign with 5 v stops | **Missing as a forecast**               |
| Expected net return per observation         | v1's per-cell fit `meanNet`, used only to select cells                                    | Partial                                 |
| Abstention against cash                     | v1's qualification (empty shortlist); #219 counted no entry as 0                          | Concept exists; no forecast rule tested |
| Calibration of a decision quantity          | v1: TARGET cells; #220: quantile intervals                                                | **Missing for expected net**            |
| Untouched evaluation data                   | None                                                                                      | **Missing: needs a prospective period** |
| Measured costs and fills                    | Assumed 0.10% fee per fill, 0.05% slippage on market fills                                | **Missing** (outside this design)       |

## The decision contract

### 1. Decision time, information, entry and horizon

v1's, unchanged. A decision time T is on the 4-hour UTC grid (00, 04, 08, 12, 16, 20). Information
is the 1h candles closed by T: the 200-candle window whose last candle opens at T − 1h, validated
and never repaired. The entry reference is the open O of the candle opening at T, bought with 0.05%
slippage and a 0.10% fee. The horizon is fixed at the 24 candles opening T to T + 23h; a position
still open is sold at the close of the last one. One long Spot position per pair and decision,
no leverage.

### 2. Outcomes

v1's `resolveOutcome`, unchanged, bar by bar. Two kinds of statement are mixed in its result and
are kept apart here:

**Observed at hourly resolution.** Which bar first reached a level is observed. So is a gap: a bar
opening at or beyond a level reached it before anything else in that bar.

| Outcome   | Rule (first deciding bar)                                       | Booked fill                                         |
| --------- | --------------------------------------------------------------- | --------------------------------------------------- |
| TARGET    | Opens at or above the target, or touches only the target        | The target, a resting limit with no slippage        |
| STOP      | Opens at or below the stop, or touches only the stop            | The open after a gap, else the stop; 0.05% slippage |
| AMBIGUOUS | Touches both levels without a gap                               | As a STOP at the stop; never a success              |
| TIMEOUT   | No level reached in 24 bars; the last close lies between levels | The 24th close; 0.05% slippage                      |

**Assumed within a bar.** None of these is observed:

- _AMBIGUOUS order (conservative):_ the stop is assumed first. v1 recorded at most 0.027% of
  observations per scenario as AMBIGUOUS; finer candles are not needed to resolve them.
- _Gap above the target (conservative):_ filled at the target, not at the higher open.
- _A touch fills at the level (optimistic for the target):_ a limit at exactly the high may not
  fill. The proposed experiment reports a sensitivity for this (below).
- _Stop fill at the level less 0.05% (assumed):_ fast moves can fill worse.

### 3. What must be predicted

A trade's value is its expected net return, after costs, against cash at 0:

E[net | x] = p_T(x) · n_T + p_S(x) · n_S + p_TO(x) · n_TO,

with p_T + p_S + p_TO = 1 (AMBIGUOUS inside STOP), and n the mean net return of each outcome. v1's
`netReturn` is linear in the exit price, so each n is that function at the outcome's mean exit.
So a decision needs three joint probabilities, the conditional timeout return and the costs.
P(TARGET) alone does not determine the sign. With v1's T3S3 levels at the median v of 1.057%
(target and stop 3.17% away), n_T = +2.91%, n_S = −3.46%, and a timeout at zero gross nets
−0.30%:

| p_T  | p_S  | p_TO | Timeout gross | E[net]     |
| ---- | ---- | ---- | ------------- | ---------- |
| 0.35 | 0.25 | 0.40 | 0%            | **+0.03%** |
| 0.35 | 0.35 | 0.30 | 0%            | **−0.28%** |
| 0.35 | 0.25 | 0.40 | −0.5%         | **−0.16%** |

The same target probability gives opposite decisions. Costs enter every outcome, so the gross
hurdle is about 0.3% per trade.

### 4. Enter or abstain

Each eligible (pair, T) is a choice: ENTER, earning that position's net return on a unit stake, or
ABSTAIN, holding cash at exactly 0 with no cost. A rule is valued per opportunity: the mean of
d · net over all eligible observations, d ∈ {0, 1}, abstentions included as 0. Entry rate and mean
net per trade are reported beside it. Abstaining everywhere is a complete and valid answer and is
the reference to beat. Beating "always enter" (v1's −0.37% to −0.44% on test) is not usefulness:
#219's waiting arm beat a losing arm and still did not beat cash. Positions on a unit stake may
overlap, so the per-opportunity mean is not a wallet return.

### 5. Comparison

Three forecasters on the same observations, outcomes, levels and costs, each fitted only on data
before the period it is scored on:

| Forecaster                    | Probabilities                                                               | Decision rule                                                           |
| ----------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| U, unconditional baseline     | Fit-set frequencies of TARGET, STOP, TIMEOUT                                | Enter if E[net] > 0 with those frequencies and that observation's v     |
| V1, v1's estimator, unchanged | `fitFrequencies` per RSI × MACD cell; STOP and TIMEOUT counted the same way | v1's selection: the cell has a probability and a positive fit `meanNet` |
| C, the candidate              | One model's joint probabilities ([below](#one-modelling-approach))          | Enter if E[net] > 0                                                     |

An observation is scored only where all three have a forecast; coverage below 95% is insufficient
evidence. For U and C, n_S and n_TO come from the fit set's mean gross return of that outcome in
units of v, through v1's `netReturn`; n_T is exact. V1's expected net is its cell's fit `meanNet`,
as in v1.

### 6. Criteria, kept separate

**Predictive improvement.** The three-class Brier score, Σ_k (p_k − y_k)², averaged over
observations. C must be lower than U and lower than V1, each with the 95% upper bound of the
difference below zero. v1's binary TARGET Brier against its base rate is reported for continuity.

**Calibration.** Per class: calibration in the large ≤ 0.03 and observation-weighted error over
deciles of predicted probability ≤ 0.05 (v1's limits, deciles in place of cells). Expected net in
the large: |mean predicted E[net] − mean realized net| ≤ 0.10 percentage points (a proposed value
without precedent here).

**Economic usefulness.** C's per-opportunity mean net return above 0 with its 95% lower bound above
0; at least 300 entries on at least 30 days in at least 3 calendar months; mean net per trade above
0; the per-opportunity mean above 0 with any one calendar month left out; and above 0 under the
target-fill sensitivity. Paired differences against the U and V1 rules are reported with
intervals. Economic usefulness without predictive improvement is not support: it may be luck in
one market state.

**Dependence.** Labels of decisions 4 hours apart share 20 of 24 hours, and the 20 pairs co-move
(19 of 20 shared a cell at v1's current evaluation). Intervals come from a moving block bootstrap
over whole UTC days, every pair and hour of a day together, 7-day blocks, which covers the label
overlap and same-day co-movement. v1's diagnosis found calendar months describe more of the
outcome variance than cells or pairs, which 7-day blocks do not cover. Hence the month floors and
the leave-one-month-out condition. The evidence is roughly days, not rows.

**Seen data is never untouched evidence.** Only the prospective stage below can support anything.

### 7. Reuse and what is missing

Reusable unchanged (configuration may be new; the code is not changed):

| Component                                                               | File                                                                 | Role                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `indexHourly`, `consecutive`                                            | `scripts/spot24h.ts`                                                 | Validation without repair; feature and forward windows                  |
| `resolveOutcome`, `netReturn`, `potentialNetGain`                       | `scripts/spot24h.ts`                                                 | Outcomes and costs                                                      |
| `featuresAt`, `fitFrequencies`, `evaluateFit`                           | `scripts/spot24h.ts`                                                 | V1's cells, frequencies, `meanNet`, binary Brier, v1's selection        |
| `pairObservations`, `splitOf`, `dayOrders`, `ratioInterval`, `quantile` | `scripts/spot24h.ts`                                                 | Observations per scenario, purge, day-block bootstrap; v1-shaped config |
| `featuresOf`, `decisionTimes`                                           | `scripts/quantileForecast.ts`                                        | #220's eleven causal features; the grid for given dates                 |
| `fetchHistory`                                                          | `scripts/spot24hRun.ts`                                              | Paged public 1h klines                                                  |
| `codeIdentity`, write-once UNCHANGED / CONFLICT                         | `scripts/spot24hRun.ts`, `quantile_forecast.py`                      | Clean-tree runs, recorded blobs, results never overwritten              |
| Pinned environment, `check_environment`, `block_orders`                 | `scripts/quantile_forecast.py`, `quantile-forecast-requirements.txt` | scikit-learn 1.9.1, which includes the classifier                       |
| `decompose`, `outcomeAttribution`                                       | `scripts/spot24hDiagnostic.ts`                                       | Gross-to-net and per-outcome reporting                                  |

Missing outputs and data:

- **A joined observation export:** (pair, T, eleven features, v1 cell, v, T3S3 category, gross and
  net). v1's result holds aggregates only; #220's dataset has excursions, not categories.
- **STOP and TIMEOUT counts per cell** for V1's three-class forecast. `CellFit` keeps TARGET wins
  and `meanNet` only.
- **A classifier fit** and its probabilities. #220 fitted regressors only.
- **The evaluation layer:** expected-net plug-in, the three decision rules, per-opportunity value,
  three-class Brier, decile reliability, expected-net calibration, leave-one-month-out.
- **The target-fill sensitivity**, by calling `resolveOutcome` with a detection level (below).
- **A collector for a new period.** `collectHistory` is fixed to v1's cutoff and directory.
- **Data:** no candle after 2026-11-21T23:00Z has been collected for this purpose, and the
  evaluation period has not happened. No measured fee tier, spread or fill.
- **Time to exit.** `resolveOutcome` returns the deciding bar but `pairObservations` drops it.
  Needed only if a capital-constrained rule is chosen.

## v1's six scenarios as legacy choices

v1 fixed T3S3, T5S3, T8S3, T3S5, T5S5 and T8S5 (target and stop in multiples of v = ATR14 ÷ close)
before any data. They were never searched or validated; the diagnosis recommended no change to
them. Choosing among them by recorded results would select on examined history, so the choice
below uses only their geometry and the decision's needs.

**Recommendation: T3S3 as the one primary scenario.**

- **The barrier event decides a large share of outcomes only at 3 v.** In #220's fit, the 24-hour
  up and down excursions had medians of 1.98 v and 2.09 v and 90th percentiles of 5.93 v and
  5.73 v. A 5 v or 8 v level sits in the tail, so most trades time out (51–81% in v1's
  validation and test records), and the forecast becomes a forecast of the 24th close. That is a
  volatility property, not a return or a skill.
- **Symmetric levels give a plain null.** With no drift and continuous prices, target and stop are
  about equally likely to come first. Any departure is the signal to find.
- **The smallest stop.** 3 v rather than 5 v: this design excludes widening a stop, and a wider
  stop also needs a higher hit share (T3S5's net break-even was 65.7% of decided trades).
- **Against it:** costs are the largest share of the target move at 3 v (8.1% median), and the net
  break-even is 54.3% of decided trades.
- **Disclosure:** on test, T3S3 had the largest absolute ΔBrier (−0.00130) but the second-smallest
  skill score (0.63%), and ranked fourth of six on mean net (−0.41%). None of this was used.

## One modelling approach

**Proposed:** one multinomial classifier of v1's own T3S3 outcomes: scikit-learn's
`HistGradientBoostingClassifier` with `loss="log_loss"` and #220's frozen settings carried over
(`learning_rate=0.05`, `max_iter=100`, `max_leaf_nodes=15`, `min_samples_leaf=100`,
`l2_regularization=1.0`, `early_stopping=False`, `random_state=17`, others at 1.9.1 defaults), on
#220's eleven causal features, pooled over pairs, no coin identity, no class weights, no
recalibration. Classes: TARGET, STOP (with AMBIGUOUS), TIMEOUT. Its probabilities feed E[net] as
in [section 3](#3-what-must-be-predicted).

**What it adds over v1:** a joint forecast of all three outcomes rather than TARGET against the
rest, so expected net return can be formed; continuous features instead of six cells; and an
abstention rule judged against cash. It keeps v1's labels, levels, costs and evaluator. No setting
is chosen anew; a lower-capacity multinomial logistic regression would need new scaling and
regularization choices. Its known limit: n_TO is an unconditional fit-set mean, so a view on the
timeout return can show only through p_T − p_S.

**Stop condition.** Stage D below stops the approach unless C beats U in both development periods
with an upper bound below zero, its rule reaches 300 entries on 30 days, and its per-opportunity
mean is positive in both. Stage P is run once; NOT_SUPPORTED or INSUFFICIENT_EVIDENCE ends the
approach. In every case: no tuning, no feature, setting or scenario change, no second model, no
extension of the period.

## Proposed specification

PROPOSED / NOT RUN. At freezing, this table becomes
`docs/spot-24h-expected-net-t3s3.v1.json`, committed alone, and is never edited afterwards.

| Item                    | Proposed value                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Id                      | `popup-spot-24h-expected-net-t3s3-v1`                                                                                                                                                                                                                                                                                                                                              |
| Universe                | v1's 20 members, fixed; no re-selection, no newly listed coin. A missing or invalid candle makes a decision FEATURES_UNAVAILABLE or OUTCOME_MISSING: counted, never filled. A delisted pair stays in the universe with every later decision missing                                                                                                                                |
| Decisions, features     | v1's grid and 200-candle window. C: #220 `featuresOf`. V1: v1 `featuresAt` cells. v = ATR14 ÷ close at T                                                                                                                                                                                                                                                                           |
| Outcome, costs          | T3S3 only: target O × (1 + 3 v), stop O × (1 − 3 v); v1 `resolveOutcome` and `netReturn` unchanged. AMBIGUOUS counted separately                                                                                                                                                                                                                                                   |
| Target-fill sensitivity | `resolveOutcome` called with the target detection level O × (1 + 3 v) × 1.0005 (v1's slippage figure); a TARGET is then booked at O × (1 + 3 v). Reported; the economic point estimate must stay positive                                                                                                                                                                          |
| Forecasters             | U, V1 and C as in [section 5](#5-comparison); C as in [One modelling approach](#one-modelling-approach)                                                                                                                                                                                                                                                                            |
| Expected net            | E = p_T · netReturn(1, 1 + 3 v, TARGET) + p_S · netReturn(1, 1 + ḡ_S v, STOP) + p_TO · netReturn(1, 1 + ḡ_TO v, TIMEOUT); ḡ = the fit set's mean gross return ÷ v of that outcome                                                                                                                                                                                                  |
| Decision                | Enter if E > 0 (C, U) or by v1's selection (V1). Abstain = 0. Unit stake per observation, overlap allowed; not a wallet                                                                                                                                                                                                                                                            |
| Stage D, development    | v1's splits and purge on v1's saved candles (hashes verified, no download): fit on train, score validation; fit on train + validation, score test. Proceed only if ΔBrier₃(C − U) has a 95% upper bound below 0 in both, C's rule has ≥ 300 entries on ≥ 30 days over both, and its per-opportunity mean is above 0 in both. Else `STOP_AT_DEVELOPMENT`. Development evidence only |
| Final fit               | C, U and V1 fitted on all 87,500 v1 observations. The SHA-256 of C's fit-set predictions is committed before the evaluation period starts; stage P refits at its run commit and must reproduce it                                                                                                                                                                                  |
| Stage P, period         | Decisions from the first 00:00Z after that commit (date fixed in the JSON) for 6 calendar months. No interim look: candles are retrieved once, after the last label has closed, into a new git-ignored directory                                                                                                                                                                   |
| Uncertainty             | v1's `dayOrders`: moving block bootstrap over UTC days, all pairs together, 7-day blocks never wrapped, 10,000 replicates, seed `popup-spot-24h-expected-net-t3s3-v1`, type-7 percentiles; fits held fixed                                                                                                                                                                         |
| Criteria                | [Section 6](#6-criteria-kept-separate), on stage P only                                                                                                                                                                                                                                                                                                                            |
| Verdict                 | INTEGRITY_FAILURE (a hash or the prediction digest differs) → INSUFFICIENT_EVIDENCE (coverage or a floor) → SUPPORTED (predictive, calibration and economic all pass) → else NOT_SUPPORTED, each failing criterion named. Insufficient is inconclusive, not a pass                                                                                                                 |
| After any verdict       | The approach ends. SUPPORTED leads only to v1's remaining prerequisites: measured costs and fills, execution checks at about 44 USDT, and the owner's own decision. The study never produces an order                                                                                                                                                                              |
| Outputs                 | Git-ignored, written once, UNCHANGED or CONFLICT on a rerun; aggregates only in the report. Every earlier result keeps its recorded SHA-256                                                                                                                                                                                                                                        |

## Excluded

Recovery-based holding, extending the 24-hour horizon, widening a stop, shorts, leverage and newly
listed coins. Also: combining #220's quantiles into probabilities, and refitting during the
period. This document ran, downloaded and collected nothing, and touches no order, alert, account,
experiment record, UI or production system.

## Unresolved design decisions

1. **Whether to run it at all.** Every study that measured net returns on this history (v1, its
   diagnosis, the breadth filter, the channel breakout, structure entry) found none positive after
   costs, and the gross mean was negative on validation and test in every v1 scenario. Stopping
   the 24-hour line is a reasonable choice.
2. **The primary scenario.** T3S3 is recommended above; the owner may decline to choose one.
3. **Period length and start.** Six calendar months is a proposal carried from the diagnosis, not
   a finding. A decision could not come before mid-2027.
4. **Accounting.** Per-opportunity unit stake (proposed, as v1 and #219) or a capital-constrained
   44-USDT wallet. Minimum-notional limits would cap concurrent positions; that rule needs time
   to exit and a selection order, neither of which exists.
5. **Hurdle.** E > 0 (proposed) or a positive margin for estimation error.
6. **Stage D.** Keep the development gate (proposed) or go straight to the prospective period.
7. **Expected-net calibration tolerance.** 0.10 percentage points is proposed without precedent.
8. **Costs.** v1's assumed costs (proposed) or the account's measured fee tier, which needs an
   account read outside this task.
9. **Plug-ins.** Unconditional fit-set means for the stop and timeout returns (proposed) or a
   conditional timeout-return model, which would be a second fitted model.

## Sources

Read, not run: [`SPOT_24H_PROBABILITY.md`](SPOT_24H_PROBABILITY.md) and
[`spot-24h-probability.v1.json`](spot-24h-probability.v1.json), `scripts/spot24h.ts` and
`scripts/spot24hRun.ts`, [`SPOT_24H_V1_DIAGNOSTIC.md`](SPOT_24H_V1_DIAGNOSTIC.md),
[`STRUCTURE_ENTRY_1H_DEV_V1.md`](STRUCTURE_ENTRY_1H_DEV_V1.md),
[`QUANTILE_FORECAST_24H_DEV_V1.md`](QUANTILE_FORECAST_24H_DEV_V1.md), `scripts/quantileForecast.ts`
and `scripts/quantile_forecast.py`, all at `586d2bb`. The T3S3 illustration in section 3 applies
v1's `netReturn` to v1's recorded median level distance.
