# Popup product status

[← README](../README.md) · [Architecture](../ARCHITECTURE.md) · [Technical guide](WORKSPACE_GUIDE.md)

**Stage: private testing / pre-beta.** This page describes the supported scope as of 20 November 2026; it is not a release announcement or an investment-performance claim.

The owner's private real-money trial is already underway: the owner places Binance Spot trades by hand and records them as [Manual Spot experiments](MANUAL_SPOT_EXPERIMENTS.md). Popup only reads Binance and places no orders. Paper Desk and Build Portfolio, which used simulated money, are paused: their records stay readable, and nothing new can be booked. No entry, holding, adding, reducing or exit policy is defined for the real trial beyond the rules the owner records in each experiment ([decision lifecycle](MANUAL_SPOT_EXPERIMENTS.md#decision-lifecycle-current-behavior-and-proposed-product-contract)).

## Available today

| Surface                 | Capability                                                                                                                                                      | Boundary                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daily candidates        | Research opens here: an owner-only dated shortlist from the daily Binance discovery collector; other sign-ins see an access notice                              | Discovery, not scoring: Binance Spot pairs ranked by 24-hour quote volume, never a model score, a prediction, a BUY/SELL signal or evidence of profitability ([details](MARKET_SCANNER.md)) |
| Model scan (1D)         | Research's second place: review bounded equity/ETF and crypto scans on closed daily candles, compare compatible snapshots, and inspect factor and Risk evidence | TradingView development scans are local and owner-initiated through an authenticated agent; not an unattended hosted scanner                                                                |
| Simulation history      | Paused Paper Desk and Build Portfolio: read and export the Paper Trading and Simulation ledgers, from Account                                                   | Read-only at the old `/paper-trading` address; no booking, cash, reset or allocation controls. Simulated, never real holdings                                                               |
| TradingView HUD         | Pine Script overlay with factor scores and alerts, ingested through an authenticated webhook                                                                    | Alerts are recorded only; the Action Center that executed them is paused with the Paper Desk                                                                                                |
| Decision Journal        | Review recorded signal decisions, provenance, and dismissal evidence, under Simulation history                                                                  | A decision record does not prove an investment outcome                                                                                                                                      |
| Account                 | Owner-only read-only Binance Spot balances, executions and reconciliation, with Manual Spot experiments, shown first                                            | No orders or transfers; incomplete history is not a complete account ledger                                                                                                                 |
| Manual Spot experiments | Owner-only records of real trades placed by hand: source scan, decision, rules, linked fills, observations and close                                            | Append-only; Popup verifies no holding and evaluates no rule                                                                                                                                |

Research opens on Daily candidates, then Model scan (1D), then the Markets directory (prices, alerts and broker links). The discovery batch and the model scan are separate: the batch's date says when Binance's 24-hour figures were collected and does not set the model's timeframe, and the board stays readable when market data or the model scan fails.

Account opens on that Binance Spot card. Holdings tracked by hand follow as their own section, separate from Binance balances and experiment-linked fills. Data export, the Simulation history link and TradingView webhook keys sit in one closed section at the end. Account no longer shows a subscription card or the perpetual tools.

The hosted app and the local research tooling have different capabilities. Opening the hosted app does not provide access to the owner's scans, account, credentials, or private research artifacts. The owner can open one saved TradingView crypto scan file there from their own disk; it is checked and kept in that browser tab only ([how](MARKET_SCANNER.md#opening-a-saved-crypto-scan-file)).

## What the evidence establishes

Functional checks cover deterministic scoring, accounting invariants, authentication boundaries, scan reproduction, and finite-history reconciliation. See the [agent journal](AGENT_JOURNAL.md) for dated checks and their limits.

Investment results remain unproven. The [scanner research](SCANNER_RESEARCH.md) reports mixed crypto findings and does not establish a predictive advantage. A model score is a ranking, not a probability of profit; a working integration does not validate a strategy.

## Current priorities

1. Complete the owner's private workflow trial and resolve friction observed in actual use.
2. Verify read-only account evidence against known executions within explicitly bounded ranges.
3. Evaluate strategy outcomes under frozen research contracts. The real-money manual trial is already running; owner decisions on its lifecycle come before any policy is implemented.

Public beta, automated order execution, new providers, and expanded campaigns remain outside the current phase. These are scope boundaries, not dated release commitments.

## Read further

- [Market scanner](MARKET_SCANNER.md) and [crypto scan](TRADINGVIEW_CRYPTO_SCAN.md)
- [Binance Spot account](BINANCE_SPOT_ACCOUNT.md) and [reconciliation](BINANCE_SPOT_RECONCILIATION.md)
- [Manual Spot experiments](MANUAL_SPOT_EXPERIMENTS.md)
- [Decision Journal](DECISION_JOURNAL.md)
- [Model diagnostic](MODEL_DIAGNOSTIC.md) and [strategy validation](STRATEGY_VALIDATION.md)
- [Earlier engineering roadmap](hybrid-roadmap.md) and [historical launch checklist](roadmap.md)

## Name and compatibility

Popup was previously named ZeroChart. Pine filenames, local store folders, browser storage keys, secret names, the SonarQube project key, frozen research identifiers, and historical documents retain that name for compatibility or provenance. The product and canonical repository are **Popup** and `blackhebrewisraeli/Popup`.
