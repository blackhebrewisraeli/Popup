# Binance Spot outcome tracking: account-event and reconciliation contract

**Stage D specification.** Sections 8, 9 and 10 record the parts implemented since; everything
else is specification only. It adds no endpoint, storage, ledger, valuation, P&L, scheduler or
Binance request. It does not show that account history is complete, that any reconciliation result
matches a real account (none has been compared), or that outcomes measured this way are
economically useful. The owner's first live read-only checks are recorded in
[BINANCE_SPOT_ACCOUNT.md](BINANCE_SPOT_ACCOUNT.md#verification). Canonical model `1.0.0` stays
descriptive.

It builds on the read-only integration in [BINANCE_SPOT_ACCOUNT.md](BINANCE_SPOT_ACCOUNT.md) and
does not repeat the provider contract recorded there. Code links in the historical gap analysis
point to `56366db`.

[#157](https://github.com/blackhebrewisraeli/Popup/pull/157) merged the original stage-D
specification at `62f4fbb`. Commit `ddb949b` was a later documentation correction, not part of that
merge; [#158](https://github.com/blackhebrewisraeli/Popup/pull/158) carried its corrected contract
onto main at `bfea2e6`. The reliable accumulated-execution-evidence prerequisite from section 8
merged in [#159](https://github.com/blackhebrewisraeli/Popup/pull/159) at `e179bc2`. Quantity
reconciliation (section 9) merged in [#160](https://github.com/blackhebrewisraeli/Popup/pull/160)
at `e74fb6c`: a pure function checked on synthetic fixtures only. The manual Account flow in
section 10 ([#163](https://github.com/blackhebrewisraeli/Popup/pull/163), merged at `836ba95`) now
calls it, and shows every result as Indeterminate while D3 is unverified. The execution view can
also read an explicit historical UTC range of at most 24 hours
([#164](https://github.com/blackhebrewisraeli/Popup/pull/164)), so an existing fill can be inspected
without a new trade; that changes no rule here and does not settle D3, D4 or D6. Acquisition cost
and P&L remain unimplemented.

[p]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/lib/portfolioAccounting.ts

## 1. What the integration records today

| Topic           | Recorded and guaranteed                                                                                                                                                                                                                                                                                                                            | Gap for reconciliation                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Balances        | `asset`, `free`, `locked` as Binance's decimal strings. Zero rows are omitted by Binance (`omitZeroBalances=true`) and again by Popup, so an asset absent from a successful read holds zero. A repeated asset refuses the read ([`parseBalances`][h-bal], [`readBalances`][h-rb]).                                                                 | Spot wallet only. The time is `readAt`, the function's own clock after the read ([L787][h-at]); Binance's `updateTime` is not kept, and Binance does not document its meaning. Balances and fills come from separate requests at different moments, so there is no common snapshot. Kept in component memory only ([`applySpotRead`][c-apply]). |
| Fill identity   | `(symbol, tradeId)`; trade and order IDs as decimal strings; several fills of one order stay separate. Identical repeats collapse only when every recorded field is exactly equal. Distinct variants under one identity are retained as a conflict and excluded from consistent fills. An ID above 2^53 refuses the page instead of being rounded. | `orderListId`, `isMaker` and `isBestMatch` are not kept. Binance does not document whether one account can legitimately receive different trade-list rows under one identity; Popup therefore reports the conflict without choosing.                                                                                                            |
| Decimals        | Strings matching `^\d+(\.\d+)?$`, never floats. Duplicate equality is character-for-character, so numerically equal `1.0` and `1.00` are conflicting representations.                                                                                                                                                                              | Any later arithmetic must stay exact at each value's own scale. `spotScenario.ts`'s BigInt parsing fits; its fixed 1e-8 quantity scale does not.                                                                                                                                                                                                |
| Commission      | Amount and asset kept together, never converted ([L259–268][h-fee]).                                                                                                                                                                                                                                                                               | Binance does not say how the trade-list `commission` relates to its standard, tax and special commissions (decision D3).                                                                                                                                                                                                                        |
| Time range      | At most 24 hours, kept inclusive at both ends ([`validRange`][h-range], [L302][h-dup]). The first page is time-bounded, later pages use `fromId` ([`readSymbolPage`][h-page]). The view's window ends at the browser clock ([L285][u-end]).                                                                                                        | Binance does not state whether `startTime`/`endTime` are inclusive for this endpoint, so a fill on a shared boundary millisecond can appear in two windows. Times are milliseconds, and several fills can share one.                                                                                                                            |
| Pagination      | 100 fills per page. A full page returns an HMAC-signed continuation from the last ID plus one; a short page or one past the end completes the pair; a page whose IDs decrease is refused. Each response explicitly names pairs whose terminal page succeeded, and the view accumulates that evidence with earlier failures and conflicts.          | The continuation remains opaque and proves only that another request may be made. Completion is scoped to the requested pairs and window; it says nothing about another pair, another window or lifetime account history.                                                                                                                       |
| Partial failure | Failed pairs are listed per response. A rate limit fails every remaining pair and stops. The view keeps every earlier pair/page failure for the retrieval even when a later response reports `partial: false`; top-level continuation failures are retained too.                                                                                   | A failed pair gets no cursor and cannot resume inside that retrieval. Its window can only be attempted again from the start in a fresh explicit retrieval; the failed retrieval remains incomplete.                                                                                                                                             |
| Retention       | Popup claims no lifetime history.                                                                                                                                                                                                                                                                                                                  | Binance states no retention period for the trade list.                                                                                                                                                                                                                                                                                          |

[h-bal]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L409-L426
[h-rb]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L525-L539
[h-at]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L787
[h-row]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L250-L281
[h-id]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L243-L245
[h-dup]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L302
[h-mono]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L299
[h-dec]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L239
[h-fee]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L259-L268
[h-range]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L397-L407
[h-page]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L579-L604
[h-cov]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L654-L667
[h-fail]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/supabase/functions/binance-spot-account/handler.ts#L641-L648
[c-apply]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/lib/binanceSpotAccount.ts#L234-L251
[u-dedup]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/components/BinanceSpotExecutions.tsx#L69-L77
[u-fail]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/components/BinanceSpotExecutions.tsx#L115
[u-end]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/components/BinanceSpotExecutions.tsx#L285-L288
[t-dup]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/test/binanceSpotAccountHandler.test.ts#L441-L503

**Binance facts checked again on 2026-11-12** in the Spot API documentation source
([`rest-api.md`](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), its
[account endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints)
and [general information](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-api-information)
pages, and the [commission](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/commission_faq.md)
and [self-trade prevention](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/stp_faq.md)
FAQs). They match the 2026-11-10 contract and add:

- The trade-list response also carries `orderListId`, `isMaker` and `isBestMatch`. The page
  states no retention period and does not say whether `startTime`/`endTime` are inclusive. The
  supported parameter combinations never pair `fromId` with a time bound.
- The account response carries `updateTime` with no description of what it marks.
- Data is chronological unless an endpoint says otherwise; with both time bounds a request starts at
  `startTime` and stops at `endTime`. Times are milliseconds unless microseconds are requested.
- The commission FAQ names three commission kinds (standard, tax, special) and says the BNB
  discount applies to standard commission only. With too little BNB, the full commission comes out
  of the received asset. It never mentions the trade list.
- Under self-trade prevention mode `NONE`, an account's orders can trade with each other. The FAQ
  does not say how such a trade appears in the trade list.

Provider guarantees end there. Everything below is Popup's own, narrower policy.

## 2. Account events

| Event                                                                                            | Required evidence                                                                              | Available now                                                                                                              | Missing                                    | Consequence                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Spot buy or sell on a selected supported pair                                                    | Identity, time, side, `qty`, `quoteQty`, `commission`, `commissionAsset`, base and quote asset | All of it, for the selected pair and window. Base and quote come from Popup's fixed `<BASE>USDT` set, not Binance metadata | `isMaker` (not needed)                     | Base moves by ±`qty`, USDT by ∓`quoteQty`. The USDT side of cost or proceeds is exact.                                          |
| Fee in the quote asset (USDT)                                                                    | `commission`, `commissionAsset`                                                                | Yes                                                                                                                        | None                                       | USDT moves by −fee. A USDT cost or proceeds component, kept separate (D2).                                                      |
| Fee in the base asset                                                                            | Same                                                                                           | Yes                                                                                                                        | None                                       | Base moves by −fee in the same fill, so a buy receives `qty` − fee. Cost needs no exchange rate.                                |
| Fee in BNB or any other asset                                                                    | Same                                                                                           | Amount and asset                                                                                                           | That asset's other movements, and any rate | That asset moves by −fee and leaves reconciliation scope. The subject's cost becomes partial: the fee stays an unvalued amount. |
| **Unsupported:** fill on a pair not read (unselected, outside the 12, or another quote)          | Its fills                                                                                      | No                                                                                                                         | Everything                                 | An unseen movement of the subject: a discrepancy, or masked by another one.                                                     |
| **Unsupported:** deposit                                                                         | Asset, amount, time, status                                                                    | No                                                                                                                         | Everything                                 | Unexplained increase. Binance holds no cost for deposited units.                                                                |
| **Unsupported:** withdrawal                                                                      | Asset, amount, fee, time, status                                                               | No                                                                                                                         | Everything                                 | Unexplained decrease. Which units left depends on the cost method.                                                              |
| **Unsupported:** transfer between Spot and another wallet or account                             | Asset, amount, direction, time                                                                 | No; balances cover the Spot wallet only                                                                                    | Everything                                 | Unexplained change; ownership is unchanged but invisible.                                                                       |
| **Unsupported:** conversion (Convert, small-balance conversion and similar)                      | Both assets and amounts, time                                                                  | No, and nothing shows they appear in the trade list                                                                        | Everything                                 | Moves two assets; looks like a deposit or a withdrawal.                                                                         |
| **Unsupported:** other credits and debits (distributions, rewards, token migrations, delistings) | Asset, amount, time                                                                            | No                                                                                                                         | Everything                                 | Unexplained change.                                                                                                             |
| Order placed or cancelled, not filled                                                            | None                                                                                           | Only as `free` versus `locked`                                                                                             | None                                       | Moves `free` ↔ `locked` only. Reconcile on `free + locked`.                                                                     |

## 3. Initial tracking scope

One bounded case that the existing reads can support. Nothing wider is justified yet.

- **Account and asset.** The configured owner's Binance Spot wallet. One **subject asset**: the
  base asset of one supported pair. Not USDT, which moves on every USDT pair and through most
  unsupported events, and not BNB, which pays fees on pairs that are not read. USDT and fee-asset
  movements are reported, never reconciled.
- **Time boundary.** An opening balance read at `O` and a closing balance read at `C` (their
  `readAt`), with `C − O ≤ 24 h − 2g`. One execution selection for that pair over `[O − g, C + g]`,
  read after `C + g`. The guard `g` is **60 seconds**, a **provisional Popup policy**. It is set
  above the client's 20 s read limit. It is not a Binance figure, and it is not a proven bound on
  the skew between the function's clock and Binance's or on when Binance took the balance
  snapshot. Passing the guard only means no fill is visibly close to a read. It does not make
  either read an atomic or synchronized account snapshot (D6).
- **Opening quantity and cost.** Opening quantity = `free + locked` of the subject at `O`
  (absent = 0). Opening cost is known only when the opening quantity is zero. Otherwise it is
  **unknown**: a quantity is not evidence of what it cost, and an owner-typed figure is an
  assertion, not evidence, so it is out of scope. Opening inventory is never given zero cost.
- **Identity, deduplication and order.** Event identity is `(symbol, tradeId)`. Identical
  repeats collapse to one event. The same identity with any field different is a **conflict**,
  never first-wins. Within the pair, order is `(time, tradeId as an integer)`. That is Popup
  policy: Binance states chronological order only. Quantity reconciliation does not depend on
  order; a cost method does.
- **Movements and fees.** Per fill, in exact decimals: base `+qty` on a buy and `−qty` on a sell;
  USDT `−quoteQty` on a buy and `+quoteQty` on a sell; `commissionAsset` `−commission`. Only the
  subject's movement is reconciled. A fee in the subject reduces it directly; a USDT fee is a
  separate USDT component; a fee in any other asset is kept as an unvalued amount of that asset. No
  exchange rate is invented.
- **Coverage.** The pair is complete for the selection only when its first page and every
  continuation succeeded and the last page was short or passed the end. "No further
  continuation" alone is not completeness: a pair that failed also ends with none. The consumer
  tracks this across pages, because `coverage` describes one response and a failed pair drops out
  of later ones. Account history is always **not established**: a fixed statement, not a computed result.
  Reading every page of one pair and window says nothing about other pairs, windows or event kinds.
- **Closing reconciliation.** `expected = opening + Σ subject movements`;
  `difference = closing − expected`.
  - **Consistent:** coverage complete, no conflict, no fill within `g` of `O` or `C`, and
    `difference = 0`. This is **numerical consistency only**: the pair's fills add up to the
    change. It does not prove that every event was seen, since offsetting unseen events cannot be
    ruled out, and it does not make any acquisition cost known.
  - **Discrepancy:** the same conditions, with `difference ≠ 0`. Report the exact difference with
    its sign and leave it **unattributed**; the unsupported rows above are possible causes, and
    none is chosen.
  - **Indeterminate:** anything else: an incomplete or failed page, a conflict, a fill within the
    guard, a missing or failed balance read, or a selection that breaks these rules. Say which.
- **Unresolved discrepancies** stay with their window and amount. They are not netted against
  another window or carried forward as a correction.

## 4. Known, partial and unavailable

Three results, each with its own status, never merged into one figure and never derived from one
another. A Consistent quantity is a precondition for a cost status, not evidence of one. "Known"
always means **known within scope**: it assumes no unseen event touched the subject during the
window, an assumption Popup cannot test (example 6b).

**The cost and P&L rows are specification only.** They must not be implemented while D1 and D2
remain undecided and D3 and D4 remain unverified. Until then, at most the recorded components
(USDT amounts, and fees in their own assets) are reported, with no cost status.

| Result                                                 | Known within scope                                                                                                                                                                                  | Partial                                                                                                                                                                              | Unavailable                                                   |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Quantity reconciliation                                | Consistent                                                                                                                                                                                          | Never: a reconciliation is consistent or it is not                                                                                                                                   | Discrepancy (states the amount) or Indeterminate (states why) |
| Acquisition cost of the closing quantity               | Consistent; every held unit came from an in-window buy (or opening quantity is zero); every buy fee was in USDT or the subject; and the result does not depend on the cost method, or D1 is decided | Consistent, but some units have unknown cost (opening inventory), a fee is unvalued in another asset, or the allocation depends on the undecided method. Report each part separately | Not consistent, or no held unit has a known cost              |
| Realized P&L (later; not specified for implementation) | Sold units' cost is known and proceeds net of fees are in USDT                                                                                                                                      | A sell fee is unvalued in another asset                                                                                                                                              | Sold units' cost is not known                                 |

Unrealized P&L needs a valuation and stays out of scope. USDT is not treated as USD.

## 5. Synthetic examples

Every value is invented. Subject BTC on BTCUSDT unless stated; `g` = 60 s; fills lie well inside
`(O + g, C − g)` and coverage is complete unless stated. Cost statuses are the provisional ones from
section 4. They illustrate the contract and are not a result Popup would compute today.

**E1. Buy and sell with USDT fees.** Opening 0; closing 0.30000000.

| Trade | Side | `qty`      | `quoteQty`  | Fee             |
| ----- | ---- | ---------- | ----------- | --------------- |
| 1001  | buy  | 0.50000000 | 50.00000000 | 0.05000000 USDT |
| 1002  | sell | 0.20000000 | 24.00000000 | 0.02400000 USDT |

BTC: 0.5 − 0.2 = 0.3, difference 0, **Consistent**. USDT is reported, not reconciled:
−50 − 0.05 + 24 − 0.024 = −26.07400000. Cost: one lot, so the method does not matter. The 0.3 BTC
held cost 30.00000000 USDT plus 0.03000000 USDT of fee, allocated pro rata as the paper books do;
D2 decides whether the fee joins the cost. **Known.** The sale's realized result would be known:
24 − 0.024 − 20 − 0.02 = 3.956 USDT if fees join (D2). Popup computes and shows none of this.

**E2. Base-asset fee.** Opening 0. Trade 2001 buys 1.00000000 for 100.00000000 USDT, fee
0.00100000 BTC. Closing 0.99900000. BTC: 1 − 0.001 = 0.999, **Consistent**. Ignoring the fee
would expect 1.00000000 and report a false discrepancy of −0.00100000. Cost **known**: 100 USDT
for 0.999 BTC, with no rate needed.

**E3. BNB fee on another asset.** Opening BTC 0, BNB 2.00000000. Trade 3001 buys 0.10000000 for
10.00000000 USDT, fee 0.00500000 BNB. Closing BTC 0.10000000, BNB 1.99500000. BTC: **Consistent**.
BNB −0.005 is reported but not reconciled, even though 2 − 0.005 matches: fees on pairs that are not
read, and other events, also move BNB. Cost **partial**: 10.00000000 USDT plus 0.00500000 BNB,
unvalued. No BNB/USDT rate is assumed.

**E4. Several fills, overlapping pages, one ID on two pairs.** Selection BTCUSDT and ETHUSDT
(the server accepts up to four pairs); subject BTC; opening 0; closing 0.30000000. Two reads whose
windows share a boundary millisecond return:

| Pair    | Trade | Order | Side | `qty`      | `quoteQty`  | Fee             |
| ------- | ----- | ----- | ---- | ---------- | ----------- | --------------- |
| BTCUSDT | 4001  | 77    | buy  | 0.10000000 | 10.00000000 | 0.01000000 USDT |
| BTCUSDT | 4002  | 77    | buy  | 0.20000000 | 20.00000000 | 0.02000000 USDT |
| BTCUSDT | 4002  | 77    | buy  | 0.20000000 | 20.00000000 | 0.02000000 USDT |
| ETHUSDT | 4001  | 91    | buy  | 1.00000000 | 5.00000000  | 0.00500000 USDT |

Three events: the repeated BTCUSDT 4002 is one; BTCUSDT 4001 and ETHUSDT 4001 are two. BTC:
0.1 + 0.2 = 0.3, **Consistent**; cost **known**: 30 USDT plus 0.03 USDT of fees. Wrong identities
fail visibly: by trade ID alone one 4001 row is lost (if it is BTC's, a false difference of +0.1);
by order ID, 4002 is lost (+0.2); without deduplication 4002 counts twice (−0.2). Only BTCUSDT's
coverage matters here; an ETHUSDT failure would not change the BTC result.
**E4b:** if the repeated 4002 row had `qty` 0.25000000, it is a conflict and the result is
**Indeterminate**. Today's code would keep whichever row arrived first, silently.

**E5. Opening inventory with unknown cost.** Opening 0.40000000, cost unknown. Trade 5001 buys
0.10000000 for 12.00000000 USDT (fee 0.01200000 USDT); trade 5002 sells 0.20000000 for
26.00000000 USDT (fee 0.02600000 USDT). Closing 0.30000000. BTC: 0.4 + 0.1 − 0.2 = 0.3,
**Consistent**. The cost depends on the undecided method (D1):

- First in, first out (the paper books' rule): 5002 sells opening units, leaving 0.2 BTC of
  unknown cost and 0.1 BTC at 12 + 0.012 USDT. Cost **partial**; the sale's result
  **unavailable**.
- Average cost: undefined while any unit's cost is unknown. **Unavailable.**

Giving the opening inventory zero cost would claim, fees included, that the 0.3 BTC cost
12.012 USDT and the sale gained 25.974 USDT. The contract forbids that.

**E6. Evidence that blocks a conclusion.**

- **6a. Unseen increase.** Opening 0; trade 6001 buys 0.10000000 for 10.00000000 USDT, fee
  0.01000000 USDT; closing 0.15000000. Difference +0.05000000, **Discrepancy**. A deposit, a transfer in, a conversion,
  a BTC trade on a pair not read or a distribution could each explain it, and none is chosen. Cost
  **unavailable**: +0.05 could equally be +0.15 in and −0.10 out, so which units are held is
  unknown.
- **6b. Offsetting unseen events.** The same trade 6001 (10.00000000 USDT plus a 0.01000000 USDT
  fee) and a closing of 0.10000000, but 0.1 BTC was withdrawn and 0.1 BTC deposited from
  elsewhere. **Consistent**, and the cost would read as known (10.00000000 USDT plus
  0.01000000 USDT of fee) while the units held are not the ones bought. This is why numerical
  consistency never implies complete coverage or a known cost, and why every known result carries
  the scope assumption.
- **6c. Missing page.** Page 1 of BTCUSDT returns 100 fills and a continuation; page 2 times out.
  The response lists BTCUSDT as failed with no continuation, and the view shows "More results:
  No" beside the partial-retrieval alert. **Indeterminate**, even if the sum happens to match the
  closing balance. In a two-pair read where the other pair failed on page 1, it is simply missing
  from page 2, which reports `partial: false`; the consumer must carry the failure forward.
- **6d. Boundary fill.** A fill 10 s after `O`. Whether the opening read included it is unknown,
  so the result is **Indeterminate**.

| Example | Quantity                      | Acquisition cost (provisional)          | Realized result (later) |
| ------- | ----------------------------- | --------------------------------------- | ----------------------- |
| E1      | Consistent                    | Known                                   | Known, given D2         |
| E2      | Consistent                    | Known                                   | No sale                 |
| E3      | Consistent                    | Partial (BNB fee unvalued)              | No sale                 |
| E4, E4b | Consistent; Indeterminate     | Known; Unavailable                      | No sale                 |
| E5      | Consistent                    | Partial or Unavailable, depending on D1 | Unavailable             |
| 6a      | Discrepancy +0.05000000       | Unavailable                             | No sale                 |
| 6b      | Consistent, and wrong in fact | Known within scope only                 | No sale                 |
| 6c, 6d  | Indeterminate                 | Unavailable                             | Unavailable             |

## 6. Open decisions

- **D1. Cost method.** First in, first out (the paper books' rule), average cost or another. E5
  changes with it. Not chosen here.
- **D2. Fees in cost and proceeds.** Fees stay separate components until decided. The paper books
  attach acquisition fees to lots pro rata.
- **D3. What `commission` covers.** Whether it is the whole amount debited for the fill (standard,
  tax and special commission together). Binance does not say; the live check must compare one
  fill's commission with the balance change. **Still unresolved on 2026-11-13**; see
  [the documentation check](#d3-check-2026-11-13) and the conservative clarification below it.
- **D4. Quote movement.** Whether the USDT balance moves by exactly `quoteQty`, rather than
  `price × qty` rounded. Popup always uses `quoteQty` as recorded and never recomputes it; the live
  check confirms it.
- **D5. One trade ID twice on one pair.** A self-trade under mode `NONE` could plausibly produce a
  buyer and a seller row; Binance does not document it. This contract treats it as a conflict.
- **D6. Guard and clocks.** `readAt` comes from the function's clock, while fill times come from
  Binance, and Binance does not say when its balance snapshot is taken. The 60 s guard is
  provisional policy, not a measured or documented bound. Stamping `readAt` from the Binance time
  the function already fetches would narrow it, but even then no read becomes an atomic snapshot.
- **D7. Boundary inclusivity.** Popup keeps both window ends; Binance does not say. It only
  produces duplicates, which identity handles.

### D3 check (2026-11-13)

Read on 2026-11-13 in Binance's Spot API documentation source: the
[account trade list](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md#account-trade-list-user_data),
the [account endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints)
page, the [commission FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/commission_faq.md)
and the [CHANGELOG](https://github.com/binance/binance-spot-api-docs/blob/master/CHANGELOG.md)
(last updated 2026-11-11).

- **Trade-list row.** Thirteen fields: `symbol`, `id`, `orderId`, `orderListId`, `price`, `qty`,
  `quoteQty`, `commission`, `commissionAsset`, `time`, `isBuyer`, `isMaker`, `isBestMatch`.
  `commission` has an example value and no description. The parser drops only `orderListId`,
  `isMaker` and `isBestMatch`, none of which is a charge, so it omits no commission field.
- **Commission kinds exist only as rates.** `GET /api/v3/account/commission` returns
  `standardCommission`, `taxCommission`, `specialCommission` (maker, taker, buyer, seller) and a
  BNB `discount`; a test order with `computeCommissionRates` returns the same kinds per order; the
  account response carries `commissionRates`. A full order response's fills carry only `commission`
  and `commissionAsset`. `specialCommission` joined the rate responses on 2025-08-12. No CHANGELOG
  entry adds a commission field to the trade list or to fills.
- **The FAQ** computes tax and special commission like standard commission. Without BNB, the
  commissions "are summed up and deducted" from the received asset; with BNB, the discount applies
  to standard commission only; with too little BNB, the full commission comes out of the received
  asset. It describes what an order's trades are charged and never mentions the trade list.

**Still unresolved.** The FAQ makes it plausible that one row's `commission` is the summed charge,
but nothing says so. A rate is not a per-fill amount, so the rate endpoints cannot settle it either.
The owner's 2026-11-13 live execution read returned no fills for its selection, which settles
nothing.

**Conservative clarification (2026-11-13).** Until a real fill's recorded `commission` has been
compared with the balance change it caused, a view over real reads shows every quantity result as
**Indeterminate — commission coverage unverified**: no figure, no difference and no Consistent or
Discrepancy wording. The pure function, its arithmetic and its result are unchanged; only the
display is gated. No owner control lifts the gate, and no provider field or endpoint is added for
it. The comparison must come from Binance's own balance and trade-history views for a fill whose
fee was paid in the subject or USDT, not from this view: a gated view cannot be the evidence for
lifting its own gate. Resolving D3 is a change to this contract, recorded here.

## 7. Reuse and separation

Reused as concepts, not code, from [`portfolioAccounting.ts`][p]: lots carrying their acquisition
fees and allocating them pro rata ([`PositionLot`][p-lot]), and first-in-first-out consumption
([`consumeLotsFifo`][p-fifo]) as one candidate for D1. Not reused: its floating-point quantities
with an epsilon ([L155][p-eps]), its USD cash ledger ([L50][p-cash]) and its transitions, which
write ledger rows. Nothing from Binance enters Live Tracking (`real_tracking`, hand-entered),
Simulation or Paper Trading. A reconciliation is a derived, read-only result over evidence held
in memory.

[p-lot]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/lib/portfolioAccounting.ts#L19-L30
[p-fifo]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/lib/portfolioAccounting.ts#L376-L409
[p-eps]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/lib/portfolioAccounting.ts#L155
[p-cash]: https://github.com/blackhebrewisraeli/Popup/blob/56366db9be11d4d2896b4a6dfbec69c07b732d5a/src/lib/portfolioAccounting.ts#L50-L56

## 8. Reliable accumulated execution evidence (implemented prerequisite)

The existing handler response and execution view now carry this prerequisite through one manual
retrieval. It remains display-only and in component memory:

- **Identical duplicates collapse.** Equality covers `symbol`, `tradeId`, `orderId`, `time`, `side`,
  `quantity`, `price`, `quoteQuantity`, `commission` and `commissionAsset`. Decimal strings compare
  exactly as recorded: `1.0` and `1.00` conflict rather than normalize.
- **Conflicts are surfaced, never resolved.** The same `(symbol, tradeId)` with any field
  different is removed from the consistent-fill table and every distinct variant is shown as
  inconsistent evidence, both within one provider page and across accumulated pages. Neither the
  first nor the last variant is authoritative.
- **Earlier failures stay visible.** A pair that failed on any page of a retrieval stays failed
  for that retrieval. A page response explicitly names pairs whose terminal page succeeded; the
  view accumulates that evidence instead of inferring it from the opaque cursor. A later response
  with `partial: false` does not erase an earlier failure.
- **No continuation is not completeness.** `Continuation: None` says only that no cursor remains.
  Coverage is complete only for the named requested pairs and finite window, and only when every
  pair has explicit terminal-success evidence with no accumulated pair/page or continuation failure
  and no conflict.
- **Continuation failures are evidence.** A top-level continuation failure retains the earlier
  records and cursor for an explicit retry, marks the retrieval unresolved, and remains visible if
  a later retry succeeds.
- **A continued answer must continue this retrieval.** It is merged only when it names the same
  pairs, in the same order, and the same window. Otherwise it is recorded as a failed continuation
  (`invalid_request`) and the earlier evidence and cursor stay; with nothing to continue it yields
  no evidence. (Added after the [pipeline acceptance](#synthetic-pipeline-acceptance-2026-11-12)
  showed the gap.)
- **A fresh successful retrieval starts a new evidence state.** A failed refresh leaves the retained
  earlier result and its label unchanged. A changed selection clears it; owner account changes and
  logout still unmount the owner-keyed component; request sequencing still drops late answers.

It adds no endpoint, storage, reconciliation, cost or P&L code, deployment or Binance request, and
touches no paper, simulation or Live Tracking code. Quantity reconciliation (section 3) is section 9. Cost and P&L statuses (section 4) wait until D1 and D2 are decided and D3 and D4 are verified.

**Live dependency.** Real Binance verification has not run. Before any reconciliation result is
compared with a real account, the owner check in
[BINANCE_SPOT_ACCOUNT.md](BINANCE_SPOT_ACCOUNT.md#verification) must run, and it must also settle
D3 and D4 on one known fill.

## 9. Quantity reconciliation function (implemented, synthetic fixtures only)

[`reconcileSpotQuantity`](../src/lib/binanceSpotReconciliation.ts) applies section 3 to quantities
and nothing else. It is pure: no provider request, clock, storage, ledger or view. The manual flow
in [section 10](#10-manual-reconciliation-flow-implemented-gated-by-d3) calls it. It has run only on synthetic data: the labeled fixtures in
[`binanceSpotReconciliation.test.ts`](../src/test/binanceSpotReconciliation.test.ts), which use the
quantity portions of E1–E6, never their cost statuses, and the
[pipeline acceptance](#synthetic-pipeline-acceptance-2026-11-12) below.

**Inputs.**

- `subject`: the base asset of one supported USDT pair (`BTC` for `BTCUSDT`). USDT and BNB are
  refused.
- `opening` and `closing`: one balance read each, as `parseSpotRead` returns it, with its
  `accountContext`.
- `executions`: the accumulated evidence of one retrieval with its `accountContext`. It is the record
  the execution view already folds page by page with `nextExecutionEvidence`, now in
  [`binanceSpotEvidence.ts`](../src/lib/binanceSpotEvidence.ts). That fold moved out of the view
  unchanged; it also records when the retrieval's first page was read. There is no `complete` flag:
  completeness is derived from the record's terminal successes, failures and conflicts.

`accountContext` is the caller's label for whose reads these are, such as the signed-in owner's
user ID, compared exactly. Popup keeps no Binance account identifier, so this stops reads made for
different owners being mixed; it does not prove which Binance account answered.

**Rules.** O and C are the two `readAt` times and g is 60 s. Any failed rule is a reason.

- Both reads succeeded and are well formed: exact decimal strings, distinct assets, a parseable
  time. An absent subject is zero only in such a read.
- One non-empty `accountContext` across all three inputs.
- O < C and C − O ≤ 24 h − 2g. The selection covers [O − g, C + g], lasts at most 24 h, and its
  first page was read at or after C + g.
- Every fill, consistent or conflicting, lies within its declared pairs and window and has valid
  identifiers and decimals. Each identity appears once.
- The subject pair has explicit terminal success and no pair or page failure, and has no conflict.
  No continuation failed: a continuation is opaque, so its failure cannot be confined to one pair.
  Another selected pair's failure or conflict does not matter (E4), but a fill on it that pays its
  fee in the subject does.
- A subject-pair fill within g of O or C, including the guard bands outside [O, C] and the exact
  edges, makes the result Indeterminate and is never summed. Fills before O − g or after C + g are
  ignored: the opening read already holds them, or the closing read cannot.

Over the fills strictly inside (O + g, C − g): `opening = free + locked`,
`movement = buys − sells − fees paid in the subject`, `expected = opening + movement` and
`difference = closing − expected`.

**Arithmetic.** BigInt counts at the widest scale recorded among the amounts that enter a figure,
parsed with `spotScenario.ts`'s `parseDecimal` at that scale rather than its fixed 1e-8. No
floating point, epsilon or rounding. `1.0` and `1.00` are the same amount here, while section 8
still treats them as conflicting evidence under one identity.

**Result.**

- `CONSISTENT`: the difference is exactly zero.
- `DISCREPANCY`: the exact signed difference, unattributed.
- `INDETERMINATE`: every reason found, each a code with the trade IDs, error codes or evidence
  problems behind it, and no figures.

A determinate result lists every figure, the counted trade IDs and the fees the counted fills paid
in other assets (USDT, BNB or any other), each summed in its own asset, never converted and never
reconciled. Every result carries the same fixed limits: numerical consistency only, account history
not established, unseen events not excluded (6b), acquisition cost not evaluated, `commission`
coverage unverified (D3) and a provisional guard (D6).

**Not implemented.** Acquisition cost, P&L, any choice on D1–D4, USDT or BNB reconciliation,
persistence and any Binance request. Display is section 10. Before a result is compared with a real
account, a live check on a real fill must settle D3.

### Synthetic pipeline acceptance (2026-11-12)

[`binanceSpotReconciliationPipeline.test.ts`](../src/test/binanceSpotReconciliationPipeline.test.ts)
runs the layers together on invented data, in one process: the browser client (`supabase-js`
`functions.invoke` via `readSpotAccount` and `readSpotExecutions`) → the committed, unmodified
`handler.ts` with its existing injected env, fetch and clock → a synthetic Binance answering the four
documented GETs (`startTime`/`endTime`, inclusive `fromId`, `limit`, injected faults) → the
handler's JSON, error bodies included → `parseSpotRead` / `parseSpotExecutionRead` →
`nextExecutionEvidence` → `reconcileSpotQuantity`. No evidence object is built by hand. Supabase Auth
is a stub with two invented users. Nothing waits; no network, credential or deployment is involved.

Results, 12 tests, every figure worked by hand:

- Two balance reads and a two-page, two-pair retrieval: `CONSISTENT` with exact figures. BTC fees
  are subtracted; BNB and USDT fees stay in their own assets. An identical repeat within a page and
  one across the page boundary collapse. Two spellings of one ETH fill stay a conflict that keeps
  the retrieval incomplete without affecting BTC (E4).
- Closing one satoshi short: `DISCREPANCY` of `-0.00000001`.
- A failed BTC page, then ETH continued and ended: BTC `pair_failed` although the last page had no
  failure and no continuation; ETH `CONSISTENT`.
- A top-level continuation timeout, then an explicit retry of the same cursor (`fromId` 1101):
  `continuation_failed` despite the successful retry.
- Exactly 100 fills: `pair_incomplete` after the full page, `CONSISTENT` after the empty terminal one.
- A fill at exactly O + g: `fill_near_boundary`. A first page read before C + g:
  `executions_read_too_early`, still after a later page.
- A rate-limited closing read: `closing_unavailable` (`rate_limited`). Reads served to two
  configured owners through one synthetic key: `account_context_mismatch`.
- The handler's `readAt` and `retrievedAt`, the per-pair terminal successes and the first page's time
  survive parsing and accumulation unchanged.

**Defect found and fixed.** `nextExecutionEvidence` merged any answer marked as continued. Through the
real handler, continuing a BTC retrieval that began at O + 30 min with the continuation of a
retrieval over [O − g, C + g] adopted the second window while missing ten fills, and reconciled to a
`DISCREPANCY` of `+0.10000000`. A continuation page with nothing to continue reconciled 60 of 160
fills to `+0.54970000`. Both are now refused as section 8 describes. The view continues only its own
cursor, and a signed continuation carries its pairs and window, so valid retrievals are unchanged.
One view fixture whose continuation answer named a pair its first page had not was corrected.

**Limitations.** This shows that the layers agree with each other, not with Binance. The provider and
Auth are synthetic. `accountContext` is the caller's label and the handler reports no Binance
account identity, so matching labels do not prove that one Binance account answered. A continuation
from another retrieval with the same pairs and window cannot be told apart by its answer. D3 and D6
are not resolved. Real Binance: NOT RUN, and no view calls the function.

## 10. Manual reconciliation flow (implemented, gated by D3)

[`BinanceSpotReconciliation`](../src/components/BinanceSpotReconciliation.tsx) sits in the owner's
Binance Spot card in Account, below the execution view. It composes `readSpotAccount`,
`readSpotExecutions`, `nextExecutionEvidence` and `reconcileSpotQuantity` and adds no arithmetic,
evidence rule, endpoint, provider field or storage.

- **Subject.** One base asset of the supported pairs. USDT and BNB are not offered: the view reads
  the pure module's `EXCLUDED_SUBJECTS`, now exported. The subject is fixed once the opening read
  is captured; Reset changes it.
- **Observations.** **Capture opening balance** and **Capture closing balance** each send one
  balance read (weight 22) and keep it only if it succeeded, with the function's `readAt` and the
  signed-in owner's ID as `accountContext`. A failed read captures nothing. The card's own refresh
  is a separate read and never replaces a captured one. Each is captured once per session.
- **Guarded window.** With both captured, **Retrieve executions** requests exactly `[O − g, C + g]`
  for `<SUBJECT>USDT`, and only once the browser clock has reached C + g. Until then the view says
  when, with a local countdown that never sends a request. Reads out of order or more than
  24 h − 2g apart are explained and never requested (the function would refuse a range over
  24 hours). The pure function still checks the first page's server time against C + g.
- **Continuation.** **Load next page** sends only the evidence's own cursor. A failed page keeps
  the cursor for an explicit retry and stays recorded (`continuation_failed`) after a successful
  retry. **Retrieve again from the start** is the only way to a new evidence state; when it fails,
  the earlier evidence stays unchanged.
- **One request at a time.** A double click sends one request. A rate limit, on the whole read or
  one pair, pauses every request in this flow for Binance's `Retry-After` (60 s without one).
- **Session boundaries.** **Reset** clears the session, and an answer still in flight is then
  dropped. The flow is keyed by owner inside the owner-keyed card, so an owner change or logout
  unmounts it and a late answer changes nothing. An answer that shows lost access
  (unauthenticated, forbidden, not configured, unrecognized) clears the session.
- **Memory only.** No browser storage, query cache or table, and no order, transfer or ledger code.

**Presentation.**

- While D3 is unverified (`QUANTITY_LIMITS.commissionCoverage`), the result always reads
  **Indeterminate — commission coverage unverified**. Its reasons list the D3 statement first,
  then one of: the next step (capture, wait, retrieve); the pure function's Indeterminate reasons
  as actions (load the next page; retrieve again from the start after a failed page, failed
  continuation or conflict; capture reads away from trading for a fill near a read); or, when the
  pure result is determinate, only that nothing else blocks the evidence. No quantity, difference,
  Consistent or Discrepancy wording reaches the page.
- The component's `commissionCoverage` prop defaults to that statement. Only tests pass `verified`,
  to exercise what a resolved D3 would allow: **Consistent within this scope** (numerical
  consistency only, offsetting unseen events not excluded) or **Discrepancy** with the exact signed
  difference (`+` or `-`), unattributed, beside every figure as the pure function formats it.
  Without D3, Indeterminate shows its reasons and no figure. No owner control sets the prop.
- A fixed note always states the scope: one asset, pair and window; account history not
  established; deposits, withdrawals, transfers, conversions and other pairs unseen; a provisional
  guard and no atomic snapshot; commission coverage unverified; no acquisition cost, valuation,
  profit or loss; no order or ledger change.

**Evidence, synthetic only.**
[`binanceSpotReconciliationView.test.tsx`](../src/test/binanceSpotReconciliationView.test.tsx), 26
tests with a mocked clock: no request on mount or as time passes; subject list; capture through
successful reads only, with server times; the countdown and the exact `[O − g, C + g]` request; reads
too far apart; consistent and one-satoshi-short evidence gated with no figure in the page while the
same evidence gives `CONSISTENT` and `-0.00000001` from the pure function; exact figures, including
`+0.00000001`, only with `verified`; pages, a retained continuation failure, conflicts, a failed
pair, a fill near a read, a first page read too early, a failed fresh retrieval; failed and thrown
reads, rate limits, double clicks; reset and owner change with late answers, logout, lost access;
the card's refresh leaving a captured read; no storage writes and only the expected requests. Nine
mutations of the view (gate off, no stale-answer check, no wait, failed reads captured, no
access-loss reset, no backoff, unguarded window, continuation not merged, unsigned difference) each
fail at least one test. In the browser, a local dev server pointed at an unreachable Supabase URL
with the function's answers simulated by Playwright route interception and the `?devAuth` stub:
keyboard capture, the countdown with no request, the exact window, a full page, a timed-out
continuation and its retry, a fresh complete retrieval held Indeterminate with no figure, a card
refresh leaving both captured reads, a double click, a late answer after reset, a rate-limit pause,
unchanged browser storage, 1280 and 375 px without page overflow, light and dark.

**Not verified.** Any reconciliation against a real account, D3, D4 and D6.
