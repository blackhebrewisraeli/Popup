# Manual Spot experiments: storage and access

A manual Spot experiment follows one real Binance Spot decision from the scan it came from to what
was observed afterwards. It records:

- the source scan and the candidate's evidence;
- the owner's decision and the rules the owner set;
- the fills the owner links;
- dated observations, and the owner's explicit close.

**Stage: storage only.** Migration `20261114120000` adds the tables, the access rule and their
validation. Nothing in the app reads or writes them yet. A later increment adds the views in
**Account**, separate from the paper Signal Journal: recording from the
[Manual Spot scenario](TRADINGVIEW_CRYPTO_SCAN.md#manual-spot-scenario) and linking fills from the
[execution view](BINANCE_SPOT_ACCOUNT.md#execution-history-coverage).

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

| Fact               | Column                                          | Establishes                                                                                                            | Does not establish                                                                                                                                            |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot identity  | `source_snapshot_sha256`                        | Which bytes the experiment refers to: the SHA-256 of the snapshot file, as the browser reported it                     | That the scan is authentic, or that it reproduces. The database can't read the file. Any other copy with the same bytes has the same hash                     |
| Reproduction       | `source_reproduction`                           | What the local offline reproduction reported when the record was made: `match` or `not_checked`. `mismatch` is refused | That it would reproduce now. The database can't re-run it, and the value is client-submitted                                                                  |
| Authenticity       | none                                            | Nothing                                                                                                                | Local snapshots are unsigned. No column shows that the scan came from Popup's scanner or from TradingView data                                                |
| Candidate evidence | `source_evidence`                               | What the browser showed for the candidate (rank, setups, freshness), as a copy                                         | It is not re-derived from the snapshot                                                                                                                        |
| Recorded time      | `recorded_at`                                   | When the database stored the row (`clock_timestamp()`). Clients can't set it                                           | When anything happened in the market or in Binance                                                                                                            |
| Stated time        | `decision_stated_at`, `stated_at`               | When the owner says the decision was made, the rule was set, the observation was made or the experiment ended          | Anything the database can check. Never after `recorded_at`. Null means not stated                                                                             |
| Fill               | `spot_experiment_fills`                         | The values the owner's browser submitted, copied from the execution view                                               | That Binance holds that fill. The server doesn't re-read Binance to verify it: the row is **client-submitted evidence**, not a server-verified Binance record |
| Read behind a fill | `retrieved_at`, `window_*`, `coverage_complete` | The read the browser says it copied from: the function's clock, the requested window and whether every page was read   | The same limits as the fill. Coverage complete covers that window and pair only                                                                               |
| Account context    | `account_label`                                 | The caller's label for the Binance account. It scopes fill identity                                                    | Which Binance account that is. Popup reads no Binance account identifier, so the label proves nothing about identity                                          |
| Order status       | none                                            | Nothing                                                                                                                | Popup reads no orders. An observation is what the owner saw, and when, never a current status                                                                 |

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

## Not in this increment

- No UI: recording, linking and the Account view come next.
- No `types.ts` entries and no `DB_CONTRACT` change: the frontend calls nothing new.
- No Binance requests, order actions or changes to the `binance-spot-account` function.
- No server-side verification of linked fills, and no derived totals.
- No owner configuration in production.

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
