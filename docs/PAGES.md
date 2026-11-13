# Popup product page

The standalone product overview lives in [`site/`](site/) and is published at
<https://blackhebrewisraeli.github.io/Popup/>. It complements the hosted application; it does not
replace the TanStack workspace or host the research tooling.

## Deployment

**Live since 13 November 2026.** The first deployment ran from the #167 merge (`cba3d86`) in
workflow run [43449416349](https://github.com/blackhebrewisraeli/Popup/actions/runs/43449416349).
The served `index.html` and `styles.css` matched `docs/site` on `main` byte for byte.

- Pages source: **GitHub Actions** (**Settings → Pages → Build and deployment**).
- The [Popup product page workflow](../.github/workflows/pages.yml) deploys on pushes to `main`
  that change `docs/site/**` or the workflow. To redeploy without a change, run
  **Actions → Popup product page → Run workflow** on `main`.
- After each deployment, check the published page as described in [Preview](#preview).

The README links the page as **Product overview** and keeps a separate **Hosted app** link. The
repository Website field still points to the hosted app; changing it is an owner decision.

Only `docs/site` is uploaded. The workflow does not publish the rest of `docs`, raw market data,
research stores, account data, or application environment variables. It installs no dependencies
and runs no application build. No custom domain, analytics, campaign, or trading integration is added.

## Preview

From the repository root:

```bash
python3 -m http.server 4173 --directory docs/site
```

Open `http://localhost:4173`. Check desktop and 375 px widths, keyboard navigation, the skip link,
and both light and dark system themes. The page has no JavaScript or external font dependency.

## README screenshots

[`screenshots/`](screenshots/) holds the two product images in the README. Both are captures of
the real application from a local development build of `main` at `cba3d86`: dark theme, 1280 px
viewport at 2× scale, cropped only.

| File                          | View                                   | Data shown                                                                                                                                                       |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research-example-scan.png`   | The signed-out page's **Example scan** | The app's built-in synthetic readings (`DEMO1`–`DEMO5` in `LandingPage.tsx`), labeled _Illustrative_ and _Synthetic_ in the interface                            |
| `paper-desk-order-ticket.png` | Paper Desk with the order ticket open  | The dev-only `?devAuth=1` preview user, the app's own **Sample data** mode, a fresh paper account, and $2,500 typed into the ticket. The order was not submitted |

**Isolation.** The dev server ran with its Supabase URL pointed at an unused local port. The
capture browser answered its database reads with empty lists, which is what puts the app in Sample
data mode, and blocked Binance, TradingView, and analytics requests. Nothing reached production. No
account, credential, balance, execution history, or scan artifact was involved.

**Limitations.**

- The signed-in Research scan needs market candles from Binance or a private TradingView import.
  Neither is synthetic, so the README shows the built-in example. It uses the same model, setup
  rules, and condition list as Research.
- A populated paper ledger needs fills that the server accepts against fresh `assets_status`
  quotes. The isolated preview has none, so the image shows an unsubmitted order. With market data
  blocked, the Paper Desk chart has no candles; the crop ends above it.

Replace an image only with a new capture made the same way. Never edit the figures in it.

## GitHub Social Preview

[`branding/popup-social-preview.png`](branding/popup-social-preview.png) is the 1280 × 640
repository card. Its editable source is
[`branding/popup-social-preview.svg`](branding/popup-social-preview.svg): the existing Popup mark,
coral identity, and Arial/Helvetica text.

To publish it, the owner opens **Settings → General → Social preview → Edit → Upload an image…**
and uploads `docs/branding/popup-social-preview.png`. To change the copy, edit the SVG and render
it in a browser at exactly 1280 × 640 to the same PNG path.

## Editing

- `site/index.html`: product copy, semantic structure, links, and metadata.
- `site/styles.css`: scoped theme tokens and responsive layout.
- `site/favicon.svg`: the existing Popup mark, copied from `public/favicon.svg`.
- `branding/popup-banner.svg`: repository README banner, not part of the Pages artifact.
- `branding/popup-social-preview.svg` and `.png`: GitHub Social Preview source and upload file.
- `screenshots/*.png`: README product images, documented above.

Keep public copy aligned with [product status](PRODUCT_STATUS.md). All workflow illustrations must
stay visibly labeled; do not invent prices, model results, performance statistics, or screenshots.
