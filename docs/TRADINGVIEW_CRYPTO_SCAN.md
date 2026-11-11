# TradingView crypto scan (local, owner-initiated)

The [TradingView development scan](MARKET_SCANNER.md#tradingview-development-scan-local-owner-initiated)
extended to a bounded crypto universe: Binance Spot USDT pairs, scored by the same scanner and
canonical model `1.0.0` on daily bars the owner's agent session retrieves through TradingView's
MCP server. TradingView is the **data source**; Binance Spot is the **venue** where these pairs
trade and where the owner may, independently, choose to act. Popup reads no Binance candles for
this scan, holds no exchange credential for it and places no orders.

This is a bounded initial research universe, not a scan of the crypto market.

## Universe `crypto-usdt-v1`

Frozen on 2026-11-11, before any candle was retrieved or any score computed. Committed in
`CRYPTO_TRADINGVIEW_SYMBOLS` (`scripts/tradingViewImport.ts`). A different membership is a new
universe ID, never an edit to this one.

### Membership rule

1. **Candidates, in order.** TradingView's coin ranking: `run_screener` with market `coin`, every
   coin with `market_cap_calc` ≥ 1, sorted by `market_cap_calc` descending, retrieved at about
   18:29 UTC. The rule uses the order only; no capitalization, price or return is recorded here.
   Two runs minutes apart gave the same order through every candidate below.
2. **Walk the order and pass over:**
   - **Stablecoins**: TradingView category `stablecoins`; or, where TradingView records no
     category, a token named as a US-dollar unit (RWUSD). Quoted in USDT, each would be a
     stablecoin-to-stablecoin pair.
   - **Duplicate exposure**: TradingView category `wrapped-tokens` or `rehypothecated-crypto`
     (wrapped, bridged, liquid-staking and restaking receipts of another coin, such as WBTC or
     stETH).
   - **Tokenized commodities**: tokens redeemable for a physical commodity (XAUT, gold).
   - **Leveraged tokens** (`UP`/`DOWN`/`BULL`/`BEAR`, `3L`/`3S`): none was encountered.
   - **No Binance Spot USDT pair**: `search_symbols` for `<BASE>USDT` with type `crypto` did not
     return a row whose symbol is exactly `BINANCE:<BASE>USDT`, exchange `Binance`, type `spot`.
     A perpetual (`BINANCE:<BASE>USDT.P`), its mark, index or premium series, Binance.US
     (`BINANCEUS:`) and other exchanges never count. The search returns at most 10 rows, so
     "unresolved" means TradingView did not offer the listing, not proof that none exists.
3. **Take the first 25** candidates that pass. Base tickers are TradingView's `base_currency`.

The rule does not depend on a model score, a setup or later prices. Market capitalization at the
freeze reflects earlier prices, as any size rule does. The existing Binance account-history
allowlist was not used.

### Resolution evidence

Members, in walk order (rank in the candidate list, then the exact symbol and TradingView's own
description of it, from `search_symbols`):

| #   | Ticker    | Exact symbol       | Description                 |
| --- | --------- | ------------------ | --------------------------- |
| 1   | BTC-USDT  | `BINANCE:BTCUSDT`  | Bitcoin / TetherUS          |
| 2   | ETH-USDT  | `BINANCE:ETHUSDT`  | Ethereum / TetherUS         |
| 4   | BNB-USDT  | `BINANCE:BNBUSDT`  | Binance Coin / TetherUS     |
| 6   | XRP-USDT  | `BINANCE:XRPUSDT`  | XRP / TetherUS              |
| 7   | SOL-USDT  | `BINANCE:SOLUSDT`  | SOL / TetherUS              |
| 8   | TRX-USDT  | `BINANCE:TRXUSDT`  | TRON / TetherUS             |
| 10  | HYPE-USDT | `BINANCE:HYPEUSDT` | HYPE / TetherUS             |
| 11  | ZEC-USDT  | `BINANCE:ZECUSDT`  | Zcash / TetherUS            |
| 13  | DOGE-USDT | `BINANCE:DOGEUSDT` | Dogecoin / TetherUS         |
| 19  | LINK-USDT | `BINANCE:LINKUSDT` | ChainLink / TetherUS        |
| 22  | ADA-USDT  | `BINANCE:ADAUSDT`  | Cardano / TetherUS          |
| 24  | XLM-USDT  | `BINANCE:XLMUSDT`  | Stellar / TetherUS          |
| 26  | NEAR-USDT | `BINANCE:NEARUSDT` | NEAR / TetherUS             |
| 27  | BCH-USDT  | `BINANCE:BCHUSDT`  | Bitcoin Cash / TetherUS     |
| 30  | UNI-USDT  | `BINANCE:UNIUSDT`  | UNI / TetherUS              |
| 33  | LTC-USDT  | `BINANCE:LTCUSDT`  | Litecoin / TetherUS         |
| 34  | AVAX-USDT | `BINANCE:AVAXUSDT` | AVAX / TetherUS             |
| 37  | SUI-USDT  | `BINANCE:SUIUSDT`  | SUI / TetherUS              |
| 38  | GRAM-USDT | `BINANCE:GRAMUSDT` | GRAM / TetherUS             |
| 42  | HBAR-USDT | `BINANCE:HBARUSDT` | Hedera Hashgraph / TetherUS |
| 48  | SHIB-USDT | `BINANCE:SHIBUSDT` | SHIB / TetherUS             |
| 49  | TAO-USDT  | `BINANCE:TAOUSDT`  | TAO / TetherUS              |
| 53  | QNT-USDT  | `BINANCE:QNTUSDT`  | QNT / TetherUS              |
| 55  | ENA-USDT  | `BINANCE:ENAUSDT`  | ENA / TetherUS              |
| 56  | PEPE-USDT | `BINANCE:PEPEUSDT` | PEPE / TetherUS             |

GRAM is TradingView's name for the coin formerly called Toncoin ("Gram (prev. Toncoin)").

Passed over (31 of the first 56 candidates):

| Reason                          | Candidates (#)                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stablecoin (13)                 | USDT (3), USDC (5), USDS (16), USDE (25), DAI (29), USDT0 (31), RWUSD (32, no category; `BINANCE:RWUSDUSDT` exists), USD1 (39), PYUSD (44), USDG (46), RLUSD (47), AETHUSDT (50), USDY (52) |
| Duplicate exposure (7)          | STETH (9), WSTETH (14), WBTC (15), WBETH (18), CBBTC (20), WETH (21), WEETH (28)                                                                                                            |
| Tokenized commodity (1)         | XAUT (41; `BINANCE:XAUTUSDT` exists)                                                                                                                                                        |
| Unresolved on Binance Spot (10) | XMR (12; Binance rows were only `XMRUSDT.P` mark, index and premium), LEO (17), WBT (23), RYO (35), CC (36), BTW (40; only `BTWUSDT.P` mark), ZETRIX (43), RAIN (45), CRO (51), OKB (54)    |

The walk stopped at candidate 56. No unresolved or passed-over candidate is replaced later, after
any score has been seen.
