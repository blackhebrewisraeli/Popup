# Retrospective scanner study

Does the market scanner's ranking, or its setup conditions, say anything about what prices did
next? This study replays the existing scanner (`market-scan-v2`, model `1.0.0`,
`us-equity-daily-v1`) over the history in the private TradingView export of the 50-instrument
development scan and compares its signals with same-date baselines.

It is **retrospective historical research**. The scanner did not record these readings at the
time, so nothing here is prospective evidence, a backtest, a fill or a trading result. It changes no
model, weight, threshold, ranking, alert or campaign.

The crypto scan has its own frozen study, run on the same infrastructure:
[Crypto: `crypto-usdt-v1`](#crypto-crypto-usdt-v1).

Code: `scripts/scannerResearch.ts` (specification, replay, outcomes, comparisons),
`scripts/scannerResearchReport.ts` (private HTML), tests in `scripts/scannerResearch.test.ts`.

## Frozen specification

[`scanner-research.v1.json`](scanner-research.v1.json) is the machine-readable study:
universe and selection rule, calendar and evaluation dates, decision time, scanner versions and
history window, long-setup and risk-warning definitions, rank groups, 1/5/20-session horizons,
reference, endpoint and benchmark conventions, comparisons, statistics, missing-data rules and the
study identifier. Its ID is the SHA-256 of its canonical content,
`ab0d42aa14413cd2f05a2b29a516c85502aa0ff410652375a8390eb0860bebdf`, and a test keeps the JSON and
the code identical.

It was committed (8a93089, 2026-10-29 13:25:05Z, pushed at once) after inspecting only the export's
bar dates, bar counts, timestamps and market-data notice, and before any score, rank or forward
price change was computed. The replay code was committed (6fe2e49) before it first ran on the export.
A change to any of it is a new study version, frozen before it is run, not an edit of this one.

## Method

- **Data.** The export `.zerochart-tradingview/20261029T103004Z.json` (git-ignored), identified in
  the specification by its SHA-256: 1,000 daily bars per symbol from TradingView's `get_ohlcv`,
  regular session, split-adjusted only. A bar is used only if its session was final (9h after the
  close) when retrieval started, through `tradingViewSeries`, the import's own mapping.
- **Calendar.** TradingView sends none and the published calendar in `usEquityDaily.ts` starts in
  2026, so the sessions are those present in any member's bars. Where the published calendar
  reaches, they must equal it exactly or the study refuses to run.
- **Evaluation dates.** Every observed session from the first on which every member's data allows a
  full window: 802 dates, 2023-08-18 to 2026-10-28, the same for every member.
- **Replay.** On each date the scanner gets only bars of sessions on or before it, from the
  200-session range the scan requests, and scores the last 199 with `evaluateCandles`, checking
  them in `assessEquity`'s order: invalid or gapped window → `DATA_INVALID`, latest bar older than
  the session before → `STALE_DATA`, short → `INSUFFICIENT_HISTORY`. Ranking, `modelSetups` and
  failures are kept per member and date. Nothing is filled or repaired.
- **Parity.** On every date whose request range the published calendar covers, the actual scanner
  (`importInputs` + `evaluateScan`) runs on the same export and must agree on status, window end,
  rank, score, regime and setups, or the study refuses to run.
- **Outcomes.** OPEN of the first session after the date (which opens after the decision time) to
  OPEN 1, 5 and 20 sessions later. The date's close is never an entry. A horizon whose endpoint is
  not final yet is `PENDING`; a missing or invalid bar is `MISSING` or `INVALID`; both are excluded.
- **Comparisons.** Long setups, risk warnings, top 5, top 10 and rank quintiles against the
  same-date mean of every scored member, and against SPY over the same sessions. Stocks and ETFs are
  also compared with the same-date universe of their own type; breakdowns by calendar year and by
  asset show concentration. Every horizon and group is reported, weak or negative.
- **Observations versus transitions.** A standing setup counts once per date it holds. A
  transition is a date on which it holds and the member was evaluated without it the date before;
  if the member was not evaluated the date before, the onset is unknown and it is not a transition.

## Reproduction

```bash
npm run evaluate -- scanner-research .zerochart-tradingview/20261029T103004Z.json
```

The command refuses any other export, and any run whose calendar, evaluation dates, retrieval or
scanner parity differ from the frozen study. It writes, git-ignored:

- `.zerochart-reports/scanner-research-ab0d42aa1441.json`: every replayed date and member and every
  aggregate. Written once; a rerun prints `UNCHANGED` only if it is byte-identical, otherwise
  `CONFLICT` and a non-zero exit.
- `.zerochart-reports/scanner-research-ab0d42aa1441.html`: the private report, coverage and method
  first, then every horizon, stocks versus ETFs, years, per-asset concentration and limitations.

It prints aggregates only (no ticker, price or per-asset figure). Market data and per-asset results
stay in the git-ignored files; this repository is public.

TradingView's terms as this repository reads them
([TRADINGVIEW_ONLY_FEASIBILITY.md](TRADINGVIEW_ONLY_FEASIBILITY.md#4-terms-by-use)) allow this as
the owner's personal research. Using its results in the product would need TradingView's written
confirmation first.

## Limitations

- No historical provider snapshots: every past bar is today's version of it, after any later
  corrections. What a provider would have served on each date is unknown, so this is not fully
  point-in-time.
- Split-adjusted history. The model's inputs (RSI, MACD histogram / close, ATR / close) and
  OPEN-to-OPEN ratios don't change under a uniform split factor, but adjusted prices are rounded
  after adjustment, and around a split a live provider could have served unadjusted bars that
  `us-equity-daily-v1` would reject.
- No dividend adjustment: changes are price only, the benchmark's too.
- The universe is today's configured list, selected in 2026. Delisted or later-listed instruments
  are absent, so survivorship and selection effects remain.
- Before 2026 the calendar is observed, not published; earlier early closes are unknown (they move
  the decision timestamp, never which bars are used).
- One provider, one retrieval, one roughly three-year period.
- Same-date comparisons remove the common market move, not differences in volatility or beta. The
  model rewards quiet regimes and flags high-volatility ones, so its groups differ in volatility by
  construction.
- Consecutive dates share most of each horizon, standing setups repeat, and same-date members share
  moves: counts are not independent trials, and no significance test, p-value or confidence interval
  is reported. No portfolio return, trade win rate or drawdown is computed, and a decline after a
  risk warning is not treated as profit.

## What it cannot establish

Whether trading on the scanner would have been profitable after costs; whether a difference is more
than chance; whether it would recur on future data, other instruments or other periods; or whether
point-in-time data would have given the same scores.

## v2: a volatility-matched baseline

v1 found that higher ranks were followed by smaller changes than the same-date universe, and risk
warnings by larger ones. The model rewards quiet regimes and flags high-volatility ones, so that may
be volatility rather than information. [`scanner-research.v2.json`](scanner-research.v2.json)
(ID `117f36fd7b240c6238c67dcc5179b470fc175345a461ab498dd6bf2226f2ba83`) fixes how to test that
before any volatility-stratified figure exists:

- Same export, universe, dates, scanner replay, horizons, prices and missing-data rules as v1,
  copied unchanged; it names v1's ID as its basis.
- Volatility is the model's own ATR(14) / close on the evaluation date. Each date, each
  population's evaluated members are split into terciles by it (ties by ticker).
- v1's groups (universe, long setups and transitions, risk warnings and transitions, top 5, top 10,
  rank quintiles) are compared with the same-date mean of their own volatility tercile; the three
  terciles themselves are compared with the same-date population mean; each group's spread across
  terciles is reported.
- Two populations: all 50 members, and the 38 stocks with terciles, ranks and baselines among
  stocks alone. ETFs alone are too few for terciles.

It was specified after v1's results were seen and uses the same data, so it can explain them, not
confirm them.

Code: `scripts/scannerResearchV2.ts`, on v1's replay unchanged (a v1 rerun still prints
`UNCHANGED`). Run it with:

```bash
npm run evaluate -- scanner-research-v2 .zerochart-tradingview/20261029T103004Z.json
```

It refuses what v1 refuses and writes, git-ignored, `.zerochart-reports/scanner-research-117f36fd7b24.json`
(written once, with each evaluated member's ATR/close per date) and `.html` (coverage and method,
then each population's tercile mix and every horizon, by year and by asset).

## Crypto: `crypto-usdt-v1`

The same question for the TradingView crypto scan: within the 25 frozen Binance Spot USDT pairs
([universe](TRADINGVIEW_CRYPTO_SCAN.md#universe-crypto-usdt-v1)), did higher-ranked pairs, or the
Long setup, precede larger price changes than a same-date baseline? Retrospective historical
research on today's provider history, not proof of profitability and not a trading system.

### Frozen before it ran

[`scanner-research-crypto.v1.json`](scanner-research-crypto.v1.json) (ID
`6d005fee9ffdfb561e3ea8412800d0d5f116fc816482cf66c5dc46959389dcbc`, kept identical to the code
by a test) fixes the universe exactly as committed with each pair's exact symbol, the export and
per-pair input hashes, the scanner, model and `tradingview-crypto-daily-v1` policy, the 199-candle
window, 801 evaluation days with a 15-pair coverage floor, the timestamps and horizons, the groups,
both baselines, missing-data rules, the statistics and the prior knowledge it cannot be blind to.

It was committed (`ac05b1f`, 2026-11-11 20:09:17Z) after inspecting only the export's identity
fields, bar counts, first and last dates, UTC alignment, gaps, duplicates and response metadata.
The replay code was committed (`aaf4eae`, 20:20:50Z) before it first ran on the export (20:21Z).
Committing the study first improves research discipline. It does **not** remove survivorship
bias, historical data revisions or prior knowledge of this model: the model and its thresholds,
the live scan's aggregate on 10 Nov (0 Long, 20 Risk) and the equity results above were all known.

### Method

- **Data.** Only the private export of the first crypto retrieval,
  `.zerochart-tradingview/20261111T183825Z.json` (sha256 `8d251bbf…`): 21 pairs hold 1000 daily
  bars from 2024-02-16 (TradingView has older ones; none were retrieved), ENA and TAO back to
  their 2024 listings, GRAM and HYPE back to their 2026 listings. No new retrieval, no Binance
  candle, no reconstructed bar. A bar is used, as input or outcome, only if it closed by the
  retrieval start, so the forming 11 Nov bar never is.
- **Selection bias.** The universe was chosen on 2026-11-11 from today's market-cap ranking:
  coins that collapsed or were delisted are absent, coins that grew are present. Every figure,
  the baselines included, carries that bias, and no retrospective slice of this history is unseen
  validation data.
- **Replay.** On each UTC day D from 2024-09-01 (the first day any pair holds 199 closed candles)
  to 2026-11-10, the scanner itself (`evaluateScan`, TradingView crypto policy, unchanged) gets
  each pair's candles from the 200 days the scan requests that closed by **D's close, 23:59:59.999
  UTC**, and nothing later. It validates, checks freshness (24h), scores the last 199 and ranks
  evaluated pairs only.
- **Parity.** Every day, the replay must equal `evaluateScan(importInputs(export, cutoff))`, the
  import reading the whole export with later bars left for the validator to exclude; and on
  10 Nov it must equal the recorded results of live scan `20261111T183825Z-dc217757` for all 25
  pairs. Otherwise the study refuses to run.
- **Outcomes.** OPEN of the bar opening at D+1 00:00:00.000 UTC (the first bar opening after the
  cutoff, 1 ms later) to OPEN h = 1, 5, 20 UTC days later. D's close is never the reference. In a
  24/7 market that open is usually at or near D's close: a reference price, not a fill. A bar not
  closed at the export cutoff makes the outcome `PENDING`; a missing or invalid bar `MISSING` or
  `INVALID`; nothing is substituted.
- **Baselines.** Each group against (1) the same-date equal-weight mean of evaluated pairs, and
  (2) same-date pairs in the same ATR/close tercile that are **outside** the group. An observation
  whose tercile holds no such pair is unmatched and counted, never matched elsewhere. Statistics
  add a date-weighted difference so busy dates do not dominate. Breakdowns by pair and quarter.

### Reproduction

```bash
npm run evaluate -- scanner-research-crypto .zerochart-tradingview/20261111T183825Z.json
```

It reads the export and `.zerochart-scans/20261111T183825Z-dc217757.json` only, refuses either
unless byte-identical to the frozen hashes (naming any changed pair entry), recomputes everything
and writes, git-ignored, `.zerochart-reports/scanner-research-6d005fee9ffd.json` (once; a rerun
prints `UNCHANGED`, a changed file `CONFLICT` with a non-zero exit) and `.html`. Results sha256:
`a14c0d191bc4d2878bd043985ec696f0419c6b08bac03fddcb7a4ed2918ffe71`.

Verified locally: rerun `UNCHANGED`; rerun with outbound network denied by a macOS sandbox
`UNCHANGED`; a copy of the export with one close changed refused, naming that pair; a changed
recorded scan refused; a changed results file `CONFLICT` with no report written. Equity v1 and v2
still reproduce `UNCHANGED`.

### Findings (aggregates)

Coverage: 801 days, 21–23 of 25 pairs evaluated each day (no day below the floor); 18,322
evaluated asset-days. GRAM and HYPE were `INSUFFICIENT_HISTORY` on every day; ENA joined on
2024-10-17 and TAO on 2024-10-26; no `DATA_INVALID` or `STALE_DATA`. Parity `MATCH` on all 801
days and on all 25 recorded results.

The equal-weight universe rose on average (+0.12%, +0.64%, +3.15% at 1, 5, 20 days) while the
typical pair trailed it (median difference −0.24, −0.68, −2.50 pp): a few large gains lift
every mean. Read mean and median together. Δ is percentage points against the baseline.

| Group (horizon)           |      n | Mean Δ | Median Δ | Above | Dates above | Matched mean Δ | Matched median Δ |
| ------------------------- | -----: | -----: | -------: | ----: | ----------: | -------------: | ---------------: |
| Top 5 (1 day)             |  3,995 |  −0.00 |    −0.17 | 46.3% |       50.4% |          −0.01 |            −0.05 |
| Top 5 (5 days)            |  3,975 |  +0.06 |    −0.26 | 47.4% |       51.8% |          −0.18 |            −0.35 |
| Top 5 (20 days)           |  3,900 |  +1.42 |    −1.51 | 43.9% |       51.4% |          +2.37 |            −0.69 |
| Rank quintile 1 (20 days) |  3,120 |  +1.87 |    −1.41 | 44.6% |       51.4% |          +2.82 |            −0.44 |
| Rank quintile 5 (20 days) |  3,900 |  +0.43 |    −3.52 | 37.6% |       44.0% |          +0.16 |            −2.75 |
| Risk warning (20 days)    | 15,311 |  +0.15 |    −2.73 | 38.0% |       44.7% |  +0.99 (2,851) |            −2.31 |
| Risk transition (20 days) |    124 |  −1.12 |    −2.24 | 38.7% |       39.1% |          −0.94 |            −1.69 |
| Long setup (all horizons) |      3 |      — |        — |     — |           — |              — |                — |

- **Long setup: insufficient evidence.** 3 asset-days in 801 days (1 transition), one pair, one
  quarter. Nothing can be read from them.
- **Ranking, 1 and 5 days: no difference.** Every rank group is within ±0.1 pp of the universe
  mean (±0.4 pp of same-tercile pairs), medians negative, fewer than half above.
- **Ranking, 20 days: a mean advantage the typical observation does not share.** Top 5 and
  quintile 1 beat the universe mean by +1.4 and +1.9 pp (+2.4 and +2.8 against same-tercile
  pairs), but their median difference is negative and fewer than half of their observations, and
  about half of the dates, are above. The quintiles are not monotonic (2 to 4 negative, 5
  positive). For the top 5, seven of ten quarters are positive, the largest in 2024-Q4; ten of 23 pairs
  have a positive mean difference and four a positive median; and, read from the per-pair table,
  one pair accounts for about half of the summed difference (58% against the universe, 48%
  matched). Quintile 1 looks the same.
- **Risk warnings** held on 86% of evaluated asset-days (ATR ≥ 4% of price is the usual crypto
  regime), so the label separates little: changes after a warning were close to the universe.
  Only 2,851 of 15,311 could be volatility-matched; the rest sat in terciles with no pair outside
  the warning. The 124–128 new warnings were followed by below-universe changes at every horizon.
  A decline after a warning is not profit; no short position is assumed.
- **Volatility.** The top 5 sit 57% in the quietest tercile and quintile 5 58% in the most
  volatile, as the model's design implies. The terciles themselves are not monotonic (20 days:
  +0.46, −1.38, +0.98 pp).

At 20 days the 780 overlapping dates hold about 39 non-overlapping windows, and 21–23 pairs move
together on each: the counts are not independent trials, and no significance is claimed. These
are price-change comparisons, not portfolio returns, win rates, Sharpe ratios or drawdowns.

### Conclusion: mixed

No 1- or 5-day information. At 20 days the top ranks' **mean** change was higher, against both
baselines, but the **typical** top-ranked observation did worse than the universe, the advantage
rests largely on one pair's large moves, and the rank order is not monotonic. Long setups were too
rare to judge. This history does not show that the current crypto ranking carries useful
information; it does not rule out a weak long-horizon effect concentrated in a few large moves.

**Next step, now frozen:** a prospective check of the 20-day top-5 comparison, below.

TradingView's terms as this repository reads them allow this as the owner's personal research;
product use of its results would need TradingView's written confirmation first
([feasibility](TRADINGVIEW_ONLY_FEASIBILITY.md#4-terms-by-use)).

### Policy note

At a cutoff of exactly D's close, `tradingview-crypto-daily-v1`'s 24h freshness bound also admits
a pair whose latest candle is D−1 (exactly 24h old); fixtures pin this. The export has no missing
day, so it never applied here. A live retrieval's mid-day cutoff does not reach that boundary.

### Prospective follow-up (frozen, not yet collected)

[`scanner-research-crypto-prospective.v1.json`](scanner-research-crypto-prospective.v1.json)
(ID `45a43d5c6390f4ce6437c24cdfdc3adc817617e3634f1c24b3e8454951a268fa`) was frozen in commit
`fab48a3` (2026-11-11 20:37:21Z, pushed at once), before any day of its period had begun. A test
keeps the JSON and code identical, and any change to the model, scanner, policy, thresholds or
universe constants changes its ID.

**Where the hypothesis came from.** The 20-day horizon and the top-5 comparison were chosen
**after** seeing the retrospective results above, from 3 horizons and 15 groups, because that is
where a positive mean difference appeared. This is a future confirmation attempt of a selected
hypothesis, not an independently preselected finding; the retrospective figures are not evidence
for it.

- **One comparison.** Top 5 ranked pairs against the same-date equal-weight mean of evaluated
  pairs, 20 UTC days. Per scored day, Δ = top-5 mean change − universe mean change; the primary
  statistic M is the mean of Δ over days, each day once. No other horizon, group, baseline or
  threshold is analysed under it. Model, thresholds, `crypto-usdt-v1` and
  `tradingview-crypto-daily-v1` unchanged.
- **Timing.** The decision cutoff is the scan's own frozen cutoff, its retrieval start R. The
  scored day D is the UTC day before R's day. The reference is the OPEN of the first bar opening
  strictly after R, at D+2 00:00 UTC; the endpoint the OPEN 20 days later, D+22. That is one day
  later than the retrospective study's D+1 open, so that no part of the outcome window precedes
  the recorded scan.
- **Period.** Scored days **2026-11-12 to 2027-11-11** (365), from retrievals on 2026-11-13 to
  2027-11-12. Every scored day up to 2026-11-11 is excluded: their outcomes were inspected
  (through 2026-11-08), or they were scored or partly retrieved before the freeze. The last
  endpoint bar is 2027-12-03; the one analysis runs no earlier than **2027-12-04 00:00 UTC**.
  Until then only collection status is checked, never an outcome.
- **Coverage and missing data.** At least 15 of 25 pairs evaluated in the recorded scan. No
  substitution; a pair that stops trading has a MISSING outcome, counted and listed. A day with
  fewer than 3 measurable top-5 outcomes has no Δ. GRAM and HYPE become rankable during the period
  and are ranked as the scanner ranks them.
- **Overlap and correlation.** Δ is one value per day, so correlated pairs are never separate
  trials. Days are split into 21 phase series (days since 2026-11-12, mod 21), within which
  20-day windows never share a bar; M is reported per series. No p-value or confidence interval.
- **Planned reading**, every outcome reported with the same prominence:
  - **SUPPORTED** only if M > 0, the median Δ > 0, M stays > 0 without the pair contributing most,
    M > 0 in at least 11 of 21 phase series, and at most 2% of top-5 outcomes are MISSING.
  - **NOT_SUPPORTED** if M ≤ 0.
  - **INCONCLUSIVE** if M > 0 but another condition fails.
  - **INSUFFICIENT_COLLECTION** if fewer than 240 prospective days (or fewer than 8 in any phase
    series) qualify.

  Even SUPPORTED means only that a price-change association recurred: not a net trading return,
  not proof of profitability.

### Prospective versus reconstructed

- **PROSPECTIVE:** a `crypto-usdt-v1` scan snapshot from an owner-initiated retrieval, saved
  (`completedAt`) **before its reference bar opened**, under the unchanged versions and
  membership, reproducing offline. Its recorded ranks are the observation.
- **RECONSTRUCTED:** a day in the period without such a snapshot, replayed later from the outcome
  retrieval. Labeled, reported in a separate table, never pooled with PROSPECTIVE and never
  counted toward the minimum or the classification.
- A snapshot saved at or after its reference bar opened, under another version, or that does not
  reproduce is not prospective, whatever its contents. Nothing recorded later is ever moved into
  PROSPECTIVE. `classifyRecordedScan` (`scripts/scannerResearchCryptoProspective.ts`) encodes
  these rules and its tests pin the UTC boundaries; the analysis itself is not written yet and
  must be committed before the outcome retrieval.

### Collection requirement

The specification collects nothing. Each prospective day needs the owner, in an agent session
with TradingView's MCP server, to run the [crypto scan](TRADINGVIEW_CRYPTO_SCAN.md#running-it)
(`tradingview-start --universe crypto-usdt-v1`, capture, `tradingview-finish`) on the day after
the scored day, **finished before the next UTC midnight**, and to keep the snapshot in the
git-ignored `.zerochart-scans`. The minimum is 240 of the 365 days, so about two days in three, on
days chosen without regard to the market. No scheduler or campaign is added. Snapshot timestamps
are the owner's own machine's, not an independent attestation. Then one outcome retrieval on or
after 2027-12-04.

Open blockers: no prospective day exists yet (the first possible retrieval is 2026-11-13 UTC);
collection depends entirely on manual daily runs for a year; the analysis code is unwritten;
`.zerochart-scans` is local and has no backup; and TradingView's confirmation would be needed
before any product use.
