# activityShock24h incremental value: historical development screen (PROPOSED / NOT RUN)

**Status: design only, and blocked before retrieval.** This proposes one historical screen of
whether [#224](BINANCE_ACTIVITY_FEASIBILITY.md)'s `activityShock24h` adds information to #222's
classifier. The machine-readable specification is
[`spot-24h-activity-shock-increment-dev-v1.json`](spot-24h-activity-shock-increment-dev-v1.json)
(revision 2, not frozen). Nothing was retrieved, exported, fitted or scored. The terms covering
the proposed REST endpoint remain **unresolved** after two reviews, so no retrieval may follow
from this revision. [#222](SPOT_24H_EXPECTED_NET_T3S3_DEV_V1.md)'s `STOP` and every earlier
study stand. The owner accepted the four defaults on 2026-11-26 ([decisions](#owner-decisions)).

## In brief

- **One comparison.** On v1's 20 pairs, decision grid, chronological splits, 24-hour boundary
  purge and T3S3 labels: arm A is #220's eleven price features; arm B is the same eleven plus
  `activityShock24h`. Same rows, labels, `HistGradientBoostingClassifier`, #222's fixed settings,
  seed and environment. Primary metric: the paired per-observation difference in three-class
  Brier score, B − A.
- **Two development evaluations.** Fit on train and score validation; fit on train + validation
  and score test. Both periods are examined history (an eighth look), so a pass can only justify
  reviewing a separate prospective proposal. It cannot establish predictive support,
  profitability or permission for live use. A better Brier score is information value only,
  never evidence of trading readiness.
- **Terms: unresolved, retrieval blocked.** The Terms of Use govern unauthenticated public
  market-data access and incorporate a Prohibited Use Policy. The copy of that policy read has an
  unconfirmed publication status. No text read expressly permits copying or keeping the returned
  data offline for research, and none is a confirmed prohibition of it. See
  [Source terms](#source-terms).
- **No economics.** No entries, expected-net plug-in, payoffs, costs, wallet or backtest. This
  isolates information value only.

## Why this screen, and why it is narrow

#224 found that Popup discards kline activity fields, proposed one block (a 24-hour base-volume
shock against the pair's own previous 30 days) and one hypothesis: adding it lowers
three-class Brier on identical opportunities and labels. It also said a historical screen on
v1's period would be development only. This specification designs that screen, not the
prospective evaluation.

Everything except the extra column is reused, so the only difference between the arms is the
feature:

| Part                    | Reused from                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ |
| Pairs, grid, splits     | Protocol v1 (`splitOf`, purge of labels crossing a boundary)                   |
| Labels                  | v1's `resolveOutcome` at T3S3, #222's class mapping (AMBIGUOUS → STOP)         |
| Price features          | #220's `featuresOf`; rows taken from #222's recorded dataset and recomputed    |
| Estimator and settings  | #222's C: settings, `verifiedParams`, seed 17, pinned scikit-learn 1.9.1       |
| Calibration definitions | #222's in-the-large and decile error, with its limits as labels                |
| Uncertainty             | #222's method: v1's `dayOrders` and `ratioInterval`, 7-day blocks, 10,000 reps |
| Feature                 | #224 section 5, unchanged                                                      |

If no observation loses its activity value, arm A must reproduce #222's recorded C probabilities
exactly (1e-12). That check shows that arm A is #222's classifier and not a re-implementation.

## Source terms

Reviewed twice on 2026-11-26, from official Binance documents only. This is a reading of the
text, not legal advice or an assurance. Silence is treated as neither permission nor prohibition.

**Conclusion: unresolved, but narrowed.** Unauthenticated public market data falls under the Terms
of Use, not under the account-access API terms. The Terms of Use incorporate a Prohibited Use
Policy. The only copy read was found on Binance's CDN and was not matched to the current policy
page, so its publication status and applicability are unconfirmed. That copy restricts automated
access, obtaining and copying "except as expressly permitted". Binance's own documentation of the
public market-data endpoints plausibly gives that permission for automated _access_. No text read
expressly permits _copying or keeping_ the returned data offline for research. Nothing read is a
confirmed prohibition of this research either. Blocker `TERMS_UNRESOLVED` stands: no retrieval.

**Supporting clauses.**

- **Terms of Use** (ADGM Binance Entities), effective 27 October 2026. CDN PDF `f7c3c8a8…`, 74
  pages, matched to the binance.com viewer by date and page count.
  - _Preamble:_ accessing the Binance Platform is acceptance, and Local Terms supplement the
    Agreement where they apply.
  - _Definitions:_ the Platform includes access via a Binance API.
  - _1.3.1(c):_ the Prohibited Use Policy is a core policy for all users.
  - _26–27:_ Binance IP may be used only as needed to receive the services, for "non-commercial
    personal or internal business use". IP rights include database rights.
  - _14.1.2(b):_ account access through APIs needs separate API terms and Binance's approval.
  - _33.1:_ the right to access the Platform is revocable.
  - _33.7–33.8:_ APIs are part of the Technology, and some databases in it are proprietary.
  - _3.1:_ questions go to customer support.
- **Prohibited Use Policy, copy of unconfirmed status.** CDN PDF `3c287bd6…`, 3 pages, saying
  "Last updated: 5 January 2026".
  - _Status:_ found by search, with "[DRAFT]" in its metadata title. It was not matched to the
    policy page the Terms of Use link (`/en/about-legal/prohibited-use-policy`, client-rendered,
    not read). Whether it is the policy in force is not established.
  - _Section I (this copy):_ crawlers, bots, programs or scripts used to access, obtain, copy or
    replicate Binance Services are prohibited unless expressly permitted. So are unreasonable load
    and copying or replicating any part of the Binance Platform.
  - _Section D (this copy):_ resale or commercial use needs Binance's written authorization.
- **Spot API documentation** (`rest-api.md`, `market_data_only.md`, and the "SPOT Exchange Terms
  of Use" page, which only points to the Terms of Use).
  - Documents the public endpoints, their rate limits and a market-data-only host,
    `data-api.binance.vision`.
  - Has no licence, storage or research clause.

**Public market data versus account APIs.**

- _Account-access APIs_ (API keys, signed endpoints): clause 14.1.2(b) adds separate API terms
  and approval. Those terms were not located (`/en/about-legal/api-key-terms` returns 404).
  Neither this screen, v1 nor the probe uses them.
- _Unauthenticated public market data_ (`GET /api/v3/klines`, no key): governed by the Terms of
  Use, including the Prohibited Use Policy they incorporate, whose current text is unconfirmed.
  No market-data-specific terms were found. The Product Terms
  list (client-rendered, no CDN copy found) was not read, so whether any Product Terms cover
  market data is unknown.

**Not settled by the text.**

1. Whether the policy copy read is the one in force.
2. Whether "expressly permitted" covers copying and keeping the responses, or only access.
3. Whether API market data is "any part of the Binance Platform" or Binance IP.
4. Whether offline research is "as needed to receive the services" under clause 27.
5. Whether publishing aggregates derived from the data is allowed. This repository is public.

**Regional uncertainty.**

- Binance's global terms moved to the ADGM entities from 5 January 2026. binance.com served the
  ADGM version here, while the en-AE page carried a Binance FZE (VARA) footer.
- Local Terms supplement the Agreement where they apply. Which ones bind the owner depends on
  residence and the entity holding the account, which was not determined.
- Both PDFs were found on Binance's CDN by search, and their metadata titles say "Draft". The
  Policy copy was not matched to the binance.com page.
- binance.com legal pages render client-side. Opening one in the owner's Chrome triggered an
  automatic Google social-login redirect, so the PDFs were read from the CDN instead.

**Existing files.** v1's universe and 20 candle files (retrieved 2026-11-22) and #224's 60 probe
responses (2026-11-26) came from the same endpoint, without a key, under the same documents, so
the same question applies to them. Aggregates from v1's candles are already published in this
repository (#215–#223). The files are preserved unchanged: not deleted, edited, re-retrieved or
redistributed.

**Archive terms, kept separate.** The Binance Vision Dataset Terms (version 1.0, last updated
2026-08-26, unchanged since #224) cover data from `data.binance.vision` "and associated
endpoints". They grant CC BY-NC-SA 4.0 and list personal non-production backtesting as permitted
(4.1). They do not name `api.binance.com`. They are not relied on here, and this specification does
not switch to the archive or to a `binance.vision` host.

## Clarification request (prepared, not sent)

Only the owner decides whether to send this. The agent does not contact Binance.

**Route.** Terms of Use clause 3.1 sends questions to customer support at
<https://www.binance.com/en/chat>. Ask there for the question to be passed to the legal team.
`legal@binance.com` appears in the policy copy read only for reporting violations.

**Question.**

```text
Subject: Is keeping public Spot kline data for private, non-commercial research permitted?

I would like to confirm the scope of the Binance Terms of Use (effective 27 October 2026) and the
Prohibited Use Policy they incorporate for the use below. Please refer this to the legal team if
needed.

Intended use:
1. Unauthenticated GET requests to https://api.binance.com/api/v3/klines (interval 1h) for 20
   USDT Spot pairs: about 380 requests, one at a time at least 250 ms apart, within published
   rate limits, stopping on any 429 or 418.
2. Keeping the raw responses privately on one computer for offline statistical research by one
   individual, together with similar responses retrieved in November 2026 (two years of hourly
   candles for the same pairs, and 60 single-day samples). No redistribution of the data, no
   commercial use, no trading service and no signal distribution.
3. Publishing only aggregate statistics computed from the data (for example forecast-accuracy
   scores), never the data itself, in a public, non-commercial code repository.

Questions:
a) Is automated retrieval through this documented public market-data endpoint "expressly
   permitted" under section I of the Prohibited Use Policy?
b) Does clause 27 of the Terms of Use (non-commercial personal use) cover keeping and analysing
   the responses offline as described in 2?
c) Do separate API terms (clause 14.1.2(b)) or any Product Terms apply to unauthenticated
   market-data endpoints? If so, where are they published?
d) Is publishing aggregate statistics as described in 3 permitted, and is attribution required?
e) Do the Binance Vision Dataset Terms apply to responses from api.binance.com?
f) Is the Prohibited Use Policy marked "Last updated: 5 January 2026" the version currently in
   force? If not, where is the current version published?
```

## Scope

**In:**

1. A retrieval of 380 requests: candles opening 2024-10-22T00:00Z to 2026-11-21T23:00Z for 20
   pairs, 18,264 hours each. That includes the 744-hour warm-up for the first decision, 544 hours
   of which precede v1's saved history.
2. Write-once storage in its own git-ignored directory, with raw bodies, a hash manifest and a
   validation file.
3. Full field validation (the probe's checks over every hour) and exact OHLC and presence parity
   with every v1 hour.
4. `activityShock24h` as #224 defines it.
5. Four fits: two arms × two evaluations.
6. Metrics, paired intervals and one verdict.

**Missing, invalid and zero hours.** A zero-volume hour is valid and enters the sums. A missing or
invalid hour anywhere in a decision's 744 hours, a zero block, or zero dispersion makes the decision
ineligible for **both** arms. Nothing is imputed or repaired.

**Coverage.** Per split, the denominator is every grid decision of that split: train 43,700,
validation 21,620, test 21,980. Purged decisions are left out. At least 95% must be common
observations in each split.

**Reported, not gated.**

- Per-class Brier components and log-loss differences, with intervals.
- Both arms' probability calibration against #222's limits.
- A monthly table, the count of months favouring B, and per-pair figures.
- Every exclusion and hour classification.

**Out:**

- Entries, payoffs, costs, returns, wallets and backtests.
- Other activity fields, windows, normalizations, models, settings, labels and scenarios.
- Collection, schedules, UI, alerts, orders, production changes and merges.

## Stop conditions

| Verdict                 | When                                                                                                                               | Then                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `INTEGRITY_FAILURE`     | Any hash, v1 directory, manifest, validation, OHLC parity, #222 row parity, reproduction of C, environment or identity check fails | Nothing reported; a new revision is needed                               |
| `INSUFFICIENT_EVIDENCE` | Coverage < 95% in any split, < 2,000 observations or < 90 days in an evaluation, a missing class, or < 9,900 defined replicates    | Screen ends; floors are not relaxed, no source switched                  |
| `SCREEN_PASSED`         | In both evaluations: mean B − A < 0 with 97.5% upper bound < 0, and still < 0 with each calendar month left out                    | Permits writing a separate prospective proposal for review, nothing else |
| `STOP`                  | B − A lower 2.5% bound > 0 in either evaluation, or mean ≥ 0 in both                                                               | Activity block ends; no other field, window, model or label              |
| `INCONCLUSIVE`          | Anything else (for example negative means whose interval reaches 0, a failed leave-one-month-out, opposite signs)                  | Historical screen ends; no rerun, no variation, no prospective proposal  |

Before any of this, three preconditions must hold. The retrieval is also stopped and kept as
`RETRIEVAL_INCOMPLETE` on a second 429, any 418, 403 or 451, used weight above 3,000, or any other
failure.

1. The owner approves this proposal.
2. The terms are resolved and cited.
3. The frozen revision is committed alone.

## Owner decisions

Accepted on 2026-11-26, with these boundaries:

1. **Terms.** Review the missing official documents only (done above). Do not contact Binance on
   the owner's behalf; the question and route are prepared above for the owner. The blocker
   remains.
2. **Host.** `api.binance.com`; no source switch.
3. **Calibration.** Reported, not gated, which departs from #224 section 6. #222 recorded this
   estimator on A's features missing the limits once per period. A better Brier score is never
   presented as evidence of trading readiness.
4. **Existing files.** Included in the applicability review above and preserved unchanged.

## Limits

- Both periods were examined by seven earlier looks. A pass is not untouched evidence.
- The arms share eleven features, so the paired interval is narrow by construction. Seven-day
  blocks do not capture regimes longer than a week.
- OHLC parity shows prices unchanged since v1's retrieval. Volume has no earlier copy, and
  whether Binance revises closed klines is undocumented.
- `activityShock24h`'s transfer from the daily, multi-exchange evidence to hourly Binance pairs is
  uncertain (#224 section 5).
