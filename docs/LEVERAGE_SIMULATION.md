# Leverage simulation: isolated USDT-margined perpetual long

`src/lib/perpetualScenario.ts` is an offline scenario model for one isolated, USDT-margined, linear
perpetual **long**. It does arithmetic on numbers the owner types. It is not a Binance execution
model, an eligibility check or a liquidation calculator.

**Stage: pure engine and tests only.** There is no UI, storage, network request, account access,
scanner change or link to the Manual Spot record. Nothing calls it yet.

## Boundaries

- **No market data and no defaults.** Every rate, threshold and amount is an input. The engine
  holds no leverage, fee, funding, maintenance-margin or bracket value of its own, and suggests
  none. 5× appears only in tests, as a requested scenario.
- **No account inference.** It assumes nothing about position mode, margin mode settings,
  Multi-Assets mode, auto-add margin, Portfolio Margin, VIP tier or eligibility.
- **No funding schedule.** Carrying cost is one signed amount for the whole holding period.
- **No predictive claim.** Leverage scales a scenario's price move by the position size. It does not
  change how often a scan's ranking turns out right.
- **Separate from Spot.** It does not read or write the Spot planner, the Spot balance view,
  reconciliation or the Manual Spot experiment tables.

## Inputs

Every field is a decimal typed by the owner. Required unless noted.

| Input                    | Meaning                                                                                  | Accepted                        |
| ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------- |
| `collateral`             | Starting isolated collateral, USDT                                                       | > 0, up to 8 decimals           |
| `sizing` + `size`        | Either a target notional (USDT) or a leverage multiple; notional = collateral × leverage | > 0, up to 8 decimals           |
| `entry`                  | Hypothetical entry fill price, USDT per unit                                             | > 0                             |
| `exit`                   | Hypothetical exit **fill** price                                                         | > 0                             |
| `stopTrigger` (optional) | Stop **trigger** price, for comparison only                                              | > 0 and below entry, or empty   |
| `entryFeePercent`        | Fee on the entry fill, as a percent of entry notional                                    | 0 ≤ rate < 100, 4 decimals      |
| `exitFeePercent`         | Fee on the exit fill, as a percent of exit notional                                      | 0 ≤ rate < 100, 4 decimals      |
| `carryingCost`           | Signed USDT for the holding period: **positive is paid, negative is received**           | Any sign, 8 decimals; 0 allowed |
| `maintenanceRatePercent` | Maintenance-margin rate of the bracket the owner believes applies                        | 0 ≤ rate < 100, 4 decimals      |
| `maintenanceAmount`      | That bracket's maintenance amount, USDT                                                  | ≥ 0                             |
| `bracketFloor`           | The notional lower bound of that bracket                                                 | ≥ 0                             |
| `bracketCap`             | The notional upper bound of that bracket                                                 | > floor                         |

A missing or invalid input returns validation messages and no figure.

## Outputs and derivations

Notation: C collateral, N target notional, E entry, X exit fill, f_in and f_out fee rates as
fractions, K signed carrying cost, m maintenance rate as a fraction, A maintenance amount.

| Output                                 | Formula                                    |
| -------------------------------------- | ------------------------------------------ |
| Quantity Q                             | floor to 0.00000001 of N ÷ E               |
| Entry notional                         | Q × E (at most N, because Q is floored)    |
| Exit notional                          | Q × X                                      |
| Entry fee, exit fee                    | Q × E × f_in, Q × X × f_out                |
| Price move                             | Q × (X − E), signed                        |
| Equity at exit                         | C + Q × (X − E) − entry fee − exit fee − K |
| Net result                             | Equity at exit − C, signed                 |
| Change relative to starting collateral | Net result ÷ C × 100                       |

**How costs reach equity.** Both fees and a positive carrying cost reduce equity one for one; a
negative carrying cost (a credit) adds to it. Equity at exit is not clamped: it can be zero or
negative, and the net result can exceed the starting collateral. `collateralExhausted` is true
when equity at exit is zero or below. The model does not say what Binance would do in that case.

**Stop trigger and fill are separate.** The result is computed at the exit **fill** price. A stop
trigger, when given, is reported with the fill's distance from it and is never used as the fill.
A market stop's fill can differ from its trigger.

### Simplified liquidation reference

At a price P, with C′ the collateral left before the price move:

```
equity(P)      = C′ + Q × (P − E)
requirement(P) = Q × P × m − A
equity = requirement  ⇒  P* = (Q × E − C′ − A) ÷ (Q × (1 − m))
notional at P* = Q × P* = (Q × E − C′ − A) ÷ (1 − m)
```

This follows Binance's stated condition that liquidation occurs when the margin balance falls below
the maintenance margin, with maintenance margin = notional × rate − maintenance amount. Binance
publishes its own formula as an image; this document does not claim it is that formula.

It is computed twice:

- **Zero-cost:** C′ = C. With C = 10, notional 50, entry 1, m = 1 % and A = 0, P* = 40 ÷ 49.5.
- **After costs:** C′ = C − entry fee − K. This assumes the entry fee and the whole carrying cost
  are charged against the isolated collateral before the price move. Exit fees and any liquidation
  fee are not included. A credit (negative K) lowers P*.

A reference is given only when the assumptions hold together. Otherwise the status says why and no
price is given:

| Status                 | When                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `reference`            | All checks below pass                                                                            |
| `collateral_exhausted` | C′ ≤ 0: costs use up the collateral before any price move                                        |
| `no_positive_solution` | Q × E − C′ − A ≤ 0: the equation has no price above 0. This does not mean "cannot be liquidated" |
| `not_below_entry`      | P* ≥ E: equity at entry is already at or below the requirement                                   |
| `bracket_mismatch`     | The notional at P* is outside [floor, cap]: the rate and amount entered don't apply there        |

Bounds are inclusive at both ends. Binance's convention at an exact bracket boundary is not
verified. The maintenance requirement is evaluated at the notional at P*, not at entry.

**Stop and exit comparisons share one price.** With a reference, the stop trigger and the exit fill
are compared with P* as if all three were on one price series. Binance triggers liquidation on the
**mark price**, while a stop may trigger on the last (contract) price or the mark price, and a fill
can be far from either. Every comparison carries this note.

## Rounding

- Inputs: USDT amounts, prices and leverage up to 8 decimals; percent rates up to 4 decimals.
- Quantity is floored to 0.00000001, so entry notional can sit just below the target. Both are
  reported. A quantity that floors to 0 is refused.
- USDT amounts are exact. Every product of 8-decimal and rate inputs ends within 22 decimals, and
  BigInt arithmetic keeps all of them. No floating point is used.
- Collateral change is rounded half away from zero to 4 decimals of a percent.
- P* is returned as an exact reduced fraction and as a decimal rounded **up** to 0.00000001. For a
  long, up means reached sooner. The notional at P* is also rounded up; the bracket check uses the
  exact value.

## Limitations

The engine is not a Binance-verified liquidation price or an achievable execution. In particular it
does not model:

- the mark price, its divergence from the last price, or price protection;
- funding timing, rate changes or the interval;
- partial liquidation, the liquidation clearance fee, the insurance fund or auto-deleveraging;
- which wallet fees and funding are drawn from;
- several brackets across the price path, other positions, cross margin or auto-add margin;
- lot size, minimum notional, tick size or slippage, other than the owner's chosen fill prices.

A liquidation reference is not a guaranteed maximum loss.

## Acceptance fixtures

All values are invented. None is a quote, balance, rate or recommendation.

| Case                                              | Expected                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| C 10, notional 50, entry 1, exit 0.96, zero costs | Loss 2, −20 % of starting collateral                                   |
| Same, m 1 %, A 0, bracket 0–50,000                | Reference 40 ÷ 49.5 = 80/99, shown as 0.80808081                       |
| Leverage 2×, 5×, 10× on C 10                      | Losses 0.8, 2, 4; references 50/99, 80/99, 10/11                       |
| Fees 0.05 % each, carrying cost +0.105            | Equity 7.846, −21.54 %; after-cost reference 4013/4950                 |
| Carrying credit −0.105                            | Equity 8.105, −18.95 %; after-cost reference 7979/9900                 |
| Spot planner, allocation 50, same move            | Same quantity and absolute loss (2); 4 % of cash vs 20 % of collateral |

## Sources

Read 2026-11-14:
[Leverage and Margin of USDⓈ-M Futures](https://www.binance.com/en/support/faq/leverage-and-margin-of-usd%E2%93%A2-m-futures-360033162192),
[Liquidation price of USDⓈ-M contracts](https://www.binance.com/en/support/faq/how-to-calculate-liquidation-price-of-usd%E2%93%A2-m-futures-contracts-b3c689c1f50a44cabb3a84e663b81d93),
[Futures liquidation protocols](https://www.binance.com/en/support/faq/binance-futures-liquidation-protocols-360033525271),
[Funding rates](https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031),
[New Algo Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order).
