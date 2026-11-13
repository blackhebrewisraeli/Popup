# TradingView crypto scan (local, owner-initiated)

The [TradingView development scan](MARKET_SCANNER.md#tradingview-development-scan-local-owner-initiated)
extended to a bounded crypto universe: Binance Spot USDT pairs, scored by the same scanner and
canonical model `1.0.0` on daily bars the owner's agent session retrieves through TradingView's
MCP server. TradingView is the **data source**; Binance Spot is the **venue** where these pairs
trade and where the owner may, independently, choose to act. Popup reads no Binance candles for
this scan, holds no exchange credential for it and places no orders.

This is a bounded initial research universe, not a scan of the crypto market.

## Universe `crypto-usdt-v1`

Frozen on 2026-11-11, before any candle was retrieved or any score computed. Committed in
`CRYPTO_TRADINGVIEW_SYMBOLS` (`scripts/tradingViewImport.ts`). A different membership is a new
universe ID, never an edit to this one.

### Membership rule

1. **Candidates, in order.** TradingView's coin ranking: `run_screener` with market `coin`, every
   coin with `market_cap_calc` ≥ 1, sorted by `market_cap_calc` descending, retrieved at about
   18:29 UTC. The rule uses the order only; no capitalization, price or return is recorded here.
   Two runs minutes apart gave the same order through every candidate below.
2. **Walk the order and pass over:**
   - **Stablecoins**: TradingView category `stablecoins`; or, where TradingView records no
     category, a token named as a US-dollar unit (RWUSD). Quoted in USDT, each would be a
     stablecoin-to-stablecoin pair.
   - **Duplicate exposure**: TradingView category `wrapped-tokens` or `rehypothecated-crypto`
     (wrapped, bridged, liquid-staking and restaking receipts of another coin, such as WBTC or
     stETH).
   - **Tokenized commodities**: tokens redeemable for a physical commodity (XAUT, gold).
   - **Leveraged tokens** (`UP`/`DOWN`/`BULL`/`BEAR`, `3L`/`3S`): none was encountered.
   - **No Binance Spot USDT pair**: `search_symbols` for `<BASE>USDT` with type `crypto` did not
     return a row whose symbol is exactly `BINANCE:<BASE>USDT`, exchange `Binance`, type `spot`.
     A perpetual (`BINANCE:<BASE>USDT.P`), its mark, index or premium series, Binance.US
     (`BINANCEUS:`) and other exchanges never count. The search returns at most 10 rows, so
     "unresolved" means TradingView did not offer the listing, not proof that none exists.
3. **Take the first 25** candidates that pass. Base tickers are TradingView's `base_currency`.

The rule does not depend on a model score, a setup or later prices. Market capitalization at the
freeze reflects earlier prices, as any size rule does. The existing Binance account-history
allowlist was not used.

### Resolution evidence

Members, in walk order (rank in the candidate list, then the exact symbol and TradingView's own
description of it, from `search_symbols`):

| #   | Ticker    | Exact symbol       | Description                 |
| --- | --------- | ------------------ | --------------------------- |
| 1   | BTC-USDT  | `BINANCE:BTCUSDT`  | Bitcoin / TetherUS          |
| 2   | ETH-USDT  | `BINANCE:ETHUSDT`  | Ethereum / TetherUS         |
| 4   | BNB-USDT  | `BINANCE:BNBUSDT`  | Binance Coin / TetherUS     |
| 6   | XRP-USDT  | `BINANCE:XRPUSDT`  | XRP / TetherUS              |
| 7   | SOL-USDT  | `BINANCE:SOLUSDT`  | SOL / TetherUS              |
| 8   | TRX-USDT  | `BINANCE:TRXUSDT`  | TRON / TetherUS             |
| 10  | HYPE-USDT | `BINANCE:HYPEUSDT` | HYPE / TetherUS             |
| 11  | ZEC-USDT  | `BINANCE:ZECUSDT`  | Zcash / TetherUS            |
| 13  | DOGE-USDT | `BINANCE:DOGEUSDT` | Dogecoin / TetherUS         |
| 19  | LINK-USDT | `BINANCE:LINKUSDT` | ChainLink / TetherUS        |
| 22  | ADA-USDT  | `BINANCE:ADAUSDT`  | Cardano / TetherUS          |
| 24  | XLM-USDT  | `BINANCE:XLMUSDT`  | Stellar / TetherUS          |
| 26  | NEAR-USDT | `BINANCE:NEARUSDT` | NEAR / TetherUS             |
| 27  | BCH-USDT  | `BINANCE:BCHUSDT`  | Bitcoin Cash / TetherUS     |
| 30  | UNI-USDT  | `BINANCE:UNIUSDT`  | UNI / TetherUS              |
| 33  | LTC-USDT  | `BINANCE:LTCUSDT`  | Litecoin / TetherUS         |
| 34  | AVAX-USDT | `BINANCE:AVAXUSDT` | AVAX / TetherUS             |
| 37  | SUI-USDT  | `BINANCE:SUIUSDT`  | SUI / TetherUS              |
| 38  | GRAM-USDT | `BINANCE:GRAMUSDT` | GRAM / TetherUS             |
| 42  | HBAR-USDT | `BINANCE:HBARUSDT` | Hedera Hashgraph / TetherUS |
| 48  | SHIB-USDT | `BINANCE:SHIBUSDT` | SHIB / TetherUS             |
| 49  | TAO-USDT  | `BINANCE:TAOUSDT`  | TAO / TetherUS              |
| 53  | QNT-USDT  | `BINANCE:QNTUSDT`  | QNT / TetherUS              |
| 55  | ENA-USDT  | `BINANCE:ENAUSDT`  | ENA / TetherUS              |
| 56  | PEPE-USDT | `BINANCE:PEPEUSDT` | PEPE / TetherUS             |

GRAM is TradingView's name for the coin formerly called Toncoin ("Gram (prev. Toncoin)").

Passed over (31 of the first 56 candidates):

| Reason                          | Candidates (#)                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stablecoin (13)                 | USDT (3), USDC (5), USDS (16), USDE (25), DAI (29), USDT0 (31), RWUSD (32, no category; `BINANCE:RWUSDUSDT` exists), USD1 (39), PYUSD (44), USDG (46), RLUSD (47), AETHUSDT (50), USDY (52) |
| Duplicate exposure (7)          | STETH (9), WSTETH (14), WBTC (15), WBETH (18), CBBTC (20), WETH (21), WEETH (28)                                                                                                            |
| Tokenized commodity (1)         | XAUT (41; `BINANCE:XAUTUSDT` exists)                                                                                                                                                        |
| Unresolved on Binance Spot (10) | XMR (12; Binance rows were only `XMRUSDT.P` mark, index and premium), LEO (17), WBT (23), RYO (35), CC (36), BTW (40; only `BTWUSDT.P` mark), ZETRIX (43), RAIN (45), CRO (51), OKB (54)    |

The walk stopped at candidate 56. No unresolved or passed-over candidate is replaced later, after
any score has been seen.

## Daily candle contract `tradingview-crypto-daily-v1`

Model `1.0.0`, the 1D timeframe and every threshold are unchanged. Observed on 2026-11-11 from
`get_ohlcv` for `BINANCE:<BASE>USDT`, interval `1D`, and enforced by `tradingViewCryptoCandles`
(`scripts/tradingViewImport.ts`) and the existing candle validator (`src/lib/candleValidation.ts`):

| Rule             | Contract                                                                                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity         | The response must name exactly the requested symbol, interval `1D` and currency `USDT`. A perpetual (`.P`), `BINANCEUS:`, another venue or quote is refused before any bar is read: `REJECTED` at capture (symbol, interval), `DATA_INVALID` at import. Nothing is substituted |
| Timestamp        | `t` is the bar's **opening** time in Unix **seconds**, UTC: 00:00:00 of its day. It becomes epoch milliseconds. A stamp that is not a positive integer below 10¹¹ (milliseconds, fractions) is `DATA_INVALID`, never re-dated                                                  |
| Day boundary     | TradingView reports no close time. A bar closes at the end of its UTC day, open + 86,399,999 ms, as a Binance 1d kline does. A bar opening at any other time than UTC midnight is `DATA_INVALID` (`TIMESTAMP_NOT_UTC_DAY_ALIGNED`)                                             |
| Cutoff           | The retrieval start, frozen in `retrieval.json`, is the scan's evaluation time for every pair. A candle counts only if it closed at or before it. The forming bar, and any day that closes during retrieval, is excluded from every pair alike                                 |
| Validity         | No repair: positive finite OHLC, high ≥ low, open and close within the range, unique opening times (`DUPLICATE_TIMESTAMP`), no missing day inside the window (`MISSING_DAILY_INTERVAL`), chronological order after sorting. Each failure is `DATA_INVALID` with its code       |
| Window           | Bars opening in the 200 UTC days before the cutoff's day are kept as input evidence, with any later bar (excluded, counted). The score rests on the last **199** closed candles, as every app score does (a 200-candle request minus the open one)                             |
| History          | Fewer than 199 closed candles is `INSUFFICIENT_HISTORY`: a younger listing is reported, not ranked                                                                                                                                                                             |
| Freshness        | The latest closed candle must be the last UTC day completed before the cutoff (cutoff − close ≤ 24h). Otherwise `STALE_DATA`. Nothing is forward-filled                                                                                                                        |
| Retrieval window | `validUntil` is the next UTC midnight after the start; after it `retry` is empty and a new retrieval is needed for a newer day. Crossing midnight is not refused, as an equity import is, because the frozen cutoff already keeps the newer day out                            |
| Provider         | Cohort provider `tradingview-mcp-get_ohlcv`. No Binance candle is read and there is no fallback. The live Market scan keeps `binance-spot-klines` and `binance-daily-v1` (48h) unchanged                                                                                       |

The 199-versus-200 difference is unchanged: app scores use 199 closed candles; Pine
`1.0.0-pw200` sees 200 at a bar close ([Pine parity](PINE_PARITY_ASSESSMENT.md)).

**Comparison.** "Asset class" is now one of the attributes two scans must share, with source,
timeframe, scanner, model, candle policy, universe and exact symbols. `tradingview-finish` chooses
a baseline only among imports of the same asset class, so crypto and equity imports are never
candidates for each other; naming one with `tradingview-baseline` shows only **Not comparable**.
Between two crypto scans, days that were never evaluated are counted in UTC days, weekends included.

## Running it

The [owner runbook](MARKET_SCANNER.md#refreshing-it-owner-runbook), with
`npm run evaluate -- tradingview-start --universe crypto-usdt-v1` in step 1 (its prompt covers the
inline case below). Fresh retrieval needs an
agent session with TradingView's MCP server connected and signed in as the owner; Popup cannot
fetch TradingView bars itself and nothing re-scans on a schedule.

A young listing returns few bars, and the agent client may show such a short result inline
instead of saving it to a file. Never retype it. Either copy it byte for byte from the client's own
record of the call (in the run below, the tool result in the session transcript, with the
transcript's timestamp as the file time), then capture that file as usual; or record it with
`tradingview-fail SYMBOL "<what was returned>"`, which keeps the pair as a failure.

## First real scan, 2026-11-11

Local, owner-initiated, from this branch. Aggregate evidence only; the export, snapshot and view
stay in git-ignored local storage.

- **Retrieval** `20261111T183825Z`: cutoff 18:38:25 UTC, last response 18:39:47 UTC, required day
  2026-11-10. 25 of 25 symbols captured in four batches (23 from saved files, 2 short results
  copied from the session transcript as above); 0 rejected, 0 conflicts, no retry needed. One
  read-only `list_alerts`: alerts exist on `BINANCE:BTCUSDT` only.
- **Scan** `20261111T183825Z-dc217757`: `PARTIAL`. Requested 25, evaluated 23, failed 2, both
  `INSUFFICIENT_HISTORY` (GRAM-USDT 132 and HYPE-USDT 48 closed UTC days on TradingView's
  `BINANCE:` series). Every evaluated pair rests on the 10 Nov UTC candle, 199 closed candles, its
  requested symbol confirmed by the response; one forming bar per pair was excluded.
- **Findings**: 0 Long setups, 20 Risk warnings (each with ATR ≥ 4% of price, the high-volatility
  regime), 3 with no setup. A high rank is not a setup: the top rank holds none.
- **Reproduction**: offline `MATCH` at finish and with `scan-reproduce`; finishing again printed
  `ALREADY_IMPORTED` and left the export and snapshot byte-identical. No baseline: the store holds
  no other crypto import, and the six equity imports were not candidates.
- **Research**: all 23 rows matched the snapshot on rank, ticker, exact symbol, score, setup and
  reason, and the two failures on status and detail. Checked at desktop width (evidence beside the
  list), at 375 px (no horizontal overflow; the evidence sheet closes back to its row), with Up and
  Down focus and Enter selection, and switching **Scan shown** to the 90-member equity scan and
  back.

## End-to-end acceptance, 2026-11-12

A second retrieval on `main` `6e99803` repeated the whole flow
([matrix](TRADINGVIEW_CRYPTO_ACCEPTANCE.md)): scan `20261112T012214Z-dc217757`, 11 Nov UTC day,
23 of 25 evaluated (the same two short histories), 0 Long, 20 Risk, offline `MATCH`, an idempotent
second finish, and the first crypto comparison (against the 10 Nov scan: no setup appeared or
cleared). Research matched the snapshot row for row, and the Manual Spot scenario matched an
independent decimal reference. No code defect was found; the runbook prompt gained the crypto
start command and the inline-result step.

## Historical study

A frozen retrospective study replays this scan over the first export's history (801 UTC days,
2024-09-01 to 2026-11-10) and compares ranks and setups with what prices did next. Result: mixed,
with Long setups too rare to judge ([method, findings and limits](SCANNER_RESEARCH.md#crypto-crypto-usdt-v1)).

A [prospective follow-up](SCANNER_RESEARCH.md#prospective-follow-up-frozen-not-yet-collected)
is frozen for scored days 2026-11-12 to 2027-11-11. A day counts only if its scan is run on the
following UTC day and **finished before the next UTC midnight**; the snapshot must stay in
`.zerochart-scans`. Nothing runs by itself.

## Manual Spot scenario

The evidence of an evaluated pair in a TradingView crypto scan (beside the list, or in the sheet
at phone width) ends with **Manual Spot scenario**. **Plan a hypothetical scenario** opens your own
arithmetic for that pair. Popup reads no balance, quote or exchange filter, sends and saves
nothing, and offers no order: you decide, and act in Binance yourself if you choose to. **Open
evidence** on one of the [candidates to review first](MARKET_SCANNER.md#candidates-to-review-first)
reaches the same panel, under the same rules and with empty inputs.

- **Evidence first.** The panel repeats what it rests on: the exact TradingView symbol, Binance
  Spot as venue, the scan ID, model and timeframe, the evaluated UTC day, the technical rank,
  whether ZC LONG and ZC RISK held (both can), freshness now and data quality. A pair without a
  Long setup is labeled not model-backed; a Risk warning (named by its clause) and **Stale** stay visible beside the
  inputs and figures. Pairs that were not evaluated (short history, invalid data) have no evidence
  view and so no scenario.
- **Inputs, all yours:** available allocation (USDT), maximum planned loss (USDT, at most the
  allocation), a hypothetical entry (USDT per unit) and a stop reference below it. The recorded
  daily close can fill the entry, labeled as a historical reference, never a current or
  executable quote. Popup suggests no entry, stop, target, confidence or expected return.
- **Figures.** With f the optional fee assumption per fill (0 while unspecified):
  quantity = min(allocation ÷ (entry × (1 + f)), max loss ÷ (entry − stop + f × (entry + stop))),
  floored to 0.00000001; which budget limited it; position notional; unallocated budget; the
  entry-to-stop distance; the loss at the stop reference. Inputs are exact decimals (up to 8
  places, fee 4) computed without floating point, so small-price pairs keep every digit; USDT
  amounts show to the cent. Missing or invalid input shows validation, never a figure.
- **Costs and limits.** Fees are unspecified by default, and then every figure excludes them. An
  assumed fee is charged once at entry and once at the stop as a share of the fill; Binance may
  charge it in the bought asset or BNB, which this does not model. Slippage is never included.
  A stop reference is a planning input, not a placed stop or a guaranteed maximum: a gap or
  execution costs can lose more. The quantity is illustrative until Binance's lot size, minimum
  notional and price filters are checked.
- **Memory only.** Choosing another asset or scan, closing the sheet, reloading the page, or an
  in-app reload that brings changed content (even under the same scan ID) clears it. An in-app
  reload of an unchanged file keeps it. Nothing is journaled or stored, and no background process
  runs.
