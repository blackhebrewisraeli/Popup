<div align="center">

<img src="docs/branding/popup-banner.svg" alt="Popup — daily candidates, model evidence and manual Spot records" width="100%" />

# Popup

**Understand the signal. Inspect the evidence. Record the decision.**

A research prototype for reviewing a dated daily shortlist of liquid Binance Spot pairs,
inspecting daily-candle model scans, and recording trades placed by hand.

[![CI](https://img.shields.io/github/actions/workflow/status/blackhebrewisraeli/Popup/ci.yml?branch=main&label=CI)](https://github.com/blackhebrewisraeli/Popup/actions/workflows/ci.yml)
[![Stage: private testing](https://img.shields.io/badge/stage-private_testing-ff7a5c)](docs/PRODUCT_STATUS.md)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[**Open the app ↗**](https://popup-signals.vercel.app) (popup-signals.vercel.app) · [Product page](https://blackhebrewisraeli.github.io/Popup/) (overview only) · [Screenshots](#screenshots) · [Product status](docs/PRODUCT_STATUS.md) · [Getting started](#getting-started) · [Documentation](#documentation)

</div>

> [!NOTE]
> **Private testing / pre-beta.** Popup places no orders. The owner trades on Binance by hand,
> and Popup's owner-only Binance Spot connection is read-only. Paper Desk and Build Portfolio are
> paused; their simulated records stay readable. The daily candidate rank is a liquidity ranking,
> not a model score or a prediction. Investment performance has not been established.

## What Popup does today

The workspace has two tabs, **Research** and **Account**, plus a read-only Simulation history.

| Research                                                                                                                                                                                                                              | Account                                                                                                                                                                                   | Simulation history (paused)                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Opens on **Daily candidates**: a dated, owner-only shortlist of Binance Spot USDT pairs ranked by 24-hour quote volume. Then **Model scan (1D)**, with the evidence behind each score and Risk warning, and the **Markets directory** | Read-only Binance Spot balances, executions and reconciliation, with **Manual Spot experiments**: owner records of real trades placed by hand. Holdings tracked by hand follow separately | Paper Desk and Build Portfolio are paused. Read and export the earlier simulated ledgers and the Decision Journal; nothing new can be booked |

### A typical workflow

1. **Check the daily candidates.** Read the batch date, coverage, and exclusions. The rank orders
   pairs by 24-hour quote volume only: it is a place to start looking, not a score or a BUY signal.
2. **Inspect the model evidence.** In Model scan (1D), check a scan's source and closed-candle
   coverage, then its RSI, MACD, and ATR factors, market regime, and the specific Risk clauses.
3. **Compare the evidence.** Use a compatible earlier snapshot to distinguish observed changes.
4. **Record your own decision.** A trade you place on Binance yourself can be recorded as a Manual
   Spot experiment: its source scan, rules, linked fills, observations, and close. Popup verifies
   no holding and evaluates no rule.

**Availability matters:** the daily batch is collected once a day by a scheduled Supabase Edge
Function, with no browser or agent session. TradingView development scans are local and
owner-initiated through an authenticated agent; they are not an unattended scanner in the hosted
app. Binance live market data, TradingView alerts, and the read-only account connection are
separate flows.

## Screenshots

Captured from the running application. It shows only the app's built-in synthetic data
([how it was made](docs/PAGES.md#readme-screenshots)).

![Popup's example scan: five synthetic assets, DEMO1 to DEMO5, ranked with score, setup and reason, beside the evidence for DEMO5: score 80, mean-reverting regime, and which Long and Risk conditions are met or not met](docs/screenshots/research-example-scan.png)

**Model scan: each result beside its evidence.** The signed-out page's built-in example, labeled
_Illustrative_: made-up readings for five made-up assets, scored by Popup's own model and setup
rules. The selected result shows why a score of 80 still meets no setup. No market data.

Daily candidates and Account have no labeled synthetic mode. Filling them with made-up pairs,
balances, or trades would misrepresent real records, so they are not pictured.

## Engineering highlights

- **Explainable model:** a canonical TypeScript scoring engine with factor contributions and explicit insufficient-data states; a Pine Script HUD with a documented comparison contract.
- **Reproducible research:** versioned candle contracts, captured scan inputs, and offline reproduction before reviewing saved scans.
- **Dated discovery:** a protected Edge Function stores one Binance Spot batch a day with its policy, coverage, and exclusions; the board reads stored batches.
- **Atomic accounting:** isolated ledgers for tracked holdings and the paused simulations, FIFO lots, and fee-aware realized P&L.
- **Responsive compute:** indicator and backtest calculations run in a Web Worker; market updates subscribe by symbol.
- **Scoped access:** Supabase Auth and row-level security; authenticated TradingView ingestion; owner-only Binance reads.
- **Quality checks:** CI runs typecheck, build, lint, tests with coverage, and independent fixture reproduction.

[Technical feature guide](docs/WORKSPACE_GUIDE.md) · [Architecture and file map](ARCHITECTURE.md)

## Tech stack

| Layer              | Tools                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Application        | React 19, TypeScript, TanStack Start / Router / Query, Vite                                       |
| Interface          | Tailwind CSS v4, shadcn/ui, Radix, Framer Motion                                                  |
| Charts and compute | lightweight-charts, Recharts, Web Workers                                                         |
| Backend            | Supabase Postgres, Auth, row-level security, Realtime, Edge Functions                             |
| Integrations       | TradingView Pine Script v6 and webhooks; separate Binance market-data and read-only account paths |
| Verification       | Vitest, Testing Library, ESLint, Prettier, GitHub Actions                                         |

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (or [Bun](https://bun.sh/))
- A [Supabase](https://supabase.com/) project

### 1. Clone and install

```bash
git clone https://github.com/blackhebrewisraeli/Popup.git
cd Popup
npm ci --ignore-scripts
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Then fill in the two values from **Supabase → Project Settings → API**:

```env
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
# Publishable key (sb_publishable_...); a legacy anon key also works
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

> [!WARNING]
> Only the publishable (anon) key belongs in the frontend. Never put a service-role or secret key in `.env.local`.

### 3. Set up the database

`supabase/migrations` is the only source of the schema. Link the Supabase CLI and push every migration:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

Finally, make sure **Email** is enabled under **Authentication → Providers**.

### 4. Run the dev server

```bash
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

### 5. Optional: connect TradingView

1. Deploy the webhook (JWT verification is already turned off for it in [`supabase/config.toml`](./supabase/config.toml)):

   ```bash
   npx supabase functions deploy tv-webhook
   ```

2. In the app, open any asset and click **TradingView Indicator**, then click **Generate webhook token**. Copy the Pine Script after that: your token replaces `USER_SECRET_PLACEHOLDER` in its alert payloads.
3. Follow [TradingView notification meaning and secure setup](./docs/TRADINGVIEW_NOTIFICATIONS.md) to create separate machine and phone alerts. The machine alert uses **Machine JSON**, **Any alert() function call**, and the webhook only; the phone alert uses **Human readable** and has no webhook. Alerts are recorded only: executing them is paused with the Paper Desk.

### Scripts

| Command              | Purpose                            |
| -------------------- | ---------------------------------- |
| `npm run dev`        | Start the dev server on port 8080  |
| `npm run build`      | Production build                   |
| `npm run preview`    | Serve the production build locally |
| `npm test`           | Run the Vitest suite once          |
| `npm run test:watch` | Run Vitest in watch mode           |
| `npm run lint`       | ESLint                             |
| `npm run format`     | Prettier                           |
| `npx tsc --noEmit`   | Typecheck                          |

## Quality gates

```bash
npm run typecheck
npm run build
npm run lint
npm test
```

[CI](.github/workflows/ci.yml) also collects coverage and reproduces the independent Python
reference fixtures. Production builds check the database contract before deployment; see
[release procedures](docs/RELEASE.md). Test results establish software behavior, not investment returns.

## Documentation

| Start here                                                                                                   | Purpose                                                                   |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [Product status](docs/PRODUCT_STATUS.md)                                                                     | Current capabilities, private-testing boundaries, and next priorities     |
| [Technical feature guide](docs/WORKSPACE_GUIDE.md)                                                           | Model, ledgers, position sizing, webhook flow, and implementation details |
| [Architecture](ARCHITECTURE.md)                                                                              | Source map and feature ownership                                          |
| [Daily discovery](docs/MARKET_SCANNER.md#daily-discovery-binance-spot-unattended)                            | How the dated daily batch is collected, ranked, and verified              |
| [Manual Spot experiments](docs/MANUAL_SPOT_EXPERIMENTS.md)                                                   | Owner records of real trades placed by hand, and what Popup checks        |
| [Market scanner](docs/MARKET_SCANNER.md) / [crypto scan](docs/TRADINGVIEW_CRYPTO_SCAN.md)                    | Local scan workflow, source attribution, comparison, and coverage         |
| [Decision Journal](docs/DECISION_JOURNAL.md)                                                                 | Signal decisions and recorded evidence, now under Simulation history      |
| [Binance Spot account](docs/BINANCE_SPOT_ACCOUNT.md) / [reconciliation](docs/BINANCE_SPOT_RECONCILIATION.md) | Owner-only read access and finite-history limits                          |
| [Scanner research](docs/SCANNER_RESEARCH.md) / [model diagnostic](docs/MODEL_DIAGNOSTIC.md)                  | Findings, limitations, and the meaning of model conditions                |
| [Pine comparison contract](docs/PINE_PARITY_ASSESSMENT.md)                                                   | Supported comparison between app scores and Pine HUD                      |
| [TradingView setup](docs/TRADINGVIEW_NOTIFICATIONS.md)                                                       | Phone and webhook alerts, provenance, and secure setup                    |
| [Strategy validation](docs/STRATEGY_VALIDATION.md)                                                           | Private decision replay and observation contracts                         |
| [Releases](docs/RELEASE.md) / [contributing](CONTRIBUTING.md)                                                | Development checks, migrations, and review process                        |
| [Product page](docs/PAGES.md)                                                                                | Published overview page, README screenshots, and Social Preview assets    |

## Contributing and feedback

Use [GitHub Issues](https://github.com/blackhebrewisraeli/Popup/issues) for reproducible bugs or
focused feature proposals. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Keep account balances, credentials, and private research artifacts out of public reports.

Built and maintained by [Shimon Esterkin](https://github.com/blackhebrewisraeli).
Released under the [MIT License](LICENSE). Previously named **ZeroChart**; legacy identifiers
remain where compatibility or historical evidence requires them.
