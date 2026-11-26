# activityShock24h incremental value: historical development screen (PROPOSED / NOT RUN)

**Status: design only, and blocked before retrieval.** This proposes one historical screen of
whether [#224](BINANCE_ACTIVITY_FEASIBILITY.md)'s `activityShock24h` adds information to #222's
classifier. The machine-readable specification is
[`spot-24h-activity-shock-increment-dev-v1.json`](spot-24h-activity-shock-increment-dev-v1.json)
(revision 1, not frozen). Nothing was retrieved, exported, fitted or scored. The terms covering
the proposed REST endpoint are **unresolved** after review, so no retrieval may follow from this
revision. [#222](SPOT_24H_EXPECTED_NET_T3S3_DEV_V1.md)'s `STOP` and every earlier study stand.

## In brief

- **One comparison.** On v1's 20 pairs, decision grid, chronological splits, 24-hour boundary
  purge and T3S3 labels: arm A is #220's eleven price features; arm B is the same eleven plus
  `activityShock24h`. Same rows, labels, `HistGradientBoostingClassifier`, #222's fixed settings,
  seed and environment. Primary metric: the paired per-observation difference in three-class
  Brier score, B − A.
- **Two development evaluations.** Fit on train and score validation; fit on train + validation
  and score test. Both periods are examined history (an eighth look), so a pass can only justify
  reviewing a separate prospective proposal. It cannot establish predictive support,
  profitability or permission for live use.
- **Terms: unresolved, retrieval blocked.** The Binance Terms of Use plausibly govern the
  endpoint, but they do not say whether keeping public klines offline for private research is
  within their licence. The separate API terms they name were not found. See
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

Reviewed on 2026-11-26. This is a reading of the text, not legal advice or an assurance.

**Applicable to the proposed endpoint** (`GET https://api.binance.com/api/v3/klines`,
unauthenticated):

- **Binance Terms of Use, Effective Date 27 October 2026** (ADGM Binance Entities). Shown at
  `binance.com/en/terms` as an embedded 74-page PDF. The file read is on Binance's CDN, SHA-256
  `f7c3c8a8…` (equal to its file name). It was matched by date and page count, and its metadata
  title says "Draft".
  - _Scope:_ the preamble says accessing the Binance Platform or using Binance Services is
    acceptance. The Binance Platform is defined to include access via a Binance API.
  - _Licence (cl. 26–27):_ Binance IP stays with Binance. Users get a non-exclusive licence to use
    it only as needed to receive the Binance Services, for "non-commercial personal or internal
    business use". Intellectual Property Rights include database rights (definitions).
  - _APIs (cl. 14.1.2(b)):_ account access through Binance APIs is subject to separate API terms
    and approval.
  - _Platform access (cl. 33.1):_ a revocable, non-exclusive right to access the platform to
    receive the services.
  - _Technology (cl. 33.7–33.8):_ APIs are part of the Technology. Some databases in it are
    proprietary, with confidentiality duties.
  - _Third-party market data (cl. 33.11):_ provided for information only.
  - _Also relevant:_ cl. 1.3–1.4 incorporate the Prohibited Use Policy and Product Terms;
    cl. 7.5.1 requires identity verification before accessing any Binance Service.
- **SPOT Exchange Terms of Use** (Spot API documentation): a single sentence placing Binance
  products under the Product Terms of Use, linking to the same `binance.com/en/terms`.
- **Spot API documentation** (`rest-api.md`, `market_data_only.md`, repository README): limits
  and error handling only. No licence, storage or research clause, and no LICENSE file. Public
  market-data clients are pointed to `data-api.binance.vision`.

**Not addressed in the text read:** whether kline responses are Binance IP or proprietary
databases; storing or retaining them; offline analysis; research use; publishing aggregates
derived from them (this repository is public). No scraping, crawling, data-mining or
redistribution clause appears.

**Not located or not read:** the separate API terms of cl. 14.1.2(b) (the `api-key-terms` path
returns 404; none found by search or linked from the API documentation); the Prohibited Use Policy
and the Product Terms list. Binance's legal pages render client-side. Opening one in the owner's
Chrome caused an automatic Google social-login redirect on binance.com, so reading stopped there.
Which regional version binds the owner's account was not determined.

**Archive terms, kept separate.** The Binance Vision Dataset Terms (version 1.0, last updated
2026-08-26, unchanged since #224) cover data from `data.binance.vision` "and associated
endpoints". They grant CC BY-NC-SA 4.0 and list personal non-production backtesting as permitted
(4.1). They do not name `api.binance.com`. They are not relied on here, and this specification does
not switch to the archive or to a `binance.vision` host.

**Assessment: unresolved.** The use is neither clearly addressed nor clearly restricted. It is
private and non-commercial, which matches the licence's wording. But that licence covers only
what is needed to receive Binance's services, and no clause says whether keeping two years of
klines offline for a research model falls within it. Free, unauthenticated access is not treated
as permission. **Blocker `TERMS_UNRESOLVED`:** no retrieval. The same open question applies to v1's
saved candles and #224's probe files, which came from the same endpoint.

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

## Open decisions (recommended defaults)

1. **Terms blocker.** _Default:_ keep retrieval blocked. First read the separate API terms, the
   Prohibited Use Policy and the Product Terms, without using the owner's sign-ins. If they are
   silent, seek a written statement from Binance. Otherwise stop. _Reason:_ the text reviewed
   neither permits nor forbids this use, and the documents that might were not read. The owner is
   not asked to certify the ambiguity.
2. **Host.** _Default:_ `api.binance.com`. _Reason:_ it is v1's and the probe's source, and the
   one whose terms were reviewed. A `binance.vision` host may bring the archive terms into scope,
   which is a source change needing its own review.
3. **Calibration as a gate.** _Default:_ report only, which departs from #224 section 6. _Reason:_
   the screen measures one feature's increment. #222 recorded this same estimator on A's
   features missing the limits once per period, so an absolute gate on B would mostly retest
   #222's model. The Brier difference already includes calibration.
4. **Existing files.** _Default:_ the terms resolution also covers v1's candles and the probe's
   files. _Reason:_ same endpoint, same open question, and this screen reads v1's candles.

## Limits

- Both periods were examined by seven earlier looks. A pass is not untouched evidence.
- The arms share eleven features, so the paired interval is narrow by construction. Seven-day
  blocks do not capture regimes longer than a week.
- OHLC parity shows prices unchanged since v1's retrieval. Volume has no earlier copy, and
  whether Binance revises closed klines is undocumented.
- `activityShock24h`'s transfer from the daily, multi-exchange evidence to hourly Binance pairs is
  uncertain (#224 section 5).
