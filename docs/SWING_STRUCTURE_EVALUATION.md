# Swing-structure evaluation: proposed specification v1

**Status: proposed.** The machine-readable contract is
[`swing-structure-evaluation.v1.json`](swing-structure-evaluation.v1.json), study
`popup-swing-structure-retrospective-crypto-top5-1d-v1`. Its `specificationId` is the sha256 of its
own content, as for [Opportunity Radar](opportunity-radar.v1.json). Merging freezes it: any later
change is a v2 file, never an edit. Approval starts no run and activates no strategy, setting,
screen or trade. Where this page and the JSON differ, the JSON governs.

It evaluates the [research candidate](MANUAL_SPOT_EXPERIMENTS.md#research-candidate-swing-structure-swing-structure-direction-010)
`swing-structure-direction` 0.1.0 exactly as merged in `9a5ba29`. Nothing has been run. No market
data was read to write it: only the export's sha256 was recomputed, to confirm the file is the
recorded one.

## Questions

- **A. Coverage and latency.** How often is direction evaluable, how often Unclear, and how long
  after its pivots does a state become knowable? Descriptive.
- **B. Directional information (primary).** Are Up and Down followed by price changes in their
  stated direction, beyond each pair's own base rate over the same dates and horizon?
- **C. Structural reference.** After the observation, how often and how soon is the reference
  fixed at that observation breached, by a close and, separately, by an extreme? Descriptive.

A state that persists is not evidence of usefulness, so persistence is reported under A only.

## Fixed in advance

| Choice          | Value                                                                                                | Why                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Candidate       | 0.1.0 at `9a5ba29`, blob ids pinned for the candidate and `candleValidation.ts`                      | Called as published, never patched                                                                                                                   |
| Data            | The existing `crypto-usdt-v1` TradingView export `20261111T183825Z.json`, sha256 `8d251bbf…`         | The only crypto history Popup holds, with identity recorded before this spec. One retrieval supplies every candle. No new provider or Binance candle |
| Universe        | BTC, ETH, BNB, XRP, SOL (USDT): the first five of `crypto-usdt-v1`'s market-cap walk order           | Small and liquid, each with complete history. TRX is sixth, so not a member; the study says nothing about TRX or the owner's experiment              |
| Timeframe       | `1D`, UTC days, 86,400,000 ms                                                                        | The weeks-to-months path. 24/7 trading, so the fixed interval holds                                                                                  |
| Window          | 180 closed candles, D−179 through D                                                                  | Same history for every observation, so INSUFFICIENT means no structure, not a short file                                                             |
| Daily dates (A) | 2024-08-13 to 2026-09-10, 759 dates                                                                  | First complete window to the last date whose 60-day endpoint has closed                                                                              |
| Grid (B, C)     | 38 dates, every 20 days from 2024-08-13, listed in the JSON. Phases 1 to 19 shift it by one day each | Spacing equals the primary horizon, so the primary outcome windows never overlap                                                                     |
| Configurations  | **L5R5 primary**; L3R3, L10R10, L5R2 exploratory                                                     | L5R5 pivots span ~1.5 weeks with a 5-day lag. The others bracket the span and isolate a shorter lag                                                  |
| Horizons        | **20 UTC days primary**; 5 and 60 exploratory                                                        | ~3 weeks, the near end of weeks to months, as in earlier crypto studies                                                                              |
| Primary cell    | L5R5, 20 days, grid G0, statistic M                                                                  | The only classified result                                                                                                                           |

## Timing

Five times stay apart: the pivot's **candle time**; its **`availableAt`**, the close R bars later;
the state's **`establishedAt`**, the latest `availableAt` of its four pivots; the **observation
cutoff** τ_D, the close of D; and a breach's **`knowableAt`**, the close of the breaching candle.

- The candidate receives only the 180 candles up to D. The run checks the timing invariants on
  every observation, and repeats each grid observation with every later candle appended. Any
  difference refuses the run.
- **Frozen reference.** The reference returned at τ_D is the one measured afterwards. It is never
  replaced by a later pivot or carried to another observation.
- **Breaches before the observation.** The candidate can report a breach after the reference became
  available, even before the current state was established. Such a breach is classified
  `BEFORE_ESTABLISHMENT` (knowable at or before `establishedAt`) or `AFTER_ESTABLISHMENT` (later,
  but by τ_D), separately for close and extreme. It is never a forward outcome, never reset and
  never dropped. C reports these groups apart, and B breaks down by them.
- **Forward breaches** scan only bars opening D+1 to D+h, against the frozen price. Equal is not
  beyond. An observation is not an entry: nothing is simulated, so nothing is post-entry.

## Outcome and baseline

- **Reference price:** the open of D+1, the first bar after τ_D. **Endpoint:** the open of D+1+h.
  Change r = ln(endpoint ÷ reference).
- **Signed outcome:** s × r, with s = +1 for Up and −1 for Down. Down is a directional observation,
  not Short profit: no borrow, funding, fees, slippage or execution.
- **Base rate:** b_i, the mean of r for pair i over every grid date with an available outcome,
  whatever the candidate said that day. **Signed excess:** e = s × (r − b_i). Without information
  its expected value is zero, whatever the pair's drift and the mix of Up and Down. Plain s × r
  would reward following a drift.
- **Weighting:** pairs equally within a date, giving E(D). Then M is the mean of E(D) over dates,
  each date once. Configurations and horizons are never pooled.
- **Uncertainty:** M ± 2.064 × f × sd(E) ÷ √n. 2.064 is the t quantile at 24 degrees of freedom,
  and f inflates for positive lag-1 autocorrelation of E. No p-value. 60-day windows overlap, and
  their intervals say so.

## Reading the result

The primary cell is interpretable only with at least 25 dates and at least 30 Up and 30 Down
observations, each on at least 10 dates. No member may have more than 3 of its 38 grid dates
invalid, incomplete or without an outcome. Otherwise it is **NOT_INTERPRETABLE**.

- **INFORMATIVE:** the interval's lower bound > 0; Up and Down components each > 0; M > 0 with any
  one pair left out; the base-rate-adjusted hit rate > 0; and the median of M over the 20 grid
  phases > 0.
- **ADVERSE:** the interval's upper bound < 0.
- **INCONCLUSIVE:** anything else. It is not evidence of no effect.

Even INFORMATIVE is a retrospective association on partly examined history. It is not a return or
proof of profit, and it would justify only a separately frozen prospective check. The other 11
cells, the components, the phases and every breakdown are exploratory: shown with unadjusted
intervals and never classified. Nothing is selected from them for this study.

## Data handling and reproduction

- **No substitution:** no forward-fill, repair, nearby bar or other retrieval.
- **Study level:** a missing export, a hash mismatch or a refused member stops the study. It never
  runs on fewer pairs or a shorter period.
- **Observation level:** `INVALID_INPUT` is the candidate's own status. `WINDOW_INCOMPLETE` means
  the first or last day of the window is absent.
- **Outcome level:** `MISSING`, `INVALID`, or `INCOMPLETE` for forward scans. Each is counted and
  listed.
- **Attribution:** every row carries the study, spec and candidate identities and its
  configuration.
- **Output:** written once to a git-ignored
  `.zerochart-reports/swing-structure-evaluation-<spec id>.json`. A rerun must reproduce it
  byte-for-byte, or it reports `CONFLICT` and overwrites nothing. A PR quotes aggregates only.

## What it cannot establish

- **Not an untouched holdout.** The export was used by the
  [crypto scanner study](SCANNER_RESEARCH.md#crypto-crypto-usdt-v1), whose aggregates were seen.
  The drafter also knows the broad crypto history.
- **Small and correlated.** 38 non-overlapping dates on five correlated pairs. Survivorship comes
  from a market-cap pick made today. INCONCLUSIVE is a likely, legitimate result.
- **Narrow scope.** It says nothing about intraday, equities, weekly or monthly bars, other session
  boundaries or venues. Its fixed interval reads equity weekends as `MISSING_INTERVAL` and cannot
  represent calendar months.
- **No strategy.** No costs, sizing, exits or execution.

**Next step (not started):** write the analysis module against this contract on synthetic
fixtures, including look-ahead, frozen-reference and pre-observation-breach cases, and commit it
before it reads the export. Then run it once, if the owner decides to.
