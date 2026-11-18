# Swing-structure evaluation: proposed specification v1

**Status: proposed.** The machine-readable contract is
[`swing-structure-evaluation.v1.json`](swing-structure-evaluation.v1.json), study
`popup-swing-structure-retrospective-crypto-top5-1d-v1`. Its `specificationId` is the sha256 of its
own content, as for [Opportunity Radar](opportunity-radar.v1.json). Merging freezes it: any later
change is a v2 file, never an edit. Approval starts no run and activates no strategy, setting,
screen or trade. Where this page and the JSON differ, the JSON governs.

**Run once, 2026-11-18, at `17370f1`: primary classification INCONCLUSIVE.** The aggregates and
the reproduction record are in [Recorded run](#recorded-run-2026-11-18).

**Revision 2, before any run or merge.** It replaces the earlier interval, which corrected only
lag-1 autocorrelation and treated the base rate as fixed, with a block bootstrap. It narrows the
base rate so that the signed excess is mean-zero under a stated null, and it makes every
unavailable case explicit. The JSON's `revisions` lists the changes. The candidate, pairs, dates,
configurations and horizons are unchanged.

It evaluates the [research candidate](MANUAL_SPOT_EXPERIMENTS.md#research-candidate-swing-structure-swing-structure-direction-010)
`swing-structure-direction` 0.1.0 exactly as merged in `9a5ba29`. Nothing had been run when it was
written. No market data was read to write it: only the export's sha256 was recomputed, to confirm
the file is the recorded one.

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

## Analysis module: verified on synthetic data only

[`scripts/swingStructureEvaluation.ts`](../scripts/swingStructureEvaluation.ts) computes A, B
and C on candles passed in memory. It calls the candidate as published and refuses on any timing
invariant, look-ahead difference, pending outcome, empty base rate or non-finite value. Before
any computation, every study evaluation rehashes the specification object it was given. It refuses
unless that content hashes to `99fff590…`, the id the object declares. A changed copy that keeps
the id is refused, and so is a consistently rehashed alternative.

**Synthetic verification.**
[`swingStructureEvaluation.test.ts`](../scripts/swingStructureEvaluation.test.ts) checks it on
synthetic candles only:

- window and outcome boundaries, and look-ahead;
- base rates, weights and ties against hand-worked values;
- the pinned bootstrap draws;
- frozen references and breach timing;
- every classification and unavailable state;
- one synthetic run through the frozen schedule, serialized deterministically.

Mutations of look-ahead, baseline eligibility, reference replacement and bootstrap recomputation
each fail those tests.

**Synthetic only when merged.** No export, real candle, market outcome or experiment record had
been read. The runner below reads the export, verifies its identities and writes the results. The
study was later run once: see [Recorded run](#recorded-run-2026-11-18).

**Readings of open details.** Where the text leaves a detail open, the module takes these
readings. None changes a threshold, a gate or the primary cell.

- **Interpretability counts:** Up and Down observations and dates are those entering M: Up or Down
  with an available 20-day outcome.
- **Replicate sums:** sums run in replicate order, a repeated position counting each time.
- **Quantiles and the phase median:** linear interpolation (type 7), the repository's existing
  method. For 20 phases it is the mean of the 10th and 11th values.
- **Valid input (A):** neither `INVALID_INPUT` nor `WINDOW_INCOMPLETE`.
- **A direction change:** a different direction (Up, Down or Unclear) on the next daily date, both
  with valid input. Run lengths keep runs that touch either end of the period.
- **Unavailable interval:** se* is reported only with an interval. Defined replicates and their
  mean are reported whenever replicates were drawn.

## Running the study: runner verified on synthetic data only

**Verified on synthetic exports first.** Its tests use synthetic exports in temporary
directories. Its one run on the real export is recorded [below](#recorded-run-2026-11-18).

```bash
npm run evaluate -- swing-structure-evaluation
```

The command takes no options. The export path, expected hashes, members, bootstrap settings and
output path all come from the verified specification. Any argument is refused.

**Prerequisites:**

- The owner has decided to run the study.
- A checkout of a commit on `main` whose tracked files are unchanged (`git status` shows no
  modified tracked file).
- The export at `.zerochart-tradingview/20261111T183825Z.json` on the owner's machine,
  git-ignored. Nothing is retrieved.

**Order of checks.** [`scripts/swingStructureEvaluationRun.ts`](../scripts/swingStructureEvaluationRun.ts)
stops at the first failure. Nothing is analysed or written before every check passes.

1. **Specification:** read once. The analysis module's own validator checks that its content hashes
   to `99fff590…`.
2. **Candidate code:** the working bytes of `scripts/swingStructure.ts` and
   `src/lib/candleValidation.ts` must be blobs `c081159b…` and `f2d11061…`. The files themselves
   are hashed, not their committed versions (`CODE_IDENTITY`).
3. **Repository:** `HEAD` is recorded, and every tracked file must match it, so the commit names all
   the code that runs (`REPOSITORY`).
4. **Export bytes:** read once. The sha256 must be `8d251bbf…` before the bytes are parsed. Every
   later check and the mapping use these bytes (`DATA_UNAVAILABLE`).
5. **Export metadata:** the existing `parseExport` check, the `crypto-usdt-v1` universe, and the
   frozen retrieval start and end.
6. **Members:** each of the five appears exactly once, under its committed and frozen symbol, with
   its frozen input hash. A missing, duplicated or changed member stops the study. It never runs
   on four.
7. **Mapping:** the existing `tradingViewCryptoCandles`, from 2024-02-16. Whatever it refuses
   stops the study. Gaps and duplicates inside a member's bars are not repaired. The analysis
   classifies them per observation, as the specification says.
8. **Analysis:** `evaluateSwingStructureStudy`, unchanged. A refusal there writes nothing.

**Output:** `.zerochart-reports/swing-structure-evaluation-99fff59080a3.json`, written once
through `saveResearchResults`:

- **`CREATED`:** the first write.
- **`UNCHANGED`:** a rerun produced the same bytes.
- **`CONFLICT`:** the bytes differ. Nothing is overwritten, and the command exits 1.

The file holds `{ manifest, results }`.

- **`manifest`:** the spec id and blob, the commit, the candidate's verified blobs, the blobs of
  the analysis module and the runner, the export's file name, size, sha256, universe and retrieval
  times, the mapping, and each member's symbol, input hash and candle count.
- **`results`:** the analysis output, verbatim.

It holds no wall-clock time and no absolute path. The command prints `savedSha256`, the sha256 of
the bytes at that path, outside the file. On `CONFLICT` that is the kept file. It also prints
`contentSha256`, the hash of this run's bytes.

**Readings and limits:**

- **Commit in the result.** The manifest records the commit, so a rerun at another commit reports
  `CONFLICT`, even if only documents changed. To confirm a reproduction, rerun at the same commit.
- **Loaded, then checked.** The candidate and its dependency are loaded when the command starts.
  Their bytes are checked before any analysis, at the paths they were loaded from. A file changed
  between start and check would not be detected.
- **Synthetic verification.**
  [`swingStructureEvaluationRun.test.ts`](../scripts/swingStructureEvaluationRun.test.ts) uses
  synthetic exports in temporary directories. A synthetic file cannot hash to the frozen
  identities, so a test-only mock presents the fixture's digests as the frozen ones. The runner
  has no option, parameter or flag that accepts other identities.
- **What the tests cover.** Each refusal above, in order. That the export is read once. That the
  analysis receives exactly the five mapped members. `CREATED`, `UNCHANGED` and `CONFLICT` with
  the earlier bytes kept. A deterministic manifest. That importing the runner does nothing. One
  run through the real analysis.
- **Mutations.** Removing any identity check, re-reading the export, or overwriting a result each
  fails a test.

## Recorded run (2026-11-18)

**Primary classification: INCONCLUSIVE.** All seven gates are FALSE, none UNAVAILABLE. It is not
ADVERSE: both upper bounds are above zero. Aggregates only; the per-observation rows stay in the
local, git-ignored result.

### Identity and reproduction

| Item               | Value                                                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit             | `17370f1f40e92a7bb6e48b66a0e9eb32e0397669` ([#198](https://github.com/blackhebrewisraeli/Popup/pull/198) merged), tracked files `MATCH_COMMIT` |
| specificationId    | `99fff59080a3b2f94ee5fdb1310cce7624912d7eafdad3fe8b82c4c3203dece2`, spec blob `36963b9d…`, `MATCH`                                             |
| Code blobs         | candidate `c081159b…`, `candleValidation.ts` `f2d11061…` (both `MATCH`); analysis `390fe8c6…`; runner `4f76c1ee…`                              |
| Export             | `20261111T183825Z.json`, 1,838,933 bytes, sha256 `8d251bbfed6089d0a10abf336a53ae895298639fa651888966c672c6227cbba4`                            |
| Members            | BNB, BTC, ETH, SOL, XRP: symbol and input hash `MATCH`, 1,000 mapped candles each                                                              |
| Result             | `.zerochart-reports/swing-structure-evaluation-99fff59080a3.json`, 25,651,648 bytes                                                            |
| Result sha256      | `0c66a85fde36f1479fbeb2f1ee9fc72ac45759e4fb3386089f2cfdf967859154`                                                                             |
| Run 1              | `CREATED`; `savedSha256` = `contentSha256` = `0c66a85f…`                                                                                       |
| Run 2, same commit | `UNCHANGED`; both hashes `0c66a85f…`; file bytes and modification time untouched; tracked tree still clean                                     |

**Reproducing it.** The commit is in the result's manifest, so reproduce at `17370f1`, not at this
document's commit or any later one. There, with the export at its path, the command reports
`UNCHANGED`, or `CREATED` with the same sha256 where no result exists yet. At any other commit it
reports `CONFLICT` by design and overwrites nothing.

### Completeness and exclusions

Each member has 999 of the 999 required bars (2024-02-16 to 2026-11-10), with none missing,
duplicate or invalid. No observation is `INVALID_INPUT`, `WINDOW_INCOMPLETE` or `INSUFFICIENT` in
any configuration. Every 5, 20 and 60-day outcome is `AVAILABLE` on all 759 daily and 38 grid
dates, and no forward scan is `INCOMPLETE`. The exclusion lists are empty.

### B. Primary cell: L5R5, 20 days, G0

| Statistic      | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| Dates (n)      | 37 of 38 grid dates (one date had no Up or Down member)                                  |
| Observations   | 114: Up 61 on 29 dates, Down 53 on 25 dates                                              |
| M              | −0.0138                                                                                  |
| ℓ = 4 interval | −0.0518 to +0.0242; se\* 0.0194; 10,000 of 10,000 replicates defined, their mean −0.0201 |
| ℓ = 8 interval | −0.0543 to +0.0268; se\* 0.0207; 10,000 of 10,000 defined, their mean −0.0232            |
| U, Dn          | −0.0238, −0.0130                                                                         |
| Hit excess     | −0.0578                                                                                  |
| M(−j)          | BNB −0.0176, BTC −0.0183, ETH −0.0276, SOL −0.0105, XRP −0.0069                          |
| M₀ to M₁₉      | all available; median −0.0129; range −0.0288 to +0.0094; 3 of 20 above zero              |

**Interpretability:** every condition holds. Dates 37 ≥ 25; Up 61 ≥ 30 on 29 ≥ 10 dates; Down
53 ≥ 30 on 25 ≥ 10 dates; 0 invalid or incomplete observations and 0 unavailable outcomes for
every member (limit 3); the ℓ = 4 interval is available.

**Gates:** 1 (ℓ = 4 lower bound > 0) FALSE, 2 (ℓ = 8 lower bound > 0) FALSE, 3 (U > 0) FALSE,
4 (Dn > 0) FALSE, 5 (every M(−j) > 0) FALSE for all five members, 6 (hit excess > 0) FALSE,
7 (phase median > 0) FALSE.

**In plain terms.** M is a mean of log-price changes from the open after the observation, net of
each pair's own base rate. On these dates, the 20 days after an Up or Down state moved on average
about 0.014 in log terms, roughly 1.4% of price, against the stated direction. The stated direction
was right 5.8 percentage points less often than each pair's base share of rises or falls. The
intervals run from about −0.05 to about +0.025. So the data neither show the states pointing the right way nor rule
that out, and they do not reach ADVERSE either. INCONCLUSIVE is not evidence of no effect. U, Dn,
the hit excess, every M(−j) and 17 of 20 phases lean the same way, but they reuse M's data and are
not independent confirmations. This is not a portfolio return, and a Down observation is not a
Short profit.

### A. Coverage and latency (L5R5)

- **Coverage, daily dates:** 3,795 member-dates, all with valid input. Up 32.3%, Down 28.6%,
  Unclear 39.1% (mixed structure 38.6%, equal pivot level 0.5%). On G0: Up 61, Down 53, Unclear
  76 of 190.
- **Latency:** every pivot is confirmed exactly 5 days (R) after its candle. A state becomes
  knowable a median 8 days (Up) and 6 days (Down) after its reference pivot's candle, quartiles 5
  and 14, at most 36. At observation the state is a median 4 days old and its reference 14 days
  old, at most 46 (Up) and 51 (Down).
- **Persistence:** 22 to 26 direction changes per member per 365 days. Runs last a median 13 days
  (Up) and 15 days (Down).
- **Other configurations, descriptive:** 59% to 61% of daily member-dates are directional in
  each. Confirmation always takes R days. Direction changes per member per year: L3R3 36 to 42,
  L10R10 10 to 16, L5R2 29 to 37.

### C. Structural reference (L5R5, 20 days headline)

114 observations, 104 distinct references. Before the observation, by close: 96 no breach, 2
`BEFORE_ESTABLISHMENT`, 16 `AFTER_ESTABLISHMENT`; by extreme: 95, 2 and 17. At observation, 14
closes were already beyond the reference.

| Pre-observation category | Close breached within 20 days | Median days (quartiles) | Extreme breached within 20 days | Median days (quartiles) |
| ------------------------ | ----------------------------- | ----------------------- | ------------------------------- | ----------------------- |
| None                     | 35 of 96 (36.5%)              | 10 (5 to 12.5)          | 44 of 95 (46.3%)                | 8 (4.75 to 11)          |
| `BEFORE_ESTABLISHMENT`   | 2 of 2                        | 1                       | 2 of 2                          | 1                       |
| `AFTER_ESTABLISHMENT`    | 16 of 16                      | 1 (1 to 1.5), max 12    | 17 of 17                        | 1 (1 to 1), max 12      |

No scan was `INCOMPLETE`. Without an earlier breach, a close beyond the frozen reference followed
within 5, 20 and 60 days in 10.4%, 36.5% and 54.2% of cases, and an extreme in 15.8%, 46.3% and
62.1% (5 and 60 days exploratory). In the `AFTER_ESTABLISHMENT` group the reference was already
breached at observation, so the next-day breaches are largely mechanical. C has no baseline: it
describes the reference and does not validate a stop-loss or invalidation rule.

### Exploratory cells, not classified

| Cell        | Dates, observations | M       | ℓ = 4 interval     | ℓ = 8 interval     |
| ----------- | ------------------- | ------- | ------------------ | ------------------ |
| L5R5, 5d    | 37, 114             | −0.0140 | −0.0299 to +0.0020 | −0.0303 to +0.0023 |
| L5R5, 60d   | 37, 114             | −0.0171 | none at 60 days    | none at 60 days    |
| L3R3, 5d    | 36, 118             | −0.0039 | −0.0184 to +0.0107 | −0.0143 to +0.0066 |
| L3R3, 20d   | 36, 118             | +0.0072 | −0.0300 to +0.0444 | −0.0379 to +0.0523 |
| L3R3, 60d   | 36, 118             | +0.0053 | none at 60 days    | none at 60 days    |
| L10R10, 5d  | 35, 105             | −0.0055 | −0.0196 to +0.0086 | −0.0191 to +0.0081 |
| L10R10, 20d | 35, 105             | −0.0067 | −0.0436 to +0.0303 | −0.0423 to +0.0289 |
| L10R10, 60d | 35, 105             | +0.0066 | none at 60 days    | none at 60 days    |
| L5R2, 5d    | 37, 105             | −0.0053 | −0.0204 to +0.0099 | −0.0213 to +0.0108 |
| L5R2, 20d   | 37, 105             | +0.0072 | −0.0307 to +0.0451 | −0.0315 to +0.0458 |
| L5R2, 60d   | 37, 105             | −0.0281 | none at 60 days    | none at 60 days    |

Every exploratory interval contains zero. The primary cell's breakdowns are descriptive as well:
M per member runs from −0.073 (XRP) to +0.029 (ETH), and per half-year from −0.112 (2026H1) to
+0.109 (2026H2, 3 dates). No cell, member or period is selected from these, and none becomes a
preferred configuration.

### What this run does not change

- It used a small, correlated sample, 37 dates on five co-moving pairs, and interval coverage is
  nominal and unverified at this size.
- The export had been examined before, by the crypto scanner study. This is not an untouched
  holdout.
- The members were picked by market capitalization after the period, with survivorship.
- There are no costs, sizing, fills or exits. Log-price changes are not portfolio returns.
- It says nothing about intraday, equities, other timeframes, TRXUSDT, the owner's manual Spot
  experiment or its original recommendation.
- No strategy, setting, alert, screen or trade was activated, and none follows from this result.
  Even INFORMATIVE would not have authorized activation. Any further study needs its own frozen
  specification.
