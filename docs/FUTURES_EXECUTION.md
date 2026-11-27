# Owner-approved Binance USDⓈ-M Futures execution

**Status: code only.** Not deployed, not configured, not activated. No request has been sent to
Binance and no order has been placed. Live entries stay off until the owner completes
[activation](#activation-owner-only). No Futures entry rule has been approved, so nothing is
proposed even after activation until one is.

The `futures-execution` Edge Function proposes one Long on a Binance USDⓈ-M perpetual when an
approved entry rule finds a candidate, sends the owner a private Telegram message with Approve and
Reject, and only on the owner's approval of that exact proposal enters at 5× isolated margin,
confirms the fill and places exchange-side exits. It reports actual order and protection status in
Telegram.

It does not touch the Spot workflow. The read-only `binance-spot-account` function, its key check
and its secrets are unchanged.

## Fixed scope

These are code, not settings:

- Binance USDⓈ-M Futures (`https://fapi.binance.com`), USDT-margined perpetuals.
- Long only, isolated margin, 5× leverage, one-way position mode.
- **44 USDT total experiment budget.** A trade's collateral (notional ÷ 5) never exceeds what is
  left of it after cumulative losses.
- One pending proposal and one open execution at a time.

## Flow

1. **Detect** (scheduled tick, every minute). Runs the rule named by `FUTURES_ENTRY_RULE` from
   `ENTRY_RULES` in [`engine.ts`](../supabase/functions/futures-execution/engine.ts). The registry is
   empty. The Spot liquidity ranking and the daily model score are not entry rules. Synthetic
   candidates exist only in the local tests.
2. **Propose.** Reads the symbol's filters, best ask, mark price and the account's taker fee rate.
   Sizes the order (below), stores an immutable proposal and sends it to the owner's private chat
   with Approve and Reject. The message shows the contract, signal reason, entry price bound,
   size, notional, collateral, stop trigger, estimated loss at the stop in USDT, exit targets,
   cumulative loss so far, the budget and the expiry.
3. **Approve.** Only a press from `TELEGRAM_OWNER_USER_ID` in the private chat
   `TELEGRAM_OWNER_CHAT_ID`, on the message that showed the proposal, with the button's hash
   matching the stored terms, counts. The database decides a proposal once and refuses approval at
   or after expiry by its own clock. Duplicates and late presses are answered and ignored.
4. **Recheck before the entry.** Risk limits unchanged since the proposal. Cumulative loss and
   budget still allow the trade. API key permissions are Futures trading only. Ask within the
   approved limit and within `maxPriceMoveBps` of the reference. One-way mode, single-asset mode,
   trading allowed. Symbol flat with no open orders. Isolated margin and 5× set and read back.
   Auto-add margin off. 5× bracket covers the notional. Available USDT covers the collateral. Any
   value that can't be read refuses the entry.
5. **Enter.** One `LIMIT` `IOC` buy at the entry bound, client order ID `pf-<proposal>`. The state is
   written before the request. An unknown answer (timeout, 5xx, the 503 "Unknown error" variant,
   -1006/-1007) is resolved by querying that ID. If Binance has no such order after its 5 s
   `recvWindow`, it was never placed. The entry is never resent.
6. **Protect the filled quantity.** `STOP_MARKET` with `closePosition=true` on mark price, and one
   `TAKE_PROFIT_MARKET` per target with `reduceOnly=true`, sized from the actual fill. Neither can
   open a short. Each algo ID is queried before any retry.
7. **If the fill can't be protected:** cancel the entry remainder, close with a reduce-only market
   order, confirm the position is flat and no order is left, and alert the owner. Until then the
   execution stays `unresolved` and blocks new proposals and entries, and every tick retries.
8. **Reconcile** (every tick, also after a restart). An entry left unknown is resolved. A missing
   stop is replaced or the position is closed. Once the position is flat, every remaining exit is
   cancelled and verified gone. Then the trade's net result (realized PnL, commissions and funding
   in USDT from Binance income) is recorded once.

## Sizing and the two loss limits

The plan takes the largest quantity on the lot grid such that:

- the loss if the stop fills at its trigger, from the worst entry price, **plus taker fees both
  ways**, stays within `maxLossPerTradeUsdt` and within what is left of `maxCumulativeLossUsdt`;
- the collateral stays within what is left of the 44 USDT budget.

If even the smallest order Binance accepts (`minQty`, `MIN_NOTIONAL`, step size) breaks either, the
trade is **skipped** with the figures in the reason. Funding, slippage and gaps through the stop are
not in the estimate. A real loss can exceed it.

**Cumulative loss** is the sum of losing closed trades' net results. Wins don't offset it. A
closed trade whose result can't be verified stops new proposals. That happens when a commission or
funding entry isn't in USDT (BNB fee payment), or no realized-PnL entry exists yet.

## Owner risk limits — `FUTURES_RISK_LIMITS`

One JSON secret with exactly these keys. It has no defaults. If it is unset, malformed, has an
unknown key or a value out of bounds, nothing is proposed or approved. Changing it invalidates any
pending proposal.

| Key                     | Meaning                                                      | Allowed               |
| ----------------------- | ------------------------------------------------------------ | --------------------- |
| `symbols`               | USDT perpetuals the rule may propose                         | 1–5 symbols           |
| `maxLossPerTradeUsdt`   | Cap on one trade's estimated loss at the stop, fees included | > 0, ≤ cumulative cap |
| `maxCumulativeLossUsdt` | Cap on the experiment's cumulative loss                      | > 0, ≤ 44             |
| `stopDistancePercent`   | Stop trigger below the reference ask                         | 0.1–20                |
| `takeProfitR`           | Targets as multiples of the stop distance, ascending         | 1–3 values            |
| `entrySlippageBps`      | Entry bound above the reference ask                          | integer 0–100         |
| `maxPriceMoveBps`       | On approval, how far the ask may have moved                  | integer 1–500         |
| `proposalTtlSeconds`    | Proposal expiry                                              | integer 60–1800       |

Decimals are strings: `{"symbols":["<SYMBOL>"],"maxLossPerTradeUsdt":"<owner>","maxCumulativeLossUsdt":"<owner>","stopDistancePercent":"<owner>","takeProfitR":["<owner>"],"entrySlippageBps":<owner>,"maxPriceMoveBps":<owner>,"proposalTtlSeconds":<owner>}`

## Secrets and switches

| Name                                  | Purpose                                                              |
| ------------------------------------- | -------------------------------------------------------------------- |
| `FUTURES_LIVE_ENABLED`                | Exactly `true` activates proposals and approvals. Unset by default.  |
| `FUTURES_ENTRY_RULE`                  | ID of an approved rule in `ENTRY_RULES`. Unset: nothing is detected. |
| `FUTURES_RISK_LIMITS`                 | The owner limits above.                                              |
| `BINANCE_FUTURES_API_KEY` / `_SECRET` | Dedicated Futures key. Refused if equal to `BINANCE_SPOT_API_KEY`.   |
| `TELEGRAM_BOT_TOKEN`                  | Bot that sends proposals.                                            |
| `TELEGRAM_WEBHOOK_SECRET`             | `secret_token` given to `setWebhook` (A–Z, a–z, 0–9, `_`, `-`).      |
| `TELEGRAM_OWNER_USER_ID` / `_CHAT_ID` | The owner and their private chat with the bot.                       |

Turning `FUTURES_LIVE_ENABLED` off stops proposals and approvals. Reconciliation of an open
position continues. Storage uses the project's secret key against `futures_proposals`,
`futures_executions` and `futures_events`. No browser role can read or write them. The function
answers only in `eu-west-1`, where this project's functions have reached Binance before.

## Activation (owner only)

Each step is the owner's to take, in order. Never paste a key, secret or token into chat, an issue
or a PR.

1. **Merge, then apply the migration** from a checkout of `origin/main`:
   `supabase db push --dry-run`, then `supabase db push` ([release](RELEASE.md)). Vercel production
   builds stay blocked until the migration is applied.
2. **Binance account.** Confirm Futures is available to you and enabled on the account. Set
   one-way position mode and single-asset mode. Keep auto-add margin off for the symbols. Pay fees
   in USDT, not BNB, or results stay unverified.
3. **Binance API key.** Create a dedicated key with reading and **Enable Futures** only: no
   withdrawals, internal or universal transfers, Spot & Margin, Margin, Options or Portfolio Margin.
   The function refuses any other key. See owner decisions on IP restriction.
4. **Telegram.** Create a bot with @BotFather, start a private chat with it, and note your numeric
   user ID. In a private chat the chat ID equals it.
5. **Secrets** (leave `FUTURES_LIVE_ENABLED`, `FUTURES_ENTRY_RULE` and `FUTURES_RISK_LIMITS` unset
   for now): `supabase secrets set --project-ref <ref> BINANCE_FUTURES_API_KEY=… BINANCE_FUTURES_API_SECRET=… TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… TELEGRAM_OWNER_USER_ID=… TELEGRAM_OWNER_CHAT_ID=…`
6. **Deploy:** `supabase functions deploy futures-execution --project-ref <ref>`.
7. **Webhook.** Call Telegram `setWebhook` with
   `url=https://<ref>.supabase.co/functions/v1/futures-execution?forceFunctionRegion=eu-west-1`,
   your `secret_token`, `allowed_updates=["callback_query"]` and `drop_pending_updates=true`.
8. **Schedule the tick** (SQL editor), like the other scheduled functions:

   ```sql
   select cron.schedule('futures-execution-tick', '* * * * *', $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
         || '/functions/v1/futures-execution',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-region', 'eu-west-1',
         'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'secret_key')
       ),
       timeout_milliseconds := 150000
     );
   $$);
   ```

9. **Check it is inert:** the tick answers `"rule":"no entry rule configured"` and
   `futures_events` stays empty.
10. **Approve an entry rule** through a reviewed PR that adds it to `ENTRY_RULES`, then set
    `FUTURES_ENTRY_RULE` to its ID.
11. **Set `FUTURES_RISK_LIMITS`** with your values.
12. **Activate:** `FUTURES_LIVE_ENABLED=true`. To stop, unset it. If you need to stop everything,
    also delete the key on Binance and unschedule the tick.

## Owner inputs still missing

- **An approved Futures entry rule.** The Spot liquidity ranking and the daily model score are not
  Futures signals. A rule needs: the signal and its data source, timeframe and bar-close timing,
  symbol universe, a stop placement from the setup's invalidation (today a fixed percent below the
  ask), exit logic (today R multiples of the stop distance), a cooldown or de-duplication after a
  rejected or expired proposal, and any daily proposal limit or maximum holding time.
- All `FUTURES_RISK_LIMITS` values.
- The Binance Futures API key and the Telegram bot, user ID and webhook secret.

## Owner decisions before activation

- **Eligibility.** Whether Binance USDⓈ-M Futures and API trading are permitted for your
  jurisdiction and account. The function checks only that the account can trade.
- **IP restriction.** Supabase Edge Functions have no fixed egress IP, so the key can't be
  IP-restricted from here. Accept that, or run the function where you can whitelist an IP.
- **Cumulative loss definition.** Gross losses (default here, stricter) or net of wins.
- **Fees in BNB.** Keep USDT fees, or accept that results stay unverified and block new entries.
- **Manual trading on the same symbols.** Results assume no other trading on the symbol while an
  execution is open. Preflight requires it flat with no orders at entry, but manual trades after
  that would enter the recorded result.

## Verification

Automated, local mocks only ([`futuresFlow.test.ts`](../src/test/futuresFlow.test.ts),
[`futuresPlan.test.ts`](../src/test/futuresPlan.test.ts), SQL
[`futures_execution.test.sql`](../supabase/tests/futures_execution.test.sql)): approval,
rejection, expiry, duplicate approval, non-owner and group-chat presses, a button not matching the
stored hash, live off by default, rule and limits required, synthetic Telegram commands ignored,
price and limit changes, account settings and key permissions, the smallest-order skip, partial
fills, unknown and never-accepted entry answers, failed stop placement with a verified close, an
unresolved close that blocks entries until a later tick resolves it, restart reconciliation,
sibling exits cancelled after the stop fires, a replaced stop, a finished stop with a long left,
result recording and the cumulative loss limit. The signing test reproduces Binance's documented
HMAC example. The SQL test checks immutability, single decisions, expiry by the database clock, one
open execution, final states and grants.

Not verified: any request to live Binance or Telegram. In particular, `fapi.binance.com` reachability
from `eu-west-1`, live `algoStatus` values, whether Binance accepts the close-all stop beside the
reduce-only targets, and how soon income entries appear after a close.

## Binance and Telegram references (read 2026-11-27)

- [USDⓈ-M general info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info):
  base URL, signing, `recvWindow`, HTTP 503 variants.
- [Error codes](https://developers.binance.com/docs/derivatives/usds-margined-futures/error-code),
  [change log](https://developers.binance.com/docs/derivatives/change-log): conditional orders on
  `POST /fapi/v1/algoOrder` since 2025-12-09.
- [Trade](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api),
  [account](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api)
  and [filters](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/common-definition).
- [API key permissions](https://developers.binance.com/docs/wallet/account/api-key-permission).
- [Telegram Bot API](https://core.telegram.org/bots/api): `setWebhook` `secret_token`,
  `callback_data` 1–64 bytes, `answerCallbackQuery`.
- [Supabase regional invocation](https://supabase.com/docs/guides/functions/regional-invocation)
  (`forceFunctionRegion`) and
  [background tasks](https://supabase.com/docs/guides/functions/background-tasks)
  (`EdgeRuntime.waitUntil`).
