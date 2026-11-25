# Stage D: 24-hour T3S3 expected net on v1's candles: verdict `STOP`

**Status: development research, finished. Verdict `STOP`; per the specification, the approach
ends here.** Stage D of the [decision contract](SPOT_24H_DECISION_CONTRACT.md) was run once. It
compared one three-class classifier (C) with an unconditional baseline (U) and v1's own cell
estimator (V1) on v1's saved hourly candles. That history had already been examined by v1, its
[diagnosis](SPOT_24H_V1_DIAGNOSTIC.md), the [breadth filter](SPOT_24H_BREADTH_FILTER.md), the
[channel-breakout wallet](SPOT_24H_CHANNEL_BREAKOUT.md), the
[structure-entry comparison](STRUCTURE_ENTRY_1H_DEV_V1.md) and the
[quantile forecast](QUANTILE_FORECAST_24H_DEV_V1.md). This was a seventh look: both evaluation
periods are examined development data, never untouched evidence.

**Every return figure below is simulated research on historical candles with assumed costs (0.10%
fee per fill, 0.05% slippage on market fills). None is the owner's Binance balance or a realized
trade.** Returns are in percent of the entry price on a unit stake.

C's expected net return is a **restricted plug-in**: its class probabilities depend on the
features, but its stop and timeout payoffs are pooled training-set means. It is not a complete
conditional return model.

## In brief

- **Did C improve predictions over U and V1 in both periods? No.** C's three-class Brier score was
  lower than both in both periods (about 1% lower than U, 0.7–1.0% lower than V1). Only one of the
  four comparisons had a 95% upper bound below zero: C against U in the final period. Against V1,
  neither period's interval excludes zero, and in development neither comparison does. C's
  probabilities also missed the frozen calibration limits once per period: TIMEOUT in development
  (predicted 32.4%, observed 36.5%), TARGET in the final period (predicted 33.1%, observed 29.3%).
- **Were selected entries' expected returns calibrated? No.** On the observations C entered, its
  forecasts were too high in both periods: development mean forecast +0.39% against a realized
  −0.27% per trade (difference −0.66 points, 95% −1.12 to −0.28); final +0.55% against +0.34%
  (difference −0.21 points, 95% −1.20 to +0.68). Both are `OVERPREDICTED` beyond the 0.10-point
  tolerance. Over all eligible observations the forecasts were within tolerance (−0.03 and −0.09
  points), which is exactly the pattern the contract warned could hide a miscalibrated decision.
- **Did selected entries earn positive net returns against cash? Not shown.** Development: C
  entered 1,830 of 21,620 opportunities (8.5%); per-opportunity mean −0.023% (95% −0.061 to
  +0.011), per trade −0.27% (−0.78 to +0.12). Final: 1,372 of 21,980 (6.2%); per-opportunity
  +0.021% (−0.024 to +0.078), per trade +0.34% (−0.47 to +1.05). Neither interval excludes zero,
  and the sign differs between periods. U and V1 never entered in either period, so they equal
  cash (0).
- **Sensitive to execution, ordering or individual months?** Execution and ordering barely moved
  anything: the target-overshoot booking changed the per-opportunity mean by about 0.001 points,
  and C entered 0 and 1 AMBIGUOUS trades. Months mattered. In development, the per-opportunity mean
  was negative with any one month left out. In the final period it stayed positive with each month
  left out, but leaving out August 2026 leaves +0.0002%, essentially zero: August alone contributed
  +0.123% per opportunity over its 3,720 opportunities.
- **Which gates passed or failed?** The evidence checks passed (coverage 100%, 1,830 and 1,372
  entries on 166 and 170 days, 3,202 entries in 13 months overall), so the result is not
  insufficient evidence. 11 conditions failed: 8 in development, 3 in the final period
  ([table](#gates)). No `ORDERING_SENSITIVE` or `FILL_SENSITIVE` label applies.

## What was fixed in advance

[`docs/spot-24h-expected-net-t3s3-dev-v1.json`](spot-24h-expected-net-t3s3-dev-v1.json) was
committed alone in `e9c477f`, before any study code existed and before any figure of this study was
computed on real data. It translates the contract's stage D into exact rules and was not edited
afterwards. The owner accepted the contract's recommended defaults; no gate was changed.

| Choice        | Fixed value                                                                                                                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data          | v1's 20 pairs and saved 1h candles; protocol v1, v1's result `662c5d7d…`, the universe and every candle file checked against recorded SHA-256. No download or repair                                                                            |
| Observations  | v1's grid (every 4 h, 2024-11-22 to labels ending 2026-11-22), #220's eleven causal features, v1's RSI × MACD cell and v = ATR14 ÷ close; T3S3 levels O × (1 ± 3 v); v1's `resolveOutcome` and `netReturn` unchanged; AMBIGUOUS kept separately |
| v1 parity     | Every exported outcome equal to v1's; v1's T3S3 development and confirmatory evaluations reproduced within 1e-12                                                                                                                                |
| Periods       | v1's splits and 24 h purge. Development: fit train, score validation. Final: fit train + validation, score v1's test split                                                                                                                      |
| U             | Fit-set frequencies of TARGET, STOP (with AMBIGUOUS) and TIMEOUT; plug-in expected net; enter if > 0                                                                                                                                            |
| V1            | v1's `fitFrequencies` cells, STOP and TIMEOUT counted the same way; enter by v1's rule (a probability and fit `meanNet` > 0)                                                                                                                    |
| C             | `HistGradientBoostingClassifier`, log loss, #220's settings (learning rate 0.05, 100 iterations, 15 leaves, 100 per leaf, L2 1.0, no early stopping, seed 17), pooled pairs, no weights, no recalibration; plug-in expected net; enter if > 0   |
| Plug-in       | p_T × net(target) + p_S × net(1 + ḡ_S v) + p_TO × net(1 + ḡ_TO v), with ḡ the fit set's mean gross ÷ v for STOP and TIMEOUT                                                                                                                     |
| Accounting    | Unit stake per opportunity, abstention = 0, overlap allowed, no wallet; concurrency reported                                                                                                                                                    |
| Uncertainty   | v1's `dayOrders`: 7-day UTC day blocks, never wrapped, 10,000 replicates, seed `popup-spot-24h-expected-net-t3s3-dev-v1`, one set of draws per period for every quantity (paired); 2.5 and 97.5 percentiles; fits held fixed                    |
| Gates         | The contract's section 6, every condition in both periods; τ = 0.10 points; 300 entries, 30 days, 3 months                                                                                                                                      |
| Verdict order | `INTEGRITY_FAILURE` → `INSUFFICIENT_EVIDENCE` → `GATE_PASSED` → `STOP`                                                                                                                                                                          |

## The run

- Code at `4d53653` (implementation committed on a clean tracked tree before the run). All three
  steps ran at that commit; a second invocation of each printed `UNCHANGED`.
- Dataset `.zerochart-reports/spot-24h-expected-net-t3s3-dev-v1-dataset-0f67666dc4f8-4d536534e79d.json`
  (SHA-256 `477946a0…`). Classifier probabilities `…-predictions-0f67666dc4f8-4d536534e79d.json`
  (`23a18828…`). Result `.zerochart-reports/spot-24h-expected-net-t3s3-dev-v1-0f67666dc4f8.json`
  (`1f291c94…`). Specification SHA-256 (stable serialization) `0f67666dc4f8…`.
- Environment: CPython 3.12.14 on macOS arm64; scikit-learn 1.9.1, numpy 2.5.5, scipy 1.18.1 and
  the other pins of `scripts/quantile-forecast-requirements.txt`, unchanged; OpenMP, 8 threads.
- Earlier results keep their recorded SHA-256: v1 `662c5d7d…`, diagnosis `6d6df8f1…`, breadth
  `54183e97…`, breakout `e4e734a3…`, structure entry `aab7284c…`, quantile forecast `b6c0b3f1…`.

## Results

### Coverage and fits

All 87,500 decisions (20 pairs × 4,375) became observations, with no exclusion, and v1 parity held
with no difference. Development scored 21,620 (181 days), the final period 21,980 (184 days):
coverage 100% for all three forecasters. 200 decisions were purged at the two inner boundaries.

| Fit set                                    | Development (train)           | Final (train + validation)    |
| ------------------------------------------ | ----------------------------- | ----------------------------- |
| Observations, days                         | 43,700, 365                   | 65,320, 546                   |
| TARGET / STOP / TIMEOUT (AMBIGUOUS)        | 13,764 / 14,100 / 15,836 (3)  | 20,615 / 20,980 / 23,725 (7)  |
| U: p_T / p_S / p_TO                        | 0.315 / 0.323 / 0.362         | 0.316 / 0.321 / 0.363         |
| ḡ_S (stop gross ÷ v)                       | −3.000004                     | −3.000003                     |
| ḡ_TO (timeout gross ÷ v)                   | −0.022                        | −0.048                        |
| V1 cells: TARGET p, fit `meanNet` per cell | 0.293–0.375; −0.10% to −0.39% | 0.294–0.363; −0.14% to −0.38% |
| C: iterations                              | 100                           | 100                           |

Stops booked almost exactly at the level (gaps through the stop were rare), and timeouts ended on
average slightly below the entry. Every V1 cell had a negative fit mean, as in v1's own record, so
V1 never entered. U's expected net was negative for every observation, so U never entered either.

### Predictive performance

Three-class Brier score (lower is better), with C's paired differences.

|                  |             Development |                    Final |
| ---------------- | ----------------------: | -----------------------: |
| U                |                  0.6652 |                   0.6648 |
| V1               |                  0.6649 |                   0.6626 |
| C                |                  0.6584 |                   0.6577 |
| **C − U**        |             **−0.0068** |              **−0.0072** |
| 95% interval     |  −0.0132 to **+0.0003** |   −0.0142 to **−0.0008** |
| **C − V1**       |             **−0.0065** |              **−0.0049** |
| 95% interval     |  −0.0129 to **+0.0006** |   −0.0106 to **+0.0005** |
| Gate (upper < 0) | fails vs U, fails vs V1 | passes vs U, fails vs V1 |

For continuity, v1's binary TARGET Brier against the base rate reproduced v1's recorded points:
development +0.0000185 (95% −0.0013 to +0.0014), final −0.0013 (−0.0029 to +0.00003). C's binary
TARGET Brier was 0.2138 against a base rate of 0.2165 in development, and 0.2073 against 0.2075
(V1 0.2062) in the final period.

### Probability calibration

C's in-the-large error and observation-weighted decile error per class; limits 0.03 and 0.05.

| Class   | Development: predicted / observed, in the large, deciles | Final: predicted / observed, in the large, deciles |
| ------- | -------------------------------------------------------- | -------------------------------------------------- |
| TARGET  | 33.8% / 31.7%, 0.021, 0.026                              | 33.1% / 29.3%, **0.038**, 0.041                    |
| STOP    | 33.8% / 31.8%, 0.020, 0.040                              | 32.8% / 34.2%, 0.014, 0.035                        |
| TIMEOUT | 32.4% / 36.5%, **0.041**, 0.041                          | 34.1% / 36.6%, 0.025, 0.025                        |

U and V1 stayed within both limits in both periods (largest: U's final TARGET, 0.023 in the large;
V1's final TARGET, 0.027 by decile). C's probabilities were further from the observed shares than
the unconditional frequencies were, while its Brier score was lower.

### Expected-net calibration

Mean forecast E and mean realized net, per observation, with difference = realized − forecast.
Tolerance ±0.10 points.

| Subset, period        | Observations (days) | Mean E | Mean realized | Difference (95%)           | Label              |
| --------------------- | ------------------: | -----: | ------------: | -------------------------- | ------------------ |
| C, all, development   |        21,620 (181) | −0.33% |        −0.36% | −0.03 (−0.35 to +0.18)     | `WITHIN_TOLERANCE` |
| C, ENTER, development |         1,830 (166) | +0.39% |        −0.27% | **−0.66 (−1.12 to −0.28)** | `OVERPREDICTED`    |
| C, all, final         |        21,980 (184) | −0.33% |        −0.41% | −0.09 (−0.35 to +0.24)     | `WITHIN_TOLERANCE` |
| C, ENTER, final       |         1,372 (170) | +0.55% |        +0.34% | **−0.21 (−1.20 to +0.68)** | `OVERPREDICTED`    |

U and V1 were within tolerance on all eligible observations in both periods (U −0.05 and −0.09,
V1 −0.03 and −0.07 points) and had no entries. By decile of C's E within its ENTER subset, only the
top decile realized a positive mean in development (forecast +2.23%, realized +1.43%; the other nine
deciles were negative). In the final period the top four deciles realized +0.57% to +1.34%, and
two lower deciles were also slightly positive. These decile readings are descriptive and were not
tested.

### Economic results (simulated research, unit stake)

| C                                     | Development                    | Final                          |
| ------------------------------------- | ------------------------------ | ------------------------------ |
| Entries (rate), days, months          | 1,830 (8.5%), 166, 7           | 1,372 (6.2%), 170, 7           |
| Entered TARGET / STOP / TIMEOUT (AMB) | 592 / 581 / 657 (0)            | 495 / 355 / 521 (1)            |
| **Per-opportunity mean (95%)**        | **−0.023% (−0.061 to +0.011)** | **+0.021% (−0.024 to +0.078)** |
| **Per trade (95%)**                   | **−0.27% (−0.78 to +0.12)**    | **+0.34% (−0.47 to +1.05)**    |
| C − U, per opportunity                | −0.023% (−0.061 to +0.011)     | +0.021% (−0.024 to +0.078)     |
| C − V1, per opportunity               | the same (V1 never entered)    | the same                       |
| Target overshoot, per opportunity     | −0.024%                        | +0.020%                        |
| Ordering-optimistic, per opportunity  | −0.023%                        | +0.022%                        |

U and V1 entered nothing in either period: their per-opportunity mean is exactly 0, the cash
reference. The paired differences against them are therefore C's own figures.

By calendar month (per-opportunity mean, entries):

| Development    |  Nov 25 |  Dec 25 |  Jan 26 |  Feb 26 |  Mar 26 |  Apr 26 |  May 26 |
| -------------- | ------: | ------: | ------: | ------: | ------: | ------: | ------: |
| Entries        |     108 |     290 |     304 |     305 |     295 |     330 |     198 |
| Mean           | +0.034% | +0.005% | −0.035% | −0.027% | −0.039% | −0.064% | +0.024% |
| Month left out | −0.026% | −0.028% | −0.020% | −0.022% | −0.019% | −0.014% | −0.028% |

| Final          |  May 26 |  Jun 26 |  Jul 26 |   Aug 26 |  Sep 26 |  Oct 26 |  Nov 26 |
| -------------- | ------: | ------: | ------: | -------: | ------: | ------: | ------: |
| Entries        |      78 |     371 |     139 |      250 |     316 |     149 |      69 |
| Mean           | +0.080% | −0.037% | +0.003% |  +0.123% | +0.065% | −0.004% | −0.079% |
| Month left out | +0.018% | +0.032% | +0.024% | +0.0002% | +0.012% | +0.026% | +0.033% |

The final period's positive mean rests largely on August 2026. By pair, its gains were concentrated
in ENA, WLD and NEAR (+0.18%, +0.14% and +0.13% per opportunity); C never entered TRX in that
period.

### Concurrency (C's entries)

| C                                   |  Development |        Final |
| ----------------------------------- | -----------: | -----------: |
| Open positions per hour, maximum    |           39 |           43 |
| Open positions per hour, median     |            4 |            3 |
| ENTER pairs per decision time, max  |           16 |           16 |
| ENTER pairs per decision time, mean |         1.69 |         1.25 |
| Decision times with an ENTER        | 634 of 1,081 | 611 of 1,099 |

Entries cluster: up to 16 of the 20 pairs at one decision time and up to 43 overlapping positions.
A capital-limited wallet could take only a fraction of these, chosen by rules stage D does not
have, so these per-opportunity figures do not describe one.

## Gates

| Condition                                           | Development                               | Final          |
| --------------------------------------------------- | ----------------------------------------- | -------------- |
| Coverage ≥ 95% (evidence)                           | holds                                     | holds          |
| ENTER subset ≥ 300 observations, 30 days (evidence) | holds                                     | holds          |
| C − U Brier, point and upper bound < 0              | **fails**                                 | holds          |
| C − V1 Brier, point and upper bound < 0             | **fails**                                 | **fails**      |
| Probability calibration, TARGET                     | holds                                     | **fails**      |
| Probability calibration, STOP                       | holds                                     | holds          |
| Probability calibration, TIMEOUT                    | **fails**                                 | holds          |
| Expected-net calibration of ENTER                   | **fails**                                 | **fails**      |
| Per-opportunity mean > 0                            | **fails**                                 | holds          |
| Per-trade mean > 0                                  | **fails**                                 | holds          |
| Leave one month out > 0                             | **fails**                                 | holds (barely) |
| Target overshoot > 0                                | **fails**                                 | holds          |
| Entry floor, both periods (evidence)                | holds: 3,202 entries, 336 days, 13 months |                |

Verdict `STOP`: 11 conditions failed, and the evidence checks held, so this is not insufficient
evidence. `ORDERING_SENSITIVE` does not apply (the optimistic ordering did not change the sign in
either period) and neither does `FILL_SENSITIVE` (other conditions fail too).

## What this does and does not show

- It shows that, on this examined history, this one classifier with pooled payoffs did not give a
  decision quantity that cleared the contract's gates. Its Brier score was slightly lower than both
  baselines, but not reliably, and its entries' expected returns were overstated.
- It does not show that no 24-hour forecast could work, that the features carry no information, or
  anything about untouched or future data. It is not a wallet result: positions overlap without a
  capital limit.
- The final period's positive per-opportunity point estimate is not evidence of profit: its
  interval includes zero, development's sign was negative, and one month carries most of it.

## After

Per the specification and the contract's stop condition, the approach stops here: no tuning, no
feature, setting, scenario, payoff or plug-in change, no second model, no new scenario and no
automatic follow-up study. Nothing authorizes prospective collection, a prospective test, an alert
or an order. v1, its result and every earlier study are untouched.

## Reproduce

At `4d53653`, with v1's saved candles in `.zerochart-market-data/spot-24h-v1/` and the pinned
environment (`python3.12 -m venv .venv`, then
`.venv/bin/python -m pip install --require-hashes --only-binary :all: -r scripts/quantile-forecast-requirements.txt`):

```bash
npm run evaluate -- expected-net-export
```

```bash
.venv/bin/python scripts/expected_net_classifier.py
```

```bash
npm run evaluate -- expected-net-evaluate
```

Each step refuses a dirty tracked tree, inputs that differ from their recorded hashes, and files
written at another commit or under another specification. With the files above present, each
prints `UNCHANGED`.
