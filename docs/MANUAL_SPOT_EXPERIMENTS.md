# Manual Spot experiments: storage and access

A manual Spot experiment follows one real Binance Spot decision from the scan it came from to what
was observed afterwards. It records:

- the source scan and the candidate's evidence;
- the owner's decision and the rules the owner set;
- the fills the owner links;
- dated observations, and the owner's explicit close.

**Stage: recording, fill linking, rules, observations, closing and viewing.** Migration
`20261114120000` adds the tables, the access rule and their validation. It was applied to production on 2026-11-13 (UTC)
([release record](#production-release-2026-11-13)). The app records an experiment from a saved
scan's [Manual Spot scenario](TRADINGVIEW_CRYPTO_SCAN.md#manual-spot-scenario)
([Recording](#recording-from-a-saved-scan)), links fills to it from the
[execution view](BINANCE_SPOT_ACCOUNT.md#execution-history-coverage)
([Linking](#linking-fills-from-the-execution-view)), and lists experiments with their linked fills
in **Account**, apart from the paper Signal Journal ([Viewing](#viewing-in-account)). Account also
records append-only rules, dated observations and the owner's explicit close through the existing
entries table ([Closing](#closing-in-account)). Migration `20261117120000` adds an optional
[scenario snapshot](#scenario-snapshot) to a new experiment. It was applied to production on
2026-11-17 (UTC) before [#187](https://github.com/blackhebrewisraeli/Popup/pull/187) merged as
`49b0903` ([release](RELEASE.md#manual-spot-scenario-snapshot-20261117120000)). The hosted app
can record from a saved crypto scan [file the owner opens](MARKET_SCANNER.md#opening-a-saved-crypto-scan-file).

## Access

Only the configured Binance owner can read or add an experiment. The database enforces this with
row-level security: a row is visible or insertable only when it belongs to the caller **and** the
caller is the configured owner. Owning a row is not enough.

- **Configuration.** `public.binance_spot_owner` holds one row: the owner's Popup user ID. A
  database administrator sets it in the SQL editor ([Release](RELEASE.md#manual-spot-experiments-20261114120000)).
  It must name the same user as the `binance-spot-account` function's
  `BINANCE_SPOT_OWNER_USER_ID`. The database can't read the function's secrets, so nothing checks
  that the two match.
- **Fails closed.** With no row, nobody can read or add an experiment.
- **Owner change.** Naming another owner hides the previous owner's experiments from everyone.
  The rows are kept.
- **Who sees the configuration.** A signed-in user sees the configuration row only when it names
  them. `public.is_binance_spot_owner()` tells a signed-in caller whether they are the owner and
  nothing about anyone else.
- **Roles.** `anon` has no access. The service role can read experiments, entries and fills, but
  can't write any of them, and can't read the configuration.

These protections apply to the application roles: `anon`, `authenticated` and `service_role`. A
database administrator can bypass grants, policies and constraints, for example in the SQL editor.

## The record

| Table                     | One row per                                                                   | Written by                                                    |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `spot_experiments`        | Experiment: source scan, evidence, decision and an optional scenario snapshot | The owner. ID, owner and recorded time come from the database |
| `spot_experiment_entries` | Rule, observation or close, in the owner's words                              | The owner                                                     |
| `spot_experiment_fills`   | Linked fill, copied from a Popup Binance read                                 | The owner's browser                                           |

A client names the content only. The `id`, `user_id` and `recorded_at` columns are not in its
insert grant, so a request that sends them is refused.

## What each fact establishes

Each assurance is separate. None implies another.

| Fact               | Column                                          | Establishes                                                                                                                                                       | Does not establish                                                                                                                                            |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot identity  | `source_snapshot_sha256`                        | Which bytes the experiment refers to: the SHA-256 of the snapshot file, as the browser reported it                                                                | That the scan is authentic, or that it reproduces. The database can't read the file. Any other copy with the same bytes has the same hash                     |
| Reproduction       | `source_reproduction`                           | What the local offline reproduction reported when the record was made: `match` or `not_checked`. `mismatch` is refused                                            | That it would reproduce now. The database can't re-run it, and the value is client-submitted                                                                  |
| Authenticity       | none                                            | Nothing                                                                                                                                                           | Local snapshots are unsigned. No column shows that the scan came from Popup's scanner or from TradingView data                                                |
| Candidate evidence | `source_evidence`                               | What the browser showed for the candidate (rank, setups, freshness), as a copy                                                                                    | It is not re-derived from the snapshot                                                                                                                        |
| Scenario snapshot  | `scenario_snapshot`                             | The scenario inputs, as typed, and its figures, as shown, that the owner chose to include and reviewed. Client-submitted. Null: no scenario recorded              | That the arithmetic is right (the database checks the shape only), when the plan was made, or any rule, order, balance or fill                                |
| Recorded time      | `recorded_at`                                   | When the database stored the row (`clock_timestamp()`). Clients can't set it                                                                                      | When anything happened in the market or in Binance                                                                                                            |
| Stated time        | `decision_stated_at`, `stated_at`               | When the owner says the decision was made, the rule was set, the observation was made or the experiment ended                                                     | Anything the database can check. Never after `recorded_at`. Null means not stated                                                                             |
| Fill               | `spot_experiment_fills`                         | The values the owner's browser submitted, copied from the execution view                                                                                          | That Binance holds that fill. The server doesn't re-read Binance to verify it: the row is **client-submitted evidence**, not a server-verified Binance record |
| Read behind a fill | `retrieved_at`, `window_*`, `coverage_complete` | The read the browser says it copied from: the function's clock for the retrieval's latest page, the requested window and whether every page was read consistently | The same limits as the fill. Coverage complete covers that window and pair only. A fill from an earlier page of the retrieval was read before `retrieved_at`  |
| Account context    | `account_label`                                 | The caller's label for the Binance account. It scopes fill identity                                                                                               | Which Binance account that is. Popup reads no Binance account identifier, so the label proves nothing about identity                                          |
| Order status       | none                                            | Nothing                                                                                                                                                           | Popup reads no orders. An observation is what the owner saw, and when, never a current status                                                                 |

**Recording later is allowed.** A decision or rule recorded after it was made has a stated time
earlier than its recorded time. That is a labelled retrospective record, not an inconsistency. A
stated time after the recorded time is refused.

## Rules

- **Names:** `allocation_ceiling`, `stop`, `horizon`, `target`, `exit`, `other`.
- **Statuses:** `approved`, `proposed`, `withdrawn`.
- **Rules exist only as the owner states them.** A rule exists only as an entry the owner adds,
  with a status. Nothing is inferred from the scenario's inputs, a recorded scenario snapshot,
  earlier conversations or other rules. A named rule with no current approved entry is not decided. That holds for any horizon,
  target or exit the owner hasn't approved.
- **Changes.** A change is a new entry that names the entry it replaces (`supersedes`). That must
  be an entry of the same experiment and the same rule.
  - Each entry can be replaced only once.
  - A named rule starts only one chain of entries, so it always has exactly one current version.
  - `other` can hold several unrelated rules.
  - A withdrawal must name the entry it withdraws.
- **Current rules** are the rule entries that no later entry replaces.

## Fills, partial exits and closing

- **Any number of fills.** An experiment can link any number of buy and sell fills. Fills of one
  order are separate rows, one per trade ID.
- **Identity.** A fill is identified by owner, account label, pair and trade ID. One trade belongs
  to one experiment. The same trade ID under another account label is a different fill.
- **Matching the experiment.** A fill must have the experiment's pair and account label.
- **Exact values.** Values are Binance's decimal strings, stored exactly as sent. Each commission
  stays in its own asset.
- **Nothing derived.** No position, remaining quantity, cost, total, profit or loss is stored. A
  partial exit is simply some linked sell fills.
- **Read window.** The read window is at most 24 hours, and the fill's time must fall inside it.
- **Closing is explicit.** An experiment ends only when the owner adds a `close` entry, at most one.
  Sells never close an experiment, even when they match every unit bought.
- **A close doesn't lock the record.** A fill, rule or observation added later is accepted, and its
  recorded time shows it came after the close. So a fill found late stays visible as linked late.

## Observations

An observation says where the owner saw something (`binance_interface` or `elsewhere`) and when
(`stated_at`, required). For example: "stop order seen in Open Orders" at a stated time. It
records that the owner saw that, then. It never becomes the order's current status.

## Append-only

- Experiments, entries and fills can't be changed or deleted by any application role.
- `authenticated` may insert content columns and read. `service_role` may only read. Nobody has
  `UPDATE`, `DELETE` or `TRUNCATE`.
- Deleting the owner's account cascades: its experiments go with it.
- Corrections are new entries, not edits. A wrong fill link has no correction path yet.

## Separate from Popup's books

No foreign key, trigger, view or function connects these tables to paper trading
(`paper_transactions`, `paper_order_batches`), tracked holdings or simulations (`user_portfolios`),
or to `trading_signals`. The SQL tests check the foreign keys and triggers. They also check that
those tables' row counts don't change.

## Privacy

Rows live in the hosted database and are readable only by the configured owner. This repository
holds synthetic fixtures only (`ZCT*` pairs, invented IDs, prices and times). No live experiment,
scan ID, account label or fill belongs in code, tests or docs.

## Recording from a saved scan

**Record experiment (saves to Account)** sits under **Plan a hypothetical scenario** in a
TradingView crypto pair's evidence. It asks the database nothing until it is opened, and it saves
only when the owner presses **Confirm and record** after **Review record**.

- **A saved scan only,** reproduced offline before it is shown, with `snapshotSha256`, the SHA-256
  of the bytes that reproduced. Two ways in, same check and same record:
  - **Scan shown** (`vite dev` only): the local saved-scan route reads the snapshot from the scan
    store.
  - **Open saved crypto scan** (any build, the hosted app included): the owner chooses the
    original `<scan ID>.json` file, and the browser's finance worker hashes and reproduces it
    ([how](MARKET_SCANNER.md#opening-a-saved-crypto-scan-file)). The file stays in memory: the
    record stores the scan ID, the file hash, `match` and the copied evidence, never the file or
    its candles. Opening a file proves nothing about who opened it; the owner check below is
    unchanged.

  The published view is not the snapshot file, so it offers no form and says which scan to
  choose.

- **Who.** A signed-in user whom `is_binance_spot_owner()` names. The `?devAuth` stub has no
  session, so the form never appears and nothing is sent. Without a session, the database refuses
  `anon` anyway. Anyone else is told recording is unavailable, never who the owner is.
- **The owner states:** the decision in their own words, an account label (the database's format),
  and optionally when they decided (`datetime-local`, read as UTC, never after now).
- **Copied:** the pair, the scan ID, the snapshot hash, `source_reproduction = 'match'`, and the
  candidate's evidence exactly as **Recorded evidence it rests on** shows it (the same facts, in
  the same words, plus rank, setups and staleness). Snapshot identity, reproduction and
  authenticity stay separate facts, as [above](#what-each-fact-establishes).
- **Scenario, only when included.** **Include this scenario in the record** is off by default.
  Off, the scenario's inputs and figures are not sent, the insert is the one earlier frontends
  sent, and an incomplete or invalid scenario never blocks recording. On, **Review record**
  needs a valid result from the planner and takes one frozen [snapshot](#scenario-snapshot) of
  it; otherwise it names the problem and focuses the checkbox. Either way no entry is written, so
  every rule stays **Not decided** until the owner adds one.
- **Labels.** A stated time marks the record **Retrospective**. A stale scan marks it **Historical
  scan**, recorded retrospectively from evidence about an earlier day.
- **Review, then confirm.** **Review record** shows every value that will be stored, an included
  scenario's inputs and figures among them. Only **Confirm and record** sends it, with the same
  snapshot the review shows. The button locks before the request leaves, so repeated presses send
  one insert. Opening or reviewing writes nothing.
- **An out-of-date review is never sent.** If an included scenario's inputs change after the
  review, or the scan, its snapshot file or the pair does (with or without a scenario), the review
  says so and Confirm locks. **Edit** and **Review record** again take a new snapshot.
- **Outcomes.**
  - **Recorded:** only with the ID and `recorded_at` the database returned. The button then stays
    locked.
  - **Refused:** the database answered, for example a permission refusal. Nothing was stored.
    The draft is kept, and Confirm can be pressed again.
  - **No confirmation:** no answer came back, so the row may or may not exist. Confirm locks until
    the owner edits and reviews again, and the message says to check Account first.

## Linking fills from the execution view

**Link to experiment** sits in the Experiment column of Account's **Binance Spot executions** table.

- **An account label for the retrieval.** The owner names the account before loading, in the
  database's label format. It belongs to that retrieval: changing it clears the result, like the
  pair and range. Without one, no row can be linked, and the view says so.
- **Consistent rows only.** Conflicting variants of a trade get no control. A row whose trade is
  already linked under this label shows where (**Linked:** the experiment) and flags a stored copy
  whose fill values differ from this read. A row with no experiment for its pair under this label
  says so.
- **Only matching experiments.** The list is the owner's own experiments with the fill's pair and
  the retrieval's label, from the same read Account makes. The database accepts nothing else (its
  foreign key names the pair and label). With several, none is preselected.
- **Review, then confirm.** The panel shows the experiment (with its decision), the account label,
  every fill field exactly as read (side, trade and order IDs, trade time to the millisecond,
  quantity, price, quote quantity, commission with its own asset), the retrieval time (the
  function's clock for the retrieval's latest page), the requested window and the coverage. Only
  **Confirm and link** sends it, and it locks before the request leaves, so repeated presses send
  one insert. If a later page turns the fill into a conflict while the panel is open, it can no
  longer be linked.
- **What is stored.** One `spot_experiment_fills` row: the fill as client-submitted evidence,
  never re-read from Binance by the server. Decimal strings and the commission asset are stored
  as read. No entry is written, so linking never closes an experiment, a sell included.
- **Outcomes.**
  - **Linked:** only with the ID and `recorded_at` the database returned.
  - **Already linked:** the database holds a link for this trade under this label (one trade
    belongs to one experiment). The stored copy is read back and the panel says whether it belongs
    to another experiment and which fill fields differ from this read. Nothing is changed: links
    are append-only, with no correction path yet.
  - **Refused:** the database answered (for example, permission denied). Nothing was stored, and
    Confirm can be pressed again.
  - **No confirmation:** no answer came back, so the link may or may not be stored. Trying again is
    safe: the unique key turns a stored link into **Already linked**, never a second row. The
    experiment list is read again either way.

## Viewing in Account

**Manual Spot experiments** sits inside Account's **Binance Spot** card, the first section after
the Account heading, so only the owner the `binance-spot-account` function recognizes sees it. The database still decides what it shows.
The workspace banner links to it at `/account#spot-experiments` for every sign-in. Once the card
renders, the heading takes focus. Until then the card's place says the check is running, and for
anyone else it says the section is not available.

- **States.** Loading, empty, unavailable (the database names no owner, or another one), refused
  (permission denied), and failed. A failure never shows an empty list in its place.
- **One read.** The owner's newest 100 experiments, each with its entries and linked fills
  embedded.
- **Each experiment.** The closed row shows the pair, account label and recorded time, with
  **Retrospective** and **Historical scan** tags when they apply. Opening it shows the
  **Experiment overview** first (see **Record summary** below). Next comes one closed disclosure,
  **Provenance and copied evidence**: both times with their sources (the stated decision time or
  **Not stated**, and the database's recorded time), the account label, the scan, snapshot
  SHA-256, reproduction, authenticity (**Not established**), and every copied evidence fact.
  Opening it, or the experiment, sends no request. A second closed disclosure,
  [**Review another saved scan**](#reviewing-another-saved-scan), follows it.
- **Rules.** Each named rule shows its current version as **Proposal**, **Approved** or
  **Withdrawn**. A proposal or withdrawal is also labelled **Not decided**. The complete immutable
  history remains available. A change or withdrawal always supersedes the current entry; several
  unrelated `other` rule lines may coexist.
- **Scenario, as recorded.** **No scenario recorded** for an experiment stored without one, never
  zeros. Otherwise the snapshot's inputs and figures exactly as stored, with the database's
  recorded time as the only time. A snapshot in another format or calculation, or one this view
  cannot read, is named and not shown; the rest of the experiment still is.
- **Linked fills.** Each fill in trade time order: side, trade and order IDs, trade time, quantity,
  price, quote quantity and commission with its asset, exactly as stored; the read it was copied
  from (retrieval time, window, coverage); and when the database stored the link. A fill stored
  after a close is labelled **Linked after the close**. Or **No linked fills**.
- **Observations.** Each observation shows where it was seen, the owner's required stated UTC time,
  and the database-recorded time. It is labelled retrospective and always says that it records
  what was observed then, not what is true now. An observation that an open stop was visible never
  becomes a current-order-status claim.
- **Adding an entry.** Rule and observation forms first validate the owner's words and UTC time,
  then show an explicit review. Only **Confirm and save** inserts. Repeated presses send one
  request. A successful immutable result offers **Add another**, which starts a blank draft; a new
  rule still supersedes the current rule version, including the entry just returned. Permission and
  validation refusals say nothing was stored. A concurrent named-rule change is reported as a
  conflict and requests a history refresh. If the database gives no answer, the review stays locked
  while the UI reports the history refresh as pending, succeeded or failed; it does not claim
  success or automatically retry an observation, because the existing schema has no observation
  idempotency key.
- **Record summary.** The **Experiment overview** at the top of an opened experiment is a factual
  summary. It holds:
  - the decision, with its stated and recorded times;
  - **Entry evidence, as recorded**: the ZC LONG, ZC RISK, technical rank, evaluated, freshness
    and data-quality facts. These are shown in the text copied when the experiment was recorded,
    labelled historical, not current. ZC LONG and ZC RISK are listed side by side, with no
    precedence. A fact the copy lacks reads **Unknown: not in this copy**, and an unreadable copy
    reads **Unknown**. Neither becomes "does not hold".
  - which named rules are approved and which are not decided, marking a current proposal or
    withdrawal, and how many rule entries the history holds. One note says that approved means
    recorded by the owner: Popup does not evaluate, follow or execute a rule.
  - how many fills are linked, by side: **Counts only, not a holding**;
  - how many observations are recorded;
  - the close: **Not closed**, or the owner's stored close with **Ends the record; not evidence
    of a sale**. After a close it also counts the fills, rule entries and observations recorded
    after it.

  Selling every unit bought changes only the counts. The close review repeats this summary, with
  the source scan, its reproduction and its authenticity in place of the entry evidence. No
  position, total, P&L, remaining quantity, order status or rating is shown.

- **Close.** **Close experiment record** adds the owner's close ([Closing](#closing-in-account)).

## Reviewing another saved scan

**Review another saved scan** is a closed disclosure after **Provenance and copied evidence** in
each opened experiment. It puts one saved crypto scan file the owner chooses beside the
experiment's stored entry evidence, for that experiment's pair only. It is read-only: it fetches
nothing, stores nothing and changes no record, rule, observation or fill.

- **Research's check, unchanged.** The file goes through
  [Opening a saved crypto scan file](MARKET_SCANNER.md#opening-a-saved-crypto-scan-file):
  `useSavedScanFile`, the finance worker, the 4 MB limit and the same refusals. Nothing from the
  file is shown until it reproduces.
- **The exact pair only.** The experiment's `symbol` is matched against each result's
  `BINANCE:<pair>` instrument whose TradingView symbol was requested and confirmed (`spotSymbol`,
  `exactSymbol`), never by ticker. A pair that is not in the scan, is named twice, is not
  confirmed or was not evaluated (fetch failed, rate limited, invalid data, stale data, short
  history) gets its own state with the scan's reason. No other pair is shown in its place.
- **Two labelled columns, same rows.** **Entry evidence, as recorded** is the stored copy as
  stored, never recalculated or overwritten. The copy keeps no score, scan evaluation time, full
  candle close or exact freshness time, so those read **Not stored in this copy**. An unreadable
  copy reads **Unknown**. **Selected scan evidence** words the file's facts as a recorded copy
  would (`candidateEvidence`). It adds the score, the scan's cutoff and the full close time of the
  candle the result rests on. Both columns list instrument, scan, model and timeframe, evaluated
  candle, ZC LONG, ZC RISK with its reasons, technical rank, freshness with its reference time, and
  data quality.
- **What is compared, and nothing else:**
  - **This file**: the bytes match the snapshot SHA-256 the experiment references, or the file
    has the same scan ID with other bytes, or it is another scan. A matching hash identifies the
    file only. It does not check the copied entry facts against the file, and never stands in for
    a pair the scan did not evaluate.
  - **Candle order: unknown.** A version 1 copy keeps the entry candle as a day and month without
    a year ("27 Oct candle (UTC)"), shown as stored. A record may be retrospective, of a scan of
    any age, so no year is guessed: not from the record or stated decision time, the scan ID, the
    file name or file times. The two candles are never called the same, earlier or later, and
    never new evidence or a new signal. The selected candle's full close time is shown on its own.
  - **Model and timeframe**: compared only when the copy states them as `<model> · <timeframe>`;
    otherwise unknown. A difference reads "not comparable as one measurement".
  - No onset, recovery or alert is inferred. ZC LONG and ZC RISK are separate and can both hold.
    Each rank is relative to its scan's universe, so ranks are not compared. No score is invented
    for the copy. No BUY, HOLD or SELL, rule evaluation, holding, P&L or order status.
- **Freshness.** Each side uses the scan's own rule (`cohortFreshness`) with its reference time:
  the copy's was judged when it was copied, before the record time; the file's when its check came
  back, by the browser's clock. Fresh at a scan's cutoff does not make a historical file current.
- **In memory, under one experiment.** The file and comparison live in that experiment's component
  memory only: never browser storage, a URL, the database or analytics. Choosing another file drops
  the comparison at once, also when the new file is refused. **Close comparison**, or closing the
  disclosure, clears it, and a check that answers late for a closed or replaced file is ignored.
  Another experiment never shows it.
- **Authenticity.** Reproduction shows the file is internally consistent, not that it is authentic.

## Closing in Account

**Close experiment record** sits at the end of an experiment that has no close, after its linked
fills.

- **The owner's words.** A reason is required (at most 1,000 characters). A stated UTC time is
  optional: empty means not stated. The field is read as UTC, whatever the browser's time zone,
  and a time after now is refused.
- **Review, then confirm.** The review shows the experiment, the reason, the stated time and that
  the database sets the recorded time. A stated time earlier than now is labelled a retrospective
  record. The review repeats the record summary and says that closing places no order, sends
  nothing to Binance and does not show that the Binance position is closed. Only **Confirm and
  save close entry** inserts, and it locks before the request leaves, so repeated presses send one
  request.
- **What is stored.** One `spot_experiment_entries` row with `kind = 'close'`, the reason as
  `statement` and the optional `stated_at`. Rule, status, supersedes and place are null. No sale,
  remaining quantity, total, profit or loss, and no success or failure rating is inferred or
  stored.
- **Outcomes.**
  - **Saved:** only with the time the database returned. There is no **Add another**: the
    database accepts one close per experiment.
  - **Already closed:** the database holds a close for this experiment (another tab or device
    stored one first, or this review was already submitted). Nothing new is stored, Confirm locks
    and the history is read again, so the stored close appears in the summary.
  - **Refused:** the database answered (for example, permission denied). Nothing was stored, and
    Confirm can be pressed again.
  - **No confirmation:** no answer came back, so the close may or may not be stored. The review
    stays locked while the history refresh is reported as pending, succeeded or failed, and success
    is never claimed.
- **After the close.** The close form is gone, and a note says the record is not locked. Adding
  rules and observations still works, and fills can still be linked. Each later item is marked
  **Recorded after the close** (fills: **Linked after the close**) by comparing database-recorded
  times, and the summary counts them. A close cannot be edited, withdrawn or removed.

## Scenario snapshot

An experiment recorded with **Include this scenario in the record** carries one
`scenario_snapshot` (migration `20261117120000`). It is the owner's hypothetical plan as the
review showed it: a client-submitted planning record, kept apart from `source_evidence`, which
describes the scan candidate.

```json
{
  "version": 1,
  "calculationVersion": "spot-scenario-1",
  "inputs": {
    "allocation": "15",
    "maxLoss": "1",
    "entry": "0.00000612",
    "stop": "0.0000055",
    "feePercent": null
  },
  "figures": {
    "quantity": "1,612,903.22580645",
    "limitedBy": "maxLoss",
    "notional": "9.87",
    "unallocated": "5.13",
    "stopDistance": "0.00000062",
    "stopDistancePercent": "10.13%",
    "lossAtStop": "1.00",
    "fees": null
  }
}
```

- **Versions.** `version` is the snapshot's format. `calculationVersion` names the arithmetic,
  rounding and output text of `planSpotScenario` (`SPOT_SCENARIO_CALCULATION` in
  `src/lib/spotScenario.ts`). It is not the signal model's version. A change to that arithmetic
  needs a new calculation name, so stored figures are never read under rules they were not made
  with.
- **Inputs** are the strings the planner read (trimmed), never converted to a number, so a
  small-price entry keeps every digit. An unspecified fee is `null`; a stated zero is `"0"`, and
  only then do the figures carry `fees`.
- **Figures** are the display text the review showed: grouped digits, cents, `<0.01`, a percent.
  They are not amounts to compute with, and Account shows them as stored, never worked out again.
- **No time of its own.** The experiment's `recorded_at` is when it was stored. No planning time
  is stored or implied.
- **What it is not.** It sets or approves no allocation, stop, horizon, target or exit rule: only
  rule entries do. The stop reference is a planning input, not a Binance stop order. The planned
  loss is not a guaranteed maximum. The figures are hypothetical, not a placed order, a verified
  balance, an executable quantity, an actual fill or performance.
- **Database validation.** A check constraint accepts null or exactly this shape: format 1, a
  `spot-scenario-<n>` calculation name, the five inputs as plain decimal strings (amounts and
  prices above zero with at most 8 decimals, the fee null or at most 4 decimals, each at most 32
  characters), the eight figures as display text, `fees` present exactly when a fee was stated,
  and at most 2,048 bytes. It checks structure, types and size only. It does not establish who
  calculated the snapshot or independently verify a single figure.
- **Access.** `authenticated` may insert the column, under the same owner-only policies. No role
  may update or delete it, and the service role still only reads. A snapshot cannot be added to,
  changed on or removed from an existing experiment.
- **Compatibility.** Existing experiments are not backfilled: they read as **No scenario
  recorded**. An insert that leaves the column out, as earlier frontends send, still works.

## Decision lifecycle: current behavior and proposed product contract

Checked against `main` at `4e91384` (2026-11-17). This section describes code and proposes
display wording. It approves, activates or changes no strategy, and merging it does not either.
Existing experiments and frozen studies keep exactly what they recorded. The math stays in
[QUANT_MODEL_VERIFICATION.md](QUANT_MODEL_VERIFICATION.md#exact-mathematical-contract) and the
meaning of each label in [MODEL_DIAGNOSTIC.md](MODEL_DIAGNOSTIC.md#what-each-label-establishes).

The browser and the local scan tools score with the canonical TypeScript implementation
(`evaluateCandles` → `scoreFactors` in `src/lib/canonicalModel.ts`). The Pine HUD implements the
same model separately (`1.0.0-pw200`). Its decisions matched the app's on the bars compared at
runtime, but its readings are not identical: equivalence is bounded, not exact, and the HUD scores
the chart it is on without the app's candle validation
([parity assessment](PINE_PARITY_ASSESSMENT.md#3-correction-candidate)). A Pine label and an app
label for the same day are two readings, not one. Each surface applies its own policy to its own
ledger. **None of them is the policy of a real Spot
experiment:** an experiment's only policy is what the owner records in it.

### Current behavior (implemented)

| Surface / policy                                                                                | Condition                                                                                              | Actual consumer and account scope                                                                                                                                                                                                | Establishes                                            | Does not establish                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Score and rank: `evaluateCandles`; rank in `marketScanner.ts`                                   | 0–100 composite on the last closed daily bar; rank is score order within one asset class               | Research Scan and Markets; copied into `source_evidence` by `candidateEvidence` (`spotExperiments.ts`)                                                                                                                           | Order within one scan's evaluated pairs                | Entry eligibility, a probability or a forecast                                                                           |
| Pine action band: `action` in `pine/zerochart_quant_hud.pine`                                   | ≥ 78 STRONG BUY, ≥ 60 BUY, > 28 WAIT, > 15 RISK/TRIM, else STRONG SELL; with a size and "Exit at" stop | The HUD table on a TradingView chart. No app code reads it                                                                                                                                                                       | A score band                                           | Long, an entry, a reduction, an exit rule or a sale                                                                      |
| Setups: `modelSetups` (Pine's own `longSetup`, `riskSetup` on its readings)                     | Long: score ≥ 78 and momentum ≥ +0.05% of price. Risk: score ≤ 28 or HIGH_VOLATILITY                   | Scan rows and evidence (`candidateStatus`, `riskLabel` in `scanReview.ts`); copied as `long` and `risk` into `source_evidence`                                                                                                   | A standing condition on that closed bar. Both can hold | That it began that day, an order or an exit                                                                              |
| Pine transitions: `longSignal`, `riskSignal`, `stopBreached`                                    | The bar a setup turns true, or the indicator's trailing stop flips                                     | `tv-webhook` → `trading_signals` → Action Center **Execute** (`execute_tactical_signal`) into the Paper Trading ledger; [Decision Journal](DECISION_JOURNAL.md)                                                                  | An event for one alerted symbol and timeframe          | Anything about an experiment: no key links `trading_signals` to these tables ([above](#separate-from-popups-books))      |
| Profile eligibility: `qualifiesForRiskProfile`, `RISK_PROFILE_POLICIES` (`portfolioBuilder.ts`) | Minimum score 60 / 60 / 71; conservative excludes HIGH_VOLATILITY; aggressive needs positive momentum  | `buildQuantPortfolio` → **Build Portfolio** → `execute_paper_portfolio` (Paper Trading, simulated); the scan's profile filter. The local [validation lab](STRATEGY_VALIDATION.md) keeps its own frozen copy (`evaluationLab.ts`) | Fit to a paper profile's filter                        | Long, or a real-money entry                                                                                              |
| Sizing and gates: `recommendPositionSize`, `checkNewEntry`, `checkSell` (`risk.ts`)             | 2% of capital at a 2 × ATR stop; 6% open-risk cap; no sale beyond the ledger's holding                 | Build Portfolio, asset details (reference capital), trade tickets on Popup's own ledgers                                                                                                                                         | Sizing and checks inside Popup's ledgers               | A Spot allocation or stop. The [Manual Spot scenario](TRADINGVIEW_CRYPTO_SCAN.md#manual-spot-scenario) does not reuse it |
| Tactical signals: `generateTacticalSignals` (`tacticalSignals.ts`)                              | SELL a held asset scoring < 50; BUY an unheld one scoring ≥ 85 while cash remains; no score, no signal | Tactical Signals and the Paper Trading terminal, over Paper Trading positions only                                                                                                                                               | A paper idea                                           | Anything about real holdings                                                                                             |
| Rebalance: `computeRebalancePlan` (`rebalance.ts`)                                              | A holding or idle cash more than 5 points off owner-set targets. Reads no score                        | `RebalancePanel` on Simulation (Paper Desk) and Tracked Holdings (Account, logged by hand)                                                                                                                                       | Drift from stated targets in that ledger               | A model view or a Binance position. Tracked Holdings is neither read from Binance nor linked to experiments              |
| Manual Spot experiment: `spotExperiments.ts`, `SpotExperiments.tsx`                             | The owner records, links, states and closes                                                            | These owner-only tables; real trades placed by hand in Binance                                                                                                                                                                   | What the owner stored, and when the database stored it | That a rule was met or followed (`ruleVersions` only lists them), a position, a total or P&L                             |
| Binance reads: `binance-spot-account`, `reconcileSpotQuantity`                                  | Balance and execution reads the owner requests                                                         | Account's Binance card. Reconciliation of real reads shows **Indeterminate** while [D3](BINANCE_SPOT_RECONCILIATION.md#d3-check-2026-11-13) is open                                                                              | A balance at read time; fills in one bounded window    | That a balance belongs to an experiment, or a verified holding                                                           |

### Position lifecycle

| Stage    | Implemented today                                                                                                                                                                                                             | Not defined                                                                                                             | Smallest proposed display (not implemented)                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry    | [Record experiment](#recording-from-a-saved-scan) from a reproduced saved scan: copied rank, Long, Risk and freshness; a pair without Long is labelled not model-backed; the owner's decision; optional scenario; linked buys | What qualifies an entry: Long, a fresh event or neither. The copied evidence holds no alert event (`candidateEvidence`) | **Entry evidence** from stored facts: Long met or not · Model Risk flag or none · rank (ordering only) · as of day · alert event not recorded |
| Holding  | Nothing computes a holding. Fills show as stored; observations as dated statements; balances and reconciliation stay separate                                                                                                 | A holding rule; whether and how current evidence is compared                                                            | **Holding: not verified by Popup**                                                                                                            |
| Adding   | More buys can be linked to the same experiment (same pair and account label)                                                                                                                                                  | Whether an addition belongs to the same experiment or a new one, and on what basis                                      | Buy count only, as the record summary already shows                                                                                           |
| Reducing | Sells can be linked; a reduction shows only as linked sell executions. RISK/TRIM and tactical SELL exist only on the HUD and in Paper Trading                                                                                 | A reduction rule; what a Risk flag means for an open experiment                                                         | A Risk flag on an open experiment reads **Model Risk warning, not an exit rule**                                                              |
| Exiting  | `stop`, `target`, `exit` and `horizon` exist only as [owner rule entries](#rules). Nothing evaluates them against prices or fills. Linked sells are executions, not a rule                                                    | Any exit criterion, level or horizon the owner has not approved                                                         | Approved rules: **Approved, not evaluated by Popup**. Others stay **Not decided**                                                             |
| Closure  | One explicit `close` entry ends the experiment record. It is neither an exit rule nor evidence of a sale. Sells never close, and a close does not lock the record ([how](#fills-partial-exits-and-closing))                   | Nothing structural                                                                                                      | Keep. With sells linked and no close: **Sells linked; open until the owner closes it**                                                        |

### Proposed display semantics (not implemented)

Each pair below stays two separate facts, never merged into one verdict:

- **Rank and eligibility.** Rank orders a scan; profile eligibility is a paper filter. Neither is
  an entry.
- **Standing setup and event.** "Long conditions met" is standing, as of the scan's day. An event
  is shown only when a received alert is recorded with its bar time.
- **Risk warning and exit.** A Risk flag names its clause; it is a warning, not an exit fact. Three
  exit facts stay apart from it and from each other:
  - an approved owner `exit`, `stop` or `target` rule states an exit criterion;
  - linked sell fills are client-submitted copies of executions;
  - the `close` entry ends the experiment record. It is neither an exit rule nor evidence of a
    sale.
- **Scenario and rule.** A [scenario snapshot](#scenario-snapshot) sets no rule.
- **Linked fill and holding.** Linked fills are client-submitted copies; the holding is not
  verified.
- **Sell and closure.** Only the `close` entry ends the record; a sell of every unit does not.
- **Saved and current evidence.** Copied evidence carries its scan and day, and stays historical.
  Popup reads no current evidence for an experiment.

**Long and Risk together** appear side by side, both always shown, with no precedence and no
combined label, as `candidateEvidence` and the scan rows already record them. Under model 1.0.0
this needs HIGH_VOLATILITY ([reachability](MODEL_DIAGNOSTIC.md#structural-reachability)).

**Absence is not a state.** No Long reads **Long conditions not met**. Missing or stale evidence
reads **Not evaluated** or **Stale** with its reason. No sell reads **No linked sell**. None of
these becomes HOLD, and missing data never becomes a sale.

### Strategy decisions (owner approval required; none made)

An entry criterion; holding, adding and reducing rules; exit, stop, target and horizon values; an
allocation ceiling; what a Risk flag requires; any precedence between Long and Risk. Today each
can exist only as an approved rule entry in one experiment. A product-wide policy would need its own
versioned contract and would not apply to earlier experiments.

### Illustrative examples (synthetic, not observed market results)

Scores are from the TypeScript implementation. A HUD band is named for the same score; Pine's own
reading of a real chart can differ.

- **BUY band without Long.** RSI 45, momentum +0.2%, ATR/close 2% → NEUTRAL, score 64. A HUD
  showing 64 says BUY and the conservative and moderate profiles fit, but Long needs 78: **Long
  conditions not met**.
- **High score with high-volatility Risk.** RSI 35, momentum +0.8%, ATR/close 4.5% →
  HIGH_VOLATILITY, score 67. A HUD showing 67 says BUY, the moderate profile fits, and **Model
  Risk flag: high volatility** holds. If Pine's Risk setup began on that bar, a configured alert
  sends SELL. Each is shown as its own fact.
- **Standing setup, no new event.** Long held on days D−1 and D, so `longSignal`
  (`longSetup and not longSetup[1]`) is false on D: no new event begins then. When the setup began
  is unknown from these two days; `longSignal` was true on D−1 only if Long did not hold on D−2. A
  scan of D shows **Long conditions met**; the proposed wording adds that it is standing, as of D,
  with no alert event recorded.
- **Missing or stale evidence.** Evidence recorded after a newer UTC day closed is stored with
  `stale: true` and labelled **Historical scan**. A browser score on old candles is `STALE_DATA`,
  and the tactical feed stays silent. Neither becomes HOLD or an exit.
- **A linked sell that does not close.** A `ZCTUSDT` experiment links a buy of 100 and a sell of 100
  and has no close entry. The summary reads **2 linked: 1 buy, 1 sell** and **Not closed: no close
  recorded**. The sell matching every unit bought does not change that.

### Before implementation

Owner decisions:

1. Approve or amend the wording above, including that it restates the stored facts of existing
   experiments without assigning them a policy.
2. Whether an open experiment shows current model evidence for its pair (from which saved scan, up
   to what age), and whether a Risk flag there is display-only or a prompt to review an owner rule.
3. Whether an addition or a re-entry is linked to the same experiment or recorded as a new one.

**Recommended next task (not started):** add **Entry evidence**, **Holding: not verified by
Popup** and **not evaluated by Popup** to Account's existing record summary, from stored rows only.
No new reads, schema, model or rule change. It needs decision 1 only.

**Since then:** the [Experiment overview](#viewing-in-account) leads each opened experiment. It
shows the copied entry evidence in its stored text and says that linked fills are counts, not a
holding, that approved rules are not evaluated by Popup, and that a close is not evidence of a
sale. It does not adopt the proposed labels above, so decisions 1–3 stay open.

## Two trading paths: proposal for owner review

Checked against `main` at `82ef781` (2026-11-18). This is a proposal, not a contract. It
implements, approves and activates nothing, and merging it would not change that. It changes no
formula, threshold, Pine script, trading policy or frozen study. Existing experiments keep
exactly what they recorded. No path, direction, invalidation or strategy is assigned to them after
the fact.

The owner wants two paths: **intraday** and **weeks to months**. The working hypothesis is that
both belong to one strategy family, with different timing and risk parameters. This section
treats that as a hypothesis to test ([assessment](#b-two-paths)).

Every statement here carries one of three labels:

- **Implemented:** what the code does today, as listed under
  [current behavior](#current-behavior-implemented).
- **Proposed:** product behavior to build after review. It records and displays; it decides nothing.
- **Candidate rule:** a strategy rule. It needs a frozen evaluation and the owner's explicit
  approval before any screen treats it as more than a question. None is approved. None is
  presented as profitable, validated or ready for real money.

### Terms

| Term              | Meaning here                                                                                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holding horizon   | How long the thesis is expected to need: within one session (intraday), or weeks to months                                                                                                                                                                                         |
| Context timeframe | The bar length used to judge direction and structure                                                                                                                                                                                                                               |
| Entry timeframe   | The bar length used to time the entry and place the invalidation                                                                                                                                                                                                                   |
| Review frequency  | How often the plan is checked against new data                                                                                                                                                                                                                                     |
| Direction         | **Up**, **Down** or **Unclear** on the context timeframe. It is separate from movement and from the model's Risk flag. Nothing computes it today                                                                                                                                   |
| Movement          | How far price typically travels in one bar. The only measure in Popup today is ATR(14) ÷ close of a daily bar. It is a measurement, not a verdict: neither more nor less is better in itself                                                                                       |
| Invalidation      | The stated condition that makes the thesis wrong: a structure break, an expired horizon, or a reversal of the direction assessment. A move against the trade is not one by itself                                                                                                  |
| Counter-movement  | Price on the losing side of the stated entry reference (below it for a Long), measured from that reference, while the invalidation has not been met. Candle colour does not establish it. "Stability" means that the plan tolerates this by design, not that the price stays still |
| Budget            | The money assigned to a path: the most that path may commit                                                                                                                                                                                                                        |
| Planned loss      | The loss the scenario arithmetic computes at the stop reference, with the stated fee assumption. A planning figure, not a cap ([why](#invalidation-stop-reference-and-protective-order))                                                                                           |
| Position size     | The units held                                                                                                                                                                                                                                                                     |
| Exposure          | Size × price: the value that moves with the market                                                                                                                                                                                                                                 |
| Leverage          | Exposure ÷ own money committed. Spot is 1×. Any other value is out of scope today                                                                                                                                                                                                  |

### Four decisions that stay apart

1. **Risk flag** (implemented): a model warning that names its clause, either high volatility or
   a low score. It prompts a review and changes no plan. It is not bearish evidence. High
   volatility is the usual state of these crypto pairs
   ([diagnostic](MODEL_DIAGNOSTIC.md#what-each-label-establishes)).
2. **Bearish evidence** (proposed; no direction state exists): the direction assessment turns
   Down on the plan's context timeframe. It invalidates a Long only if the plan's own invalidation
   says so.
3. **Exiting a Long:** the owner's decision. It is recorded with its reason: invalidation met,
   horizon reached, target reached, or the owner's discretion.
4. **Opening a Short:** a new plan with its own thesis, invalidation and size. Short and leveraged
   intraday trading belong to the product vision only. Popup is read-only, a Spot experiment has
   no short side, and no execution capability is authorized.

None of the four implies another. Exiting a Long never opens a Short.

### A. Lifecycle

| Stage    | Required evidence                                                                                                                                                                                                  | Proposed behavior                                                                                                                                                                                                                                                                                                                                                                                                                                          | Existing support (implemented)                                                                                                                                                                                                                                 | Unresolved strategy choices                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Entry    | Direction on the context timeframe; a reason on the entry timeframe; the invalidation, stated before entry; measured movement; data fresh enough for the path; budget, planned loss, existing exposure to the pair | The plan reads **Incomplete** until its thesis, direction, invalidation, horizon and planned loss are stated. The invalidation is structured (level, close or touch, timeframe), never free text. Size is the smaller of the budget limit and planned loss ÷ distance to the stop reference, which is not the [invalidation](#invalidation-stop-reference-and-protective-order). ZC LONG and ZC RISK are shown side by side as facts, never as one verdict | Daily evidence only. **Record experiment** from a reproduced saved scan. The [Manual Spot scenario](TRADINGVIEW_CRYPTO_SCAN.md#manual-spot-scenario) sizes from allocation, maximum loss, entry and a stop reference. No direction state, no intraday evidence | How direction is defined; whether ZC LONG is required; context and entry timeframes per path; the entry reason            |
| Holding  | Data on the context timeframe at the review frequency; the position as the owner states it (Popup verifies none); distance to invalidation                                                                         | Reads **Thesis intact by its stated rule**, **Invalidated**, naming the rule and the bar that met it, or **Not evaluated**, with its reason: stale, missing or wrong timeframe. Price on the losing side of the entry reference that has not met the invalidation reads **Counter-movement inside the plan**, not a warning; candle colour is not an input                                                                                                 | The [overview](#viewing-in-account) shows stored evidence only. [Review another saved scan](#reviewing-another-saved-scan) compares a daily snapshot by hand, with candle order Unknown. Nothing reads current evidence or verifies a holding                  | Review frequency; close or touch; whether the thesis expires with time                                                    |
| Adding   | The thesis still intact; the combined position's planned loss to the same or a moved stop reference; total exposure within the budget                                                                              | An addition re-runs sizing over the combined position. A result above the stated planned loss or budget is shown as information. Nothing is blocked or placed                                                                                                                                                                                                                                                                                              | Buys can be linked to the same experiment. Nothing combines them                                                                                                                                                                                               | Whether adding is allowed, and only after a favorable move; same or new experiment ([decision 3](#before-implementation)) |
| Reducing | A stated reduction condition: a target, a partial level, or exposure above budget after a price move                                                                                                               | Shown as its own decision, apart from exiting. A Risk flag prompts a review and never reduces by itself                                                                                                                                                                                                                                                                                                                                                    | Sells can be linked. RISK/TRIM and tactical SELL exist only on the HUD and in Paper Trading                                                                                                                                                                    | Whether to scale out, and on what basis; what a Risk flag requires                                                        |
| Exiting  | The stated invalidation met, the horizon reached, a target reached, or the owner's discretion                                                                                                                      | The reason is recorded as one of those four. The record's close stays a separate fact ([position lifecycle](#position-lifecycle))                                                                                                                                                                                                                                                                                                                          | `stop`, `target`, `exit` and `horizon` exist only as owner rule entries, and none is evaluated. One explicit close                                                                                                                                             | Close or touch; how an intraday session ends; whether the invalidation trails                                             |

**What invalidates a weeks-to-months Long.** A red daily candle closes below its own open. That
alone says nothing about the entry or the thesis: it can close above the entry, or above the
previous close. Counter-movement is measured from the stated entry reference, and the thesis is
judged against the stated structure and invalidation. Only the plan's stated invalidation ends the
thesis:

- a close on the context timeframe beyond the level whose break would end the up-structure;
- the direction assessment on the context timeframe turning Down, if the plan adopted that;
- the horizon passing without the progress the plan stated.

Any number of red daily candles changes nothing unless a close meets the stated invalidation.
Closes below the entry reference that do not meet it are counter-movement.

### Invalidation, stop reference and protective order

These are three different things. Even when they share a price, they are never one number.

|                                   | What it is                                                          | When it is known             | What it establishes                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thesis invalidation (close-based) | The plan's rule, for example a daily close below the stated level   | Only after the candle closes | That the thesis is wrong. It is not an exit price: the close can lie well beyond the level, and any exit fills after it                                                                                          |
| Stop reference                    | A price entered in the Manual Spot scenario for hypothetical sizing | When the plan is made        | The loss the arithmetic computes at that price, with the stated fee assumption                                                                                                                                   |
| Protective order                  | An order the owner may place in Binance, and its execution          | When placed, and when filled | What actually happened. A stop order triggers when its price trades. It can fill worse (slippage, a gap) or, as a stop-limit, not fill. Popup places no order and does not identify any fill as a protective one |

The scenario's loss at the stop reference does not cap the loss of a strategy that waits for a
candle to close beyond that level. That loss depends on where the candle closed and where the
exit filled. Whether a plan invalidates on a close or on a touch, and whether it uses a protective
order at all, is a strategy choice. It is listed as unresolved in the [lifecycle](#a-lifecycle).

### B. Two paths

**Is it one strategy family?**

- **Plausible for the plan's structure.** Both paths need a direction, an invalidation stated
  before entry, sizing from planned loss and the distance to the stop reference, and a horizon. The plan record, the sizing
  arithmetic and the four separate decisions can be shared.
- **Not established for parameters or evidence.** Costs relative to movement, noise relative to
  trend, session effects and data latency all change with bar length.
- **Model 1.0.0 has been studied on daily bars only.** It is defined on 199 closed daily candles.
  Its thresholds are fixed per bar: ATR/close ≥ 4% means HIGH_VOLATILITY on any bar length, so the
  same reading on an hourly chart measures something else. The Pine HUD runs on any chart, but no
  study covers its non-daily readings.
- **Evidence for one path is not evidence for the other.** Proposed: one plan contract, with
  parameters versioned and validated separately for each path.

| Aspect            | Shared                                                                              | Intraday                                                                   | Weeks to months                                                              |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Holding horizon   | Stated with each plan                                                               | Within one session; the session itself (UTC day or another) is not defined | Weeks to months, stated                                                      |
| Context timeframe | Recorded with the plan                                                              | Shorter than daily; not chosen                                             | Daily or weekly; not chosen. Today's daily scan is one candidate             |
| Entry timeframe   | Recorded with the plan                                                              | Minutes to hours; not chosen                                               | Daily, or shorter for timing; not chosen                                     |
| Review frequency  | Recorded with the plan                                                              | During the session, while a position is open                               | At each context close, or less often                                         |
| Data              | **Not evaluated** when the data is older than the review frequency                  | Needs intraday candles close to real time. Popup's evidence has none       | Existing daily TradingView scans and saved snapshots                         |
| Direction         | Up, Down, Unclear                                                                   | Its own definition and validation                                          | Its own definition and validation                                            |
| Movement          | Measured and shown with its bar length                                              | Per intraday bar; not computed in Popup                                    | ATR(14) ÷ close of the daily bar, in every scan today                        |
| Invalidation      | Structured: level, close or touch, timeframe, plus the horizon                      | A structure break on the entry timeframe, or the session ending            | A structure break judged on the context close. Candle colour is not an input |
| Costs             | Fees stated; slippage named as excluded                                             | Large relative to movement; every figure needs them                        | Smaller relative to movement; still stated                                   |
| Sizing            | The scenario arithmetic below                                                       | Same                                                                       | Same                                                                         |
| Short, leverage   | Each would be its own plan; neither is available                                    | Product vision only                                                        | Product vision only. Funding builds up over weeks                            |
| Validation        | The same method: a frozen spec, a retrospective replay, then prospective collection | A separate study                                                           | A separate study                                                             |

### C. Budget, risk and existing holdings

- **Sizing** (implemented for one Spot plan). Quantity is the smaller of the available budget ÷
  entry and the planned loss ÷ the distance from entry to the stop reference. A stated fee
  assumption is included. This is the existing
  [Manual Spot scenario](TRADINGVIEW_CRYPTO_SCAN.md#manual-spot-scenario) formula. It assumes a
  fill at the entry reference and a loss taken exactly at the stop reference, with no slippage or
  gap.
- **Distance and size** (that arithmetic). If the chosen distance to the stop reference is larger,
  the same planned loss permits fewer units, under those assumptions. Volatility does not set a
  structural level. The level comes from the structure the plan names; ATR places it only if a
  separately specified rule says so. Measured movement can be shown beside the distance for
  comparison. High volatility does not exclude a pair.
- **Existing holdings** (proposed). Popup verifies no holding. The owner states the existing
  position in the pair, or confirms a balance read they requested, shown with its read time. An
  addition is sized so that the combined planned loss and combined exposure stay within the
  stated limits. A balance never becomes an experiment's holding by inference.
- **Across plans** (owner decision). Popup could show total planned loss across open plans, and
  exposure per pair and across pairs that tend to move together. Whether any of these is capped,
  and at what value, is for the owner to state. The paper policies are not adopted for real
  money. These are the 2% per trade at 2 × ATR and the 6% open-risk cap in `risk.ts`, the profile
  caps, and the tactical and HUD bands.
- **Leverage** (not authorized). Leverage changes exposure and the loss per unit of movement, not
  the quality of the thesis. A leveraged plan would also need its liquidation reference beyond its
  invalidation, and funding for its horizon. The offline arithmetic exists in the
  [leverage simulation](LEVERAGE_SIMULATION.md).

### D. Examples (synthetic)

The pair is EXAMPLEUSDT. Every number is an input chosen for illustration. None is a
recommendation or a threshold. The lines in quotes are the proposed visible output.

1. **Direction with tolerable counter-movement** (weeks to months, Long).
   - **Plan:** direction Up, stated by the owner on the daily timeframe. Entry reference 100.
     Invalidation: a daily close below 88, the last higher low.
   - **Then:** a week later, the latest daily close is 93.
   - **Shows:** "Direction: Up (owner-stated, daily) · Counter-movement inside the plan: close 93,
     −7% from the entry reference; invalidation (daily close < 88) not met · Thesis intact by its
     stated rule · Model Risk flag: high volatility — not an exit rule". No SELL and no HOLD.
   - **Colour plays no part.** A red candle closing at 102 is not counter-movement. A green one
     closing at 93 is, because of where it closed relative to the entry reference.
2. **High movement, no clear direction** (intraday).
   - **Situation:** hourly bars swing widely both ways.
   - **Shows:** "Movement: ATR(14) on 1h is x% of price · Direction: Unclear · Plan incomplete: a
     Long or a Short needs a direction; movement alone is not an entry".
3. **Favorable and risk evidence together** (weeks to months).
   - **Situation:** the day's scan has ZC LONG met and Risk: high volatility.
   - **Shows:** both lines, with no precedence and no combined label.
   - **Sizing:** budget 1,000 USDT, planned loss 50 USDT, entry reference 100. The owner's stated
     structural level, and so the stop reference, is 90, and the plan reads "5 units, limited by
     planned loss". Had the stated level been 95, the same planned loss would permit 10 units.
     Neither the Risk flag nor the measured movement sets either level.
4. **Missing or stale data.**
   - An intraday plan reviews hourly. Its last candle closed at 13:00 UTC, and it is now 15:10 UTC.
     It reads "Not evaluated: last candle 13:00 UTC, older than the review frequency".
   - A weeks-to-months plan reads "Stale: evaluated day D−1; a newer daily close exists".
   - An intraday plan with only a daily scan reads "Not evaluated: no intraday data in Popup".
   - None of these becomes HOLD or an exit. Missing data never becomes a sale.
5. **Invalidation.**
   - **Weeks to months:** the daily close is 87, below the stated 88. It reads "Invalidated: daily
     close 87 < 88 on D (stated rule) · Exit: your decision, recorded with its reason · No Short
     opened: a Short needs its own plan".
   - **Loss:** the scenario's planned loss was computed at a stop reference of 88. Taking the
     close-based rule, the price is already 87 when the invalidation becomes known. An exit fills
     after that, at whatever price follows, so the loss can exceed the planned figure.
   - **Intraday:** the stated session ends with the position open. It reads "Horizon reached".

### Candidate rules (not approved)

| Candidate                                                                                                                    | Plain-language rationale                                                                                | Proposed evaluation                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direction from structure on the context timeframe: higher highs and higher lows read Up, the reverse Down, otherwise Unclear | A Long needs price rising on the scale the trade lives on. Movement says how far, not which way         | A frozen spec for each path, then a retrospective replay. Measure how often each state persisted over the path's horizon, against the base rate for the same pairs and days. Then prospective collection. Unclear is a valid outcome, not a failure |
| Invalidation at the structure break, judged on the context close                                                             | The thesis's own premise fails there. A fixed percentage ignores whether a move is normal for the pair  | Fix each candidate definition before reading outcomes. Replay how often invalidation occurred, and what followed counter-moves that stayed inside it compared with breaks                                                                           |
| Compare the distance to invalidation with measured movement                                                                  | A level within one bar's typical movement may be met by ordinary movement rather than a structure break | Replay how often invalidation was met against the distance in ATR multiples, reported as a curve. No cut-off is chosen from the same data                                                                                                           |
| Time invalidation at the end of the horizon                                                                                  | A thesis that has not progressed ties up budget. An intraday position is not meant to carry overnight   | Replay the time to invalidation or to progress, for each path                                                                                                                                                                                       |
| Add only while the thesis is intact, within the combined planned loss                                                        | Adding to a failing thesis increases the loss on the weakest evidence                                   | Staying within the planned loss is arithmetic, not a strategy. Adding only after a favorable move needs a replay                                                                                                                                    |

Each candidate would be versioned, frozen before its results are read, and studied separately for
each path. The owner approves it before any screen treats it as more than a question. This is the
[scanner research](SCANNER_RESEARCH.md) method. A passed evaluation describes the rule on past
data. It does not establish profit with real money.

### Research candidate: swing structure (`swing-structure-direction` 0.1.0)

This contract makes the first two candidate rules exact. It was written before the code, and
[`scripts/swingStructure.ts`](../scripts/swingStructure.ts) implements it as one pure offline
function. The candidate is not approved. It is not connected to the scanner, the finance worker,
Pine, portfolio decisions, experiments or any screen. Every number in its tests is a test input,
not a setting. No parameter was tuned, and no historical data was read. No existing experiment
or record is given a result.

**Inputs.** All four are required. Nothing has a default.

- `candles`: closed candles in the order supplied, in the existing candle shape. Each has an
  open time `timestamp` and a `closeTime`, both in epoch ms, plus `high`, `low`, `close` and an
  optional `open`.
- `timeframe`: `{ label, intervalMs }`, stated by the caller. No bar length is assumed.
- `config`: `{ leftBars, rightBars }`. Both are positive integers.
- `cutoff`: epoch ms.

A malformed timeframe, configuration or cutoff throws, and nothing is evaluated.

**Candles used at the cutoff.**

- A candle is used only when `timestamp + intervalMs − 1 ≤ cutoff`. Later candles are never read.
- Each used candle must close at exactly `timestamp + intervalMs − 1`, the repository's
  inclusive-end convention. It must pass the existing `validatePrices` checks: finite and
  positive prices, high ≥ low, open and close inside [low, high].
- Each used candle must open exactly `intervalMs` after the previous one.
- A candle whose open time is not a positive integer is reported wherever it sits, because it
  cannot be placed on either side of the cutoff.
- Any failure gives status `INVALID_INPUT`, listing the issues: `CLOSE_TIME_CONVENTION_MISMATCH`,
  a price issue, `DUPLICATE_TIMESTAMP`, `TIMESTAMP_OUT_OF_ORDER`, `MISSING_INTERVAL` or
  `INVALID_TIMESTAMP`. The observation then has no direction.
- Nothing is sorted, deduplicated, filled or repaired.

**Pivots.** For the used candle at position i, with L = `leftBars` and R = `rightBars`:

- **Pivot high:** its high is strictly above each of the L previous highs, and at or above each of
  the R following highs.
- **Pivot low:** its low is strictly below each of the L previous lows, and at or below each of
  the R following lows.
- **Window:** a pivot needs L used candles before it and R after it.
- **Knowable:** the pivot's `availableAt` is the close time of candle i + R, not of candle i.
  Until then it is not reported at all. If a right-window candle exceeds it, it never appears.
- **Equal prices and plateaus:** only the first bar of a run of equal highs can be the pivot
  high, because an equal high in its left window blocks each later bar. Two separate pivots at
  the same price are both kept. Lows are the mirror image. Prices are compared exactly, with no
  tolerance.
- **Both at once:** a candle that qualifies as both, such as an outside bar, appears in both
  lists. Each list is ordered by candle time. Highs and lows need not alternate.

**Direction.** H1 and H2 are the two latest confirmed pivot highs, oldest first. L1 and L2 are the
two latest confirmed pivot lows.

| Condition                     | Status         | Direction | Reason                          |
| ----------------------------- | -------------- | --------- | ------------------------------- |
| Fewer than two highs or lows  | `INSUFFICIENT` | Unclear   | `INSUFFICIENT_CONFIRMED_PIVOTS` |
| H2 = H1, or L2 = L1           | `EVALUATED`    | Unclear   | `EQUAL_PIVOT_LEVEL`             |
| H2 > H1 and L2 > L1           | `EVALUATED`    | Up        | `HIGHER_HIGH_AND_HIGHER_LOW`    |
| H2 < H1 and L2 < L1           | `EVALUATED`    | Down      | `LOWER_HIGH_AND_LOWER_LOW`      |
| Any other combination (mixed) | `EVALUATED`    | Unclear   | `MIXED_STRUCTURE`               |

`establishedAt` is the latest `availableAt` of the four pivots. The state cannot be dated earlier,
and in particular never to a pivot's own candle.

**Structural reference.** For Up it is L2, the latest higher low. For Down it is H2, the latest
lower high. Unclear has none. It describes structure. It is not an order, an executable stop, a
loss cap, or a recommendation to open or close anything.

**Breach.** The search covers the used candles that open after the reference's `availableAt`.
Two separate facts are reported:

- `firstClose`: the first candle that closes beyond the reference, below it for Up and above it
  for Down;
- `firstExtreme`: the first candle whose low (Up) or high (Down) is beyond it.

Equal is not beyond. Each event carries its candle's open time and `knowableAt`, the close time of
that candle. A move through the level inside a candle becomes known only at that candle's close.
A breach changes neither the direction nor the reference. Nothing becomes SELL, Short or an exit.
The direction changes only when new pivots confirm, by the table above.

**Output.**

- Always: `candidateId`, `candidateVersion`, `config`, `timeframe` and `cutoff`.
- `INVALID_INPUT`: `issues`.
- Otherwise:
  - `closedCandles` and `latestCloseTime`;
  - `direction`, `reason` and `establishedAt`;
  - `supportingHighs` and `supportingLows`: up to two each, with price, `candleOpenTime` and
    `availableAt`;
  - `reference`;
  - `breach`.

There is no probability, confidence or profitability figure.

**Causality.** Evaluating a longer series at a cutoff gives the same observation as evaluating only
the candles used at that cutoff. Appending candles never changes an earlier observation.

**Walkthrough (synthetic, daily, L = R = 1).**

| Day | High | Low  | Close | Known at this day's close                                                           |
| --- | ---- | ---- | ----- | ----------------------------------------------------------------------------------- |
| D0  | 10   | 8    | 9     |                                                                                     |
| D1  | 12   | 10   | 11    |                                                                                     |
| D2  | 11   | 9    | 10    | Pivot high 12 (D1)                                                                  |
| D3  | 14   | 11   | 12.5  | Pivot low 9 (D2)                                                                    |
| D4  | 13   | 10   | 11.5  | Pivot high 14 (D3). `INSUFFICIENT`: two highs, one low                              |
| D5  | 15   | 12   | 13.5  | Pivot low 10 (D4). Up: 14 > 12 and 10 > 9. Reference 10 (D4)                        |
| D6  | 12   | 10.5 | 11    | Pivot high 15 (D5). Still Up: 15 > 14                                               |
| D7  | 11   | 9.5  | 10.2  | `firstExtreme`: low 9.5 is below 10. Still Up                                       |
| D8  | 10.4 | 9    | 9.4   | `firstClose`: close 9.4 is below 10. Still Up                                       |
| D9  | 10   | 9.2  | 9.6   | Pivot low 9 (D8). Lows 10 → 9, highs 14 → 15: Unclear (`MIXED_STRUCTURE`), not Down |

At D5's close, `establishedAt` is D5's close, never D4, the reference's own candle. From D6 it
is D6's close, because the four supporting pivots changed.

**Unresolved.** These remain open:

- L, R and the timeframe;
- whether two pivots of each kind are enough;
- a close or an extreme as the breach;
- a price tolerance;
- calendar bars such as months, and equity sessions, where a weekend reads as `MISSING_INTERVAL`.

Nothing has been evaluated on market data. A proposed
[evaluation specification](SWING_STRUCTURE_EVALUATION.md) fixes L, R, the timeframe, the pairs,
the dates and the base rate for one retrospective daily crypto study, before any run. Its choices
apply to that study only. They resolve none of the questions above for the product.

### Destination, order and open decision

The owner stated the following on review (2026-11-18). The proposal stays unapproved.

- **Destination.** Popup should eventually derive an explained proposal of direction and
  invalidation from an evaluated rule: a candidate rule that passed its frozen evaluation and was
  approved. Direction and levels entered by the owner may support planning in the meantime. They
  are not the final substitute for the requested indicator.
- **Recommended order.** Weeks to months first, because it can reuse the daily scans, saved
  snapshots and experiment review. Intraday stays in the design: one plan contract, with its own
  parameters, data source and validation. This order selects no timeframe, threshold or budget,
  and approves no strategy.
- **Open decision: money.** One budget for both paths, or separate budgets. And whether to cap
  total planned loss across open plans, with the value stated by the owner.

**Smallest next task (not started).** In the Manual Spot scenario, also show the distance from
entry to the stop reference as a multiple of the evaluated day's ATR(14), taken from the same
saved scan. It is labelled as a description of past daily movement. It concerns weeks to months
only, the path that has daily data. It adds no threshold, judgement, request, schema, snapshot or
model change, and it does not place or move the stop reference. It fits the recommended order. It
waits for this proposal's review.

## Not in this increment

- No correction, withdrawal or reopening of a close: the one close entry is final.
- No adding, editing or revising a scenario on an existing experiment, and no rule created from
  one.
- No P&L, totals, remaining quantity, leverage or order status, and no comparison of a plan with
  its fills.
- No scanner, model, scenario arithmetic or paper-ledger change. The saved-scan route stays local
  (`vite dev` only); the hosted app records from a file the owner opens, and a new scan still
  needs the owner's agent session.
- No new Binance requests, order actions or changes to the `binance-spot-account` function.
  Linking reuses a read the owner already made.
- No server-side verification of linked fills, and no correction path for a wrong link.

## Verification of reviewing another saved scan — 2026-11-17

Synthetic data only: invented `ZCT*` pairs and candles saved by the repository's own `saveScan`,
and two invented experiment records. Nothing reached Supabase, Binance or any other host. No
schema, RLS, RPC, function, payload or query changed.

| Check                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration tests (`experimentScanReview.test.tsx`, 12) | A later and an earlier file, another scan of the same day and month, and a file whose bytes match the referenced hash; candle order unknown for every one, the selected candle's full close time shown on its own; a regression case for each of: same day and month, a copy recorded more than a year after its source, a year boundary and a leap day; a matching hash with a contradicting copy, with an unreadable copy, and with a pair the scan did not evaluate; missing pair, short history, stale data and fetch failure; ZC LONG and ZC RISK both held in the copy; different and missing model/timeframe; refused replacement; close before the check answered; a late answer after a replacement; closing the disclosure; two experiments kept apart; no read, write, request or storage; the record object frozen and unchanged |
| Mutations                                               | Restoring only the guessed-year order (the latest matching day at or before the record time) fails all four named regression cases: `never infers the entry candle’s year from the record time (regression: guessed chronology)`. Restoring the "same evidence" wording, or letting a matching hash set the candle order, fails the matching-hash tests. Earlier: ticker-resemblance match, closing the disclosure not clearing, model always "same" and an unevaluated pair shown each failed a test                                                                                                                                                                                                                                                                                                                                        |
| Existing tests                                          | Saved scan file, recording, rule, observation, fill, close and tour tests pass unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Browser, desktop and 375 px, light and dark             | Vite dev server with Supabase at a closed local port, answered in the page; every other request and WebSocket aborted. Later scan, file matching the referenced hash, same-candle file (same scan ID, other bytes), tampered replacement (refused; the earlier evidence gone at once), unreadable copy with a short-history pair. After the chronology fix: a later file and the matching file each read candle order **Unknown** with the selected full close time; a matching hash with an unreadable copy and an unevaluated pair reads only a file match. No horizontal scroll at 375 px; the columns stack below 560 px                                                                                                                                                                                                                 |
| Keyboard                                                | Tab reaches the disclosure after Provenance and Enter opens it; Tab to **Choose a saved scan file** and Enter opens the chooser; Tab to **Close comparison** and Enter clears it and returns focus to the chooser button; closing and reopening the disclosure leaves nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Requests and storage                                    | From opening the disclosure to the verified comparison: no Supabase or HTTP request; `localStorage` and `sessionStorage` byte-identical. The session's other attempts came from the app's existing background market data (status poll, klines, price stream), answered or blocked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The model cannot practically produce ZC LONG and ZC RISK together in a reproducing file: a score of
78 or more under ATR ≥ 4% needs RSI near 0 with positive MACD. So both holding is checked on the
stored copy, and the selected column states each fact separately from the same function.

Not checked: Safari and Firefox, a physical phone, a screen reader, and the owner's real files or
record.

## Verification of the experiment overview — 2026-11-17

Synthetic data only: two invented `ZCT*` experiments answered by the browser test harness.
Nothing reached Supabase, Binance or any other host. The app's Supabase URL pointed at a closed
local port, and every request to it was answered in the page. Every other request and WebSocket
off the dev server was aborted. No schema, RLS, RPC, function, payload or query changed.

| Check                                                | Result                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Component tests                                      | Overview first and provenance in one closed disclosure; ZC LONG and ZC RISK both held; unreadable and missing evidence stay unknown; superseded rules; sells of every unit without a close; entries after a close; no read or write from opening       |
| Close review                                         | Still repeats the record summary; review, single confirm, conflict, refusal and uncertain-save tests unchanged and passing                                                                                                                             |
| Browser, desktop and 375 px, light and dark          | Overview at the top of the opened record (on `main` the summary began about 1,970 px down at desktop width, 3,690 px at 375 px); no horizontal scroll; a legacy record with unreadable evidence, no scenario and a fill linked after its close renders |
| Keyboard                                             | Tab reaches the experiment row, Enter opens it, the next Tab stop is the provenance disclosure, and Enter opens that and the close form                                                                                                                |
| Requests while opening the record and the disclosure | None. A confirmed close sent one insert, which the harness refused; the review said nothing was stored                                                                                                                                                 |

Not checked: Safari and Firefox, a physical phone, a screen reader, and the owner's real record.

## Verification of opening a saved scan file — 2026-11-17

Synthetic data only: a two-pair `ZCT*` crypto snapshot written by the repository's own `saveScan`.
Nothing touched production or Binance. No schema, RLS, RPC or function changed.

| Check                                                                                                                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node reader vs browser check, same synthetic file                                                                                                                                               | Both `VERIFIED`, same SHA-256 of the bytes, same view apart from `fromFile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The same JSON with other whitespace                                                                                                                                                             | Verifies in both under its own, different hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| One edit each: input hash, candle, universe, start time, evaluation time, score, rank, coverage, commit, model                                                                                  | Both refuse with the same state and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Published view, Binance-kline crypto, `assets_status`, equity, mixed, legacy, mismatched symbol, non-USDT pair, schema 2, old scanner, not UTF-8, not JSON, over 4 MB, 101 pairs, 1,001 candles | Refused with a specific reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The owner's 17 local snapshots, read-only (states and hash equality only)                                                                                                                       | 4 crypto scans: `VERIFIED` in both with equal hashes; 6 equity imports: still `VERIFIED` by the dev route, refused here as equity; 7 Market scans: refused as not TradingView. The TRX experiment's source scan hashes to the recorded `7f11268d…`                                                                                                                                                                                                                                                                                                                                                                                                      |
| Component tests                                                                                                                                                                                 | Replacement and close drop late answers; a refused replacement never shows the earlier file; oversized files are never read; no request or storage while opening and reviewing; owner, non-owner and signed-out recording; the insert carries the file hash, `match` and an included scenario, never candles                                                                                                                                                                                                                                                                                                                                            |
| Production build (`npm run build`, nitro `node-server` output) on a scratch `zcfile` stack, every non-local request and WebSocket blocked                                                       | Opened, verified and reviewed the file; its hash equals `shasum` of the file; **Stale** shown. Zero requests from opening, checking, reviewing or the scenario. Record: one `is_binance_spot_owner` call and one insert; the row holds the scan ID, file hash, `match` and the scenario, no candles; Account lists it (balance function answered `not_configured` in the page). A second user without the owner row got **Recording unavailable** and no form. Tampered, published-view and 4.5 MB files refused, the 4.5 MB one without a request. No `/__zerochart/` request. Blocked: only Research's own Binance klines and price stream, and fonts |
| `supabase test db` on the same stack, schema unchanged                                                                                                                                          | 9 files, 289 assertions pass, owner and RLS contracts included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Keyboard and layout                                                                                                                                                                             | Enter on the button opens the chooser; **Close file** returns focus to it; at 375 px no horizontal scroll and Tab stays in the evidence sheet; light and dark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Not checked: Safari and Firefox, a physical phone, a screen reader, and a real snapshot file in
the hosted app (the owner's files stay private).

## Verification of scenario snapshots — 2026-11-17

Synthetic data only. Nothing was written to production, and no request reached a Binance account.
The stack was a scratch `zcscenario` stack. The browser check used a separate worktree whose scan
store held one labeled `ZCT*` scan written with the repository's own `saveScan`, an invented owner,
and one experiment inserted the way earlier frontends insert (no snapshot). `binance-spot-account`
was answered in the page with `not_configured`. Unlike earlier checks, the app's public market-data
requests were not blocked.

| Check                                                                            | Result                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase test db`                                                               | 9 files, 289 assertions; `spot_experiment_scenario_snapshot.test.sql` adds 54                                                                                     |
| `upgrade.sh origin/main` (production-shaped experiment, rule, observation, fill) | 16 checks pass; only `20261117120000` applied; the old rows are unchanged and read as no scenario; an insert without the column and one with a snapshot both work |
| `upgrade.sh` from CI's pre-#79 base, then `supabase test db`                     | 12 checks pass (the experiment checks are skipped: no such tables there); 289 assertions pass                                                                     |
| `concurrency.sh`                                                                 | 19 checks pass                                                                                                                                                    |
| Release contract against the stack                                               | All 32 migrations and every RPC this frontend calls                                                                                                               |
| Weakened, then the suite run again                                               | Shape check dropped: 25 failures. Fee rule alone dropped: 3. Owner `UPDATE` granted: 6. Insert grant revoked: 33. Service role may insert: 2                      |
| Default                                                                          | **Include this scenario in the record** unchecked; Tab reaches it after the stated time, Space turns it on                                                        |
| Review (desktop, then 375 px sheet)                                              | Every input and figure shown, small-price entry `0.0000047` and quantity `1,724,137.93103448` exact; no write while reviewing; heading takes focus                |
| Scenario changed after review                                                    | Alert, Confirm locked, a press sent nothing; restoring the reviewed value unlocked it                                                                             |
| Three presses of Confirm (click, Enter, click)                                   | One insert. The stored snapshot equals the reviewed one                                                                                                           |
| Unspecified fee, then a stated zero                                              | Stored as `null` without fees and as `"0"` with `0.00` fees; reviewed and shown as **Not specified** and **0% of each fill, as stated**                           |
| Account                                                                          | Both snapshots shown as stored, the legacy row as **No scenario recorded**, every rule **Not decided**; summaries unchanged                                       |
| Layout                                                                           | 375 px: no horizontal page scroll, one column of facts, checkbox beside its label. Light and dark themes checked                                                  |

Unsupported and unreadable snapshots cannot be stored under the current check, so they were
checked with component tests only.

## Verification of closing — 2026-11-14

Synthetic `ZCT*` data only. Nothing was written to production, and no request reached Binance.
Component tests replace the Supabase client. The browser check ran on a scratch `zcclose` stack
built from every migration, with an invented owner and four invented experiments. In the browser
(Playwright, time zone Asia/Jerusalem), every request outside the local app and stack was aborted,
including the app's public Binance price requests and WebSocket, and the `binance-spot-account`
function was answered in the browser with `not_configured`.

| Check                                          | Result                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Reason and stated time                         | Empty reason refused (unit test); 15:00 typed in a UTC+2 browser was reviewed and stored as 15:00 UTC; a future time is refused (unit test) |
| Review                                         | Shows the reason, times, the no-order and no-position statements and the record summary; nothing is sent                                    |
| Owner row removed before Confirm               | `403` permission denied, "Nothing was stored"; after restoring it, the same review saved                                                    |
| Three presses of Confirm (click, Enter, click) | One insert, `201`; no **Add another**                                                                                                       |
| Close stored meanwhile by another session      | `409` reported as **Already closed**; Confirm locked; the refreshed summary shows the other close; no form                                  |
| Response dropped after the database stored it  | "May or may not be stored"; locked; the refreshed history shows the stored close; one row                                                   |
| Evidence after the close                       | An observation added through the form and a sell fill linked later both show as after the close                                             |
| Full reload                                    | Close, its stated and recorded times, later evidence and the summary counts unchanged; one close per experiment                             |
| Keyboard                                       | Enter opens the disclosure; Tab reaches the reason, the time and Confirm; the review heading takes focus                                    |
| Layout                                         | 375 px: no horizontal page scroll, one column of facts. Light and dark themes checked                                                       |

## Verification of rules and observations — 2026-11-14

Synthetic `ZCT*` data only. No production write or live Binance request was made. Component tests
replace the Supabase client; the existing database suite verifies the unchanged entries schema and
supersession constraints.

| Check                                    | Result                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Rule review and repeated Confirm         | One insert containing only the reviewed rule; no scenario or fill values                                  |
| Proposed → approved → withdrawn          | Each change supersedes the current entry; all versions remain visible                                     |
| Concurrent named-rule change             | Unique conflict reported; history refresh requested; no success claimed                                   |
| Permission refusal and missing response  | Refusal allows correction; an unanswered save stays locked and is never reported as stored                |
| Successful immutable entry               | No edit offered; Add another opens a blank draft and rules retain the current supersession head           |
| Failed history refresh after uncertainty | Save stays locked; stale history remains inspectable and no successful refresh is claimed                 |
| Observation review                       | Requires where and stated UTC time; review and history show stated and database times                     |
| Open-stop observation                    | Displayed only as what was observed then, never current status                                            |
| Persistence                              | Reloaded synthetic records retain rule history, observation provenance and retrospective labels           |
| Keyboard and mobile                      | Native disclosure/select controls, focused review heading, and one-column facts/forms at 560 px and below |

## Verification of fill linking — 2026-11-14

Synthetic data only. Nothing was written to production, and no request reached Binance. The stack
was a scratch `zclink` stack built from every migration, with an invented owner and four invented
experiments (two `main`/`BTCUSDT`, one `spare`/`BTCUSDT`, one `spare`/`ETHUSDT`). In the browser
(Playwright), every request outside the local app and stack was aborted before the page loaded,
including the app's public Binance price requests and WebSocket, and the `binance-spot-account`
function was answered in the browser with invented fills: two buys, a sell, and one conflicting
trade.

| Check                                                          | Result                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Controls                                                       | Consistent rows only; the conflicting trade had none. Only the label's experiments for the pair were offered |
| Review, then three presses of Confirm (click, Enter, click)    | One insert, `201`. The stored row equals the review: decimal strings and commission assets unchanged         |
| Fill time outside the requested window (a fixture mistake)     | Refused by the database's window check; "Nothing was stored", Confirm available again                        |
| Same trade linked meanwhile to another experiment, other value | `409`, then a read-back: names the other experiment and the differing field (quantity); nothing stored       |
| Owner row removed before Confirm                               | `403` permission denied, nothing stored; after restoring it, the same review linked                          |
| Response dropped after the database stored the link            | "May or may not be stored"; the row then showed Linked; Try again gave Already linked, same values; one row  |
| Account label changed                                          | Result cleared; under the other label the same trade was linkable again (identity is scoped by label)        |
| Sell linked                                                    | Stored as a sell; no entry written; the experiment stayed Not closed                                         |
| Full reload, Account                                           | Every experiment listed its fills exactly, with retrieval time, window, coverage and link time               |
| Keyboard                                                       | Enter opens the panel and focuses its heading; Tab reaches the list, Confirm, Cancel; Cancel restores focus  |
| Layout                                                         | 375 px: no horizontal page scroll, one column of facts, values wrap. Light and dark themes checked           |

## Verification of the recording UI — 2026-11-14

Synthetic data only. Nothing was written to production, and no request reached Binance. The stack
was a scratch `zcrecord` stack built from every migration. Its users were invented, and its scans
were labeled `ZCT*` fixtures written with the repository's own `saveScan` into a separate worktree.

| Check                                                         | Result                                                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Hash from the saved-scan route against `shasum -a 256`        | Equal. Rewriting the same JSON in other bytes kept `VERIFIED` and changed the hash                                              |
| Owner check, before and after the owner row                   | `false`, then `true`. Before it, the owner's insert was refused with `42501`                                                    |
| Inserts from another user, `anon` (what `?devAuth` would use) | Refused, `42501`                                                                                                                |
| Inserts naming `id` or `recorded_at`, or a future stated time | Refused: column privileges, then the time check (`23514`)                                                                       |
| Update by the owner                                           | Refused, `42501`                                                                                                                |
| Embedded list read                                            | The owner got the rows with `spot_experiment_entries` and `spot_experiment_fills` embedded; another user got none               |
| Browser record, three rapid Enter presses on Confirm          | One `201` insert. Hash, scan, stated time and 10 evidence facts stored; no entry or fill                                        |
| Owner row removed between review and Confirm                  | `Not recorded. Permission denied…`; no row added. Account then showed the unavailable state                                     |
| Release contract against the stack                            | All 31 migrations and every RPC this frontend calls                                                                             |
| Keyboard                                                      | Enter opens the disclosure; errors focus the first invalid field; review focuses its heading; Tab wraps inside the 375 px sheet |
| Layout                                                        | 375 px: no horizontal scroll, one column of facts, the hash wraps. Light and dark themes checked                                |

Account's Binance card needs the `binance-spot-account` function, which the scratch stack doesn't
serve, so that one response was answered in the page with `not_configured`.

## Verification — 2026-11-14

Local only. Nothing was written to production. The stack was a scratch `zcexperiment` stack (DB on 56122) built from every migration.

| Check                                                            | Result                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `supabase db start` from an empty database                       | Every migration applies, `20261114120000` last                                       |
| `supabase test db`                                               | 8 files, 235 assertions. `spot_experiments.test.sql` adds 75                         |
| `supabase/tests/upgrade.sh origin/main`, then `supabase test db` | 12 upgrade checks pass; only `20261114120000` is applied on top; 235 assertions pass |
| The same from CI's pre-#79 base (`20261023120000`)               | 12 upgrade checks pass; 235 assertions pass                                          |
| `supabase/tests/concurrency.sh`                                  | 19 checks pass                                                                       |

`spot_experiments.test.sql` covers:

- **Access:** fail-closed access, the owner gate for signed-in non-owners, an owner change and
  removal, and anon.
- **Server-set columns:** client attempts to set the owner, recorded time or ID.
- **Append-only:** update, delete and truncate refused for the owner and the service role, and the
  service role kept read-only.
- **Validation:** every format and time check.
- **Rules:** replacing a rule once, one chain per named rule, several `other` rules, withdrawals
  and the current-rule query.
- **Observations:** time and place required.
- **Fills:** exact strings, identity scoped by account label, pair and label matching, the window,
  decimal format, and links to another user's experiment refused.
- **Partial exits and closing:** a partial exit, no implied close, one explicit close, and a fill
  linked after the close.
- **Separation:** from the paper, portfolio and signal tables.

Each protection was then weakened inside a rolled-back transaction, and the suite run again. Every
weakening made named assertions fail:

| Weakened                                                     | Failing assertions                        |
| ------------------------------------------------------------ | ----------------------------------------- |
| Policies check row ownership only, not the configured owner  | 7, including fail-closed and owner change |
| Service role granted insert, update, delete                  | 3                                         |
| Clients may insert every column                              | 3 (owner, recorded time, ID)              |
| Fill identity unique key dropped                             | 2                                         |
| One-close index dropped                                      | 1                                         |
| Replace-once key dropped                                     | 2                                         |
| One chain per named rule dropped                             | 2                                         |
| Stated time may follow recorded time                         | 1                                         |
| Owner granted `UPDATE`                                       | 1                                         |
| Fill linked by experiment ID only (pair and label unchecked) | 3                                         |
| Configuration readable by every signed-in user               | 1                                         |
| A rule may replace any entry                                 | 3                                         |
| A fill references `paper_transactions`                       | 1                                         |

## Production release (2026-11-13)

All times are UTC. #171 was merged as `14894a8` before its migration reached production, so it
was released by the [delayed-migration path](RELEASE.md#delayed-migrations).

| Step                     | Result                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First production build   | **Failed** at the release gate: `migration 20261114120000 is not applied`. That was the only gap it reported. Nothing went live, and production kept serving `01dc3e1`                                                                                                                                                              |
| Pre-checks               | A clean checkout of `14894a8`. The migration file's SHA-256 matched the reviewed file. Production's history and catalog showed the migration not applied and none of its objects present. The dry run listed only `20261114120000`                                                                                                  |
| Migration                | `supabase db push` applied `20261114120000` only, with no seeds or roles                                                                                                                                                                                                                                                            |
| Verification             | Production matched a fresh local build of the same files: RLS on all four tables, the 7 policies, table and column grants, the function's security mode, source and execute rights, constraints, indexes and triggers. All four tables were empty. The release contract passed: all 31 migrations and every RPC this frontend calls |
| Retried production build | **Succeeded.** A redeploy of the failed deployment built `14894a8` again, passed the gate and went live                                                                                                                                                                                                                             |

At release, the owner configuration was empty, so nobody could read or add an experiment. No UI
existed, and no experiment had been recorded. Configuring the owner is a separate step
([Release](RELEASE.md#manual-spot-experiments-20261114120000)).
