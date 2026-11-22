# One market-breadth filter on protocol v1's history: no consistent separation

**Status: development feasibility, finished. Verdict `NO_CONSISTENT_SEPARATION`.** One causal
filter, fixed in advance, was applied to [protocol v1](SPOT_24H_PROBABILITY.md)'s observations as
reconciled by the [diagnosis](SPOT_24H_V1_DIAGNOSTIC.md). The whole two-year history had been
examined before, so nothing here is independent validation. Nothing in v1 or the diagnosis changed,
no scenario was selected and no other rule was tried. The `TARGET` shares below are descriptive
historical frequencies, not probabilities for any current candidate.

## In brief

- **The filter's relationship with outcomes reverses between periods.** Permitted minus excluded
  mean gross return was −0.05% to −0.13% on train, −0.12% to +0.01% on validation and +0.19% to
  +0.30% on test, depending on the scenario. Over the three periods together it is −0.03% to +0.03%,
  and its Bonferroni-adjusted day-block intervals span roughly −0.4% to +0.4%.
- **Months mostly disagree.** Permitted decisions did better in 9 of 27 months (11 in T8S3), in
  runs: May–July 2025, late November 2025, January–February 2026 and June–August 2026.
- **Test's advantage lies between months, not within them.** Inside test months, permitted minus
  excluded averaged −0.03% to +0.06%. The period-level +0.19% to +0.30% arises because excluded
  decisions were concentrated in the falling months, such as June (66% excluded) and November 2026
  (73%). This is a post-hoc reading of the monthly table, not a pre-registered test.
- **Permitted decisions lost money everywhere.** Their mean net return was −0.20% to −0.44% per
  trade in every period and scenario. Even test, where the filter looked best, is an improvement
  that still loses money (−0.20% to −0.34% net), and the pre-registered verdict does not reach that
  case because separation already fails.
- **Recommendation: stop.** This filter does not merit a separately designed validation. The
  specification says to report that and not search for another rule, so none was tried.

## What was fixed in advance

[`docs/spot-24h-breadth-filter.json`](spot-24h-breadth-filter.json) was committed (`9870c93`)
before any filtered figure existed. At decision time T, each of v1's 20 pairs has a trailing return
close(T − 1h) ÷ close(T − 25h) − 1, read from the two 1h candles closed by T under v1's own
validity rules. Breadth is the share of pairs with a strictly positive return. A long decision is
**permitted** when breadth > 0.50 (11 or more of 20) and **excluded** otherwise; exactly 10 of 20
is excluded. A missing or invalid input would make the state **unavailable** at T for every pair,
counted and kept out of both states, never computed over fewer than 20 pairs. The specification
also fixed the comparisons, the month rule, the bootstrap and the verdict rule below. Lookback,
threshold and direction were not changed after the results.

Everything else is v1's: universe, decision grid, entry, the six scenarios and their levels, the
outcome scan, the AMBIGUOUS rule, costs, the 24-hour horizon and the train, validation and test
boundaries with their purge (200 purged observations are not analysed).

## Provenance and reconciliation

| Item          | Value                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Specification | `popup-spot-24h-breadth-filter-dev-1`, SHA-256 (stable serialization, as v1) `2be9b9bfba8c6b0358f971737bc925ece1616282f9fd89e8c827a987b115e6b9`, committed in `9870c93`                                                                                                              |
| Code          | `b3897917123e8b1f1e55f6dc732effe71c49b4d1`; the result records each file's git blob                                                                                                                                                                                                  |
| Inputs        | v1 result `662c5d7d…6ec1e`, diagnostic output `6d6df8f1…a06c7`, `universe.json` `b43acfda…` and the 20 candle files, each checked against its recorded SHA-256. All byte-identical after the run. Nothing was downloaded                                                             |
| Observations  | 87,500, rebuilt by the run commit's own `scripts/spot24h.ts` (from `git archive 2d848fb`) with the diagnosis's `rebuildRows`. Split sizes, the current fit and every validation and test aggregate match the recorded result (tolerance 10⁻¹²), and the count equals the diagnosis's |
| Output        | `.zerochart-reports/spot-24h-breadth-filter-2be9b9bfba8c.json`, 158,072 bytes, SHA-256 `54183e9723aeb76cf5d83fcc3a472114e5eeece2f8479f95cbbfd44c51c650fe`. A second run reported `UNCHANGED`                                                                                         |

## 1. Permitted, excluded and all decisions by period

No state was unavailable: every pair had both candles at every decision time. Group sizes are the
same in every scenario:

| Period     | Permitted: n · days · coverage | Excluded: n · days · coverage | Unavailable | All: n · days |
| ---------- | ------------------------------ | ----------------------------- | ----------: | ------------- |
| train      | 20,680 · 294 · 47.3%           | 23,020 · 309 · 52.7%          |           0 | 43,700 · 365  |
| validation | 9,900 · 142 · 45.8%            | 11,720 · 156 · 54.2%          |           0 | 21,620 · 181  |
| test       | 9,720 · 142 · 44.2%            | 12,260 · 159 · 55.8%          |           0 | 21,980 · 184  |

Breadth is strongly bimodal: at 19% of decision times no pair or all 20 pairs had risen (over the
three periods, 0 of 20 at 447 times and 20 of 20 at 389, out of 4,365). Exactly 10 of 20, excluded
by the rule, occurred at 151 times (3.5%).

| Period     | Scenario | TARGET share: P · E · all | Mean gross: P · E · all  | Mean net: P · E · all    | P − E gross | P − all gross |
| ---------- | -------- | ------------------------- | ------------------------ | ------------------------ | ----------: | ------------: |
| train      | T3S3     | 33.5% · 29.7% · 31.5%     | −0.11% · +0.00% · −0.05% | −0.40% · −0.28% · −0.34% |      −0.12% |        −0.06% |
| train      | T5S3     | 15.7% · 12.3% · 13.9%     | −0.09% · +0.04% · −0.02% | −0.38% · −0.25% · −0.31% |      −0.13% |        −0.07% |
| train      | T8S3     | 5.7% · 3.6% · 4.6%        | −0.04% · +0.05% · +0.01% | −0.33% · −0.25% · −0.29% |      −0.09% |        −0.05% |
| train      | T3S5     | 34.6% · 30.8% · 32.6%     | −0.08% · −0.00% · −0.04% | −0.37% · −0.29% · −0.32% |      −0.08% |        −0.04% |
| train      | T5S5     | 16.1% · 12.7% · 14.3%     | −0.06% · +0.03% · −0.01% | −0.35% · −0.26% · −0.30% |      −0.10% |        −0.05% |
| train      | T8S5     | 5.8% · 3.7% · 4.7%        | −0.01% · +0.04% · +0.01% | −0.31% · −0.26% · −0.28% |      −0.05% |        −0.03% |
| validation | T3S3     | 31.5% · 31.8% · 31.7%     | −0.10% · −0.07% · −0.08% | −0.38% · −0.35% · −0.36% |      −0.03% |        −0.02% |
| validation | T5S3     | 14.0% · 15.2% · 14.6%     | −0.15% · −0.03% · −0.08% | −0.44% · −0.32% · −0.38% |      −0.12% |        −0.06% |
| validation | T8S3     | 5.4% · 5.1% · 5.3%        | −0.13% · −0.01% · −0.06% | −0.42% · −0.31% · −0.36% |      −0.12% |        −0.06% |
| validation | T3S5     | 32.7% · 33.4% · 33.1%     | −0.09% · −0.10% · −0.09% | −0.37% · −0.38% · −0.38% |      +0.01% |        +0.00% |
| validation | T5S5     | 14.4% · 15.9% · 15.2%     | −0.14% · −0.05% · −0.09% | −0.44% · −0.34% · −0.39% |      −0.09% |        −0.05% |
| validation | T8S5     | 5.5% · 5.3% · 5.4%        | −0.13% · −0.04% · −0.08% | −0.42% · −0.33% · −0.37% |      −0.09% |        −0.05% |
| test       | T3S3     | 31.7% · 27.3% · 29.2%     | −0.02% · −0.21% · −0.13% | −0.31% · −0.50% · −0.41% |      +0.19% |        +0.11% |
| test       | T5S3     | 15.6% · 11.3% · 13.2%     | +0.04% · −0.21% · −0.10% | −0.25% · −0.50% · −0.39% |      +0.25% |        +0.14% |
| test       | T8S3     | 6.4% · 3.8% · 4.9%        | +0.10% · −0.20% · −0.07% | −0.20% · −0.50% · −0.37% |      +0.30% |        +0.17% |
| test       | T3S5     | 33.1% · 28.7% · 30.6%     | −0.05% · −0.24% · −0.16% | −0.34% · −0.53% · −0.44% |      +0.19% |        +0.10% |
| test       | T5S5     | 16.4% · 11.8% · 13.8%     | +0.01% · −0.24% · −0.13% | −0.28% · −0.53% · −0.42% |      +0.25% |        +0.14% |
| test       | T8S5     | 6.6% · 3.9% · 5.1%        | +0.07% · −0.23% · −0.10% | −0.23% · −0.53% · −0.40% |      +0.30% |        +0.17% |

P is permitted, E excluded. Mean net is v1's net return after the assumed 0.28% to 0.30% costs.

- **Train and validation favour excluded decisions** on mean return in 11 of 12 scenario-periods;
  test favours permitted ones in all six.
- **A higher target share did not mean a better return.** On train, permitted decisions reached
  the target 2.0 to 3.8 points more often than excluded ones, yet their mean gross was lower. This
  was not investigated further.
- **The direction is the same across scenarios.** Within a period, all six scenarios move together,
  as they share entries.

<details>
<summary>Every outcome share by group</summary>

| Period     | Scenario | Group     | TARGET |  STOP | TIMEOUT | AMBIGUOUS |
| ---------- | -------- | --------- | -----: | ----: | ------: | --------: |
| train      | T3S3     | permitted |  33.5% | 31.4% |   35.1% |     0.01% |
| train      | T3S3     | excluded  |  29.7% | 33.0% |   37.3% |     0.00% |
| train      | T3S3     | all       |  31.5% | 32.3% |   36.2% |     0.01% |
| train      | T5S3     | permitted |  15.7% | 32.8% |   51.5% |     0.01% |
| train      | T5S3     | excluded  |  12.3% | 34.2% |   53.4% |     0.00% |
| train      | T5S3     | all       |  13.9% | 33.5% |   52.5% |     0.01% |
| train      | T8S3     | permitted |   5.7% | 33.0% |   61.4% |     0.00% |
| train      | T8S3     | excluded  |   3.6% | 34.5% |   61.9% |     0.00% |
| train      | T8S3     | all       |   4.6% | 33.8% |   61.6% |     0.00% |
| train      | T3S5     | permitted |  34.6% | 11.5% |   53.9% |     0.00% |
| train      | T3S5     | excluded  |  30.8% | 14.6% |   54.6% |     0.01% |
| train      | T3S5     | all       |  32.6% | 13.1% |   54.3% |     0.01% |
| train      | T5S5     | permitted |  16.1% | 12.0% |   72.0% |     0.00% |
| train      | T5S5     | excluded  |  12.7% | 15.0% |   72.3% |     0.01% |
| train      | T5S5     | all       |  14.3% | 13.6% |   72.1% |     0.01% |
| train      | T8S5     | permitted |   5.8% | 12.0% |   82.2% |     0.00% |
| train      | T8S5     | excluded  |   3.7% | 15.2% |   81.1% |     0.00% |
| train      | T8S5     | all       |   4.7% | 13.7% |   81.6% |     0.00% |
| validation | T3S3     | permitted |  31.5% | 30.4% |   38.1% |     0.00% |
| validation | T3S3     | excluded  |  31.8% | 33.0% |   35.1% |     0.03% |
| validation | T3S3     | all       |  31.7% | 31.8% |   36.5% |     0.02% |
| validation | T5S3     | permitted |  14.0% | 32.4% |   53.6% |     0.00% |
| validation | T5S3     | excluded  |  15.2% | 34.6% |   50.2% |     0.03% |
| validation | T5S3     | all       |  14.6% | 33.6% |   51.8% |     0.01% |
| validation | T8S3     | permitted |   5.4% | 32.7% |   61.9% |     0.00% |
| validation | T8S3     | excluded  |   5.1% | 35.0% |   59.9% |     0.02% |
| validation | T8S3     | all       |   5.3% | 33.9% |   60.8% |     0.01% |
| validation | T3S5     | permitted |  32.7% | 10.8% |   56.5% |     0.00% |
| validation | T3S5     | excluded  |  33.4% | 14.9% |   51.7% |     0.00% |
| validation | T3S5     | all       |  33.1% | 13.0% |   53.9% |     0.00% |
| validation | T5S5     | permitted |  14.4% | 11.4% |   74.1% |     0.00% |
| validation | T5S5     | excluded  |  15.9% | 15.6% |   68.5% |     0.00% |
| validation | T5S5     | all       |  15.2% | 13.7% |   71.1% |     0.00% |
| validation | T8S5     | permitted |   5.5% | 11.5% |   83.0% |     0.00% |
| validation | T8S5     | excluded  |   5.3% | 15.8% |   78.9% |     0.00% |
| validation | T8S5     | all       |   5.4% | 13.8% |   80.8% |     0.00% |
| test       | T3S3     | permitted |  31.7% | 32.5% |   35.8% |     0.03% |
| test       | T3S3     | excluded  |  27.3% | 35.4% |   37.3% |     0.02% |
| test       | T3S3     | all       |  29.2% | 34.1% |   36.6% |     0.03% |
| test       | T5S3     | permitted |  15.6% | 34.2% |   50.2% |     0.02% |
| test       | T5S3     | excluded  |  11.3% | 36.7% |   51.9% |     0.02% |
| test       | T5S3     | all       |  13.2% | 35.6% |   51.2% |     0.02% |
| test       | T8S3     | permitted |   6.4% | 34.7% |   58.9% |     0.01% |
| test       | T8S3     | excluded  |   3.8% | 36.9% |   59.3% |     0.02% |
| test       | T8S3     | all       |   4.9% | 35.9% |   59.1% |     0.02% |
| test       | T3S5     | permitted |  33.1% | 12.9% |   54.0% |     0.01% |
| test       | T3S5     | excluded  |  28.7% | 15.6% |   55.7% |     0.01% |
| test       | T3S5     | all       |  30.6% | 14.4% |   54.9% |     0.01% |
| test       | T5S5     | permitted |  16.4% | 13.7% |   70.0% |     0.00% |
| test       | T5S5     | excluded  |  11.8% | 16.2% |   72.0% |     0.01% |
| test       | T5S5     | all       |  13.8% | 15.1% |   71.1% |     0.00% |
| test       | T8S5     | permitted |   6.6% | 13.9% |   79.5% |     0.00% |
| test       | T8S5     | excluded  |   3.9% | 16.3% |   79.7% |     0.01% |
| test       | T8S5     | all       |   5.1% | 15.3% |   79.6% |     0.00% |

</details>

## 2. Months

Permitted minus excluded mean gross return per UTC month (a month cut by a boundary appears in both
periods). Every month had at least 30 observations in each state, so all 27 are eligible:

| Month (period)       |   P n |   E n |        T3S3 |        T5S3 |         T8S3 |        T3S5 |        T5S5 |        T8S5 |
| -------------------- | ----: | ----: | ----------: | ----------: | -----------: | ----------: | ----------: | ----------: |
| 2024-11 (train)      |   720 |   360 |      −1.46% |      −1.74% |       −1.77% |      −1.68% |      −2.02% |      −2.07% |
| 2024-12 (train)      | 1,480 | 2,240 |      −0.70% |      −0.69% |       −0.67% |      −0.37% |      −0.36% |      −0.32% |
| 2025-01 (train)      | 1,860 | 1,860 |      −0.10% |      −0.03% |       +0.03% |      −0.35% |      −0.29% |      −0.20% |
| 2025-02 (train)      | 1,280 | 2,080 |      −0.71% |      −0.78% |       −0.79% |      −0.11% |      −0.18% |      −0.19% |
| 2025-03 (train)      | 1,720 | 2,000 |      −0.18% |      −0.08% |       +0.01% |      −0.36% |      −0.24% |      −0.15% |
| 2025-04 (train)      | 1,880 | 1,720 |      −0.76% |      −0.91% |       −0.89% |      −0.66% |      −0.78% |      −0.76% |
| 2025-05 (train)      | 1,720 | 2,000 |      +0.46% |      +0.54% |       +0.74% |      +0.50% |      +0.59% |      +0.80% |
| 2025-06 (train)      | 1,680 | 1,920 |      +0.68% |      +0.62% |       +0.54% |      +0.85% |      +0.81% |      +0.73% |
| 2025-07 (train)      | 2,000 | 1,720 |      +0.53% |      +0.44% |       +0.48% |      +0.27% |      +0.17% |      +0.21% |
| 2025-08 (train)      | 1,820 | 1,900 |      −0.27% |      −0.43% |       −0.44% |      −0.58% |      −0.78% |      −0.81% |
| 2025-09 (train)      | 1,820 | 1,780 |      −0.22% |      −0.26% |       −0.24% |      −0.18% |      −0.23% |      −0.21% |
| 2025-10 (train)      | 1,820 | 1,900 |      −0.22% |      −0.35% |       −0.23% |      −0.15% |      −0.31% |      −0.18% |
| 2025-11 (train)      |   880 | 1,540 |      −1.06% |      −1.01% |       −1.07% |      −0.96% |      −0.90% |      −0.94% |
| 2025-11 (validation) |   560 |   520 |      +0.50% |      +0.79% |       +0.91% |      +0.77% |      +1.09% |      +1.22% |
| 2025-12 (validation) | 1,640 | 2,080 |      −0.56% |      −0.55% |       −0.60% |      −0.56% |      −0.62% |      −0.68% |
| 2026-01 (validation) | 1,500 | 2,220 |      +1.07% |      +1.12% |       +1.16% |      +1.34% |      +1.40% |      +1.43% |
| 2026-02 (validation) | 1,260 | 2,100 |      +0.67% |      +0.77% |       +0.91% |      +0.92% |      +1.01% |      +1.15% |
| 2026-03 (validation) | 1,780 | 1,940 |      −0.05% |      −0.26% |       −0.15% |      −0.11% |      −0.34% |      −0.21% |
| 2026-04 (validation) | 1,980 | 1,620 |      −1.34% |      −1.78% |       −2.08% |      −1.54% |      −1.98% |      −2.28% |
| 2026-05 (validation) | 1,180 | 1,240 |      −0.76% |      −0.84% |       −0.75% |      −0.86% |      −0.95% |      −0.86% |
| 2026-05 (test)       |   520 |   680 |      −0.65% |      −0.63% |       −0.66% |      −0.86% |      −0.81% |      −0.82% |
| 2026-06 (test)       | 1,240 | 2,360 |      +0.65% |      +0.65% |       +0.63% |      +0.93% |      +0.94% |      +0.90% |
| 2026-07 (test)       | 1,920 | 1,800 |      +0.36% |      +0.38% |       +0.33% |      +0.42% |      +0.42% |      +0.37% |
| 2026-08 (test)       | 1,800 | 1,920 |      +0.15% |      +0.33% |       +0.49% |      +0.07% |      +0.22% |      +0.42% |
| 2026-09 (test)       | 1,920 | 1,680 |      −0.49% |      −0.52% |       −0.35% |      −0.62% |      −0.64% |      −0.46% |
| 2026-10 (test)       | 1,660 | 2,060 |      −0.19% |      −0.26% |       −0.26% |      −0.38% |      −0.46% |      −0.47% |
| 2026-11 (test)       |   660 | 1,760 |      −0.53% |      −0.36% |       −0.45% |      −0.47% |      −0.23% |      −0.35% |
| **Permitted higher** |       |       | **9 of 27** | **9 of 27** | **11 of 27** | **9 of 27** | **9 of 27** | **9 of 27** |

In 25 of 27 months all six scenarios have the same sign. The sign changes from month to month in
every period, and in runs rather than as a steady tilt.

**Within months against between months (post hoc, from this table).** Weighting each month's
difference by its observations, permitted minus excluded averaged −0.19% to −0.26% on train, −0.06%
to −0.18% on validation and −0.03% to +0.06% on test. Test's period-level +0.19% to +0.30% therefore
comes mostly from which months each state fell in: excluded decisions were 66% of June and 73% of
November 2026, both falling months, against 56% of the whole test period. This reading was not part
of the pre-registered rule and does not change the verdict.

## 3. Uncertainty

Moving block bootstrap over UTC decision days (7-day blocks, never wrapped, 2,000 replicates on
common draws for all six scenarios). A resampled day carries every pair and decision hour, so
co-moving pairs and labels overlapping within a block stay together; rows are never resampled
individually. Intervals are two-sided with a Bonferroni adjustment for six scenarios: percentiles
0.4167 and 99.5833. Over train, validation and test together:

| Set    | Scenario | Permitted mean net [interval] | P − E mean gross [interval] |
| ------ | -------- | ----------------------------- | --------------------------- |
| pooled | T3S3     | −0.37% [−0.63%, −0.12%]       | −0.02% [−0.36%, +0.31%]     |
| pooled | T5S3     | −0.36% [−0.67%, −0.05%]       | −0.03% [−0.44%, +0.36%]     |
| pooled | T8S3     | −0.32% [−0.66%, +0.04%]       | +0.00% [−0.44%, +0.42%]     |
| pooled | T3S5     | −0.36% [−0.65%, −0.09%]       | +0.01% [−0.39%, +0.37%]     |
| pooled | T5S5     | −0.36% [−0.70%, −0.02%]       | −0.01% [−0.46%, +0.42%]     |
| pooled | T8S5     | −0.32% [−0.69%, +0.06%]       | +0.03% [−0.45%, +0.48%]     |

<details>
<summary>Each period separately</summary>

| Set        | Scenario | Permitted mean net [interval] | P − E mean gross [interval] |
| ---------- | -------- | ----------------------------- | --------------------------- |
| train      | T3S3     | −0.40% [−0.78%, −0.02%]       | −0.12% [−0.62%, +0.33%]     |
| train      | T5S3     | −0.38% [−0.85%, +0.07%]       | −0.13% [−0.70%, +0.39%]     |
| train      | T8S3     | −0.33% [−0.83%, +0.16%]       | −0.09% [−0.70%, +0.48%]     |
| train      | T3S5     | −0.37% [−0.82%, +0.05%]       | −0.08% [−0.61%, +0.41%]     |
| train      | T5S5     | −0.35% [−0.89%, +0.13%]       | −0.10% [−0.72%, +0.47%]     |
| train      | T8S5     | −0.31% [−0.87%, +0.23%]       | −0.05% [−0.71%, +0.57%]     |
| validation | T3S3     | −0.38% [−0.84%, −0.03%]       | −0.03% [−0.63%, +0.52%]     |
| validation | T5S3     | −0.44% [−0.98%, +0.01%]       | −0.12% [−0.79%, +0.51%]     |
| validation | T8S3     | −0.42% [−1.00%, +0.04%]       | −0.12% [−0.85%, +0.55%]     |
| validation | T3S5     | −0.37% [−0.89%, +0.01%]       | +0.01% [−0.71%, +0.75%]     |
| validation | T5S5     | −0.44% [−1.05%, +0.03%]       | −0.09% [−0.89%, +0.73%]     |
| validation | T8S5     | −0.42% [−1.07%, +0.09%]       | −0.09% [−0.93%, +0.76%]     |
| test       | T3S3     | −0.31% [−0.81%, +0.22%]       | +0.19% [−0.38%, +0.86%]     |
| test       | T5S3     | −0.25% [−0.91%, +0.49%]       | +0.25% [−0.41%, +1.08%]     |
| test       | T8S3     | −0.20% [−0.93%, +0.71%]       | +0.30% [−0.45%, +1.24%]     |
| test       | T3S5     | −0.34% [−0.92%, +0.27%]       | +0.19% [−0.46%, +1.01%]     |
| test       | T5S5     | −0.28% [−0.98%, +0.52%]       | +0.25% [−0.52%, +1.23%]     |
| test       | T8S5     | −0.23% [−1.02%, +0.74%]       | +0.30% [−0.53%, +1.38%]     |

</details>

**Assumptions.** Dependence longer than 7 days is not reproduced; the monthly runs above suggest it
exists, so these intervals are, if anything, too narrow. The adjustment covers the six scenarios
only, not the periods, the two statistics or the monthly breakdown. The intervals describe this
examined history and validate nothing.

## 4. Decision

The verdict rule required every criterion in all six scenarios, without selecting one:

| Scenario | P > E gross in all three periods  | Pooled lower bound > 0 | P > E in ≥ 2/3 of months | P net > 0 in all three periods    |
| -------- | --------------------------------- | ---------------------- | ------------------------ | --------------------------------- |
| T3S3     | **no** (−0.12% · −0.03% · +0.19%) | **no** (−0.36%)        | **no** (9 of 27)         | **no** (−0.40% · −0.38% · −0.31%) |
| T5S3     | **no** (−0.13% · −0.12% · +0.25%) | **no** (−0.44%)        | **no** (9 of 27)         | **no** (−0.38% · −0.44% · −0.25%) |
| T8S3     | **no** (−0.09% · −0.12% · +0.30%) | **no** (−0.44%)        | **no** (11 of 27)        | **no** (−0.33% · −0.42% · −0.20%) |
| T3S5     | **no** (−0.08% · +0.01% · +0.19%) | **no** (−0.39%)        | **no** (9 of 27)         | **no** (−0.37% · −0.37% · −0.34%) |
| T5S5     | **no** (−0.10% · −0.09% · +0.25%) | **no** (−0.46%)        | **no** (9 of 27)         | **no** (−0.35% · −0.44% · −0.28%) |
| T8S5     | **no** (−0.05% · −0.09% · +0.30%) | **no** (−0.45%)        | **no** (9 of 27)         | **no** (−0.31% · −0.42% · −0.23%) |

Evidence passed (each state has at least 9,720 observations on at least 142 days per period).
Separation failed on all three criteria in all six scenarios, so the verdict is
**`NO_CONSISTENT_SEPARATION`**. The net-return criterion also fails everywhere; positive mean net was
not reached in any period, scenario or state.

## What this shows and what it does not

- **Shows:** on this history, the fixed breadth state at T did not separate later 24-hour outcomes
  in a consistent direction. Its apparent advantage on test is matched by an opposite tilt on train
  and validation, and month by month it goes both ways. No group it defines made money after the
  assumed costs.
- **Does not show:** that market-wide state carries no information, that another lookback,
  threshold or direction would fail or succeed, or anything about periods after the cutoff. Other
  definitions were deliberately not computed: picking one after seeing this would be a search over
  examined data.
- **Inherited limits:** survivorship in v1's universe, one venue, 1h bars, assumed costs and no
  spread, lot-size or minimum-notional effects. Every figure is in-sample with respect to the
  research process.

## Recommendation

**Do not design a validation for this filter.** It failed the pre-registered separation criteria in
every scenario and its permitted decisions lost money in every period. Per the specification, this
line of work stops here: no other rule was searched for, v1's gates are unchanged and nothing here
is a basis for live use. Any further idea about market state needs its own specification, frozen
before a new, unseen period, and is the owner's decision.

## Reproducing it

```bash
npm run evaluate -- spot-24h-breadth
```

It refuses to start while a tracked file differs from `HEAD`, verifies the specification's basis,
the recorded v1 result, the diagnostic output and every input hash, rebuilds and reconciles the
observations from a temporary `git archive` of `2d848fb` that it deletes afterwards, and writes the
output once. The output records the code commit, so reproduce at `b389791`: it reports `UNCHANGED`;
at another commit it reports `CONFLICT` and overwrites nothing. It never writes the protocol, the v1
result, the diagnostic output or the market data.

Code: [`scripts/spot24hBreadth.ts`](../scripts/spot24hBreadth.ts) (pure: state, comparisons,
months, bootstrap, verdict) and [`scripts/spot24hBreadthRun.ts`](../scripts/spot24hBreadthRun.ts)
(verification, rebuild, output). Tests:
[`scripts/spot24hBreadth.test.ts`](../scripts/spot24hBreadth.test.ts), synthetic data only. They
check that only the candles opening at T − 1h and T − 25h are read (the neighbouring hours and the
candle opening at T would flip every sign); that exactly 10 of 20 is excluded, 11 permitted and a
zero return not positive; that a missing candle, a duplicate, an invalid price or a missing pair
makes the state unavailable instead of shrinking the denominator; that changing, removing,
duplicating or corrupting every candle from any T onward leaves every earlier state unchanged; that
unavailable decisions count in all and coverage but in neither state; that a bootstrap replicate
equals the statistic over the whole drawn days; each verdict; and the runner's identity checks.
Mutations that count a zero return as positive, permit exactly half, read the candle opening at T,
use T − 24h, ignore a missing pair, pool unavailable decisions with permitted ones, drop the month
share or skip the net-return criterion each fail at least one test.

Nothing here reads an account, places an order, sets an alert, writes an experiment record,
schedules anything, downloads data or touches production.
