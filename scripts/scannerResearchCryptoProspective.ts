import { createHash } from 'node:crypto';
import { DAY_MS } from '@/lib/candleValidation';
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
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import type { ScanSnapshot } from './marketScanStore';
import {
  CRYPTO_RESEARCH_SPECIFICATION,
  CRYPTO_RESEARCH_SPECIFICATION_ID,
  MINIMUM_EVALUATED,
} from './scannerResearchCrypto';
import {
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  universeTickers,
  utcDayStart,
} from './tradingViewImport';

/**
 * A prospective follow-up to the retrospective crypto study: one selected hypothesis, frozen
 * before any day of its period had begun. It collects nothing; scans recorded by the owner
 * in time are its observations. docs/scanner-research-crypto-prospective.v1.json is the
 * committed copy. The analysis is not implemented yet; only the timing and category rules
 * are, so they can be checked now.
 */
export const PROSPECTIVE_HORIZON_DAYS = 20;
/** Scored days per phase series: 20-day windows 21 days apart never share a bar. */
export const PHASE_SERIES = PROSPECTIVE_HORIZON_DAYS + 1;

export const CRYPTO_PROSPECTIVE_SPECIFICATION = {
  schemaVersion: '1',
  studyId: 'popup-scanner-prospective-crypto-usdt-v1-top5-20d',
  evidenceType: 'prospective-confirmation-attempt',
  frozenAt: '2026-11-11T20:37:00.000Z',
  basedOn: {
    studyId: CRYPTO_RESEARCH_SPECIFICATION.studyId,
    specificationId: CRYPTO_RESEARCH_SPECIFICATION_ID,
    resultsSha256: 'a14c0d191bc4d2878bd043985ec696f0419c6b08bac03fddcb7a4ed2918ffe71',
  },
  hypothesisOrigin:
    'Selected after seeing the retrospective results. Of 3 horizons and 15 groups, the 20-day horizon and the top-5 comparison are tested here because the retrospective study showed a positive mean difference there, alongside a negative median, concentration in one pair and non-monotonic quintiles. This is a future confirmation attempt of a selected hypothesis, not an independently preselected finding; the retrospective figures are not evidence for it.',
  question:
    'In crypto-usdt-v1 scans recorded before their outcome window began, was the mean 20-day price change of the top 5 ranked pairs above the same-date equal-weight mean of evaluated pairs?',
  interpretation:
    'A comparison of price changes between groups of pairs. Not a net trading return, not a portfolio return, not proof of profitability and not a trading system.',
  unchanged: {
    scannerVersion: SCANNER_VERSION,
    modelVersion: CANONICAL_MODEL_VERSION,
    candlePolicyVersion: TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
    provider: TRADINGVIEW_DEV_PROVIDER_ID,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    historyWindowCandles: SCAN_MIN_CLOSED_CANDLES,
    longSetupMinScore: LONG_SETUP_MIN_SCORE,
    riskSetupMaxScore: RISK_SETUP_MAX_SCORE,
    universe: {
      id: CRYPTO_UNIVERSE,
      members: Object.fromEntries(
        universeTickers(CRYPTO_UNIVERSE).map((ticker) => [
          ticker,
          CRYPTO_TRADINGVIEW_SYMBOLS[ticker],
        ]),
      ),
    },
    rule: 'Weights, thresholds, window, freshness, eligibility, ranking and membership stay as committed. A scan under any other scanner, model, candle policy, provider, universe source or membership is excluded and counted, never pooled; changing any of them is a new study.',
  },
  timing: {
    decisionCutoff:
      "The scan's own frozen cutoff R: its retrieval start, recorded as the snapshot's startedAt and the scan's evaluationTime (tradingview-crypto-daily-v1)",
    scoredDay:
      'D = the UTC day before the day R falls on: the last UTC day closed by R. Every pair rests on its D candle or is not evaluated',
    referencePrice:
      "OPEN of the daily bar opening at the UTC midnight after R, D+2 00:00:00.000 UTC: the first bar opening strictly after R. One day later than the retrospective study's D+1 open, because a live scan for D can exist only during D+1 and no part of the outcome window may precede the recorded scan",
    endpointPrice:
      'OPEN of the daily bar opening 20 UTC days after the reference bar, D+22 00:00 UTC',
    change: 'endpoint / reference - 1, in percent; price only, quoted in USDT',
    recordBy:
      "The snapshot's completedAt must be before the reference bar opens (the UTC midnight after R)",
  },
  period: {
    firstScoredDay: '2026-11-12',
    lastScoredDay: '2027-11-11',
    scoredDays: 365,
    retrievalDays: '2026-11-13 through 2027-11-12, UTC: R falls on D+1',
    excluded:
      'Every scored day up to 2026-11-11. Their outcomes were inspected in the retrospective study (through 2026-11-08), or they were scored or partly retrieved before this freeze (2026-11-09 to 2026-11-11). 2026-11-12 had not begun when this was frozen',
    lastEndpointBar: '2027-12-03',
    analysisNotBefore: '2027-12-04T00:00:00.000Z',
    analysisNotBeforeReason:
      'Outcomes use only bars closed at the outcome retrieval’s cutoff, so the last endpoint bar (2027-12-03) must have closed',
    interimLooks:
      'None of the outcome. Before the analysis, only collection status is checked: which days have a PROSPECTIVE snapshot. No change, rank-group return or difference of this study is computed or inspected earlier',
  },
  categories: {
    prospective:
      'PROSPECTIVE: a crypto-usdt-v1 snapshot from an owner-initiated TradingView retrieval, scored day in the period, saved before its reference bar opened, under the unchanged versions and membership, whose recorded outputs reproduce from its recorded inputs offline (MATCH). Its recorded ranks are the observation; nothing is re-scored',
    reconstructed:
      "RECONSTRUCTED: a scored day in the period without a PROSPECTIVE snapshot, replayed later from the outcome retrieval with the retrospective study's frozen replay (candles closed by D's close) and measured on the same reference and endpoint bars. Labeled, reported in a separate table, never pooled with PROSPECTIVE, never counted toward the collection minimum or the classification",
    notProspective:
      'A snapshot saved at or after its reference bar opened, under another version or membership, or that does not reproduce: counted with its reason; its day can only be RECONSTRUCTED',
    duplicates:
      'Several PROSPECTIVE snapshots for one scored day: the earliest saved is the observation; the rest are counted',
    noBackfill:
      'A day becomes PROSPECTIVE only through a snapshot saved in time. Nothing recorded later, however exact, is ever moved into that category',
  },
  collection: {
    requirement:
      'This specification collects nothing. Each PROSPECTIVE observation needs the owner, in an agent session with TradingView’s MCP server, to run tradingview-start --universe crypto-usdt-v1, capture every pair and tradingview-finish on day D+1, finishing before the next UTC midnight, and to keep the snapshot in .zerochart-scans. No scheduler, campaign or automation is added. Record every day, whatever the market does: choosing days by market conditions biases the sample',
    evidence:
      "The snapshot's scanId, startedAt, completedAt, repositoryCommit and file sha256. These are the owner's machine's own timestamps: they order events on that machine, they are not an independent attestation",
    outcomeRetrieval:
      'One owner-initiated crypto-usdt-v1 retrieval started on or after 2027-12-04, by the same workflow. Its 1000 daily bars cover the whole period; nothing is fetched from another source',
    minimum: `At least 240 PROSPECTIVE scored days with at least ${MINIMUM_EVALUATED} pairs EVALUATED and a measurable day difference, and at least 8 of them in each of the ${PHASE_SERIES} phase series. Otherwise the result is INSUFFICIENT_COLLECTION`,
  },
  primaryComparison: {
    group:
      'top5: ranks 1-5 of the recorded scan among its EVALUATED pairs (score descending, then ticker)',
    baseline:
      'The same-date equal-weight mean change of every EVALUATED pair in the recorded scan with an AVAILABLE outcome, the top 5 included',
    dayDifference:
      'Δ_d = mean change of the top 5 with AVAILABLE outcomes minus the baseline: one value per scored day',
    primaryStatistic:
      'M = the mean of Δ_d over PROSPECTIVE days: each day counts once, however many pairs it has',
    horizonUtcDays: PROSPECTIVE_HORIZON_DAYS,
    minimumCoverage: `At least ${MINIMUM_EVALUATED} of the 25 pairs EVALUATED in the recorded scan; a day below it is excluded and counted`,
    youngListings:
      'GRAM-USDT and HYPE-USDT reach 199 closed candles inside the period (about 2027-01-16 and 2027-04-10, if their series stay complete) and are ranked from then on as the scanner ranks them. The universe does not change',
    onlyComparison:
      'No other horizon, group, baseline, threshold or subset is analysed under this study',
  },
  dependence: {
    overlap: `Consecutive days' 20-day windows share 19 days. Scored days are split into ${PHASE_SERIES} phase series by (days since 2026-11-12) mod ${PHASE_SERIES}; windows within one series never share a bar. M is reported per series`,
    correlation:
      'Pairs move together on each day. Δ_d is one value per day, so pairs are never counted as independent trials',
    noSignificance:
      'No p-value, confidence interval or significance claim. About 17 non-overlapping windows per series is a small sample, and the series overlap each other',
  },
  missingData: {
    substitution:
      'none: no forward-fill, interpolation, reconstructed candle, other provider or Binance candle',
    pending: 'the reference or endpoint bar had not closed at the outcome retrieval’s cutoff',
    missing: 'no bar opening at the reference or endpoint day',
    invalid: 'the reference or endpoint bar fails OHLC validation, or appears twice',
    stoppedTrading:
      'A pair whose bars stop (delisted or halted) inside its window has a MISSING outcome. It is counted and listed, never filled with its last price',
    topFiveIncomplete:
      'A day whose top 5 has fewer than 3 AVAILABLE outcomes has no Δ_d; it is excluded and counted',
  },
  classification: {
    SUPPORTED:
      'Collection minimum met, and all of: M > 0; the median of Δ_d > 0; M > 0 after removing the pair with the largest summed contribution to Δ_d, from the top 5 (not replaced by rank 6) and from the baseline, on every day; M > 0 in at least 11 of the 21 phase series; at most 2% of top-5 outcomes MISSING',
    NOT_SUPPORTED: 'Collection minimum met and M <= 0',
    INCONCLUSIVE: 'Collection minimum met, M > 0, and at least one other SUPPORTED condition fails',
    INSUFFICIENT_COLLECTION: 'Collection minimum not met: the hypothesis is not classified',
    meaning:
      'SUPPORTED means only that the selected price-change association recurred on later data under this protocol. It is not a net trading return, not proof of profitability and not a reason to trade. NOT_SUPPORTED, INCONCLUSIVE and INSUFFICIENT_COLLECTION are reported with the same prominence',
  },
  reporting: [
    'Collection: scored days in the period; PROSPECTIVE, RECONSTRUCTED and not-prospective (with reasons) counts; duplicates; days below coverage; PROSPECTIVE days per phase series and per calendar month',
    'Primary: M; the median of Δ_d; the share of days with Δ_d > 0; M per phase series; M without the largest-contributing pair; the observation-level median difference; the share of top-5 outcomes MISSING',
    'Breakdowns of the top 5 by pair and by calendar quarter, as in the retrospective study',
    "Data revisions: how often each PROSPECTIVE scan's top 5 differs from a replay of the same day from the outcome retrieval",
    'RECONSTRUCTED days: the same statistics in a separate, labeled table, never pooled',
    'The classification, with the value of every condition',
  ],
  analysisCode:
    'Written and tested on labeled fixtures, and committed, before 2027-12-04 and before the outcome retrieval. It implements this text and cannot change it; where they differ, this specification governs.',
  notDone: [
    'model tuning or any other horizon, group or threshold',
    'scheduler, campaign, automation, orders, deployment or merge',
    'net or portfolio returns, win rates, Sharpe or other risk-adjusted ratios, drawdown',
    "the owner's personal trading trial, which stays deferred",
  ],
} as const;

export const CRYPTO_PROSPECTIVE_SPECIFICATION_ID = createHash('sha256')
  .update(stableSerialize(CRYPTO_PROSPECTIVE_SPECIFICATION))
  .digest('hex');

const SPEC = CRYPTO_PROSPECTIVE_SPECIFICATION;
const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The specification's timing for a scan whose frozen cutoff (retrieval start) is `cutoff`. */
export function prospectiveTiming(cutoff: number) {
  const day = utcDayStart(cutoff);
  const referenceOpen = day + DAY_MS;
  return {
    scoredDay: utcDay(day - DAY_MS),
    referenceOpen,
    endpointOpen: referenceOpen + PROSPECTIVE_HORIZON_DAYS * DAY_MS,
    /** The snapshot must be saved strictly before this. */
    recordBy: referenceOpen,
  };
}

/** Days since the first scored day, mod 21: windows within one series never share a bar. */
export function phaseSeries(scoredDay: string): number {
  const days = (Date.parse(scoredDay) - Date.parse(SPEC.period.firstScoredDay)) / DAY_MS;
  return ((days % PHASE_SERIES) + PHASE_SERIES) % PHASE_SERIES;
}

export type RecordedScanCategory = 'PROSPECTIVE' | 'NOT_PROSPECTIVE' | 'OUTSIDE_PERIOD';

/**
 * Whether a recorded scan can be a PROSPECTIVE observation, and why not. `reproduces` is
 * the offline reproduction of the snapshot's outputs from its inputs (scan-reproduce MATCH).
 * Choosing the earliest snapshot per day and everything about outcomes belong to the analysis.
 */
export function classifyRecordedScan(
  snapshot: Pick<ScanSnapshot, 'startedAt' | 'completedAt' | 'scan'>,
  reproduces: boolean,
): { category: RecordedScanCategory; scoredDay: string; reasons: string[] } {
  const cutoff = Date.parse(snapshot.startedAt);
  const timing = prospectiveTiming(cutoff);
  const { scoredDay } = timing;
  if (scoredDay < SPEC.period.firstScoredDay || scoredDay > SPEC.period.lastScoredDay) {
    return { category: 'OUTSIDE_PERIOD', scoredDay, reasons: ['scored day outside the period'] };
  }
  const { scan } = snapshot;
  const cohorts = scan.cohorts.map((cohort) => [
    cohort.assetClass,
    cohort.provider,
    cohort.candlePolicyVersion,
  ]);
  const checks: Array<[boolean, string]> = [
    [scan.evaluationTime === cutoff, 'evaluation time is not the retrieval start'],
    [
      Date.parse(snapshot.completedAt) < timing.recordBy,
      'saved at or after its reference bar opened',
    ],
    [scan.scannerVersion === SPEC.unchanged.scannerVersion, 'another scanner version'],
    [scan.modelVersion === SPEC.unchanged.modelVersion, 'another model version'],
    [
      stableSerialize(cohorts) ===
        stableSerialize([['crypto', SPEC.unchanged.provider, SPEC.unchanged.candlePolicyVersion]]),
      'another asset class, provider or candle policy',
    ],
    [scan.universe.source === SPEC.unchanged.universeSource, 'another universe source'],
    [
      stableSerialize(scan.universe.members) ===
        stableSerialize(Object.keys(SPEC.unchanged.universe.members)),
      'another membership',
    ],
    [reproduces, 'does not reproduce offline'],
  ];
  const reasons = checks.flatMap(([ok, reason]) => (ok ? [] : [reason]));
  return { category: reasons.length === 0 ? 'PROSPECTIVE' : 'NOT_PROSPECTIVE', scoredDay, reasons };
}
