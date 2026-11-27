# Architecture

Popup is a TanStack Start app with a Supabase backend. Supabase Auth provides the browser
session. The workspace layout checks the configured owner through `is_binance_spot_owner`
before it renders either signed-in page. Supabase row-level security and Edge Function checks
also enforce access at the data boundary.

| Entry point            | UI                                                       | Data                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` → Daily candidates | `src/components/DailyCandidates.tsx`                     | Verifies the latest stored Binance Spot liquidity batch before showing it. The scheduled collector and its evidence contract live in `supabase/functions/daily-discovery` and `src/lib/dailyDiscovery.ts`. |
| `/` → Model scan (1D)  | `src/components/MarketScanSummary.tsx`, `ScanReview.tsx` | Uses the crypto tickers configured in `assets_status` and evaluates closed Binance daily candles with `marketScanner.ts` and `canonicalModel.ts`.                                                          |
| Open saved crypto scan | `src/components/SavedScanFile.tsx`                       | Hashes and reproduces the selected snapshot in the browser worker. The file stays in memory. Verified evidence can be attached to owner decisions.                                                         |
| `/account` → Journal   | `src/components/AccountPanel.tsx`, `SpotExperiments.tsx` | Uses the read-only `binance-spot-account` function for Binance reads. Supabase owns the manual experiment records, linked fills, observations and no-entry decisions.                                      |
| Telegram (no UI)       | `supabase/functions/futures-execution`                   | Owner-approved live USDⓈ-M Futures Longs at 5× isolated, off by default and gated on an approved entry rule. See [Futures execution](docs/FUTURES_EXECUTION.md).                                           |

The route layout is `src/routes/_workspace.tsx`. The file-based router generates
`src/routeTree.gen.ts`. The two pages share a private shell with navigation, theme and sign-out.
Direct links to `/account#spot-experiments` still focus the journal section.

Research scripts and historical evaluation contracts live in `scripts/` and `docs/`. They
remain available for offline reproduction. The removed portfolio views and simulation routes
have no UI entry point. Existing database records and migrations remain in place.

## Development

- Keep model and candle validation code pure. The worker wrapper in `src/lib/financeClient.ts`
  keeps scan computation off the main thread.
- Add schema changes as new migrations. See [release procedures](docs/RELEASE.md).
- Retain source identity and freshness with recorded decisions. See
  [manual Spot experiments](docs/MANUAL_SPOT_EXPERIMENTS.md).
- CI runs TypeScript checks, eslint, builds, Vitest, independent Python checks and Supabase SQL
  tests from `.github/workflows/ci.yml`.
