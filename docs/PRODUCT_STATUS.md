# Popup product status

Popup is a private workspace for reviewing Binance Spot USDT pairs and recording the owner's
manual decisions. The configured owner has two places to work.

| Place    | What you can do                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research | Start with the dated liquidity shortlist. Open the exact pair's intraday chart on TradingView. Use the daily model scan for context or open a saved TradingView crypto scan to inspect reproduced evidence. |
| Journal  | Read Binance Spot balances and executions, reconcile holdings where history allows, and review recorded trades and decisions to stay out.                                                                   |

The daily batch orders eligible pairs by rolling 24-hour quote volume. The daily model uses
closed 1D candles. In a successfully reproduced saved crypto scan, the owner can record a
no-entry decision or a manual Spot experiment for an eligible pair. The owner places any actual
trade by hand at Binance and can link its fills, state exit rules, add observations, and close the
journal entry. The Binance connection has read-only credentials.

The former generic Markets directory, simulated trading and portfolio views, tracked holdings,
and public portfolio pages have been removed from the application. Existing database records,
schema migration history, saved scans and historical research are retained.

The workspace is ready for a usability trial after release. Prior research has not established
positive net returns for the tested rules. The intraday chart is a review tool, and a model score
has no calibrated interpretation as probability of profit.

- [Daily candidates and market scanner](MARKET_SCANNER.md)
- [Manual Spot experiments](MANUAL_SPOT_EXPERIMENTS.md)
- [Binance Spot account and executions](BINANCE_SPOT_ACCOUNT.md)
- [Scanner research](SCANNER_RESEARCH.md)
