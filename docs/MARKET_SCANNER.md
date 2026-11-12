# Market scanner

The scanner runs the canonical model (`src/lib/canonicalModel.ts`, model `1.0.0`) over every
asset in the Markets universe, ranks what it could score, flags the model's setup conditions, and
reports everything it could not score with the reason. It never places, sizes or proposes an order.

Code: `src/lib/marketScanner.ts` (pure engine), `src/lib/usEquityDaily.ts` (equity calendar,
candle policy and provider seam), `src/hooks/useMarketScan.ts` (Markets page),
`src/components/MarketScanSummary.tsx`, `src/components/ScanReview.tsx` and `src/lib/scanReview.ts`
(reviewing a scan), `scripts/marketScanStore.ts` (CLI evidence).

Equities and ETFs: see [EQUITY_DATA.md](EQUITY_DATA.md) for the provider decision, the
`us-equity-daily-v1` contract and what it takes to switch them on.

## Coverage: displayed versus evaluated

The universe is the `assets_status` table: 100 rows on 2026-10-28. Before this change the Markets
page displayed all 100 but the canonical model only ran on the 5 crypto rows. The 95 others showed
"No data", which read like a short history rather than "never evaluated".

| Asset class                | Configured | Price source (cadence)                                                      | Daily candles                                                                                                         | Canonical model runs?        | Freshness                                                                                                                         | Unsupported / failure behavior                                                                                                                                                          |
| -------------------------- | ---------: | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crypto (`BTC-USD` …)       |          5 | `crypto-price-feed`: Binance 24h ticker, every 15 min; live WebSocket ticks | Binance spot klines, 1d, last 200 (browser and CLI); `binance-daily-v1` validation                                    | **Yes**: scored and ranked   | Closed candles only; latest close must be ≤ 48h old. Prices go Stale after 2h                                                     | Before: a fetch failure became `INSUFFICIENT_DATA`. Now: `FETCH_FAILED`, `RATE_LIMITED`, `DATA_INVALID`, `STALE_DATA` or `INSUFFICIENT_HISTORY`, and the scan reports itself incomplete |
| Equities and ETFs (`AAPL`) |         90 | `equity-forex-price-feed`: Yahoo spark, every 15 min                        | None licensed. The scanner accepts a server-side `EquityDailyProvider` under `us-equity-daily-v1`; none is configured | **No** (fixture-tested only) | Sessions, not hours: latest final session or the one before ([contract](EQUITY_DATA.md#3-the-us-equity-daily-v1-candle-contract)) | `UNSUPPORTED`, "Not scanned", with the reason: no licensed provider is configured                                                                                                       |
| Forex (`EURUSD=X`)         |          5 | Same Yahoo feed                                                             | Same as equities; no volume                                                                                           | **No**                       | As equities                                                                                                                       | As equities                                                                                                                                                                             |

`market-analytics` is not the canonical model. It writes RSI(14), ATR(14), SMA 50/200, a volume
spike and the archived scanner's Stable/Radar signals. It has no MACD, no factor scores and no
regime, and it scores open-market bars by a different rule. Its output stays a separate, displayed
field.

## Cohorts and inclusion rules

Each asset class is a separate cohort with its own provider, candle policy, coverage and ranking
(`scan.cohorts`). Live today: **crypto spot on Binance, 1D, UTC days**, all 5 crypto rows. US
equities and ETFs (1D, New York sessions) run only through an injected licensed provider, and none
is configured, so they are `UNSUPPORTED` like forex. Scanner version `market-scan-v2`.

A crypto asset is ranked only if all of these hold on the scan (the equity rules are in
[EQUITY_DATA.md](EQUITY_DATA.md#3-the-us-equity-daily-v1-candle-contract)):

1. **Instrument identity.** The ticker classifies as crypto (`classifyTicker`) and maps to a Binance
   USDT spot pair. Each result names it, e.g. `BTC-USD → BINANCE:BTCUSDT`. The quote is USDT, not
   USD.
2. **Closed candles only.** The scan's evaluation time is taken before the first request. A candle
   counts only if its close (open + 86,399,999 ms) is at or before that time, so a candle that
   closes mid-scan stays open.
3. **Valid candles.** The `binance-daily-v1` policy passes (`src/lib/candleValidation.ts`): no
   repair, deduplication or fill.
4. **Fresh data.** The latest closed candle closed at most 48h before the scan, the bound
   `scoreTicker` and the evaluation lab already use. A halted or delisted market fails here or at
   fetch time.
5. **Full window.** At least 199 closed candles: the 200-candle request every score in the app
   makes, minus today's open candle. A younger listing is reported, not ranked, so every ranked
   score is smoothed over the same history.

There is **no liquidity filter**. Klines carry volume, but no repository policy defines a minimum,
so none is invented.

Scores from different asset classes or timeframes are never ranked together: ranks restart at 1
in each cohort, and the Markets "Signals" sort lists each class's ranking in turn.

## Ranking, setups and eligibility are separate

- **Rank**: within the asset class, score descending, then ticker in code-unit order. The same
  inputs always give the same order.
- **Setup conditions** (`modelSetups` in `canonicalModel.ts`) are the Pine HUD's own, on the last
  closed bar:
  - _Long setup_ (`ZC LONG`): score ≥ 78 and MACD momentum ≥ +0.05% of price.
  - _Risk setup_ (`ZC RISK`): score ≤ 28, or a high-volatility regime.

  Both can hold at once. Pine alerts only on the bar a condition turns true, so a scan reports a
  standing condition, not a fresh signal.

- **Risk-profile fit**: `qualifiesForRiskProfile` for conservative, moderate and aggressive.

A high score is not a buy signal, and none of these is a valuation claim. No threshold was changed.

## Roles

| Role                    | Who                                                                                                                                                    | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Market-data provider    | Binance public REST (`/api/v3/klines`)                                                                                                                 | Supplies raw daily candles. Keyless, documented weights (a 200-candle request weighs 2), CORS-enabled, already the app's candle source                                                                                                                                                                                                                                                                                                                |
| Scoring/scanning engine | ZeroChart: `marketScanner.ts` over `canonicalModel.ts`                                                                                                 | Validates, scores, ranks, flags setups, reports coverage                                                                                                                                                                                                                                                                                                                                                                                              |
| TradingView             | Chart widget; Pine HUD with per-chart alerts → `tv-webhook` → `trading_signals`; TradingView's hosted MCP server, used from the owner's agent sessions | One alert watches one symbol on one timeframe (today: `BINANCE:BTCUSDT` 1D). It does not scan a market. The screener and technicals tools return RSI, MACD and ATR% for the **unclosed** bar, smoothed over full history, plus TradingView's own "Recommend" rating. They are useful for cross-checks, but they are not the canonical model and not a licensed product data feed ([TRADINGVIEW_ONLY_FEASIBILITY.md](TRADINGVIEW_ONLY_FEASIBILITY.md)) |
| Decision                | The user                                                                                                                                               | Reads the ranking and reasons and decides. The scan offers no action                                                                                                                                                                                                                                                                                                                                                                                  |

Scan snapshots, scheduled-score campaigns (`.zerochart-campaigns/`) and received TradingView alerts
(`trading_signals`) are three separate evidence types. The scanner writes to none of the other two.

## Running a scan

The Markets page scans on load, every 15 minutes, and when the page regains focus after 5 minutes.
The engine runs in the finance Web Worker, with at most 4 requests in flight per provider. After a
429 or 418, nothing else is requested from that provider that scan; its remaining assets are
recorded as `RATE_LIMITED`. Other providers carry on. The browser never has an equity provider:
its credential could only live server-side.

From the command line (read-only: a public `assets_status` read and public Binance klines):

```bash
npx tsx --env-file=.env scripts/evaluate-canonical.ts scan
npm run evaluate -- scan-reproduce <SCAN_ID>
```

`scan` writes `.zerochart-scans/<SCAN_ID>.json` (git-ignored, never overwritten) and prints the
ranking, setups and every unevaluated asset. It exits non-zero unless the scan is `COMPLETE`.

A snapshot holds:

- the universe members and their hash;
- each cohort's provider, candle policy, calendar, freshness rule and coverage;
- every asset's raw candles (or equity series with its session range, fetch time and cache flag)
  or recorded failure, each with its own hash;
- the scan time;
- the scanner, model and candle-policy versions;
- the repository commit (suffixed `-dirty` for uncommitted code).

`scan-reproduce` re-derives the scan offline from those inputs, without any provider, and
compares every output: `MATCH`, or `MISMATCH` with `UNIVERSE_HASH_MISMATCH`,
`INPUT_HASH_MISMATCH`, `OUTPUT_MISMATCH` or `UNSUPPORTED_VERSION`. Snapshots written by
`market-scan-v1` report `UNSUPPORTED_VERSION`.

Scan status is `COMPLETE` only when every supported asset was scored, `PARTIAL` when some were, and
`FAILED` when none were. Each cohort has its own status too. "No qualifying setups" is stated as a
full answer only for a complete cohort.

## Reviewing a scan

Research has two places: **Scan** (the default) and **Markets directory**. The directory holds the
price table (asset details, an alert button and a broker link per row), the price alerts panel and
Build Portfolio, so it never reads as a second scanner. Both stay mounted, so moving between them keeps the scan's
filters, selection and comparison. The scan offers no order, broker or paper-trading action; those
stay in the directory and on the Paper Desk.

Each scan (the live Market scan and the TradingView development scan) heads with its source,
timeframe, data as of (with freshness and any cache age) and coverage, stated once for the scan. A
cohort repeats its own status and data time only when a scan has more than one; the coverage
breakdown by class appears only then too. The results come in three views: **Long setups** (ZC LONG
holds), **Risk warnings** (ZC RISK holds) and **All ranked** (every evaluated asset by rank; most meet
no setup). A Risk warning names the clause that holds it, the same on its tag and in the row's
accessible name: **Risk: high volatility** (the high-volatility regime, ATR ≥ 4% of price),
**Risk: low score** (score ≤ 28) or both. The Risk warnings view is every asset where either holds. Both open on **All ranked**, so zero long setups is a normal result, not an empty screen.
Each row shows rank, asset, score, setup and a short reason: the recorded clauses that decide its
setup state ("Score 61, needs ≥ 78" for an asset short of ZC LONG), from the same `explainResult`
the evidence uses. A search box (ticker, instrument or requested symbol) and filters on recorded
fields narrow them: regime, the model's own momentum bias (±0.05% of price is flat) and risk-profile
fit. "No setups" is a full answer only for a complete cohort; an empty filter result says how many
it hid. The header says whether the data still passes the scan's own freshness rule now: crypto's
latest close within 48h, equities' latest final session or the one before. Past that the data is
marked **Stale**. A scan is never called live.

Selecting a row opens its evidence. From 1024px wide it sits beside the list and keeps its own
scroll, so the list, its filters and the page stay put; Up and Down move between rows. Narrower, it
opens as a modal sheet, and closing the sheet returns focus to the selected row. The side panel
leaves out the scan's source, model and scored time, which the header already shows; the sheet,
which covers the header, keeps them.

The evidence is one asset's explanation, derived only from its recorded values
(`explainResult`): each ZC LONG and ZC RISK clause with the recorded value against the threshold,
RSI(14), MACD histogram / price, ATR(14) / price, the factor scores and weights, and the regime with
the first-match rule that chose it. Supports and weakens weigh each factor against the setup in
focus: its weight × its component's distance from the threshold (78 for ZC LONG, 28 for ZC RISK).
The three sum to the unrounded score's margin. A risk warning held by the high-volatility regime
alone lists the regime, not factor points. Source, timeframe, model, scanner and candle-policy
versions, last evaluated session, window and fetch time follow, then the limitations that apply:
historical import, split-only adjustment, equities unvalidated, the 199/200-bar window, no
liquidity filter, an incomplete scan, stale data, and what is known about a TradingView alert. A
field the scan did not record reads "Not recorded". Nothing is generated, and no confidence is
invented.

**Compare**, a checkbox at the end of each row, puts up to three assets of one cohort side by side: rank, score, regime, each setup
condition, the three readings with their factor scores and weights, risk-profile fit, last evaluated
session, window and fetch time. Assets from different asset classes cannot be selected together.

Neither view offers an order, a size or a broker link.

## Evaluating the scanner

One scan proves nothing about quality. A future evaluation has to cover every scanned asset, not
only the ones that met a setup: what each scored, and what happened to it afterwards. It also has
to count incomplete scans. The snapshots keep that whole population.

## Remaining gaps

- **Equities and ETFs (90 of 100)** need a provider licensed for display in this app, one adapter
  and a server-side scheduled scan ([EQUITY_DATA.md](EQUITY_DATA.md#integration-prerequisite)).
  The session policy, separate ranking and evidence are done. Whether the model's volatility bands
  (0.5%–5.5% daily ATR) suit single stocks and ETFs is unvalidated; that is why they rank apart.
- **Forex (5 of 100)** needs a licensed source and a 24/5 session policy of its own.
- Snapshots are local files. A server-side scheduled scan with stored history would need a table
  and a migration.
- `useCanonicalScores` (Tactical Signals, the asset details modal, the Paper Desk) still turns
  "no candle source" into `INSUFFICIENT_DATA` ("Not enough data") for equities and forex.
- App scores use 199 closed candles. Pine `1.0.0-pw200` sees 200 at a bar close, so the windows
  differ by one candle (see `docs/PINE_PARITY_ASSESSMENT.md`).

## TradingView development scan (local, owner-initiated)

A local demonstration: US equities and ETFs scored by this scanner on daily bars that the owner's
agent session retrieved through TradingView's MCP server. By default a retrieval requests the fixed
50-member universe; `tradingview-start --universe all` opts in to all 90 configured US equities and
ETFs ([Two universes](#two-universes)), and `--universe crypto-usdt-v1` to 25 Binance Spot USDT pairs,
ranked only among themselves under their own candle contract
([TradingView crypto scan](TRADINGVIEW_CRYPTO_SCAN.md)). Under `vite dev` only, the Scan
place has a source selector: **Market data** (the Market scan) or **TradingView import**, which
replaces it with the **TradingView development scan**. The Markets directory always shows market
data. The selector sits above the market-data loading and error states, so the import shows even
while live market data is loading or has failed. The selector
names the import's state (evaluated count, `Loading`, `Reloading`, `None`, `Unreadable`, or
`Failed` when a reload failed and the earlier scan is still shown). It does not change
live coverage: every live scan still reports equities as `UNSUPPORTED`.

| Step                    | Who                      | How                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose the universe     | Code, before any data    | Default: `selectDevScanUniverse`, the 50 of the 90 configured equities with the lowest `sha256(ticker)`. Opt-in (`--universe all`): all 90. `tradingview-start` freezes the choice and its exact symbols                                                    |
| Resolve instruments     | Agent (`search_symbols`) | One listing per ticker on a US primary venue (NASDAQ, NYSE, AMEX = NYSE Arca, CBOE); committed as `TRADINGVIEW_SYMBOLS` (the 50 on 2026-10-29, the other 40 on 2026-11-08). Off-exchange, CFD and foreign listings excluded                                 |
| Retrieve bars           | Agent (`get_ohlcv`)      | 1D, `count` 1000 per symbol, signed in as the owner (OAuth), well under ~100 calls/min. `tradingview-capture` binds each saved response to its symbol in git-ignored `.zerochart-tradingview/`                                                              |
| Check alerts            | Agent (`list_alerts`)    | Records which symbols hold any TradingView alert, so the panel can say whether Pine emitted anything                                                                                                                                                        |
| Validate, score, record | App (CLI)                | `tradingview-finish` (or `tradingview-import` for a hand-built export): `us-equity-daily-v1`, canonical `1.0.0`, the last 199 final sessions; writes `.zerochart-scans/<SCAN_ID>.json` (reproducible with `scan-reproduce`) and `tradingview-dev-scan.json` |
| Display                 | App (dev server)         | `scripts/tradingViewDevRoute.ts`, a `vite dev`-only plugin, serves that file at `/__zerochart/tradingview-dev-scan`, and each saved snapshot after it reproduces ([Saved scans](#saved-scans)), to this machine only; production builds have no such route  |
| Decide                  | The owner                | Nothing in the panel is an action                                                                                                                                                                                                                           |

### Refreshing it (owner runbook)

**Reload local scan**, above the TradingView review, re-reads the published
`tradingview-dev-scan.json` through the dev route without reloading the page; so does reloading the
page. Neither fetches TradingView bars, calls an agent or starts a scan, and nothing re-reads or
re-scans on a schedule. While the review is open, the header's market-data refresh is hidden.

- **Loaded, missing or unreadable:** the button is there in every state. A click during a read joins
  that read. The line beside it names the scan shown and when the file was last read (UTC).
- **A different scan:** the selector, scan metadata, results, evidence and "Changes since previous
  scan" all switch to it together, and the review starts over: no selection, Compare or open
  evidence carries across. An identical file keeps the review as it was.
- **Failed reload** (server down, HTTP error, malformed or truncated file): the earlier scan stays
  on screen under an alert naming it and saying it may not be the published scan; the selector
  says `Failed`. A removed file shows the "no scan published" state instead of the earlier scan. The agent's TradingView MCP session is the owner's, signed in with the
  owner's account; it is not a backend connection the app can call. To start a new scan, the owner
  pastes this prompt into an agent session that has TradingView's MCP server connected, opened in this
  repository:

```text
Run Popup's TradingView development scan. You retrieve; the repository's helper binds, imports
and reproduces. Local only: never commit, publish or send anything you retrieve.

1. Run `npm run evaluate -- tradingview-start` (the default 50), or
   `npm run evaluate -- tradingview-start --universe all` only when the owner asked for all 90, or
   `npm run evaluate -- tradingview-start --universe crypto-usdt-v1` only when the owner asked for
   the crypto scan.
   Note RETRIEVAL_ID, universe, validUntil and the symbols under `retry`. If validUntil is less
   than 15 minutes away, stop and start again after it.
2. For each symbol under `retry`, call TradingView `get_ohlcv` with exactly that symbol,
   interval "1D", count 1000, in batches of at most 8 calls (well under 100 a minute).
3. After each batch run
   `npm run evaluate -- tradingview-capture RETRIEVAL_ID SYMBOL=PATH SYMBOL=PATH ...`,
   pairing each symbol with the file its own call's result was saved to. Never retype, edit or
   merge response data. For a call that returned an error, run
   `npm run evaluate -- tradingview-fail RETRIEVAL_ID SYMBOL "<the error>"`. A short result (a
   young crypto listing) may be shown inline instead of saved to a file: copy it byte for byte
   from your client's own record of that call, with that record's time as the file's modification
   time, and capture that file; if you cannot, record it with `tradingview-fail` and say so.
4. Repeat steps 2-3 for the symbols the last capture lists under `retry`, at most three rounds,
   while `window` is OPEN. Never substitute another symbol, venue, provider or remembered value.
5. Call TradingView `list_alerts` once (read only), then run
   `npm run evaluate -- tradingview-capture RETRIEVAL_ID --alerts <symbols holding any alert, comma-separated, or none>`.
6. Run `npm run evaluate -- tradingview-finish RETRIEVAL_ID`. Report its outcome, the requested,
   evaluated and failed counts, every failure with its reason, universe, evaluatedSession, scanId,
   reproduction, viewStatus and preservedView. Only outcome COMPLETE with reproduction MATCH is a full success;
   state PARTIAL, REFUSED or NOT_REPRODUCED plainly (a crypto scan stays PARTIAL, and the command
   exits non-zero, while a member has fewer than 199 closed UTC days). From `baseline`, report status, chosenBy,
   before.scanId with before.session and after.session, the Long, Risk and score counts, reason,
   and every entry under skipped with its reason.
7. If viewStatus is PUBLISHED, run `npm run dev`, open http://localhost:8080/?devAuth=1, go to
   Research, choose TradingView import, and check that its retrieval window, counts and
   "Changes since previous scan" match the report.
```

What the helper (`scripts/tradingViewImport.ts`) does at each step:

- **`tradingview-start`** takes the retrieval start before anything is fetched, creates
  `.zerochart-tradingview/<RETRIEVAL_ID>/` and prints the required session and `validUntil`, the
  moment the next session becomes final. Its `retrieval.json` records the universe and the exact
  symbol of every member. Every later step requests, binds and scores exactly those, and refuses
  the retrieval if today's definition of that universe differs. A retrieval started before
  universes existed records neither and is the default 50.
- **`tradingview-capture`** binds each saved result to the symbol it was requested for. Claude
  Code names a saved tool result by the millisecond, and parallel calls can land on one name and
  overwrite each other, so a file name is never trusted. The response's own `symbol` and
  `interval` must match the request, and the file must have been written after the start; its
  modification time becomes `receivedAt`. A file holding another symbol's response is `REJECTED`
  and that symbol stays under `retry`. An identical second copy is a `DUPLICATE`. A different
  successful response for a symbol already captured is a `CONFLICT`: that symbol fails instead of
  one response being chosen. A later success replaces a recorded failure (`RETRIED`); a later
  failure never replaces a success.
- **`retry`** lists missing and failed symbols only while the window is open. Once another session
  has become final it is empty: the import refuses a retrieval that crossed the boundary, as before,
  and a new start is needed.
- **`tradingview-finish`** writes the export `.zerochart-tradingview/<RETRIEVAL_ID>.json` from the
  captured files (`completedAt` is the latest `receivedAt`), records the scan as
  `tradingview-import` does and reproduces it offline as `scan-reproduce` does. Only after `MATCH`
  does it choose the baseline for
  [Changes since previous scan](#changes-since-previous-scan) and publish the view
  (`viewStatus: PUBLISHED`). A refused or unreproduced scan leaves the last published Research
  view as it was (`UNCHANGED`). It exits non-zero unless the outcome is `COMPLETE` with `MATCH`;
  a missing baseline is reported, not a failure. Running it again on the same captures prints
  `ALREADY_IMPORTED` and leaves the export, the baseline and the view byte-identical. Before a
  view of one universe replaces a view of the other, the replaced view is copied beside it
  (`preservedView`, below).

The helper never calls TradingView, holds no credential and runs nothing unattended. A hand-built
export still imports with `npm run evaluate -- tradingview-import EXPORT.json`, followed by
`scan-reproduce`.

Importing the same export again prints `ALREADY_IMPORTED` / `REUSED` and leaves the view
byte-identical. An earlier export is a historical scan, not a refresh.

The section heads with its source (`TradingView MCP get_ohlcv`), retrieval window, latest evaluated
session, requested, evaluated and failed counts, and says that reloading does not fetch bars. It is
marked **Stale** once two newer sessions are final. Before an import exists it says so; while the
file loads, and when it cannot be read, it says that too. It opens on **All ranked**, every evaluated
asset by its recorded rank, so zero long setups still leaves all of them to review; the top rank is
not relabeled a recommendation. The Market scan names its own source (`Binance spot klines`). Only
one source shows at a time: the import view has no price table, asset count, Build Portfolio or
asset details sheet, and its evidence and Compare read the import alone, so reviewing it requests nothing
from Binance or any other provider (the page's own price feeds keep running in the background). Switching
sources discards the other's view, filters, comparison and open explanation.

### Two universes

| Universe                      | Command                                       | Members                                                        | Selection rule shown in Research           |
| ----------------------------- | --------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| `default` (50)                | `tradingview-start`                           | The 50 configured tickers with the lowest `sha256(ticker)`     | "The 50 configured US equities and ETFs …" |
| `all` (90, opt-in)            | `tradingview-start --universe all`            | Every ticker in `US_EQUITY_INSTRUMENTS`: 71 stocks and 19 ETFs | "All 90 configured US equities and ETFs …" |
| `crypto-usdt-v1` (25, opt-in) | `tradingview-start --universe crypto-usdt-v1` | 25 Binance Spot USDT pairs, frozen 2026-11-11                  | "crypto-usdt-v1: the first 25 coins …"     |

Neither universe depends on a score or an outcome. Both use the same exact symbols for the 50 they
share, so the default retrieval requests exactly what it did before. Each import records its
members in the snapshot, so the universe hash and the scan ID tell the two apart, and an export of
the full universe says `"universe": "all"` (a default export has no such field and stays
byte-identical to earlier ones).

**Ranks are per universe.** A ticker ranked among 90 can sit lower than it did among 50 with the
same score, so a 90-member scan is never compared with a 50-member one, in either direction:

- `tradingview-finish` passes over every import of the other universe with
  `not comparable: Universe 50 tickers, … → 90 tickers, …`, also when it rests on the same
  session.
- `tradingview-baseline` with an import of the other universe attaches it only to show
  **Not comparable** with the universe as the difference; no score, setup or rank change is shown.

**Moving between the two published views.** To look at the other universe without changing what
is published, choose it under **Scan shown** ([Saved scans](#saved-scans)). Research publishes one
view at a time (`tradingview-dev-scan.json`). When a finish or import publishes a view of the other universe, it
first copies the published one, named baseline included, to
`.zerochart-scans/tradingview-dev-scan.<scanId>.<sha256 prefix>.json` and reports the path as
`preservedView`. To go back, copy that file over the published one and press
**Reload local scan**:

```sh
cp .zerochart-scans/tradingview-dev-scan.<scanId>.<prefix>.json .zerochart-scans/tradingview-dev-scan.json
```

Finishing the next default retrieval also publishes a 50-member view (and preserves the 90-member
one the same way). Snapshots are never touched by either: both universes stay in the scan store and
reproduce as before.

### Saved scans

Under `vite dev`, **Scan shown** above the TradingView review chooses what it shows: **Latest
published scan** (`tradingview-dev-scan.json`, as before) or one TradingView snapshot saved in
`.zerochart-scans/`. The list names each by scan ID, evaluated session, universe size and coverage,
newest first, and marks `legacy` (recorded before exact symbols) and `published` (the published
view's scan). The review header says **Latest published scan** or **Saved scan, not the published
view**. Selecting a scan copies, publishes and replaces nothing: snapshots and the published view
stay byte-identical. The source selector's count stays the published import's.

- **Verified before it is shown.** On each selection and each **Reload saved scan**, the dev server
  reads the snapshot and reproduces it offline from its own inputs, as `scan-reproduce` does. Only a
  scan that reproduces shows results. Otherwise the review names the scan and its state, and shows
  nothing from it:

  | State                              | When                                                                     |
  | ---------------------------------- | ------------------------------------------------------------------------ |
  | Malformed                          | Not JSON, required fields missing, or another scan ID inside             |
  | Cannot be checked by this checkout | Another snapshot schema, scanner version or model version                |
  | Does not reproduce                 | Its inputs, universe, evaluation time or outputs do not re-derive (code) |
  | No longer in the scan store        | Removed since it was listed, or not a TradingView snapshot               |

  A snapshot-named file that is not JSON is not listed; the selector says how many there are.

- **Only what was recorded.** Source notes and "Changes since previous scan" come from a published
  or preserved view of exactly that scan (same scan ID, identical results). Without one, only the
  snapshot is shown: the retrieval window, TradingView's notice, the selection rule and the alert
  check read as not recorded, the symbols are those its inputs recorded (none for a legacy scan), and
  no baseline is chosen after the fact. A recorded baseline is kept only while its own snapshot is
  unchanged and reproduces; otherwise the view says why nothing is compared. Nothing is filled in
  from today's instrument map.
- **Reload stays on the selection.** With a saved scan selected, the button reads **Reload saved
  scan**. It re-reads and re-checks that scan and the list, never the published view. A scan that
  disappeared stays selected, marked "not in the scan store", until the owner picks another.
- **Changing the scan** starts the review over: no selection, Compare or open evidence carries
  across. Comparison rules and source isolation are unchanged. Switching to Market data and back
  returns to the latest published scan. So does a reload that brings different content, even
  under the same scan ID; an unchanged file keeps the review.
- **A full page reload** restores the source and **Scan shown** chosen in that browser tab, and
  reads the scan again: a saved scan by its ID, **Latest published scan** as whatever is published
  now. The tab's `sessionStorage` holds only the source and a scan ID, under `vite dev` only; a new
  tab opens on Market data. Selection, Compare, open evidence and Manual Spot inputs are not kept.
  A restored scan that is missing, unreadable, refused or not a scan ID says so, shows nothing
  from it and offers **Show the latest published scan**; Research never falls back to Market data
  or another scan by itself.
- **Access.** `/__zerochart/tradingview-saved-scans` lists and `/<scanId>` reads one. Only a scan
  ID (`YYYYMMDDTHHMMSSZ-xxxxxxxx`) is accepted, never a path. Files are read directly in the store
  and a symbolic link reads as absent. A read returns results, never candles. Like the published
  route, it answers only this machine's loopback addresses, and only for a loopback `Host`
  (`localhost`, `127.0.0.1`, `[::1]`), so a page that re-points its own name at this machine is
  refused. Neither route exists in a production build.

### Changes since previous scan

Above the ranked list, the TradingView review compares the displayed import with one earlier import
from `.zerochart-scans/`. `tradingview-finish` chooses it, after the displayed scan reproduces:

1. Candidates are the other TradingView imports of the same asset class in the scan store. A
   Market data snapshot is never one and is not listed, and neither is an import of the other
   asset class (crypto against equities).
2. They are ranked by evaluated session, latest first, then by evaluation time (the later revision
   of a session first), then by scan ID.
3. The first one that comes from a strictly earlier session, is comparable (below) and reproduces
   (`MATCH`) is the baseline. Reproduction runs only on that path, newest first, and stops at the
   first match.
4. Every import ranked above it is listed under `skipped` with its reason: a revision of the
   displayed session (never chosen automatically), a later session, no evaluated session, not
   comparable (what differs) or does not reproduce (why). A snapshot file that cannot be read is
   listed too.

With no usable baseline the verified scan is still published, and the view and the report give the
`reason` nothing is compared. The report's `baseline` gives `chosenBy`, the baseline as `before`
(scan ID and evaluated session), the displayed scan as `after`, the session gap and the counts the
view shows.

The owner can name another baseline, a same-session revision included:

```sh
npm run evaluate -- tradingview-baseline SCAN_ID
```

The command checks that the view is the stored snapshot it names and that it reproduces. It
refuses the displayed scan itself and any snapshot that is not a TradingView import, so the Market
scan is never compared with one. A comparable baseline is written into `tradingview-dev-scan.json`
only once it reproduces too, and the command prints the counts the view shows. Finishing the same
retrieval again keeps a named baseline while it still passes those checks; if it no longer does,
finish says why under `skipped` and chooses again. A new scan starts a new choice: a named baseline
belongs to the scan it was named for. `tradingview-import` publishes without a baseline.

- **Comparable** means the same source, timeframe, universe members ([Two universes](#two-universes)), recorded instrument and exact
  TradingView symbol per ticker, scanner and model versions, and candle policy, with the baseline
  evaluated first. Otherwise the view says
  **Not comparable**, lists what differs and shows no change. Such a baseline is attached without
  reproduction, since none of its results is shown.
- **Shown:** each scan's evaluated session and coverage; how many Long setups and Risk warnings
  appeared, cleared or held; scores as before → after, described, not graded; and the assets whose
  setups moved. Selecting one opens its evidence.
- **Partial coverage:** an asset evaluated in only one scan is listed apart and never counts as a
  setup that appeared or cleared.
- **Sessions:** two imports of the same session are a revision of its data, not a new session.
  Sessions between the two that were never evaluated are named: a change could have happened on any
  of them, so this is two readings, not a timed transition, and never an alert.
- **Identity:** the ticker is the display name and `US:<ticker>` the generic instrument; neither
  tells two listings apart. Each input records `providerSymbol`: the exact exchange-qualified symbol
  requested (`NASDAQ:AAPL`) and, only when TradingView's response was accepted as that ticker's
  series, the symbol the response named. It is part of the input, so the input hash covers it, and
  each result carries a copy, so reproduction re-derives it. Nothing requested, nothing recorded.
  - A ticker requested on a different symbol in the two scans is **Not comparable**
    (`TradingView symbol`), whatever its status: another listing is never an appeared or cleared
    setup.
  - Every asset evaluated in both must carry the same requested symbol, confirmed by the response,
    on both sides. Otherwise the pair is **Not comparable** (`Exact symbol`), naming the tickers.
  - **Legacy evidence is refused, not presented as limited.** Snapshots recorded before exact
    symbols were kept (every TradingView import up to 2026-11-07) still reproduce and still display,
    but they cannot be a baseline, and they are never matched up through today's instrument map:
    `tradingview-finish` passes them over and `tradingview-baseline` attaches them only to say why.
    Their evidence panel says the symbol is not recorded; the list the view wrote at import is named
    as unverified. Nothing rewrites them: importing a legacy export again is refused as a
    `PROVENANCE` conflict. The first comparison is therefore between two imports made with this
    format, on different sessions.
  - Hashes show the evidence is consistent with itself, not who wrote it. Removing every symbol and
    recomputing the hashes leaves a snapshot that reads as legacy, which is refused.

The export file (`scripts/tradingViewImport.ts`, `TradingViewOhlcvExport`) holds `retrieval.startedAt`
and `completedAt`, the alert check, and one entry per ticker: `symbol`, `receivedAt` and the response,
or the error the agent got. A selected ticker missing from the file is reported as `FETCH_FAILED`;
one outside the selection makes the import fail.

Conventions observed on 2026-10-29 and enforced by the import:

- A daily bar's `t` is its session's 09:30 New York open in Unix seconds (13:30 UTC in EDT, 14:30 in
  EST). Any other stamp is `DATA_INVALID`, never re-dated.
- TradingView's notice says "regular session only; prices are split-adjusted only", which is
  `us-equity-daily-v1`'s `SPLIT` basis. Without that notice the asset is `DATA_INVALID`: the basis is
  not assumed. Dividends are not adjusted. `get_ohlcv` reports no split events, so the
  `UNADJUSTED_SPLIT` check cannot run.
- The notice also says the last bar may still be forming and that data may be delayed under the
  owner's plan. Only final sessions count (9h after the close), as for any equity provider.
- The evaluation time is the end of retrieval. A retrieval during which another session became final
  is refused, so every symbol rests on the same required session.

Terms. TradingView's MCP documentation (retrieved 2026-10-29) names no usage terms and says nothing
about storing or processing what it returns. The general Terms still restrict non-display and
commercial use ([TRADINGVIEW_ONLY_FEASIBILITY.md](TRADINGVIEW_ONLY_FEASIBILITY.md)). So this stays
owner-only and local: the export, snapshots and view file are git-ignored, never committed, never
sent to Supabase or a deployment, and nothing schedules a re-scan. A product scan still needs
TradingView's written agreement. A working local demonstration says nothing about commercial
launch or data-redistribution readiness.
