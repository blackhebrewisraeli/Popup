import { createHash } from 'node:crypto';
import {
  CANONICAL_MODEL_VERSION,
  LONG_SETUP_MIN_SCORE,
  RISK_SETUP_MAX_SCORE,
} from '@/lib/canonicalModel';
import {
  SCAN_MIN_CLOSED_CANDLES,
  SCANNER_VERSION,
  TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
} from '@/lib/marketScanner';
import { TRADINGVIEW_DEV_PROVIDER_ID } from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import {
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  selectionRule,
  universeTickers,
} from './tradingViewImport';

/**
 * Retrospective study of the crypto scan (`crypto-usdt-v1`, TradingView bars of Binance Spot
 * USDT pairs) on the private export of its first retrieval. Frozen before any historical score,
 * rank, setup, volatility reading or forward price change was computed from that export;
 * docs/scanner-research-crypto.v1.json is the committed copy and docs/SCANNER_RESEARCH.md the
 * method.
 */
export const CRYPTO_RESEARCH_HORIZONS = [1, 5, 20] as const;

export const CRYPTO_RESEARCH_SPECIFICATION = {
  schemaVersion: '1',
  studyId: 'popup-scanner-retrospective-crypto-usdt-v1',
  evidenceType: 'retrospective-historical-research',
  frozenAt: '2026-11-11T20:10:00.000Z',
  frozenBefore:
    "Fixed after inspecting only the export's identity fields (symbol, interval, currency), bar counts, first and last bar dates, UTC alignment, gaps, duplicates and response metadata (notice, hint, has_more); before any historical score, rank, setup, volatility reading or forward price change was computed from it.",
  question:
    'Within crypto-usdt-v1, did higher-ranked pairs, or pairs meeting the Long setup, precede larger subsequent price changes than the same-date equal-weight mean of evaluated members, and than same-date members of similar volatility?',
  interpretation:
    "Retrospective historical research on today's provider history. Not prospective evidence, not genuinely unseen validation data, not a backtest, not simulated fills, not portfolio returns and not evidence of executable or profitable trading.",
  priorKnowledge: [
    'The canonical model, its weights and thresholds were fixed long before this universe was selected and are unchanged; the study cannot be blind to them.',
    'The aggregate of live scan 20261111T183825Z-dc217757 (23 evaluated, 0 Long setups, 20 Risk warnings on the 2026-11-10 candle) was seen before this specification; that day is an evaluation date here.',
    'The equity studies (docs/SCANNER_RESEARCH.md) did not establish a predictive advantage: higher ranks were followed by smaller changes than the same-date universe, and that was partly, not wholly, explained by volatility.',
    'Committing this specification before running it improves research discipline; it does not remove survivorship bias, historical data revisions or prior knowledge of this model.',
  ],
  data: {
    source: 'tradingview-mcp get_ohlcv, interval 1D, rows, up to 1000 bars per symbol',
    export: '20261111T183825Z.json',
    exportSha256: '8d251bbfed6089d0a10abf336a53ae895298639fa651888966c672c6227cbba4',
    retrieval: { startedAt: '2026-11-11T18:38:25.830Z', completedAt: '2026-11-11T18:39:47.666Z' },
    inputHashes: {
      rule: 'sha256(stableSerialize(instrument entry)): ticker, symbol, receivedAt and the get_ohlcv response verbatim',
      'ADA-USDT': 'c812e1eb2fedc4e750f9f9daae1b3068696765bbc39f84e587f4c439e71b372d',
      'AVAX-USDT': '395bb6b3efba6ab08b19e18bed833bf09e8ab4f1dd8876c71b6723e41d4c1791',
      'BCH-USDT': '23a8fd386675e5e2c0a2d1802820b4be0290326c7132e079d6b62c85b403172b',
      'BNB-USDT': 'db9a8e938251acbb233f4229a19f6c83522af3c4d16cdc373e2c76715cf15f5e',
      'BTC-USDT': '925f283c3db6db9e7f3efe193f7fc11e878436af881bc7b8c8ab6dd88fe2a2c9',
      'DOGE-USDT': 'adc3b6ba4503c946d2e3fc009467571a594c58b47e1b8e49255656857828b3ab',
      'ENA-USDT': '7c6da725c936197d13769870c75980fe5457052f441e54bd765bf4578aa17ff3',
      'ETH-USDT': '4742a7d6194dea243d77ff54ba4bd932f6daf85f8b83580cc371f0c0ddd9722c',
      'GRAM-USDT': '7426ed0c2073e360aa5d1ed99fb9363fcd314896476201629f784e7702955b37',
      'HBAR-USDT': '476724bcd20940adbccb4b1f1325eb11d7a6d4fa704d9a88380a8469eb80f8dd',
      'HYPE-USDT': 'c1675cc430ed3db1bcccbcbdf233ea9d16d004c62a560a97f146bae6e868d3ea',
      'LINK-USDT': 'dd1080696d06e7d8f7f1a5dbabf49c5daaf05804e0cb31e44edfff8ba85bc44e',
      'LTC-USDT': '2b66a6beb2546fb4f94143ba85237b539be7fda4ebc9fe6db44a1a0a3887adbb',
      'NEAR-USDT': '57c6cdd8ecd7c6352ca943520789e849cf5757654aaad332a5e3b6377b71e6d7',
      'PEPE-USDT': 'cb6f1824ef56b579745732af93319f56a448a8043fbb6dd05dcc293bd977dbe8',
      'QNT-USDT': '62b57374ab49f03e427e9ba16678b58890d675c3f76ed519bb4be3a8f9b4b37c',
      'SHIB-USDT': 'ab82e9a0185d98036f07f6eff0dfb792f3d6d17088f5d8530f581d3a503c0d34',
      'SOL-USDT': '01e1379b94f5ddb907f3cb49238c77fe475a4b170ff6e71b768cb76945725828',
      'SUI-USDT': 'f81320231a36a870362b6a8294b5b290e13e1caa829e553bc11e7413011dde11',
      'TAO-USDT': '830b275e7aa835cb03d04c23de373f5651e2ae454a310298461d12eac80166cc',
      'TRX-USDT': '6f84d1571e8b4069df39a2f1fdf74b117050c335e8f46562a2f873c41cb49090',
      'UNI-USDT': 'edad959124a83bd94c9e432dac2323b7739ffdd5911d642895124c3ad5975af4',
      'XLM-USDT': 'ef425013421814f4c1fd57ec585537102e21e0b86146179f676a0ab310cc9b90',
      'XRP-USDT': '98346513759fab879b80b1167d35b563a5c1e10671a10069f6296831fc2c0b92',
      'ZEC-USDT': '1af20a9dcd91fb0110222c879050f5ae461fa9d768f01623f1309908a8af47a9',
    },
    retrievedHistory:
      '21 pairs: 1000 bars opening 2024-02-16 through 2026-11-11, with older bars available but not retrieved (has_more). ENA-USDT 954 bars from 2024-04-02 and TAO-USDT 945 from 2024-04-11, back to their listing. GRAM-USDT 133 bars from 2026-07-02 and HYPE-USDT 49 from 2026-09-24, back to their listing. Every response: exact symbol, 1D, USDT; UTC-midnight opening times; no duplicate or missing day; the 2026-11-11 bar forming.',
    newRetrieval:
      'None. The export holds about 26 months of evaluation dates. A deeper history needs paged get_ohlcv calls outside the owner-initiated start, capture and finish workflow and would mix retrievals. No Binance candle, no other provider and no reconstructed bar is used.',
    cutoff:
      'retrieval.startedAt, the scan import’s own frozen cutoff: a bar is used, as model input or as outcome price, only if it closed (open + 86,399,999 ms) at or before it. The forming 2026-11-11 bar is never used.',
    mapping:
      "exportedCandles and tradingViewCryptoCandles (scripts/tradingViewImport.ts), the import's own mapping: the response must name exactly the requested symbol, 1D and USDT, and t is the bar's opening time in Unix seconds, UTC",
  },
  universe: {
    id: CRYPTO_UNIVERSE,
    selectionRule: selectionRule(CRYPTO_UNIVERSE),
    members: Object.fromEntries(
      universeTickers(CRYPTO_UNIVERSE).map((ticker) => [
        ticker,
        CRYPTO_TRADINGVIEW_SYMBOLS[ticker],
      ]),
    ),
    membership:
      'Exactly as committed in CRYPTO_TRADINGVIEW_SYMBOLS (f076326): no pair is added, replaced or removed after inspection, and young listings stay members',
    survivorshipAndSelection:
      "Selected on 2026-11-11 from today's market-capitalization ranking. Coins delisted, collapsed or no longer large are absent; coins that are large today partly because their prices rose are present. Every figure, the same-date baselines included, is biased toward coins that survived and grew. Nothing in this design removes that, and no retrospective partition of this history is unseen validation data.",
  },
  scanner: {
    scannerVersion: SCANNER_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    candlePolicyVersion: TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
    provider: TRADINGVIEW_DEV_PROVIDER_ID,
    historyWindowCandles: SCAN_MIN_CLOSED_CANDLES,
    replay:
      'evaluateScan, the scanner itself, with the TradingView crypto policy, given each member’s candles from the 200 UTC days before the cutoff’s day through D that closed at or before the cutoff, and nothing later',
    eligibility:
      'tradingview-crypto-daily-v1 unchanged: invalid OHLC, a duplicate or a missing day inside the 199-candle window is DATA_INVALID; a latest closed candle more than 24h before the cutoff is STALE_DATA; fewer than 199 closed candles, or no finite model reading, is INSUFFICIENT_HISTORY; an export entry that fails identity checks keeps its import status',
    ranking:
      'Within the crypto cohort: EVALUATED members only, score descending, then ticker in code-unit order, as evaluateScan ranks',
    parity: [
      'On every evaluation date, the replay must equal evaluateScan(importInputs(export, cutoff)), the import as it would read the whole export at that cutoff with later bars left for the validator to exclude, result for result, or the study refuses to run',
      'On 2026-11-10, the replay must equal the recorded results of scan 20261111T183825Z-dc217757 (snapshot sha256 000cc5ea06d238e882c6216142e9edf00bf9f7a25065297a1f96f53fd37ad18f) for every member, or the study refuses to run',
    ],
    unchanged:
      'No weight, threshold, window, freshness bound, eligibility rule or ranking is changed',
  },
  evaluationDates: {
    rule: "Every UTC day D from the first on which any member's export holds 199 candles closed by D's close, through the last UTC day closed at the export cutoff; the same dates for every member",
    first: '2024-09-01',
    last: '2026-11-10',
    count: 801,
    minimumCoverage:
      'A date enters the comparisons only when at least 15 of the 25 members are EVALUATED, so the top 5 is at most a third of the date and each volatility tercile holds at least 5. A date below it is reported and excluded from every comparison.',
    expectedFromBarCounts:
      '21 pairs from 2024-09-01, ENA-USDT from 2024-10-17, TAO-USDT from 2024-10-26; GRAM-USDT and HYPE-USDT never reach 199 closed candles. Actual coverage is what the replay finds, reported per date.',
  },
  decision: {
    cutoff:
      "D's close: D 00:00:00.000 UTC + 86,399,999 ms (23:59:59.999 UTC). The candle that opened on D is the last one the score uses",
    freshness:
      'tradingview-crypto-daily-v1: the latest closed candle must close within 24h of the cutoff, so on a complete series it is D itself',
  },
  signals: {
    longSetup: `modelSetups long (Pine ZC LONG): score >= ${LONG_SETUP_MIN_SCORE} and MACD histogram / close >= +0.05%`,
    riskWarning: `modelSetups risk (Pine ZC RISK): score <= ${RISK_SETUP_MAX_SCORE} or HIGH_VOLATILITY regime (ATR / close >= 4%)`,
    rankGroups:
      'top5: ranks 1-5; top10: ranks 1-10; rank quintile q = ceil(5 x rank / members EVALUATED that date)',
    observation:
      'One member on one evaluation date on which the condition holds; a standing setup repeats on every date it holds',
    transition:
      'An observation whose member was EVALUATED on the previous UTC day without the same condition. When the member was not evaluated on the previous day the onset is unknown, so it is not a transition',
  },
  horizonsUtcDays: CRYPTO_RESEARCH_HORIZONS,
  timestamps: {
    referencePrice:
      "OPEN of the bar opening at D+1 00:00:00.000 UTC: the first bar opening strictly after the cutoff, 1 ms after it. D's close, which produced the score, is never the reference. In a 24/7 market this open is usually at or near D's close; it is a reference price, not an achievable fill",
    endpointPrice: 'OPEN of the bar opening h UTC days after the reference bar, at D+1+h 00:00 UTC',
    change: 'endpoint / reference - 1, in percent; price only, quoted in USDT',
    maturity:
      'Both bars must have closed at or before the export cutoff, or the outcome is PENDING. The last such bar is 2026-11-10, so horizon h is measured for D up to 2026-11-09 minus h days',
  },
  comparisons: {
    universe:
      'Every EVALUATED member on D, on a date meeting minimum coverage, with an AVAILABLE outcome at that horizon',
    sameDateBaseline:
      "Per observation: the equal-weight mean change of that date's universe, the member included",
    volatility:
      "ATR(14) / close of the scored window's last candle: the canonical model's own volatilityPercent recorded on D, so no later candle",
    terciles:
      'On each date: order the EVALUATED members by volatility ascending, ties by ticker in code-unit order; tercile t = ceil(3 x position / members EVALUATED). Tercile 1 is the quietest',
    volatilityMatchedBaseline:
      'Per observation in a group: the same-date mean change of the controls, members of the same tercile that are EVALUATED, have an AVAILABLE outcome and are not in the group. No control: the observation is unmatched, counted and excluded from the matched statistics; it is never matched to another tercile or date',
    groupsAgainstUniverse: [
      'universe',
      'top5',
      'top10',
      'rank-quintile-1',
      'rank-quintile-2',
      'rank-quintile-3',
      'rank-quintile-4',
      'rank-quintile-5',
      'long-setup',
      'long-setup-transition',
      'risk-warning',
      'risk-warning-transition',
      'volatility-tercile-1',
      'volatility-tercile-2',
      'volatility-tercile-3',
    ],
    groupsAgainstVolatilityMatched: [
      'top5',
      'top10',
      'rank-quintile-1',
      'rank-quintile-2',
      'rank-quintile-3',
      'rank-quintile-4',
      'rank-quintile-5',
      'long-setup',
      'long-setup-transition',
      'risk-warning',
      'risk-warning-transition',
    ],
    statistics: [
      'observations',
      'distinctAssets',
      'distinctDates',
      'mean',
      'median',
      'positiveFraction: share of positive price changes, not a trade win rate',
      'baselineMean',
      'meanDifferenceVsBaseline',
      'medianDifferenceVsBaseline',
      'fractionAboveBaseline',
      "dateMeanDifferenceVsBaseline: mean over dates of the date's mean difference, so a date with many observations does not dominate",
      'fractionOfDatesAboveBaseline',
      'unmatched (volatility-matched rows only)',
    ],
    composition: 'For each group: the share of its observations in volatility terciles 1, 2 and 3',
    breakdowns: ['asset', 'calendar quarter of D (UTC)'],
    concentration:
      "For each group: the largest asset's and the largest quarter's share of its observations, and how many assets make up half",
    insufficientSample:
      'Every group and horizon is reported, however few its observations; fewer than 30 observations or 10 distinct dates is labeled too few to read',
  },
  missingData: {
    substitution:
      'none: no forward-fill, interpolation, reconstructed candle, other provider or Binance candle',
    pending: 'the reference or endpoint bar had not closed at the export cutoff',
    missing: 'the member has no bar opening at the reference or endpoint day',
    invalid: 'the reference or endpoint bar fails OHLC validation, or appears twice',
    youngListings:
      'INSUFFICIENT_HISTORY on every date before their 199th closed candle: counted in coverage, never in an outcome denominator, never dropped from the universe',
    denominators:
      'Statistics count only EVALUATED asset-dates with AVAILABLE outcomes at that horizon, on dates meeting minimum coverage. PENDING, MISSING and INVALID outcomes are counted per horizon; dates below minimum coverage are counted; members not EVALUATED are counted per date and status',
  },
  dependence:
    'Consecutive evaluation dates share all but one day of each horizon, standing setups repeat daily, and same-date pairs share crypto-wide moves. Observations are not independent trials; no significance test, p-value or confidence interval is reported.',
  notReported: [
    'portfolio or strategy returns',
    'trade win rates',
    'Sharpe or other risk-adjusted ratios',
    'drawdown',
    'profit from risk warnings: a decline after a warning is not profit and no short position is assumed',
  ],
} as const;

/** SHA-256 of the canonical specification: the study's identity in every result. */
export const CRYPTO_RESEARCH_SPECIFICATION_ID = createHash('sha256')
  .update(stableSerialize(CRYPTO_RESEARCH_SPECIFICATION))
  .digest('hex');
