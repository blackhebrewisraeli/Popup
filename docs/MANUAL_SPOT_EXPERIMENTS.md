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
entries table ([Closing](#closing-in-account)).

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

| Table                     | One row per                                      | Written by                                                    |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| `spot_experiments`        | Experiment: source scan, evidence and decision   | The owner. ID, owner and recorded time come from the database |
| `spot_experiment_entries` | Rule, observation or close, in the owner's words | The owner                                                     |
| `spot_experiment_fills`   | Linked fill, copied from a Popup Binance read    | The owner's browser                                           |

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
  with a status. Nothing is inferred from the scenario's inputs, earlier conversations or other
  rules. A named rule with no current approved entry is not decided. That holds for any horizon,
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

**Record experiment** sits under **Plan a hypothetical scenario** in a TradingView crypto pair's
evidence. It asks the database nothing until it is opened.

- **A saved scan only.** Choose the scan under **Scan shown**. The local saved-scan route
  (`vite dev` only) reproduces the snapshot offline and reports `snapshotSha256`, the SHA-256 of the
  file's bytes from that same read. The published view is not the snapshot file, so it offers no
  form and says which scan to choose.
- **Who.** A signed-in user whom `is_binance_spot_owner()` names. The `?devAuth` stub has no
  session, so the form never appears and nothing is sent. Without a session, the database refuses
  `anon` anyway. Anyone else is told recording is unavailable, never who the owner is.
- **The owner states:** the decision in their own words, an account label (the database's format),
  and optionally when they decided (`datetime-local`, read as UTC, never after now).
- **Copied:** the pair, the scan ID, the snapshot hash, `source_reproduction = 'match'`, and the
  candidate's evidence exactly as **Recorded evidence it rests on** shows it (the same facts, in
  the same words, plus rank, setups and staleness). Snapshot identity, reproduction and
  authenticity stay separate facts, as [above](#what-each-fact-establishes).
- **Not copied:** the scenario's inputs and figures. No entry is written, so every rule stays
  **Not decided** until the owner adds one.
- **Labels.** A stated time marks the record **Retrospective**. A stale scan marks it **Historical
  scan**, recorded retrospectively from evidence about an earlier day.
- **Review, then confirm.** **Review record** shows every value that will be stored. Only **Confirm
  and record** sends it. The button locks before the request leaves, so repeated presses send one
  insert.
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

**Manual Spot experiments** sits inside Account's **Binance Spot** card, so only the owner the
`binance-spot-account` function recognizes sees it. The database still decides what it shows.

- **States.** Loading, empty, unavailable (the database names no owner, or another one), refused
  (permission denied), and failed. A failure never shows an empty list in its place.
- **One read.** The owner's newest 100 experiments, each with its entries and linked fills
  embedded.
- **Each experiment.** Pair, account label, and both times: the stated decision time (or **Not
  stated**) and the database's recorded time. Then the scan, snapshot SHA-256, reproduction,
  authenticity (**Not established**), and the copied evidence.
- **Rules.** Each named rule shows its current version as **Proposal**, **Approved** or
  **Withdrawn**. A proposal or withdrawal is also labelled **Not decided**. The complete immutable
  history remains available. A change or withdrawal always supersedes the current entry; several
  unrelated `other` rule lines may coexist.
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
- **Record summary.** Under the linked fills, one factual summary: the decision with its stated
  and recorded times, the source scan with its reproduction and authenticity, which named rules
  are approved or not decided and how many rule entries the history holds, how many fills are
  linked by side, how many observations are recorded, and the close (**Not closed** or the owner's
  stored close). After a close it also counts the fills, rule entries and observations recorded
  after it. Counts only: no position, total, P&L, remaining quantity, order status or rating.
- **Close.** **Close experiment record** adds the owner's close ([Closing](#closing-in-account)).

## Closing in Account

**Close experiment record** sits under the record summary of an experiment that has no close.

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

## Not in this increment

- No correction, withdrawal or reopening of a close: the one close entry is final.
- No P&L, totals, remaining quantity, leverage or order status.
- No scanner, model or paper-ledger change, and no schema migration.
- No new Binance requests, order actions or changes to the `binance-spot-account` function.
  Linking reuses a read the owner already made.
- No server-side verification of linked fills, and no correction path for a wrong link.

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
