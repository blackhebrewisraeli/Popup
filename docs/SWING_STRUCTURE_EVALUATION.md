# Swing-structure evaluation: proposed specification v1

**Status: proposed.** The machine-readable contract is
[`swing-structure-evaluation.v1.json`](swing-structure-evaluation.v1.json), study
`popup-swing-structure-retrospective-crypto-top5-1d-v1`. Its `specificationId` is the sha256 of its
own content, as for [Opportunity Radar](opportunity-radar.v1.json). Merging freezes it: any later
change is a v2 file, never an edit. Approval starts no run and activates no strategy, setting,
screen or trade. Where this page and the JSON differ, the JSON governs.

**Revision 2, before any run or merge.** It replaces the earlier interval, which corrected only
lag-1 autocorrelation and treated the base rate as fixed, with a block bootstrap. It narrows the
base rate so that the signed excess is mean-zero under a stated null, and it makes every
unavailable case explicit. The JSON's `revisions` lists the changes. The candidate, pairs, dates,
configurations and horizons are unchanged.

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
- **Base rate:** b_i(D,h), the mean of r for pair i over the grid dates with an available outcome,
  whatever the candidate said that day. It leaves out the earlier windows whose path overlaps the
  observation's 180-day input: the 9 preceding grid dates at 5 and 20 days, 11 at 60.
  - **Signed excess:** e = s × (r − b_i(D,h)). Plain s × r would reward following a drift.
- **Weighting:** pairs equally within a date, giving E(D). M is the mean of E(D) over dates, each
  date once. Configurations and horizons are never pooled.

### When the signed excess is zero on average

Take as the null that each pair's log price is a random walk with constant drift: independent,
identically distributed increments, with any co-movement between pairs. The candidate compares
prices only inside its window. So its state is independent of the observation's own change and of
every change in its base rate, and E[e | s] = 0 for every observation.

- **Why the earlier windows are left out.** A whole-grid base rate would include the windows that
  formed the state, since Up follows rises. The signed excess would then be biased against the
  stated direction even under this null. This is a correction in revision 2.
- **What the null does not give.**
  - M is mean-zero only approximately. Which dates and pairs carry weight is itself random.
  - Subtracting a base rate does not give M a known distribution.
  - Real crypto increments cluster in volatility, so the null is a reference model. Under the
    weaker condition-on-the-past null, only later windows keep the exact property.
  - No classification is an exact test.

### Uncertainty

A moving block bootstrap over grid dates (Künsch 1989; Liu and Singh 1992). Every choice is in
`uncertainty` in the JSON.

- **Unit:** one grid date with all five pairs together. Pairs are never resampled on their own.
- **Blocks:** ℓ consecutive grid positions, 20 days apart. Positions without a directional
  observation, or with missing outcomes, keep their place, so no dates become adjacent that are not
  adjacent on the grid. Blocks never wrap from the last date to the first.
- **Block lengths:** ℓ = 4 (80 days), about 38^(1/3), the order Hall, Horowitz and Jing (1995) give
  for variance estimation. ℓ = 8 (160 days) tests longer dependence. Dependence beyond 140 days, such
  as one regime across the period, is not captured.
- **Recomputation:** each of 10,000 replicates re-estimates every base rate and recomputes M from
  scratch.
- **Draws:** fixed by a SHA-256 counter with a stated seed and rejection rule. Known-answer vectors
  are pinned by a test.
- **Interval:** M ± 1.96 × the replicates' standard deviation, centred on the observed M. Not
  percentiles: the moving block bootstrap under-samples the grid's ends, which would shift their
  centre.
- **Small sample:** with 38 positions the 95% level is nominal. Coverage is neither exact nor shown
  to be conservative, and the intervals may be too narrow.
- **60-day cells:** no interval or standard error. Their windows overlap, leaving about 13
  independent ones (Valkanov 2003).
- **Unavailable cases:** fewer than 25 dates, more than 1% undefined replicates, or zero or
  non-finite spread give an UNAVAILABLE interval with its reason.

## Reading the result

The primary cell is interpretable only with at least 25 dates and at least 30 Up and 30 Down
observations, each on at least 10 dates. No member may have more than 3 of its 38 grid dates
invalid, incomplete or without an outcome. Its ℓ = 4 interval must be available. Otherwise it is
**NOT_INTERPRETABLE**.

Each gate is TRUE, FALSE or UNAVAILABLE. Only TRUE counts, and a value of exactly zero fails a
strict condition, so no undefined value can drive a result.

- **INFORMATIVE:** all seven gates TRUE.
  1. The ℓ = 4 lower bound > 0.
  2. The ℓ = 8 lower bound > 0.
  3. U > 0 (Up component).
  4. Dn > 0 (Down component).
  5. M > 0 with each pair left out in turn.
  6. The base-rate-adjusted hit rate > 0.
  7. The median of M over all 20 grid phases > 0. Every M_p must be available for this gate.
- **ADVERSE:** both upper bounds < 0. It claims no use for the reversed states, so it carries no
  robustness gates.
- **INCONCLUSIVE:** anything else, with every FALSE or UNAVAILABLE gate named. It is not evidence
  of no effect.

Gates 3 to 7 are preregistered **robustness gates** within the primary interpretation. They reuse
M's dates, outcomes and base rates, so they are not independent confirmations. They stop
INFORMATIVE when the sign rests on one state, one pair, a few large moves or one grid phase.

Even INFORMATIVE is a retrospective association on partly examined history, with nominal interval
coverage. It is not a return or proof of profit, and it would justify only a separately frozen
prospective check. The other 7 interval cells, the 60-day cells, the components, the phases and
every breakdown are exploratory and never classified. Nothing is selected from them for this
study.

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
- **Approximate inference.** Bootstrap coverage is nominal and unverified at this size, and M is
  only approximately mean-zero under the null.
- **Narrow scope.** It says nothing about intraday, equities, weekly or monthly bars, other session
  boundaries or venues. Its fixed interval reads equity weekends as `MISSING_INTERVAL` and cannot
  represent calendar months.
- **No strategy.** No costs, sizing, exits or execution.

**Next step (not started):** write the analysis module against this contract on synthetic
fixtures, including look-ahead, frozen-reference and pre-observation-breach cases, and commit it
before it reads the export. Then run it once, if the owner decides to.
