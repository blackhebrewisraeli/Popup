# Immediate vs waiting entry after an hourly sweep: waiting only reduced a loss

**Status: development research, finished. Verdict `INCONCLUSIVE`; per the specification, stop.**
One paired comparison on the hourly candles that [protocol v1](SPOT_24H_PROBABILITY.md) saved.
That whole history had already been examined by v1, its [diagnosis](SPOT_24H_V1_DIAGNOSTIC.md),
the [breadth filter](SPOT_24H_BREADTH_FILTER.md) and the
[channel-breakout wallet](SPOT_24H_CHANNEL_BREAKOUT.md), so nothing here is independent
validation. No wallet was simulated: the figures are mean returns per 1-USDT hypothetical stake,
not achievable portfolio returns.

## In brief

- **Waiting improved net return per source opportunity**: +0.395 percentage points per source,
  95% interval +0.160 to +0.614 (paired 7-day block bootstrap over source days). The point estimate
  is positive in every period; test's interval spans zero.
- **It did not produce positive net expectancy. It reduced a loss.** The zero-return reference is
  cash: no entry earns 0%. Immediate entry (A) lost −0.403% per source. Waiting (B) lost −0.008%
  per source: its point estimate stays below zero, and its interval (−0.039% to +0.018%) spans
  zero. It traded on only 4.5% of sources, and its 147 trades averaged **−0.178% net** (+0.111%
  gross). B's mean net per source was negative in train, validation and test. Improving on a losing
  arm A does not establish profitable selection.
- **3,093 of 3,240 sources (95.5%) never entered**: 2,208 cancelled because the sweep low broke
  first, 627 without a structure break within six hours, 171 without a gap in the one triplet, 65
  without a return by S+12 and 22 whose first return closed or opened below the gap.
- **The improvement is avoidance, not better trades.** This is a post-hoc decomposition of the
  recorded rows, not a specified test and not an ex-ante executable selection rule: whether B
  enters is known only hours after D, so no one could have chosen at D to hold A on exactly these
  sources. The 3,093 sources B skipped contribute +0.517 points: A lost −0.542% on them. The 147
  sources B entered contribute −0.122 points: A earned +2.52% per trade there and B −0.18%. That is
  consistent with B entering after a rally above H that A already held; the study did not test it.
- **Not enough to justify independent validation.** The frozen rule needs B's net per source to
  have a positive lower bound and positive point estimates in validation and test. It has neither.
  Neither upper bound is below zero, so the verdict is `INCONCLUSIVE`, not `NEGATIVE`.

## What was fixed in advance

[`docs/structure-entry-1h-dev-v1.json`](structure-entry-1h-dev-v1.json) was committed on its own
(`7bab9af`) before any study code existed or any source, entry or return was computed. Nothing in
it changed afterwards. It records every implementation choice; the main ones:

| Choice       | Fixed value                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data         | v1's 20 pairs and saved 1h candles, each file's SHA-256 checked against v1's recorded manifest. No download                                                                                                                                                                                                                |
| Time         | Epoch ms, UTC. Source decision D = open(S) + 1h, when S has closed. Offsets S+k in whole hours                                                                                                                                                                                                                             |
| 4h bias      | The 50 complete UTC-aligned 4h bars closed by D (the bar holding S only if S is its fourth hour), `evaluateSwingStructure` with 2/2 bars, unchanged. Must be EVALUATED and Up                                                                                                                                              |
| Pivots       | `evaluateSwingStructure` with 2/2 bars, unchanged, on the 200 candles S-200 … S-1: its last confirmed low L and high H, with their tie handling and `availableAt`                                                                                                                                                          |
| Source       | L unbreached (no low < L after it became available), low(S) < L < close(S) < H, ATR14 over S-199 … S. One source per pivot low. Bias, L, H, sweep low and ATR frozen at D for both arms                                                                                                                                    |
| Admission    | D and D + 36h inside one of v1's periods (train, validation, test), decided before either arm                                                                                                                                                                                                                              |
| A            | Market entry at the open of S+1                                                                                                                                                                                                                                                                                            |
| B            | First close above H among S+1 … S+6 (M), which must be bullish; only the triplet M-1, M, M+1 for a gap high(M-1) < low(M+1); the first later candle up to S+12 touching G_high is the one return; it must neither open nor close below G_low; entry at the next open. Any low ≤ sweep low through J cancels, checked first |
| Exits (both) | From each arm's own entry open: stop −2 × source ATR, target +4 × source ATR, v1's scan candle by candle (gap stop at the open, both touched = AMBIGUOUS at the stop), else the 24th candle's close                                                                                                                        |
| Costs, stake | v1's: 0.10% per fill, 0.05% slippage on market fills, none on the target. 1 USDT per source and arm; no entry is 0                                                                                                                                                                                                         |
| Uncertainty  | Paired moving block bootstrap over UTC source days, 7-day blocks, 10,000 replicates, seed `popup-structure-entry-1h-dev-v1`, type-7 percentiles 2.5 and 97.5; replicates without a source are undefined (an interval needs 9,900 defined)                                                                                  |
| Verdict      | Integrity failure; else fewer than 300 sources on 60 days or 100 B entries on 30 days (insufficient); else both pooled lower bounds > 0 and both point estimates > 0 in validation and test (candidate); else an upper bound < 0 (negative); else inconclusive                                                             |

## Results

### Sources

350,420 pair-hours were scanned (20 pairs × 17,521 decision hours). No candle issue, no
unavailable outcome, no integrity failure.

| Screening reason (first that applies)     |   Hours |
| ----------------------------------------- | ------: |
| `INPUT_UNAVAILABLE` (first hour per pair) |      20 |
| `LOW_ALREADY_BREACHED`                    |  86,032 |
| `NO_SWEEP`                                | 240,686 |
| `NOT_RECLAIMED`                           |  12,168 |
| `CLOSE_NOT_BELOW_HIGH`                    |     165 |
| `BIAS_UNAVAILABLE`                        |       2 |
| `BIAS_NOT_UP`                             |   8,098 |
| `BOUNDARY`                                |       9 |
| Admitted sources                          |   3,240 |

`NO_CONFIRMED_LOW`, `NO_CONFIRMED_HIGH`, `ATR_UNAVAILABLE` and `PIVOT_ALREADY_USED` were 0.

### Paired returns per source (percent of the 1-USDT stake)

|                                 |              All |            Train |       Validation |             Test |
| ------------------------------- | ---------------: | ---------------: | ---------------: | ---------------: |
| Sources (source days)           |      3,240 (580) |      1,755 (297) |        772 (136) |        713 (147) |
| A mean gross / net per source   |  −0.114 / −0.403 |  −0.124 / −0.413 |  −0.164 / −0.453 |  −0.034 / −0.324 |
| B entries (entry days)          |        147 (111) |          83 (62) |          40 (26) |          24 (23) |
| B fill rate                     |             4.5% |             4.7% |             5.2% |             3.4% |
| B mean gross / net per source   |  +0.005 / −0.008 |  −0.000 / −0.014 |  +0.014 / −0.001 |  +0.008 / −0.002 |
| B mean gross / net per trade    |  +0.111 / −0.178 |  −0.003 / −0.290 |  +0.266 / −0.024 |  +0.245 / −0.046 |
| **Paired B − A net per source** |       **+0.395** |           +0.399 |           +0.452 |           +0.322 |
| 95% interval, B − A             | +0.160 to +0.614 | +0.050 to +0.737 | +0.105 to +0.934 | −0.114 to +0.644 |
| 95% interval, B net per source  | −0.039 to +0.018 | −0.062 to +0.029 | −0.033 to +0.036 | −0.047 to +0.060 |
| B better / worse than A         |    2,027 / 1,213 |      1,086 / 669 |        492 / 280 |        449 / 264 |

All 10,000 replicates were defined in every window. A's mean per trade equals its mean per source
(it always entered). Per-period intervals are descriptive; the verdict uses the pooled ones.

### Exits

| Arm | Trades | TARGET | STOP (gap) | TIMEOUT | AMBIGUOUS |
| --- | -----: | -----: | ---------: | ------: | --------: |
| A   |  3,240 |    645 |  1,662 (1) |     933 |         0 |
| B   |    147 |     31 |     78 (0) |      38 |         0 |

Target shares (A 19.9%, B 21.1%) are historical frequencies on overlapping, examined data, not
calibrated probabilities.

### Where B stopped

3,240 sources → 416 structure breaks → 239 gaps → 169 first returns → 147 entries.

| B outcome                          | Sources |
| ---------------------------------- | ------: |
| `ENTERED`                          |     147 |
| `CANCELLED_SWEEP_LOW_BROKEN`       |   2,208 |
| `NO_STRUCTURE_BREAK` (expiry)      |     627 |
| `NO_FVG`                           |     171 |
| `NO_RETURN` (expiry)               |      65 |
| `RETURN_BELOW_GAP`                 |      22 |
| `STRUCTURE_BREAK_NOT_BULLISH`      |       0 |
| `ENTRY_OPEN_AT_OR_BELOW_SWEEP_LOW` |       0 |
| `ENTRY_OPEN_BELOW_GAP`             |       0 |
| `INVALID_LEVELS`                   |       0 |

Of the cancellations, 2,197 came before any break, 6 on the gap candle and 5 while waiting for the
return. Three rules never fired. In a continuous 24-hour market an hourly open sits at or very near
the previous close, so a first close above H (with the previous close at or below it) is bullish,
and the entry open stays near J's accepted close (it equalled it in 76 of 147 entries).

B's waiting time from D to its entry: 3 h (15), 4 h (21), 5 h (20), 6 h (22), 7 h (26), 8 h (19),
9 h (9), 10 h (6), 11 h (6), 12 h (3); mean 6.4 h, median 6 h.

### Concentration and consistency

The improvement is broad, not a few observations: all 20 pairs have a positive mean difference
(from +0.02 points for ETHUSDT to +1.03 for WLDUSDT). The summed difference is 12.79 USDT over
3,240 stakes; 11.19 without the best pair, 11.63 without the ten largest single differences, which
hold 2.2% of all positive differences. By UTC month of D, the difference was positive in 20 of 25
months, B's net per source in only 8.

That breadth is what avoidance looks like: A lost in most months, and B stayed in cash 95.5% of
the time. It is not evidence that B's own entries are good.

## Answers

1. **Did waiting improve net return per source opportunity?** Yes: +0.395 points per source, with a
   positive pooled lower bound and a positive point estimate in each period.
2. **Positive net expectancy, or a smaller loss?** A smaller loss (`LOSS_REDUCED_ONLY`). Against cash
   (no entry, 0%), B's net per source is −0.008%: below zero as a point estimate, with an interval
   (−0.039% to +0.018%) that spans zero. Its trades lost −0.178% each after costs. Improving on a
   losing arm A does not establish profitable selection, and B is not called profitable.
3. **How many sources never entered?** 3,093 of 3,240 (95.5%).
4. **Consistent enough for independent validation?** No. B's net per source has a negative lower
   bound and negative point estimates in validation and test, and only 24 test entries. Per the
   specification, the verdict ends this task: no tuning, no other package, no follow-up started.
5. **What does hourly resolution leave unresolved?**
   - Order inside an hour: whether a return touched the gap before the sweep low broke in the same
     candle (cancellation was given priority), and whether stop or target came first (no ambiguous
     candle occurred here).
   - Limit fills: a resting buy order at G_high might have filled at the first touch inside a
     candle, including on the 22 returns that closed below the gap. This study did not simulate
     such an order. Hourly OHLC cannot establish whether it would have executed, the order of
     events inside the candle, or whether its price would have beaten the actual next-open entry.
     The study measured only a close-confirmed return followed by a market entry.
   - Lower timeframes: breaks, gaps and returns inside an hour are invisible. A return during C
     itself is excluded by construction.
   - Spread, queue position and slippage at the actual moments: modelled as v1's flat 0.05%.

## Limits

- **Examined data.** Four earlier studies used this history. Everything here is development
  evidence.
- **Dependence.** 3,240 sources on 580 days overlap in time and across co-moving pairs. Seven-day
  blocks keep dependence within about a week only; longer regimes make the intervals optimistic.
- **No portfolio.** Overlapping 1-USDT stakes are not achievable returns. No wallet, equity curve,
  drawdown or compounding was computed.
- **One package.** B tests the whole sequence. It says nothing about the structure break or the gap
  alone.

## Provenance

| Item          | Value                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Specification | `popup-structure-entry-1h-dev-v1`, SHA-256 (stable serialization, as v1) `bb4694c68cde995daa2a6a800830ad1214b13bde88d4c1bd12e149a49c94be09`, committed alone in `7bab9af`                                                                                                |
| Code          | `22b33fd0f392b880ed8a6d07fcabdf901db90a82`; the result records each source file's git blob. Validation, ATR, the outcome scan, costs, hashing, quantiles and bootstrap draws are the existing functions; `scripts/swingStructure.ts` and `candleValidation.ts` unchanged |
| Inputs        | v1's recorded result `662c5d7d…6ec1e`, `universe.json` `b43acfda…` and the 20 candle files (17,720 candles each, no gap), each matched to its recorded SHA-256 before the run                                                                                            |
| Output        | `.zerochart-reports/structure-entry-1h-dev-v1-bb4694c68cde.json` (git-ignored), SHA-256 `aab7284c576d98cb79464988acddcd02fcbc0c69070811c54009bb9846d189c8`, `CREATED` on 2026-11-25. Run once; rerun at `22b33fd` → `UNCHANGED`, elsewhere → `CONFLICT`                  |
| Preserved     | Every earlier result in `.zerochart-reports/` and every saved market-data file had the same SHA-256 before and after the run                                                                                                                                             |
| Checks        | 41 synthetic tests (`scripts/structureEntry.test.ts`); 17 single-rule mutations each failed at least one test; 18 recorded rows, all six B outcomes, re-derived from the raw candle files by an independent script with no mismatch                                      |

Reproduce with `npm run evaluate -- structure-entry-1h-dev-v1` at `22b33fd`.

**Changes after the run.** No rule, threshold or specification changed, and the recorded blobs
remain the run commit's; reproduce there.

- Tests: the future-candle test timed out under the full suite's load, and as written it let the
  index drop the changed candles. It now keeps them, compares every row whose 36-hour follow-up
  ends before them, and fails if arm B reads past S+12.
- SonarCloud: arm B's single function (cognitive complexity 27, limit 15) was split into a
  structure-break, a first-return and an entry helper. On four synthetic 20-pair markets (rising,
  flat, falling, and one with missing candles that ends in `INTEGRITY_FAILURE`) the run commit's
  code, checked out from `22b33fd`, and the changed code give byte-identical study output. On v1's
  saved candles the changed code's results equal the recorded `results` exactly, computed in
  memory; nothing was written.

**Not done:** no UI, order, alert, account read, experiment record, migration, deployment,
schedule, download or prospective collection.
