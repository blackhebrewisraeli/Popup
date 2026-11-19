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

- **2026-11-19 · Supabase Edge preflight for daily discovery (not deployed) · Branch `feat/discovery-preflight-function`, from `9c00896`.**
  - **Observed (read-only):** the deployed `crypto-price-feed` v13 matches the repository. Its pg_cron job pins `x-region: eu-west-1`. Over 24 hours, 95 edge invocations were served from `eu-west-1`, all HTTP 200, and 96 run summaries each updated 5/5 tickers, with no upstream errors. That covers the filtered ticker only, not the discovery endpoints. Owner-invoked `binance-spot-account` calls were served from `eu-central-2`.
  - **Changed:** `supabase/functions/discovery-preflight` (secret key, `eu-west-1` only, the two policy URLs once each, aggregate answer, no database client) and `[functions.discovery-preflight] verify_jwt = false`. 18 synthetic tests cover refusals, upstream failures, malformed bodies, timeouts, no-proxy and no-storage, with counts cross-checked against the collector's parsers; 10 mutations are caught.
  - **Not done:** not deployed, not invoked; deployed reachability of the two endpoints is NOT established. Discovery stays disabled; no user, secret, cron, migration or row.
  - **Next:** owner merges, deploys and invokes once ([docs/MARKET_SCANNER.md › Supabase Edge preflight](MARKET_SCANNER.md#supabase-edge-preflight-not-deployed)).

- **2026-11-19 · Daily discovery released; activation blocked by HTTP 451 · Docs-only PR, branch `docs/daily-discovery-release-record`, from `9c00896`.**
  - **Result:** #200 merged as `9c00896`; its production deployment is `READY` and the contract check reports 33/33 migrations. Synthetic acceptance passed on the GitHub-hosted runner; both Binance preflights answered HTTP 451 ([docs/MARKET_SCANNER.md › Activation](MARKET_SCANNER.md#activation)).
  - **Not done:** no `discovery_automation` user, no `SUPABASE_DISCOVERY_*` secrets, `DAILY_DISCOVERY_ENABLED` unset, no batch or attempt rows. Experiment, entry, fill, paper, signal, trade and campaign-storage hashes and every other Actions variable and secret were the same before and after.
  - **Next:** owner decision on a runner in a region Binance serves for `binance-preflight` and `collect`, then resume at activation step 4. No proxy or provider change.

- **2026-11-19 · Daily discovery batch and Research › Daily candidates · Draft PR [#200](https://github.com/blackhebrewisraeli/Popup/pull/200), branch `feat/daily-discovery-candidates`, from `8b030ef`.**
  - **Changed:** policy `binance-spot-usdt-liquidity-v1` (`src/lib/dailyDiscovery.ts`) is a liquidity shortlist, not a score: TRADING, spot-enabled USDT pairs minus `crypto-usdt-v1`'s recorded stablecoin bases, the top 50 by rolling 24h quote volume, compared as exact decimals. Collector `scripts/dailyDiscovery.ts` runs from the separate `daily-discovery.yml` workflow, disabled until `DAILY_DISCOVERY_ENABLED`. Migration `20261119120000` adds insert-only, immutable `discovery_batches` and `discovery_attempts`: the `discovery_automation` role writes them, `is_binance_spot_owner()` reads them. The board verifies the hash and re-derives the members before showing a batch.
  - **Evidence:** 102 vitest tests (collector in Node, end-to-end collector → board), 73 pgTAP assertions, a concurrency race, `upgrade.sh origin/main`, a local real-stack run (GoTrue role claim, real RLS, synthetic Binance) and 28 caught mutations. Review fix on 2026-11-19: the database's evidence check now fails closed (`discovery_evidence_consistent`), and the board re-validates stored inputs and collection times before re-deriving. Both sets of regressions failed at `48aaff1`, and the valid synthetic batch's hash is pinned unchanged. Browser checks covered desktop, 375 px, light, dark and keyboard. Full local runs hit 5 s timeouts in unrelated suites under heavy machine load (also on clean `main`); CI decides.
  - **Readings:** freshness is Current for 24 h from the slot, then awaiting or failed until the next 06:00 UTC deadline, then Stale (29 h 30 min after its own slot). The 24h figure is rolling, not a UTC day. Stablecoins outside the recorded list read Not classified.
  - **Not done:** no production migration, user, secret, variable, schedule or batch. No campaign, notification, trading setting, `assets_status` or research universe was touched. Binance reachability from GitHub-hosted runners is unknown (451 risk).
  - **Next:** owner review; `supabase db push` before merge (docs/RELEASE.md); then activation as a separate decision (docs/MARKET_SCANNER.md#activation).

- **2026-11-18 · Swing-structure study run and reproduced · Docs-only PR, branch `docs/swing-structure-study-result`, from the run commit `17370f1`.**
  - **Result:** primary L5R5 / 20 days / G0 is **INCONCLUSIVE**. M −0.0138, ℓ = 4 interval −0.0518 to +0.0242, ℓ = 8 −0.0543 to +0.0268. All seven gates FALSE, none UNAVAILABLE. Every interpretability condition holds, and there are no exclusions. Aggregates are in [the spec's page](SWING_STRUCTURE_EVALUATION.md#recorded-run-2026-11-18).
  - **Evidence:** `npm run evaluate -- swing-structure-evaluation` at `17370f1` on a clean tree: run 1 `CREATED`, run 2 `UNCHANGED`, both `0c66a85f…`. The primary M, U, Dn, hit excess and all 114 terms were recomputed independently from the export's opens and matched to about 1e-15.
  - **Readings:** the result names `17370f1`, so reproduce there. At this document's commit or later the runner reports `CONFLICT` by design. The export and the result stay local and git-ignored.
  - **Not done:** no strategy, alert, model, experiment record, account or production service was touched. Nothing is selected from the exploratory cells. The result says nothing about TRXUSDT or the owner's experiment.
  - **Next:** owner review and merge of the docs PR. Any further study needs its own frozen specification.

- **2026-11-18 · Swing-structure study runner, synthetic data only · Draft PR [#198](https://github.com/blackhebrewisraeli/Popup/pull/198), branch `research/swing-structure-evaluation-runner`, from `2c98580`.**
  - **Changed:** `scripts/swingStructureEvaluationRun.ts` and `npm run evaluate -- swing-structure-evaluation` (no options). The runner checks, in order, the spec through the existing validator, the candidate's working-file blobs, a tracked tree matching `HEAD`, and the export's sha256 before parsing. It then checks the metadata and the five members' symbols and input hashes, and maps them with `tradingViewCryptoCandles`. After the unchanged analysis, it writes `{ manifest, results }` once through `saveResearchResults`.
  - **Evidence:** `swingStructureEvaluationRun.test.ts` (30 tests) uses synthetic exports in temporary directories, plus one CLI test. 13 mutations (each identity check removed, an export re-read, two kinds of overwrite, CLI options accepted) were each caught. The full suite, typecheck, lint and build pass.
  - **Readings:** the commit is inside the result, so a rerun at another commit reports `CONFLICT`. Details are in [the spec's page](SWING_STRUCTURE_EVALUATION.md#running-the-study-runner-verified-on-synthetic-data-only).
  - **Not done:** the study was not run. No export, real candle, outcome or experiment record was read. The spec, candidate, `candleValidation.ts` and the analysis module are unchanged.
  - **Next:** owner review and merge. Then, only if the owner decides, run the command on a clean `main` checkout.

- **2026-11-18 · Swing-structure evaluation module, synthetic data only · Draft PR [#197](https://github.com/blackhebrewisraeli/Popup/pull/197), branch `research/swing-structure-evaluation-impl`, from `88a5e92`.**
  - **Changed:** `scripts/swingStructureEvaluation.ts` computes A, B and C of spec `99fff590…` on in-memory candles. It covers the timing invariants, the look-ahead check, outcomes, observation-specific base rates, M and its robustness gates, frozen-reference breaches, the SHA-256 block bootstrap and the classification. It loads only that specification.
  - **Evidence:** `swingStructureEvaluation.test.ts` (61 tests) uses synthetic candles only. It covers hand-worked weights and ties, the pinned draw vectors, every classification and unavailable state, and a synthetic run through the frozen schedule with deterministic output. Ten mutations of look-ahead, eligibility, reference and bootstrap were each caught. The full suite, typecheck, lint and build pass.
  - **Readings:** open details are listed in [the spec's page](SWING_STRUCTURE_EVALUATION.md#analysis-module-verified-on-synthetic-data-only). None changes a threshold or gate.
  - **Not done:** the study was not run. No export, real candle, outcome or experiment record was read. The spec, candidate and `candleValidation.ts` are unchanged.
  - **Next:** owner review. Then, as a separate task, a real-data runner: read and verify the export, record the blob ids and write once through `saveResearchResults`. It runs only if the owner decides.

- **2026-11-18 · Swing-structure evaluation specification v1 (proposed, revision 2) · PR [#196](https://github.com/blackhebrewisraeli/Popup/pull/196), branch `research/swing-structure-evaluation-spec`, from `9a5ba29`. Docs and one structural test.**
  - **Revision 2 (review):**
    - **Interval:** the AR(1)-inflated t interval is replaced by a moving block bootstrap over whole grid dates. Blocks are 4 and 8 positions, with 10,000 replicates and SHA-256 seeded draws. Base rates and every statistic are recomputed in each replicate.
    - **60-day cells:** no interval.
    - **Base rate:** it leaves out the earlier windows inside each observation's input, so the signed excess is mean-zero under a stated random-walk null.
    - **Gates:** UNAVAILABLE states are explicit, and U, Dn, leave-one-out and phase checks are named robustness gates.
    - **Unchanged:** the candidate, pairs, dates, configurations and horizons.
    - **Spec ID:** now `99fff590…`.
  - **Changed:** [`swing-structure-evaluation.v1.json`](swing-structure-evaluation.v1.json), with its [explanation](SWING_STRUCTURE_EVALUATION.md), fixes one retrospective study of `swing-structure-direction` 0.1.0 before any run.
    - **Data and universe:** the existing `crypto-usdt-v1` TradingView export, hash-pinned, on the first five pairs by market cap. TRX is sixth and not a member.
    - **Timeframe and window:** UTC daily bars, a 180-candle window, 759 daily dates for coverage.
    - **Primary analysis:** a 38-date, 20-day grid with non-overlapping outcome windows. L5R5 at 20 days is the primary cell; three more configurations and the 5- and 60-day horizons are exploratory.
    - **Baseline and classification:** the outcome is a signed excess over each pair's own base rate. Interpretability minimums and an INFORMATIVE / INCONCLUSIVE / ADVERSE rule are fixed in advance.
    - **Timing:** pivot time, `availableAt`, `establishedAt`, the cutoff and breach `knowableAt` are kept apart. The reference is frozen at the observation. A breach before the observation is its own category, never a forward outcome.
    - **Test:** `scripts/swingStructureEvaluationSpec.test.ts` checks the spec's self-hash, its agreement with the candidate, provider and universe constants and with the recorded export hashes, its date arithmetic, the base-rate exclusion counts, the interval-horizon rule, and known-answer bootstrap draws.
  - **Not done:** no run, data read or result. Only the export's sha256 was recomputed, to confirm identity. No candidate, model, UI, worker, Pine or experiment change.
  - **Next:** owner review. Then, not started, the analysis module on synthetic fixtures, committed before it reads the export.

- **2026-11-18 · Swing-structure research candidate (`swing-structure-direction` 0.1.0) · Draft PR [#195](https://github.com/blackhebrewisraeli/Popup/pull/195), branch `research/swing-structure-candidate`, from `53249bb`. Offline research only.**
  - **Changed:**
    - An exact [candidate contract](MANUAL_SPOT_EXPERIMENTS.md#research-candidate-swing-structure-swing-structure-direction-010), written before the code.
    - `scripts/swingStructure.ts`, one pure function that implements it. Its inputs are a supplied closed-candle series, a stated timeframe, required left and right bar counts, and a cutoff.
    - It reports Up, Down or Unclear from the two latest confirmed pivot highs and lows. Each pivot carries its candle time and the time it became knowable.
    - It names a structural reference: the latest higher low for Up, the latest lower high for Down.
    - Separately, it reports the first close and the first extreme beyond that reference. A breach changes no direction and is no action.
    - Two codes join the candle issue union. No existing check changed.
    - Nothing in the app, worker, Pine, portfolio or experiments calls it. No model, scanner, threshold, frozen contract, migration or request changed.
  - **Evidence:**
    - 34 synthetic tests cover the contract's cases, including prefix invariance and immunity to later candles.
    - Two look-ahead mutations were each caught. Reading pivots from candles after the cutoff fails 6 named tests, including 10 and 11. Dating a pivot at its own candle fails 13, including 7.
    - The code was restored byte-identical. Typecheck, build, lint and the full suite pass.
  - **Not done:** no market data read and no parameter chosen. Passing shows causal behavior, not usefulness.
  - **Next:** owner review. Proposed, not started: freeze an evaluation spec before replaying any data. It would fix the pairs, the period, the left/right grid and the base rate in advance.

- **2026-11-18 · Two trading paths proposal (intraday, weeks to months) · PR [#194](https://github.com/blackhebrewisraeli/Popup/pull/194), branch `docs/two-trading-paths-proposal`, from `82ef781`. Docs only.**
  - **Changed:** [Two trading paths](MANUAL_SPOT_EXPERIMENTS.md#two-trading-paths-proposal-for-owner-review) proposes product behavior for owner review. It covers:
    - a lifecycle table for entry, holding, adding, reducing and exiting;
    - a comparison of the two paths;
    - budget, risk and holdings;
    - five synthetic examples;
    - candidate rules, each with a rationale and a proposed evaluation.

    Direction, movement, invalidation and money stay separate, and so do a Risk flag, bearish evidence, exiting a Long and opening a Short.

    After the owner's review, the section also:
    - assesses counter-movement from the entry reference and the stated structure, never from candle colour;
    - states that volatility does not set a structural level;
    - separates a close-based invalidation, the scenario's stop reference and a real protective order. The scenario's planned loss does not cap a close-based exit.

    It records the owner's destination: an explained direction and invalidation proposal derived from an evaluated rule, with owner-entered levels as interim planning only. It also records the recommended order: weeks to months first, keeping intraday in the design. Nothing is approved or implemented. No formula, threshold, Pine script, policy or frozen study changed, and no paper policy is adopted for real money.

  - **Evidence:** links and anchors checked, Prettier clean, `npm run build` passes.
  - **Not done:** the budget decision; every candidate rule is unevaluated.
  - **Next:** owner review. The smallest follow-up shows the stop distance as a multiple of the evaluated day's ATR(14) in the Manual Spot scenario. Not started.

- **2026-11-17 · Review another saved scan inside a Manual Spot experiment · Draft PR [#193](https://github.com/blackhebrewisraeli/Popup/pull/193), branch `feat/experiment-scan-review`, from `290f84d`. No migration.**
  - **Changed:** an opened experiment gains a closed [Review another saved scan](MANUAL_SPOT_EXPERIMENTS.md#reviewing-another-saved-scan) disclosure. The owner chooses one saved crypto scan file. Research's own check (`useSavedScanFile`, the finance worker) verifies it, and only then is the experiment's exact pair, matched by validated instrument, shown beside the stored copy: **Entry evidence, as recorded** and **Selected scan evidence**. The view names the file (bytes matching the referenced snapshot hash, which identifies the file only and never checks the copied facts; the same scan ID; or another scan) and model and timeframe comparability. Candle order is always **Unknown**: a version 1 copy keeps the entry candle as a day and month without a year, and no year is guessed. The selected candle's full close time is shown on its own. A missing, failed or unreadable side has its own state. In component memory only; replacing, closing or collapsing clears it. No request, write, schema or model change.
  - **Evidence:** 12 integration tests. Restoring the earlier guessed-year order fails four named regression cases (same day and month, more than a year later, year boundary, leap day). Typecheck, lint, build and the full suite pass. A synthetic browser check with every off-host request answered or blocked, at desktop and 375 px, in light and dark, and by keyboard.
  - **Not done:** candles cannot be ordered until a copy stores a complete candle date (a new evidence format, not in this PR); Safari, a phone and a screen reader not checked; the owner's real files not tried.
  - **Next:** owner review of the draft PR.

- **2026-11-17 · Experiment overview first in Manual Spot experiments · Draft PR [#192](https://github.com/blackhebrewisraeli/Popup/pull/192), branch `feat/experiment-overview`, from `b4e70ba`. No migration.**
  - **Changed:** an opened experiment in Account now starts with an [Experiment overview](MANUAL_SPOT_EXPERIMENTS.md#viewing-in-account). It shows:
    - the decision and its times;
    - the entry evidence copied when the experiment was recorded, labelled historical: ZC LONG and ZC RISK side by side, and missing facts unknown;
    - rule status from the existing supersession;
    - linked buy and sell counts, labelled not a holding;
    - the explicit close, which is not evidence of a sale.

    Scan, hash, reproduction, authenticity and every copied fact sit in one closed **Provenance and copied evidence** disclosure. The close review keeps its summary. Presentation only: no request, payload, schema or rule change.

  - **Evidence:** typecheck, lint, build and 2,056 tests. The browser check was synthetic, with every off-host request answered or blocked, at desktop width and 375 px, in light and dark, and by keyboard. Opening the record sent no request.
  - **Next:** the owner's three lifecycle decisions are still open. This PR does not adopt the proposed labels.

- **2026-11-17 · Decision lifecycle contract for Manual Spot experiments · Open PR [#191](https://github.com/blackhebrewisraeli/Popup/pull/191), branch `docs/decision-lifecycle-contract`. Documentation only.**
  - **Changed:** a [decision lifecycle](MANUAL_SPOT_EXPERIMENTS.md#decision-lifecycle-current-behavior-and-proposed-product-contract) section: each policy's condition and actual consumer (score, Pine bands, setups, Pine transitions, profile eligibility, sizing, tactical signals, rebalance, experiments, Binance reads), entry → closure with what is implemented and not defined, and proposed display wording. It separates the TypeScript implementation from Pine's bounded-equivalent one, and an owner exit rule from linked sells and from the `close` entry. [Product status](PRODUCT_STATUS.md) now says the real-money manual trial is underway. No code, threshold, model, schema or experiment change; no strategy approved.
  - **Evidence:** callers traced by symbol; both synthetic examples computed with `scoreFactors` (64 NEUTRAL; 67 HIGH_VOLATILITY with Risk). Prettier and link checks.
  - **Next:** owner's three decisions in the section, then the display-only record-summary task it recommends.

- **2026-11-17 · Product tour matches the current workspace · Merged in [#190](https://github.com/blackhebrewisraeli/Popup/pull/190) as `4e91384`. No migration.**
  - **Changed:** six steps in task order (`src/lib/tourSteps.ts`): workspace tabs; Research › Scan (closed daily candles, live prices are not intraday signals, only crypto scanned); Score, Long and Model Risk as separate facts (neither a buy nor a sell instruction); Open saved crypto scan (historical, no new scan or refresh); Manual Spot experiments on the Account tab (real trades placed by hand, owner account only, Popup never places orders); Paper Desk and Build Portfolio on the Paper Desk tab (simulated). Each step anchors to the first shown of its `data-tour` targets and ends at an always-shown header tab, so no step needs data, a file, a balance or the owner check. The tour only ever switches to Research › Scan (never Paper Desk or Account: leaving Research drops an opened file, and Account starts a Binance read), waiting up to 2.5 s for a preferred target. `TourGuide` draws its own token-styled tooltip (the old `.tour-*` CSS was unused; Joyride rendered inline colors), blocks clicks through the spotlight, ends on Escape, Skip and Finish by unmounting, and returns focus to Tour. Old showcase targets (`markets`, `robo`, `sim-portfolio`, `pnl-attribution`) removed.
  - **Evidence:** new library and Joyride behavior tests (delayed route, missing-target fallback, Back, Skip/Escape/finish cleanup, restart, repeated clicks, no action or request); four mutations each failed a test. Typecheck, lint, build and the full suite pass. Browser walkthrough of all six steps on a synthetic dev stack with every non-local request blocked: dark and light, 1280 and 375 px, keyboard only, starts from Research, Markets directory, Paper Desk and Account, loading, error and failed-scan states, a synthetic saved file open, owner and non-owner Account answers; zero requests added by the tour, contrast ≥ 4.8:1 for text in both themes.
  - **Not done:** Safari, a phone and a screen reader not checked; the scrim stays black in both themes (an SVG fill cannot read a token, and dialogs use the same).
  - **Next:** owner review of the draft PR.

- **2026-11-17 · Open a saved crypto scan file in the hosted app · Merged in [#188](https://github.com/blackhebrewisraeli/Popup/pull/188) as `293e476`. No migration.**
  - **Changed:** **Open saved crypto scan** in Research (every build) takes one original `<scan ID>.json` TradingView crypto snapshot from the owner's disk, at most 4 MB ([contract](MARKET_SCANNER.md#opening-a-saved-crypto-scan-file)). The finance worker hashes the bytes with Web Crypto, then reproduces them with the scan store's own check, now shared in `src/lib/scanSnapshot.ts` (`stableSerialize` moved to `src/lib`, unchanged). Only a crypto-only `tradingview-crypto-daily-v1` scan with exact Binance Spot USDT symbols opens; views, other sources, equity, legacy and edited files are refused by name. A verified file shows the existing review in the scan's place, snapshot-only, marked **Opened from a file you chose**, and records through the unchanged Manual Spot flow and owner check. The file stays in memory; replacing or closing it drops the review, draft and late answers. Wording changed only where it said the import is re-read from a local server.
  - **Evidence:** Node/browser parity, tampering and refusal tests, UI lifecycle and recording tests; typecheck, lint, build, the full suite and 289 SQL assertions. A production build on a scratch stack with every non-local request blocked: verify, review, record once, Account, non-owner refused, no dev-route request ([verification](MANUAL_SPOT_EXPERIMENTS.md#verification-of-opening-a-saved-scan-file--2026-11-17)). The owner's four real crypto snapshots verify with the same hashes in both paths.
  - **Production (2026-11-17):** read-only acceptance passed in the owner's signed-in Chrome. The production alias serves the deployment of `293e476`: every chunk of the served page matches a local build of that commit apart from Vercel-injected environment values, and the finance worker is byte-identical. The original source file of the existing TRXUSDT experiment hashes to its recorded source hash, opened and reproduced in the hosted app, and every displayed rank, score and setup equals the snapshot; it is labelled historical and from a file, with cutoff, source, model, candle policy, stale and incomplete warnings shown and missing retrieval, selection and alert metadata named as not recorded. Opening, checking, reviewing and the scenario made no request and wrote no browser storage, and no dev-route request was made. Opening Record experiment made one owner check; the background market-status poll was unchanged. With synthetic inputs, the inclusion box was off by default, a scenario change after Review record locked Confirm with "Nothing was sent", and the draft was discarded unconfirmed. Account showed the experiment with the same scan and hash, its linked buy, two approved rules, one observation and **No scenario recorded**. Database row counts and row hashes of experiments, entries and fills were identical before and after; the file was unchanged.
  - **Not done:** a new scan still needs the owner's agent session; Safari, phone and screen reader not checked. Coverage reads "2 failed" for two short-history pairs (wording from #128; the not-evaluated list names the reason).
  - **Next:** none for this feature.

- **2026-11-17 · Optional scenario snapshot on new Manual Spot experiments · Merged in [#187](https://github.com/blackhebrewisraeli/Popup/pull/187) as `49b0903`. Migration `20261117120000` applied before merge.**
  - **Changed:** **Include this scenario in the record** (off by default) in Record experiment. On, Review record needs a valid planner result and shows one frozen [snapshot](MANUAL_SPOT_EXPERIMENTS.md#scenario-snapshot): input strings as typed (unspecified fee `null`, stated zero `"0"`), figures as shown, format 1 and calculation `spot-scenario-1`. Confirm sends that copy; a change to the scenario, scan file or pair after review locks Confirm. Account shows it as stored, or **No scenario recorded**, or names an unsupported or unreadable one. The migration adds a nullable `scenario_snapshot` column, a shape check (not arithmetic) and an insert grant; no backfill, RLS and append-only unchanged. Arithmetic, model and rules unchanged; no rule is created.
  - **Evidence:** 289 pgTAP assertions (54 new), both upgrade paths (`upgrade.sh` now seeds experiment rows when the base has them; CI also upgrades from main), concurrency, five weakenings caught; typecheck, lint, build and 2,002 tests; a scratch-stack browser check at desktop and 375 px ([verification](MANUAL_SPOT_EXPERIMENTS.md#verification-of-scenario-snapshots--2026-11-17)).
  - **Released 2026-11-17 (UTC):** migration pushed from `9c024db`, then merged; production deployment of `49b0903` is `READY` and a later contract check reports all 32 migrations ([what happened](RELEASE.md#manual-spot-scenario-snapshot-20261117120000)).

- **2026-11-16 · Research evidence: open summary, closed sections · Draft PR, branch `feat/research-evidence-sections`.**
  - **Changed (display only):** the evidence opens on a **Summary** (instrument, last evaluated, rank, score, Long, Model Risk, main reasons) that keeps the stale, incomplete-scan and unconfirmed-symbol warnings in the open. The rest sits in four sections, closed by default: **Model conditions**, **Indicators and score calculation**, **Score contributions relative to the Long threshold** and **Data provenance and limitations** ([reviewing a scan](MARKET_SCANNER.md#reviewing-a-scan)). Each fact has one place; the Pine alert, stale and incomplete lines no longer repeat. Contributions are always weighed against 78 (`longContributions`), with **Supports / Weakens: component above / below 78** defined as arithmetic only. A Risk-focused result's existing ZC RISK weighing moved under Model conditions as **Toward the model Risk flag / Away from it**. Regime is labeled a classification that selects the weights, momentum as MACD's direction. "Fits … profile" now reads "Meets the … profile rules", stated as not a suitability assessment. The Manual Spot scenario sits after the review in its own block, unchanged inside. No scanner, model, threshold, storage, save or Account change.
  - **Evidence:** new component and library tests; typecheck, lint, build and the full suite pass. Browser check on the saved crypto scan and Market data: both sources and switching, asset switching (scenario input cleared), disclosures by Enter/Space and Tab, sheet Tab containment and focus return at 375 px, contrast in both themes. Saved scan `20261115T210347Z-dc217757` still reproduces `MATCH`, files unchanged.
  - **Next:** owner review of the draft PR.

- **2026-11-15 · Research clarity: which scan, where to start, what a candidate says · Draft PR, branch `feat/research-clarity`.**
  - **Changed (display only):** a **What this view shows** note heads each scan: **Live browser check** (not saved, no scan ID) or **Saved TradingView scan** with its scan ID, candle source, data as of, evaluated scope and retrieval or compute time, and study eligibility stated as separate ([reviewing a scan](MARKET_SCANNER.md#reviewing-a-scan)). One primary **Start review** opens the top candidate's existing evidence. Candidate cards state Rank, Score, Long (**Long conditions met / not met**, both thresholds) and Model Risk (**No model Risk flag** / **Model Risk flag: …**) from `candidateStatus`, with the blend terms behind a **Score contributions** disclosure. "Short of ZC LONG" now reads "Long conditions not met". Manual Spot says a review is not a trading decision, and **Record experiment (saves to Account)** names when it saves. No scanner, model, threshold, source default, persistence or save-behavior change.
  - **Evidence:** updated and new component and library tests; typecheck, lint, build and the full suite pass. A browser check covered both sources and switching, Start review (panel and narrow sheet with focus return), the disclosure by keyboard and 375 px. A saved crypto scan still reproduces `MATCH`.
  - **Not done:** Account cards; the evidence panel's ZC LONG / ZC RISK headings and its "What supports and weakens it" wording.
  - **Next:** owner review of the draft PR.

- **2026-11-14 · Scenario against TRXUSDT perpetual filters · Draft PR, branch `feat/perpetual-filter-comparison`.**
  - **Changed:** a third Account card, after the public contract data, compares the simulation's current result with the last validated TRXUSDT snapshot, only when **Compare this scenario with TRXUSDT perpetual** is pressed ([filter comparison](LEVERAGE_SIMULATION.md#filter-comparison)). Quantity against LOT_SIZE and MARKET_LOT_SIZE separately, the entry and exit fills against PRICE_FILTER, and the simulated entry notional against MIN_NOTIONAL: 13 exact-decimal checks, each with its compared value, reported constraint and "within this constraint", "outside this constraint" or "not checked". Missing, malformed, disabled (PRICE_FILTER 0) and contradictory filters are named. A snapshot older than 60 seconds (Popup policy) withholds every conclusion; an edit or a new read clears the comparison. No request, storage, rounding, input change or overall verdict. The engine now also returns `entryFill`.
  - **Evidence:** new library and component tests, an Account placement assertion, and twelve mutations that each failed a test; typecheck, lint, build and the full suite pass. A browser check with every non-local request blocked and fapi answered from fixtures covered keyboard, the live 60-second flip, invalidation, 375 px and both themes.
  - **Not done:** no live Binance response checked, no PERCENT_PRICE or mark-price check, no account data.
  - **Next:** owner review of the draft PR.

- **2026-11-14 · Public TRXUSDT perpetual contract data beside the simulation · Merged in [#180](https://github.com/blackhebrewisraeli/Popup/pull/180) as `5bd5284`.**
  - **Changed:** a separate Account card, right after Leverage simulation, reads public facts about the Binance USDⓈ-M TRXUSDT perpetual only when **Read public contract data** is pressed: one unsigned GET each to exchangeInfo, premiumIndex, ticker/price v2 and fundingInfo, from the browser, with a 10-second timeout and no retry, proxy, storage or Supabase call ([public contract data](LEVERAGE_SIMULATION.md#public-contract-data)). It shows the validated identity and status, mark and last price apart, the reported funding rate and next funding time, the published funding schedule when fundingInfo lists TRXUSDT, the price, lot-size and minimum-notional filters, and the liquidation fee rate as context, each with its source, local receipt time and provider time. Fees and brackets read "Account-specific — not read; enter manually." It never fills or changes the simulation.
  - **Evidence:** new unit and component tests plus an Account placement test; typecheck, lint, build and the full suite pass. A browser check with every non-local request blocked and the four endpoints answered from fixtures covered keyboard, partial failure, an unsupported contract, 375 px and both themes.
  - **Not done:** no prefilling, no account data. Filter checks followed in the entry above.
  - **Production (2026-11-14):** acceptance passed on the deployment of `5bd5284` in the owner's signed-in Chrome: no fapi request on load, exactly four unsigned GETs per press, every displayed field equal to the raw responses, no automatic refresh, old results cleared on a second press, and nothing stored. Binance currently lists TRXUSDT in fundingInfo, so the "Not published" state is covered only by tests.

- **2026-11-14 · Leverage simulation in Account · Merged in [#179](https://github.com/blackhebrewisraeli/Popup/pull/179) as `f6c44e9`.**
  - **Changed:** Account has a separate **Leverage simulation** card, outside the Binance Spot card. It shows `simulatePerpetualLong` figures for numbers typed there, grouped into position, costs and maintenance assumptions. Fields start empty, and the card holds no defaults or advice. It shows both liquidation references or a plain reason for each unavailable status, and it warns about exhausted collateral or a stop or exit at or below a reference. Each comparison carries the shared-price note ([in Account](LEVERAGE_SIMULATION.md#in-account)). No storage, network, migration, Binance request or order control.
  - **Evidence:** 19 component tests check the screen against engine output; typecheck, lint, build and the full suite pass. A browser check used synthetic inputs, with every non-local request blocked before load: keyboard, status and errors, light and dark themes, and 375 px.
  - **Not done:** no Isolated Margin model, no market data, no saving. Not checked with a screen reader or on a phone.
  - **Production (2026-11-14):** acceptance passed on the deployment of `f6c44e9` with synthetic inputs: all fixture checks, keyboard, 375 px, both themes, and no request or storage from the simulator.

- **2026-11-14 · Offline perpetual long scenario engine · Merged in [#178](https://github.com/blackhebrewisraeli/Popup/pull/178) as `86aa6cb`.**
  - **Changed:** `src/lib/perpetualScenario.ts` works out one isolated USDT-margined perpetual long from owner-typed inputs only: quantity, notional, fees, a signed carrying cost, equity at a hypothetical exit fill, net result and change against starting collateral. It also gives a simplified liquidation reference, both zero-cost and after costs, only when the inputs and the entered bracket hold together ([contract, derivations and limits](LEVERAGE_SIMULATION.md)). No UI, storage, network, scanner change or Spot integration.
  - **Evidence:** 48 tests cover the module fully, including the negative-requirement refusal found in review. Fixture values were cross-checked with an independent exact-fraction computation. Typecheck, lint, build and the full suite pass. No Binance request and no production access.
  - **Not done:** no Isolated Margin model, no market data. Outputs are not Binance-verified liquidation prices or achievable executions. The UI followed in the entry above.

- **2026-11-14 · Close a Manual Spot experiment record in Account · Merged in [#177](https://github.com/blackhebrewisraeli/Popup/pull/177) as `ce65b84`.**
  - **Changed:** **Close experiment record** stores the owner's one append-only close (reason, optional UTC stated time) after a review that repeats a factual record summary and says closing places no order and does not show the Binance position is closed ([closing](MANUAL_SPOT_EXPERIMENTS.md#closing-in-account)). Account shows that summary for every experiment. Rules, observations and fills recorded after a close stay visible and are marked so. The rule, observation and close forms share one save hook. Existing schema; no migration.
  - **Evidence:** 7 new tests; typecheck, lint, build and the full suite pass. A scratch `zcclose` stack checked refusal, triple Confirm, a concurrent close, a dropped response, later evidence, reload, keyboard, 375 px and both themes with `ZCT*` fixtures ([verification](MANUAL_SPOT_EXPERIMENTS.md#verification-of-closing--2026-11-14)). Nothing touched production or Binance.
  - **Not done:** no correction or reopening of a close. No real experiment was closed.
  - **Production (2026-11-14, read-only):** the deployment of `ce65b84` is live. TRXUSDT · main still shows two approved rules, one observation, one linked buy and no close, and the close form shows its warning. Nothing was saved.

- **2026-11-14 · Record Manual Spot experiments and view them in Account · Draft PR, branch `feat/record-spot-experiments`.**
  - **Changed:** the saved-scan route reports the snapshot file's SHA-256 from the bytes it reproduced. **Record experiment** in the Manual Spot scenario stores the owner's decision, account label and optional stated time with the copied evidence, after an explicit review ([recording](MANUAL_SPOT_EXPERIMENTS.md#recording-from-a-saved-scan)). Account's Binance card lists experiments read-only ([viewing](MANUAL_SPOT_EXPERIMENTS.md#viewing-in-account)). `DB_CONTRACT` now requires `is_binance_spot_owner()`. No migration.
  - **Evidence:** 22 new unit tests; typecheck, lint and the full suite pass. A scratch `zcrecord` stack checked the access matrix, the embedded read and a browser record end to end with labeled `ZCT*` fixtures ([verification](MANUAL_SPOT_EXPERIMENTS.md#verification-of-the-recording-ui--2026-11-14)). Nothing touched production or Binance.
  - **Not done:** fill linking, rule and observation forms, closing. Production's owner configuration is still empty, so production shows "unavailable".
  - **Next:** after merge, the [owner configuration step](RELEASE.md#manual-spot-experiments-20261114120000), then fill linking.

- **2026-11-14 · Manual Spot experiment storage · Merged in [#171](https://github.com/blackhebrewisraeli/Popup/pull/171) as `14894a8`.**
  - **Changed:** migration `20261114120000` adds owner-only, append-only tables for one real Binance Spot experiment, with no UI yet ([contract](MANUAL_SPOT_EXPERIMENTS.md)). An experiment holds the source scan and evidence, the owner's decision, stated rules, client-submitted fill copies, dated observations and an explicit close.
    - Access needs both row ownership and the configured owner in `binance_spot_owner`. With no configuration, nobody has access.
    - No application role can update, delete or truncate.
    - Nothing references paper trading, tracked holdings, simulations or signals.
    - The TRXUSDT live-check statements now record the completed check. D3 stays unverified.
  - **Evidence:** local scratch stack only.
    - 235 pgTAP assertions, 75 of them new.
    - Upgrade checks from `origin/main` and from the pre-#79 base.
    - 19 concurrency checks.
    - 13 weakened protections, each caught by named assertions.
    - Typecheck, lint and 1,715 unit tests pass.
  - **Released 2026-11-13 (UTC)** ([release record](MANUAL_SPOT_EXPERIMENTS.md#production-release-2026-11-13)):
    - **Failed build:** #171 was merged before its migration. The first production build of `14894a8` failed at the release gate: `migration 20261114120000 is not applied`. Nothing went live, and production kept serving `01dc3e1`.
    - **Migration:** `20261114120000` was then applied from a clean checkout of `14894a8`. Production's tables, RLS, policies and grants matched a fresh local build of the same files. The release contract passed: all 31 migrations and every RPC this frontend calls.
    - **Successful retry:** a redeploy of the failed deployment built `14894a8` again, passed the gate and went live.
    - **Not set up yet:** the owner configuration (`binance_spot_owner`) is empty, so nobody can read or add an experiment. No UI exists, and the experiment tables were empty at release.
  - **Next:** the Account UI (now in the draft PR above), then the [owner configuration step](RELEASE.md#manual-spot-experiments-20261114120000).

- **2026-11-13 · TRXUSDT in Binance Spot executions · Merged in [#170](https://github.com/blackhebrewisraeli/Popup/pull/170) as `01dc3e1`.**
  - **Changed:** `TRXUSDT` joins the function's `SUPPORTED_EXECUTION_SYMBOLS` and the browser's `SPOT_EXECUTION_SYMBOLS`. That makes 13 pairs, still a finite allowlist, and a test now keeps the two lists equal. The reconciliation view builds its assets from that list, so it now offers TRX. No endpoint, field, storage, ledger, P&L or order path changed. `src/lib/ticker.ts`, scans, rankings and paper trading are untouched. The D3 gate (`commissionCoverage: 'unverified'`) is unchanged.
  - **Evidence:** synthetic only. One run goes handler → client parser → evidence fold → reconcile for TRXUSDT, with fees in TRX, USDT and BNB, a collapsed repeat and a commission conflict. `TRXBTC` and `trxusdt` are refused before Binance. The view requests a 10-minute UTC window. Removing TRXUSDT from either list fails four tests. Details are in [BINANCE_SPOT_ACCOUNT.md](BINANCE_SPOT_ACCOUNT.md#verification).
  - **Done 2026-11-13:** `binance-spot-account` was redeployed from `01dc3e1`, and the owner's live check of one known TRXUSDT fill matched Binance's own order view ([live check](BINANCE_SPOT_ACCOUNT.md#trxusdt-live-check-2026-11-13)). That covers one fee case. D3 stays unverified, because no commission was compared with a balance change.

- **2026-11-13 · Tab stays inside the evidence sheet · Merged in [#169](https://github.com/blackhebrewisraeli/Popup/pull/169) as `c4e1c46`.**
  - **Found:** a real-scan acceptance of **Candidates to review first** on `main` `8bd2f55`. In the 375 px evidence sheet, with **Plan a hypothetical scenario** closed, Tab from its summary left the modal for the header behind it. Shift+Tab from **Close** did nothing. Both date from the scenario disclosure (#151).
  - **Changed:** `containDialogTab` (`src/lib/dialogFocus.ts`) now counts a disclosure's summary. It skips controls inside a closed `<details>`, a `hidden` or `inert` subtree, or with `tabindex="-1"`. `aria-disabled` controls stay reachable, and `aria-hidden` still counts only on the control itself. Escape, initial focus and focus return are unchanged, and no dialog was rebuilt.
  - **Evidence:** 8 helper tests and one sheet test through a candidate; 4 of the helper tests and the sheet test fail against the old helper. A native keyboard run in Chromium at 375 px on a labeled synthetic scan went closed → open → closed with Tab and Shift+Tab, then Escape back to the candidate. All 21 focus moves stayed inside the dialog, and the old helper reproduced the escape in the same setup. Typecheck, lint, build and 1,709 tests pass.
  - **Not run:** the asset details and Robo dialogs in a browser, a physical phone, Safari, a screen reader. Rows G1–G11 are in [the acceptance notes](TRADINGVIEW_CRYPTO_ACCEPTANCE.md#follow-up-2026-11-13-tab-stays-inside-the-evidence-sheet).

- **2026-11-13 · Product page link, screenshots and Social Preview · Merged in [#168](https://github.com/blackhebrewisraeli/Popup/pull/168) as `8bd2f55`.** [#167](https://github.com/blackhebrewisraeli/Popup/pull/167) merged as `cba3d86`; its first Pages deployment is live at <https://blackhebrewisraeli.github.io/Popup/> and serves `docs/site` from `main` unchanged. This branch links that page in the README as **Product overview** beside **Hosted app**, adds two README screenshots of the running app (`docs/screenshots/`) and a 1280 × 640 Social Preview with its SVG source (`docs/branding/`). No app code changed. The screenshots show only built-in synthetic or sample data: the signed-out example scan (`DEMO1`–`DEMO5`) and the Paper Desk order ticket under the dev-only `?devAuth=1` user in Sample data mode. They were captured with Supabase pointed at an unused local port and market-data and analytics hosts blocked; method and limits are in [PAGES.md](PAGES.md#readme-screenshots). Evidence: the published page checked in Chromium at 1440 and 375 px, light and dark (no horizontal overflow, images load, skip link and focus rings); README and PAGES links and anchors resolved; local typecheck, build, lint and tests as reported in the PR. Not captured: a populated paper ledger or the signed-in Research scan, which need server-accepted fills or market data. Owner steps: upload `docs/branding/popup-social-preview.png` under **Settings → General → Social preview**, and decide whether the repository Website should become the product overview.

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
  records a local runtime check with throwaway users and a synthetic provider. On 2026-11-13 the
  owner deployed the function from `3efb2be`, configured the key and saw balances matching
  Binance's own view; one execution read returned no fills
  ([owner-observed, not agent-verified](BINANCE_SPOT_ACCOUNT.md#owner-observed-live-evidence-2026-11-13)).
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
- **Candidates to review first (2026-11-13):** draft
  [#166](https://github.com/blackhebrewisraeli/Popup/pull/166) opens each ranked class of a Research
  scan with up to five candidates: its evaluated assets in recorded rank, from the whole scan (never
  the view or filters), gated by no setup, each with exact instrument, rank, score, named Risk
  clauses, the largest term of its blend and what stands against it. **Open evidence** is the same
  selection as a row, so a TradingView crypto pair reaches the Manual Spot scenario with empty
  inputs. A candidate is prioritized for review by this model in this scan, never a recommendation;
  a stale scan reads as historical top ranks
  ([contract](MARKET_SCANNER.md#candidates-to-review-first)). Synthetic verification only.
- **Binance outcome tracking, stage D (2026-11-12):**
  [#157](https://github.com/blackhebrewisraeli/Popup/pull/157) (merged `62f4fbb`), documentation only.
  The later `ddb949b` correction was not in that merge; [#158](https://github.com/blackhebrewisraeli/Popup/pull/158)
  carried its corrected boundary, consistency and next-increment wording onto main at `bfea2e6`.
  [BINANCE_SPOT_RECONCILIATION.md](BINANCE_SPOT_RECONCILIATION.md) specifies the smallest
  account-event and reconciliation contract over the existing read-only balances and execution
  history ([#148](https://github.com/blackhebrewisraeli/Popup/pull/148), merged `54f9a6c`).
  Proposed scope: one subject asset (the base of one supported pair, never USDT or BNB) between two
  balance reads at most 24 hours apart. Opening cost is unknown unless the opening quantity is
  zero. Quantity, acquisition cost and P&L get separate statuses, and account history is never
  called complete. A matching quantity is numerical consistency only. Cost and P&L statuses stay
  specification-only until the cost method and fee policy are decided.
- **Reliable Binance execution evidence (2026-11-12):**
  [#159](https://github.com/blackhebrewisraeli/Popup/pull/159) (merged `e179bc2`) implements only the prerequisite named
  by stage D. Identity stays `(symbol, trade ID)`. Exact duplicates collapse; exact-field
  conflicts remain visible within and across pages with no authoritative variant. Pair/page and
  continuation failures accumulate for one retrieval, and explicit per-pair terminal success keeps
  "no continuation" distinct from "complete for the requested pairs and window". A successful
  explicit new retrieval starts over; a failed refresh retains the previous result unchanged.
  No provider call, endpoint, pair/window limit, persistence, reconciliation, acquisition cost or
  P&L was added. The owner's real Binance check still has not run and must settle what `commission`
  covers and whether USDT moves by exactly `quoteQty` before reconciliation work. Evidence: 1,544
  tests, typecheck, lint and build; synthetic browser checks at desktop and 375 px, light and dark,
  including keyboard continuation retry, visible conflict/failure warnings and no page overflow.
- **Binance quantity reconciliation (2026-11-12):**
  [#160](https://github.com/blackhebrewisraeli/Popup/pull/160) (merged `e74fb6c`) adds `reconcileSpotQuantity`, a
  pure function for the stage-D quantity check on one subject asset between two balance reads:
  `CONSISTENT` (numerical consistency only), `DISCREPANCY` (exact, signed, unattributed) or
  `INDETERMINATE` with every reason. Its evidence is the execution view's accumulated record, whose
  fold moved unchanged into `binanceSpotEvidence.ts`; there is no caller-supplied `complete` flag.
  Exact BigInt decimals at the recorded scales; the 60 s guard stays provisional. Synthetic fixtures
  only. No view, persistence, cost, P&L or Binance request. Do not compare a result with a real
  account until the owner's live check settles what `commission` covers (D3)
  ([section 9](BINANCE_SPOT_RECONCILIATION.md#9-quantity-reconciliation-function-implemented-synthetic-fixtures-only)).
  [#161](https://github.com/blackhebrewisraeli/Popup/pull/161) (merged `50d2d75`) cleared
  SonarCloud's three new issues on it without changing any result.
- **Binance reconciliation pipeline acceptance (2026-11-12):**
  [#162](https://github.com/blackhebrewisraeli/Popup/pull/162) (merged `3efb2be`) runs browser client → committed
  handler → synthetic Binance → client parsers → evidence fold → `reconcileSpotQuantity` on
  synthetic data. It found that the fold merged a continued answer for other pairs or another window
  (or with nothing to continue) and now refuses it as a failed continuation. Real Binance: NOT RUN
  ([acceptance record](BINANCE_SPOT_RECONCILIATION.md#synthetic-pipeline-acceptance-2026-11-12)).
- **Binance quantity reconciliation flow (2026-11-13):**
  [#163](https://github.com/blackhebrewisraeli/Popup/pull/163) (merged `836ba95`) adds a manual,
  owner-only flow to the Account card: pick one asset (never USDT or BNB), capture opening and
  closing balance reads, then retrieve that pair's guarded window page by page. D3 (what
  `commission` covers) is still unresolved after a fresh documentation check, so every result
  reads **Indeterminate — commission coverage unverified** with no figure
  ([section 10](BINANCE_SPOT_RECONCILIATION.md#10-manual-reconciliation-flow-implemented-gated-by-d3),
  [D3 check](BINANCE_SPOT_RECONCILIATION.md#d3-check-2026-11-13)). Its verification is synthetic
  only (view tests and a browser run with simulated answers). Separately, and not agent-checked, the
  owner observed the live balance read matching Binance and one empty execution read on 2026-11-13;
  no reconciliation has run against a real account.
  [#165](https://github.com/blackhebrewisraeli/Popup/pull/165) clears SonarCloud's complexity issue
  on its view without changing behavior (the fix was pushed after #163 merged and is recovered here).
- **Historical execution range (2026-11-13):**
  [#164](https://github.com/blackhebrewisraeli/Popup/pull/164) (merged `7cf01c5`) adds **Custom range (UTC)** to the
  execution view beside the rolling presets: one pair, one explicit window of at most 24 hours,
  read as UTC whatever the browser's zone, refused before any request when missing, invalid,
  reversed, zero-length, over 24 hours or in the future. Same endpoint, page size, cursor and
  evidence rules; synthetic verification only. Next on this track: the owner settles D3 from
  Binance's own views on one real fill, which can now be an existing fill found by its UTC window
  rather than a new trade. One fill covers its own fee case only.
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

- **2026-11-13 · TRXUSDT in Binance Spot executions · Draft PR [#170](https://github.com/blackhebrewisraeli/Popup/pull/170), from `c4e1c46`.** Decision: add
  one pair, at the owner's request, to the two execution allowlists only. TRX does not join the
  app-wide crypto set, and the reconciliation gate stays unverified: a fee charged in TRX, synthetic
  or real, settles nothing about what `commission` covers. Evidence: synthetic pipeline, handler,
  view and reconciliation-view tests, plus two allowlist mutations, each caught by four tests.
  Merged as `01dc3e1`, and the function was redeployed. The owner's live check of one fill then
  matched Binance ([live check](BINANCE_SPOT_ACCOUNT.md#trxusdt-live-check-2026-11-13)). D3 is
  still unverified.

- **2026-11-13 · Candidates to review first in Research · Draft PR
  [#166](https://github.com/blackhebrewisraeli/Popup/pull/166), from `378760b`.** Decision: answer
  "where do I start?" with what the scan already recorded. `shortlist` takes a class's `EVALUATED`
  results by recorded rank (score, then ticker), the first five, from the whole scan; no setup
  gate and no new score, threshold or weight. `candidateNotes` gives two lines from the recorded
  blend: the largest weight × component term, then every held Risk clause and unmet ZC LONG clause
  (the smallest term only for a Long with no Risk). Source, data time and freshness stay once in
  the scan header; the list names the scan ID and the evaluated day, a stale scan is titled
  **Historical top ranks** with the reason, a class with nothing evaluated says so, and "None holds
  ZC LONG" is said outright. Evidence: 9 helper and 13 view tests on synthetic candles (ranks and
  ties, fewer and none, exclusions, top rank without Long and with one or both Risk clauses, no
  Long anywhere, a Long ranked sixth, stale, filters, scan switch, Market data rescan, scenario
  reset, no request or storage write); six mutations each caught; a Chromium run on a
  synthetic-only scan store at 1280 and 375 px, light and dark, selection by keyboard: candidate →
  evidence → Manual Spot with empty inputs, reset on another candidate, switch to a stale saved
  scan of another universe. Not run: any real scan, the live Market data scan in a browser.

- **2026-11-13 · Explicit historical range for Binance executions · Draft PR
  [#164](https://github.com/blackhebrewisraeli/Popup/pull/164), from `836ba95`.** Decision: the
  existing server contract already accepted any `startTime`/`endTime` up to 24 hours apart, so only
  the view changed: **Custom range (UTC)** with two native `datetime-local` inputs whose values are
  read as UTC (appending `Z`), so the browser's zone never shifts them. Missing, invalid, reversed,
  zero-length, over-24-hour (exactly 24 is allowed) and future ranges are refused with the reason and
  no request. Pair and window are fixed at the start; continuation sends only the cursor through
  `nextExecutionEvidence`; any change of pair, range or time clears the evidence and drops late
  answers. The summary shows the requested range and retrieval time in UTC; fill times are labeled
  **Local time**. An empty answer is described as no records for that selection, never as proof
  that the account had none. No endpoint, handler, reconciliation or D3 gate change; no storage.
  Evidence: 27 new synthetic view tests with a controlled clock (four browser time zones, including
  Los Angeles's 25-hour day), 14 view mutations each caught, and a Chromium run with simulated
  answers in `Asia/Jerusalem`: keyboard only, exact UTC instants sent, cursor-only continuation,
  refusals with no request, a dropped late answer, 1280 and 375 px, light and dark. Real Binance:
  NOT RUN; D3, D4, D6, cost basis and P&L are unaffected. Next: the owner settles D3 on one real
  fill from Binance's own views.

- **2026-11-13 · Manual Binance quantity reconciliation in Account · PR
  [#163](https://github.com/blackhebrewisraeli/Popup/pull/163), from
  `3efb2be`, merged `836ba95`.** Decision: the owner can collect the evidence `reconcileSpotQuantity` needs without
  any new endpoint, storage or arithmetic. A new section in the Spot card captures opening and
  closing reads only from successful explicit reads (server time and owner kept), requests exactly
  `[O − g, C + g]` once the clock passes C + g (a local countdown sends nothing), and folds pages
  with `nextExecutionEvidence`, so a failed continuation stays recorded after a successful retry.
  One request at a time; rate limits pause it; reset, owner change, logout and lost access clear
  it, and late answers are dropped. Binance's documentation, read again, still does not say
  whether a trade-list `commission` includes tax and special commission, and the parser omits no
  commission field. So the contract now gates display: every result is Indeterminate with
  actionable reasons and no figure, while the pure function is unchanged. Evidence: 26 synthetic
  view tests with a mocked clock (including consistent and one-satoshi evidence hidden by the gate
  but shown exactly when tests lift it), nine view mutations each caught, and a browser run with
  simulated function answers at 1280 and 375 px, light, dark and keyboard. Owner-observed on
  2026-11-13, not agent-checked: deployment, 401 when unauthenticated, read-only key verified,
  balances matching Binance, one empty execution read. Not verified: any non-empty fill,
  commissions, pagination or reconciliation against a real account. Next: the owner settles D3 on
  one real fill from Binance's own views.

- **2026-11-12 · Binance quantity-reconciliation pipeline acceptance · Draft PR
  [#162](https://github.com/blackhebrewisraeli/Popup/pull/162), from `50d2d75`.** Decision: verify the
  layers together before any view uses `reconcileSpotQuantity`, through the committed handler with
  its existing injected env, fetch and clock, a synthetic Binance and the production client, so no
  folded evidence is built by hand. Fix: `nextExecutionEvidence` merged any answer marked as
  continued; through the real handler, another window's continuation turned a retrieval missing ten
  fills into a confident `DISCREPANCY`. A continued answer is now merged only when it names the
  same pairs and window, otherwise it is recorded as an `invalid_request` continuation failure; with
  nothing to continue it yields no evidence. One view fixture that changed pairs mid-retrieval was
  corrected. Evidence: 12 synthetic pipeline tests (consistent, discrepancy, three fee assets,
  overlaps and conflicts within and across pages, failed pair then success, continuation failure
  then retry, full then empty page, guard edge, read too early, failed read, owner mismatch,
  isolation); mutations of the first-page time and the parser's terminal successes each fail
  several. Real Binance: NOT RUN; the account context remains a caller label, not Binance identity.

- **2026-11-12 · Binance Spot quantity reconciliation · PR
  [#160](https://github.com/blackhebrewisraeli/Popup/pull/160), merged `e74fb6c`.** Decision: implement only the
  quantity half of stage D, as a pure function over the evidence #159 already accumulates. To avoid
  a second implementation, the view's fold moved into `src/lib/binanceSpotEvidence.ts` and now also
  keeps when the first page was read, so "executions read after C + g" is checkable. Completion
  comes only from the subject pair's explicit terminal success with no pair, page or continuation
  failure and no conflict. Fills within the guard, inside or outside the balance interval, block the
  conclusion and are never summed. An absent asset is zero only in a valid successful read, and
  fees in USDT, BNB or another asset stay in their own asset. Evidence: 68 new labeled synthetic
  tests (the quantity portions of E1–E6 plus decimal, coverage, window, boundary and purity cases),
  each figure calculated by hand; deliberate mutations of the guard, coverage, fee, timing and
  comparison rules each fail at least one test. 1,612 tests, typecheck, lint and build pass. Real
  Binance: NOT RUN; no view calls the function. The SonarCloud follow-up,
  [#161](https://github.com/blackhebrewisraeli/Popup/pull/161) (merged `50d2d75`), splits `reconcileSpotQuantity` into
  coverage, timing and fill helpers (cognitive complexity 28 → under 15), replaces two negated
  comparisons with explicit finiteness checks, and adds two tests for an unparseable or earlier
  latest-page time (1,614 tests). Results and reason order are unchanged.

- **2026-11-12 · Binance Spot account-event and reconciliation contract (stage D) · PR
  [#157](https://github.com/blackhebrewisraeli/Popup/pull/157), merged `62f4fbb`, documentation only.** Decision:
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
  request. #157 merged at its first commit, so the review follow-up landed in a separate documentation PR: example 6b now names its 0.01 USDT fee, the guard is
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
