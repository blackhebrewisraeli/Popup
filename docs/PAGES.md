# Popup product page

The standalone product overview lives in [`site/`](site/). It complements the hosted application;
it does not replace the TanStack workspace or host the research tooling.

## Deployment

On 13 November 2026, the repository's Pages source was set to **GitHub Actions**.
The page is not live until the workflow below is merged and its first deployment succeeds.

1. Merge the product-page pull request after its checks pass.
2. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
3. The [Popup product page workflow](../.github/workflows/pages.yml) deploys on changes to
   `docs/site/**` or its workflow on `main`. If the first push happened before Pages was configured,
   run it manually from **Actions → Popup product page → Run workflow** on `main`.
4. Open the URL reported by the deployment job and check its navigation and mobile layout.

The expected project URL is `https://blackhebrewisraeli.github.io/Popup/`. Do not advertise that URL
as live until the first deployment succeeds. After verification, it can be added to the README's
navigation and used as the repository Website if a product overview is preferable to the app.

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

## Editing

- `site/index.html`: product copy, semantic structure, links, and metadata.
- `site/styles.css`: scoped theme tokens and responsive layout.
- `site/favicon.svg`: the existing Popup mark, copied from `public/favicon.svg`.
- `branding/popup-banner.svg`: repository README banner, not part of the Pages artifact.

Keep public copy aligned with [product status](PRODUCT_STATUS.md). All workflow illustrations must
stay visibly labeled; do not invent prices, model results, performance statistics, or screenshots.
