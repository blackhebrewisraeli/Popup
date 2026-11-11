# Canonical model diagnostic: why Long is rare and Risk is common

The [frozen crypto study](SCANNER_RESEARCH.md#crypto-crypto-usdt-v1) found 3 Long observations in
801 evaluation days and a Risk warning on about 86% of evaluated pair-days. This document
explains the mechanism, from the code of canonical model `1.0.0` and from the study's own replay.
It changes no model, threshold, weight, window, universe, Pine script or frozen study, and it reads
no outcome: no forward price change is computed or consulted. More Long setups are not a goal,
and nothing here says the model is or is not useful.

Each statement carries its evidence:

- **Proven:** follows from the formulas in `canonicalModel.ts`; the bounds are checked in
  [`canonicalModelReachability.test.ts`](../src/test/canonicalModelReachability.test.ts).
- **Observed:** counted on the frozen replay (crypto-usdt-v1, 2024-09-01 to 2026-11-10),
  reconciled row for row with the study.
- **Demonstrated:** reached by a valid synthetic candle path, pinned in the same test file.
- **Hypothesis:** an explanation the evidence is consistent with but does not establish.

Denominator unless stated: **18,322 evaluated pair-days** (801 dates, 21–23 of 25 pairs each).
The 1,703 `INSUFFICIENT_HISTORY` pair-days (two young listings on every date, two others before
their 199th candle) are counted apart and enter no row.

## Findings, ranked

1. **Volatility decides both labels on this universe.** _Proven and observed._ A pair is in the
   HIGH_VOLATILITY regime when ATR(14)/close ≥ 4%. There the volatility factor is at most 30 and
   weighs 0.3, so the composite is at most 70 + 0.3 × that factor: 79 at 4%, 77.5 at 4.25%, 70 from
   5.5%. **Above 4.25% no RSI or momentum reading can reach the Long score.** Median ATR/close was
   6.4%: 15,672 pair-days (85.5%) were HIGH_VOLATILITY, the volatility factor was pinned at 0 on
   11,952 (65.2%), and volatility alone ruled out the Long score on 15,181 (82.9%). Only 491
   HIGH_VOLATILITY pair-days (2.7%) sat in the 4–4.25% band where it did not. The same regime is a
   Risk clause, so 15,672 of the 15,721 Risk observations (99.7%) rest on it.
2. **Long fails on the score, not on momentum, and by a wide margin.** _Observed; the momentum
   part proven._ The momentum gate (MACD histogram ≥ +0.05% of price) held on 9,096 pair-days
   (49.6%), the score gate on 3. No pair-day met the score gate without the momentum gate. That
   cell is possible only in NEUTRAL or MEAN_REVERTING (proven). Among momentum-gated pair-days the
   median composite was 28.2 points below the Long boundary (77.5) and the 95th percentile 13.9
   below. 19 came within 5 points, 124 within 10. The highest composite per regime:
   HIGH_VOLATILITY 70.3, NEUTRAL 72.5, MEAN_REVERTING 71.0, TRENDING 79.6.
3. **Rewarding low RSI and positive momentum is a restrictive conjunction.** _Proven bounds,
   observed correlation; mechanism a hypothesis._ The RSI factor pays for RSI below 50, most
   between 30 and 50. The momentum factor pays for a positive MACD histogram. Outside
   HIGH_VOLATILITY, Long needs both near their best (table below). The two factors were negatively
   correlated: −0.54 overall, −0.77 in TRENDING, −0.71 in MEAN_REVERTING, −0.54 in
   HIGH_VOLATILITY, −0.34 in NEUTRAL. Of 587 oversold pair-days (RSI ≤ 30), 35 (6%) had bullish
   momentum; of 9,708 with RSI above 30 and below 50, 3,281 (34%). _Hypothesis:_ the same declines that
   lower RSI drag the histogram negative, so both are high together mainly after a decline slows
   or reverses sharply. All 3 Long observations were TRENDING rebounds: RSI 35–42, histogram
   +0.78% to +0.94% of price, ATR/close 3.4–3.6%, momentum contributing 45–48 of 78–80 points.
4. **One Risk label hides two different conditions, and alerts hide most of their changes.**
   _Observed._ Risk held on 15,721 pair-days: high volatility only 12,088, both clauses 3,584, low
   score only 49. The low-score clause (score ≤ 28) is itself mostly volatility. 3,584 of its 3,633
   pair-days (98.7%) were HIGH_VOLATILITY, 3,260 (89.7%) had a volatility factor of 0, and
   volatility supplied 38% of their lost points on average. With a volatility factor of 0, a low
   score needs only an RSI and momentum factor averaging below 40.7 (proven). Of 561 low-score
   onsets, only 9 began a Risk transition. The other 552 began while high volatility already held,
   so Pine's `riskSignal` would not fire and its reasons would not name them. Of the 128 Risk
   transitions, 119 began with the volatility clause and 9 with the low score.
5. **A Risk warning does not exclude a high score.** _Observed._ 623 Risk pair-days, all high
   volatility, scored 60 or more. That is 48% of the 1,294 scores ≥ 60, the band the scanner's own
   moderate risk profile accepts and Pine's HUD labels BUY.
6. **Long and Risk can coincide only through high volatility, and did not.** _Proven and
   demonstrated; observed 0._ A low score and a Long score are exclusive. A Long in
   HIGH_VOLATILITY needs ATR/close between 4% and 4.25%, RSI ≤ 25.7 and a histogram ≥ +0.91% of
   price at once. A decelerating decline reaches it (synthetic path: RSI 5.5, histogram +4.4%,
   ATR/close 4.03%).
7. **Rounding moves the effective thresholds to 77.5 and 28.5.** _Proven and observed._ The score
   is rounded once (`Math.round`, ties up; equal to Pine's `math.round` for nonnegative scores).
   One of the 3 Long observations (composite 77.56) is a Long only through rounding. 199 pair-days
   were low-score only through rounding; 193 of those were also high volatility, so 6 Risk labels
   depend on it.
8. **A regime flip moves the score discontinuously.** _Proven; impact not measured._ Each regime
   has its own weights (up to 0.2 apart per factor), so crossing 4% ATR/close, ±0.5% histogram or RSI 30/70 changes the
   composite with no change in the factors: up to 15 points between MEAN_REVERTING and TRENDING,
   12 at the high-volatility boundary, 7 between NEUTRAL and either. A test pins a 10-point drop
   (71 → 62) for +0.01% of ATR/close. How often this decided a label here was not measured.
9. **Concentration.** _Observed._ All 3 Long observations are one pair in one quarter (2026-Q2).
   The 2,650 non-high-volatility pair-days spread over 17 pairs (largest 25.6%, 3 make half) and
   cluster in 2026-Q2 and Q3, when the high-volatility share fell to 73% and 70% (84–97% in every
   other quarter).
10. **No candle constraint between the factors explains this.** _Proven and observed._ On any
    199-candle window with low ≤ close ≤ high, |histogram| ≤ 5.03 × ATR, and one jump on otherwise
    rangeless candles attains it. Real ratios stayed far inside (maximum 0.81, 95th percentile
    0.39). Every Long cell is reachable by valid candles (finding 6 and the reachability table). The
    rarity comes from the formulas meeting this market's volatility, not from impossibility.

## Defects

**None found.** The code does what its comments, the landing-page definitions and the Pine port
say. The diagnostic reproduced every recorded score and setup from the factor decomposition, on
every row. What the findings describe are rules and their fit to this market:

- **Intentional rules:** the 4% high-volatility regime and Risk clause, the 0.1 weight tilts, the
  momentum gate, rounding before the thresholds (kept for Pine parity).
- **Empirical limitation:** the volatility scale (0.5% quiet, 4% high, 5.5% saturated) sits below
  this universe's typical ATR/close (6.4% median), so the factor is zero on most crypto days. One
  formula serves crypto and equities.
- **Known differences, not re-examined:** Pine's flat RSI (100 against the app's 50),
  rolling-window ties, 199 against 200 candles and hourly alerts
  ([parity assessment](PINE_PARITY_ASSESSMENT.md)).
- **Label inconsistencies in Pine (design):** the HUD's action band says STRONG BUY at score ≥ 78
  without the momentum gate, never reflects the high-volatility clause, and says BUY at 60–77
  while Risk can hold. The "High-Conviction Bullish" alert fires at ≥ 80 without the momentum gate
  (1 pair-day here, the same day as a Long).

## The mathematical contract

From [`canonicalModel.ts`](../src/lib/canonicalModel.ts) and
[`indicators.ts`](../src/lib/indicators.ts), on the last 199 closed daily candles, re-seeded on
each evaluation.

| Reading         | Definition                                                                | Unit                                                    |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| RSI(14)         | Wilder; seed = mean of the first 14 changes; flat window = 50             | 0–100                                                   |
| MACD(12, 26, 9) | SMA-seeded EMAs; histogram = MACD − EMA9(MACD), first defined at index 33 | price units; `momentumPercent` = histogram / last close |
| ATR(14)         | Wilder; TR₀ = high − low; seed = mean of TR₀…TR₁₃                         | price units; `volatilityPercent` = ATR / last close     |

| Factor     | Transform (0–100)                                                                        | Saturation                                                   |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| RSI        | Piecewise linear through (0, 100), (30, 95), (50, 55), (70, 15), (100, 0); input clipped | Slope 1/6 per RSI point below 30, 2 from 30 to 70, 1/2 above |
| Momentum   | clamp(50 + 5000 × momentumPercent)                                                       | 100 at ≥ +1%, 0 at ≤ −1%; 52.5 at the gate (+0.05%)          |
| Volatility | clamp(110 − 2000 × volatilityPercent)                                                    | 100 at ≤ 0.5%, 0 at ≥ 5.5%; 30 at 4%                         |

| Regime (first match) | Condition                  | Weights RSI / momentum / volatility |
| -------------------- | -------------------------- | ----------------------------------- |
| HIGH_VOLATILITY      | volatilityPercent ≥ 4%     | 0.35 / 0.35 / 0.30                  |
| TRENDING             | \|momentumPercent\| ≥ 0.5% | 0.30 / 0.50 / 0.20                  |
| MEAN_REVERTING       | RSI ≤ 30 or ≥ 70           | 0.50 / 0.30 / 0.20                  |
| NEUTRAL              | otherwise                  | 0.40 / 0.40 / 0.20                  |

- **Composite.** raw = Σ weight × factor, divided by the weight sum, which is exactly 1 in
  binary64 for every row. raw always lies in 0–100, so the clamp never binds. Score =
  `Math.round(raw)`.
- **Long** (`modelSetups`, Pine `longSetup`): score ≥ 78 **and** momentumPercent ≥ 0.0005, so
  raw ≥ 77.5. Points the three factors can lose and still pass: 22.5.
- **Risk** (Pine `riskSetup`): score ≤ 28 **or** HIGH_VOLATILITY, so raw < 28.5 or ATR/close ≥ 4%.
- **Standing versus transition.** The scanner, Research and the study label the condition on the
  last closed candle: a standing setup repeats every day it holds. Pine alerts only on the bar the
  combined condition turns true (`longSignal`, `riskSignal`), naming the clauses that hold on that
  bar. A clause that begins while the other already holds Risk produces no alert. Separate Pine
  alert conditions fire on the high-volatility onset and on score ≥ 80.

## Structural reachability

Necessary conditions for each cell, from the formulas (the shortfall budget of 22.5 points, the
regime's weights and its own bounds on the factors). "Observed" counts pair-days; "Synthetic"
names a pinned candle path.

| Cell                        | HIGH_VOLATILITY                                                     | TRENDING                                                 | MEAN_REVERTING                                 | NEUTRAL                                                                         |
| --------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Highest composite           | 79 (at 4%), 70 from 5.5%                                            | 100                                                      | 92.5 (supremum)                                | 88 (supremum)                                                                   |
| Long                        | ATR/close ≤ 4.25%, RSI ≤ 25.7, histogram ≥ +0.91%; always also Risk | histogram ≥ +0.5%, RSI ≤ 65; at 3.5% ATR/close, RSI ≤ 45 | RSI ≤ 30, histogram +0.05% to +0.5%            | RSI 30–43.1, histogram +0.05% to +0.5%, ATR/close < 3.125%                      |
| Long: observed / synthetic  | 0 / yes                                                             | 3 / yes                                                  | 0 / yes                                        | 0 / yes                                                                         |
| Score gate without momentum | impossible (≤ 62.4)                                                 | impossible (≤ 62.5)                                      | oversold and quiet; 0 observed / synthetic yes | RSI 30–31.9, histogram −0.025% to +0.05%, ATR/close ≤ 0.875% (≤ 79); 0 observed |
| Low score (≤ 28)            | (R + M)/2 < 40.7 when the volatility factor is 0; 3,584 observed    | reachable; 45 observed                                   | only RSI ≥ 70; 0 observed                      | only near RSI 70, histogram −0.5%, 4% (raw > 22); 4 observed                    |
| Low score: synthetic        | (the common case)                                                   | yes: RSI 97, histogram −0.52%, ATR/close 3.8%            | yes: one up day after a flat history, RSI 100  | yes: RSI 69.3, histogram −0.43%, ATR/close 3.5%                                 |

A grid over abstract inputs (RSI by 2.5, histogram by 0.05%, ATR/close by 0.25%) checks every
bound above; the derivations are the proof. Abstract inputs are not candles: only the cells
marked synthetic are shown reachable by a real price path, and the only general candle constraint
found (finding 10) excludes none of them.

## The frozen replay, in counts

Rows: 18,322 evaluated pair-days. Status counts, Long and Risk observations, transitions, unknown
onsets and standing counts equal the study's results exactly (`reconciliation: MATCH`).

| Long gates         | Pair-days | Share |
| ------------------ | --------: | ----: |
| Score and momentum |         3 | 0.02% |
| Score only         |         0 |    0% |
| Momentum only      |     9,093 | 49.6% |
| Neither            |     9,226 | 50.4% |

| Risk clauses           | Pair-days | Share |
| ---------------------- | --------: | ----: |
| High volatility only   |    12,088 | 66.0% |
| Both                   |     3,584 | 19.6% |
| Low score only         |        49 |  0.3% |
| Neither                |     2,601 | 14.2% |
| Long and Risk together |         0 |    0% |

| Regime          | Pair-days | Momentum gate | Long | Low score | Highest composite | Mean lost points RSI / momentum / volatility |
| --------------- | --------: | ------------: | ---: | --------: | ----------------: | -------------------------------------------- |
| HIGH_VOLATILITY |    15,672 |         7,745 |    0 |     3,584 |              70.3 | 14.8 / 17.4 / 29.0                           |
| TRENDING        |       960 |           557 |    3 |        45 |              79.6 | 16.1 / 21.5 / 10.8                           |
| MEAN_REVERTING  |        68 |            52 |    0 |         0 |              71.0 | 38.8 / 12.2 / 7.1                            |
| NEUTRAL         |     1,622 |           742 |    0 |         4 |              72.5 | 19.4 / 19.8 / 9.5                            |

**What rules out the Long score** (a factor whose lost points alone exceed 22.5; a pair-day can
have several): volatility 15,181, momentum 7,525, RSI 3,653; at least one 17,105; none alone but
too many together 1,214; met 3.

**Distributions** (5th / 25th / 50th / 75th / 95th percentile):

| Reading           |     p5 |    p25 |    p50 |    p75 |    p95 |
| ----------------- | -----: | -----: | -----: | -----: | -----: |
| RSI               |   31.9 |   40.9 |   48.0 |   56.9 |   71.4 |
| Histogram / close | −2.50% | −0.81% | +0.04% | +0.85% | +2.34% |
| ATR / close       |  2.76% |  4.87% |  6.44% |  8.48% | 12.14% |
| RSI factor        |   14.3 |   41.2 |   59.0 |   73.2 |   91.3 |
| Momentum factor   |    0.0 |    9.7 |   52.0 |   92.7 |  100.0 |
| Volatility factor |    0.0 |    0.0 |    0.0 |   12.6 |   54.9 |
| Composite (raw)   |   20.6 |   30.7 |   40.4 |   50.4 |   61.1 |

Score bands: 0–9: 21, 10–19: 687, 20–29: 3,331, 30–39: 4,554, 40–49: 4,804, 50–59: 3,631,
60–69: 1,236, 70–79: 57, 80–89: 1. Saturation: momentum factor 100 on 3,944 and 0 on 3,797;
volatility factor 0 on 11,952 and never 100; RSI ≤ 30 on 587, ≥ 70 on 1,109.

**Over time.** High-volatility share by quarter: 2024-Q3 84%, Q4 88%; 2025-Q1 97%, Q2 88%, Q3 87%,
Q4 92%; 2026-Q1 90%, Q2 73%, Q3 70%, Q4 84% (to 10 Nov). The highest composite per quarter stayed
between 67 and 72 except 2025-Q4 (76.0), 2026-Q2 (79.6) and 2026-Q3 (76.2). Per-pair tables are
in the private report only.

## What each label establishes

- **Rank** orders the composite within one date's evaluated pairs. Because volatility is one of
  three factors and tilts the weights, quieter pairs rank higher; the study found the top 5 in the
  quietest volatility tercile 57% of the time. Rank is relative, never a signal by itself.
- **Long setup** says the pair met a rare joint condition on that day's close: in practice a
  TRENDING rebound (histogram ≥ +0.5% of price) with RSI in the 30s or low 40s and ATR/close under
  4%. It says nothing about what follows.
- **High-volatility warning** says ATR(14) is at least 4% of the price. On this universe that is
  the normal state (85.5% of pair-days); it does not mean the price is falling.
- **Low-score warning** says the composite is 28 or less: on this universe almost always high
  volatility with negative momentum and an RSI not oversold. Outside high volatility it is rare
  (49 pair-days) and can be an overbought rally losing momentum (synthetic: RSI 97, score 19). It
  is not a bearish forecast.

A single "Risk warning" therefore mixes a volatility description that is almost always true with
a rare composite condition, and the evidence panel's clause list is the only place they are told
apart.

## Questions this raises (no change made)

Wording, product only. These would not change the model or the frozen studies:

- Name the clause on the badge and in the filter: "High volatility" and "Low score" rather than
  one "Risk warning".
- Say on the crypto view that high volatility is the usual state of these pairs.
- Avoid wording that reads a low-score warning as bearish, and a Long setup as a recommendation.
- Align Pine's HUD action bands and "High-Conviction" alert with the setups, or say why they
  differ.

Model design. Each would need a new `MODEL_VERSION`, a Pine change, a migration and a fresh
in-Pine self-check (CONTRIBUTING), and would leave the frozen
[prospective check](SCANNER_RESEARCH.md#prospective-follow-up-frozen-not-yet-collected), which
requires the unchanged model. None may be chosen from the study's outcomes:

- Should volatility count three times: as a factor, as the regime that raises its own weight
  when its factor is lowest, and as a Risk clause?
- Should crypto and equities share one volatility scale, given crypto's 6.4% median ATR/close?
- Is "oversold and turning up" the intended Long thesis? If so, it is a rebound condition, and its
  name and its rarity should say so.
- Should regime changes move the score continuously rather than by up to 15 points?

## Recommended next task

**Label the Risk warning by clause in Research, wording only.** Show "High volatility" and/or
"Low score" wherever "Risk warning" appears (badge, filter, changes list, scenario text), and add
one line to the crypto view saying high volatility is the usual state of these pairs.

Rationale: the strongest finding is that one label carries two conditions of very different
frequency and meaning (99.7% of Risk observations rest on volatility; 552 of 561 low-score onsets
are invisible as transitions). Naming the clause makes the existing evidence legible without
changing a score, a setup, `SCANNER_VERSION`, Pine or the frozen prospective check. Model changes
should wait for that check, or start as a separate new-version study frozen before any outcome is
seen.

## Reproduction

Needs the private export, the recorded scan and the frozen study results (`a14c0d19…`), all
git-ignored:

```bash
npm run evaluate -- model-diagnostic-crypto .zerochart-tradingview/20261111T183825Z.json
```

It refuses an export, recorded scan or study results file that is not byte-identical to the
frozen one. It replays the study's 801 dates with the study's own `replayDay`, reconciles every
date and count, and refuses to write anything that does not match. It writes, write-once,
`.zerochart-reports/model-diagnostic-8dc1d6fdbc62.json` (every row, per-pair tables; a rerun
prints `UNCHANGED`, a changed file `CONFLICT`) and a private HTML report. The printed summary has
no pair, date or row.

- Definition: [`model-diagnostic-crypto.v1.json`](model-diagnostic-crypto.v1.json), ID
  `8dc1d6fdbc62455da6bf03d27b0f02e47f2beda6e75954e76acb1ef3c7a117df`, kept identical to the code
  by a test. It pins the export, the recorded scan, the study specification and results, the model,
  scanner and policy versions, and the study fields it may read (never `horizons`).
- Results sha256: `7469bc442724553e199221564d09c75fa8b827320ce9d98e19d5cca5a58b114b`.
- Verified locally: first run `CREATED`; rerun `UNCHANGED`; rerun with outbound IP traffic denied
  by a macOS sandbox (`(deny network-outbound (remote ip))`, which blocks `curl`) `UNCHANGED` with
  the same hash. The crypto study and equity v1 and v2 still reproduce `UNCHANGED`, and scan
  `20261111T183825Z-dc217757` reproduces `MATCH`.

## Limitations

- One frozen export, one universe chosen from today's market capitalisation, one model. The
  counts describe this history, not crypto in general.
- Consecutive days share most of their window, so the 18,322 pair-days are far from independent;
  no test of significance is made or implied.
- The grid tests sample abstract inputs; the derivations are the proofs. Synthetic paths show a
  cell is reachable, not how often real candles reach it.
- How often a regime flip, rather than the factors, decided a label was not measured.
