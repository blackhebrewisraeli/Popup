# 24-hour Spot target-before-stop evaluation: protocol v1

**Status: proposed method, offline prototype.** The machine-readable protocol is
[`spot-24h-probability.v1.json`](spot-24h-probability.v1.json), id
`popup-spot-24h-target-before-stop-v1`. Its identity is the SHA-256 of its canonical content,
printed by every run. Where this page and the JSON differ, the JSON governs. Any change after the
first run is a v2 file, never an edit.

**Recorded before any outcome.** This page and the JSON were committed after the universe step
below and before any 1h candle inside the evaluation period was retrieved. Nothing here was chosen
after seeing an outcome, a probability or a calibration figure.

## The question

Daily Discovery ranks liquidity, and the existing 0–100 model score is not a calibrated
probability. This protocol measures one event:

> A long Binance Spot position opened at the evaluation time reaches its target before its stop,
> within 24 hours.

Spot only, no leverage. The exit is the target, the stop or the 24-hour deadline, whichever comes
first. The eventual use is one real-money experiment of about 43.92 USDT (the last account read).
This study never reads, uses or spends that balance.

## Fixed in advance

| Choice      | Value                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data        | Binance Spot public klines, `1h`, through the existing `fetchSymbolCandles`. Collection cutoff **2026-11-22T00:00:00Z**: the last candle opens at 23:00Z on 21 Nov. History from 2024-11-13T16:00Z (200 warm-up hours before the first decision). Stored in the git-ignored `.zerochart-market-data/spot-24h-v1/`, public market data only. Nothing is filled, interpolated, deduplicated or repaired |
| Universe    | The Daily Discovery policy `binance-spot-usdt-liquidity-v1`, collected locally with `collectDiscoveryEvidence` at 2026-11-21T21:03:18Z (COMPLETE, 50 of 520 eligible). Walk the 50 members in rank order. Skip stablecoin or fiat bases, leveraged products, tokenized commodities and tokenized stocks or ETFs, and any pair whose first 1h candle opens after the history start. Keep the first 20  |
| Pairs       | BTC, ETH, SOL, ZEC, XRP, NEAR, BNB, UNI, DOGE, SUI, ENA, PEPE, ADA, TRX, LINK, TAO, LTC, WLD, AVAX, AAVE (all USDT)                                                                                                                                                                                                                                                                                   |
| Decisions   | Every 4 hours at 00, 04, 08, 12, 16 and 20 UTC, from 2024-11-22T00:00Z. A decision at T uses only candles closed by T                                                                                                                                                                                                                                                                                 |
| Features    | The existing `rsi(14)`, `macd(12, 26, 9)` histogram and `atr(14)` from `src/lib/indicators.ts`, on the 200 closed 1h candles ending at T. Any gap or invalid candle means no decision                                                                                                                                                                                                                 |
| Cells       | RSI below 40, 40 to 60, above 60 × MACD histogram above 0 or not: 6 cells                                                                                                                                                                                                                                                                                                                             |
| Scenarios   | v = ATR14 ÷ close. Targets 3, 5 or 8 v above entry × stops 3 or 5 v below: T3S3, T5S3, T8S3, T3S5, T5S5, T8S5                                                                                                                                                                                                                                                                                         |
| Entry, exit | Entry at the open of the candle opening at T. Scan the 24 candles opening T to T+23h                                                                                                                                                                                                                                                                                                                  |
| Costs       | Assumed 0.10% fee per fill (regular-user rate, no BNB discount), 0.05% slippage on the entry, stop and timeout fills, none on the target limit                                                                                                                                                                                                                                                        |
| Method      | Conditional empirical frequency: TARGET count ÷ observations for each scenario and cell over the fit set. At least 300 observations on 30 distinct days, or no probability                                                                                                                                                                                                                            |
| Benchmark   | The scenario's base rate over the same fit set, ignoring the cells                                                                                                                                                                                                                                                                                                                                    |
| Splits      | Train to 2025-11-22, validation to 2026-05-22, test to the cutoff. A decision whose 24-hour label crosses a boundary is dropped                                                                                                                                                                                                                                                                       |
| Ranking     | score = 0.55 × p + 0.45 × min(max(net gain, 0), 10%) ÷ 10%                                                                                                                                                                                                                                                                                                                                            |

The universe step first exposed FDUSD (a stablecoin the discovery policy does not list) and six
tokenized stock or ETF products (SOXLB tracks a 3× leveraged ETF). The exclusion list was
completed by exact base asset code, and the selection was recomputed from the same saved evidence.
That happened before any candle history was read. Only HYPE, U, ASTER and PUMP were skipped for
short history, and only XAUT for the discovery label.

## Outcome of one decision

Bars are read in order. A bar that opens at or below the stop is a STOP filled at the open. One that
opens at or above the target is a TARGET filled at the target. Otherwise, a bar touching both levels
is **AMBIGUOUS**: 1h candles cannot say which came first. It is never counted as a success, and its
net return is taken as a stop. A bar touching only the stop is a STOP at the stop, one touching
only the target a TARGET. No touch in 24 bars is a TIMEOUT at the 24th close. A missing or invalid
forward candle makes the outcome missing; it is excluded and counted, never filled.

Net return = (1 − 0.001)² × exit × (1 − exit slippage) ÷ (entry × 1.0005) − 1. The potential net
gain is that figure for a TARGET exit.

## Splits, overlap and fits

Labels from decisions 4 hours apart overlap for 20 hours, and pairs move together. So:

- **No label crosses a boundary.** Decisions in the last 24 hours before each boundary belong to no
  split. Features may use earlier candles: they were known at the decision.
- **Development:** fit on train, report on validation.
- **Confirmatory:** fit on train and validation, evaluate on test. Only test decides support.
- **Current:** fit on every decision whose label ended by the cutoff, then score 2026-11-22T00:00Z.
- **Uncertainty:** a moving block bootstrap over UTC days, whole days with every pair and hour,
  blocks of 7 days, 2,000 replicates, seeded draws reused from the swing-structure study. Test
  ΔBrier gets a 95% percentile interval with the fit held fixed. A current probability gets a 90%
  interval from re-estimating its cell on replicates of the fit days.

## When a probability counts as supported

Per scenario, on test only, all four must hold. Otherwise it is NOT_SUPPORTED, with each failing
criterion named.

1. **Evidence:** at least 2,000 test observations with a probability on at least 90 days, covering
   at least 95% of the scenario's test observations.
2. **Skill:** Brier(method) − Brier(base rate) < 0, with its 95% upper bound < 0.
3. **Calibration:** calibration in the large ≤ 0.03, and the observation-weighted cell error ≤ 0.05.
4. **Consistency:** ΔBrier < 0 on validation as well.

A current candidate qualifies only if its scenario is supported, its window is complete, its cell
has a probability, its potential net gain is positive and the current fit's mean realized net return
for that scenario and cell is positive. With no supported scenario the result is **insufficient
evidence** and no shortlist. Supported scenarios with no qualifying candidate give **no qualifying
candidate**. A shortlist entry is a research probability at a reference price, never an order.

## Limitations known in advance

- **Survivorship.** Pairs are chosen by today's liquidity and listed history, then evaluated on two
  years before today.
- **One venue, one bar size.** 1h bars hide the order inside a bar (hence AMBIGUOUS), and the 0.05%
  slippage is an assumption, not a measurement.
- **Dependence.** Overlapping labels and correlated pairs leave far fewer independent observations
  than rows. The block bootstrap addresses this only approximately.
- **Coarse evidence.** Six cells from two indicators. A supported result would be a retrospective
  association, not proof of an edge.
- **Not the closed TRX record.** TRXUSDT is a member here, but the closed Manual Spot experiment is
  neither read nor changed.
