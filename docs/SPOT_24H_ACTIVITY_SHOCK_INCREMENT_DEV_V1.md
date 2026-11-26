# activityShock24h incremental value: historical development screen: verdict `INCONCLUSIVE`

**Status: development research, finished. Verdict `INCONCLUSIVE`; per the specification, the
historical screen ends here.** The screen asked whether adding
[#224](BINANCE_ACTIVITY_FEASIBILITY.md)'s `activityShock24h` to #220's eleven price features
lowers the out-of-sample three-class Brier score of [#222](SPOT_24H_EXPECTED_NET_T3S3_DEV_V1.md)'s
classifier on v1's T3S3 outcomes. It was run once under the frozen
[specification](spot-24h-activity-shock-increment-dev-v1.json) (revision 3). Both evaluation
periods are examined development history: this was the eighth look at the same outcomes, never
untouched evidence. A lower Brier score is information value only. Nothing here is a profit
figure, an entry rule or evidence of trading readiness.

## In brief

- **Did adding `activityShock24h` reduce Brier loss in both periods? Not shown.** Arm B's mean
  three-class Brier score was lower than arm A's in both periods, but neither period's 95% paired
  interval excludes zero. Both periods are labelled `NO_CLEAR_DIFFERENCE`.
- **How large was the improvement?** About a fifth of a percent:
  - Development (fit train, score validation): B − A = −0.00106 per observation, 95% −0.00452 to
    +0.00395 (−0.16% of A's 0.65843).
  - Final (fit train + validation, score test): −0.00124, 95% −0.00492 to +0.00152 (−0.19% of A's
    0.65766).
  - For scale, #222's C was about 1% below its unconditional baseline.
- **Did calibration improve or deteriorate? Mixed, with no label changed.**
  - B's in-the-large error was smaller for TARGET and TIMEOUT in both periods.
  - B's STOP decile error was larger in both periods, and its STOP in-the-large error was larger
    in the final period.
  - Each period has the same one figure outside #222's limits for both arms: TIMEOUT in
    development, TARGET in the final period.
  - Calibration is reported, not gated.
- **Did the result survive leaving each month out? Yes, but it is not enough.** The mean
  difference stayed below zero with any one month left out, in both periods. The largest
  leave-one-month-out means were −0.00010 (development, without March 2026) and −0.00038 (final,
  without August 2026). B was better in 4 of 7 months in each period.
- **What exact verdict follows from the frozen rules? `INCONCLUSIVE`.**
  - Every evidence floor held: coverage 100% in every split; 21,620 and 21,980 observations on
    181 and 184 days; no missing class; 10,000 defined replicates.
  - `SCREEN_PASSED` needs `B_BETTER` in both periods, and neither period is.
  - `STOP` needs `B_WORSE` in a period or a mean ≥ 0 in both, and neither holds.
- **Integrity held throughout.**
  - The retrieval was 380 of 380 requests, every one returning 200, with no retries.
  - All 365,280 hours were valid, with exact OHLC and presence parity against v1.
  - #222's rows were reproduced exactly.
  - Arm A reproduced #222's recorded C probabilities exactly (maximum absolute difference 0.0) in
    both periods.

## Source terms and the support clarification

**Binance Support case 174972727, dated 2026-11-26.** The owner asked Binance Support, through the
chat the Terms of Use name for questions (clause 3.1), whether three things are permitted:

1. Retrieving historical klines through `/api/v3/klines` within rate limits.
2. Keeping those responses privately for offline, non-commercial research.
3. Publishing aggregate research statistics without redistributing raw data.

Support answered in writing:

1. Retrieval within rate limits is permitted. Exceeding the IP rate limits brings a temporary IP
   ban.
2. Binance market data is public and available to all users for non-commercial use.
3. There would be no issues, provided there is no redistribution and the use is non-commercial.

**Scope.** This is support clarification for the research described, and only that: private
offline non-commercial research, publishing aggregate statistics, never raw data. It is not a
commercial licence, legal advice or a blanket legal assurance. It did not address revision 2's
other open points, which stand as recorded:

- whether the Prohibited Use Policy copy read is the one in force;
- separate API terms or Product Terms;
- attribution;
- the Vision Dataset Terms.

The owner keeps the transcript privately. It is not committed, and no account details are
recorded. The agent did not contact Binance.

**Effect.** Revision 3 sets `dataSource.terms.status` to `RESOLVED` on that basis and records the
owner's authorization. It changes nothing else. The clarification concerns responses of this
endpoint kept privately for this use, so it covers v1's candles and #224's probe files on the same
basis. Both sets were preserved unchanged.

**Revision 2's reading.** It is in the specification's `dataSource.terms` and in this file's
history at [#226](https://github.com/blackhebrewisraeli/Popup/pull/226). It found that the text
read neither clearly permitted nor clearly prohibited the use.

### Clarification request

Prepared in revision 2. The owner sent items 1 to 3 of the intended use in shorter form, without
the lettered questions, and Support answered them as above.

**Question.**

```text
Subject: Is keeping public Spot kline data for private, non-commercial research permitted?

I would like to confirm the scope of the Binance Terms of Use (effective 27 October 2026) and the
Prohibited Use Policy they incorporate for the use below. Please refer this to the legal team if
needed.

Intended use:
1. Unauthenticated GET requests to https://api.binance.com/api/v3/klines (interval 1h) for 20
   USDT Spot pairs: about 380 requests, one at a time at least 250 ms apart, within published
   rate limits, stopping on any 429 or 418.
2. Keeping the raw responses privately on one computer for offline statistical research by one
   individual, together with similar responses retrieved in November 2026 (two years of hourly
   candles for the same pairs, and 60 single-day samples). No redistribution of the data, no
   commercial use, no trading service and no signal distribution.
3. Publishing only aggregate statistics computed from the data (for example forecast-accuracy
   scores), never the data itself, in a public, non-commercial code repository.

Questions:
a) Is automated retrieval through this documented public market-data endpoint "expressly
   permitted" under section I of the Prohibited Use Policy?
b) Does clause 27 of the Terms of Use (non-commercial personal use) cover keeping and analysing
   the responses offline as described in 2?
c) Do separate API terms (clause 14.1.2(b)) or any Product Terms apply to unauthenticated
   market-data endpoints? If so, where are they published?
d) Is publishing aggregate statistics as described in 3 permitted, and is attribution required?
e) Do the Binance Vision Dataset Terms apply to responses from api.binance.com?
f) Is the Prohibited Use Policy marked "Last updated: 5 January 2026" the version currently in
   force? If not, where is the current version published?
```

## What was fixed in advance

Revision 3 was committed alone in `6d40a2a`, before any study code, retrieval or figure. Its
stable SHA-256 is `c7fa2a8f7056…` and its file SHA-256 is `34b8ecac9035…`. The research design is
revision 2's, unchanged.

| Choice                 | Fixed value                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Pairs, grid, splits    | v1's 20 pairs; decisions every 4 h; train / validation / test with labels crossing a boundary purged (87,500 decisions, 200 purged)  |
| Labels                 | v1's `resolveOutcome` at T3S3; classes TARGET, STOP (AMBIGUOUS mapped to STOP), TIMEOUT                                              |
| Arm A                  | #220's eleven price features, rows taken from #222's recorded dataset and recomputed from v1's candles                               |
| Arm B                  | The same eleven, then `activityShock24h` (#224 section 5)                                                                            |
| Feature                | 24 h base volume against the 30 preceding 24 h blocks: (ln R₀ − ln μ) / s, s the ddof-0 SD of ln R₁…R₃₀; 744 closed hours            |
| Estimator              | #222's C: `HistGradientBoostingClassifier`, scikit-learn 1.9.1, #222's settings, `verifiedParams` and fit function; seed 17          |
| Fits                   | Development A, development B (train), final A, final B (train + validation), on identical common observations                        |
| Primary metric         | Mean of d = Brier(B) − Brier(A) per observation, three classes                                                                       |
| Interval               | v1's `dayOrders` / `ratioInterval`: 7-day whole-day blocks, 10,000 replicates, seed `popup-spot-24h-activity-shock-increment-dev-v1` |
| Floors                 | Coverage ≥ 0.95 per split; ≥ 2,000 observations on ≥ 90 days per period; no missing class; ≥ 9,900 defined replicates                |
| Pass (`SCREEN_PASSED`) | Both periods `B_BETTER` (mean < 0 and upper bound < 0) and the mean < 0 with each calendar month left out                            |
| Reported, not gated    | Class components, log loss, calibration against #222's limits, months, pairs, every count                                            |

## The run

- **Retrieval** at `344e079`, 2026-11-26 15:30:55Z to 15:34:56Z.
  - Requests: 380 unauthenticated `GET /api/v3/klines` on `api.binance.com`, one at a time and at
    least 250 ms apart. No credentials, proxy or other host.
  - Responses: all 200, no 429 or retry. The peak `X-MBX-USED-WEIGHT-1M` was 196, against the stop
    rule's 3,000.
  - Storage: raw bodies byte for byte in the git-ignored, write-once
    `.zerochart-market-data/spot-24h-activity-shock-increment-dev-v1/`, with `manifest.json`
    (`065309da…`) and `validation.json` (`f0fe88f9…`).
- **Validation.**
  - All 365,280 hours (20 × 18,264) were valid: none zero-volume, missing or invalid. No response
    issue. Field 11 was `"0"` throughout.
  - OHLC parity with v1: 354,400 hours compared, 0 value mismatches, 0 presence differences.
  - v1's universe and 20 candle files had the same SHA-256 before and after. #224's probe files
    were unchanged.
- **Export, fit and evaluation**, all at `344e079` on a clean tracked tree.
  - Every input hash was verified: v1, #222's specification, dataset, predictions and result.
  - #222's 87,500 rows were recomputed from v1's candles and equal the recorded rows exactly.
  - Arm A's probabilities equal #222's recorded C probabilities exactly in both periods. That
    shows arm A is #222's classifier, not a re-implementation.
  - Reruns of the fit and the evaluation printed `UNCHANGED`.
- **Outputs** (git-ignored, write-once):
  - dataset `.zerochart-reports/spot-24h-activity-shock-increment-dev-v1-dataset-c7fa2a8f7056-344e07967cbf.json` (`f3a3d2d8…`)
  - predictions `…-predictions-c7fa2a8f7056-344e07967cbf.json` (`93c9fa23…`)
  - result `.zerochart-reports/spot-24h-activity-shock-increment-dev-v1-c7fa2a8f7056.json` (`f912ed14…`)
- **Environment.** Python 3.12.14, the pinned packages, OpenMP with 8 threads (as #222 recorded),
  Node v26.12.1, macOS arm64.

## Results

### Coverage and fits

No decision lost its activity value or any price feature, so every grid decision is a common
observation:

- train 43,700 of 43,700;
- validation 21,620 of 21,620;
- test 21,980 of 21,980;
- 200 decisions purged, as in v1.

Both arms were fitted on the same rows with identical parameters, each with 100 iterations:

| Fit set               | Observations | TARGET | STOP   | TIMEOUT |
| --------------------- | ------------ | ------ | ------ | ------- |
| Development (train)   | 43,700       | 13,764 | 14,100 | 15,836  |
| Final (train + valid) | 65,320       | 20,615 | 20,980 | 23,725  |

### Brier score (primary)

| Period      | Observations (days) | Brier A | Brier B | B − A    | 95% interval         | Relative | Label                 |
| ----------- | ------------------- | ------- | ------- | -------- | -------------------- | -------- | --------------------- |
| Development | 21,620 (181)        | 0.65843 | 0.65737 | −0.00106 | −0.00452 to +0.00395 | −0.16%   | `NO_CLEAR_DIFFERENCE` |
| Final       | 21,980 (184)        | 0.65766 | 0.65642 | −0.00124 | −0.00492 to +0.00152 | −0.19%   | `NO_CLEAR_DIFFERENCE` |

All 10,000 replicates were defined in both periods. The interval reflects day-to-day variation of
the evaluation days only. The fits are held fixed, and refitting variation is not included.

**By class.** The class components (B − A, with 95% intervals) sum to the primary figure.

| Period      | TARGET                        | STOP                          | TIMEOUT                       |
| ----------- | ----------------------------- | ----------------------------- | ----------------------------- |
| Development | +0.00124 (−0.00040, +0.00311) | +0.00130 (−0.00048, +0.00399) | −0.00359 (−0.00520, −0.00136) |
| Final       | +0.00033 (−0.00099, +0.00195) | +0.00061 (−0.00139, +0.00244) | −0.00219 (−0.00439, −0.00062) |

B's whole gain sits in the TIMEOUT probability. That component's interval excludes zero in both
periods, while TARGET and STOP moved slightly the other way, unresolved.

These are reported, not gated. They are three of several descriptive figures per period, so they
are no basis for a narrower follow-up (see [After](#after)).

**Log loss** (natural log, B − A): development 1.08618 → 1.08422, −0.00197 (−0.00783, +0.00661);
final 1.08504 → 1.08301, −0.00204 (−0.00749, +0.00212). No probability was zero.

### Probability calibration (reported, not gated)

#222's limits apply: in-the-large ≤ 0.03 and weighted decile error ≤ 0.05. Arm A's figures are
#222's C's figures exactly.

| Period      | Class   | Predicted A / B | Observed | In the large A → B            | Decile error A → B |
| ----------- | ------- | --------------- | -------- | ----------------------------- | ------------------ |
| Development | TARGET  | 33.8% / 33.3%   | 31.7%    | 0.0213 → 0.0162               | 0.0257 → 0.0248    |
| Development | STOP    | 33.8% / 33.6%   | 31.8%    | 0.0200 → 0.0173               | 0.0400 → 0.0465    |
| Development | TIMEOUT | 32.4% / 33.1%   | 36.5%    | **0.0413 → 0.0335** (OUTSIDE) | 0.0413 → 0.0335    |
| Final       | TARGET  | 33.1% / 32.6%   | 29.3%    | **0.0383 → 0.0331** (OUTSIDE) | 0.0410 → 0.0386    |
| Final       | STOP    | 32.8% / 32.2%   | 34.2%    | 0.0135 → 0.0192               | 0.0350 → 0.0409    |
| Final       | TIMEOUT | 34.1% / 35.2%   | 36.6%    | 0.0248 → 0.0139               | 0.0248 → 0.0139    |

### Months

Mean d per month (negative favours B). Partial first and last months are shown as they are.

| Development | Obs.  | d        | Without it | Final   | Obs.  | d        | Without it |
| ----------- | ----- | -------- | ---------- | ------- | ----- | -------- | ---------- |
| 2025-11     | 1,080 | +0.00174 | −0.00120   | 2026-05 | 1,200 | +0.00033 | −0.00133   |
| 2025-12     | 3,720 | −0.00479 | −0.00028   | 2026-06 | 3,600 | +0.00448 | −0.00236   |
| 2026-01     | 3,720 | +0.00201 | −0.00169   | 2026-07 | 3,720 | −0.00184 | −0.00112   |
| 2026-02     | 3,360 | +0.00935 | −0.00297   | 2026-08 | 3,720 | −0.00548 | −0.00038   |
| 2026-03     | 3,720 | −0.00564 | −0.00010   | 2026-09 | 3,600 | −0.00284 | −0.00093   |
| 2026-04     | 3,600 | −0.00453 | −0.00036   | 2026-10 | 3,720 | +0.00019 | −0.00153   |
| 2026-05     | 2,420 | −0.00350 | −0.00075   | 2026-11 | 2,420 | −0.00292 | −0.00103   |

The leave-one-month-out condition holds in both periods. In development it holds narrowly: without
March 2026 the mean is −0.00010.

### Pairs (point figures only)

B's mean Brier was lower in 10 of 20 pairs in development and 13 of 20 in the final period.

- BTC, ETH, SOL, ZEC, BNB, UNI and LTC favoured B in both periods.
- NEAR, ENA, ADA and TAO favoured A in both.

These figures have no intervals and are not a basis for selecting pairs.

## Verdict

| Rule (in order)         | Holds?  | Why                                                                     |
| ----------------------- | ------- | ----------------------------------------------------------------------- |
| `INTEGRITY_FAILURE`     | No      | Every hash, parity, reproduction, environment and identity check passed |
| `INSUFFICIENT_EVIDENCE` | No      | All nine floor checks held                                              |
| `SCREEN_PASSED`         | No      | Neither period is `B_BETTER`: both upper bounds are above zero          |
| `STOP`                  | No      | Neither period is `B_WORSE`, and both means are below zero              |
| `INCONCLUSIVE`          | **Yes** | Negative means whose intervals reach zero                               |

## What this does and does not show

- **It shows** that, on this examined history, adding `activityShock24h` moved the classifier's
  Brier score down by about 0.2% in both periods. That is a small change, within what day-to-day
  variation of the evaluation days produces. It also shows that the run was the intended
  comparison: the arms differ only by the column, and arm A is exactly #222's C.
- **It does not show** that the feature adds predictive information. Neither interval excludes
  zero.
- **It is not untouched evidence.** Both periods were examined seven times before.
- **It says nothing about returns or trading.** It does not show profitability, an entry rule,
  calibration fit for decisions, or readiness for live use.
- **It does not show that activity is useless** at other windows, normalizations, fields or
  horizons. Those were out of scope and are not opened by this result.
- **Limits.**
  - Seven-day blocks do not capture regimes longer than a week.
  - Volume has no earlier copy to compare. OHLC parity only shows prices unchanged since v1's
    retrieval.
  - Whether a value retrieved now equals what was available live is unverified.

## After

Per `verdict.after.INCONCLUSIVE`, **the historical screen ends.** The result is not grounds for:

- a prospective proposal, a rerun or a longer window;
- the TIMEOUT-only component as a target;
- any variation: other activity fields, windows, normalizations, models, settings, labels or
  pairs.

No tuning, additional model, prospective collection, UI, order, alert or production change follows.
#222's `STOP` and every earlier conclusion stand.

## Implementation note

`ACTIVITY_DISPERSION_ZERO` is detected as "the thirty ln R_k are all equal" as well as s = 0. With
thirty identical values, float rounding of their mean leaves s ≈ 1e-16 rather than 0, which would
otherwise turn a zero-dispersion window into an arbitrary value. The note is recorded for
completeness only: no window in this run came near it, as every observation had a finite value.

## Reproduce

Only at `344e079`, with the retrieval directory present (it is never re-retrieved):

```bash
npm run evaluate -- activity-export
.venv/bin/python scripts/activity_shock_classifier.py
npm run evaluate -- activity-evaluate
```

Each step refuses a dirty tracked tree, another commit's inputs or another specification file, and
prints `UNCHANGED` when its output already exists with identical bytes. The retrieval step
(`npm run evaluate -- activity-retrieve`) refuses to run again because its directory exists.
