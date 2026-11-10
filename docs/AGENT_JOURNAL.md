# Popup agent journal

Read this before starting a task. Use the linked PRs and technical docs for details.

## Current direction

Popup helps the owner scan a broad universe of stocks and ETFs, see which technical conditions
changed, and understand the evidence behind each result. The user decides whether to act.

- TradingView is the selected source for the equity scanner. The current equity flow is local
  and owner-initiated through an authenticated agent. It does not establish unattended or
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
  `binance-spot-account` edge function. Draft [#146](https://github.com/blackhebrewisraeli/Popup/pull/146) fixes the duplicate first read and
  records a local runtime check with throwaway users and a synthetic provider. No credential is
  configured and no read against Binance has run
  ([setup, boundaries and verification](BINANCE_SPOT_ACCOUNT.md)).
- **Owner trial:** deferred by the owner and not started. When it starts, personal decisions and
  outcomes go in a private journal, never here.
- **Model evidence:** [#118](https://github.com/blackhebrewisraeli/Popup/pull/118) and [scanner
  research](SCANNER_RESEARCH.md) did not establish a predictive advantage.

**Next:** Still pending: the first real new-session comparison. Once the 9 Nov session is final
(2026-11-10 06:00 UTC), run one fresh default (50-member) scan with the runbook prompt.
`tradingview-finish` should list the full-universe import `20261107T223109Z-aca6476d` under
`skipped` as not comparable (Universe), choose `20261107T170244Z-76cde900` as the baseline, and
report the 90-member view under `preservedView`. Research should show the same counts after
**Reload local scan**, without a page refresh, and both scans under **Scan shown**.

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
