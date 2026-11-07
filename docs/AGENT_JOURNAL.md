# Popup agent journal

Read this before starting a task. Use the linked PRs and technical docs for details.

## Current direction

Popup helps the owner scan a broad universe of stocks and ETFs, see which technical conditions
changed, and understand the evidence behind each result. The user decides whether to act.

- TradingView is the selected source for the equity scanner. The current equity flow is local
  and owner-initiated through an authenticated agent. It does not establish unattended or
  production TradingView access. The existing Binance paths are separate.
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
- **Model evidence:** [#118](https://github.com/blackhebrewisraeli/Popup/pull/118) and [scanner
  research](SCANNER_RESEARCH.md) did not establish a predictive advantage.

**Next:** Once the 9 Nov session is final (2026-11-10 06:00 UTC), run one fresh scan with the
runbook prompt and verify the first real comparison: `tradingview-finish` should choose
`20261107T170244Z-76cde900` as the baseline, and Research should show the same counts. The owner's
personal trial stays deferred; when it starts, personal decisions and outcomes go in a private journal.

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

- **2026-11-07 · Fresh-scan verification after #140 · Local real-data run on main `e1b0719`; field
  names fix in a draft PR.** Evidence: an agent-initiated TradingView retrieval through the runbook
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
