# Protocol v1 diagnosis: why insufficient evidence and an empty shortlist

**Status: exploratory diagnosis of the one recorded run.** It explains the
[protocol v1](SPOT_24H_PROBABILITY.md) result from the same observations, with the run commit's
own code. Nothing in v1 changed: the protocol JSON, the result file, its hashes, the selection
rule and both gates are as recorded, and v1 was not re-scored. The diagnosis proposes no trade,
pair, state or period. The whole two-year history is now development data for any later
revision; none of it can serve as untouched test data again.

## In brief

- **Costs are the binding constraint on expectancy.** The assumed costs take 0.28% to 0.30% of
  every trade. In the confirmatory fit, the best indicator cell's mean gross return was +0.07% to
  +0.22% per scenario, below that cost in all six. So no cell had a positive mean net return, the
  selection rule selected nothing, and expectancy could not be supported.
- **The gross return was not positive either.** Before costs, the mean was −0.06% to −0.16% per
  trade on validation and test in every scenario. A zero-cost run would still have lost on
  average. This is a diagnostic counterfactual, not an executable result.
- **Time dominates the outcomes.** Calendar months describe 0.75% to 1.60% (validation) and 3.4%
  to 4.0% (test) of the variance of gross returns. The six cells describe 0.01% to 0.05% and 0.34%
  to 0.55%. Monthly mean gross returns ranged from −1.65% to +1.07%; every month in which a scenario
  moved by more than 0.3% (about the cost) moved all six the same way.
- **The probability's small test skill is not stable.** On validation, ΔBrier changes sign from
  month to month; on test, most of it comes from a few months. Validation's target rates were
  above the train base rate in every scenario, and the cells' errors outweighed their gains. On
  test, part of the gain came from cells predicted below the base rate during a period whose rates
  fell.
- **Recommendation:** no change to v1's indicators, cells, scenarios or levels is justified by
  this evidence. One hypothesis is worth a new, prospectively evaluated protocol:
  [a market-wide state known at the decision time](#one-next-hypothesis).

## Provenance and reconciliation

| Item              | Value                                                                                                                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded result   | `.zerochart-reports/spot-24h-probability-b3aa90fb8912.json`, SHA-256 `662c5d7d…6ec1e`, unchanged                                                                                                                                                                                                           |
| Run commit        | `2d848fb1b5584d64f9892cd44627366246adf359`; every recorded source blob verified at that commit                                                                                                                                                                                                             |
| Protocol          | `popup-spot-24h-target-before-stop-v1`, SHA-256 `b3aa90fb…369a62a`                                                                                                                                                                                                                                         |
| Data              | The saved `universe.json` (SHA-256 `b43acfda…`) and 20 candle files, each matching the manifest's SHA-256. Nothing was downloaded                                                                                                                                                                          |
| Diagnostic output | `.zerochart-reports/spot-24h-v1-diagnostic-b3aa90fb8912.json`, 302,921 bytes, SHA-256 `6d6df8f1b6a712189f532e9e364df72c15159e1478f510facc8fe3dac14a06c7`, written at commit `0b4920f`. It records the diagnostic commit and blobs, the original result's identity, the universe and every candle file hash |

The result file holds aggregates only, so observations were rebuilt. The diagnosis extracts the
run commit with `git archive` and loads its `scripts/spot24h.ts` and `scripts/spot24hRun.ts`
unchanged (`src` is identical between `2d848fb` and this branch, and the run refuses otherwise).
Then:

1. **The original evaluation, re-executed.** v1's own `runEvaluation`, run from the archive on the
   saved files, produces bytes whose SHA-256 is the recorded `662c5d7d…`, in a temporary
   directory. The code and inputs are therefore exactly the recorded run's.
2. **Fills rebuilt with the same functions.** For each of the 87,500 observations, v1's
   `resolveOutcome` gives the exit price; its category, its `netReturn`, the cell and `v` are
   identical to what v1's `pairObservations` produced, or the run stops.
3. **Aggregates reconciled.** Split sizes and the current fit match exactly. For validation and
   test in all six scenarios, outcome counts, scored counts and cell sizes match exactly, and mean
   net return, both Brier scores, ΔBrier, skill score, calibration in the large, weighted cell
   error and every cell's predicted and observed rate differ from the recorded figure by 0
   (tolerance 10⁻¹²).
4. **Decomposition reconciled.** Gross plus the four cost components equals v1's net return
   within 6.7 × 10⁻¹⁶ per observation, and within 7 × 10⁻¹⁷ for every scenario's mean.

## 1. Gross to net

**Convention.** v1's net return is (1 − fee)² × exit × (1 − exit slippage) ÷ (entry × (1 + entry
slippage)) − 1, with a 0.10% fee per fill, 0.05% slippage on the entry, stop and timeout fills, and
none on a target. It is split in trade order: buy at the slipped price, pay the fee in the asset,
sell at the slipped price, pay the fee on the proceeds. Each component is the change it makes to
the return, so the five parts add up exactly; their cross terms (about 10⁻⁶) fall where that order
puts them. Gross is exit ÷ entry − 1 for the same fill.

| Scenario | Split      |   Gross | Entry slippage | Entry fee | Exit slippage | Exit fee | Net (recorded) |
| -------- | ---------- | ------: | -------------: | --------: | ------------: | -------: | -------------: |
| T3S3     | validation | −0.080% |        −0.050% |   −0.100% |       −0.034% |  −0.100% |        −0.363% |
| T5S3     | validation | −0.084% |        −0.050% |   −0.100% |       −0.042% |  −0.100% |        −0.376% |
| T8S3     | validation | −0.064% |        −0.050% |   −0.100% |       −0.047% |  −0.100% |        −0.361% |
| T3S5     | validation | −0.093% |        −0.050% |   −0.100% |       −0.033% |  −0.100% |        −0.375% |
| T5S5     | validation | −0.095% |        −0.050% |   −0.100% |       −0.042% |  −0.100% |        −0.386% |
| T8S5     | validation | −0.077% |        −0.050% |   −0.100% |       −0.047% |  −0.100% |        −0.374% |
| T3S3     | test       | −0.130% |        −0.050% |   −0.100% |       −0.035% |  −0.100% |        −0.414% |
| T5S3     | test       | −0.100% |        −0.050% |   −0.100% |       −0.043% |  −0.100% |        −0.392% |
| T8S3     | test       | −0.069% |        −0.050% |   −0.100% |       −0.047% |  −0.100% |        −0.366% |
| T3S5     | test       | −0.159% |        −0.050% |   −0.100% |       −0.034% |  −0.100% |        −0.442% |
| T5S5     | test       | −0.131% |        −0.050% |   −0.100% |       −0.043% |  −0.100% |        −0.423% |
| T8S5     | test       | −0.099% |        −0.050% |   −0.100% |       −0.047% |  −0.100% |        −0.396% |

- **Costs are nearly constant:** 0.282% to 0.297% per trade in every split. Fees are 0.20%,
  slippage 0.08% to 0.10%. Exit slippage is lower in scenarios that end more often at a target,
  which pays none. At a gross return of zero, a round trip costs 0.250% through a target and
  0.300% through a stop or timeout.
- **Gross is negative on validation and test in all six scenarios**, −0.06% to −0.16%. On train it
  was −0.05% to +0.01% (positive only in T8S3 and T8S5); over the whole history −0.03% to −0.09%.
- **Costs are 1.8 to 4.6 times the size of the mean gross loss** on validation and test. Net is
  gross minus about 0.29% throughout.
- **Zero-cost counterfactual.** With no fee or slippage, the same exits keep the same outcomes
  (levels do not depend on costs), and the mean return is the gross column: negative in every
  scenario on validation and test. Costs explain the size of the loss, not its sign.

## 2. Outcome attribution

Each outcome's contribution is its share times its mean return, so the contributions add up to
the scenario's mean. Test split, 21,980 observations per scenario:

| Scenario | Outcome   |  Count |  Share | Mean gross | Mean net | Contribution, gross | Contribution, net |
| -------- | --------- | -----: | -----: | ---------: | -------: | ------------------: | ----------------: |
| T3S3     | TARGET    |  6,429 | 29.25% |     +3.43% |   +3.18% |             +1.004% |           +0.929% |
| T3S3     | STOP      |  7,500 | 34.12% |     −3.21% |   −3.50% |             −1.097% |           −1.196% |
| T3S3     | TIMEOUT   |  8,045 | 36.60% |     −0.10% |   −0.40% |             −0.037% |           −0.147% |
| T3S3     | AMBIGUOUS |      6 |  0.03% |     −1.87% |   −2.16% |             −0.001% |           −0.001% |
| T3S3     | **All**   | 21,980 |   100% |    −0.130% |  −0.414% |             −0.130% |           −0.414% |
| T5S3     | TARGET    |  2,904 | 13.21% |     +5.67% |   +5.40% |             +0.749% |           +0.714% |
| T5S3     | STOP      |  7,825 | 35.60% |     −3.19% |   −3.48% |             −1.135% |           −1.239% |
| T5S3     | TIMEOUT   | 11,246 | 51.16% |     +0.56% |   +0.26% |             +0.287% |           +0.133% |
| T5S3     | AMBIGUOUS |      5 |  0.02% |     −0.96% |   −1.26% |             −0.000% |           −0.000% |
| T5S3     | **All**   | 21,980 |   100% |    −0.100% |  −0.392% |             −0.100% |           −0.392% |
| T8S3     | TARGET    |  1,087 |  4.95% |     +8.65% |   +8.38% |             +0.428% |           +0.414% |
| T8S3     | STOP      |  7,896 | 35.92% |     −3.19% |   −3.48% |             −1.146% |           −1.250% |
| T8S3     | TIMEOUT   | 12,993 | 59.11% |     +1.10% |   +0.79% |             +0.649% |           +0.470% |
| T8S3     | AMBIGUOUS |      4 |  0.02% |     −0.52% |   −0.82% |             −0.000% |           −0.000% |
| T8S3     | **All**   | 21,980 |   100% |    −0.069% |  −0.366% |             −0.069% |           −0.366% |
| T3S5     | TARGET    |  6,731 | 30.62% |     +3.40% |   +3.14% |             +1.040% |           +0.961% |
| T3S5     | STOP      |  3,170 | 14.42% |     −4.97% |   −5.25% |             −0.716% |           −0.757% |
| T3S5     | TIMEOUT   | 12,077 | 54.95% |     −0.88% |   −1.17% |             −0.482% |           −0.645% |
| T3S5     | AMBIGUOUS |      2 |  0.01% |     −1.17% |   −1.47% |             −0.000% |           −0.000% |
| T3S5     | **All**   | 21,980 |   100% |    −0.159% |  −0.442% |             −0.159% |           −0.442% |
| T5S5     | TARGET    |  3,034 | 13.80% |     +5.58% |   +5.31% |             +0.770% |           +0.733% |
| T5S5     | STOP      |  3,317 | 15.09% |     −4.92% |   −5.21% |             −0.743% |           −0.786% |
| T5S5     | TIMEOUT   | 15,628 | 71.10% |     −0.22% |   −0.52% |             −0.157% |           −0.370% |
| T5S5     | AMBIGUOUS |      1 |  0.00% |     −0.77% |   −1.07% |             −0.000% |           −0.000% |
| T5S5     | **All**   | 21,980 |   100% |    −0.131% |  −0.423% |             −0.131% |           −0.423% |
| T8S5     | TARGET    |  1,126 |  5.12% |     +8.53% |   +8.26% |             +0.437% |           +0.423% |
| T8S5     | STOP      |  3,353 | 15.25% |     −4.92% |   −5.20% |             −0.750% |           −0.793% |
| T8S5     | TIMEOUT   | 17,500 | 79.62% |     +0.27% |   −0.03% |             +0.213% |           −0.026% |
| T8S5     | AMBIGUOUS |      1 |  0.00% |     −0.77% |   −1.07% |             −0.000% |           −0.000% |
| T8S5     | **All**   | 21,980 |   100% |    −0.099% |  −0.396% |             −0.099% |           −0.396% |

<details>
<summary>Validation split, 21,620 observations per scenario</summary>

| Scenario | Outcome   |  Count |  Share | Mean gross | Mean net | Contribution, gross | Contribution, net |
| -------- | --------- | -----: | -----: | ---------: | -------: | ------------------: | ----------------: |
| T3S3     | TARGET    |  6,851 | 31.69% |     +3.19% |   +2.93% |             +1.010% |           +0.928% |
| T3S3     | STOP      |  6,876 | 31.80% |     −3.22% |   −3.51% |             −1.025% |           −1.117% |
| T3S3     | TIMEOUT   |  7,889 | 36.49% |     −0.18% |   −0.48% |             −0.065% |           −0.174% |
| T3S3     | AMBIGUOUS |      4 |  0.02% |     −2.74% |   −3.04% |             −0.001% |           −0.001% |
| T3S3     | **All**   | 21,620 |   100% |    −0.080% |  −0.363% |             −0.080% |           −0.363% |
| T5S3     | TARGET    |  3,166 | 14.64% |     +5.04% |   +4.77% |             +0.737% |           +0.699% |
| T5S3     | STOP      |  7,261 | 33.58% |     −3.19% |   −3.48% |             −1.072% |           −1.169% |
| T5S3     | TIMEOUT   | 11,190 | 51.76% |     +0.48% |   +0.18% |             +0.251% |           +0.095% |
| T5S3     | AMBIGUOUS |      3 |  0.01% |     −2.01% |   −2.30% |             −0.000% |           −0.000% |
| T5S3     | **All**   | 21,620 |   100% |    −0.084% |  −0.376% |             −0.084% |           −0.376% |
| T8S3     | TARGET    |  1,138 |  5.26% |     +7.64% |   +7.37% |             +0.402% |           +0.388% |
| T8S3     | STOP      |  7,334 | 33.92% |     −3.18% |   −3.47% |             −1.079% |           −1.178% |
| T8S3     | TIMEOUT   | 13,146 | 60.80% |     +1.01% |   +0.71% |             +0.613% |           +0.429% |
| T8S3     | AMBIGUOUS |      2 |  0.01% |     −1.94% |   −2.23% |             −0.000% |           −0.000% |
| T8S3     | **All**   | 21,620 |   100% |    −0.064% |  −0.361% |             −0.064% |           −0.361% |
| T3S5     | TARGET    |  7,151 | 33.08% |     +3.17% |   +2.92% |             +1.049% |           +0.964% |
| T3S5     | STOP      |  2,821 | 13.05% |     −4.89% |   −5.17% |             −0.638% |           −0.675% |
| T3S5     | TIMEOUT   | 11,648 | 53.88% |     −0.94% |   −1.23% |             −0.505% |           −0.664% |
| T3S5     | AMBIGUOUS |      0 |  0.00% |          – |        – |              0.000% |            0.000% |
| T3S5     | **All**   | 21,620 |   100% |    −0.093% |  −0.375% |             −0.093% |           −0.375% |
| T5S5     | TARGET    |  3,296 | 15.25% |     +4.98% |   +4.72% |             +0.760% |           +0.720% |
| T5S5     | STOP      |  2,960 | 13.69% |     −4.84% |   −5.13% |             −0.663% |           −0.702% |
| T5S5     | TIMEOUT   | 15,364 | 71.06% |     −0.27% |   −0.57% |             −0.192% |           −0.404% |
| T5S5     | AMBIGUOUS |      0 |  0.00% |          – |        – |              0.000% |            0.000% |
| T5S5     | **All**   | 21,620 |   100% |    −0.095% |  −0.386% |             −0.095% |           −0.386% |
| T8S5     | TARGET    |  1,169 |  5.41% |     +7.57% |   +7.30% |             +0.409% |           +0.395% |
| T8S5     | STOP      |  2,984 | 13.80% |     −4.82% |   −5.11% |             −0.666% |           −0.705% |
| T8S5     | TIMEOUT   | 17,467 | 80.79% |     +0.22% |   −0.08% |             +0.179% |           −0.063% |
| T8S5     | AMBIGUOUS |      0 |  0.00% |          – |        – |              0.000% |            0.000% |
| T8S5     | **All**   | 21,620 |   100% |    −0.077% |  −0.374% |             −0.077% |           −0.374% |

</details>

- **Before costs, the outcomes almost offset.** Individual contributions reach ±1.15 points, yet
  every scenario's gross mean is within 0.16 points of zero. In the symmetric scenarios TARGET and
  STOP nearly cancel on their own (T3S3 on test: +1.00 against −1.10 points). Costs then lower
  every outcome's net by about 0.29 points.
- **TIMEOUT sets the sign in the wide-stop scenarios.** With a 5 v stop, more than half the trades
  time out, at a mean gross of −0.88% (T3S5) to +0.27% (T8S5) on test. With a 3 v stop and a
  wider target, timeouts are positive (+0.56%, +1.10%): the downside is already cut by the stop.
- **AMBIGUOUS bars do not matter here.** At most 6 per scenario and split, they contribute at
  most 0.001 points to any mean.
- **Exits against holding to the 24th close (context only).** The same entries held for all 24
  bars had a mean gross of +0.04% on train, −0.07% on validation and −0.02% on test. On test, the
  barrier exits did 0.04 to 0.14 points worse than that. Both exits contributed: after a target
  fill the price rose a further +0.31% to +0.51% on average by the 24th close, and after a stop it
  recovered +0.02% to +0.34%. On validation the gap was within 0.03 points. Holding is not an
  evaluated rule and is not proposed.

### Level distances against the costs

The levels are v1's fixed multiples of v = ATR14 ÷ close; nothing was searched. Test split:

| Scenario | Target distance, median [p25–p75] | Stop distance, median [p25–p75] | Costs ÷ target move (median) | Extra loss at a stop ÷ stop distance (median) | Break-even TARGET share of decided trades: gross → net (median) |
| -------- | --------------------------------- | ------------------------------- | ---------------------------: | --------------------------------------------: | --------------------------------------------------------------- |
| T3S3     | 3.17% [2.12–4.52%]                | 3.17% [2.12–4.52%]              |                         8.1% |                                          9.1% | 50.0% → 54.3%                                                   |
| T5S3     | 5.29% [3.54–7.53%]                | 3.17% [2.12–4.52%]              |                         5.0% |                                          9.1% | 37.5% → 40.8%                                                   |
| T8S3     | 8.46% [5.67–12.05%]               | 3.17% [2.12–4.52%]              |                         3.2% |                                          9.1% | 27.3% → 29.7%                                                   |
| T3S5     | 3.17% [2.12–4.52%]                | 5.29% [3.54–7.53%]              |                         8.1% |                                          5.4% | 62.5% → 65.7%                                                   |
| T5S5     | 5.29% [3.54–7.53%]                | 5.29% [3.54–7.53%]              |                         5.0% |                                          5.4% | 50.0% → 52.6%                                                   |
| T8S5     | 8.46% [5.67–12.05%]               | 5.29% [3.54–7.53%]              |                         3.2% |                                          5.4% | 38.5% → 40.5%                                                   |

Validation medians differ by at most 0.03 points. Costs are small next to each level, but they
move the break-even by 2.0 to 4.3 points of TARGET share. In the two symmetric scenarios, the share
of decided trades (TARGET, STOP or AMBIGUOUS) that hit the target was 49.9% (validation) and 46.1%
(test) for T3S3, and 52.7% and 47.8% for T5S5: around or below the gross break-even of 50%, and
below the net one. In the asymmetric scenarios the 24-hour cut-off favours the nearer level, so
their decided shares are not comparable with a break-even and are not shown.

## 3. Indicator cells against the base rate

Each entry is the fit's predicted rate → the observed TARGET rate, with the cell's contribution
to ΔBrier in units of 10⁻⁵ (negative favours the method). The contributions add up to the
scenario's ΔBrier. Cell sizes are the same in every scenario.

**Test** (confirmatory fit on train and validation):

| Cell                     |      n | T3S3                | T5S3                | T8S3                | T3S5                | T5S5                | T8S5                |
| ------------------------ | -----: | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| Base rate (fit)          |      – | 0.316               | 0.142               | 0.048               | 0.328               | 0.146               | 0.049               |
| `low/positive`           |    702 | 0.303 → 0.308 (−0)  | 0.110 → 0.131 (+1)  | 0.028 → 0.030 (−1)  | 0.313 → 0.321 (+0)  | 0.113 → 0.135 (+1)  | 0.029 → 0.030 (−1)  |
| `low/nonPositive`        |  4,025 | 0.294 → 0.261 (−35) | 0.114 → 0.099 (−29) | 0.032 → 0.028 (−7)  | 0.308 → 0.277 (−29) | 0.119 → 0.104 (−28) | 0.033 → 0.028 (−8)  |
| `mid/positive`           |  7,185 | 0.297 → 0.270 (−44) | 0.136 → 0.119 (−8)  | 0.045 → 0.046 (−0)  | 0.309 → 0.282 (−45) | 0.140 → 0.125 (−7)  | 0.047 → 0.047 (−0)  |
| `mid/nonPositive`        |  6,248 | 0.320 → 0.285 (+7)  | 0.141 → 0.121 (−1)  | 0.046 → 0.043 (−1)  | 0.332 → 0.299 (+8)  | 0.145 → 0.128 (−1)  | 0.046 → 0.046 (−0)  |
| `high/positive`          |  3,223 | 0.363 → 0.369 (−41) | 0.184 → 0.204 (−51) | 0.074 → 0.089 (−21) | 0.374 → 0.383 (−43) | 0.189 → 0.209 (−53) | 0.076 → 0.090 (−21) |
| `high/nonPositive`       |    597 | 0.357 → 0.419 (−19) | 0.182 → 0.243 (−18) | 0.080 → 0.122 (−10) | 0.366 → 0.437 (−19) | 0.186 → 0.251 (−18) | 0.081 → 0.126 (−10) |
| Observed rate, all cells | 21,980 | 0.292               | 0.132               | 0.049               | 0.306               | 0.138               | 0.051               |
| ΔBrier ×10⁻⁵             |        | −130                | −105                | −40                 | −128                | −106                | −41                 |
| Skill score              |        | 0.63%               | 0.92%               | 0.86%               | 0.60%               | 0.89%               | 0.85%               |
| Calibration in the large |        | 0.022               | 0.009               | 0.002               | 0.020               | 0.007               | 0.002               |
| Weighted cell error      |        | 0.027               | 0.019               | 0.005               | 0.027               | 0.018               | 0.005               |

**Validation** (development fit on train):

| Cell                     |      n | T3S3                | T5S3                | T8S3                | T3S5               | T5S5                | T8S5                |
| ------------------------ | -----: | ------------------- | ------------------- | ------------------- | ------------------ | ------------------- | ------------------- |
| Base rate (fit)          |      – | 0.315               | 0.139               | 0.046               | 0.326              | 0.143               | 0.047               |
| `low/positive`           |    898 | 0.295 → 0.313 (+1)  | 0.085 → 0.143 (+14) | 0.013 → 0.048 (+5)  | 0.304 → 0.324 (+2) | 0.086 → 0.147 (+15) | 0.014 → 0.048 (+5)  |
| `low/nonPositive`        |  3,867 | 0.299 → 0.284 (−13) | 0.110 → 0.121 (−4)  | 0.028 → 0.040 (+2)  | 0.310 → 0.304 (−8) | 0.113 → 0.130 (+2)  | 0.028 → 0.043 (+3)  |
| `mid/positive`           |  6,638 | 0.293 → 0.305 (+1)  | 0.129 → 0.149 (+10) | 0.039 → 0.058 (+7)  | 0.303 → 0.320 (+7) | 0.133 → 0.155 (+10) | 0.041 → 0.059 (+5)  |
| `mid/nonPositive`        |  6,348 | 0.311 → 0.336 (+5)  | 0.138 → 0.146 (+1)  | 0.047 → 0.043 (+0)  | 0.325 → 0.347 (+2) | 0.142 → 0.152 (+1)  | 0.047 → 0.045 (+0)  |
| `high/positive`          |  3,349 | 0.372 → 0.343 (+1)  | 0.190 → 0.172 (−11) | 0.075 → 0.072 (−10) | 0.384 → 0.354 (+3) | 0.195 → 0.176 (−11) | 0.078 → 0.073 (−10) |
| `high/nonPositive`       |    520 | 0.375 → 0.319 (+7)  | 0.199 → 0.146 (+7)  | 0.084 → 0.071 (−1)  | 0.381 → 0.333 (+6) | 0.201 → 0.152 (+6)  | 0.084 → 0.073 (−1)  |
| Observed rate, all cells | 21,620 | 0.317               | 0.146               | 0.053               | 0.331              | 0.152               | 0.054               |
| ΔBrier ×10⁻⁵             |        | +2                  | +15                 | +3                  | +11                | +23                 | +3                  |
| Skill score              |        | −0.01%              | −0.12%              | −0.06%              | −0.05%             | −0.18%              | −0.05%              |
| Calibration in the large |        | 0.003               | 0.009               | 0.008               | 0.006              | 0.011               | 0.008               |
| Weighted cell error      |        | 0.020               | 0.017               | 0.012               | 0.019              | 0.019               | 0.011               |

- **Against the base rate, some cells keep their sign in both splits:** `high/positive` was above
  it by 2.5 to 3.3 points on validation and 4.1 to 6.3 points on test; `low/nonPositive` below it
  by 0.4 to 3.1 and 2.1 to 5.4 points; `high/nonPositive` above it by 0.4 to 2.6 and 7.4 to 10.9
  points. `mid/positive` and `low/positive` changed sign or sat near zero.
- **Validation's loss to the base rate.** Validation's observed rate was above the train base rate
  in all six scenarios. The largest positive contributions came from `low/positive` (train
  estimate 0.085 against 0.143 observed in T5S3) and `mid/positive`, both predicted below the base
  rate, and in four scenarios from the rare `high/nonPositive`, predicted well above it but
  observed near it. They outweighed the gains, mainly in `high/positive` (T5 and T8 scenarios) and
  `low/nonPositive` (T3 scenarios).
- **Test's gain.** The test rate was below the confirmatory base rate in four scenarios (T3S3,
  T5S3, T3S5, T5S5). There, the large cells predicted below the base rate, `mid/positive` and
  `low/nonPositive`, gained simply by being lower, alongside `high/positive` and
  `high/nonPositive`, whose observed rates exceeded even their predictions. Calibration in the
  large (up to 0.022) reflects the same shift.

### What the expectancy selection read

The rule selects cells whose mean net return in the confirmatory fit is positive. Mean gross per
cell over train and validation (in-sample) → on test:

| Cell               | T3S3            | T5S3            | T8S3            | T3S5            | T5S5            | T8S5            |
| ------------------ | --------------- | --------------- | --------------- | --------------- | --------------- | --------------- |
| `low/positive`     | +0.15% → +0.15% | +0.04% → +0.19% | +0.05% → +0.14% | +0.21% → +0.06% | +0.13% → +0.10% | +0.14% → +0.04% |
| `low/nonPositive`  | −0.08% → −0.25% | −0.05% → −0.28% | −0.06% → −0.30% | −0.09% → −0.17% | −0.06% → −0.22% | −0.07% → −0.24% |
| `mid/positive`     | −0.10% → −0.19% | −0.07% → −0.18% | −0.04% → −0.16% | −0.11% → −0.31% | −0.08% → −0.30% | −0.05% → −0.28% |
| `mid/nonPositive`  | −0.06% → −0.23% | −0.07% → −0.21% | −0.05% → −0.18% | −0.03% → −0.23% | −0.05% → −0.20% | −0.04% → −0.17% |
| `high/positive`    | −0.02% → +0.14% | +0.04% → +0.27% | +0.12% → +0.38% | −0.05% → +0.11% | +0.02% → +0.22% | +0.09% → +0.35% |
| `high/nonPositive` | −0.04% → +0.71% | +0.07% → +0.97% | +0.17% → +1.12% | +0.02% → +0.75% | +0.13% → +1.02% | +0.22% → +1.18% |

- **No in-sample cell cleared the cost.** The largest in-sample mean gross was +0.15%, +0.07%,
  +0.17%, +0.21%, +0.13% and +0.22% by scenario, against costs of 0.28% to 0.30%. The largest mean
  net was −0.07% to −0.22%. That is why nothing was selected.
- **The high-RSI cells' positive test gross was not there on validation.** On validation, the same
  cells had a mean gross of −0.17% to +0.02%. In the train-only fit, two cells had a positive mean
  net (T3S5 `low/positive` +0.03%, T8S5 `high/nonPositive` +0.02%); on validation both lost after
  costs (−0.21%, −0.28%).

## 4. Concentration by pair and month

These breakdowns look for concentration. They are not a way to pick pairs, states or periods.

**Share of variance described in-sample** (between-group sum of squares ÷ total). With no
structure it would average about 0.02% for the six cells, 0.09% for the 20 pairs and 0.03% for
the seven months of a split.

| Scenario | TARGET: cells · pairs · months, validation | TARGET, test          | Gross: cells · pairs · months, validation | Gross, test           |
| -------- | ------------------------------------------ | --------------------- | ----------------------------------------- | --------------------- |
| T3S3     | 0.21% · 0.49% · 0.77%                      | 0.80% · 0.69% · 3.43% | 0.05% · 0.14% · 1.60%                     | 0.37% · 0.25% · 3.45% |
| T5S3     | 0.18% · 0.42% · 0.68%                      | 1.19% · 0.41% · 3.22% | 0.02% · 0.14% · 1.12%                     | 0.49% · 0.28% · 3.79% |
| T8S3     | 0.26% · 0.27% · 0.33%                      | 1.04% · 0.18% · 2.56% | 0.01% · 0.14% · 0.83%                     | 0.55% · 0.22% · 3.93% |
| T3S5     | 0.15% · 0.51% · 0.71%                      | 0.79% · 0.71% · 3.10% | 0.03% · 0.17% · 1.42%                     | 0.34% · 0.19% · 3.48% |
| T5S5     | 0.13% · 0.42% · 0.73%                      | 1.17% · 0.40% · 2.94% | 0.01% · 0.15% · 1.00%                     | 0.43% · 0.22% · 3.82% |
| T8S5     | 0.23% · 0.27% · 0.34%                      | 1.03% · 0.20% · 2.53% | 0.01% · 0.14% · 0.75%                     | 0.51% · 0.18% · 4.02% |

**By month** (UTC; May 2026 is split at the boundary). TARGET rate and ΔBrier contribution
(×10⁻⁵) for T3S3, mean gross for T3S3 and T8S5:

| Month               | Split      |     n | TARGET rate, T3S3 | Gross, T3S3 | Gross, T8S5 | ΔBrier, T3S3 | ΔBrier, T8S5 |
| ------------------- | ---------- | ----: | ----------------: | ----------: | ----------: | -----------: | -----------: |
| 2025-11 (from 22nd) | validation | 1,080 |             33.4% |      +0.71% |      +0.32% |          +10 |           +2 |
| 2025-12             | validation | 3,720 |             31.4% |      −0.02% |      −0.11% |          +26 |          +11 |
| 2026-01             | validation | 3,720 |             28.0% |      −0.43% |      −0.50% |          −63 |          −12 |
| 2026-02             | validation | 3,360 |             25.5% |      −0.69% |      −0.50% |          −23 |           −9 |
| 2026-03             | validation | 3,720 |             32.3% |      −0.02% |      +0.06% |           +9 |           +1 |
| 2026-04             | validation | 3,600 |             35.6% |      +0.21% |      +0.20% |          +43 |          +18 |
| 2026-05 (to 21st)   | validation | 2,420 |             38.8% |      +0.33% |      +0.41% |           −1 |           −7 |
| 2026-05 (from 22nd) | test       | 1,200 |             23.8% |      −0.35% |      −0.41% |           −2 |           −2 |
| 2026-06             | test       | 3,600 |             21.8% |      −0.60% |      −0.67% |          −25 |           −2 |
| 2026-07             | test       | 3,720 |             34.4% |      +0.13% |      +0.18% |           +2 |           +4 |
| 2026-08             | test       | 3,720 |             35.6% |      +0.38% |      +0.68% |          −49 |          −29 |
| 2026-09             | test       | 3,600 |             40.4% |      +0.65% |      +1.07% |          −12 |          −12 |
| 2026-10             | test       | 3,720 |             26.1% |      −0.33% |      −0.64% |           −9 |           +2 |
| 2026-11 (to 21st)   | test       | 2,420 |             13.6% |      −1.36% |      −1.65% |          −35 |           −2 |

<details>
<summary>All six scenarios by month</summary>

| Month                | Gross T3S3 |   T5S3 |   T8S3 |   T3S5 |   T5S5 |   T8S5 | ΔBrier T3S3 | T5S3 | T8S3 | T3S5 | T5S5 | T8S5 |
| -------------------- | ---------: | -----: | -----: | -----: | -----: | -----: | ----------: | ---: | ---: | ---: | ---: | ---: |
| 2025-11              |     +0.71% | +0.45% | +0.40% | +0.65% | +0.37% | +0.32% |         +10 |   +2 |   +2 |   +9 |   +3 |   +2 |
| 2025-12              |     −0.02% | −0.20% | −0.20% | +0.08% | −0.11% | −0.11% |         +26 |  +23 |  +11 |  +25 |  +23 |  +11 |
| 2026-01              |     −0.43% | −0.39% | −0.33% | −0.60% | −0.56% | −0.50% |         −63 |  −42 |  −12 |  −64 |  −43 |  −12 |
| 2026-02              |     −0.69% | −0.62% | −0.54% | −0.64% | −0.57% | −0.50% |         −23 |  −14 |   −9 |  −16 |  −12 |   −9 |
| 2026-03              |     −0.02% | +0.07% | +0.05% | −0.01% | +0.09% | +0.06% |          +9 |  +23 |   +0 |  +18 |  +32 |   +1 |
| 2026-04              |     +0.21% | +0.18% | +0.21% | +0.20% | +0.16% | +0.20% |         +43 |  +33 |  +16 |  +43 |  +33 |  +18 |
| 2026-05 (validation) |     +0.33% | +0.45% | +0.44% | +0.28% | +0.42% | +0.41% |          −1 |  −10 |   −6 |   −4 |  −12 |   −7 |
| 2026-05 (test)       |     −0.35% | −0.45% | −0.41% | −0.31% | −0.44% | −0.41% |          −2 |   +2 |   −2 |   +1 |   +3 |   −2 |
| 2026-06              |     −0.60% | −0.63% | −0.63% | −0.64% | −0.66% | −0.67% |         −25 |  −15 |   −2 |  −31 |  −17 |   −2 |
| 2026-07              |     +0.13% | +0.16% | +0.15% | +0.17% | +0.20% | +0.18% |          +2 |   +5 |   +4 |   +3 |   +5 |   +4 |
| 2026-08              |     +0.38% | +0.51% | +0.63% | +0.41% | +0.54% | +0.68% |         −49 |  −64 |  −28 |  −47 |  −64 |  −29 |
| 2026-09              |     +0.65% | +0.90% | +1.05% | +0.67% | +0.92% | +1.07% |         −12 |  −24 |  −12 |   −9 |  −23 |  −12 |
| 2026-10              |     −0.33% | −0.43% | −0.48% | −0.45% | −0.58% | −0.64% |          −9 |   +6 |   +1 |   −9 |   +7 |   +2 |
| 2026-11              |     −1.36% | −1.44% | −1.49% | −1.53% | −1.60% | −1.65% |         −35 |  −16 |   −2 |  −36 |  −17 |   −2 |

</details>

**By pair.** On validation, no pair had a positive mean net return in any scenario; on test, at
most one per scenario did, by at most +0.03% (NEARUSDT in three scenarios, ZECUSDT in one). Mean gross by pair ranged from −0.44% to +0.33%. Test
ΔBrier is spread across pairs: 17 to 20 of the 20 contribute in its favour, and no pair accounts
for more than 13% of the total. On validation, where the total is near zero, pairs contribute with
both signs (7 to 9 of 20 negative).

<details>
<summary>T3S3 by pair</summary>

| Pair     | Validation gross | Validation net | Validation ΔBrier ×10⁻⁵ | Test gross | Test net | Test ΔBrier ×10⁻⁵ |
| -------- | ---------------: | -------------: | ----------------------: | ---------: | -------: | ----------------: |
| AAVEUSDT |           +0.00% |         −0.28% |                      +4 |     −0.05% |   −0.33% |                −7 |
| ADAUSDT  |           −0.22% |         −0.50% |                      +3 |     −0.25% |   −0.54% |               −12 |
| AVAXUSDT |           −0.07% |         −0.35% |                      +9 |     −0.30% |   −0.59% |                −2 |
| BNBUSDT  |           −0.05% |         −0.33% |                      +5 |     −0.15% |   −0.43% |                −0 |
| BTCUSDT  |           −0.03% |         −0.31% |                      +2 |     −0.14% |   −0.43% |                +2 |
| DOGEUSDT |           −0.06% |         −0.35% |                      −2 |     −0.28% |   −0.56% |               −10 |
| ENAUSDT  |           −0.26% |         −0.54% |                     −11 |     −0.15% |   −0.43% |                −7 |
| ETHUSDT  |           −0.04% |         −0.33% |                      +5 |     −0.11% |   −0.40% |                −8 |
| LINKUSDT |           −0.06% |         −0.34% |                      −2 |     −0.20% |   −0.49% |                −7 |
| LTCUSDT  |           −0.16% |         −0.44% |                      +7 |     −0.23% |   −0.52% |               −15 |
| NEARUSDT |           −0.06% |         −0.35% |                      −3 |     +0.30% |   +0.02% |                +4 |
| PEPEUSDT |           −0.08% |         −0.37% |                      +0 |     −0.09% |   −0.38% |               −16 |
| SOLUSDT  |           −0.02% |         −0.30% |                      +3 |     −0.16% |   −0.44% |                −5 |
| SUIUSDT  |           −0.15% |         −0.44% |                      −6 |     −0.38% |   −0.67% |               −12 |
| TAOUSDT  |           +0.12% |         −0.16% |                      −5 |     −0.33% |   −0.61% |                −7 |
| TRXUSDT  |           +0.12% |         −0.16% |                      +6 |     −0.01% |   −0.29% |                −1 |
| UNIUSDT  |           −0.20% |         −0.48% |                      +2 |     +0.15% |   −0.14% |                −3 |
| WLDUSDT  |           −0.31% |         −0.59% |                      −3 |     −0.06% |   −0.34% |               −12 |
| XRPUSDT  |           −0.15% |         −0.43% |                      −6 |     −0.24% |   −0.53% |               −12 |
| ZECUSDT  |           +0.07% |         −0.21% |                      −6 |     +0.10% |   −0.19% |                +1 |

</details>

## What the evidence supports

### Directly supported by the calculations

1. Net return equals gross return minus 0.28% to 0.30% per trade, in every scenario and split,
   reconciled to v1's own figures.
2. Mean gross return was negative on validation and test in all six scenarios; at zero cost the
   mean would still have been negative there.
3. In the confirmatory fit, no cell's in-sample mean gross reached the cost, so the expectancy
   selection was empty in every scenario. The empty shortlist follows from that and from the
   probability gate.
4. Before costs, the outcome contributions nearly offset; AMBIGUOUS bars are immaterial.
5. Calendar months describe far more of the variance of outcomes and gross returns than the six
   cells or the 20 pairs do, in both splits. Monthly mean gross returns ranged from −1.65% to
   +1.07%, and every month in which a scenario moved by more than 0.3% moved all six the same way.
6. On validation, ΔBrier changes sign from month to month; on test it is negative in most months
   and largest in a few (June, August and November 2026 for T3S3). Test skill is spread across
   pairs, not concentrated in one.
7. Validation's TARGET rates were above the train base rate in all six scenarios; test's were
   below the confirmatory base rate in four.

### Plausible explanations that need another experiment

- **Market direction set the sign of the gross return.** The 24-bar hold over the same decisions
  was −0.07% on validation and −0.02% on test, and months with large common moves dominate. A
  period with a different drift could give a different sign. Testing that needs new data.
- **The cells mostly track the common market state.** On 1h candles over 200 hours, co-moving
  pairs tend to share a cell (19 of 20 were in `mid/positive` at the current evaluation). Whether
  the cells add anything beyond a market-wide state was not measured.
- **The test-period gains of the high-RSI cells are period-specific.** They were absent on
  validation, and the test period holds the strongest up-months of the history (August and
  September 2026). Whether those gains are concentrated in those months was not measured. Telling
  a stable effect from a regime needs more periods.
- **Base rates drift between periods.** An estimator that adapts to recent rates could score
  better on Brier. That would not clear the cost on its own.
- **Costs are assumed, not measured.** A lower actual fee tier or maker entries would shrink the
  hurdle; spread at small size would raise it. Cell-level conclusions are sensitive to it.

### Limitations

- **Not able to judge the indicators.** This diagnosis cannot establish whether RSI and MACD carry
  no information, or whether the bands, the cells, the 1h bars or the 24-hour horizon are the
  wrong way to use them.
- **Seen data.** Every figure here comes from history that has now been examined in full. Any
  revision must be judged on a later period.
- **Many looks, no intervals.** The breakdowns are exploratory, carry no uncertainty intervals and
  include dozens of comparisons, so some patterns are chance. Overlapping labels and co-moving
  pairs leave far fewer independent observations than rows; each split has only seven months.
- **In-sample variance shares.** They describe grouping after the fact; a month is not known in
  advance.
- **Attribution convention.** The trade-order split assigns the small cross terms of fees and
  slippage by that order; another order would move them by about 10⁻⁶.
- **Inherited from v1.** Survivorship in the universe, one venue, 1h bars hiding order inside a
  bar, assumed slippage and no spread, lot-size or minimum-notional effects.

## One next hypothesis

**No change to v1's indicators, cells, scenarios or levels is justified by this evidence.** The
diagnosis cannot tell why the cells added so little, and its breakdowns are not a basis for
choosing new states.

**Hypothesis.** _A single market-wide state, computed only from the universe's candles closed by
the decision time, separates decisions whose 24-hour mean net return is positive from those whose
is not._

**Rationale.** The cost hurdle needs a conditional mean gross above about 0.3% per trade. In the
confirmatory fit no cell came close (best +0.22%). Monthly means, by contrast, ranged from −1.65%
to +1.07%, moved all six scenarios the same way whenever they exceeded 0.3%, and describe several
times more of the variance than cells or pairs. If any part of that common variation is knowable
at the decision time, it is the largest lever this data shows. If it is not, no pooled per-pair
cell at this horizon is likely to clear the cost either, and the honest next step is to stop.

**Criterion, on genuinely unseen data.** A v2 protocol, frozen before its evaluation period
starts, defines the state and its favourable value using only data available at freezing; the v1
history may inform that choice but counts as development data. Everything else stays as in v1:
universe rule, decision grid, six scenarios, levels, costs and the AMBIGUOUS rule. The evaluation
uses only decisions after the freeze, over at least six calendar months. The hypothesis is
supported for a scenario only if, in the favourable state:

- there are at least 300 observations on at least 30 distinct days in at least 3 calendar months;
- the mean net return is above zero, with the lower bound of a 7-day moving-block bootstrap above
  zero at the 0.42th percentile (a 95% two-sided bound, Bonferroni-adjusted for six scenarios);
- the favourable state's mean gross return exceeds the unfavourable state's, with the same bound.

Passing would support positive expectancy in that state over that period, not a validated
shortlist; v1's other prerequisites (measured costs, execution checks, the owner's decision) still
apply.

## Reproducing it

```bash
npm run evaluate -- spot-24h-diagnose
```

It refuses to start while a tracked file differs from `HEAD`, verifies the recorded result and
every input hash, and runs the run commit's code from a temporary `git archive` that it deletes
afterwards. It writes `.zerochart-reports/spot-24h-v1-diagnostic-b3aa90fb8912.json` once. The file
records the diagnostic commit, so reproduce at `0b4920f`: the command reports `UNCHANGED`; at
another commit it reports `CONFLICT` and overwrites nothing. It never writes the original result,
protocol or data.

Code: [`scripts/spot24hDiagnostic.ts`](../scripts/spot24hDiagnostic.ts) (pure calculations) and
[`scripts/spot24hDiagnosticRun.ts`](../scripts/spot24hDiagnosticRun.ts) (verification, rebuild,
reconciliation). Tests: [`scripts/spot24hDiagnostic.test.ts`](../scripts/spot24hDiagnostic.test.ts),
synthetic data only. They check the decomposition against v1's net return on 10,000 random fills,
by hand and at zero cost; that outcome contributions add up to the mean, and to the gap to holding;
that cell scores reproduce v1's `evaluateFit` and their ΔBrier contributions match the closed form
n(p − p₀)(p + p₀ − 2o); that pair and month contributions add up; variance shares at their limits;
that rebuilt rows match v1's outcomes; that reconciliation passes on a protocol run and fails when
a recorded figure, split size or fit differs; and each identity check. Mutations that put slippage
on a target exit, invert entry slippage, weight contributions by category, score cells without a
probability or measure the after-exit move per exit each fail at least one test.

Nothing here reads an account, places an order, sets an alert, writes an experiment record,
changes a migration or touches production.
