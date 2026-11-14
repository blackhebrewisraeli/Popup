# Leverage simulation: isolated USDT-margined perpetual long

`src/lib/perpetualScenario.ts` is an offline scenario model for one isolated, USDT-margined, linear
perpetual **long**. It does arithmetic on numbers the owner types. It is not a Binance execution
model, an eligibility check or a liquidation calculator.

**Stage: engine, an offline Account section, a public contract-facts panel and a filter
comparison.** [Account](#in-account) shows the engine's figures for numbers typed there. The
simulation makes no network request and has no storage, account access, scanner change or link to
the Manual Spot record. Beside it, a separate [public contract data](#public-contract-data) panel
reads public facts about the TRXUSDT perpetual, only when asked, and never fills the simulation. A
third card, the [filter comparison](#filter-comparison), checks the current result against that
snapshot's filters, only on an explicit press.

## Boundaries

- **No market data and no defaults.** Every rate, threshold and amount is an input. The engine
  holds no leverage, fee, funding, maintenance-margin or bracket value of its own, and suggests
  none. 5× appears only in tests, as a requested scenario.
  The public contract data panel shows market facts beside the simulation but does not pass any
  of them into it. The filter comparison reads both and changes neither.
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
| `negative_requirement` | Q × P* × m − A < 0: the maintenance amount exceeds rate × notional at P*                         |
| `bracket_mismatch`     | The notional at P* is outside [floor, cap]: the rate and amount entered don't apply there        |

**Requirement of zero or more.** At P*, equity equals the requirement. If the requirement there is
negative, equity is negative too, so it reached zero at a higher price than P*. P* is then no
liquidation point, and no reference is given. The check is
`(Q × E − C′ − A) × m ÷ (1 − m) ≥ A`, cross-multiplied in exact integers. Exactly zero is kept: P*
is then the price where equity reaches zero. Example: C 10, notional 50, entry 1, m 0, A 1 solves
to P* = 0.78, where requirement and equity are both −1, while equity is already 0 at 0.80. Nothing
is clamped. It applies to the zero-cost and the after-cost reference separately; a carrying credit
raises C′ and can turn one negative while the other is not.

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

## In Account

**Leverage simulation** (`src/components/LeverageSimulation.tsx`) is its own card in Account, below
and outside the Binance Spot card and its Manual Spot experiments. Every signed-in user sees it; it
reads nothing, so it needs no owner check.

- **Engine only.** Every figure is a string returned by `simulatePerpetualLong`, shown unrounded.
  The component adds words (paid or received, gain or loss, above or at-or-below), never arithmetic.
- **Memory only.** Every numeric field starts empty, and sizing starts at target notional. Nothing
  is prefilled from a balance, a fill, a scan, a setting or an earlier session. Switching sizing
  clears the size, because the same number means something else. **Clear simulation** empties every
  field. A reload clears it too, and the card is keyed by user.
- **Three groups:** position (collateral, sizing, size, entry fill, exit fill, optional stop
  trigger), costs (two fee rates, the signed carrying cost) and maintenance assumptions (rate,
  amount, bracket floor and cap). They stay open, so a validation message is never hidden. Each
  field names its unit. Rates say they are percentages, and leverage says it is a multiple of
  collateral. The carrying cost says positive is paid and negative is received.
- **Status.** An `<output>` line, with the implicit status role, lists what is missing, asks for
  corrections or counts the warnings. Each invalid field gets `aria-invalid` and its message through
  `aria-describedby`. Results are derived on every render, so an invalid edit removes them at once.
- **Results:** target and simulated entry notional, quantity, exit notional, fees, carrying cost,
  price move, equity at the exit fill, net result and the change against starting collateral. The
  exit fill and stop trigger are shown apart. The stop is labelled "compared only", with the fill
  minus the trigger.
- **References.** Both references show their assumptions and the collateral they start from. A
  reference shows its rounded and exact price, its notional and where the stop and exit sit. Every
  other status gets a plain-language reason and no price; a bracket mismatch also shows the notional
  where it solves.
- **Warnings** sit above the figures. They cover exhausted collateral, and an exit fill or stop
  trigger at or below either reference. Each comparison carries `SHARED_PRICE_NOTE`.
- **No advice.** No recommended leverage, risk rating, placeholder number or order control.

### Verification (2026-11-14)

- **Component tests:** 19 in `src/test/leverageSimulation.test.tsx`. Each compares the figures on
  screen with `simulatePerpetualLong` for the same inputs. They cover:
  - the 10/50/1/0.96 fixture, leverage 2×, 5× and 10×, a floored quantity, fees with a paid carry, and
    a carrying credit;
  - stop versus fill, and all three warnings;
  - all five unavailable statuses, plus the after-cost-only negative requirement;
  - invalid inputs, the too-small size, reset, no prefill, no `fetch`, and placement outside the
    Binance card.

  Five deliberate component mutations each failed a test.

- **Browser:** synthetic inputs only, on the local dev server with Supabase pointed at an unused
  local port. Before the first page load, Playwright aborted every request and WebSocket not served
  by that server. Blocked were Google Fonts, Vercel analytics, the Binance stream and every Supabase
  call. Checked:
  - Tab order through the groups, and arrow keys on the sizing radios;
  - the fixture's figures and references;
  - the status line, and an invalid stop's `aria-invalid` and description;
  - light and dark themes through the app's toggle;
  - 375 px with no horizontal overflow.

  Not checked: a screen reader, Safari, a physical phone.

## Public contract data

**TRXUSDT perpetual: public contract data** (`src/components/PerpetualContractFacts.tsx` over
`src/lib/perpetualContractFacts.ts`) is its own card in Account, right after the Leverage simulation
card. It is informational only. It describes one fixed instrument, the Binance USDⓈ-M **TRXUSDT
perpetual**. That is a different instrument from Spot TRXUSDT, and the panel shares no code or price
source with the Spot scanner (`src/lib/binance.ts`) or the Binance Spot card.

### Requests

Nothing is requested until **Read public contract data** is pressed. Each accepted press sends one
GET to each endpoint, concurrently, from the browser to `https://fapi.binance.com`:

| Group                | Endpoint                               | Provider time shown                                        |
| -------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Contract and filters | `/fapi/v1/exchangeInfo`                | None. `serverTime` is documented as "ignore" and not used. |
| Mark price, funding  | `/fapi/v1/premiumIndex?symbol=TRXUSDT` | `time`                                                     |
| Last price           | `/fapi/v2/ticker/price?symbol=TRXUSDT` | `time`, documented as the transaction time                 |
| Funding schedule     | `/fapi/v1/fundingInfo`                 | None in the response                                       |

- **Unsigned and bare.** Requests carry no key, signature, custom header or cookie
  (`credentials: 'omit'`), use `cache: 'no-store'`, send no referrer and refuse redirects
  (`redirect: 'error'`). There is no proxy and no Supabase call.
- **Bounded.** Each request stops after 10 seconds. Nothing retries or refreshes on its own.
- **One read at a time.** While a read is in flight the button is `aria-disabled` and presses are
  ignored. Unmounting the card aborts the requests, and a late answer is discarded.
- **Cleared on a new read.** A press removes the previous snapshot at once; nothing old is shown as
  current. Nothing is saved, so a reload starts empty.

### What is shown

Every group shows its **source** (method and full URL), the time it was **received** on this
device's clock, and the **provider time** when the response has one. One is never substituted for
another.

- **Contract and filters.** Symbol, contract type, pair, status, base, quote and margin asset as
  reported. The contract is supported only as `TRXUSDT`, pair `TRXUSDT`, `PERPETUAL`, base `TRX`,
  quote and margin `USDT`, status `TRADING`. Then `PRICE_FILTER` (tick size, minimum and maximum
  price), `LOT_SIZE` and `MARKET_LOT_SIZE` (step, minimum and maximum quantity), `MIN_NOTIONAL`, and
  the reported `liquidationFee` rate, labelled context only. `maintMarginPercent` and
  `requiredMarginPercent`, documented as "ignore", are never read.
- **Mark price** from premiumIndex and **last price** from ticker/price v2, in separate groups.
- **Reported funding rate** (`lastFundingRate`, which Binance documents as the latest funding rate)
  and the **next funding time**. The panel says the rate is reported, not settled, that nothing
  says it will settle unchanged, and that it is not the simulation's holding-period carrying cost.
- **Funding schedule** from fundingInfo: interval, cap and floor as published. fundingInfo lists
  only contracts whose cap, floor or interval was adjusted. When TRXUSDT is absent the panel says
  so and shows no interval; it never assumes 8 hours.
- **Not read: account parameters.** Trading fee rates and the maintenance-margin bracket always read
  "Account-specific — not read; enter manually." Public fee schedules and public bracket tables are
  not shown or used.

**Exact values.** Provider decimals are kept as their strings. A rate is also shown as a percentage
by moving the decimal point two places (`0.012500` → `1.2500 %`, `-0.00058793` → `-0.058793 %`), so
no digit is lost or added. Values that are not plain decimals (for example `1e-5` or a number) are
malformed. Times are milliseconds, written as UTC.

### Failures

Each group fails on its own and says why; nothing from a failed group is shown.

| Case                                 | Shown                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| No response (CORS, region, offline)  | The browser received no response; the browser does not say which cause.                     |
| Timeout                              | No complete response within 10 seconds.                                                     |
| HTTP error                           | The status code, for example HTTP 451. No interpretation is added.                          |
| Malformed body                       | The field that does not have the documented shape, or "not JSON".                           |
| A missing or malformed filter        | Marked in its own row; the other filters still show.                                        |
| Unsupported identity or status       | Each mismatch is listed; filters, prices and funding are withheld.                          |
| TRXUSDT not listed in exchangeInfo   | Unsupported contract; everything else is withheld.                                          |
| exchangeInfo failed, others answered | "Contract not confirmed"; the other groups are checked only against their own symbol field. |
| TRXUSDT not listed in fundingInfo    | "Not published for TRXUSDT"; no interval, cap or floor.                                     |

### Not in this increment

No prefilling of the simulation, no change to its inputs, no quantity rounding to the contract step
and no order-validity verdict. The filters are compared with the simulation only in the separate
[filter comparison](#filter-comparison), on an explicit press. No other symbol, no scanner change,
no signed endpoint, no account data.

### Verification (2026-11-14)

- **Fields** checked against the official USDⓈ-M documentation the same day (exchangeInfo,
  premiumIndex, ticker/price v2, fundingInfo, filter definitions, HTTP return codes), and against
  public TRXUSDT responses read the same day.
- **Tests:** `src/test/perpetualContractFacts.test.ts` (parsing, identity and status mismatches,
  malformed shapes, missing fundingInfo, timestamps, exact percent conversion, the four exact
  requests and their options, partial failures, timeout, cancellation) and
  `src/test/perpetualContractFactsPanel.test.tsx` (no request before the press, provenance and both
  clocks, mark versus last price, funding wording, fees and brackets, partial and malformed
  failures, unsupported contract, missing fundingInfo, timeout, ignored presses in flight, clearing
  on a new read, unmount, no storage, and an untouched simulation). An Account test checks the
  card sits right after the simulation, outside the Binance card, with no request on load.
  Eight deliberate mutations were tried; seven failed a test. Removing the late-answer guard is not
  observable, because overlapping reads are already refused and React ignores updates after
  unmount.
- **Browser:** the local dev server with Supabase pointed at an unused port. Before the first load,
  Playwright aborted every request and WebSocket not served by that server and answered the four
  fapi endpoints from fixtures. Checked: no fapi request on load; exactly four GETs per press;
  Tab from the simulation reaches the button, Enter reads, focus stays with a visible outline; a
  partial failure (HTTP 451, a dropped connection, fundingInfo without TRXUSDT); an unsupported
  margin asset and status; 375 px with no horizontal overflow; light and dark themes.

  Not checked: a live request to Binance from the hosted app, a screen reader, Safari, a phone.

## Filter comparison

**Scenario against TRXUSDT perpetual filters** (`src/components/PerpetualFilterComparison.tsx` over
`src/lib/perpetualFilterComparison.ts`) is its own card in Account, right after the public contract
data. It runs arithmetic checks of the simulation's current result against the filters of the last
public read. It sends no request, has no storage, and never rounds, resizes or changes an input.
There is no overall verdict, and nothing says a position is ready to trade.

The three cards share one account-keyed state (`PerpetualWorkspace` in AccountPanel). The simulation
and the facts panel report each change in the same event that makes it, so the comparison never
sees an old input or an old read.

### Binding and prerequisites

The simulation does not name an instrument. Only a press of **Compare this scenario with TRXUSDT
perpetual** treats the scenario as a TRXUSDT USDⓈ-M perpetual position, for these checks only. The
result states the binding and the time of the press. The button is `aria-disabled`, and a press does
nothing, until all of these hold:

- the simulation has a valid result;
- the last public read finished, and its exchangeInfo group passed the fixed-contract check
  (`contractGate` is `confirmed`); premiumIndex, ticker and fundingInfo are not used;
- that snapshot is no older than 60 seconds.

The status line names whichever is missing.

### Checks

Values are compared as exact integers at a shared decimal scale: the simulation's own strings and
the snapshot's own strings, with no floating point. Rules follow Binance's USDⓈ-M
[filter definitions](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/common-definition)
(last modified 2026-11-12, read 2026-11-14).

| Subject                  | Filter          | Rule                                                                       |
| ------------------------ | --------------- | -------------------------------------------------------------------------- |
| Quantity                 | LOT_SIZE        | ≥ minQty; ≤ maxQty; (quantity − minQty) % stepSize = 0                     |
| Quantity                 | MARKET_LOT_SIZE | Same rules, kept separate; Binance defines it for MARKET orders            |
| Entry fill, exit fill    | PRICE_FILTER    | ≥ minPrice; ≤ maxPrice; (price − minPrice) % tickSize = 0, each on its own |
| Simulated entry notional | MIN_NOTIONAL    | quantity × entry fill ≥ notional                                           |

Each of the 13 checks shows the compared value, the reported constraint and one of **within this
constraint**, **outside this constraint** or **not checked**. A step or tick outside its grid also
shows the exact remainder.

- **MIN_NOTIONAL** is arithmetic only. Binance values a MARKET order at the mark price, which is not
  read here, so the check does not validate a Market order's exchange reference-price calculation.
- **PRICE_FILTER only.** PERCENT_PRICE, the band around the mark price, is not checked, and the stop
  trigger is not compared.
- **Not established:** account eligibility, sufficient collateral, maintenance-bracket validity,
  price-band compliance, liquidity or order acceptance.

### Unusable filters

| Case                                            | Handling                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Filter missing from the snapshot                | Its checks are not checked: "Not reported: the snapshot has no … filter".                 |
| Field not a plain decimal                       | Its checks are not checked, naming the field.                                             |
| PRICE_FILTER field equal to 0                   | That rule is not checked: Binance documents 0 as disabling it. The other rules still run. |
| PRICE_FILTER minPrice above maxPrice (both set) | All three price checks are not checked: the filter contradicts itself.                    |
| LOT_SIZE or MARKET_LOT_SIZE minQty above maxQty | All three checks of that filter are not checked; the other lot filter still runs.         |
| stepSize 0                                      | The step check is not checked: Binance gives no disabled meaning, and % 0 is undefined.   |
| A duplicate filter, or an unconfirmed contract  | The snapshot is not validated (see [failures](#failures)), so no comparison can be made.  |

### Staleness and invalidation

- **Snapshot time.** The card shows when the exchangeInfo response arrived, on this device's clock.
- **Popup policy, not a Binance rule:** a snapshot older than 60 seconds is stale. A timer re-renders
  the card at that moment; no request is made. The outcomes of a shown comparison all turn to "not
  checked" with the reason, the button is disabled, and the age is checked again at every press.
  Exactly 60 seconds is still fresh.
- **Cleared, never refreshed.** Editing any input, switching the sizing, clearing the simulation,
  starting a new public read, or a new read that fails or finishes clears the comparison, and the
  status says why. Comparing again always needs another press.

### Verification (2026-11-14)

- **Tests:** `src/test/perpetualFilterComparison.test.ts` (inclusive minimum and maximum one 1e-8
  either side, LOT_SIZE and MARKET_LOT_SIZE apart, exact step and tick remainders, steps counted
  from minQty across decimal scales, disabled PRICE_FILTER rules, contradictory and zero-step
  filters, missing and malformed filters, MIN_NOTIONAL at the boundary, the 60-second boundary,
  and an unchanged scenario) and `src/test/perpetualFilterComparisonPanel.test.tsx` (nothing before
  a press, no request from the comparison, the binding and snapshot time, every check's three
  parts, untouched inputs, a refused contract, staleness at 60 s and 60 s + 1 ms, the age check at
  the press, and clearing on an edit, a cleared simulation, a new read and a failed read). The
  Account test checks the card follows the public data, outside the Binance card. Twelve
  deliberate mutations were tried; every one failed a test.
- **Browser:** the local dev server with Supabase pointed at an unused port, every request and
  WebSocket not served by it aborted before the first load, and the four fapi endpoints answered
  from fixtures. Checked: no fapi request on load and none from a compare; keyboard only from the
  first input through Read and Compare, with a visible focus outline; 13 checks with exact
  remainders; the live page turning stale 60.02 s after receipt with all outcomes withheld; clearing
  on a new read and on an edit; 375 px with no horizontal overflow; light and dark themes; no new
  storage keys.

  Not checked: a live Binance response, a screen reader, Safari, a phone.

## Acceptance fixtures

All values are invented. None is a quote, balance, rate or recommendation.

| Case                                              | Expected                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| C 10, notional 50, entry 1, exit 0.96, zero costs | Loss 2, −20 % of starting collateral                                   |
| Same, m 1 %, A 0, bracket 0–50,000                | Reference 40 ÷ 49.5 = 80/99, shown as 0.80808081                       |
| Leverage 2×, 5×, 10× on C 10                      | Losses 0.8, 2, 4; references 50/99, 80/99, 10/11                       |
| Fees 0.05 % each, carrying cost +0.105            | Equity 7.846, −21.54 %; after-cost reference 4013/4950                 |
| Carrying credit −0.105                            | Equity 8.105, −18.95 %; after-cost reference 7979/9900                 |
| m 0, A 1 (review reproduction)                    | `negative_requirement` for both references; equity 0 at exit 0.80      |
| m 1 %, A 0.5                                      | `negative_requirement`: requirement ≈ −0.101 at P* = 39.5/49.5         |
| m 1 %, A 0.4, or m 0, A 0                         | Zero requirement: reference 4/5 = 0.8, notional 40                     |
| m 1 %, A 0.4, carrying credit −0.1                | Zero-cost reference 0.8; after-cost `negative_requirement`             |
| Spot planner, allocation 50, same move            | Same quantity and absolute loss (2); 4 % of cash vs 20 % of collateral |

## Sources

Read 2026-11-14:
[Leverage and Margin of USDⓈ-M Futures](https://www.binance.com/en/support/faq/leverage-and-margin-of-usd%E2%93%A2-m-futures-360033162192),
[Liquidation price of USDⓈ-M contracts](https://www.binance.com/en/support/faq/how-to-calculate-liquidation-price-of-usd%E2%93%A2-m-futures-contracts-b3c689c1f50a44cabb3a84e663b81d93),
[Futures liquidation protocols](https://www.binance.com/en/support/faq/binance-futures-liquidation-protocols-360033525271),
[Funding rates](https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031),
[New Algo Order](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/New-Algo-Order).

For the public contract data, also read 2026-11-14:
[General info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info),
[Common definitions and filters](https://developers.binance.com/docs/derivatives/usds-margined-futures/common-definition),
[Exchange information](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information),
[Mark price](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price),
[Symbol price ticker v2](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Symbol-Price-Ticker-v2),
[Funding rate info](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-Info).
