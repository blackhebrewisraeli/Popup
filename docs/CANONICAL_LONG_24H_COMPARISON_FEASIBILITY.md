# Canonical daily Long, 24-hour economic comparison: feasibility review

**Review only, 26 November 2026. Verdict `NOT_WORTH_RUNNING`.** The reviewed proposal stays
PROPOSED / NOT FROZEN / NOT RUN. This review froze, implemented and ran nothing. It computed no
canonical score, setup, Long count, forward return or performance figure, and it downloaded no
data. #222's `STOP`, the activityShock24h screen's `INCONCLUSIVE` and every earlier specification,
result and conclusion are unchanged.

- **Reviewed:** _Canonical daily Long setup: 24-hour economic comparison_ (owner-supplied Markdown,
  dated 26 November 2026, SHA-256 `c9a4a536f4d9e49b6d64dc12058cd3436ed7ea9b4eaba3c83042295a8e6753ad`).
  It is not committed: this review finds it not worth retaining (see [the verdict](#verdict)).
- **Code read at:** `main` = `712b956`. `git diff a4508a2..712b956` is empty for every source file
  the proposal names, so its source identity (`a4508a2`) still describes the code.

## Verdict

**`NOT_WORTH_RUNNING`.** The design is mostly sound, but its predictable result repeats published
research.

1. **The question was already asked on nearly the same pairs and dates.** The frozen crypto scanner
   study (#152, [SCANNER_RESEARCH.md](SCANNER_RESEARCH.md#crypto-crypto-usdt-v1)) replayed the
   unchanged scanner (`evaluateScan`, model `1.0.0`, 199 closed daily candles) on 25 Binance Spot
   USDT pairs. It covered 2024-09-01 to 2026-11-10, and 18 of the proposal's 20 pairs are in it.
   The Long setup held on **3 of 18,322 evaluated pair-days**, one pair, one quarter (2026-Q2).
   That study recorded it as "insufficient evidence". Its 1-day rank groups showed no difference
   from the same-date equal-weight mean.
2. **The model explains why, independently of the data source.**
   [MODEL_DIAGNOSTIC.md](MODEL_DIAGNOSTIC.md) (#153) proves, and
   [`canonicalModelReachability.test.ts`](../src/test/canonicalModelReachability.test.ts) pins,
   that no RSI or momentum reading reaches the Long score above 4.25% ATR/close. On #152's
   pair-days the median ATR/close was 6.4%, and volatility alone ruled Long out on 82.9%.
3. **The evidence floor therefore cannot plausibly be met.** The proposal needs at least 300
   selected pair-dates in each period, about 8.3% of roughly 3,600 pair-dates. On the 18
   overlapping pairs the published count is at most 3 over all 801 days. The pair-dates #152 did
   not cover are WLDUSDT and AAVEUSDT on every date, plus the other 18 pairs on nine late Period B
   dates. To reach 300, more than 80% of them in Period A, and more than 56% in Period B, would
   have to hold the setup. The arithmetic excludes that for any pair-date above 4.25% ATR/close.
   The expected verdict is `INSUFFICIENT_EVIDENCE`, which adds nothing to #152's finding.
4. **The incremental co-primary is a gross comparison.** With equal stakes, the inherited cost
   formula cancels except for a constant factor: mean A − B after costs = 0.997003 × the gross
   value ([row 18](#evidence)). #152 already made the gross 1-day comparison with a same-date
   equal-weight baseline. Costs change only mean A against cash, and with almost no entries mean A
   is close to zero by construction.

**Recommendation: stop.** Do not commit a corrected copy or a frozen specification, and do not
implement it. If the owner overrides this, [the correction list](#corrections-if-the-owner-overrides)
is what a retained version would need (`REVISIONS_REQUIRED` level). Only a different, separately
proposed rule would change this verdict. Lowering the threshold to obtain entries is excluded, as
the proposal itself says.

No count was computed for this review, and the proposal's floors were not changed. Points 1 to 3
use aggregates already published by #152 and #153, which this review was asked to read.

## A. What existing research measured

| Work                                                                         | Data and rule                                                                                                                | Outcome measured                                                                                                           | Result                                                                                                                     | Overlap with this proposal                                                                                                                                |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #152 crypto scanner study ([doc](SCANNER_RESEARCH.md#crypto-crypto-usdt-v1)) | TradingView daily bars of 25 `BINANCE:` pairs; `evaluateScan` with the TradingView policy; standing Long, transitions, ranks | Gross OPEN(D+1 00:00) to OPEN 1/5/20 days later, against the same-date equal-weight mean and a volatility-matched baseline | Long: 3 pair-days, insufficient evidence. Ranks: no 1- or 5-day difference; a 20-day mean gain resting largely on one pair | Same rule, 18 of 20 pairs, every Period A date and all but the last 9 Period B dates; its 1-day window is this proposal's 24-hour window one hour earlier |
| #153 model diagnostic ([doc](MODEL_DIAGNOSTIC.md))                           | #152's replay; formulas of model `1.0.0`                                                                                     | None (reads no outcome)                                                                                                    | Long is out of reach above 4.25% ATR/close; 85.5% of pair-days HIGH_VOLATILITY; all 3 Longs TRENDING rebounds              | Explains the expected count of this proposal                                                                                                              |
| #152 prospective follow-up                                                   | Same scanner, 20-day top 5                                                                                                   | Gross, prospective, not collected yet                                                                                      | None yet                                                                                                                   | Different group and horizon; not affected                                                                                                                 |
| #118 equity scanner v1/v2 ([doc](SCANNER_RESEARCH.md))                       | 50 US equities and ETFs                                                                                                      | Gross 1/5/20 sessions                                                                                                      | Higher ranks lagged the universe (v1); v2 added a volatility-matched baseline                                              | Other asset class                                                                                                                                         |
| #215 v1 and #216–#222, #228                                                  | v1's 1h klines; RSI/MACD cells, breakout, structure, quantile, expected-net and activity classifiers                         | Barrier outcomes, wallets, calibration                                                                                     | INSUFFICIENT_EVIDENCE, STOP or INCONCLUSIVE                                                                                | Same files; none uses the daily canonical score or the Long setup                                                                                         |
| Strategy-validation lab ([doc](STRATEGY_VALIDATION.md))                      | Risk-profile eligibility (score ≥ 60 or 71)                                                                                  | None: performance is deliberately unavailable                                                                              | Operational evidence only                                                                                                  | Different rule; no returns                                                                                                                                |

**What the proposal would add:** a net-of-cost, per-opportunity 24-hour return for the Long setup
against cash, a one-hour delayed entry, and an exposure-matched control on daily candles rebuilt
from v1's Binance 1h klines. That information exists only if the setup occurs often enough to
measure, and the published evidence says it will not.

## Evidence

| #   | Proposal item                                     | Implementation (file)                                                                                                                                   | Finding                                                                                                                                                                                                                                                                                                                                      | Required action                                                                                                                                                  |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Distinct question; scanner research is gross only | [SCANNER_RESEARCH.md](SCANNER_RESEARCH.md#findings-aggregates), [MODEL_DIAGNOSTIC.md](MODEL_DIAGNOSTIC.md)                                              | The proposal links the scanner research but omits its Long finding (3 of 18,322 pair-days) and #153's bound.                                                                                                                                                                                                                                 | Disclose both as prior knowledge. Basis of the verdict.                                                                                                          |
| 2   | Canonical model 1.0.0                             | `CANONICAL_MODEL_VERSION` in `src/lib/canonicalModel.ts`                                                                                                | Matches; unchanged since `a4508a2`.                                                                                                                                                                                                                                                                                                          | None.                                                                                                                                                            |
| 3   | Long: score ≥ 78                                  | `LONG_SETUP_MIN_SCORE`, `modelSetups`                                                                                                                   | Compared with the rounded score (`Math.round`), so the raw boundary is 77.5. One of #152's 3 Longs (77.56) depended on rounding.                                                                                                                                                                                                             | State the rounding.                                                                                                                                              |
| 4   | MACD histogram / last close ≥ 0.0005              | `evaluateCandles`, `FLAT_MOMENTUM`                                                                                                                      | Matches: MACD(12, 26, 9) histogram on the window's last bar divided by that bar's close, inclusive.                                                                                                                                                                                                                                          | None.                                                                                                                                                            |
| 5   | Standing setup, not an alert                      | `modelSetups` doc comment; `pine/zerochart_quant_hud.pine`                                                                                              | Matches the Research board's standing label. Pine alerts fire only on a false-to-true change, run on its 200-bar window and use TradingView's EMA initialization; that path is not reproduced.                                                                                                                                               | Say that the Pine alert path is out of scope.                                                                                                                    |
| 6   | Exactly 199 closed daily candles                  | `CRYPTO_POLICIES`, `SCAN_MODEL_WINDOW` in `src/lib/marketScanner.ts`; `validateBinanceDailyCandles`                                                     | The Binance policy keeps the last **200** closed candles; a live scan has 199 only because one of the 200 fetched rows is still open. The TradingView policy cuts to 199. An adapter that passes 200 or more closed days under the Binance policy silently scores 200, which changes every recursively seeded indicator.                     | Pass exactly the 199 days; assert the result's `closedCandles` is 199.                                                                                           |
| 7   | Window ends at D−1                                | Same policies                                                                                                                                           | At 00:05 the Binance policy's 48-hour bound would still accept a window ending at D−2 if D−1 were absent; the TradingView policy's 24-hour bound would not.                                                                                                                                                                                  | Name the provider configuration; check that the last candle opens at D−1 00:00Z before scoring.                                                                  |
| 8   | v1 symbols into the scanner                       | `classifyTicker`, `scanInstrument` in `src/lib/ticker.ts`, `marketScanner.ts`                                                                           | v1's `BTCUSDT` does not match the crypto pattern `^([A-Z0-9]+)-USDT?$`, so it is classed as an equity and returned `UNSUPPORTED`. The scanner needs `BTC-USDT`, which maps to `BINANCE:BTCUSDT`.                                                                                                                                             | Specify the mapping; assert each instrument.                                                                                                                     |
| 9   | "Parity with `evaluateScan`"                      | `evaluateScan`; #152's parity design                                                                                                                    | This is code-path parity on rebuilt inputs, not input parity. Live Binance scans read 1d klines; Research's crypto scan reads TradingView bars of `crypto-usdt-v1` (25 pairs); v1 holds today's version of past 1h klines, not point-in-time snapshots; the universes differ.                                                                | Gate on code path (scanner result equals `evaluateCandles` + `modelSetups` on the same 199). Report, never gate, any reconciliation with #152's recorded replay. |
| 10  | Daily candles from 24 hourly candles              | `validateBinanceDailyCandles` (run again by `evaluateScan`)                                                                                             | Conventions match (UTC-aligned open, close = open + 86,399,999 ms). Equality with Binance's own 1d klines is plausible but not verified. No 1h-to-1d helper exists in the repository.                                                                                                                                                        | Call them reconstructed daily candles.                                                                                                                           |
| 11  | v1 inputs and hashes                              | v1 manifest in `.zerochart-reports/spot-24h-probability-b3aa90fb8912.json` (run `2d848fb`)                                                              | Verified read-only ([boundary](#boundary)): `universe.json` and all 20 files match; every hour of the needed span is present.                                                                                                                                                                                                                | None.                                                                                                                                                            |
| 12  | Earlier data for warm-up                          | `rsi`, `macd`, `atr` in `src/lib/indicators.ts`                                                                                                         | Indicators are seeded at the window's start, so nothing before each 199-day window affects the score. The first window is 2025-05-07 to 2025-11-21; complete days exist from 2024-11-14.                                                                                                                                                     | Say "unused", not "warm-up".                                                                                                                                     |
| 13  | 00:05 decision, 01:00 entry, 01:00 exit           | Proposal; v1 1h files                                                                                                                                   | No price after D−1 23:59:59.999 enters a signal; the entry bar opens after the decision. Each exit is the next date's entry time, so holding periods abut and never overlap. Historical opens are observed prices; fills, fees, slippage and data availability at 00:05 are assumptions.                                                     | None.                                                                                                                                                            |
| 14  | Period boundaries                                 | Proposal; v1 last hour 2026-11-21T23:00Z                                                                                                                | Eligible decision dates: A 2025-11-22 to 2026-05-20 (180), B 2026-05-22 to 2026-11-20 (183). 2026-05-21 belongs to neither. The last exit bar (2026-11-21 01:00Z) is saved. Exits are at 01:00, so "exit exactly at its end boundary" can never apply.                                                                                       | Replace that clause with these date ranges.                                                                                                                      |
| 15  | Common-date exclusion                             | Proposal                                                                                                                                                | Coherent and applied to every arm. No hour is missing in the span, so no exclusion is expected. Exclusion is unbiased only if failures are unrelated to returns; outages tend to cluster in stress.                                                                                                                                          | None; keep naming each reason.                                                                                                                                   |
| 16  | No target or stop                                 | Proposal                                                                                                                                                | Measures the whole 24-hour return with no barrier path, so it is not comparable with v1's T/S scenarios. Both arms take the same tails, so A − B stays fair. A setup standing on consecutive dates pays a full round trip each day, a cost a holder would not pay; this is conservative for A against cash and cancels in A − B.             | None. No exit search.                                                                                                                                            |
| 17  | Arms A, B, C                                      | Proposal formulas                                                                                                                                       | Equal stake verified: A holds k units, B holds k/N in each of N pairs (k units). k = 0 gives A = B = C = 0; k = N gives A = B.                                                                                                                                                                                                               | None.                                                                                                                                                            |
| 18  | Costs via `netReturn(entry, exit, 'TIMEOUT')`     | `netReturn` in `scripts/spot24h.ts`                                                                                                                     | r = c × exit/entry − 1 with c = (1 − 0.001)² × (1 − 0.0005) / (1 + 0.0005) = 0.997003, a 0.2997% round trip. With equal stakes, A − B after costs = c × A − B before costs, exactly. Spread is not charged twice.                                                                                                                            | State this; report A − B gross but not as cost evidence.                                                                                                         |
| 19  | What B controls for                               | `modelSetups`; #152's matched baseline                                                                                                                  | B isolates selection within a date at fixed exposure. It does not control volatility: Long is possible only at ATR/close ≤ 4.25%, so A holds quiet pairs by construction. It does not control beta. Timing sits in B, since k(d) varies.                                                                                                     | Report mean B, so mean A = mean(A − B) + mean B. Volatility stays a limitation; no new arm.                                                                      |
| 20  | Per-opportunity, not wallet                       | [SPOT_24H_DECISION_CONTRACT.md](SPOT_24H_DECISION_CONTRACT.md); #218                                                                                    | Consistent with #221's convention. B's fractional positions could not be placed with a wallet of about 44 USDT; capital, concurrency and order minimums are not modelled.                                                                                                                                                                    | None.                                                                                                                                                            |
| 21  | Bootstrap                                         | `bootstrapOrders` (`scripts/swingStructureEvaluation.ts`); `dayOrders`, `ratioInterval`, `quantile` (`spot24h.ts`); `STUDY` in `scripts/expectedNet.ts` | Reusable unchanged. `dayOrders` defaults to v1's 2,000 replicates and v1's seed, so the specification must override both, as #222 did. The grid label in the draw message must be named. The axis is the 180 and 183 eligible dates. For A and A − B the denominator is measurable days, so the ≥ 9,900 defined-replicate floor cannot bind. | Fix replicates, seed, labels and axis. Keep the replicate floor only for ratios over selections.                                                                 |
| 22  | Evidence floors                                   | Proposal                                                                                                                                                | Design defaults, not a power calculation. 300 selections per period is about 8.3% of 3,600 (A) or 3,660 (B) pair-dates. Not adjusted here. Practically unreachable (row 1, verdict point 3).                                                                                                                                                 | None. Basis of the verdict.                                                                                                                                      |
| 23  | Verdict order                                     | Proposal                                                                                                                                                | Coherent: integrity, then floors, then a four-part conjunction in both periods. `NOT_SUPPORTED` correctly names a non-positive estimate apart from an interval including zero, and is not proof of no advantage. What each verdict ends is not stated.                                                                                       | Add what follows each verdict: stop, with no threshold, horizon, universe or exit variant.                                                                       |
| 24  | Source identity                                   | `git diff a4508a2..712b956`                                                                                                                             | Unchanged. The block-bootstrap draws live in `swingStructureEvaluation.ts`, which `spot24h.ts` imports.                                                                                                                                                                                                                                      | Cite both files.                                                                                                                                                 |

## Corrections if the owner overrides

None of these is applied anywhere: no corrected copy is committed.

**Blocking ambiguities**

1. **Scanner adapter** (rows 6–8): map each v1 symbol to `<BASE>-USDT` and assert the instrument
   `BINANCE:<SYMBOL>`; pass exactly the 199 reconstructed days; check that the last opens at D−1
   00:00Z; set `evaluationTime` to D 00:05Z; name `cryptoProvider`.
2. **Parity** (row 9): the gate is code-path parity only; input reconciliation is reported.
3. **Date axis and bootstrap** (rows 14 and 21): the explicit eligible dates, replicates, seed and
   grid labels.
4. **Prior evidence and endings** (rows 1 and 23): disclose #152 and #153, and state that
   `INSUFFICIENT_EVIDENCE` and `NOT_SUPPORTED` end the line.

**Recommended defaults**

- `cryptoProvider: 'binance-spot-klines'` (policy `binance-daily-v1`), because the bars are
  Binance-sourced and the live Binance scan uses it. The explicit D−1 check supplies the strictness
  its 48-hour bound lacks.
- Bootstrap grid labels `A` and `B`, v1's draw message, 10,000 replicates and the proposal's seed,
  shared by A, B and A − B within a period.
- Report mean B and A − B before costs next to the after-cost figures (rows 18 and 19).
- Replace the boundary clause with the explicit date ranges (row 14) and call the candles
  reconstructed (row 10).

**Limitations that remain after correction**

- Both periods are examined development history; neither is a holdout.
- v1's universe was chosen on 2026-11-21 by 24-hour volume: look-ahead and survivorship remain.
- Today's version of past klines, not point-in-time data; daily candles rebuilt, not served.
- Costs and fills are inherited assumptions: no spread, latency, partial fill or order minimum.
- B is not volatility-matched, and A selects quiet regimes by construction.
- Daily round-trip costs on standing setups make A against cash conservative relative to holding.
- Seven-day blocks may understate dependence from persistent setups and volatility clustering.
- Per-opportunity returns are not wallet returns.
- Not blind: the model's constants and #152's and #153's results were known in advance.

## Reusable components and missing work

**Reusable as they are:** `evaluateScan` (`src/lib/marketScanner.ts`); `evaluateCandles` and
`modelSetups` (`src/lib/canonicalModel.ts`); `validateBinanceDailyCandles`, which `evaluateScan`
applies; `indexHourly`, `consecutive`, `netReturn`, `quantile` and `ratioInterval`
(`scripts/spot24h.ts`); `bootstrapOrders` (`scripts/swingStructureEvaluation.ts`); v1 manifest
hash verification (as in `scripts/expectedNet.ts`); the write-once `saveResearchResults`
(`scripts/scannerResearch.ts`, reused by `scripts/activityShockRun.ts`); `protocolSha256` and
`stableSerialize`.

**Genuinely missing:** a 1h-to-1d aggregation, the v1-to-`ScanInput` adapter (rows 6–8), per-date
arms with coverage accounting, the frozen JSON, synthetic tests and a report. It is small, but not
recommended.

## Boundary

**Inspected:** the proposal; `canonicalModel.ts`, `marketScanner.ts`, `candleValidation.ts`,
`evaluationLab.ts`, `ticker.ts`, `scripts/evaluate-canonical.ts`, `spot24h.ts`, `expectedNet.ts`,
`swingStructureEvaluation.ts` (bootstrap), `scannerResearch.ts` (write-once helper),
`spot24hBreakout.ts` (header and report only);
STRATEGY_VALIDATION, SCANNER_RESEARCH, MODEL_DIAGNOSTIC, SPOT_24H_DECISION_CONTRACT,
`spot-24h-probability.v1.json`, TRADINGVIEW_CRYPTO_SCAN (universe) and the #222 and activityShock24h
reports. v1's saved files were opened read-only from the main checkout's git-ignored stores.

**Computed:**

- SHA-256 of the proposal, `universe.json`, the 20 candle files and the v1 result. All 21 inputs
  equal the v1 manifest (run `2d848fb`); the v1 result is `662c5d7d…`, as #222's specification
  records.
- Structure only, per file: 17,720 rows from 2024-11-13T16:00Z to 2026-11-21T23:00Z, hour-aligned,
  close = open + 3,599,999 ms, no duplicate, and no missing hour from 2025-05-07T00:00Z (first
  window day) to 2026-11-21T01:00Z (last exit bar).
- Calendar counts (180 and 183 eligible dates), the cost constant c, and a synthetic grid of
  `scoreFactors` (no market data) that agreed with #153's 4.25% bound.

**Not computed or inspected:** any canonical score, setup, Long count, ATR, return, outcome or
bootstrap on real data; any price comparison. v1's price validity under `indexHourly` was not
rerun; #228 reports exact OHLC parity between v1 and a separately retrieved, fully valid copy.
Also not inspected: #152's and #153's private per-pair files (published aggregates only), live
scan snapshots and Binance 1d klines. Nothing was downloaded, fitted, frozen, implemented,
collected or traded, and no test was added.
