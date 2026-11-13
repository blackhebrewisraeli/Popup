# Popup product status

[← README](../README.md) · [Architecture](../ARCHITECTURE.md) · [Technical guide](WORKSPACE_GUIDE.md)

**Stage: private testing / pre-beta.** This page describes the supported scope as of 13 November 2026; it is not a release announcement or an investment-performance claim.

## Available today

| Surface          | Capability                                                                                                     | Boundary                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Research         | Review bounded equity/ETF and crypto scans, compare compatible snapshots, and inspect factor and Risk evidence | TradingView development scans are local and owner-initiated through an authenticated agent; not an unattended hosted scanner |
| Paper Desk       | Size hypothetical allocations, backtest, and record simulated trades with cash and transaction ledgers         | Paper trades are simulated; planned stops are sizing assumptions, not stop orders                                            |
| TradingView HUD  | Pine Script overlay with factor scores and alerts, ingested through an authenticated webhook                   | Model/timeframe compatibility is checked separately from successful transport                                                |
| Decision Journal | Review recorded signal decisions, provenance, and dismissal evidence                                           | A decision record does not prove an investment outcome                                                                       |
| Account          | Owner-only read-only Binance Spot balances, bounded execution history, and manual quantity reconciliation      | No orders or transfers; incomplete history is not a complete account ledger                                                  |

The hosted app and the local research tooling have different capabilities. Opening the hosted app does not provide access to the owner's scans, account, credentials, or private research artifacts.

## What the evidence establishes

Functional checks cover deterministic scoring, accounting invariants, authentication boundaries, scan reproduction, and finite-history reconciliation. See the [agent journal](AGENT_JOURNAL.md) for dated checks and their limits.

Investment results remain unproven. The [scanner research](SCANNER_RESEARCH.md) reports mixed crypto findings and does not establish a predictive advantage. A model score is a ranking, not a probability of profit; a working integration does not validate a strategy.

## Current priorities

1. Complete the owner's private workflow trial and resolve friction observed in actual use.
2. Verify read-only account evidence against known executions within explicitly bounded ranges.
3. Evaluate strategy outcomes under frozen research contracts before considering a separate small-capital pilot.

Public beta, automated order execution, new providers, and expanded campaigns remain outside the current phase. These are scope boundaries, not dated release commitments.

## Read further

- [Market scanner](MARKET_SCANNER.md) and [crypto scan](TRADINGVIEW_CRYPTO_SCAN.md)
- [Binance Spot account](BINANCE_SPOT_ACCOUNT.md) and [reconciliation](BINANCE_SPOT_RECONCILIATION.md)
- [Decision Journal](DECISION_JOURNAL.md)
- [Model diagnostic](MODEL_DIAGNOSTIC.md) and [strategy validation](STRATEGY_VALIDATION.md)
- [Earlier engineering roadmap](hybrid-roadmap.md) and [historical launch checklist](roadmap.md)

## Name and compatibility

Popup was previously named ZeroChart. Some Pine filenames, workflow names, storage identifiers, and historical documents retain that name for compatibility or provenance. The product and canonical repository are **Popup** and `blackhebrewisraeli/Popup`.
