# Binance Spot account view (owner-only, read-only)

The Account zone can show the owner's Binance Spot balances: asset, available quantity and locked
quantity, with the time of the last successful read. It reads; it does nothing else.

TradingView remains the source for market analysis. Binance supplies account balances only.

## Boundaries

- **No trading surface.** The integration can send three `GET` requests to `api.binance.com` and
  nothing else: server time, API-key permissions, account balances. There is no order, cancel,
  withdrawal or transfer code.
- **One owner.** The edge function serves the single user ID in `BINANCE_SPOT_OWNER_USER_ID`. It
  asks Supabase Auth who the caller is before it reads a credential or contacts Binance. Anonymous
  callers get 401 and other signed-in users get 403. With no owner configured, everyone gets 403.
  There is no bypass and no multi-user credential storage.
- **Read-only key, verified.** Before reading balances the function asks Binance what the key may
  do. Reading must be on. Every documented trading, withdrawal and transfer capability must be
  reported and off, and any other capability that is on (including ones Binance adds later) refuses
  the key. If Binance does not answer that question in the documented shape, the result is
  **Unverified** and no balances are read. The account-level `canTrade` flag is never used for this.
- **Server-side credentials.** The key and secret live in Supabase function secrets. They are not in
  `VITE_*` variables, the browser, URLs the browser sees, logs, fixtures or Git. The function logs
  one line per request: outcome, HTTP status, duration, a Binance error code and the number of
  assets. It never logs which assets or how much.
- **Separate from Popup's books.** The snapshot lives in the Account component's memory only. It is
  not cached, stored, or written to any table, and it never becomes a deposit, position or
  transaction in paper trading, tracked holdings or simulations.
- **Quantities only.** Values are the decimal strings Binance sent, never parsed to floats or
  rounded. No valuation, total, P&L or cost basis is derived, and USDT is not treated as USD.

## States

| Shown                                                                                         | Meaning                                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Nothing                                                                                       | Not the owner, signed out, or the function is not deployed                                               |
| Not configured                                                                                | Owner is set, but the flag, key or secret is missing                                                     |
| Reading balances from Binance…                                                                | A read is in flight; refresh is unavailable until it ends                                                |
| Connected … Last successful read _time_                                                       | Key verified read-only; the table, or "no non-zero Spot balances"                                        |
| **Stale**                                                                                     | The last successful read is more than 5 minutes old                                                      |
| Not current. Showing the last successful read, from                                           | A refresh failed; the earlier balances stay, labeled, with the reason                                    |
| Binance rejected the API key…                                                                 | Binance refused the key, signature or IP                                                                 |
| Refused: this API key can do more than read (…)                                               | The key has trading, withdrawal or transfer enabled; names them                                          |
| Unverified                                                                                    | Key permissions could not be confirmed                                                                   |
| Rate limit / did not answer in time / could not reach / could not be read / reported an error | Binance 429 or 418 (refresh pauses for `Retry-After`), timeout, network, malformed response, other error |

Answers are applied in request order, and a snapshot is never replaced by one Binance produced
earlier, so overlapping refreshes cannot move the view backwards.

## Binance documentation used

Read on 2026-11-10.

- [Request security](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security):
  HMAC-SHA256 over the query string, `X-MBX-APIKEY` header, `timestamp`, `recvWindow` (default 5000 ms,
  maximum 60000; a timestamp more than 1 s ahead of the server is rejected).
- [Account endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints):
  `GET /api/v3/account`, weight 20, `omitZeroBalances`.
- [General endpoints](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-endpoints):
  `GET /api/v3/time`, weight 1.
- [Limits](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits): limits are per
  IP; 429 and 418 carry `Retry-After` in seconds; the client must back off.
- [Get API Key Permission](https://developers.binance.com/docs/wallet/account/api-key-permission):
  `GET /sapi/v1/account/apiRestrictions`, weight 1.

How they are applied (`supabase/functions/binance-spot-account/handler.ts`):

- Each signed request is stamped with Binance's own clock (from `/api/v3/time`) plus the time elapsed
  since that answer, so local clock skew does not matter and the stamp is never ahead of Binance.
  `recvWindow` is fixed at 5000 ms and never widened. A rejected timestamp is reported, not retried.
- One refresh costs weight 22 against a per-IP limit in the thousands per minute. Nothing retries
  automatically. After a 429 or 418 the view disables refresh for the time Binance names (60 s if
  it names none).
- Each request has a 4 s timeout; redirects are refused.

## Owner setup

Not done yet: no credential is configured anywhere and the function is not deployed. Until then the
Account zone shows nothing new. Do these yourself; never paste a key or secret into a chat, issue,
commit or screenshot.

1. In Binance, create an API key with **Enable Reading** only. Leave trading, margin, futures,
   withdrawals, internal transfer and universal transfer off. Supabase edge functions have no fixed
   egress IP, so the key cannot be IP-restricted with this setup.
2. Find your Popup user ID in the Supabase dashboard under Authentication → Users.
3. Set the function secrets the same way `TV_WEBHOOK_SECRET` is set: in the Supabase dashboard
   (Edge Functions → Secrets), or from a file kept outside the repository:

   ```bash
   supabase secrets set --project-ref <project-ref> --env-file /path/outside/repo/binance.env
   ```

   | Secret                          | Value                                    |
   | ------------------------------- | ---------------------------------------- |
   | `BINANCE_SPOT_OWNER_USER_ID`    | Your Popup user ID                       |
   | `BINANCE_SPOT_API_KEY`          | The read-only key                        |
   | `BINANCE_SPOT_API_SECRET`       | Its secret                               |
   | `BINANCE_SPOT_READONLY_ENABLED` | `true` (anything else disables the view) |

4. Deploy the function: `supabase functions deploy binance-spot-account --project-ref <project-ref>`.
5. Sign in to Popup as that user and open **Account**.

To turn it off, unset `BINANCE_SPOT_READONLY_ENABLED` (the owner sees **Not configured**) or
`BINANCE_SPOT_OWNER_USER_ID` (nobody sees anything), and delete the key in Binance.

## Verification

Covered with synthetic responses and fake credentials in
`src/test/binanceSpotAccountHandler.test.ts` and `src/test/binanceSpotBalances.test.tsx`.

**Not run:** a read against the real Binance API. No Binance credential is configured for this
project. Two things only a live read can show: that the deployed function's region is allowed to
reach `api.binance.com` for signed requests (a blocked region shows as "Binance reported an
error"), and that Binance still returns key permissions in the documented shape.
