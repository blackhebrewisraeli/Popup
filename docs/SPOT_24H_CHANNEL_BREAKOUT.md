# One 24-hour channel-breakout wallet on protocol v1's candles: it lost money, stop

**Status: development research, finished. Verdict `STOP_THIS_DESIGN`.** One fixed, long-only
Binance Spot breakout rule was simulated once in a hypothetical 44-USDT wallet holding at most one
position, over the hourly candles that [protocol v1](SPOT_24H_PROBABILITY.md) saved. That whole
history had already been examined by v1, its [diagnosis](SPOT_24H_V1_DIAGNOSTIC.md) and the
[breadth filter](SPOT_24H_BREADTH_FILTER.md), so nothing here is independent validation. The
portfolio is **execution-unverified**: sizing is ideal and fractional, and no historical exchange
filter was applied.

## In brief

- **It lost money after modelled costs.** The full two-year wallet went from 44.00 to **24.72 USDT
  (−43.8%)**. Its trades' price moves were positive (+21.88 USDT gross), but fees (28.80) and
  slippage (12.36) on 28,799 USDT of turnover, 654 times the wallet, took more than all of it.
- **Consistently, in every period.** Separately initialized wallets lost −10.4% (train, 12 months),
  −18.6% (validation, 6 months) and −20.9% (test, 6 months). Gross was positive in each, shrinking
  from +35.7% to +13.0% to +5.6% of the wallet; costs exceeded it every time. Profit factor 0.95,
  0.83 and 0.79.
- **The events alone tell the same story.** All 10,324 breakout events, each taken on its own,
  averaged +0.07% gross and **−0.22% net** per event; the net mean was negative in every period.
- **Verdict: `STOP_THIS_DESIGN`**, by the rule fixed in advance: the full wallet lost and no period
  wallet gained. No parameter, filter, reversed rule or subset was tried, and none is proposed.
- **References, not a benchmark race.** Over the same dates, buying and holding BTC lost −38.9% and
  ETH −49.9% under the same cost convention. The falling market explains part of every long-only
  figure here; it does not make the strategy's loss a success.

## What was fixed in advance

[`docs/spot-24h-channel-breakout.json`](spot-24h-channel-breakout.json) was committed (`6413eab`)
before any event, trade or portfolio figure existed. Nothing in it changed afterwards.

| Choice     | Fixed value                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data       | v1's 20 pairs and saved 1h candles, each file's SHA-256 checked against v1's recorded manifest. No download, no change of membership                                                                                                                                           |
| Decision   | Every hour T = the close of signal candle t. Inputs: the 200 consecutive valid candles ending with t, or no signal                                                                                                                                                             |
| Signal     | channelHigh(t) = highest high of t − 24 … t − 1 (t excluded). breakout(t) = close(t) > channelHigh(t), strictly. An event needs breakout(t) and not breakout(t − 1), the latter against its own window t − 25 … t − 2                                                          |
| Entry      | Reference O = the unadjusted open of the candle opening at T. Fill O × 1.0005                                                                                                                                                                                                  |
| Levels     | ATR14 (the existing `atr`, over the 200 candles, read at t). Stop O − 2 × ATR14, target O + 4 × ATR14, frozen at entry                                                                                                                                                         |
| Exit       | v1's `resolveOutcome`, one holding candle at a time: gap through the stop exits at the open, gap through the target at the target, a candle touching both is AMBIGUOUS at the stop; otherwise the 24th holding candle's close (TIMEOUT). Nothing after the exit candle is read |
| Costs      | v1's: 0.10% fee per fill withheld from the asset received, 0.05% slippage on entry, stop, ambiguous and timeout fills, none on the target                                                                                                                                      |
| Wallet     | 44 USDT, one open position. Spend S = min(1% of equity ÷ planned loss per USDT at the stop, 95% of cash). The planned loss includes both fees and both slippages                                                                                                               |
| Selection  | Several events at once: largest (close − channelHigh) ÷ ATR14, then symbol ascending; no fallback if the chosen one cannot be entered                                                                                                                                          |
| Boundaries | Full wallet 2024-11-22 to 2026-11-22. Period wallets on v1's boundaries, each starting at 44 USDT, entering only at T with T + 24h ≤ its end; later events count as BOUNDARY                                                                                                   |
| Integrity  | A missing candle inside an open trade stops that wallet with `INTEGRITY_FAILURE`: no invented fill, no dropped trade                                                                                                                                                           |
| Verdict    | Integrity failure, then fewer than 30 trades in a period (inconclusive), then full and every period positive (justifies independent validation), then full ≤ 0 with at most one period positive (stop), else inconclusive                                                      |

**Exact accounting.** Spending S at reference O buys q = S × 0.999 ÷ (O × 1.0005). Exiting at
reference X pays q × X × (1 − slippage) × 0.999, with slippage 0 for a target. Net P&L is proceeds
minus S, so proceeds ÷ S − 1 equals v1's `netReturn`. Gross P&L is q × (X − O); fees are S × 0.001
plus 0.001 of the exit value; slippage is q × O × 0.0005 plus q × X × the exit slippage. Net = gross
− fees − slippage exactly, per trade. An open position is marked hourly at liquidation value,
q × close × 0.9995 × 0.999.

## Provenance

| Item          | Value                                                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specification | `popup-spot-24h-channel-breakout-dev-1`, SHA-256 (stable serialization, as v1) `e807743e77b4df2b5b8132146a4c61a23c3449633456f597ab0385777d5e4900`, committed in `6413eab`                                                           |
| Code          | `afd15bc563fde0cbdc3815cd6435d854b738f011`; the result records the git blob of each source file. Validation, the outcome scan and costs are v1's own functions, unchanged since its run commit                                      |
| Inputs        | v1's recorded result `662c5d7d…6ec1e`, `universe.json` `b43acfda…` and the 20 candle files, each matched to its recorded SHA-256 before the run. Those, the diagnostic output and the breadth result were byte-identical afterwards |
| Coverage      | 350,400 pair-hours, no candle issue, no unavailable input, no missing outcome, no integrity failure                                                                                                                                 |
| Output        | `.zerochart-reports/spot-24h-channel-breakout-e807743e77b4.json` (git-ignored), SHA-256 `e4e734a3f811869fdfb0dc262def1fba69742c078b35bd8f68147b31ea8da6e5`, `CREATED`. Run once; no rerun was made                                  |

**Code after the run.** A later commit changed `scripts/spot24hBreakout.ts` only to resolve two
SonarCloud findings: a negated comparison written as `close <= channelHigh` (prices there are
validated, never NaN), and the wallet's entry step moved into a helper to cut cognitive complexity.
No rule, threshold or specification changed. On four synthetic 20-pair markets (plain, two with
missing candles that stop wallets on integrity failures, and one with no cash), the run commit's
code from `git archive afd15bc` and the changed code give byte-identical study output. The recorded
blobs are the run commit's; reproduce there.

## B. The wallets

Each period wallet started at 44 USDT. All four completed without an integrity failure.

| Wallet                             |                    Full |                   Train |              Validation |                    Test |
| ---------------------------------- | ----------------------: | ----------------------: | ----------------------: | ----------------------: |
| Window (UTC)                       | 2024-11-22 → 2026-11-22 | 2024-11-22 → 2025-11-22 | 2025-11-22 → 2026-05-22 | 2026-05-22 → 2026-11-22 |
| Signals in window                  |                  10,327 |                   5,661 |                   2,357 |                   2,309 |
| Executed trades                    |                     898 |                     451 |                     224 |                     223 |
| Skipped: position open             |                   8,273 |                   4,586 |                   1,813 |                   1,848 |
| Skipped: not selected              |                   1,153 |                     624 |                     294 |                     235 |
| Skipped: boundary                  |                       3 |                       0 |                      26 |                       3 |
| Skipped: cash, invalid levels      |                   0 · 0 |                   0 · 0 |                   0 · 0 |                   0 · 0 |
| Ending equity (USDT)               |               **24.72** |               **39.42** |               **35.81** |               **34.81** |
| Net return                         |              **−43.8%** |              **−10.4%** |              **−18.6%** |              **−20.9%** |
| Gross P&L (USDT, % of 44)          |         +21.88 (+49.7%) |         +15.71 (+35.7%) |          +5.74 (+13.0%) |           +2.45 (+5.6%) |
| Fees · slippage (USDT)             |           28.80 · 12.36 |            14.18 · 6.11 |             9.79 · 4.14 |             8.12 · 3.52 |
| Max mark-to-market drawdown        |      48.2% (22.67 USDT) |           29.3% (13.78) |           23.0% (10.28) |           24.3% (11.01) |
| TARGET · STOP · TIMEOUT · AMBIG.   |     237 · 452 · 208 · 1 |     120 · 227 · 103 · 1 |       65 · 115 · 44 · 0 |       53 · 109 · 61 · 0 |
| Gap stops                          |                       0 |                       0 |                       0 |                       0 |
| Win rate (net P&L > 0)             |                   39.2% |                   40.6% |                   38.8% |                   37.2% |
| Mean win · mean loss (USDT)        |         +0.437 · −0.317 |         +0.514 · −0.368 |         +0.453 · −0.348 |         +0.426 · −0.318 |
| Mean win · loss per USDT spent     |         +4.04% · −2.61% |         +4.73% · −2.90% |         +3.25% · −2.19% |         +3.42% · −2.50% |
| Mean net P&L per trade (USDT)      |                  −0.021 |                  −0.010 |                  −0.037 |                  −0.041 |
| Mean net per USDT spent            |                 −0.002% |                  +0.20% |                  −0.08% |                  −0.30% |
| Profit factor                      |                    0.89 |                    0.95 |                    0.83 |                    0.79 |
| Exposure (hours in a position)     |                   64.9% |                   65.6% |                   63.6% |                   65.0% |
| Turnover (USDT, × 44)              |           28,799 (654×) |           14,176 (322×) |            9,791 (223×) |            8,120 (185×) |
| Longest losing run (trades)        |                      12 |                      12 |                       7 |                      11 |
| Spend per trade min · median · max |    2.31 · 13.03 · 41.20 |    2.31 · 13.04 · 41.20 |    5.50 · 17.54 · 42.34 |    3.62 · 14.36 · 39.63 |
| Peak → trough of the drawdown      | 2024-11-30 → 2026-08-03 | 2024-11-30 → 2025-08-06 | 2025-11-27 → 2026-05-18 | 2026-05-22 → 2026-08-03 |

- **Costs, not direction, decided the sign.** Every wallet's trades moved in its favour before
  costs. Assumed costs are about 0.29% of the spend per round trip, and with about 450 trades a
  year the wallet paid them on 654 times its own size.
- **Equal-weighted per-trade means can look better than the wallet.** Train's mean net per USDT
  spent was +0.20% while its wallet lost 10.4%. Spend varies 18-fold, from 2.31 to 41.20 USDT, and
  is largest when the stop is closest. This follows from the fixed sizing rule; it was not tested
  further and is not a proposal.
- **One trade crossed an internal boundary** in the full wallet; period wallets held none across
  their ends by construction (29 signals were skipped as BOUNDARY there).
- **Drawdown is measured at hourly closes.** Intrabar lows of an open position are not marked.

### References over the same dates

Buy-and-hold puts all 44 USDT in at the window's first open and sells at its last close, with v1's
fee and slippage on each fill, marked hourly at liquidation value. Cash keeps 44.00 USDT.

| Wallet     | Strategy                 | BTC buy-and-hold                          | ETH buy-and-hold                        | Cash         |
| ---------- | ------------------------ | ----------------------------------------- | --------------------------------------- | ------------ |
| Full       | 24.72 (−43.8%), DD 48.2% | 26.87 (−38.9%), DD 55.7%; 98,317 → 60,216 | 22.03 (−49.9%), DD 69.2%; 3,356 → 1,686 | 44.00 (0.0%) |
| Train      | 39.42 (−10.4%), DD 29.3% | 37.98 (−13.7%), DD 34.8%                  | 36.16 (−17.8%), DD 65.3%                | 44.00 (0.0%) |
| Validation | 35.81 (−18.6%), DD 23.0% | 40.00 (−9.1%), DD 35.6%                   | 33.84 (−23.1%), DD 46.5%                | 44.00 (0.0%) |
| Test       | 34.81 (−20.9%), DD 24.3% | 34.03 (−22.7%), DD 36.0%                  | 34.65 (−21.2%), DD 43.9%                | 44.00 (0.0%) |

Both majors fell in every window. The strategy lost less than both in train and test, landed
between them in the full and validation windows, and was below cash everywhere. That ordering is
not evidence for or against the strategy: it holds a position 65% of the time in whichever pair
broke out, which is not the same exposure.

### Months (full wallet)

Equity at each UTC month's first hourly mark and at the next month's; a trade counts in the month
its exit candle closes. BTC and ETH are the full-window references' monthly returns.

| Month   | Start |   End | Return | Trades exited | Net P&L |    BTC |    ETH |
| ------- | ----: | ----: | -----: | ------------: | ------: | -----: | -----: |
| 2024-11 | 44.00 | 46.52 |  +5.7% |            15 |   +2.50 |  −2.2% | +10.0% |
| 2024-12 | 46.52 | 41.27 | −11.3% |            43 |   −5.24 |  −2.9% |  −9.9% |
| 2025-01 | 41.27 | 41.26 |  −0.0% |            41 |   +0.09 |  +9.5% |  −1.1% |
| 2025-02 | 41.26 | 42.87 |  +3.9% |            31 |   +1.33 | −17.7% | −32.2% |
| 2025-03 | 42.87 | 43.90 |  +2.4% |            34 |   +1.08 |  −2.1% | −18.6% |
| 2025-04 | 43.90 | 44.05 |  +0.3% |            37 |   +0.19 | +14.1% |  −1.6% |
| 2025-05 | 44.05 | 40.56 |  −7.9% |            36 |   −3.38 | +11.1% | +40.9% |
| 2025-06 | 40.56 | 35.21 | −13.2% |            38 |   −5.37 |  +2.4% |  −1.7% |
| 2025-07 | 35.21 | 34.69 |  −1.5% |            34 |   −0.52 |  +8.0% | +48.8% |
| 2025-08 | 34.69 | 35.02 |  +1.0% |            40 |   +0.56 |  −6.5% | +18.7% |
| 2025-09 | 35.02 | 36.66 |  +4.7% |            35 |   +1.54 |  +5.4% |  −5.6% |
| 2025-10 | 36.66 | 41.62 | +13.5% |            42 |   +4.34 |  −3.9% |  −7.2% |
| 2025-11 | 41.62 | 38.17 |  −8.3% |            38 |   −2.97 | −17.6% | −22.3% |
| 2025-12 | 38.17 | 37.42 |  −2.0% |            38 |   −0.75 |  −3.0% |  −0.7% |
| 2026-01 | 37.42 | 34.28 |  −8.4% |            40 |   −3.14 | −10.2% | −17.5% |
| 2026-02 | 34.28 | 33.26 |  −3.0% |            29 |   −1.45 | −14.9% | −19.9% |
| 2026-03 | 33.26 | 34.56 |  +3.9% |            34 |   +1.52 |  +2.0% |  +7.2% |
| 2026-04 | 34.56 | 33.73 |  −2.4% |            39 |   −0.72 | +11.8% |  +7.2% |
| 2026-05 | 33.73 | 30.55 |  −9.4% |            40 |   −3.04 |  −3.5% | −11.1% |
| 2026-06 | 30.55 | 29.00 |  −5.1% |            34 |   −1.60 | −20.4% | −21.7% |
| 2026-07 | 29.00 | 24.97 | −13.9% |            41 |   −4.02 |  +7.3% | +18.5% |
| 2026-08 | 24.97 | 25.78 |  +3.2% |            39 |   +0.81 | +25.0% | +32.5% |
| 2026-09 | 25.78 | 28.58 | +10.8% |            50 |   +2.79 |  +6.4% |  +8.8% |
| 2026-10 | 28.58 | 26.68 |  −6.6% |            32 |   −1.89 |  −7.2% | −16.0% |
| 2026-11 | 26.68 | 24.72 |  −7.3% |            18 |   −1.96 | −22.4% | −25.3% |

The wallet rose in 10 of 25 months (train wallet 7 of 13, validation 1 of 7, test 2 of 7). Months
are listed, not tested.

### Concentration

Net P&L by pair in the full wallet (USDT, trades):

| Pair | Trades | Net P&L | Pair | Trades | Net P&L |
| ---- | -----: | ------: | ---- | -----: | ------: |
| ZEC  |     92 |  +11.25 | BNB  |     54 |   −0.54 |
| NEAR |     48 |   +3.76 | LINK |     19 |   −0.87 |
| PEPE |     29 |   +2.43 | AAVE |     43 |   −1.08 |
| TAO  |     46 |   +1.87 | AVAX |     26 |   −1.19 |
| UNI  |     38 |   +1.48 | ADA  |     20 |   −1.58 |
| WLD  |     35 |   +0.93 | ETH  |     35 |   −3.81 |
| SUI  |     35 |   +0.83 | SOL  |     27 |   −4.38 |
| XRP  |     38 |   +0.46 | ENA  |     43 |   −4.67 |
| DOGE |     18 |   −0.06 | BTC  |     45 |   −6.20 |
|      |        |         | TRX  |    154 |   −8.28 |
|      |        |         | LTC  |     53 |   −9.65 |

- **No single pair carries the loss, and one pair hides part of it.** Eight pairs gained, twelve
  lost. Without ZEC's +11.25 the wallet's arithmetic total would be −30.53 instead of −19.28.
- **TRX was chosen 154 times**, 17% of trades, against 696 of its 10,324 events (6.7%). Selection
  divides by ATR, so a quiet pair's small breakout scores high. That is how the fixed convention
  behaves, observed after the fact; it was not tested and changes nothing here.
- **Largest winners.** The best trade made +0.85 USDT, the best 5 +4.16 and the best 10 +8.16.
  The total without them (arithmetic, not re-simulated) would be −20.12, −23.44 and −27.44 USDT.
  Gains were not concentrated in a few trades; the loss is broad.
- Period wallets: train gained on 10 of 20 pairs, validation on 4 and test on 7.

## A. All breakout events, each on its own

Every event, entered alone with the same levels, scan and costs, whether or not a wallet could
have held it. Events overlap in time and across pairs, so these are descriptive statistics, not
achievable returns. The target shares are historical frequencies, not calibrated probabilities for
any current candidate.

| Set        | Events | Days | TARGET |  STOP | TIMEOUT | AMBIGUOUS | Mean holding (h) | Mean gross | Mean net |
| ---------- | -----: | ---: | -----: | ----: | ------: | --------: | ---------------: | ---------: | -------: |
| Train      |  5,661 |  341 |  23.5% | 51.2% |   25.3% | 1 (0.02%) |             13.6 |     +0.04% |   −0.25% |
| Validation |  2,331 |  165 |  25.7% | 53.3% |   21.0% | 1 (0.04%) |             12.8 |     +0.02% |   −0.26% |
| Test       |  2,306 |  167 |  25.9% | 51.4% |   22.8% |         0 |             12.5 |     +0.18% |   −0.10% |
| All        | 10,324 |  674 |  24.5% | 51.7% |   23.8% | 2 (0.02%) |             13.2 |     +0.07% |   −0.22% |

- 26 events whose 24 holding candles crossed a period boundary belong to no period (they are in
  All), and 3 events in the last day had no complete holding window and are excluded. No outcome
  was missing and no stop gapped.
- Events per pair ranged from 422 (PEPE) to 696 (TRX).
- With the target twice as far as the stop, a TARGET share of one third would break even before
  costs if every other exit were a full stop. Observed: about a quarter targets, half stops and a
  quarter timeouts, which nets to a gross mean near zero. Costs of 0.25–0.30% per event then make
  every period negative.

## Conclusion

1. **Made or lost money after modelled costs?** Lost: the full wallet ended at 24.72 of 44 USDT
   (−43.8%), and every period wallet lost as well.
2. **Consistent across periods?** Yes, consistently negative: −10.4%, −18.6% and −20.9%, with
   positive but shrinking gross each time. The per-event net mean was negative in every period too.
3. **Validation, inconclusive or stop?** **Stop this design.** It meets the predeclared
   `STOP_THIS_DESIGN` rule, with ample trades (224 to 451 per period). The figures do not justify
   an independent validation. Per the specification, the design is not tuned, reversed or
   filtered, and no new hypothesis is started from it.

A positive result would not have been a live-use approval either; this one is not close.

## Limitations

- **Execution-unverified.** Sizing is ideal and fractional. Historical Binance lot-size,
  minimum-notional and tick-size filters for 2024–2026 are not in the saved inputs and none was
  assumed, so it is not claimed that every order (2.31 to 42.34 USDT) could have been placed.
- **Assumed costs.** v1's 0.10% fee and 0.05% slippage are assumptions, not the account's
  measured rates. With costs this dominant the sign depends on them: gross P&L was 53% of the
  modelled costs in the full wallet, 77% in train, 41% in validation and 21% in test (arithmetic on
  the reported figures, not a re-simulation at other costs).
- **Examined data.** The two years were studied three times before. Results describe this design on
  this history; they validate nothing.
- **Survivorship.** The pairs were chosen by liquidity on 2026-11-21 and listed history.
- **Hourly bars.** The order of touches inside a bar is unknown (2 AMBIGUOUS events, 1 trade), and
  drawdown ignores intrabar lows.
- **One design.** No uncertainty interval was predeclared; the verdict is a point-estimate rule.

## Running it

Code: [`scripts/spot24hBreakout.ts`](../scripts/spot24hBreakout.ts) (pure: events, per-event
outcomes, the wallet, metrics, references, verdict) and
[`scripts/spot24hBreakoutRun.ts`](../scripts/spot24hBreakoutRun.ts) (verifies inputs, writes once).
Tests: [`scripts/spot24hBreakout.test.ts`](../scripts/spot24hBreakout.test.ts), synthetic candles
only: the channel excluding candle t, strict equality, transitions judged against their own
windows, immunity to candles from T on, next-open entry, simultaneous selection and its tie-break,
gaps, AMBIGUOUS bars, the exact 24-candle timeout, cost identities against v1's `netReturn`, 1%
risk and the 95% cap, hourly liquidation marks, one position, unfunded events, integrity failure on
missing data, window boundaries, the verdict table and an end-to-end 20-pair reconciliation.
Eleven mutations each fail at least one test: candle t inside its channel, `>=` for a breakout, no
transition check, a reversed tie-break, sizing without costs, no spend cap, no boundary rule, a
trade with missing data skipped, marks without costs, the slot freed an hour early and a 25th
holding candle.

```bash
npm run evaluate -- spot-24h-breakout
```

It takes no options, refuses to start while any tracked file differs from `HEAD`, and writes
`.zerochart-reports/spot-24h-channel-breakout-e807743e77b4.json` once. The code commit is in the
file, so reproduce at `afd15bc`: there it reports `UNCHANGED`; at any other commit `CONFLICT`,
overwriting nothing.

Nothing here reads an account, places an order, sets an alert, writes an experiment record,
changes a schedule or touches a production store.
