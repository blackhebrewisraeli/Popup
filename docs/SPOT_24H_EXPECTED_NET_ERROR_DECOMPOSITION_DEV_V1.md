# Stage D's expected-net overprediction, decomposed: probability and payoff components

**Status: descriptive diagnostic of stage D's one recorded run
([#222](SPOT_24H_EXPECTED_NET_T3S3_DEV_V1.md), verdict `STOP`), finished. Nothing was refitted,
re-forecast or reselected, and #222's result and its `STOP` stand.** It reads #222's recorded
dataset, classifier probabilities and result, and splits C's realized-minus-forecast expected net
into two additive parts: outcome-probability error weighted by the plug-in's assumed payoffs, and
the error of those assumed payoffs.

**Every return figure below is simulated research on historical candles with assumed costs (0.10%
fee per fill, 0.05% slippage on market fills). None is the owner's Binance balance or a realized
trade.** Figures are in percentage points of return per observation (unit stake). Both evaluation
periods are examined development data.

**The components are accounting, not causes.** They do not show that a different probability
model or payoff estimate would have changed a decision or would improve future ones.

## In brief

- **Which component accounts for the overprediction on C's entries?** In development, both did,
  and the probability component was the larger: of the −0.66-point error, −0.51 (95% −0.93 to
  −0.18) came from probability error and −0.15 (−0.25 to −0.05) from the payoff approximation
  (point shares 78% and 22%). On the entered observations C forecast TARGET at 40.8% on average
  against 32.3% observed, and STOP at 26.5% against 31.7%. The payoff part was entirely timeouts:
  entered timeouts ended below the pooled timeout payoff. In the final period neither component is
  resolved: −0.09 (−1.15 to +0.83) and −0.12 (−0.30 to +0.07) of a −0.21 error whose own interval
  (−1.19 to +0.68) includes zero; there, the entered observations' average class forecasts were
  within one point of the observed shares.
- **Is the pattern consistent across periods? No** (`NOT_CONSISTENT` by the rule fixed in
  advance). The probability component was large and resolved in development, small and
  unresolved in the final period. Only the payoff component had the same sign and a similar size
  in both (−0.15 and −0.12), and its final interval includes zero.
- **What can be concluded?** In development, most of the overprediction on entries sat in the
  probabilities of the observations C chose, not in the pooled payoffs the contract named as the
  plug-in's limit. Stops and targets contributed nothing material to the payoff part; all of it
  came from timeouts. Nothing here says which change, if any, would have helped, and the final
  period does not repeat the development split.
- **Does this justify a specific next investigation? No; the approach stays closed.** The one
  resolved, dominant component does not recur in the other period, the one recurring component is
  the smaller one and is resolved in only one period, the history has now been examined eight
  times, and #222's frozen stop rule rules out a payoff or plug-in change on it.

## What was fixed in advance

[`docs/spot-24h-expected-net-error-decomposition-dev-v1.json`](spot-24h-expected-net-error-decomposition-dev-v1.json)
was committed alone in `fbe38f5`, before any diagnostic code existed or any diagnostic figure was
computed. It was not edited afterwards.

| Choice         | Fixed value                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs         | #222's specification, dataset, predictions and result, each against its recorded SHA-256; the result's manifest and every code blob it records checked at the run commit `4d53653`. No download, repair, refit or regeneration                  |
| Reproduction   | `scripts/expectedNet.ts` changed after the run (#222's Sonar commit). Its `evaluateStudy` at this diagnostic's commit had to reproduce the recorded result byte for byte before anything else was computed                                      |
| Held fixed     | Both evaluations, every row's split, outcome and net, C's recorded probabilities, each fit set's pooled ḡ_S and ḡ_TO, C's forecast E and its decision ENTER if E > 0                                                                            |
| Identity       | r − E = Σ_k (I_k − p̂_k) n̂_k + Σ_k I_k (r − n̂_k), k ∈ {TARGET, STOP (with AMBIGUOUS), TIMEOUT}; n̂_k #222's own observation-specific payoffs: netReturn(1, 1 + 3v, TARGET), netReturn(1, 1 + ḡ_S v, STOP), netReturn(1, 1 + ḡ_TO v, TIMEOUT)      |
| Components     | Probability A = Σ_k (I_k − p̂_k) n̂_k; payoff B = Σ_k I_k (r − n̂_k); both reported per class                                                                                                                                                      |
| Tolerance      | 1e-12 per observation and per subset mean (#222's parity tolerance); a breach stops the run                                                                                                                                                     |
| Subsets        | All scored observations and #222's ENTER subset only; no pair, month, threshold, decile or outcome subset                                                                                                                                       |
| Uncertainty    | #222's paired 7-day whole-day block bootstrap, 10,000 replicates, same seed and grid labels, one set of day orders per period for every quantity; forecasts, payoffs and selections held fixed                                                  |
| Reconciliation | Totals, means, counts, days and the 95% interval of r − E equal to #222's recorded expected-net calibration exactly; ENTER count, entered outcomes and payoffs too; any difference listed before any reading                                    |
| Reading        | Each component `NEGATIVE` if its upper bound < 0, `POSITIVE` if its lower bound > 0, else `UNRESOLVED`; for ENTER, the negative components account for the error, or `NOT_RESOLVED`; `CONSISTENT` only if both periods name the same components |

Two properties of the identity matter for reading it. A is weighted by the assumed payoffs, and
because Σ_k (I_k − p̂_k) ≈ 0, adding one constant to all three payoffs leaves A unchanged but moves
it between classes: the per-class A_k are bookkeeping, not separate errors. And n̂_TARGET is the
scenario's exact target level, so B_TARGET is zero up to rounding by construction.

## The run

- Code at `a16c826` on a clean tracked tree; output
  `.zerochart-reports/spot-24h-expected-net-error-decomposition-dev-v1-67ad9d76749d.json`
  (SHA-256 `69274e1e…`); specification SHA-256 (stable serialization) `67ad9d76749d…`. A second
  invocation printed `UNCHANGED`. About 7 seconds; no network.
- Inputs as recorded: specification `0f67666dc4f8…` (file `b9fe596a…`), dataset `477946a0…`,
  predictions `23a18828…`, result `1f291c94…`, every recorded code blob equal at `4d53653`.
  #222's result was reproduced byte for byte; none of its files was written.
- Reconciliation: no difference. For both periods and both subsets the observations, days, mean
  forecast, mean realized net, mean difference and its 95% interval equal #222's recorded
  figures exactly, as do the ENTER counts (1,830 and 1,372), the entered outcomes and the pooled
  payoffs. The identity held within 1e-12 for every observation and every mean.
- Two rounding slips in #222's report text, not in its recorded figures: it prints the final ENTER
  difference's lower bound as −1.20 (recorded −1.1948, so −1.19) and the final period's observed
  TARGET share as 29.3% (recorded 29.249%, so 29.2%). Neither changes a label, gate or verdict;
  #222's report is left as merged.

## Results

### Totals and components

Mean per observation, percentage points, 95% interval; difference = realized − forecast.

| Period, subset     | Observations (days) | Total r − E                | Probability A              | Payoff B                      | Reading            |
| ------------------ | ------------------: | -------------------------- | -------------------------- | ----------------------------- | ------------------ |
| Development, all   |        21,620 (181) | −0.03 (−0.35 to +0.18)     | +0.02 (−0.28 to +0.24)     | **−0.055 (−0.112 to −0.023)** | B `NEGATIVE`       |
| Development, ENTER |         1,830 (166) | **−0.66 (−1.12 to −0.28)** | **−0.51 (−0.93 to −0.18)** | **−0.145 (−0.248 to −0.051)** | A and B `NEGATIVE` |
| Final, all         |        21,980 (184) | −0.09 (−0.35 to +0.24)     | −0.07 (−0.33 to +0.25)     | −0.014 (−0.057 to +0.029)     | neither resolved   |
| Final, ENTER       |         1,372 (170) | −0.21 (−1.19 to +0.68)     | −0.09 (−1.15 to +0.83)     | −0.120 (−0.303 to +0.066)     | `NOT_RESOLVED`     |

Point shares of the ENTER total: development 78% probability, 22% payoff; final 44% and 56%. With
the final period's intervals this wide, its shares are not informative.

### By outcome class, ENTER subset

Observed share against C's mean forecast, and each class's terms (percentage points, 95%).

| Development ENTER  | Count (share) | Mean p̂ | A_k                         | B_k                           |
| ------------------ | ------------: | -----: | --------------------------- | ----------------------------- |
| TARGET             |   592 (32.3%) |  40.8% | **−0.30 (−0.55 to −0.07)**  | 0 (rounding, below 1e-15)     |
| STOP (0 AMBIGUOUS) |   581 (31.7%) |  26.5% | **−0.20 (−0.47 to −0.002)** | +0.000002, positive           |
| TIMEOUT            |   657 (35.9%) |  32.7% | −0.011 (−0.023 to +0.006)   | **−0.145 (−0.248 to −0.051)** |

| Final ENTER        | Count (share) | Mean p̂ | A_k                       | B_k                       |
| ------------------ | ------------: | -----: | ------------------------- | ------------------------- |
| TARGET             |   495 (36.1%) |  37.0% | −0.10 (−0.68 to +0.40)    | 0 (rounding)              |
| STOP (1 AMBIGUOUS) |   356 (25.9%) |  25.1% | +0.009 (−0.52 to +0.48)   | +0.000001, positive       |
| TIMEOUT            |   521 (38.0%) |  37.9% | −0.002 (−0.027 to +0.018) | −0.120 (−0.303 to +0.066) |

- **Targets** cost no payoff error: the assumed payoff is the exact target level.
- **Stops** contributed a positive but negligible payoff term (about 0.000001–0.000002 points):
  the pooled ḡ_S was −3.000004 and −3.000003 because a few fit-period stops gapped, and the
  evaluated stops averaged slightly closer to the level.
- **Timeouts** carry the whole payoff component. The pooled ḡ_TO was −0.022 (development) and
  −0.048 (final) in units of v; the timeouts C entered ended lower than that on average.
- **Probabilities.** In development, the entered observations' forecasts overstated TARGET by 8.4
  points and understated STOP by 5.2 points in the large. In the final period they matched the
  observed shares within one point in every class, and A is small and unresolved.

### By outcome class, all scored observations

| Class   | Development: observed / mean p̂, A_k, B_k                                    | Final: observed / mean p̂, A_k, B_k                                      |
| ------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| TARGET  | 31.7% / 33.8%, −0.060 (−0.189 to +0.047), 0                                 | 29.2% / 33.1%, −0.073 (−0.196 to +0.073), 0                             |
| STOP    | 31.8% / 33.8%, +0.094 (−0.105 to +0.230), +0.000001                         | 34.1% / 32.8%, +0.009 (−0.143 to +0.203), +0.000001                     |
| TIMEOUT | 36.5% / 32.4%, **−0.013 (−0.023 to −0.001)**, **−0.055 (−0.112 to −0.023)** | 36.6% / 34.1%, **−0.009 (−0.020 to −0.001)**, −0.014 (−0.057 to +0.029) |

In development, over all observations, TARGET and STOP were both overpredicted by about two
points; with payoffs of opposite sign their terms offset (−0.060 and +0.094). On the entered
observations there was no such offset: TARGET was overpredicted and STOP underpredicted, so both
terms are negative.

## What this does and does not show

- **It shows** where #222's recorded ENTER overprediction sits in its own accounting. In
  development, mostly in the probabilities of the observations C selected (TARGET too high, STOP
  too low), with a smaller, resolved shortfall of entered timeouts against the pooled timeout
  payoff. In the final period, the error itself is not resolved and neither is either part.
- **It does not show** a cause. Selecting entries where E is high may itself pick observations
  whose probabilities are overstated, but this diagnostic does not test that. It does not show that
  recalibrated probabilities or a conditional timeout payoff would have changed decisions: either
  would change E and therefore the ENTER subset, which this diagnostic holds fixed. It says
  nothing about untouched or future data.
- **About the plug-in's stated limitation** (pooled stop and timeout payoffs): on entries it
  amounted to the timeout term only, −0.15 points in development (resolved) and −0.12 in the
  final period (not resolved). It was the smaller part of development's error.

## Next

None. The approach stays closed, as #222's specification requires after `STOP`: no tuning,
refit, revised forecast, payoff model, plug-in change, second model, strategy, new data or
prospective collection follows from this diagnostic. A specific investigation would need a
pattern that is resolved and repeats in both periods; the dominant component here does neither.
Any further work would be a separate proposal for the owner, on data not yet examined.

## Reproduce

At `a16c826`, with #222's recorded files in `.zerochart-reports/` (no candles or Python needed):

```bash
npm run evaluate -- expected-net-decomposition
```

It refuses a dirty tracked tree, any input whose SHA-256, manifest or recorded code blob differs,
and a result that #222's code does not reproduce. With the output present it prints `UNCHANGED`.
