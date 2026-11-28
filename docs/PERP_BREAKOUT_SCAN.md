# Binance USDⓈ-M perpetual breakout scan (research, read-only)

One local command scans Binance USDⓈ-M crypto perpetuals with public market data, evaluates one
frozen intraday research rule and reports which signals still have acceptable reward-to-risk at
the available quote. The same command replays a saved scan without network access.

**Research baseline only.** The two-close directional breakout's historical performance after
costs did not support live use. The scan sends no order and uses no API key or account. It writes
nothing to the database and sends nothing to Telegram. It doesn't read or widen the owner's
Futures execution allowlist (`FUTURES_RISK_LIMITS`). Nothing schedules it.

```bash
npx tsx scripts/perpBreakoutScanRun.ts --save
```

```bash
npx tsx scripts/perpBreakoutScanRun.ts --replay .zerochart-scans/perp-breakout/<file>.json
```

`--json` prints the typed report instead of text. Snapshots go to the git-ignored
`.zerochart-scans/perp-breakout/`. Code: [`perpBreakoutScan.ts`](../scripts/perpBreakoutScan.ts)
(pure: selection, rule, economics, `evaluateScan`) and
[`perpBreakoutScanRun.ts`](../scripts/perpBreakoutScanRun.ts) (fetching, snapshot, replay).

## 1. Universe

1. **Discover.** `GET /fapi/v1/exchangeInfo` (weight 1). It keeps `status` TRADING, `contractType`
   PERPETUAL, quote and margin asset USDT, `underlyingType` COIN, and readable filters. Excluded:
   TradFi perpetuals (`TRADIFI_PERPETUAL`: equities, commodities, FX), `INDEX` contracts such as
   BTCDOMUSDT, pre-market listings, quarterlies, non-USDT margin and settling contracts. Each
   exclusion is counted by reason.
2. **Screen**, before any candle request, on bulk `GET /fapi/v1/ticker/24hr` (weight 40) and
   `GET /fapi/v1/ticker/bookTicker` (weight 5). It requires 24h quote volume of at least
   `--min-quote-volume` and spread `(ask − bid) ÷ midpoint` of at most `--max-spread-bps`. A missing
   ticker or a missing, invalid or crossed quote is rejected with its reason.
3. **Candles.** One common decision timestamp fixes one closed 15m boundary for every symbol. It
   is Binance's server time from `GET /fapi/v1/time` (weight 1). exchangeInfo's own `serverTime`
   isn't used: on 2026-11-28 it was about 4 hours old, even on a CDN cache miss. A scan whose
   decision time is more than 60 s from the newest bulk book-ticker timestamp is **failed**,
   because a stale clock would fix an old boundary that every candle check then accepts. The reference basket (BTC, ETH, SOL, BNB, XRP) is fetched
   first, even when it falls outside the screened universe. Then every eligible contract follows in
   descending 24h quote volume, with no top-N cutoff. Each request is
   `GET /fapi/v1/klines?interval=15m&startTime=…&endTime=boundary−1&limit=98` (weight 1). Up to
   `--concurrency` requests run at once, within `--weight-budget` (discovery included) and
   `--deadline-ms`. Contracts left over are reported as not evaluated, with the reason (weight
   budget, deadline, a failed request, or a rate limit that stops the scan).
4. Candle data is rejected when missing, malformed, stale (the last closed candle isn't the
   boundary's) or gapped. A contract listed less than 98 intervals ago is evaluated and rejected
   for insufficient history.

## 2. Rule `two-close-directional-breakout-15m` 1.0.0 (frozen)

- **Candles.** The last two closed 15m candles are the first breakout and its immediate
  confirmation. The 96 closed candles before the first breakout freeze the range (its high and
  low).
- **Market direction.** It is measured once per scan, at the first breakout close. BTC's 12h
  trend efficiency is |net log return| ÷ Σ|hourly log change|, over 12 hourly intervals sampled
  backward from that close (every fourth 15m close). It must be ≥ 0.30. At least three of ETHUSDT,
  SOLUSDT, BNBUSDT and XRPUSDT must have the same signed 12h return as BTC. The direction is then UP
  or DOWN; otherwise it is NONE and no signal can pass.
- **Signals.** A Long needs an UP market and both closes strictly above the range high (the
  breakout level). A Short needs a DOWN market and both closes strictly below the range low.
- **Exits, frozen at the first breakout candle.**
  - Long stop: 1 bp below the lower of that candle's low and the breakout level.
  - Short stop: 1 bp above the higher of its high and the breakout level.
  - Target: twice the distance from the first breakout close to the stop, projected from that close
    in the trade direction.
- **Two sets of levels.** The raw research levels are reported exactly. For the economics, the
  exits are rounded onto the symbol's tick grid against the trade: the stop away from the entry,
  the target toward it. That is a Long rounding both down, a Short both up. Both sets are in the
  report.

If any reference contract's candles are unusable, the scan is **incomplete**: there is no market
direction and no signal is judged.

## 3. Quote and economics

- **Signal time.** The confirmation close is the signal timestamp. The quote is evaluated only from
  `--quote-window-start-ms` (3 min) to `--quote-window-end-ms` (5 min) after it, with a quote at
  most `--max-quote-age-ms` (15 s) old at evaluation.
  - These are operational defaults. The historical test used a fill proxy at exactly +3 min.
  - A signal found outside the window stays in the report as **not currently eligible**, too early
    or expired. Its quote is not fetched.
- **Quotes.** For each signal in the window the scan fetches:
  - `GET /fapi/v1/ticker/bookTicker?symbol=` (weight 2): the ask for a Long, the bid for a Short.
  - `GET /fapi/v1/premiumIndex?symbol=` (weight 1): the mark price.

  Both timestamps, the sources and the evaluation time are recorded. A quote or mark that is
  missing, unreadable or stale rejects the signal. The spread is rechecked at the evaluation quote.

- **Barriers.** The mark price at or beyond the stop or the target means the setup has already
  played out, so the signal is rejected.
- **Costs and threshold.**
  - Entry and both exits fill `--slippage-bps` (5) against the trade and pay `--taker-fee-bps` (5).
  - Net reward = target fill − entry fill − fees. Net risk = entry fill − stop fill + fees.
  - Net reward ÷ net risk must be at least `--min-net-reward-risk` (1.5).
  - Funding is not modeled: every estimate is **before funding**.
- **Signal fields.** Each signal reports, as decimal strings and ISO timestamps:
  - symbol, side, rule ID and version
  - signal and expiry times
  - frozen range and breakout level
  - entry quote and quote details
  - raw and tick exits
  - fills, net reward, net risk and net reward:risk
  - its status (eligible, not currently eligible, rejected) and the reasons

**Why `planOrder` isn't used.** `planOrder` plans a resting stop-limit entry triggered when a
price is touched. This rule decides after the confirmation close and enters at the available quote,
so its execution semantics don't match. The scan reuses only `plan.ts`'s exact decimals and
symbol-filter reader.

## 4. Snapshots and replay

`--save` writes everything the decision used:

- the rule and settings, the decision timestamp and the boundary
- exchangeInfo's symbols, the bulk tickers and quotes
- every kline answer, each signal's quote and mark answers with their times
- not-evaluated contracts, request failures, request weight, Binance's reported used weight
- elapsed time, and the report

`--replay` runs the saved inputs through the same `evaluateScan` offline and compares the result
with the recorded report: **MATCH** or **MISMATCH**. A snapshot from another rule version is
refused. Replay reads only `.json` files in `.zerochart-scans/perp-breakout/`, named alone or by a
path that resolves there.

**Scan status:**

- **complete:** every eligible contract was evaluated (zero signals is a valid complete scan).
- **partial:** some eligible contracts were not evaluated.
- **incomplete:** the reference basket is unusable.
- **failed:** discovery failed.

## Defaults

| Flag                      | Default  | Meaning                                      |
| ------------------------- | -------- | -------------------------------------------- |
| `--min-quote-volume`      | 20000000 | Minimum 24h quote volume, USDT               |
| `--max-spread-bps`        | 10       | Maximum spread, screen and evaluation quote  |
| `--weight-budget`         | 1000     | Request weight for the whole scan (2400/min) |
| `--deadline-ms`           | 60000    | No new candle or quote request after this    |
| `--concurrency`           | 8        | Requests in flight                           |
| `--quote-window-start-ms` | 180000   | Quote window opens after the signal close    |
| `--quote-window-end-ms`   | 300000   | Quote window closes (the signal's expiry)    |
| `--max-quote-age-ms`      | 15000    | Maximum quote and mark age at evaluation     |
| `--taker-fee-bps`         | 5        | Per fill                                     |
| `--slippage-bps`          | 5        | Adverse, per fill                            |
| `--min-net-reward-risk`   | 1.5      | After fees and slippage, before funding      |

Not in this rule: volume confirmation (a later paired experiment against this baseline), funding,
scheduling and execution.

## Verification

[`perpBreakoutScan.test.ts`](../scripts/perpBreakoutScan.test.ts) uses deterministic SYNTHETIC
fixtures. It covers:

- product-type selection and the screen's reasons and order
- missing, invalid, stale, gapped and short candles
- the market direction (UP, DOWN, too few agreeing, low efficiency)
- a Long and a Short on two contracts with different exact levels
- exact economics, an uneconomic quote, too-early, expired and stale quotes, a mark beyond the stop,
  a wide spread at the quote and a failed quote request
- a partial scan (stale candles, weight budget), an incomplete scan (unusable reference basket)
  and a failed scan (discovery error, rate limit, a decision time 4 h from the book tickers)
- the decision time taken from `/fapi/v1/time` while exchangeInfo reports a 4 h old `serverTime`
- a complete zero-signal scan
- the runner's request weight and snapshot replay (MATCH, MISMATCH, rule version refused)
