# 24-hour quantile forecasts on v1's candles: a small edge over the volatility-scaled baseline, not established

**Status: development research, finished. Verdict `INCONCLUSIVE`; per the specification, stop.**
One fixed quantile model, scikit-learn's `HistGradientBoostingRegressor`, forecast three 24-hour
quantities on the hourly candles that [protocol v1](SPOT_24H_PROBABILITY.md) saved. That history
had already been examined by v1, its [diagnosis](SPOT_24H_V1_DIAGNOSTIC.md), the
[breadth filter](SPOT_24H_BREADTH_FILTER.md), the [channel-breakout wallet](SPOT_24H_CHANNEL_BREAKOUT.md)
and the [structure-entry comparison](STRUCTURE_ENTRY_1H_DEV_V1.md). Both evaluation periods are
examined historical development data, not untouched validation or independent confirmation.

This is a forecasting study. It is not a trading strategy, a target-before-stop probability, a
recovery forecast or approval for live use, and it does not evaluate profitability.

## In brief

- **Does the model beat the volatility-scaled baseline? Not shown.** Its mean pinball loss over the
  nine target and quantile combinations was lower in both periods: by 0.89% of the baseline's loss
  in development (validation) and 0.77% in the final period. It was lower in 16 of the 20 pairs in
  each period. Neither 95% interval excludes zero: their upper bounds are +0.0016 and +0.0007
  percentage points. Even the point estimates are under 1% of the loss.
- **Which targets are consistent across periods? None, by the frozen rule.** No target's interval
  is below zero in both periods. The downward excursion's is below zero in the final period
  (−0.0167 to −0.0007) but not in development. Descriptively, every target's 0.9 quantile had lower
  loss in both periods (−0.9% to −3.2%), and both excursions' 0.1 quantiles had slightly higher
  loss in both (+0.01% to +0.52%). Nothing tested that pattern.
- **Are the intervals calibrated and informative?** Both methods' nominal 80% intervals were within
  the frozen tolerances for every target and period: coverage 78.4% to 81.9%, each tail 8.2% to
  11.4%. The baseline, scaled by ATR alone, was already calibrated. The model's interval score was lower in all six
  target-periods, by 0.8% to 2.1%, and its mean width narrower in four. In development its
  terminal-return and downward-excursion intervals were wider on average, so those two do not count
  as informative. No forecast crossed another, and no excursion forecast was negative.
- **Is there enough evidence for a separately designed next step? No.** The specification allowed one
  only if the model beat the baseline with an upper bound below zero in both periods. Per the
  specification, this task stops here: no tuning, other model, feature change or new hypothesis.

## What was fixed in advance

[`docs/quantile-forecast-24h-dev-v1.json`](quantile-forecast-24h-dev-v1.json) was committed with
the pinned Python requirements, and nothing else, in `303c1d1`. That was before any study code
existed or any feature, label, fit or metric was computed on real data. Nothing in it changed
afterwards. It records every implementation choice; the main ones:

| Choice      | Fixed value                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data        | v1's 20 pairs and saved 1h candles, each file's SHA-256 checked against v1's recorded manifest. No download, repair or omission                                                                                                                                                                                                                                      |
| Decisions   | v1's: every 4 hours from 2024-11-22T00:00Z with T + 24h ≤ 2026-11-22T00:00Z, 4,375 per pair                                                                                                                                                                                                                                                                          |
| Features    | Eleven, on v1's 200 candles closed by T (so RSI, ATR and MACD keep v1's seeds), computed by Popup's own `rsi`, `macd`, `atr` and `sma`: close returns over 1, 4, 24 and 72 h; ATR14 ÷ close; population SD of the last 24 hourly log returns; RSI14 ÷ 100; MACD(12,26,9) histogram ÷ close; close ÷ SMA24 − 1; 24-candle high ÷ close − 1; close ÷ 24-candle low − 1 |
| Excluded    | The entry reference O (never exported), coin identity, volume, news, calendar, any other indicator, feature selection                                                                                                                                                                                                                                                |
| Labels      | From O = open at T over the 24 candles opening T … T + 23h: terminal return last close ÷ O − 1; up excursion max(0, max high ÷ O − 1); down excursion max(0, 1 − min low ÷ O). Full-window, unordered                                                                                                                                                                |
| Scale       | Each label ÷ v, v = ATR14 ÷ close at T (finite, > 0); forecasts × the same v, scored on the ordinary scale                                                                                                                                                                                                                                                           |
| Model       | Nine fits per evaluation, one per target and quantile 0.10, 0.50, 0.90, pooled over the 20 pairs: `loss="quantile"`, `learning_rate=0.05`, `max_iter=100`, `max_leaf_nodes=15`, `min_samples_leaf=100`, `l2_regularization=1.0`, `early_stopping=False`, `random_state=17`; every other parameter at scikit-learn 1.9.1's default, listed                            |
| Baseline    | Per target and quantile, the type-7 empirical quantile of the normalized target over the same fitting observations, × each observation's v                                                                                                                                                                                                                           |
| Periods     | v1's: train to 2025-11-22, validation to 2026-05-22, final to 2026-11-22; a label crossing a boundary is purged. Fit on train → evaluate validation; fit on train + validation → evaluate final, in one invocation                                                                                                                                                   |
| Forecasts   | Scored as produced: no sorting, rearrangement, clipping or repair                                                                                                                                                                                                                                                                                                    |
| Primary     | Mean over observations of (1/9) Σ over targets and quantiles of [model pinball − baseline pinball], ordinary scale, same observations                                                                                                                                                                                                                                |
| Uncertainty | Moving block bootstrap over whole UTC decision days, all pairs together, 7-day blocks never wrapped, 10,000 replicates, `numpy.random.default_rng(20261125)` per period in one `integers` call, type-7 percentiles 2.5 and 97.5; models held fixed                                                                                                                   |
| Verdict     | Fewer than 2,000 observations or 90 days in a period, or no interval: insufficient. Upper bound < 0 in both periods: improvement. A lower bound > 0 in either, or point difference ≥ 0 in both: no improvement. Otherwise inconclusive                                                                                                                               |
| Intervals   | Calibrated: coverage 75%–85% and each tail 7%–13%. Informative: calibrated, and both mean width and interval score below the baseline's                                                                                                                                                                                                                              |

The settings were checked against the installed stable API (`get_params()` of scikit-learn 1.9.1)
before freezing. With early stopping off there is no internal validation split, and with
`max_features=1.0` and under 200,000 rows no random draw affects a fit.

## Results

### Coverage

All 87,500 decisions (20 pairs × 4,375) became observations: no candle issue, no unavailable
feature window, no non-finite feature, no non-positive v and no unavailable label window. Train
43,700 (365 days), validation 21,620 (181 days), final 21,980 (184 days); 100 decisions were purged
at each of the two inner boundaries. All 18 estimators ran their 100 iterations.

### Primary metric

Mean pinball loss in percent of O (fractional return × 100), each method's equal-weight mean over the
nine combinations on the same observations. Negative differences favour the model.

|                                        |                Development |                       Final |
| -------------------------------------- | -------------------------: | --------------------------: |
| Fit                                    |      train: 43,700 (365 d) | train + val: 65,320 (546 d) |
| Evaluated                              | validation: 21,620 (181 d) |       final: 21,980 (184 d) |
| Model                                  |                     0.7254 |                      0.7462 |
| Baseline                               |                     0.7319 |                      0.7520 |
| **Model − baseline**                   |       **−0.0065 (−0.89%)** |        **−0.0058 (−0.77%)** |
| 95% interval                           |         −0.0160 to +0.0016 |          −0.0133 to +0.0007 |
| Label                                  |      `NO_CLEAR_DIFFERENCE` |       `NO_CLEAR_DIFFERENCE` |
| Normalized scale (v units), relative   |                     −0.81% |                      −0.45% |
| Pairs where the model's loss was lower |                   16 of 20 |                    16 of 20 |

All 10,000 replicates were defined in both periods. Neither period is `BETTER` or `WORSE`; the point
differences are negative in both, so the verdict is `INCONCLUSIVE`, not `NO_IMPROVEMENT`.

### By target

Each target's mean over its three quantiles, with its own interval from the same draws.

| Target          | Development, model − baseline (relative) | 95% interval       | Final, model − baseline (relative) | 95% interval       | Consistency      |
| --------------- | ---------------------------------------: | ------------------ | ---------------------------------: | ------------------ | ---------------- |
| Terminal return |                         −0.0066 (−0.71%) | −0.0202 to +0.0039 |                   −0.0031 (−0.32%) | −0.0121 to +0.0061 | `NOT_CONSISTENT` |
| Up excursion    |                         −0.0085 (−1.29%) | −0.0201 to +0.0021 |                   −0.0059 (−0.86%) | −0.0167 to +0.0022 | `NOT_CONSISTENT` |
| Down excursion  |                         −0.0043 (−0.72%) | −0.0135 to +0.0048 |                   −0.0083 (−1.38%) | −0.0167 to −0.0007 | `NOT_CONSISTENT` |

Three targets, no multiplicity adjustment: the down excursion's single interval below zero, in one
period only, should be read in that light.

### By quantile

Relative difference in mean pinball loss, model ÷ baseline − 1.

| Target          | q    | Development |  Final |
| --------------- | ---- | ----------: | -----: |
| Terminal return | 0.10 |      −0.73% | −0.72% |
|                 | 0.50 |      −0.61% | +0.31% |
|                 | 0.90 |      −0.88% | −1.15% |
| Up excursion    | 0.10 |      +0.01% | +0.52% |
|                 | 0.50 |      −1.03% | −0.01% |
|                 | 0.90 |      −2.17% | −2.56% |
| Down excursion  | 0.10 |      +0.22% | +0.16% |
|                 | 0.50 |      +0.24% | −0.73% |
|                 | 0.90 |      −2.59% | −3.16% |

Most of the gain sits in the 0.9 quantiles, the size of the larger moves, which the features
apparently help scale beyond ATR alone. This reading is after the fact and untested.

The 0.5 forecasts were no better by median absolute error. In development the model's error was
slightly higher for all three targets: 1.918% vs 1.913% (terminal), 1.295% vs 1.278% (up) and
1.271% vs 1.248% (down). In the final period it was 1.859% vs 1.861%, 1.176% vs 1.167% and 1.274%
vs 1.276%. Observations fell below the model's median 49.2% to 53.7% of the time (baseline 48.6% to
51.8%).

### Forecast intervals (nominal 80%)

Coverage, below-q10 and above-q90 in percent; widths in percent of O.

| Target, period        | Model cov / below / above | Baseline cov / below / above | Mean width, model / baseline | Median width, model / baseline | Interval score vs baseline | Model interval            |
| --------------------- | ------------------------- | ---------------------------- | ---------------------------: | -----------------------------: | -------------------------: | ------------------------- |
| Terminal, development | 81.9 / 9.3 / 8.8          | 79.9 / 10.3 / 9.8            |                  9.31 / 9.27 |                    9.47 / 8.72 |                     −0.81% | `CALIBRATED`, `NOT_SHOWN` |
| Terminal, final       | 81.1 / 10.1 / 8.9         | 80.3 / 10.5 / 9.2            |                  9.26 / 9.72 |                    9.02 / 8.70 |                     −0.95% | `CALIBRATED`, informative |
| Up, development       | 78.7 / 11.4 / 9.9         | 78.4 / 10.6 / 11.0           |                  6.16 / 6.28 |                    5.97 / 5.91 |                     −1.55% | `CALIBRATED`, informative |
| Up, final             | 79.8 / 10.8 / 9.4         | 80.4 / 10.0 / 9.7            |                  6.35 / 6.70 |                    5.94 / 6.00 |                     −1.71% | `CALIBRATED`, informative |
| Down, development     | 81.7 / 10.1 / 8.2         | 80.3 / 9.5 / 10.1            |                  6.21 / 6.02 |                    6.24 / 5.67 |                     −1.72% | `CALIBRATED`, `NOT_SHOWN` |
| Down, final           | 80.0 / 9.9 / 10.1         | 79.4 / 9.5 / 11.1            |                  6.09 / 6.32 |                    5.84 / 5.65 |                     −2.08% | `CALIBRATED`, informative |

The baseline was calibrated in every row too. In five of six rows the model's median width is wider
than the baseline's, though its mean width is narrower in four. That pattern fits the model
narrowing the widest volatility-scaled intervals and widening typical ones, but it is descriptive
only. Quantile crossings: 0 for both methods in every target and period. Negative excursion
forecasts: 0.

For scale, the training fit's baseline put the terminal return's 10%, 50% and 90% quantiles at
−4.02, −0.06 and +4.21 v, the up excursion's at 0.36, 1.98 and 5.93 v, and the down excursion's at
0.39, 2.09 and 5.73 v (v = ATR14 ÷ close).

## What this does and does not show

- **Forecasting improvement** (pinball loss) is small and not established: under 1% of the loss,
  with intervals reaching just above zero in both periods.
- **Interval calibration and usefulness**: both methods' 80% intervals were adequately calibrated.
  The model's interval score was 0.8% to 2.1% lower in every target-period, and its intervals were
  also narrower on average in four of six. That is a small gain.
- **Profitability is not evaluated.** No costs, entries, exits, sizes or returns of any rule were
  computed. A better quantile forecast need not pay after costs: v1's diagnosis found its assumed
  costs of about 0.25% to 0.30% per round trip exceeded every cell's mean gross return.
- **Not a path band.** The terminal-return interval covers the 24th close only, not the price path
  in between.
- **No event order.** The up and down excursion quantiles are separate, full-window forecasts. They
  do not say which came first, and so give no target-before-stop probability and no chance of
  recovery after a loss.

## Limits

- **Examined data.** Five earlier studies used this history, and its periods were not new to this
  design. Everything here is development evidence.
- **Dependence.** Decisions four hours apart share 20 of 24 label hours, and the 20 pairs co-move.
  Seven-day day blocks keep dependence within about a week only, so the intervals are optimistic.
- **Fixed fits.** The bootstrap resamples evaluation days with the models held fixed. It does not
  include the variability of refitting them.
- **Ordinary-scale weighting.** Pinball loss on the ordinary scale is v times the normalized loss,
  so volatile hours weigh more. The normalized-scale differences (−0.81% and −0.45%) point the same
  way.
- **Survivorship.** v1 chose the pairs by liquidity and listed history on 2026-11-21, then
  evaluated the two years before.

## Provenance

| Item          | Value                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Specification | `popup-quantile-forecast-24h-dev-v1`, SHA-256 (stable serialization, as v1) `a0d7ad9b57d1e3002a4dc8d63d45298fe6b72234486ed16865baf7f2b098c93c`, file SHA-256 `42cb7f4c306524f55ebaac048028456abfe5c0ae0e056e586414f3a411e0a389`, committed with only its requirements in `303c1d1`                                                                                                                                             |
| Code          | `73deab0232e0ed7b4380b1750f26d6303467dddb`. The dataset records each TypeScript and Python source file's git blob, and the result the Python files', the specification and the requirements. Candle validation, the window helper and the indicators are v1's and Popup's existing functions, unchanged                                                                                                                        |
| Inputs        | v1's recorded result `662c5d7d…6ec1e`, `universe.json` `b43acfda…` and the 20 candle files (17,720 candles each), each matched to its recorded SHA-256 before the export                                                                                                                                                                                                                                                       |
| Dataset       | `.zerochart-reports/quantile-forecast-24h-dev-v1-dataset-a0d7ad9b57d1-73deab0232e0.json` (git-ignored), 27,872,670 bytes, SHA-256 `c04d8c364d2167b3728d9eeb4d44ab1e8975ebf2a47cc477f07f41b1b21b31c6`, `CREATED` on 2026-11-25                                                                                                                                                                                                  |
| Result        | `.zerochart-reports/quantile-forecast-24h-dev-v1-a0d7ad9b57d1.json` (git-ignored), 461,665 bytes, SHA-256 `b6c0b3f169c480c8f3b095df087fb455a858ea49232fbf8c0b0b48b513560492`, `CREATED` on 2026-11-25                                                                                                                                                                                                                          |
| Determinism   | A second invocation of both steps at `73deab0`, before anything else was written, reported `UNCHANGED` for both files                                                                                                                                                                                                                                                                                                          |
| Environment   | CPython 3.12.14 on macOS 26.7.4 arm64; scikit-learn 1.9.1, numpy 2.5.5, scipy 1.18.1, joblib 1.6.0, threadpoolctl 3.8.0, narwhals 2.29.0, cloudpickle 3.1.3, installed from [`scripts/quantile-forecast-requirements.txt`](../scripts/quantile-forecast-requirements.txt) (SHA-256 `b4928392…e719`) with hashes, wheels only; OpenMP (libomp), 8 threads. The result holds every estimator's full `get_params()` and `n_iter_` |
| Preserved     | Every earlier result in `.zerochart-reports/` kept its recorded SHA-256 (v1 `662c5d7d`, diagnosis `6d6df8f1`, breadth `54183e97`, breakout `e4e734a3`, structure entry `aab7284c`); the market data was only read                                                                                                                                                                                                              |
| Checks        | 13 TypeScript tests (`scripts/quantileForecast.test.ts`) and 21 Python tests (`scripts/test_quantile_forecast.py`), synthetic data only; 11 single-rule mutations (window offset, label offset, SD convention, return lag, purge, fit set, inverse scaling, baseline quantile method, coverage, verdict rule, block range) each failed at least one test. Full suite 149 files and 2,528 tests, typecheck, lint, build         |

**Changes after the run.** One comment only: the estimator call in `scripts/quantile_forecast.py` is
marked `NOSONAR`, because SonarCloud cannot see that `learning_rate` and `random_state` arrive
through `**settings`. No code, setting or figure changed; the recorded blobs are the run commit's.

**The synthetic checks are not evidence of skill.** On a learnable synthetic dataset the model
beats the baseline in both periods, as an integration check must. On features unrelated to the
targets it does not, and a dry run of the TypeScript export into the Python study on i.i.d. random
walks gave `NO_IMPROVEMENT`.

## Running it

From the repository root, at `73deab0`:

```bash
python3.12 -m venv .venv
```

```bash
.venv/bin/python -m pip install --require-hashes --only-binary :all: -r scripts/quantile-forecast-requirements.txt
```

```bash
npm run evaluate -- quantile-forecast-export
```

```bash
.venv/bin/python scripts/quantile_forecast.py
```

Both steps refuse to run while a tracked file differs from `HEAD`. The export verifies every input
and writes the dataset once, named by the specification hash and the commit. The fit refuses a
dataset from another commit, a different specification file or an installed version that differs
from its pin. It writes the result once; a rerun reports `UNCHANGED` for identical bytes, or
`CONFLICT` and overwrites nothing. At a later commit the export writes a new dataset and the fit
reports `CONFLICT`, by design: reproduce at `73deab0`. Tests:

```bash
.venv/bin/python -m unittest discover -s scripts -p 'test_quantile_forecast.py'
```

**Not done:** no UI, order, alert, account read, experiment record, migration, deployment,
schedule, download or prospective collection.
