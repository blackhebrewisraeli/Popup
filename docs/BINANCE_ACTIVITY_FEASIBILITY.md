# Binance Spot trading activity: feasibility and one proposed hypothesis (PROPOSED / NOT RUN)

**Status: feasibility and experiment design only.** No model was fitted. No outcome was scored, no
return or profitability was computed, and no setting was searched. One bounded public probe
retrieved 60 pair-days of hourly klines to check field availability. [#222](SPOT_24H_EXPECTED_NET_T3S3_DEV_V1.md)'s
`STOP` and [#223](SPOT_24H_EXPECTED_NET_ERROR_DECOMPOSITION_DEV_V1.md)'s conclusion stand. The
comparison proposed below is a separate proposal for the owner. It does not continue or retune
#222.

## In brief

- **What Popup discards.** Binance's 1h klines carry five aggregated activity fields: base volume,
  quote volume, number of trades, taker-buy base volume and taker-buy quote volume. Popup's parser
  keeps open time, OHLC and close time only. v1's saved files and every study since v1 have never
  held the activity fields, and #220 and #222 list volume as excluded.
- **Available at the sampled dates.** All 60 requests (v1's 20 pairs × 3 dates × 24 hours)
  returned HTTP 200, and all 1,440 hours passed every check: schema, timestamps, decimal types,
  integer trade counts, taker-buy ≤ total, and implied mean prices within each candle's range.
  There were no zero-volume hours, no missing hours and no invalid values. OHLC equalled v1's saved
  candles exactly for all 1,440 hours. This shows availability on these dates only.
- **One block, one hypothesis.** A single feature: the 24-hour base-volume shock against the pair's
  own previous 30 days (the de-trended volume of Bianchi, Babiak and Dickerson, 2022). The
  hypothesis: on identical opportunities and labels, adding it to #220's eleven price features
  lowers the out-of-sample three-class Brier score. Taker-buy and trade-count fields are not
  proposed.
- **Transfer is uncertain.** The general evidence (volume changes what a price move predicts, in a
  direction that differs between settings) comes from daily equities and daily crypto aggregated
  across exchanges. In the crypto evidence the effect is strongest in small, illiquid pairs, while
  Popup's pairs are the 20 most liquid. No source examined tests hourly Binance Spot data against a
  24-hour barrier outcome, so whether the published effects carry over to this setting is unknown.
- **Is an experiment justified?** One frozen, paired comparison scored prospectively is justified,
  and nothing beyond it. It needs no collector, schedule or UI, but it needs a period of new data:
  184 days is proposed (v1's test length, reused), not an established minimum or a power-based
  requirement. Stopping here is also defensible. See [go/no-go](#go--no-go-prerequisites).

## 1. Field map

Raw kline fields from `GET /api/v3/klines`, as the official documentation lists them, and what
Popup keeps today.

| #   | Field                        | Kind              | Units (documented or by name)    | Popup today                                       |
| --- | ---------------------------- | ----------------- | -------------------------------- | ------------------------------------------------- |
| 0   | Open time                    | Timestamp         | Epoch ms (µs on request)         | Kept (`timestamp`)                                |
| 1–4 | Open, high, low, close       | Candle price      | Quote asset per base unit        | Kept                                              |
| 5   | Volume                       | Activity, summed  | Base asset units                 | **Discarded** by `parseCandles` and `parseKlines` |
| 6   | Close time                   | Timestamp         | Epoch ms; open + 3,599,999 on 1h | Kept (`closeTime`)                                |
| 7   | Quote asset volume           | Activity, summed  | Quote asset (USDT)               | **Discarded**                                     |
| 8   | Number of trades             | Activity, count   | Integer count                    | **Discarded**                                     |
| 9   | Taker buy base asset volume  | Activity, summed  | Base asset units                 | **Discarded**                                     |
| 10  | Taker buy quote asset volume | Activity, summed  | Quote asset (USDT)               | **Discarded**                                     |
| 11  | Ignore                       | Documented unused | —                                | Discarded                                         |

Where they are dropped: [`src/lib/binance.ts`](../src/lib/binance.ts) `parseCandles` reads indices
0–4 and 6, and `parseKlines` reads 0 and 4. The `Candle` and v1 `HourCandle` types have no activity
member. v1's files in `.zerochart-market-data/spot-24h-v1/klines/` therefore hold
`{timestamp, closeTime, open, high, low, close}` as JS numbers, with the original decimal strings
gone. [#220](quantile-forecast-24h-dev-v1.json) and [#222](spot-24h-expected-net-t3s3-dev-v1.json)
exclude volume by name. [#223](spot-24h-expected-net-error-decomposition-dev-v1.json) reads only
#222's records. This task does not change the parser.

**Three kinds of data, kept apart.**

- _Candle price data_ (fields 0–4, 6): what Popup uses now.
- _Aggregated trading activity_ (fields 5, 7–10): per-hour totals Binance computes from its own
  Spot trades in that pair. They say how much traded and how much of it had a buying taker. They
  give no order sizes, no sequence, no prices within the hour, no orders that did not trade, and
  nothing from other venues.
- _Order-book or trade-by-trade data_: not in klines. Trade-by-trade records exist elsewhere
  (`/api/v3/trades`, `historicalTrades`, `aggTrades`, and archive `trades`/`aggTrades` files, each
  with `isBuyerMaker`). The REST order book (`/api/v3/depth`) is a current snapshot only, and the
  public archive README lists no Spot order-book history. Popup uses neither, and nothing below
  needs them.

**What taker-buy volume is not.** Binance names the field and gives no further definition in the
kline documentation. Read with the glossary's `isBuyerMaker` ("the Buyer was also the Maker"), it
is most plausibly the volume of trades in which the buyer was the taker, the side whose order
executed against resting orders. That is an inference, not verified here against trade data. It is
not all buying (every trade has a buyer), not net capital inflow, not trader intent, and not a
complete order-flow record: it omits resting orders, cancellations and other venues.

## 2. Source semantics and access (official documentation)

Read on 2026-11-26 from Binance's documentation repositories (hashes in [Sources](#sources)).

| Topic          | Documented fact                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity       | "Klines are uniquely identified by their open time." Data source: Database.                                                                                                                                                                                                                                                                                                                                                          |
| Values         | Prices and volumes are JSON strings, times and trade count JSON integers. Precision varies by symbol: PEPEUSDT's volumes carried 2 decimals, every other field and pair 8 (probe).                                                                                                                                                                                                                                                   |
| Timestamps     | Milliseconds by default; microseconds only with `X-MBX-TIME-UNIT`. `startTime`/`endTime` are always UTC. `timeZone` (default 0) shifts interval boundaries only when sent. The **archive** (data.binance.vision) switched Spot timestamps to microseconds from 2025-01-01, so mixing archive and REST needs unit handling.                                                                                                           |
| Interval       | 1h is supported. With `startTime`, the oldest klines from it are returned up to `limit` (max 1000).                                                                                                                                                                                                                                                                                                                                  |
| Gaps           | Market data is not generated during `BREAK`, and klines are not generated during `CANCEL_ONLY` (glossary). A missing hour is therefore possible and differs from a zero-volume hour.                                                                                                                                                                                                                                                 |
| Limits         | Klines weight 2. IP limits use `REQUEST_WEIGHT`, shown as 6,000 per minute in the documentation's `exchangeInfo` example (the live value was not requested). 429 means slow down with `Retry-After`. Ignoring 429s leads to 418 bans of 2 minutes to 3 days. 403 means a WAF rule. Binance points public market-data clients to `data-api.binance.vision`; the probe kept v1's `api.binance.com` so that the source stayed the same. |
| History        | REST klines go back to a symbol's listing. The archive offers daily and monthly kline zips with `.CHECKSUM` files. **Archived files may be updated later** (a 2022-08-08 kline update "Fixed inconsistent data"), so point-in-time values are not guaranteed.                                                                                                                                                                        |
| Archive terms  | **Reviewed:** the Binance Vision Dataset Terms (version 1.0, last updated 2026-08-26), the archive's terms file. They cover datasets "made available through data.binance.vision and associated endpoints", license them under CC BY-NC-SA 4.0, list permitted non-commercial uses (section 4.1), and supplement the Binance Terms of Use. Whether "associated endpoints" includes the REST API is not determined here.              |
| REST terms     | **Not reviewed:** the Binance Terms of Use and any terms specific to the REST API. The probe used the REST endpoint only and downloaded no archive file, so which terms govern its responses, and what they permit, remains open.                                                                                                                                                                                                    |
| Not documented | How taker-buy volume is computed, whether self-trades or wash trades are included, and whether REST klines are ever revised after close.                                                                                                                                                                                                                                                                                             |

## 3. Probe (2026-11-26)

**Plan first.** [`binance-activity-probe.plan.json`](binance-activity-probe.plan.json) was
committed alone in `4927532` (SHA-256 `bfb1fe51…`) before any request: v1's 20 pairs in v1's
order; 24 closed 1h candles from 00:00 UTC on 2024-11-22, 2025-11-22 and 2026-11-21; 60 requests
at most; stop rules for 429, 418, 403 and 451 and for used weight above 3,000; write-once storage.
The probe code, [`scripts/binanceActivityProbe.ts`](../scripts/binanceActivityProbe.ts), was
committed in `6d3660f` with synthetic tests and run once from a clean tree. A later commit
restructured it for SonarCloud only (async `git` call, helpers, top-level await). Its tests pass
unchanged, and validating the saved responses again reproduces `validation.json` byte for byte.
The run's code is `6d3660f`'s.

**These dates are examined data.** They are v1's first decision day, the first day of v1's
validation period and the last day before v1's cutoff. Nothing retrieved here is untouched
evidence, and none of it was related to prices, returns or outcomes.

**Provenance.**

| Item         | Value                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint     | `GET https://api.binance.com/api/v3/klines?symbol=…&interval=1h&startTime=…&endTime=…&limit=24`, no credentials, no extra headers               |
| Retrieved    | 2026-11-26T00:23:50.408Z to 00:24:23.164Z, at commit `6d3660f`                                                                                  |
| Requests     | 60 counted, all HTTP 200, 0 rate-limit retries, no stop. `X-MBX-USED-WEIGHT-1M` peaked at 86                                                    |
| Stored       | `.zerochart-market-data/binance-activity-probe-2026-11-26/` (git-ignored): 60 raw bodies, 243,002 bytes in all, each SHA-256 in `manifest.json` |
| Digests      | `manifest.json` `5e41f9a8…`, `validation.json` `4bf3bed2…`; SHA-256 of the 60 raw files' `shasum` list `4ad8c83c…`                              |
| v1 untouched | SHA-256 of v1's 20 kline files' `shasum` list `1fe1be62…` before and after the run                                                              |

**Checks and results** (all 1,440 pair-hours).

| Check                                                                                     | Result                                 |
| ----------------------------------------------------------------------------------------- | -------------------------------------- |
| 24 rows of exactly 12 fields per response; open times on the hour, ordered, no duplicates | 60 of 60 responses                     |
| Close time = open + 3,599,999 ms and before the request was sent                          | 1,440 of 1,440                         |
| Prices positive decimal strings; high ≥ open, close, low; low ≤ open, close               | 1,440                                  |
| Volumes nonnegative decimal strings; trade count a nonnegative integer                    | 1,440 (trades 537 to 720,831 per hour) |
| Taker-buy base ≤ base volume and taker-buy quote ≤ quote volume (exact decimals)          | 1,440                                  |
| Zero consistency (no trades exactly when base volume is 0)                                | 1,440; no zero-volume hour occurred    |
| Quote ÷ base and taker-buy quote ÷ taker-buy base within [low, high] (±1e-6 relative)     | 1,440                                  |
| Field 11                                                                                  | Always `"0"`                           |
| OHLC and close time equal to v1's saved candle (parsed the same way)                      | 1,440 of 1,440; no mismatch            |

Classification: 1,440 valid, 0 valid zeros, 0 missing, 0 invalid. The taker-buy share of quote
volume ran from 0.147 to 0.859, never exactly 0 or 1. The implied-price check is an inference
from the field names (every trade in an hour is priced within its range), not a documented
guarantee.

**Limits of the probe.** 60 pair-days cannot establish complete coverage of the 20 pairs' history,
that values never change after retrieval, how the fields are computed, or that zeros never occur.
The OHLC match only says these 1,440 hours were unchanged between v1's retrieval (2026-11-22) and
this one, four days later.

## 4. Evidence

Primary sources read for this task. Facts are restated from the text actually read.

**About these variables generally (equities, daily).**

- Campbell, Grossman and Wang (1993): daily index return autocorrelation falls with trading volume.
  Price changes on high volume are more likely to reverse than those on low volume.
- Llorente, Michaely, Saar and Wang (2002): daily NYSE/AMEX stocks. Returns from risk-sharing
  trades tend to reverse, and returns from speculative trades tend to continue. How volume relates
  to autocorrelation varies with the extent of informed trading.
- Chordia and Subrahmanyam (2004): daily order imbalance in individual stocks, signed by Lee–Ready
  classification. Lagged imbalance relates positively to returns, but the relation reverses sign
  once the current imbalance is controlled for. Its forecasting value thus runs through the
  persistence of imbalance itself.

**Closer to this setting (crypto).**

- Bianchi, Babiak and Dickerson (2022): daily, March 2017 to March 2022. Pairs against USD, with
  prices and volume aggregated across more than 80 exchanges (CryptoCompare). A volume shock is
  defined as log volume minus the log of its mean over the previous m days (m = 30, 60 as a check),
  standardised by a rolling log standard deviation. Daily returns reverse, the reversal is
  concentrated in pairs with negative volume shocks, and the interaction of lagged returns and
  volume shocks predicts returns. They also report stronger effects in smaller, more volatile and
  less liquid pairs, and replicate the strategy on single exchanges, Binance's USDT pairs among
  them from October 2018. No taker-side data.
- Easley, O'Hara, Yang and Zhang (2024, working paper): Binance USDT pairs for BTC, ETH, XRP, SOL
  and ADA, January 2021 to July 2023, one-minute bars. Roll, Kyle's lambda, Amihud and VPIN predict
  the sign of next-day changes in volatility, autocorrelation and distribution shape with random
  forests. Aggregate test accuracy is 0.53–0.54. The labels are about price dynamics, not
  direction or barrier outcomes.

**Untested in Popup.** None of these covers hourly Binance Spot klines, Popup's 20 pairs, a 4-hour
decision grid, ATR-scaled 24-hour barrier outcomes, or information beyond #220's eleven price
features. A cited secondary summary of a 2026 crypto order-flow paper could not be checked against
the paper itself, so it is not relied on.

## 5. Recommendation: one block, one hypothesis

**Block (one feature): `activityShock24h`, the 24-hour base-volume shock.** At a decision time T on
v1's grid, let h_j be the 1h candle opening at T − j hours, j = 1 … 744. Every such candle closed
by T.

```text
R_0 = Σ_{j=1..24} V(h_j)                       base volume of the last 24 closed hours
R_k = Σ_{j=24k+1..24k+24} V(h_j), k = 1 … 30   the 30 preceding, non-overlapping 24-hour blocks
μ   = (1/30) Σ_k R_k                           mean of the baseline blocks
s   = population SD of ln R_1 … ln R_30        (ddof = 0, as #220's logReturnStd24h)
activityShock24h = (ln R_0 − ln μ) / s
```

| Property            | Definition                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input               | Kline field 5 (base volume), decimal string to float64. Hours with zero volume are valid and enter the sums.                                                                                                                                                                                |
| Units               | Dimensionless: log deviation from the pair's own baseline, in baseline log-SD units.                                                                                                                                                                                                        |
| Lookback            | 744 closed hourly candles (31 days), longer than v1's 200-candle window. Blocks are aligned to T, so they match UTC days only at 00:00Z decisions. Each block contains one complete 24-hour cycle (every hour of day once). Whether hour-of-day patterns cancel in the ratio is unverified. |
| Normalization       | Per pair, own history only. No cross-sectional or fitted transformation, so nothing is estimated outside training. The tree model's internal binning is part of its fit.                                                                                                                    |
| Unavailable         | Any missing or invalid candle among the 744 (no repair, as in v1), any R_k = 0 for k = 0 … 30, or s = 0. An opportunity without the feature is ineligible for **both** arms, and the count is reported.                                                                                     |
| Available at T      | Uses only candles closed by T, as v1's features do. Whether a retrospectively retrieved value equals what was available live is unverified. See archive revisions in section 2.                                                                                                             |
| Settings and source | m = 30 and standardization follow Bianchi et al.'s main specification. The 24-hour block matches their daily frequency and the decision horizon. Their standardization text is brief, and SD of baseline log volumes is this proposal's reading. No setting was chosen from outcomes.       |
| Base, not quote     | Quote volume = base volume × price, so its ratio carries a price term the price block already has. Base volume isolates the non-price part. Bianchi et al. used USD volume, so this is a deliberate departure.                                                                              |

**Hypothesis H1.** On identical eligible opportunities and identical labels, a forecaster given
#220's eleven price features plus `activityShock24h` (B) has a lower mean three-class Brier score
than the same forecaster given the eleven price features alone (A), on an untouched period.

**Why it could add information beyond price and ATR.** Every current feature describes what
prices did. None says how much traded. Across the sources above, the same price move predicts
different things depending on the volume behind it. The direction is not settled: high-volume
index moves reverse more in Campbell et al.; in Llorente et al. it depends on how much trading is
informed; in Bianchi et al.'s crypto data, moves on unusually low activity reverse. H1 therefore
states no direction, only that the interaction carries information. ATR measures range, which
co-moves with volume but is not volume, and similar ranges occur with very different activity.
The model can only use that interaction if activity is an input, and a tree model can learn it
from `activityShock24h` next to the existing return features.

**Why not the other fields.** _Taker-buy share:_ largely the signed counterpart of the same hour's
return, which the price block already has. In Chordia and Subrahmanyam, imbalance's forecasting
value depends on the imbalance still to come. Binance documents it only by name, and no
crypto-specific primary source covering it was verified. _Trade count and mean trade size:_ no
evidence examined at this horizon. Adding them would turn one hypothesis into a catalogue.

**Why transfer is uncertain.** Bianchi et al.'s effects are strongest in small, illiquid pairs, and
Popup's are Binance's most liquid. Their volume pools 80+ exchanges, while Binance-only volume can
differ. Their test is a daily cross-sectional portfolio, not a pooled hourly-sampled classifier
with barriers. Easley et al.'s Binance results are modest and about other labels. None of these
limitations settles the outcome here in either direction. A supported or an unsupported H1 would
both be informative.

## 6. Proposed comparison (a specification to write, not an implementation)

| Element       | Proposal                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opportunities | v1's 20 pairs, v1's 4-hour grid and entry (open of the candle opening at T). Eligible only if both arms have every feature.                                                                                                                                                                                                                                                                                     |
| Labels        | v1's `resolveOutcome`, unchanged, at T3S3: TARGET, STOP (AMBIGUOUS inside), TIMEOUT. Reused so that no new label is chosen.                                                                                                                                                                                                                                                                                     |
| Arms          | A: #220's eleven features. B: the same eleven plus `activityShock24h`. Nothing else differs.                                                                                                                                                                                                                                                                                                                    |
| Fitting       | The same estimator and fixed settings for both arms: `HistGradientBoostingClassifier`, three classes, with #222's pinned settings, seed and scikit-learn 1.9.1. No tuning, feature selection, class weights or recalibration.                                                                                                                                                                                   |
| Chronology    | Fit once on v1's period (decisions whose 24-hour label ends by 2026-11-22T00:00Z). Fitting on examined data is not evidence. Score only an **untouched period**: decisions from the first 00:00Z after the specification is committed, for a proposed 184 days (v1's test length, reused; not an established minimum and not derived from a power calculation). Labels that cross the period's end are dropped. |
| Primary       | Per observation, Brier(B) − Brier(A), averaged. H1 is supported only if the mean is below 0 and the 95% upper bound is below 0. Intervals come from v1's moving block bootstrap over whole UTC days with 7-day blocks, paired (the same resampled days for both arms).                                                                                                                                          |
| Also required | B meets the contract's probability calibration limits (per class: in the large ≤ 0.03, decile error ≤ 0.05), and the mean difference stays below 0 with any one calendar month left out. Months carried much of v1's outcome variance.                                                                                                                                                                          |
| Reported only | Three-class log-loss difference. Eligible counts and exclusions by reason.                                                                                                                                                                                                                                                                                                                                      |
| Entries       | Not recommended in this comparison. If the owner wants them, each arm's decisions use the contract's restricted plug-in, v1's costs, abstention at 0 and per-opportunity means, with the contract's economic criteria and ENTER-subset calibration reported **separately**. They neither support nor refute H1, and H1 does not license entries.                                                                |
| Stop          | If H1 is not supported, the activity block stops. No other window, quote volume, taker share, model or label follows.                                                                                                                                                                                                                                                                                           |

**Historical screen versus prospective evaluation.** Two different things could follow this
report, and they are not interchangeable:

- An _optional historical development screen_ on v1's examined period. It would be the eighth look
  at the same outcomes, so a pass there could not be told apart from the selection already done on
  that history. At most it could inform whether a prospective evaluation is worth waiting for. It
  is not evidence for H1. Retrieving new columns does not make examined prices untouched.
- An _independent prospective evaluation_ on decisions made after a frozen specification. Only
  this could support or fail to support H1, and it is what #223 asked for (data not yet examined).

This correction authorizes and designs neither. Each would be a separately reviewed proposal.

**Not a continuation of #222.** H1 compares two forecasters on information. It does not test
whether a decision rule beats cash. It reuses v1's labels and #222's estimator settings so that no
new choice enters, and nothing in #222's or #223's results informed the choice of block. #222's
verdict, files and stop conditions are unchanged.

## Go / no-go prerequisites

All must hold before any scored figure exists:

1. **Owner approval** of this proposal, and the decision whether to proceed at all.
2. **A frozen specification** (JSON with its SHA-256) committed alone, before the untouched period
   starts and before any activity value is joined to an outcome.
3. **Data terms reviewed.** The terms that govern REST market data (the Binance Terms of Use and
   any API terms, not reviewed here) are read before any further retrieval, and the specification
   cites the text and version reviewed. The reviewed Vision Dataset Terms apply to archive files;
   this proposal uses REST. If the reviewed text leaves this use unclear, that is recorded as an
   open question and no retrieval proceeds on that source.
4. **Fit-set retrieval:** 1h klines with all 12 fields for the 20 pairs from 2024-10-22T00:00Z (744
   hours before v1's first decision) to 2026-11-22T00:00Z, into a new git-ignored directory with a
   hash manifest. v1's files are never written. About 380 requests, a retrieval to authorize
   separately.
5. **Parity:** retrieved OHLC and close times equal v1's saved candles for every overlapping hour,
   so that A's features and the labels are v1's and #220's. Any mismatch stops the work, and it is
   reported.
6. **Field validation** over the whole retrieval with the probe's checks. Zero-volume hours,
   missing hours and invalid values are counted. Invalid or missing inputs make the affected
   decisions ineligible for both arms, never repaired.
7. **Coverage:** at least 95% of opportunities eligible for both arms in the fit set and in the
   scored period. Otherwise the result is insufficient evidence.
8. **Score-period retrieval** only after the period and its last labels have ended, with the same
   checks. No collector, schedule or live process is needed. The values may differ from what was
   available live (section 2).

## What can be done, what is unknown, and the verdict

- **Can be done with available data:** the five activity fields for v1's pairs at hourly
  resolution, through the same public endpoint, are well-formed and consistent at the sampled
  dates. The proposed feature is computable from field 5 alone.
- **Unknown:** coverage over full history, any revision of closed klines, exactly how taker-buy
  volume is computed, and whether `activityShock24h` carries any incremental information for these
  pairs and this outcome. That last question is H1.
- **Unknown, terms:** what the unreviewed REST terms permit (section 2).
- **Verdict:** a separate experiment is justified only as the single paired comparison above,
  frozen in advance and scored prospectively (184 days proposed, not a power-based minimum). The
  evidence does not justify collection infrastructure, UI, alerts, decision rules or more activity
  features. Given uncertain transfer and the long wait, stopping here is a reasonable owner choice.

## Sources

Binance documentation (read 2026-11-26; SHA-256 of the files read):

- [Spot REST API: klines, general information, limits, data sources](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) (`d1d8d5e6…`)
- [Spot glossary (`isBuyerMaker`, `BREAK`, `CANCEL_ONLY`)](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/spot_glossary.md)
- [Market data only URLs](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/market_data_only.md)
- [Spot API changelog (kline weight change to 2, `timeZone`)](https://github.com/binance/binance-spot-api-docs/blob/master/CHANGELOG.md) (`e6f174d2…`)
- [Binance public data README (archive fields, microseconds from 2025, archive updates)](https://github.com/binance/binance-public-data/blob/master/README.md) (`2e133d99…`) and [its terms](https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md) (Binance Vision Dataset Terms v1.0, `99c4921d…`)
- Not reviewed: the [Binance Terms of Use](https://www.binance.com/en/about-legal/terms) and any REST API terms

Research:

- Campbell, J. Y., Grossman, S. J., Wang, J. (1993). Trading volume and serial correlation in stock
  returns. _Quarterly Journal of Economics_ 108(4), 905–939. [NBER w4193](https://www.nber.org/papers/w4193)
- Llorente, G., Michaely, R., Saar, G., Wang, J. (2002). Dynamic volume-return relation of
  individual stocks. _Review of Financial Studies_ 15(4), 1005–1047. [NBER w8312](https://www.nber.org/papers/w8312)
- Chordia, T., Subrahmanyam, A. (2004). Order imbalance and individual stock returns: theory and
  evidence. _Journal of Financial Economics_ 72(3), 485–518. [Working paper abstract](https://ideas.repec.org/p/cdl/anderf/qt34k8f3pv.html)
- Bianchi, D., Babiak, M., Dickerson, A. (2022). Trading volume and liquidity provision in
  cryptocurrency markets. _Journal of Banking & Finance_ 142, 106547.
  [Abstract](https://econpapers.repec.org/RePEc:eee:jbfina:v:142:y:2022:i:c:s0378426622001418);
  read in full as [CERGE-EI WP 730](https://www.cerge-ei.cz/pdf/wp/Wp730.pdf)
- Easley, D., O'Hara, M., Yang, S., Zhang, Z. (2024). Microstructure and market dynamics in crypto
  markets. Working paper, SSRN 4814346. [PDF](https://stoye.economics.cornell.edu/docs/Easley_ssrn-4814346.pdf)
