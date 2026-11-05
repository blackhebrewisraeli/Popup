# TradingView notification meaning and secure setup

Status: production attribution support is deployed. Owner credential rotation and TradingView
alert recreation remain pending; no active alert or credential is changed by this runbook.

Popup treats TradingView alerts as technical market events. They are information for the user,
not trade instructions. Receiving an event never places an order. The existing Action Center can
book a separate, explicit paper-trading simulation only after the user reviews and confirms it.

## Sanitized diagnosis of the score-69 SELL

Only allowlisted metadata was used. Raw messages, complete request bodies, webhook URLs and
credentials are intentionally omitted.

| Classification | Finding                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VERIFIED       | TradingView's saved hourly indicator snapshot used model `1.0.0` with the condition **Any alert() function call**.                                                                                                                               |
| VERIFIED       | The chart symbol was `BINANCE:BTCUSDT`; the stored ticker was `BTCUSDT`. Neither contains a hyphen. `BTC-USD` is an app-side display/asset normalization, not the alert ticker.                                                                  |
| VERIFIED       | The stored event was `SELL`, score `69`, timeframe `60`, bar time `2026-10-25 09:00:00 UTC`, model `1.0.0`, received `2026-10-25 10:00:07.676552 UTC`, status `PENDING`.                                                                         |
| VERIFIED       | A matching row exists in `trading_signals`, so the webhook authenticated and committed the event. `PENDING` is the app decision state, not TradingView's transport status.                                                                       |
| VERIFIED       | In the saved script, a dynamic SELL alert could fire for a risk-setup transition, an ATR trailing-stop breach, or both. The score is reported context; it does not select the event reason.                                                      |
| INFERRED       | Score `69` rules out the low-score (`score <= 28`) branch on that bar. If the risk-setup transition fired, high volatility was its cause.                                                                                                        |
| UNKNOWN        | The legacy payload did not record whether the event was a high-volatility risk transition, an ATR trailing-stop breach, or both. Do not infer one from the score or reconstruct it from newly fetched candles.                                   |
| UNKNOWN        | TradingView's provider-side webhook-status cell was not retrieved because the available history response also exposes the raw alert message. The committed database row is the safe evidence that this delivery reached and was stored by Popup. |

New alert payloads carry trigger-attribution schema `1` and preserve every reason that is true on
the firing bar:

- `long_setup_transition`
- `low_score_risk_transition`
- `high_volatility_risk_transition`
- `atr_trailing_stop_breach`

The three named legacy `alertcondition()` choices also identify their own condition. Events created
before this change show **Trigger reason not recorded**. They are never assigned a guessed reason.

## Why phone and webhook notifications must be separate

TradingView gives an alert one generated message and a set of notification actions. Its webhook
documentation says the alert message becomes the HTTP POST body, while its alert setup
documentation lists phone notification and webhook URL as actions on that alert. For Pine
`alert()` alerts, TradingView says the script controls the message. There is no documented
per-action message or custom-header facility.

Therefore, an alert with both **Notify in App** and **Webhook URL** enabled sends the same
script-generated content to both destinations. Popup cannot redact a phone notification after
TradingView has already generated it.

Use two saved alert snapshots from the same indicator instead:

1. **Machine alert** — indicator setting **Alert output: Machine JSON**; condition **Any alert()
   function call**; **Webhook URL on**; **Notify in App, pop-up, email and plain text off**.
2. **Human alert** — indicator setting **Alert output: Human readable**; condition **Any alert()
   function call**; **Notify in App on**; **Webhook URL off**. Other human notification actions are
   optional.

The indicator thresholds and bar-close firing rules are identical in both modes. Only formatting
changes. Each alert saves a snapshot of the script, chart context and inputs, so create or recreate
both after installing this version. Use the daily (`1D`) chart for `1.0.0-pw200`.

Current official references:

- [How to set up alerts](https://www.tradingview.com/support/solutions/43000595315-how-to-set-up-alerts/)
- [Alerts on `alert()` function](https://www.tradingview.com/support/solutions/43000597494-alerts-on-alert-function/)
- [How to configure webhook alerts](https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/)
- [Pine Script alert FAQ](https://www.tradingview.com/pine-script-docs/faq/alerts/)

## Owner-only credential rotation

The exposed webhook credential remains valid until the owner completes these steps. Remediation is
**pending**. Do not paste the old or replacement credential into chat, an issue, a PR, a screenshot
or a support ticket.

1. In TradingView, inventory every Popup or legacy ZeroChart alert with **Webhook URL** enabled.
   The read-only inventory on 2026-11-05 contained active legacy **ZC Quant** hourly (`60`) and
   **ZC Quant pw200** daily (`1D`) snapshots for `BINANCE:BTCUSDT`, plus one inactive hourly
   snapshot. The active hourly snapshot was verified to have both webhook and phone delivery
   enabled. Record only alert names, symbol, timeframe and enabled actions—not messages or webhook
   URLs.
2. In Popup, sign in, open **TradingView Indicator**, and choose **Generate a new webhook
   token** exactly once. The existing `rotate_signal_webhook_token()` RPC replaces the stored
   SHA-256 digest, returns the new plaintext once, and immediately invalidates the old credential.
   A short delivery gap is expected while alerts are recreated.
3. Copy or download the newly generated Pine source locally. Keep it in the Pine editor or another
   owner-controlled secret store; do not commit it. The repository source contains only
   `USER_SECRET_PLACEHOLDER`.
4. Add the updated script to the intended chart. Set the chart to `1D` for `1.0.0-pw200` and keep
   the existing capital, risk, ATR and stop inputs unchanged.
5. Recreate each wanted machine alert using **Machine JSON** and the machine-only actions above.
   Use a clear name such as **Popup Machine · BTCUSDT · 1D**. Paste the normal Popup Edge Function
   endpoint into TradingView's **Webhook URL** field. Do not put the credential in the URL and do
   not attempt custom headers; TradingView documents neither custom webhook headers nor separate
   per-action bodies for this alert flow.
6. Recreate the separate phone alert using **Human readable** and the human-only actions above.
   Use a clear name such as **Popup Phone · BTCUSDT · 1D** and confirm **Webhook URL is off** before
   saving it.
7. Disable or delete superseded alert snapshots that contain the old credential. Do not resume the
   inactive hourly snapshot unless it has been recreated from the rotated source.
8. Verify through the next naturally occurring event or an owner-controlled TradingView alert test.
   Check only the Alert Log's webhook-status column and Popup's sanitized signal metadata. Do
   not send a live test signal as part of this coding PR, and do not copy the message or request
   body into diagnostics.

Rotation does not require removing authentication, putting a public identifier in the payload, or
changing the Edge Function's execution contract. Active-alert remediation remains an owner action
after this PR.
