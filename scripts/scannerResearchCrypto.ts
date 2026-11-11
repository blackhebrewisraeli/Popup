import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DAY_MS } from '@/lib/candleValidation';
import {
  CANONICAL_MODEL_VERSION,
  LONG_SETUP_MIN_SCORE,
  RISK_SETUP_MAX_SCORE,
} from '@/lib/canonicalModel';
import {
  compareTickers,
  evaluateScan,
  SCAN_ASSET_STATUSES,
  SCAN_CANDLE_REQUEST,
  SCAN_MIN_CLOSED_CANDLES,
  SCANNER_VERSION,
  TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
  type MarketScan,
  type ScanAssetResult,
  type ScanAssetStatus,
  type ScanInput,
} from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import type { ScanSnapshot } from './marketScanStore';
import {
  barsBySession,
  concentration,
  fraction,
  GROUP_MEMBERSHIP,
  groupBy,
  mean,
  measureOutcome,
  studyObservations,
  summarize,
  writeStudy,
  type GroupedObservation,
  type OutcomeBar,
  type ParityCheck,
  type ReplayResult,
  type ResearchOutcome,
  type ResearchPoint,
} from './scannerResearch';
import { renderCryptoResearchReport } from './scannerResearchReport';
import {
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  cryptoInputs,
  importInputs,
  parseExport,
  selectionRule,
  universeTickers,
  utcDayStart,
  type TradingViewOhlcvExport,
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

const SPEC = CRYPTO_RESEARCH_SPECIFICATION;
export type CryptoHorizon = (typeof CRYPTO_RESEARCH_HORIZONS)[number];
export type CryptoGroupId = (typeof SPEC.comparisons.groupsAgainstUniverse)[number];
export type CryptoMatchedGroupId = (typeof SPEC.comparisons.groupsAgainstVolatilityMatched)[number];

/** The live scan the replay must reproduce on its own day, as the specification's parity names it. */
export const RECORDED_SCAN = {
  scanId: '20261111T183825Z-dc217757',
  day: '2026-11-10',
  sha256: '000cc5ea06d238e882c6216142e9edf00bf9f7a25065297a1f96f53fd37ad18f',
} as const;

/** The specification's minimum coverage: members EVALUATED on a date for it to be compared. */
export const MINIMUM_EVALUATED = 15;
/** Below either count a row is labeled too few to read, as the specification says. */
export const TOO_FEW = { observations: 30, dates: 10 } as const;

const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The decision cutoff for evaluation day D: D's close, 23:59:59.999 UTC. */
export function cutoffOf(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) + DAY_MS - 1;
}

/** Closed by `time` under the policy's own rule (open + 86,399,999 ms), not the bar's closeTime. */
const closedBy = (timestamp: number, time: number) => timestamp + DAY_MS - 1 <= time;

/** The options the TradingView crypto import scores with (recordTradingViewScan). */
function scanOptions(cutoff: number) {
  return {
    evaluationTime: cutoff,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    equityProvider: null,
    cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
  };
}

/** Each member's whole exported history, through the import's own mapping and identity checks. */
export function cryptoHistory(file: TradingViewOhlcvExport): ScanInput[] {
  return cryptoInputs(file, Date.parse(file.retrieval.startedAt), 0);
}

/**
 * The scanner's inputs on day D: the 200 UTC days the scan requests, cut at D's close. No
 * candle that closes after the cutoff is passed in, so none can reach a score.
 */
export function inputsAt(history: readonly ScanInput[], day: string): ScanInput[] {
  const cutoff = cutoffOf(day);
  const from = utcDayStart(cutoff) - SCAN_CANDLE_REQUEST * DAY_MS;
  return history.map((input) =>
    input.candles === undefined
      ? input
      : {
          ...input,
          candles: input.candles.filter(
            (candle) => candle.timestamp >= from && closedBy(candle.timestamp, cutoff),
          ),
        },
  );
}

/** One member on one day in the scanner's terms, with the model's ATR/close when it scored. */
export interface CryptoReplayResult extends ReplayResult {
  volatility: number | null;
}

export interface CryptoReplayDate {
  session: string;
  /** Members EVALUATED, and so ranked, that day. */
  evaluated: number;
  /** Every universe member, by ticker. */
  results: CryptoReplayResult[];
}

/** The crypto scan as it would have read at D's close. */
export function replayDay(
  history: readonly ScanInput[],
  day: string,
): { scan: MarketScan; date: CryptoReplayDate } {
  const scan = evaluateScan(inputsAt(history, day), scanOptions(cutoffOf(day)));
  const results = [...scan.results]
    .sort((a, b) => compareTickers(a.ticker, b.ticker))
    .map((result): CryptoReplayResult => ({
      ticker: result.ticker,
      status: result.status,
      detail: result.detail,
      dataAsOf: result.dataAsOf === null ? null : utcDay(result.dataAsOf),
      rank: result.rank,
      score: result.model?.signal_score ?? null,
      regime: result.model?.regime ?? null,
      setups: result.setups,
      volatility: result.model?.inputs.volatilityPercent ?? null,
    }));
  return { scan, date: { session: day, evaluated: scan.coverage.evaluated, results } };
}

type Mismatch = ParityCheck['mismatches'][number];

/** Field-by-field differences between two scans' results for the same members. */
function resultDifferences(
  session: string,
  replayed: readonly ScanAssetResult[],
  actual: readonly ScanAssetResult[],
): Mismatch[] {
  const other = new Map(actual.map((result) => [result.ticker, result]));
  const tickers = [...new Set([...replayed, ...actual].map((result) => result.ticker))];
  const mine = new Map(replayed.map((result) => [result.ticker, result]));
  tickers.sort(compareTickers);
  return tickers.flatMap((ticker) => {
    const a = (mine.get(ticker) ?? {}) as Record<string, unknown>;
    const b = (other.get(ticker) ?? {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((field) => stableSerialize(a[field]) !== stableSerialize(b[field]))
      .map((field) => ({ session, ticker, field, replay: a[field], scanner: b[field] }));
  });
}

/** The replay against the actual import reading the whole export at the same cutoff. */
export function scanDifferences(session: string, replayed: MarketScan, actual: MarketScan) {
  if (stableSerialize(replayed) === stableSerialize(actual)) return [];
  const differences = resultDifferences(session, replayed.results, actual.results);
  return differences.length > 0
    ? differences
    : [{ session, ticker: '*', field: 'scan', replay: null, scanner: null }];
}

export interface RecordedScanParity {
  status: 'MATCH' | 'MISMATCH';
  scanId: string;
  day: string;
  members: number;
  mismatches: Mismatch[];
}

/** The replay on the recorded scan's day against what that scan actually recorded. */
export function recordedScanParity(
  replayed: MarketScan | undefined,
  recorded: Pick<ScanSnapshot, 'scanId' | 'scan'>,
  cutoff: number,
): RecordedScanParity {
  const { day } = RECORDED_SCAN;
  const mismatches = resultDifferences(day, replayed?.results ?? [], recorded.scan.results);
  if (recorded.scanId !== RECORDED_SCAN.scanId || recorded.scan.evaluationTime !== cutoff) {
    mismatches.push({
      session: day,
      ticker: '*',
      field: 'scanId/evaluationTime',
      replay: [RECORDED_SCAN.scanId, cutoff],
      scanner: [recorded.scanId, recorded.scan.evaluationTime],
    });
  }
  return {
    status: mismatches.length === 0 ? 'MATCH' : 'MISMATCH',
    scanId: recorded.scanId,
    day,
    members: recorded.scan.results.length,
    mismatches,
  };
}

/** Every UTC day from the earliest closed bar of any member through the last closed at the cutoff. */
export function utcCalendar(history: readonly ScanInput[], cutoff: number): string[] {
  const opens = history.flatMap((input) =>
    (input.candles ?? []).filter((c) => closedBy(c.timestamp, cutoff)).map((c) => c.timestamp),
  );
  const last = utcDayStart(cutoff) - DAY_MS;
  if (opens.length === 0) return [];
  const days: string[] = [];
  for (let time = utcDayStart(Math.min(...opens)); time <= last; time += DAY_MS)
    days.push(utcDay(time));
  return days;
}

/** The first day on which any member holds 199 candles closed by that day's close. */
export function firstEvaluationDay(history: readonly ScanInput[], cutoff: number): string | null {
  const days = history.flatMap((input) => {
    const opens = (input.candles ?? [])
      .filter((c) => closedBy(c.timestamp, cutoff))
      .map((c) => c.timestamp)
      .sort((a, b) => a - b);
    const full = opens[SCAN_MIN_CLOSED_CANDLES - 1];
    return full === undefined ? [] : [utcDay(full)];
  });
  days.sort(compareTickers);
  return days[0] ?? null;
}

/** Outcome prices: each member's bars closed at the export cutoff, keyed by UTC opening day. */
export function outcomeBars(
  history: readonly ScanInput[],
  cutoff: number,
): Map<string, Map<string, OutcomeBar | null>> {
  return new Map(
    history.map((input) => [
      input.ticker,
      barsBySession(
        (input.candles ?? [])
          .filter((c) => closedBy(c.timestamp, cutoff))
          .map((c): OutcomeBar => ({ session: utcDay(c.timestamp), ...c })),
      ),
    ]),
  );
}

type Tercile = 1 | 2 | 3;

/** An EVALUATED member on one date, with its volatility tercile and what followed. */
export interface CryptoObservation extends GroupedObservation {
  ticker: string;
  session: string;
  volatility: number;
  tercile: Tercile;
  longOnsetUnknown: boolean;
  riskOnsetUnknown: boolean;
  outcomes: Record<CryptoHorizon, ResearchOutcome>;
}

/**
 * The equity study's observations (ranks, quintiles, setups, transitions) plus each
 * member's volatility tercile among that date's EVALUATED members, ties by ticker.
 */
export function cryptoObservations(
  replay: readonly CryptoReplayDate[],
  outcomeOf: (ticker: string, date: number, horizon: CryptoHorizon) => ResearchOutcome,
): CryptoObservation[] {
  const placed = new Map<string, { volatility: number; tercile: Tercile }>();
  for (const date of replay) {
    const evaluated = date.results.flatMap((result) => {
      if (result.rank === null) return [];
      if (result.volatility === null)
        throw new Error(`No ATR/close for ${result.ticker} on ${date.session}`);
      return [{ ticker: result.ticker, volatility: result.volatility }];
    });
    evaluated.sort((a, b) => a.volatility - b.volatility || compareTickers(a.ticker, b.ticker));
    evaluated.forEach(({ ticker, volatility }, i) => {
      const tercile = Math.ceil((3 * (i + 1)) / evaluated.length) as Tercile;
      placed.set(`${date.session}|${ticker}`, { volatility, tercile });
    });
  }
  // No instrument types in crypto: the equity study's `type` is dropped.
  return studyObservations(replay, new Map(), outcomeOf).map(({ type, ...observation }) => ({
    ...observation,
    ...placed.get(`${observation.session}|${observation.ticker}`)!,
  }));
}

export const CRYPTO_MEMBERSHIP: Record<CryptoGroupId, (o: CryptoObservation) => boolean> = {
  ...GROUP_MEMBERSHIP,
  'volatility-tercile-1': (o) => o.tercile === 1,
  'volatility-tercile-2': (o) => o.tercile === 2,
  'volatility-tercile-3': (o) => o.tercile === 3,
};

export interface CryptoStats {
  observations: number;
  distinctAssets: number;
  distinctDates: number;
  mean: number | null;
  median: number | null;
  /** Share of positive price changes; not a trade win rate. */
  positiveFraction: number | null;
  baselineMean: number | null;
  meanDifferenceVsBaseline: number | null;
  medianDifferenceVsBaseline: number | null;
  fractionAboveBaseline: number | null;
  dateMeanDifferenceVsBaseline: number | null;
  fractionOfDatesAboveBaseline: number | null;
}

/** The equity study's statistics, plus a date-weighted view so busy dates do not dominate. */
export function cryptoStats(points: readonly ResearchPoint[]): CryptoStats {
  const stats = summarize(points);
  const days = [...groupBy(points, (point) => point.session).values()].map(
    (day) => mean(day.map((point) => point.change - point.baseline)) ?? Number.NaN,
  );
  return {
    observations: stats.observations,
    distinctAssets: stats.distinctAssets,
    distinctDates: stats.distinctDates,
    mean: stats.mean,
    median: stats.median,
    positiveFraction: stats.positiveFraction,
    baselineMean: stats.sameDateUniverseMean,
    meanDifferenceVsBaseline: stats.meanDifferenceVsUniverse,
    medianDifferenceVsBaseline: stats.medianDifferenceVsUniverse,
    fractionAboveBaseline: stats.fractionAboveUniverse,
    dateMeanDifferenceVsBaseline: mean(days),
    fractionOfDatesAboveBaseline: fraction(days.map((difference) => difference > 0)),
  };
}

export const quarterOf = (day: string) =>
  `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;

export interface GroupResult {
  stats: CryptoStats;
  concentration: ReturnType<typeof concentration> & { largestQuarterShare: number | null };
  byQuarter: Record<string, CryptoStats>;
  byAsset: Record<string, CryptoStats>;
}

function groupResult(points: readonly ResearchPoint[]): GroupResult {
  const by = (key: (point: ResearchPoint) => string) =>
    Object.fromEntries(
      [...groupBy(points, key)]
        .sort(([a], [b]) => compareTickers(a, b))
        .map(([name, group]) => [name, cryptoStats(group)]),
    );
  const quarters = points.map((point) => ({ ...point, ticker: quarterOf(point.session) }));
  return {
    stats: cryptoStats(points),
    concentration: {
      ...concentration(points),
      largestQuarterShare: concentration(quarters).largestAssetShare,
    },
    byQuarter: by((point) => quarterOf(point.session)),
    byAsset: by((point) => point.ticker),
  };
}

export interface CryptoHorizonResults {
  horizon: CryptoHorizon;
  /** Outcome status of every EVALUATED asset-date on a date meeting minimum coverage. */
  outcomes: Record<ResearchOutcome['status'], number>;
  againstUniverse: Record<CryptoGroupId, GroupResult>;
  volatilityMatched: Record<CryptoMatchedGroupId, GroupResult & { unmatched: number }>;
}

/**
 * Every group against the same-date equal-weight universe, and the specified groups
 * against same-date, same-tercile members outside the group. An observation without such
 * a control is counted as unmatched, never matched elsewhere.
 */
export function cryptoHorizonResults(
  observations: readonly CryptoObservation[],
  horizon: CryptoHorizon,
): CryptoHorizonResults {
  const outcomes = { AVAILABLE: 0, PENDING: 0, MISSING: 0, INVALID: 0 };
  for (const observation of observations) outcomes[observation.outcomes[horizon].status] += 1;
  const measured = observations.filter((o) => o.outcomes[horizon].status === 'AVAILABLE');
  const change = (o: CryptoObservation) => o.outcomes[horizon].change ?? Number.NaN;
  const dateMeans = new Map(
    [...groupBy(measured, (o) => o.session)].map(([session, day]) => [
      session,
      mean(day.map(change)) ?? Number.NaN,
    ]),
  );
  const cells = groupBy(measured, (o) => `${o.session}|${o.tercile}`);
  const point = (o: CryptoObservation, baseline: number): ResearchPoint => ({
    ticker: o.ticker,
    session: o.session,
    change: change(o),
    baseline,
    benchmark: null,
  });
  const againstUniverse = Object.fromEntries(
    SPEC.comparisons.groupsAgainstUniverse.map((id) => [
      id,
      groupResult(
        measured
          .filter(CRYPTO_MEMBERSHIP[id])
          .map((o) => point(o, dateMeans.get(o.session) ?? Number.NaN)),
      ),
    ]),
  ) as CryptoHorizonResults['againstUniverse'];
  const volatilityMatched = Object.fromEntries(
    SPEC.comparisons.groupsAgainstVolatilityMatched.map((id) => {
      const inGroup = CRYPTO_MEMBERSHIP[id];
      let unmatched = 0;
      const points = measured.filter(inGroup).flatMap((o) => {
        const controls = (cells.get(`${o.session}|${o.tercile}`) ?? []).filter((c) => !inGroup(c));
        if (controls.length === 0) {
          unmatched += 1;
          return [];
        }
        return [point(o, mean(controls.map(change)) ?? Number.NaN)];
      });
      return [id, { ...groupResult(points), unmatched }];
    }),
  ) as CryptoHorizonResults['volatilityMatched'];
  return { horizon, outcomes, againstUniverse, volatilityMatched };
}

/** For each group, the share of its observations (any outcome) in each volatility tercile. */
export function cryptoComposition(observations: readonly CryptoObservation[]) {
  return Object.fromEntries(
    SPEC.comparisons.groupsAgainstUniverse.map((id) => {
      const members = observations.filter(CRYPTO_MEMBERSHIP[id]);
      const share = (t: Tercile) => members.filter((o) => o.tercile === t).length / members.length;
      return [
        id,
        {
          observations: members.length,
          terciles: members.length === 0 ? null : ([share(1), share(2), share(3)] as const),
        },
      ];
    }),
  ) as Record<
    CryptoGroupId,
    { observations: number; terciles: readonly [number, number, number] | null }
  >;
}

export interface CryptoCoverage {
  memberCount: number;
  assetDates: number;
  byStatus: Record<ScanAssetStatus, number>;
  evaluatedPerDate: { min: number | null; max: number | null };
  datesBelowMinimum: number;
  observationsOnExcludedDates: number;
  /** Every member: its first EVALUATED date and its statuses across the dates. */
  perMember: Record<string, { firstEvaluated: string | null; byStatus: Record<string, number> }>;
  signals: Record<
    'long' | 'risk',
    { observations: number; transitions: number; onsetUnknown: number; standing: number }
  >;
}

function coverageOf(
  replay: readonly CryptoReplayDate[],
  observations: readonly CryptoObservation[],
  covered: ReadonlySet<string>,
): CryptoCoverage {
  const byStatus = Object.fromEntries(SCAN_ASSET_STATUSES.map((status) => [status, 0])) as Record<
    ScanAssetStatus,
    number
  >;
  const perMember: CryptoCoverage['perMember'] = {};
  for (const date of replay) {
    for (const result of date.results) {
      byStatus[result.status] += 1;
      const member = (perMember[result.ticker] ??= { firstEvaluated: null, byStatus: {} });
      member.byStatus[result.status] = (member.byStatus[result.status] ?? 0) + 1;
      if (result.status === 'EVALUATED') member.firstEvaluated ??= date.session;
    }
  }
  const counts = replay.map((date) => date.evaluated);
  const kept = observations.filter((o) => covered.has(o.session));
  const signal = (kind: 'long' | 'risk') => {
    const held = kept.filter((o) => o[kind]);
    const transitions = held.filter((o) => o[`${kind}Transition`]).length;
    const onsetUnknown = held.filter((o) => o[`${kind}OnsetUnknown`]).length;
    return {
      observations: held.length,
      transitions,
      onsetUnknown,
      standing: held.length - transitions - onsetUnknown,
    };
  };
  return {
    memberCount: replay[0]?.results.length ?? 0,
    assetDates: replay.reduce((sum, date) => sum + date.results.length, 0),
    byStatus,
    evaluatedPerDate: {
      min: counts.length > 0 ? Math.min(...counts) : null,
      max: counts.length > 0 ? Math.max(...counts) : null,
    },
    datesBelowMinimum: replay.length - covered.size,
    observationsOnExcludedDates: observations.length - kept.length,
    perMember,
    signals: { long: signal('long'), risk: signal('risk') },
  };
}

/** sha256 of each instrument entry, by ticker: the specification's input hashes. */
export function instrumentHashes(file: TradingViewOhlcvExport): Record<string, string> {
  return Object.fromEntries(
    [...file.instruments]
      .sort((a, b) => compareTickers(a.ticker, b.ticker))
      .map((entry) => [entry.ticker, sha256(stableSerialize(entry))]),
  );
}

export interface CryptoStudyResults {
  schemaVersion: '1';
  specificationId: string;
  studyId: string;
  evidenceType: string;
  specification: typeof CRYPTO_RESEARCH_SPECIFICATION;
  export: {
    sha256: string;
    retrieval: TradingViewOhlcvExport['retrieval'];
    inputHashes: Record<string, string>;
  };
  calendar: { days: number; first: string | null; last: string | null };
  evaluationDates: {
    count: number;
    first: string | null;
    last: string | null;
    minimumEvaluated: number;
    compared: number;
  };
  parity: ParityCheck;
  recordedScanParity: RecordedScanParity;
  coverage: CryptoCoverage;
  composition: ReturnType<typeof cryptoComposition>;
  horizons: CryptoHorizonResults[];
  replay: CryptoReplayDate[];
}

/** The whole study on one parsed export. Pure: the same inputs always give the same results. */
export function runCryptoStudy(
  file: TradingViewOhlcvExport,
  exportSha256: string,
  recorded: Pick<ScanSnapshot, 'scanId' | 'scan'>,
): CryptoStudyResults {
  const cutoff = Date.parse(file.retrieval.startedAt);
  const history = cryptoHistory(file);
  const days = utcCalendar(history, cutoff);
  const firstDay = firstEvaluationDay(history, cutoff);
  const start = firstDay === null ? days.length : days.indexOf(firstDay);
  const replayed = days.slice(start).map((day) => replayDay(history, day));
  const replay = replayed.map(({ date }) => date);

  const mismatches = replayed.flatMap(({ scan, date }) => {
    const at = cutoffOf(date.session);
    return scanDifferences(
      date.session,
      scan,
      evaluateScan(importInputs(file, at), scanOptions(at)),
    );
  });
  const recordedDay = replayed.find(({ date }) => date.session === RECORDED_SCAN.day)?.scan;
  const comparedStatus = mismatches.length === 0 ? 'MATCH' : 'MISMATCH';

  const bars = outcomeBars(history, cutoff);
  const observations = cryptoObservations(replay, (ticker, k, horizon) =>
    measureOutcome(bars.get(ticker) ?? new Map(), days, start + k, horizon),
  );
  const covered = new Set(
    replay.filter((date) => date.evaluated >= MINIMUM_EVALUATED).map((date) => date.session),
  );
  const compared = observations.filter((o) => covered.has(o.session));
  return {
    schemaVersion: '1',
    specificationId: CRYPTO_RESEARCH_SPECIFICATION_ID,
    studyId: SPEC.studyId,
    evidenceType: SPEC.evidenceType,
    specification: SPEC,
    export: {
      sha256: exportSha256,
      retrieval: file.retrieval,
      inputHashes: instrumentHashes(file),
    },
    calendar: { days: days.length, first: days[0] ?? null, last: days.at(-1) ?? null },
    evaluationDates: {
      count: replay.length,
      first: replay[0]?.session ?? null,
      last: replay.at(-1)?.session ?? null,
      minimumEvaluated: MINIMUM_EVALUATED,
      compared: covered.size,
    },
    parity: {
      status: replay.length === 0 ? 'NOT_COMPARABLE' : comparedStatus,
      datesCompared: replay.length,
      first: replay[0]?.session ?? null,
      last: replay.at(-1)?.session ?? null,
      mismatches,
    },
    recordedScanParity: recordedScanParity(recordedDay, recorded, cutoff),
    coverage: coverageOf(replay, observations, covered),
    composition: cryptoComposition(compared),
    horizons: CRYPTO_RESEARCH_HORIZONS.map((horizon) => cryptoHorizonResults(compared, horizon)),
    replay,
  };
}

/** The run must rest on exactly what the specification froze, or it is not this study. */
export function cryptoFrozenFactDifferences(
  results: Pick<CryptoStudyResults, 'evaluationDates' | 'export' | 'parity' | 'recordedScanParity'>,
): string[] {
  const expected: Record<string, [unknown, unknown]> = {
    'evaluationDates.first': [results.evaluationDates.first, SPEC.evaluationDates.first],
    'evaluationDates.last': [results.evaluationDates.last, SPEC.evaluationDates.last],
    'evaluationDates.count': [results.evaluationDates.count, SPEC.evaluationDates.count],
    'data.retrieval': [
      stableSerialize(results.export.retrieval),
      stableSerialize(SPEC.data.retrieval),
    ],
    'data.exportSha256': [results.export.sha256, SPEC.data.exportSha256],
    'parity.status': [results.parity.status, 'MATCH'],
    'recordedScanParity.status': [results.recordedScanParity.status, 'MATCH'],
  };
  return Object.entries(expected).flatMap(([field, [actual, frozen]]) =>
    actual === frozen ? [] : [`${field}: ${String(actual)} (frozen ${String(frozen)})`],
  );
}

/**
 * The parsed export, only if it is byte for byte the one the specification froze. A
 * differing file names the instrument entries whose hashes changed.
 */
export function verifyCryptoExport(
  raw: Buffer,
  frozen: { exportSha256: string; inputHashes: Readonly<Record<string, string>> } = SPEC.data,
): { file: TradingViewOhlcvExport; exportSha256: string } {
  const exportSha256 = sha256(raw);
  const file = parseExport(JSON.parse(raw.toString('utf8')));
  if (file.universe !== CRYPTO_UNIVERSE) {
    throw new Error(
      `The study reads a ${CRYPTO_UNIVERSE} export, not ${file.universe ?? 'default'}.`,
    );
  }
  if (exportSha256 !== frozen.exportSha256) {
    const hashes = instrumentHashes(file);
    const { rule, ...expected } = frozen.inputHashes;
    const changed = [...new Set([...Object.keys(expected), ...Object.keys(hashes)])]
      .filter((ticker) => expected[ticker] !== hashes[ticker])
      .sort(compareTickers);
    const detail =
      changed.length > 0
        ? `changed instrument entries: ${changed.join(', ')}`
        : 'every instrument entry is unchanged; the file around them differs';
    throw new Error(
      `The study is frozen on export ${frozen.exportSha256}; this file is ${exportSha256} (${detail}).`,
    );
  }
  return { file, exportSha256 };
}

/** The recorded live scan the replay is checked against, only if byte for byte the frozen one. */
export async function loadRecordedScan(store: string): Promise<ScanSnapshot> {
  const raw = await readFile(join(store, `${RECORDED_SCAN.scanId}.json`));
  const actual = sha256(raw);
  if (actual !== RECORDED_SCAN.sha256) {
    throw new Error(
      `Scan ${RECORDED_SCAN.scanId} is frozen as sha256 ${RECORDED_SCAN.sha256}; the stored file is ${actual}.`,
    );
  }
  return JSON.parse(raw.toString('utf8')) as ScanSnapshot;
}

/** Aggregates only: no ticker, price or per-asset figure. */
export function researchSummaryCrypto(results: CryptoStudyResults) {
  const { perMember, ...coverage } = results.coverage;
  const row = ({ stats, concentration: c }: GroupResult) => ({
    ...stats,
    tooFew: stats.observations < TOO_FEW.observations || stats.distinctDates < TOO_FEW.dates,
    largestAssetShare: c.largestAssetShare,
    assetsForHalf: c.assetsForHalf,
    largestQuarterShare: c.largestQuarterShare,
  });
  const each = <K extends string, V extends GroupResult>(
    groups: Record<K, V>,
    extra = (_: V) => ({}),
  ) =>
    Object.fromEntries(
      (Object.entries(groups) as [K, V][]).map(([id, group]) => [
        id,
        { ...row(group), ...extra(group) },
      ]),
    );
  return {
    specificationId: results.specificationId,
    studyId: results.studyId,
    evidenceType: results.evidenceType,
    evaluationDates: results.evaluationDates,
    parity: { ...results.parity, mismatches: results.parity.mismatches.length },
    recordedScanParity: {
      ...results.recordedScanParity,
      mismatches: results.recordedScanParity.mismatches.length,
    },
    coverage: {
      ...coverage,
      membersEverEvaluated: Object.values(perMember).filter((m) => m.firstEvaluated !== null)
        .length,
    },
    composition: results.composition,
    horizons: results.horizons.map(({ horizon, outcomes, againstUniverse, volatilityMatched }) => ({
      horizon,
      outcomes,
      againstUniverse: each(againstUniverse),
      volatilityMatched: each(volatilityMatched, (group) => ({ unmatched: group.unmatched })),
    })),
  };
}

export async function runScannerResearchCrypto(options: {
  file: string;
  outputDir: string;
  repositoryCommit: string;
  scanStore: string;
  now?: () => number;
}) {
  const { file, exportSha256 } = verifyCryptoExport(await readFile(options.file));
  const results = runCryptoStudy(file, exportSha256, await loadRecordedScan(options.scanStore));
  return {
    ...(await writeStudy(
      results,
      CRYPTO_RESEARCH_SPECIFICATION_ID,
      options,
      renderCryptoResearchReport,
      cryptoFrozenFactDifferences(results),
    )),
    results,
  };
}
