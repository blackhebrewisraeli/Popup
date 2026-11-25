# 24-hour Spot long: decision contract and one proposed development experiment (PROPOSED / NOT RUN)

**Status: PROPOSED / NOT RUN.** A design document. Nothing here was fitted, scored, downloaded or
computed on real outcomes; every figure quoted comes from an earlier recorded report. It changes
no earlier specification, result or code.

**Scope: stage D only.** The one proposed experiment is a development study on v1's saved,
already examined candles. This document authorizes no prospective collection and no six-month
test. A prospective phase would be a separate proposal, reviewed on its own
([outline](#a-later-prospective-phase-not-proposed-here)). Stage D runs only if the owner
approves it, after its machine-readable specification has been committed on its own.

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
  expected net return after costs, which also depends on P(STOP), P(TIMEOUT) and the stop and
  timeout payoffs. Timeouts were 36–81% of v1's validation and test outcomes.
- **No untouched data remains.** 2024-11-22 to 2026-11-22 has been examined by six studies (v1,
  its diagnosis, breadth filter, channel breakout, structure entry, quantile forecast). Stage D
  would be a seventh look: development evidence only.

## Gap map

| Decision need                               | What exists                                                                            | Status                                  |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| Ordered outcome within 24 h                 | v1 `resolveOutcome`; reconciled exactly by the diagnosis; built on by #216–#219        | Exists, reuse unchanged                 |
| P(TARGET before STOP)                       | v1's six-cell frequencies: calibrated, not consistently better than the base rate      | Exists, no established skill            |
| P(STOP), P(TIMEOUT), jointly with P(TARGET) | Outcome counts per split and the diagnosis's attribution; no forecast                  | **Missing as a forecast**               |
| Stop and timeout payoffs                    | Inside each observation's net return; the diagnosis shows timeouts set the sign at 5 v | **Missing as a forecast**               |
| Expected net return per observation         | v1's per-cell fit `meanNet`, used only to select cells                                 | Partial                                 |
| Abstention against cash                     | v1's qualification (empty shortlist); #219 counted no entry as 0                       | Concept exists; no forecast rule tested |
| Calibration of a decision quantity          | v1: TARGET cells; #220: quantile intervals                                             | **Missing for expected net**            |
| Untouched evaluation data                   | None                                                                                   | **Missing**; outside this proposal      |
| Measured costs and fills                    | Assumed 0.10% fee per fill, 0.05% slippage on market fills                             | **Missing**; outside this proposal      |

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
  observations per scenario as AMBIGUOUS. That is a past rate on the examined history. It does not
  establish future rates, nor the rate inside a forecast-selected subset, which may favour volatile
  hours where both levels are reached more often. It does not show that finer candles will never
  be needed. Stage D reports the count and an [ordering sensitivity](#6-criteria-kept-separate).
- _Gap above the target (conservative):_ filled at the target, not at the higher open.
- _A touch fills at the level (optimistic for the target):_ candles cannot show whether a resting
  limit at the target would have filled; queue position and volume at that price are unknown.
  Stage D's target-overshoot check is an execution sensitivity assumption, not evidence that such
  orders fill.
- _Stop fill at the level less 0.05% (assumed):_ fast moves can fill worse.

### 3. What must be predicted

A trade's value is its expected net return, after costs, against cash at 0. Exactly:

```text
E[net | x] = p_T(x) · n_T(x) + p_S(x) · n_S(x) + p_TO(x) · n_TO(x)
```

with p_T + p_S + p_TO = 1 (AMBIGUOUS inside STOP) and n_k(x) = E[net | outcome k, x]. v1's
`netReturn` is linear in the exit price, so each n_k is `netReturn` at that outcome's conditional
mean exit. n_T depends on v alone, since a TARGET is always booked at the target. n_S depends on
gaps through the stop, and n_TO on where the 24th close lands. So a decision needs three joint
probabilities, the stop and timeout payoffs, and the costs. P(TARGET) alone does not determine the
sign. With v1's T3S3 levels at the median v of 1.057% (target and stop 3.17% away), n_T = +2.91%,
a stop at the level nets −3.46%, and a timeout at zero gross nets −0.30%:

| p_T  | p_S  | p_TO | Timeout gross | E[net]     |
| ---- | ---- | ---- | ------------- | ---------- |
| 0.35 | 0.25 | 0.40 | 0%            | **+0.03%** |
| 0.35 | 0.35 | 0.30 | 0%            | **−0.28%** |
| 0.35 | 0.25 | 0.40 | −0.5%         | **−0.16%** |

The same target probability gives opposite decisions. Costs enter every outcome, so the gross
hurdle is about 0.3% per trade.

**What the candidate estimates: a restricted plug-in approximation.** Its class probabilities are
conditional on the features, but its stop and timeout payoffs are not:

```text
Ê(x) = p̂_T(x)  · netReturn(1, 1 + 3 · v,    TARGET)
     + p̂_S(x)  · netReturn(1, 1 + ḡ_S · v,  STOP)
     + p̂_TO(x) · netReturn(1, 1 + ḡ_TO · v, TIMEOUT)
```

where ḡ_S and ḡ_TO are the pooled training-set means of gross return ÷ v over that outcome's
observations, one number each. Ê equals E[net | x] only if the stop and timeout payoffs, in units
of v, do not depend on the features. Any such dependence is left out, so Ê is not a complete
conditional expected-return model. The [calibration checks](#6-criteria-kept-separate) measure how
far Ê departs from realized net return.

### 4. Enter or abstain

Each eligible (pair, T) is a choice: ENTER, earning that position's net return on a unit stake, or
ABSTAIN, holding cash at exactly 0 with no cost. Abstaining everywhere is a complete and valid
answer and is the reference to beat. Beating "always enter" (v1's −0.37% to −0.44% on test) is not
usefulness: #219's waiting arm beat a losing arm and still did not beat cash.

**Per-opportunity return, not a wallet.** A rule is valued by the mean of d · net over all eligible
observations, d ∈ {0, 1}, abstentions included as 0; entry rate and mean net per trade are
reported beside it. Positions on a unit stake may overlap, without a capital limit or compounding.
This measures whether the forecast's selections earn more than cash on average. It does not
measure what a capital-limited 44-USDT wallet would earn: that needs time to exit, a limit on
concurrent positions, a selection order among simultaneous ENTER signals and minimum-notional
rounding, none of which stage D specifies. Stage D reports concurrency so that the gap is visible.

### 5. Comparison

Three forecasters on the same observations, outcomes, levels and costs, each fitted only on data
before the period it is scored on:

| Forecaster                    | Probabilities                                                               | Expected net and decision                                                 |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| U, unconditional baseline     | Fit-set frequencies of TARGET, STOP, TIMEOUT                                | The same plug-in with those constant frequencies; enter if Ê > 0          |
| V1, v1's estimator, unchanged | `fitFrequencies` per RSI × MACD cell; STOP and TIMEOUT counted the same way | The cell's fit `meanNet`; v1's selection: a probability and `meanNet` > 0 |
| C, the candidate              | One model's joint probabilities ([below](#one-modelling-approach))          | The restricted plug-in of section 3; enter if Ê > 0                       |

An observation is scored only where all three have a forecast; coverage below 95% is insufficient
evidence. V1's `meanNet` is the cell's mean realized net, so it conditions the whole expected net
on the cell; U and C use pooled stop and timeout payoffs.

### 6. Criteria, kept separate

Stage D evaluates two development periods with v1's splits: fit on train, score validation; fit on
train and validation, score test. Every condition below must hold in both, unless stated. All of
them are development gates on examined data, not untouched evidence.

**Predictive improvement.** The three-class Brier score, Σ_k (p_k − y_k)², averaged over
observations. C must be lower than U and lower than V1, each with the 95% upper bound of the
difference below zero. v1's binary TARGET Brier against its base rate is reported for continuity.

**Probability calibration.** Per class: calibration in the large ≤ 0.03 and observation-weighted
error over deciles of predicted probability ≤ 0.05. These are v1's pre-declared limits, reused as
design choices (deciles in place of cells); they are not empirically established.

**Expected-net calibration.** Reported separately on two subsets, each with mean Ê, mean realized
net, their difference (realized − predicted) with a 95% interval, and the same by decile of Ê:

| Subset       | Definition                                                                  | Role                 |
| ------------ | --------------------------------------------------------------------------- | -------------------- |
| All eligible | Every scored observation                                                    | Reported, not a gate |
| ENTER        | Observations with Ê_C > 0, selected from the forecasts only, never outcomes | Gate (below)         |

Each subset gets one label per period. `NO_ENTRIES`: no observation, so no mean or difference.
`INSUFFICIENT_SELECTED`: fewer than 300 observations or 30 distinct days; figures are shown as
descriptive, with no tolerance label. Otherwise, with tolerance τ: `WITHIN_TOLERANCE` if
|difference| ≤ τ, `OVERPREDICTED` if the difference is below −τ, `UNDERPREDICTED` if above +τ. The
gate needs ENTER to be `WITHIN_TOLERANCE` or `UNDERPREDICTED`.

_Why both subsets._ Aggregate calibration can look fine while the decision is miscalibrated. The
ENTER subset is chosen where Ê is high, so overpredictions concentrate there, and offsetting
errors elsewhere can hide them in the all-eligible mean. Only the ENTER subset bears on what was
entered.

_Why τ = 0.10 percentage points._ A proposed design value, not an empirical threshold: no earlier
study measured expected-net calibration. It is a third of the ~0.30% cost of a round trip (v1's
assumed costs), so an overprediction this large on entered trades would consume a third of the
hurdle the forecast is meant to clear. It should be reviewed with the specification.

**Economic usefulness.** In each period, C's per-opportunity mean net return is above 0 (its 95%
lower bound reported), its mean net per trade is above 0, the per-opportunity mean stays above 0
with any one calendar month left out, and it stays above 0 under the target-overshoot
sensitivity. Over both periods, at least 300 ENTER observations on at least 30 days in at least 3
calendar months. Paired differences against the U and V1 rules are reported with intervals.

**Sensitivities, reported with each period.**

- _Target overshoot (execution assumption):_ `resolveOutcome` is called with the detection level
  O × (1 + 3 v) × 1.0005, v1's slippage figure used as an arbitrary overshoot, and a TARGET is then
  booked at O × (1 + 3 v). A result that fails only here is `FILL_SENSITIVE`. Passing it does not
  show a resting limit would fill.
- _Ordering:_ the per-opportunity mean is also computed with entered AMBIGUOUS trades booked as
  TARGET, an optimistic bound. If the conservative figure is at or below 0 and the optimistic one
  is above 0, the result is `ORDERING_SENSITIVE`: neither a pass nor a clean negative, and finer
  candles would be needed to decide.

**Dependence.** Labels of decisions 4 hours apart share 20 of 24 hours, and the 20 pairs co-move
(19 of 20 shared a cell at v1's current evaluation). Intervals come from a moving block bootstrap
over whole UTC days, every pair and hour of a day together, 7-day blocks, which covers the label
overlap and same-day co-movement. v1's diagnosis found calendar months describe more of the
outcome variance than cells or pairs, which 7-day blocks do not cover. Hence the month floor and
the leave-one-month-out condition. The evidence is roughly days, not rows.

**Examined data is never untouched evidence.** Passing stage D shows only that a separate
prospective proposal may be worth writing.

### 7. Reuse and what is missing

Reusable unchanged (configuration may be new; the code is not changed):

| Component                                                               | File                                                                 | Role                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `indexHourly`, `consecutive`                                            | `scripts/spot24h.ts`                                                 | Validation without repair; feature and forward windows                  |
| `resolveOutcome`, `netReturn`, `potentialNetGain`                       | `scripts/spot24h.ts`                                                 | Outcomes, deciding bar and costs                                        |
| `featuresAt`, `fitFrequencies`, `evaluateFit`                           | `scripts/spot24h.ts`                                                 | V1's cells, frequencies, `meanNet`, binary Brier, v1's selection        |
| `pairObservations`, `splitOf`, `dayOrders`, `ratioInterval`, `quantile` | `scripts/spot24h.ts`                                                 | Observations per scenario, purge, day-block bootstrap; v1-shaped config |
| `featuresOf`, `decisionTimes`                                           | `scripts/quantileForecast.ts`                                        | #220's eleven causal features; v1's decision grid                       |
| `codeIdentity`, write-once UNCHANGED / CONFLICT                         | `scripts/spot24hRun.ts`, `quantile_forecast.py`                      | Clean-tree runs, recorded blobs, results never overwritten              |
| Pinned environment, `check_environment`, `block_orders`                 | `scripts/quantile_forecast.py`, `quantile-forecast-requirements.txt` | scikit-learn 1.9.1, which includes the classifier                       |
| `decompose`, `outcomeAttribution`                                       | `scripts/spot24hDiagnostic.ts`                                       | Gross-to-net and per-outcome reporting                                  |

Missing for stage D (to be written in the experiment, not here):

- **A joined observation export:** (pair, T, eleven features, v1 cell, v, T3S3 category, deciding
  bar, gross and net). v1's result holds aggregates only, `pairObservations` drops the deciding bar,
  and #220's dataset has excursions, not categories.
- **STOP and TIMEOUT counts per cell** for V1's three-class forecast. `CellFit` keeps TARGET wins
  and `meanNet` only.
- **A classifier fit** and its probabilities. #220 fitted regressors only.
- **The evaluation layer:** the plug-in, the three decision rules, per-opportunity value,
  three-class Brier, decile reliability, two-subset expected-net calibration, leave-one-month-out,
  both sensitivities and concurrency.

Stage D needs no new data: v1's 20 saved candle files, verified against v1's recorded hashes.

## v1's six scenarios as legacy choices

v1 fixed T3S3, T5S3, T8S3, T3S5, T5S5 and T8S5 (target and stop in multiples of v = ATR14 ÷ close)
before any data. They were never searched or validated, and the diagnosis recommended no change to
them.

**Recommendation: T3S3, a development-informed design choice.** Its rationale draws on results
observed in the examined history: the 24-hour excursion distribution measured in #220, and the
outcome frequencies and level distances v1 recorded. It does not rank scenarios by recorded
profitability or skill, and T3S3 is not the best on either. Because the rationale used examined
data, the choice belongs to the development design; it is not a choice made before seeing that
history.

- **The barrier event decides a large share of outcomes only at 3 v.** In #220's fit, the 24-hour
  up and down excursions had medians of 1.98 v and 2.09 v and 90th percentiles of 5.93 v and
  5.73 v. A 5 v or 8 v level sits in the tail, so most trades time out (51–81% in v1's validation
  and test records), and the forecast becomes a forecast of the 24th close. These are observed
  frequencies of reaching a level, not returns after costs.
- **Symmetric levels give a plain null.** With no drift and continuous prices, target and stop are
  about equally likely to come first. Any departure is the signal to find.
- **The smallest stop.** 3 v rather than 5 v: this design excludes widening a stop, and a wider
  stop also needs a higher hit share (T3S5's net break-even was 65.7% of decided trades).
- **Against it:** costs are the largest share of the target move at 3 v (8.1% median), and the net
  break-even is 54.3% of decided trades.
- **Recorded profitability and skill, not the criterion:** on test, T3S3 had the largest absolute
  ΔBrier (−0.00130) but the second-smallest skill score (0.63%), and ranked fourth of six on mean
  net (−0.41%; T8S3 was highest at −0.37%).

## One modelling approach

**Proposed:** one multinomial classifier of v1's own T3S3 outcomes: scikit-learn's
`HistGradientBoostingClassifier` with `loss="log_loss"` and #220's frozen settings carried over
(`learning_rate=0.05`, `max_iter=100`, `max_leaf_nodes=15`, `min_samples_leaf=100`,
`l2_regularization=1.0`, `early_stopping=False`, `random_state=17`, others at 1.9.1 defaults), on
#220's eleven causal features, pooled over pairs, no coin identity, no class weights, no
recalibration. Classes: TARGET, STOP (with AMBIGUOUS), TIMEOUT. Its probabilities feed the
restricted plug-in of [section 3](#3-what-must-be-predicted).

**What it adds over v1:** a joint forecast of all three outcomes rather than TARGET against the
rest, which, with pooled payoffs, gives a restricted plug-in approximation of expected net;
continuous features instead of six cells; and an abstention rule judged against cash. It keeps
v1's labels, levels, costs and evaluator. No setting is chosen anew; a lower-capacity multinomial
logistic regression would need new scaling and regularization choices. Its limit: stop and timeout
payoffs are pooled training-set means in units of v, not conditional on the features.

**Stop condition.** Stage D is run once. If any gate fails, or the result is
INSUFFICIENT_EVIDENCE, `ORDERING_SENSITIVE` or `FILL_SENSITIVE`, the approach stops: no tuning, no
feature, setting, scenario or plug-in change, no second model. Passing permits only writing a
separate prospective proposal for review.

## Proposed specification: stage D

PROPOSED / NOT RUN. At freezing, this table becomes `docs/spot-24h-expected-net-t3s3-dev-v1.json`,
committed alone before any study code or figure, and is never edited afterwards.

| Item                 | Proposed value                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Id                   | `popup-spot-24h-expected-net-t3s3-dev-v1`                                                                                                                                                                                                                                              |
| Data                 | v1's 20 pairs and saved 1h candles, each file's SHA-256 checked against v1's recorded manifest, and v1's result `662c5d7d…` verified. No download, repair or omission                                                                                                                  |
| Decisions, features  | v1's grid from 2024-11-22T00:00Z, labels ending by 2026-11-22T00:00Z. C: #220 `featuresOf`. V1: v1 `featuresAt` cells. v = ATR14 ÷ close at T                                                                                                                                          |
| Outcome, costs       | T3S3 only: target O × (1 + 3 v), stop O × (1 − 3 v); v1 `resolveOutcome` and `netReturn` unchanged. AMBIGUOUS counted separately; deciding bar recorded                                                                                                                                |
| Periods              | v1's splits and purge: fit on train, score validation; fit on train and validation, score test                                                                                                                                                                                         |
| Forecasters          | U, V1 and C as in [section 5](#5-comparison); C as in [One modelling approach](#one-modelling-approach)                                                                                                                                                                                |
| Expected net         | The restricted plug-in of [section 3](#3-what-must-be-predicted), with ḡ_S and ḡ_TO from each fit set                                                                                                                                                                                  |
| Decision, accounting | Enter if Ê > 0 (C, U) or by v1's selection (V1); abstain = 0. Unit stake per observation, overlap allowed. Concurrency reported: open ENTER positions per hour (maximum, median) and ENTER pairs per decision time. No wallet simulated                                                |
| Uncertainty          | v1's `dayOrders`: moving block bootstrap over UTC days, all pairs together, 7-day blocks never wrapped, 10,000 replicates, seed `popup-spot-24h-expected-net-t3s3-dev-v1`, type-7 percentiles; fits held fixed                                                                         |
| Gate                 | Every condition of [section 6](#6-criteria-kept-separate)                                                                                                                                                                                                                              |
| Verdict              | INTEGRITY_FAILURE (a hash differs) → INSUFFICIENT_EVIDENCE (coverage below 95%, ENTER `NO_ENTRIES` or `INSUFFICIENT_SELECTED`, or the entry floor) → GATE_PASSED (every condition holds) → else STOP, each failing condition named. `ORDERING_SENSITIVE` and `FILL_SENSITIVE` are STOP |
| After                | STOP ends the approach. GATE_PASSED is development evidence only and permits writing a separate prospective proposal. Neither authorizes collection, a prospective test or an order                                                                                                    |
| Outputs              | Git-ignored, written once, UNCHANGED or CONFLICT on a rerun; aggregates only in the report. Every earlier result keeps its recorded SHA-256                                                                                                                                            |

### Recommended defaults

Every technical choice has a default, so the owner need not settle them:

| Choice                   | Default                                       | Reason                                                                                      |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Scenario                 | T3S3                                          | Development-informed, [above](#v1s-six-scenarios-as-legacy-choices)                         |
| Hurdle                   | Ê > 0                                         | Costs are already in net; a margin would be a new tunable with nothing to set it from       |
| Accounting               | Per-opportunity unit stake, concurrency shown | Isolates the value of the forecast's selections; a wallet needs rules stage D does not have |
| Costs                    | v1's assumed 0.10% fee, 0.05% slippage        | Comparable with every earlier study; measured costs need an account read outside this scope |
| Stop and timeout payoffs | Pooled training-set means ÷ v                 | One fitted model; conditional payoffs would need a second                                   |
| Classifier settings      | #220's                                        | No new hyperparameter                                                                       |
| Probability calibration  | v1's 0.03 and 0.05                            | v1's pre-declared limits; no new value                                                      |
| Expected-net tolerance τ | 0.10 percentage points                        | A third of the round-trip cost; proposed, not empirical                                     |
| Evidence floors          | 300 ENTER observations, 30 days, 3 months     | v1's expectancy floor and the diagnosis's month floor                                       |
| Bootstrap                | 7-day day blocks, 10,000 replicates           | v1's block length; #219's and #220's replicate count                                        |

### For the owner

1. **Whether to run stage D at all.** Every study that measured net returns on this history (v1,
   its diagnosis, the breadth filter, the channel breakout, structure entry) found none positive
   after costs, and the gross mean was negative on validation and test in every v1 scenario.
   Stopping the 24-hour line is a reasonable choice.
2. **Whether to accept the defaults,** or name any to change before the specification is frozen.

## A later prospective phase (not proposed here)

Only after GATE_PASSED, and only as its own reviewed proposal. It would need, at least: a
specification frozen before its period; the final fit and a digest of its predictions committed
before the period starts; a period length (the diagnosis's six months is a starting point, not a
finding); collection only after the period ends, into a new directory; measured costs and fills;
and, if wanted, a capital-limited wallet with its own rules. Nothing in this document starts or
authorizes any of it.

## Excluded

Recovery-based holding, extending the 24-hour horizon, widening a stop, shorts, leverage and newly
listed coins. Also: combining #220's quantiles into probabilities, and any prospective collection
or test. This document ran, downloaded and collected nothing, and touches no order, alert,
account, experiment record, UI or production system.

## Sources

Read, not run: [`SPOT_24H_PROBABILITY.md`](SPOT_24H_PROBABILITY.md) and
[`spot-24h-probability.v1.json`](spot-24h-probability.v1.json), `scripts/spot24h.ts` and
`scripts/spot24hRun.ts`, [`SPOT_24H_V1_DIAGNOSTIC.md`](SPOT_24H_V1_DIAGNOSTIC.md),
[`STRUCTURE_ENTRY_1H_DEV_V1.md`](STRUCTURE_ENTRY_1H_DEV_V1.md),
[`QUANTILE_FORECAST_24H_DEV_V1.md`](QUANTILE_FORECAST_24H_DEV_V1.md), `scripts/quantileForecast.ts`
and `scripts/quantile_forecast.py`, all at `586d2bb`. The T3S3 illustration in section 3 applies
v1's `netReturn` to v1's recorded median level distance.
