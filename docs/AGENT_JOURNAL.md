# Popup agent journal

Read this before starting a task. Use the linked PRs and technical docs for details.

## Current direction

Popup helps the owner scan bounded universes of stocks and ETFs and of crypto pairs, see which
technical conditions changed, and understand the evidence behind each result. The user decides
whether to act, and where; Popup places no orders.

- TradingView is the selected source for the equity scanner and for the crypto scan of Binance
  Spot USDT pairs (`crypto-usdt-v1`). Binance is the crypto venue, never the data source of that
  scan. Both flows are local and owner-initiated through an authenticated agent. It does not establish unattended or
  production TradingView access. The existing Binance market-data paths are separate, and so is
  the owner-only, read-only [Binance Spot balance view](BINANCE_SPOT_ACCOUNT.md): balances only,
  never orders, transfers or analysis.
- Prioritize the owner's private trial and friction observed in real use. Keep public rollout,
  automated trading, new providers, and campaign expansion outside the current phase.
- Keep functional verification separate from investment outcomes. A technical score is not a
  demonstrated investment advantage.

## Current handoff

- **Research and landing:** [#132](https://github.com/blackhebrewisraeli/Popup/pull/132) put results
  and evidence side by side. [#133](https://github.com/blackhebrewisraeli/Popup/pull/133) added a
  labeled synthetic example.
- **Repeatable TradingView import:** [#134](https://github.com/blackhebrewisraeli/Popup/pull/134)
  reports a local run with 50 of 50 assets evaluated and offline `MATCH`. The agent still retrieves
  the data.
- **Comparison:** [#137](https://github.com/blackhebrewisraeli/Popup/pull/137) added comparison
  against a named prior import. Its report records offline `MATCH` on both private scans. A gap does
  not establish when a change occurred.
- **Refresh follow-up:** [#139](https://github.com/blackhebrewisraeli/Popup/pull/139) merged automatic
  baseline selection at the end of an owner-initiated refresh. Its required checks passed.
- **Exact symbol identity:** [#140](https://github.com/blackhebrewisraeli/Popup/pull/140) (merged)
  records the requested and validated exchange-qualified TradingView symbol in each scan input and
  compares two scans only on the same exact symbol. Every import up to the morning of 2026-11-07 is
  legacy: it reproduces and displays, but it is never a baseline. The first new-format import,
  `20261107T170244Z-76cde900` (6 Nov session), is the first possible baseline.
  [#141](https://github.com/blackhebrewisraeli/Popup/pull/141) (merged `9d06e6c`) named the scan
  form fields and recorded the post-#140 scan check.
- **Reloading the published scan:** [#142](https://github.com/blackhebrewisraeli/Popup/pull/142)
  (merged `abcc241`) adds **Reload local scan** to the TradingView review. It re-reads the local
  dev route only, keeps one coherent snapshot and labels a failed reload. First used on a real scan
  in the full-universe work below.
- **Full configured universe:** [#143](https://github.com/blackhebrewisraeli/Popup/pull/143)
  (merged `1a2cd8e`) adds an opt-in `tradingview-start --universe all` (all 90 configured US
  equities and ETFs). The 50-member universe stays the default, on the same symbols. A retrieval
  freezes its universe and symbols at start, scans of different universes are never compared, and
  publishing over the other universe's view keeps a copy of it. One real full-universe scan,
  `20261107T223109Z-aca6476d` (6 Nov session), is now the published Research view; the 50-member
  view is preserved beside it ([how to return](MARKET_SCANNER.md#two-universes)).
- **Saved scans in Research:** [#144](https://github.com/blackhebrewisraeli/Popup/pull/144)
  (merged `25a62ba`) adds **Scan shown** to the local TradingView review: the latest published scan or any saved
  TradingView snapshot, reproduced offline before it is shown, with only what was recorded for it.
  Nothing is copied or published, so the 50-member scan can be viewed beside the published 90
  ([Saved scans](MARKET_SCANNER.md#saved-scans)).
- **Binance Spot balances:** [#145](https://github.com/blackhebrewisraeli/Popup/pull/145) (merged
  `c054ffd`) adds an owner-only, read-only balance card to Account, served by a new
  `binance-spot-account` edge function. [#146](https://github.com/blackhebrewisraeli/Popup/pull/146) (merged `1f9c65e`) fixes the duplicate first read and
  records a local runtime check with throwaway users and a synthetic provider. No credential is
  configured and no read against Binance has run
  ([setup, boundaries and verification](BINANCE_SPOT_ACCOUNT.md)).
- **TradingView crypto scan:** [#150](https://github.com/blackhebrewisraeli/Popup/pull/150)
  (merged `7f0f40c`) freezes `crypto-usdt-v1` (25 Binance Spot USDT pairs, rule and resolution in
  [TRADINGVIEW_CRYPTO_SCAN.md](TRADINGVIEW_CRYPTO_SCAN.md)), adds the `tradingview-crypto-daily-v1`
  contract with one frozen cutoff per retrieval, and shows the scan in Research beside the equity
  scans. Real scan `20261111T183825Z-dc217757`: 23 of 25 evaluated, offline `MATCH`; it is now the
  published Research view.
- **Manual Spot scenario:** [#151](https://github.com/blackhebrewisraeli/Popup/pull/151)
  (merged `cc8bc1f`) adds the owner's own hypothetical plan to an evaluated pair's evidence in that scan: allocation,
  loss budget, entry and stop reference typed by the owner, exact decimal arithmetic, fees
  optional and unspecified by default, in component memory only. No order, balance read or
  storage ([usage and limits](TRADINGVIEW_CRYPTO_SCAN.md#manual-spot-scenario)).
- **Owner trial:** deferred by the owner and not started. When it starts, personal decisions and
  outcomes go in a private journal, never here.
- **Model evidence:** [#118](https://github.com/blackhebrewisraeli/Popup/pull/118) and [scanner
  research](SCANNER_RESEARCH.md) did not establish a predictive advantage. The frozen crypto study
  is **mixed**: no 1- or 5-day information, a 20-day mean advantage for the top
  ranks that the median observation does not share and one pair dominates, and too few Long
  setups (3) to judge ([#152](https://github.com/blackhebrewisraeli/Popup/pull/152), merged `354c233`,
  [findings](SCANNER_RESEARCH.md#crypto-crypto-usdt-v1)).
- **Why Long is rare and Risk common:** the [model diagnostic](MODEL_DIAGNOSTIC.md)
  ([#153](https://github.com/blackhebrewisraeli/Popup/pull/153), merged `8bf3db8`, no model
  change, no outcome read)
  traces it to volatility: crypto's median ATR/close (6.4%) puts 85.5% of pair-days in
  HIGH_VOLATILITY, where no RSI or momentum reading can reach the Long score above 4.25%, and
  99.7% of Risk observations rest on that clause. No defect found.
- **Risk clauses named in Research:** [#154](https://github.com/blackhebrewisraeli/Popup/pull/154) (merged `6e99803`) labels every Risk warning
  by the clause that holds it, **High volatility** or **Low score** or both, on row tags and
  accessible names, evidence, comparison, the Manual Spot scenario and the landing example. Wording
  only: the Risk warnings view, its counts, ranks and scan-change transitions are unchanged.
- **Crypto workflow acceptance (2026-11-12):** [#155](https://github.com/blackhebrewisraeli/Popup/pull/155) (merged `134fef7`). A fresh `crypto-usdt-v1` retrieval on `6e99803`
  passed start → capture → finish → Research → evidence → Manual Spot scenario, with offline
  `MATCH`, an idempotent second finish and the first crypto comparison
  ([matrix](TRADINGVIEW_CRYPTO_ACCEPTANCE.md)). No code defect; the runbook prompt now covers the
  crypto start and short results shown inline.
- **Research selection across reloads (2026-11-12):** [#156](https://github.com/blackhebrewisraeli/Popup/pull/156) (merged `56366db`). Owner
  decisions on the two open rows: a full page reload now restores the source and **Scan shown**
  (C7), and an in-app reload of an unchanged file keeps scenario inputs while changed content,
  even under the same scan ID, resets them (C12, revised).
- **Binance outcome tracking, stage D (2026-11-12):** draft
  [#157](https://github.com/blackhebrewisraeli/Popup/pull/157), documentation only.
  [BINANCE_SPOT_RECONCILIATION.md](BINANCE_SPOT_RECONCILIATION.md) specifies the smallest
  account-event and reconciliation contract over the existing read-only balances and execution
  history ([#148](https://github.com/blackhebrewisraeli/Popup/pull/148), merged `54f9a6c`).
  Proposed scope: one subject asset (the base of one supported pair, never USDT or BNB) between two
  balance reads at most 24 hours apart. Opening cost is unknown unless the opening quantity is
  zero. Quantity, acquisition cost and P&L get separate statuses, and account history is never
  called complete. A matching quantity is numerical consistency only. Cost and P&L statuses stay
  specification-only until the cost method and fee policy are decided. Next increment, proposed
  and not started: reliable accumulated execution evidence. Identical duplicates collapse.
  Conflicting `(symbol, trade ID)` records are surfaced, within a page and across pages. Earlier
  page failures stay visible for the same retrieval. "No further continuation" is kept distinct
  from "complete". A reconciliation function comes only after that. All of it still depends on
  the owner's real Binance check, which has not run and must also settle what `commission` covers
  and whether USDT moves by exactly `quoteQty`.
- **Model decision (2026-11-12):** keep canonical model `1.0.0` as a descriptive technical tool.
  Nothing has validated its predictive value, and nothing here authorizes a change. The annual
  prospective study is not a prerequisite for ongoing development. Any future model change needs
  its own justified, versioned proposal (new `MODEL_VERSION`, Pine, migration and in-Pine
  self-check per CONTRIBUTING) that keeps every earlier version reproducible and leaves the frozen
  studies on `1.0.0`.
- **Prospective crypto check:** frozen in `fab48a3` (2026-11-11 20:37Z, same PR): top 5 against
  the same-date universe at 20 days, a hypothesis selected after the retrospective results, for
  scored days 2026-11-12 to 2027-11-11, analysed once on or after 2027-12-04. It collects
  nothing: a day counts only if the owner's crypto scan for it was saved before the next UTC
  midnight ([rules](SCANNER_RESEARCH.md#prospective-follow-up-frozen-not-yet-collected)).

**Next:** Still pending: the first real new-session equity comparison. Run one fresh default
(50-member) scan with the runbook prompt. `tradingview-finish` should list the full-universe import
`20261107T223109Z-aca6476d` under `skipped` as not comparable (Universe), choose
`20261107T170244Z-76cde900` as the baseline, and report the published crypto view under
`preservedView`; crypto imports are no longer candidates and are not listed. Research should show
the same counts after **Reload local scan**, and every scan under **Scan shown**. The first crypto
comparison is done (10 → 11 Nov, 2026-11-12). From 2026-11-13 UTC,
each daily crypto scan finished before UTC midnight is also a prospective observation; keep
`.zerochart-scans`.

See the [scanner runbook](MARKET_SCANNER.md) for retrieval, import, reproduction, and review.
The [Decision Journal](DECISION_JOURNAL.md) is an in-app feature; this file is for engineering handoffs.

## How to leave a handoff

- Check `main` and relevant PRs before starting. This document can lag behind GitHub.
- For a change that affects direction, evidence, or the next task, update the current handoff
  and add a short entry here in the same PR when practical. Link the source instead of copying
  a changelog or chat transcript.
- Say whether the work is proposed, open, or merged. Record what was actually checked and
  distinguish fixtures, a local real-data run, and deployment verification.
- This repository is public. Keep raw market data, private artifacts, alert payloads, credentials,
  account details, and personal holdings, trades or results out of the journal. Use synthetic
  examples or sanitized aggregate evidence.

## Recent entries

- **2026-11-12 · Binance Spot account-event and reconciliation contract (stage D) · Draft PR
  [#157](https://github.com/blackhebrewisraeli/Popup/pull/157), documentation only.** Decision:
  specify before building, and only what the existing four GET requests can evidence. The trace
  of the integration at `56366db` (cited by line in
  [the spec](BINANCE_SPOT_RECONCILIATION.md)) found three gaps that matter for reconciliation:
  - A second row with the same `(symbol, trade ID)` is dropped without comparing its content. The
    handler test asserts first-wins for a conflicting row.
  - A pair that fails on one page silently drops out of later pages, which then report
    `partial: false`.
  - `readAt` comes from the function's clock, not Binance's.

  A throwaway test confirmed the two handler behaviours; it was not committed. Binance facts were
  rechecked on 2026-11-12: trade-list fields, no stated retention or bound inclusivity, an
  undocumented `updateTime`, the three commission kinds and self-trade mode `NONE`.

  The contract covers one subject asset over a window of at most 24 hours between two balance
  reads, with a 60 s boundary guard. The guard is provisional Popup policy, not a proven bound on
  clock skew or snapshot timing, and no read becomes an atomic snapshot. Identity is
  `(symbol, trade ID)`: identical repeats collapse, and differing ones are conflicts. Fees stay in
  their own asset, with no invented rate. Quantity is Consistent (numerical consistency only),
  Discrepancy or Indeterminate. Cost and later P&L are known within scope, partial or unavailable,
  and stay specification-only while the accounting policies are open. The three are kept apart.

  Ten synthetic examples were hand-calculated, and their arithmetic was rechecked with exact
  decimals. Seven open decisions (D1–D7) are listed but not chosen: cost method, fees in cost,
  what `commission` covers, quote movement, duplicate IDs from self-trades, the guard and clocks,
  and boundary inclusivity. There is no code, endpoint, storage, migration, deployment or Binance
  request. Review follow-up on the same PR: example 6b now names its 0.01 USDT fee, the guard is
  marked provisional, and the next increment became the evidence-integrity prerequisite. Next:
  reliable accumulated execution evidence (proposed, not started). The real Binance check
  remains the owner's.

- **2026-11-12 · Restore the Research source and scan after a full reload · PR
  [#156](https://github.com/blackhebrewisraeli/Popup/pull/156), merged `56366db`.** Decision: the smallest mechanism, per tab. `useResearchSelection` keeps the source
  and a scan ID in `sessionStorage` under `vite dev` only, read synchronously at mount (the shell
  renders only after client-side auth, so there is no hydration mismatch and no frame of Market
  data). Nothing else is kept: no results, prices, selection or scenario input. A restored scan is
  read again; missing, refused, unreadable or malformed ones say so with **Show the latest
  published scan**, never a silent fallback. The review is now keyed by an FNV-1a digest of what
  was read, so changed content resets the scenario even under the same scan ID, and identical
  content keeps it (C12 as revised). Evidence: 14 new tests (restore, published semantics,
  defaults, unreadable entries, missing, malformed or non-text reference, failed read, scenario after reload, identical
  and changed reloads, production build), two of them checked to fail without the change; 1,529
  tests, typecheck, lint, build. Browser: real reload at desktop and 375 px, light and dark,
  keyboard, stores byte-identical ([follow-up rows](TRADINGVIEW_CRYPTO_ACCEPTANCE.md#follow-up-2026-11-12-c7-fixed-c12-requirement-revised)).
  Next: none required.

- **2026-11-12 · TradingView crypto workflow acceptance · PR
  [#155](https://github.com/blackhebrewisraeli/Popup/pull/155), merged `134fef7`, documentation
  only.** Decision: verify the existing flow end to end and fix only what blocks or misrepresents
  it; nothing in the code did. Evidence, kept apart in [the matrix](TRADINGVIEW_CRYPTO_ACCEPTANCE.md):
  fresh live retrieval `20261112T012214Z` (25 of 25 captured, two inline short results copied byte
  for byte from the session transcript, read-only alert check); scan `20261112T012214Z-dc217757`,
  `PARTIAL` 23 of 25, 0 Long, 20 Risk, offline `MATCH` also with outbound IP denied; a second
  finish `ALREADY_IMPORTED` with both stores byte-identical; an independent script confirmed exact
  symbols, one cutoff, closed bars, 199-day history, freshness and accounting for all 25. In the
  browser, all 23 rows matched the snapshot in the published view and its saved copy; evidence,
  scenario arithmetic (against a `Decimal` reference, fees included), 15 validation cases,
  clearing on asset, scan and sheet changes, no storage write or account call, keyboard, desktop
  and 375 px all passed. The first crypto comparison (10 → 11 Nov) matched a recomputation. The
  runbook prompt now names the crypto start and the inline-result step. Not prospective (11 Nov
  precedes the period). Next: owner decision on the two reload behaviours (matrix C7, C12).

- **2026-11-12 · Name the Risk clause in Research · Draft PR
  [#154](https://github.com/blackhebrewisraeli/Popup/pull/154).** Decision: wording only, from `explainResult`'s own clauses, so no
  formula is repeated. A Risk tag reads "Risk: high volatility", "Risk: low score" or both, and the
  row's accessible name uses the same words; the evidence, comparison table and Spot scenario name
  each held clause; a label with no recorded model names none ("Risk warning"). The Risk warnings
  view stays the union of both clauses with the same members and counts, and Long stays visible
  beside high-volatility Risk. The ranked list's Setup column now takes a share of spare width (never under its old 100 px), so the common label fits on one line on wider screens. The changes list keeps "held in both" for a warning whose clause
  changed and shows no clause history, because the comparison records none. The TradingView
  crypto reading guide adds one scoped line: high volatility held on 85.5% of the frozen study's
  evaluated pair-days and describes ATR relative to price, not a decline. No model, threshold,
  Pine, scanner version, snapshot or study change. Evidence: synthetic readings through
  `scoreFactors`/`modelSetups` and scans through `evaluateScan` (each clause alone, both, neither,
  Long with high volatility, both canonical boundaries, missing model, union and comparison
  unchanged); browser check at desktop and 375 px, light and dark, keyboard. Next: none required;
  the model decision above stands.

- **2026-11-12 · Diagnose the canonical model's Long and Risk behaviour · PR
  [#153](https://github.com/blackhebrewisraeli/Popup/pull/153), merged `8bf3db8`.**
  Decision: explain before proposing changes. A new `model-diagnostic-crypto` command replays
  the frozen crypto study's 801 dates with its own `replayDay`, takes every score apart into
  factor contributions and gate clauses, and refuses to write unless every replayed date and
  every status, Long and Risk count equals the frozen results (`a14c0d19…`). It never reads the
  study's horizons. Definition `model-diagnostic-crypto.v1.json` (ID `8dc1d6fd…`) is pinned by a
  test. Evidence: reconciliation `MATCH` on 801 dates and 18,322 rows; rerun and an
  outbound-IP-denied rerun `UNCHANGED` (results `7469bc44…`); crypto, equity v1 and v2 studies
  `UNCHANGED`, scan `20261111T183825Z-dc217757` `MATCH`. Formula bounds are checked on a grid,
  and synthetic candle paths reach Long in all four regimes, including Long and Risk together
  through HIGH_VOLATILITY (never observed). Findings in [MODEL_DIAGNOSTIC.md](MODEL_DIAGNOSTIC.md):
  volatility rules out the Long score on 82.9% of pair-days; momentum never blocked a Long; RSI
  and momentum factors correlate −0.54; 552 of 561 low-score onsets began while high volatility
  already held, so no transition marks them. No defect; Pine's HUD bands and the score-80 alert
  differ from the setups by design. Next: name the Risk clause in Research (wording only); any
  model change needs a new version and would leave the frozen prospective check.

- **2026-11-11 · Prospective follow-up to the crypto study, frozen · Draft PR
  [#152](https://github.com/blackhebrewisraeli/Popup/pull/152), commit `fab48a3`.** Decision:
  confirm one selected hypothesis on days that had not begun at the freeze, rather than slice the
  same history further. The 20-day horizon and top-5 comparison were chosen after seeing the
  retrospective results; the specification says so. Reference: the first bar opening after the
  scan's own cutoff (D+2 open), so no part of a window precedes the recorded scan. Only snapshots
  saved before that bar opened are PROSPECTIVE; later replays are RECONSTRUCTED, reported apart
  and never pooled. Days are summarised once each and split into 21 non-overlapping phase series;
  the four possible readings and their conditions are fixed. Evidence: specification ID
  `45a43d5c…` pinned by a test; the timing and category rules tested at UTC boundaries (saved at
  23:59:59.999 counts, at midnight does not; the first live scan falls outside the period);
  1,466 tests, typecheck, lint, build. No outcome of the period exists. Next: owner-initiated
  daily crypto scans from 2026-11-13 UTC, finished before midnight (240 of 365 days needed); the
  analysis code before 2027-12-04.

- **2026-11-11 · Frozen retrospective study of the TradingView crypto ranking · Draft PR
  [#152](https://github.com/blackhebrewisraeli/Popup/pull/152).** Decision: reuse the equity study's observations, outcomes,
  statistics and write-once reproduction, and replay with the scanner itself (`evaluateScan`,
  TradingView crypto policy unchanged) at each UTC day's close on candles closed by then. The
  specification (`scanner-research-crypto.v1.json`, ID `6d005fee9ffd…`) was committed (`ac05b1f`)
  after inspecting only bar counts, dates and response metadata, and the replay code (`aaf4eae`)
  before its first real run. No new retrieval: the 11 Nov export holds 1000 bars for 21 pairs.
  Outcomes: OPEN of the first bar after D's 23:59:59.999 UTC cutoff to OPEN 1/5/20 days later.
  Baselines: same-date equal-weight universe, and same-tercile pairs outside the group (unmatched
  counted). Evidence: labeled fixtures (no future candle, strictly later reference, UTC
  boundaries and horizon ends, gaps, invalid bars, stale, young listings, coverage floor, ties,
  order independence, both parities, tampered export/scan/results, no network); 1,458 tests,
  typecheck, lint, build. Local real-data run: 801 days, 21–23 of 25 pairs per day, parity
  `MATCH` on every day and on all 25 recorded results of `20261111T183825Z-dc217757`; reruns
  (also with outbound network denied) `UNCHANGED`; equity v1 and v2 still `UNCHANGED`. Result:
  mixed (aggregates in the doc). The study does not remove survivorship bias, data revisions or
  prior knowledge of the model. Next: freeze an out-of-sample check of the 20-day top-rank
  comparison on days after 2026-11-10, before any of them is seen.

- **2026-11-11 · Manual Spot scenario in the TradingView crypto evidence · Draft PR
  [#151](https://github.com/blackhebrewisraeli/Popup/pull/151).** Decision: a disclosure at the
  end of the existing evidence view, not a new dashboard, holding only the owner's inputs in
  component state keyed by scan and asset. A new pure `spotScenario.ts` sizes with BigInt at
  1e-8 rather than reusing `recommendPositionSize`, whose ATR stop, percent-of-capital risk,
  4-decimal rounding and zero-on-invalid do not fit an owner-typed plan; doubles also lose the
  last digit of PEPE-sized quantities. Quantity is floored so notional plus any assumed entry fee
  stays within the allocation and the loss at the stop within the budget. Evidence: labeled
  synthetic fixtures (allocation-, loss- and equally-limited sizing; stop at or above entry;
  zero, negative, non-finite, comma, exponent, over-precise and excessive inputs; a small-price
  pair; sub-cent amounts; a budget too small for one unit; unspecified, 0% and 0.1% fees; no-Long,
  Long+Risk and stale states; selection, scan and sheet changes clearing; no fetch or storage
  write; no order control), 1,428 tests, typecheck, lint, build. Real-scan inspection on the
  published `20261111T183825Z-dc217757` view: a no-setup pair's panel named its symbol, scan, day,
  rank and freshness; planning sent no request; another row and another scan started empty;
  equity scans show no panel; desktop, 375 px (no horizontal overflow), light and dark and
  keyboard (disclosure, inputs, recorded-close button) checked. No real figure is recorded here.

- **2026-11-11 · TradingView crypto scan of Binance Spot USDT pairs · Draft PR
  [#150](https://github.com/blackhebrewisraeli/Popup/pull/150).** Decision: extend the existing
  start → capture → finish workflow, not a new scanner. `crypto-usdt-v1` was frozen (commit
  `f076326`) before any candle was retrieved: the first 25 coins of TradingView's market-cap ranking
  that are not stablecoins, tokenized commodities or wrapped/staked receipts and resolve exactly
  to `BINANCE:<BASE>USDT` spot; 10 candidates were unresolved and are listed, none replaced. The
  `tradingview-crypto-daily-v1` contract reads `t` as UTC-midnight opening seconds, refuses another
  symbol, interval or quote, freezes one cutoff at the retrieval start (a day that closes during
  retrieval never enters), scores the last 199 closed UTC days and requires the last completed
  day. Equity imports and the live Binance scan are unchanged; crypto and equities rank and compare
  separately ("Asset class"). Research names TradingView as source and Binance Spot as venue.
  Evidence: labeled fixtures (identity refusal, units, UTC boundary and crossing, gaps, duplicates,
  alignment, stale, short history, accounting, ranking, idempotency, conflicts, cross-class
  refusal, no network during reproduction); 1,390 tests, typecheck, lint, build. Local real-data
  run: 25 requested, 23 evaluated, 2 short histories, 0 Long, 20 Risk, offline `MATCH`, every
  Research row matched the snapshot; desktop, 375 px and keyboard checked. Two short responses were
  shown inline by the agent client and were copied byte for byte from its session transcript, not
  retyped. Next: a second crypto retrieval on a later UTC day, for the first crypto comparison.

- **2026-11-10 · Owner-only Binance Spot execution history · Draft PR [#148](https://github.com/blackhebrewisraeli/Popup/pull/148).** Decision:
  extend the existing read-only account function with signed `GET /api/v3/myTrades`, never a
  trading endpoint. The Account view manually reads one of 12 explicit USDT pairs over 1, 6 or 24
  hours, 100 fills per page. It preserves each fill and its recorded commission asset, deduplicates
  by symbol plus trade ID, uses an HMAC-validated continuation, and labels finite/partial coverage;
  it never writes a Popup ledger or derives value, P&L, cost basis or tax. Evidence: official
  Binance Spot documentation; labeled synthetic fixtures; 1,335 tests, typecheck, lint and build;
  and an isolated local Auth → edge function → synthetic provider run with anonymous 401,
  wrong-user 403, owner 200, a 100-record partial first page and IDs 101–102 on continuation. The
  byte-identical committed handler ran in edge runtime 1.76.2, logs were aggregate-only, and the
  disposable stack had zero public tables. In headless Chrome the manual-only read showed 100 then
  102 fills, kept two fills for one order and exact BNB/USDT fees; keyboard focus survived paging,
  and the 375 px view had no page overflow. Real Binance and hosted deployment: NOT RUN. A short
  feasibility note records what a broad TradingView crypto scan still lacks; no scanner was built.
  Next: after an explicitly authorized deployment, compare one known pair/range (and continuation,
  if present) with Binance's own UI without widening the pair set or claiming lifetime history.

- **2026-11-10 · Recover the Sonar fixes pushed after #144 merged · Open PR
  [#147](https://github.com/blackhebrewisraeli/Popup/pull/147).** Decision: commit `d656ad3` reached
  the #144 branch after the merge, so `main` never received it. It is cherry-picked unchanged onto
  current `main`: the scan summary's dev-import badges and Retrieved fact become two small
  components, and the **Scan shown** label text sits in a `span`. Same rendered output; no scanner,
  model, provider or account behavior changes. Evidence: fixtures only. The scan-summary,
  saved-scan and source-selector tests pass unchanged, with typecheck, lint, the full suite and
  build. No browser run. Next: after merge, delete `feat/saved-tradingview-scan-selector`, which
  then holds nothing `main` lacks.

- **2026-11-10 · Binance Spot balances through the local runtime; one initial read · Draft PR
  [#146](https://github.com/blackhebrewisraeli/Popup/pull/146).**
  Decision: the card sent its first read twice in development, because React StrictMode re-runs the
  mount effect on one instance. The effect now starts the first read once per instance and keeps
  listening for its answer. Manual refresh, the rate-limit pause, request ordering and the
  per-user remount are unchanged, and nothing is cached. Evidence, three levels. Unit and fixture:
  a StrictMode test that failed before the fix, and an answer arriving after the account changed.
  Local runtime integration: on an isolated local Supabase stack with two throwaway users, the
  unmodified function loaded and refused anonymous (401) and wrong-user (403) callers and told the
  owner **Not configured**. With a local entry file outside the repository routing the three
  Binance requests to a synthetic server, the owner saw the synthetic balances character for
  character, refused callers caused zero provider requests, and connected, empty, key-refused,
  failed-refresh, rate-limited and stale states, logout and account switching with a late answer,
  keyboard refresh and phone width were checked in the browser. Logs held no credential, identity
  or balance, and no table was written
  ([details](BINANCE_SPOT_ACCOUNT.md#verification)). Real Binance: NOT RUN. No credential is
  configured, and the hosted function's deployment was not checked. Next: the owner follows
  [the setup steps](BINANCE_SPOT_ACCOUNT.md#owner-setup), then one live read-only check.

- **2026-11-10 · Owner-only read-only Binance Spot balances · Merged in
  [#145](https://github.com/blackhebrewisraeli/Popup/pull/145) (`c054ffd`).** Decision: the smallest
  account connection is one Supabase edge function that asks Supabase Auth who the caller is,
  serves only the configured owner ID, and can send three GETs to Binance: server time, key
  permissions, account balances. Credentials are function secrets; a missing owner, flag, key or
  secret disables it. A key with any trading, withdrawal or transfer capability is refused, and
  one whose permissions cannot be confirmed is reported as unverified; the account's `canTrade`
  flag is not consulted. The Account card shows asset, available and locked as Binance's decimal
  strings, the last successful read, a stale label after 5 minutes and a manual refresh. It holds
  one snapshot in memory, separate from every Popup ledger, with no valuation. Evidence: synthetic
  responses and fake credentials cover signing against Binance's documented example, time
  handling, owner, anonymous and wrong-user access before any provider call, permission refusal
  and unverified, precision, locked funds, an empty account, 429 and 418, timeouts, malformed
  data, failed refresh with retained balances, out-of-order refreshes, credential leakage and the
  GET-only allowlist. The card was checked in the browser at desktop and phone width, in light
  and dark, from the keyboard, with the function's answers simulated in the page. Not verified:
  any read against Binance; whether the deployed function's region may reach Binance's signed
  endpoints. Next: the owner follows [the setup steps](BINANCE_SPOT_ACCOUNT.md#owner-setup), then
  one live read-only check.

- **2026-11-08 · Select a saved TradingView scan in Research · Merged in
  [#144](https://github.com/blackhebrewisraeli/Popup/pull/144) (`25a62ba`).** Decision: viewing the other
  universe meant copying a preserved view over the published one. **Scan shown** now lists every
  TradingView snapshot in the scan store (ID, session, universe size, coverage) beside **Latest
  published scan**. The dev server reproduces a selected snapshot offline before showing it, and
  shows only what was recorded: source and comparison from a published or preserved view of
  exactly that scan, otherwise the snapshot alone, with retrieval window, notice, selection rule
  and alert check not recorded and no baseline chosen after the fact. Malformed, incompatible,
  non-reproducing and removed scans each have a state. Reload stays on the selection. The route
  takes only a scan ID, treats a symbolic link as absent, never writes, and refuses non-loopback
  peers and non-loopback `Host` headers. Evidence: unit tests for the route, the store reader and
  the review. Labeled fixtures built through start → capture → finish, in a scratch worktree:
  50 → 90 → 50 with no page refresh, every row matching its snapshot, each refused state, a removed
  and restored file, ten rapid changes (one read per scan), keyboard, phone width and dark mode.
  Local real-data run: the six TradingView snapshots listed (crypto scans excluded, four legacy),
  all reproduce, 50 → 90 → 50 and a legacy scan matched their snapshots row for row, and all 15
  files in the real store stayed byte-identical. Next: the 9 Nov comparison above.

- **2026-11-08 · Full configured US equity universe, opt-in · Merged in [#143](https://github.com/blackhebrewisraeli/Popup/pull/143) (`1a2cd8e`).**
  Decision: the 50-member scan stays the default. `--universe all` requests all 90 configured US
  equities and ETFs. The 40 added tickers were resolved with TradingView `search_symbols`: each has
  exactly one US primary-venue listing (WMT is now on NASDAQ), so none was ambiguous or
  unavailable. A retrieval's universe and exact symbols are frozen in its manifest at start. A scan
  of one universe is never a baseline for the other, because a wider universe changes ranks. A
  same-session one now says so instead of suggesting it be named. Publishing over the other
  universe's view copies the replaced view first. Evidence: labeled fixtures cover both universes,
  partial retrieval, an unavailable symbol, retries, duplicate finish, frozen-membership refusal,
  reproduction, cross-universe refusal and the preserved view. Local real-data run: 90 requested,
  90 resolved, 90 evaluated, 0 failed on the 6 Nov session; two same-millisecond file collisions
  were rejected and retried. Offline `MATCH`; a second finish was `ALREADY_IMPORTED` and
  byte-identical. Every input names the requested, validated exact symbol. 0 Long setups and 27
  Risk warnings. Naming the 50-member scan as its baseline shows only Not comparable (Universe). In
  the browser, **Reload local scan** switched 50 → 90 → 50 → 90 without a page refresh, and all 90
  rows matched the snapshot on rank, symbol, score and setup. All five earlier TradingView snapshots
  still reproduce. Next: the 9 Nov comparison above.

- **2026-11-07 · Reload the published TradingView scan in place · Merged in
  [#142](https://github.com/blackhebrewisraeli/Popup/pull/142) (`abcc241`).** Decision:
  the import query never re-read the file, and the header's refresh re-reads market data only, so a
  newly published scan stayed invisible on an open page. **Reload local scan** re-reads the dev route
  on request in every state; the header refresh is hidden while the review is open. A changed file
  replaces the whole snapshot and starts the review over; an identical one keeps it. A failed reload
  keeps the earlier scan under an alert naming it; a removed file shows the empty state. The query is
  `staleTime: 'static'`: TanStack Query marks kept data invalidated after a failed fetch, which made
  focus or a source switch re-read the file by itself. Evidence: labeled fixture scans A and B
  published into a scratch store with the app's own publish function, served by the existing route on
  a separate dev server. A then B without a page refresh, identical, malformed, truncated, removed,
  server stopped, simulated HTTP 500, five rapid clicks (one read), source switch mid-read, keyboard,
  light and dark, and phone width were checked in the browser. Each click read only the local route;
  background market-data polling continued as before. Next: use it after the next real scan.

- **2026-11-07 · Fresh-scan verification after #140 · Local real-data run on main `e1b0719`; field
  names fix merged in [#141](https://github.com/blackhebrewisraeli/Popup/pull/141).** Evidence: an agent-initiated TradingView retrieval through the runbook
  helpers captured 50 of 50 with no failures. One same-millisecond file collision was rejected and
  retried. The 6 Nov session was evaluated, outcome `COMPLETE`, offline `MATCH`, 0 Long setups and
  16 Risk warnings. For every asset, the committed map, the request, TradingView's response, the
  stored input and the result name the same exchange-qualified symbol. A second finish printed
  `ALREADY_IMPORTED` and left all 66 private files byte-identical. All four legacy imports still
  reproduce `MATCH` and were passed over for `Exact symbol`, so the result is `NO_BASELINE`. That
  is expected, and Research says why. In the browser, all 50 rows matched the snapshot on rank,
  symbol, score and setup. Evidence for 8 assets, filters, Compare, source switching, keyboard
  order and the phone sheet were checked too. The "unnamed form fields" item was Chrome's autofill
  issue (no `id` or `name`), not a missing accessible name. Every field was already labeled. The
  scan filters and Compare boxes now carry a `name`, and Chrome reports no issue. Next: the first
  new-session comparison, as above.

- **2026-11-07 · Exact TradingView symbol in scan evidence · Merged in
  [#140](https://github.com/blackhebrewisraeli/Popup/pull/140).** Decision: snapshots kept only the
  generic `US:<ticker>`, so a different listing of the same ticker could read as a setup change. Each
  input now records `providerSymbol` (requested; validated only when the response was accepted),
  inside the input hash. A changed or unrecorded symbol makes the pair Not comparable. Legacy
  snapshots are refused as baselines, never re-derived from today's map and never rewritten.
  Evidence: labeled fixtures cover same and changed symbols, tampering, legacy, automatic and named
  baselines and unchanged numbers. Locally, the four private TradingView snapshots still reproduce
  `MATCH`, and the published legacy view shows Not comparable (Exact symbol) in the browser. Next:
  after merge, the first comparison needs two new-format imports on different sessions.

- **2026-11-07 · First practical owner scan · Completed locally on main.** A fresh owner-initiated
  TradingView retrieval evaluated the fixed 50-instrument universe with full coverage, reproduced
  offline, selected a verified earlier-session baseline automatically and published the local
  Research view. Source, session, coverage, comparison-gap language, changed-result evidence,
  no-setup evidence and same-cohort comparison were checked in a browser. No scanner blocker was
  found; one non-blocking browser accessibility issue remains for unnamed form fields. Personal
  decisions and market artifacts remain in a git-ignored local journal. **Next:** the owner should
  complete the walkthrough and record their own understanding, unclear points and decision before
  observing later outcomes.

- **2026-11-07 · Scan comparison · Merged in #137.** Compare a named earlier TradingView import.
  The PR records offline reproduction and an independent aggregate check. The next coding
  follow-up is selecting a verified baseline during refresh.

### Entry template

```text
Date · Task · Status · PR / commit
Decision: what changed and why
Evidence: what was checked and what remains unverified
Next: one concrete step or blocker
```
