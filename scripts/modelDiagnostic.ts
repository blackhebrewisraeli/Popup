import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ATR_PERIOD,
  CANONICAL_MODEL_VERSION,
  FLAT_MOMENTUM,
  LONG_SETUP_MIN_SCORE,
  MACD_FAST,
  MACD_SIGNAL,
  MACD_SLOW,
  momentumBias,
  REGIME_HIGH_VOLATILITY,
  REGIME_TRENDING_MOMENTUM,
  REGIME_WEIGHTS,
  RISK_SETUP_MAX_SCORE,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  type FactorInputs,
  type MarketRegime,
} from '@/lib/canonicalModel';
import { atr, macd } from '@/lib/indicators';
import {
  compareTickers,
  SCAN_ASSET_STATUSES,
  SCAN_MIN_CLOSED_CANDLES,
  SCANNER_VERSION,
  TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
  type ScanAssetResult,
  type ScanAssetStatus,
} from '@/lib/marketScanner';
import { stableSerialize } from './evaluationStore';
import type { ScanSnapshot } from './marketScanStore';
import { esc, REPORT_STYLES, share, table, wrap, type Cell } from './reportStyles';
import { groupBy, mean, saveResearchResults } from './scannerResearch';
import {
  CRYPTO_RESEARCH_SPECIFICATION,
  CRYPTO_RESEARCH_SPECIFICATION_ID,
  cryptoHistory,
  instrumentHashes,
  MINIMUM_EVALUATED,
  quarterOf,
  RECORDED_SCAN,
  recordedScanParity,
  replayDay,
  verifyCryptoExport,
  loadRecordedScan,
  type CryptoStudyResults,
} from './scannerResearchCrypto';
import type { TradingViewOhlcvExport } from './tradingViewImport';

/**
 * Explains the canonical model's Long and Risk behaviour on the frozen crypto replay
 * (docs/MODEL_DIAGNOSTIC.md). It replays the study's own dates with the study's own
 * `replayDay`, reconciles every row with the frozen results, and decomposes each score into
 * its factor contributions. It reads no outcome and computes no price change: the study's
 * horizons are never read.
 */
const LONG_RAW_BOUNDARY = LONG_SETUP_MIN_SCORE - 0.5;
const RISK_RAW_BOUNDARY = RISK_SETUP_MAX_SCORE + 0.5;
/** Points a score can lose to its three factors and still round to the Long threshold. */
export const LONG_SHORTFALL_BUDGET = 100 - LONG_RAW_BOUNDARY;
/** Precedence order, as classifyRegime tests them. */
export const REGIMES = ['HIGH_VOLATILITY', 'TRENDING', 'MEAN_REVERTING', 'NEUTRAL'] as const;
const FACTORS = ['rsi', 'momentum', 'volatility'] as const;
type Factor = (typeof FACTORS)[number];
const QUANTILES = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1] as const;
const STUDY_RESULTS_SHA256 = 'a14c0d191bc4d2878bd043985ec696f0419c6b08bac03fddcb7a4ed2918ffe71';

export const MODEL_DIAGNOSTIC_DEFINITION = {
  schemaVersion: '1',
  diagnosticId: 'popup-model-diagnostic-crypto-usdt-v1',
  evidenceType: 'explanatory-diagnostic',
  question:
    'Why does the canonical model, on the frozen crypto replay, meet the Long setup on almost no pair-day and the Risk warning on most? Mechanism only: which clause, factor and regime decide each label.',
  interpretation:
    'Describes the model’s own readings on historical candles. No forward price change, outcome or return is read or computed, no threshold or weight is varied, and nothing here proposes or validates a model.',
  reads: {
    export: CRYPTO_RESEARCH_SPECIFICATION.data.exportSha256,
    recordedScan: { scanId: RECORDED_SCAN.scanId, sha256: RECORDED_SCAN.sha256 },
    study: {
      specificationId: CRYPTO_RESEARCH_SPECIFICATION_ID,
      resultsSha256: STUDY_RESULTS_SHA256,
      fieldsRead: ['evaluationDates', 'parity', 'recordedScanParity', 'coverage', 'replay'],
      neverRead: ['horizons', 'composition'],
    },
  },
  replay:
    'replayDay (scripts/scannerResearchCrypto.ts), unchanged, on every evaluation date of the frozen study; each EVALUATED result keeps the full CanonicalScore the scanner computed',
  model: {
    modelVersion: CANONICAL_MODEL_VERSION,
    scannerVersion: SCANNER_VERSION,
    candlePolicyVersion: TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
    windowCandles: SCAN_MIN_CLOSED_CANDLES,
    longSetup: `score >= ${LONG_SETUP_MIN_SCORE} and momentumPercent >= ${FLAT_MOMENTUM}`,
    riskWarning: `score <= ${RISK_SETUP_MAX_SCORE} or regime HIGH_VOLATILITY (volatilityPercent >= ${REGIME_HIGH_VOLATILITY})`,
    regimePrecedence: REGIMES,
    trendingMomentum: REGIME_TRENDING_MOMENTUM,
    rsiExtremes: [RSI_OVERSOLD, RSI_OVERBOUGHT],
    weights: REGIME_WEIGHTS,
  },
  reconciliation: [
    'Every replayed date equals the frozen results’ replay entry (stableSerialize), date for date',
    'Status counts equal coverage.byStatus; Long and Risk observations, transitions, unknown onsets and standing counts equal coverage.signals',
    'The 2026-11-10 replay equals recorded scan 20261111T183825Z-dc217757 (recordedScanParity)',
    'On every row, Math.round(raw) equals the recorded score and the gates reproduce the recorded setups',
    'Otherwise nothing is written',
  ],
  definitions: {
    rows: 'EVALUATED members on dates the study compared (at least 15 EVALUATED); other statuses are counted apart and never enter a row denominator',
    raw: 'The unrounded composite in scoreFactors’ operation order: weight × factor summed over RSI, momentum, volatility. Every weight row sums to exactly 1 in binary64, so its division is exact',
    contribution: 'weight × factor score; the three sum to raw',
    shortfall: 'weight × (100 − factor score); the three sum to 100 − raw',
    gates: {
      score: `score >= ${LONG_SETUP_MIN_SCORE} (raw >= ${LONG_RAW_BOUNDARY})`,
      momentum: `momentumPercent >= ${FLAT_MOMENTUM}`,
      lowScore: `score <= ${RISK_SETUP_MAX_SCORE} (raw < ${RISK_RAW_BOUNDARY})`,
      highVolatility: 'regime HIGH_VOLATILITY',
    },
    veto: `A factor whose shortfall alone exceeds ${LONG_SHORTFALL_BUDGET}: no value of the other two factors meets the score gate in that regime`,
    roundingDecided: `Score gate met only through rounding (raw in [${LONG_RAW_BOUNDARY}, ${LONG_SETUP_MIN_SCORE})); low-score clause met only through rounding (raw in (${RISK_SETUP_MAX_SCORE}, ${RISK_RAW_BOUNDARY}))`,
    transition:
      'The condition holds and the member was EVALUATED the previous date without it; otherwise an unknown onset (not EVALUATED the day before) or standing, as the study counts',
    clauseOnset:
      'One Risk clause begins (previous date EVALUATED without it). It produces a Risk transition only if Risk did not already hold through the other clause',
    saturation:
      'momentum factor at 100 (>= +1%) or 0 (<= −1%); volatility factor at 100 (<= 0.5%) or 0 (>= 5.5%); RSI tails <= 30 and >= 70, where the RSI curve flattens',
    histogramAtrBound:
      'sup |MACD histogram| / ATR over any candles with low <= close <= high, for the window: max over j of |hist step response at j| / ATR weight of j',
    riskProfileFit:
      'The scanner’s own riskProfiles (qualifiesForRiskProfile), counted on all rows and on rows that also carry a Risk warning',
  },
  quantiles: QUANTILES,
  quantileMethod: 'linear interpolation between order statistics (type 7)',
  breakdowns: ['regime', 'calendar quarter of D (UTC)', 'pair (private output only)'],
  notComputed: [
    'forward price changes and outcomes',
    'alternative thresholds, weights, windows or regimes',
    'any model selection or optimisation',
  ],
  privacy:
    'Per-row readings, pair tables and Long observations stay in the git-ignored output. The printed summary names no pair and no date.',
} as const;

export const MODEL_DIAGNOSTIC_ID = createHash('sha256')
  .update(stableSerialize(MODEL_DIAGNOSTIC_DEFINITION))
  .digest('hex');

type Gates = { score: boolean; momentum: boolean; lowScore: boolean; highVolatility: boolean };

/** One EVALUATED member on one date, with its score taken apart. */
export interface DiagnosticRow {
  session: string;
  ticker: string;
  rank: number;
  regime: MarketRegime;
  inputs: FactorInputs;
  factors: Record<Factor, number>;
  weights: Record<Factor, number>;
  contributions: Record<Factor, number>;
  shortfalls: Record<Factor, number>;
  raw: number;
  score: number;
  gates: Gates;
  long: boolean;
  risk: boolean;
  riskProfiles: ScanAssetResult['riskProfiles'];
}

/** The scanner's result taken apart; refuses a result the decomposition does not reproduce. */
export function diagnosticRow(session: string, result: ScanAssetResult): DiagnosticRow {
  const { model, setups, rank } = result;
  if (result.status !== 'EVALUATED' || model === null || setups === null || rank === null) {
    throw new Error(`${result.ticker} on ${session} has no score to take apart`);
  }
  const { weights, rsiScore, momentumScore, volatilityScore } = model.components;
  const factors = { rsi: rsiScore, momentum: momentumScore, volatility: volatilityScore };
  const raw =
    weights.rsi * rsiScore +
    weights.momentum * momentumScore +
    weights.volatility * volatilityScore;
  const score = model.signal_score;
  const gates: Gates = {
    score: score >= LONG_SETUP_MIN_SCORE,
    momentum: model.inputs.momentumPercent >= FLAT_MOMENTUM,
    lowScore: score <= RISK_SETUP_MAX_SCORE,
    highVolatility: model.regime === 'HIGH_VOLATILITY',
  };
  if (
    Math.round(raw) !== score ||
    setups.long !== (gates.score && gates.momentum) ||
    setups.risk !== (gates.lowScore || gates.highVolatility)
  ) {
    throw new Error(`${result.ticker} on ${session}: the decomposition does not reproduce it`);
  }
  const each = (value: (factor: Factor) => number) =>
    Object.fromEntries(FACTORS.map((factor) => [factor, value(factor)])) as Record<Factor, number>;
  return {
    session,
    ticker: result.ticker,
    rank,
    regime: model.regime,
    inputs: model.inputs,
    factors,
    weights: { rsi: weights.rsi, momentum: weights.momentum, volatility: weights.volatility },
    contributions: each((f) => weights[f] * factors[f]),
    shortfalls: each((f) => weights[f] * (100 - factors[f])),
    raw,
    score,
    gates,
    long: setups.long,
    risk: setups.risk,
    riskProfiles: result.riskProfiles,
  };
}

/** Linear interpolation between order statistics; null for no values. */
export function quantiles(values: readonly number[]): Record<string, number> | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries(
    QUANTILES.map((q) => {
      const at = q * (sorted.length - 1);
      const low = sorted[Math.floor(at)] ?? Number.NaN;
      const high = sorted[Math.ceil(at)] ?? Number.NaN;
      return [`p${Math.round(q * 100)}`, low + (high - low) * (at - Math.floor(at))];
    }),
  );
}

export function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  const mx = mean(xs);
  const my = mean(ys);
  if (mx === null || my === null) return null;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  xs.forEach((x, i) => {
    const dy = (ys[i] ?? Number.NaN) - my;
    sxy += (x - mx) * dy;
    sxx += (x - mx) ** 2;
    syy += dy ** 2;
  });
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

const count = <T>(items: readonly T[], test: (item: T) => boolean) =>
  items.reduce((sum, item) => sum + (test(item) ? 1 : 0), 0);

const maxOf = (values: readonly number[]) =>
  values.length === 0 ? null : values.reduce((a, b) => Math.max(a, b));

/** Which Risk clauses hold: both, one, or neither. */
export function riskClauses(
  gates: Gates,
): 'both' | 'lowScoreOnly' | 'highVolatilityOnly' | 'neither' {
  if (gates.lowScore && gates.highVolatility) return 'both';
  if (gates.lowScore) return 'lowScoreOnly';
  return gates.highVolatility ? 'highVolatilityOnly' : 'neither';
}

/** Gate cells, regime counts, vetoes and mean contributions of a set of rows. */
export function cells(rows: readonly DiagnosticRow[]) {
  const vetoed = (row: DiagnosticRow, factor: Factor) =>
    row.shortfalls[factor] > LONG_SHORTFALL_BUDGET;
  const meanOf = (value: (row: DiagnosticRow) => number) => mean(rows.map(value));
  return {
    rows: rows.length,
    regimes: Object.fromEntries(REGIMES.map((r) => [r, count(rows, (row) => row.regime === r)])),
    longGates: {
      both: count(rows, ({ gates }) => gates.score && gates.momentum),
      scoreOnly: count(rows, ({ gates }) => gates.score && !gates.momentum),
      momentumOnly: count(rows, ({ gates }) => !gates.score && gates.momentum),
      neither: count(rows, ({ gates }) => !gates.score && !gates.momentum),
    },
    riskClauses: {
      both: count(rows, (row) => riskClauses(row.gates) === 'both'),
      lowScoreOnly: count(rows, (row) => riskClauses(row.gates) === 'lowScoreOnly'),
      highVolatilityOnly: count(rows, (row) => riskClauses(row.gates) === 'highVolatilityOnly'),
      neither: count(rows, (row) => riskClauses(row.gates) === 'neither'),
    },
    longAndRisk: count(rows, (row) => row.long && row.risk),
    scoreGateVetoes: {
      volatility: count(rows, (row) => vetoed(row, 'volatility')),
      rsi: count(rows, (row) => vetoed(row, 'rsi')),
      momentum: count(rows, (row) => vetoed(row, 'momentum')),
      anyFactor: count(rows, (row) => FACTORS.some((f) => vetoed(row, f))),
      noSingleFactor: count(
        rows,
        (row) => !row.gates.score && !FACTORS.some((f) => vetoed(row, f)),
      ),
    },
    roundingDecided: {
      scoreGate: count(
        rows,
        (row) => row.raw >= LONG_RAW_BOUNDARY && row.raw < LONG_SETUP_MIN_SCORE,
      ),
      lowScore: count(rows, (row) => row.raw > RISK_SETUP_MAX_SCORE && row.raw < RISK_RAW_BOUNDARY),
    },
    maxRaw: maxOf(rows.map((row) => row.raw)),
    maxScore: maxOf(rows.map((row) => row.score)),
    meanContribution: Object.fromEntries(
      FACTORS.map((f) => [f, meanOf((r) => r.contributions[f])]),
    ),
    meanShortfall: Object.fromEntries(FACTORS.map((f) => [f, meanOf((r) => r.shortfalls[f])])),
  };
}

/**
 * sup |MACD histogram| / ATR over every candle window of this length with low <= close <=
 * high. Both are linear: the histogram is Σ B_j (close_j − close_{j−1}) with B_j its response
 * to a unit step at j, |close_j − close_{j−1}| <= TR_j, and ATR is Σ a_j TR_j with a_j > 0. So
 * |histogram| <= max_j |B_j| / a_j × ATR, and dividing by the close, |momentum| <= K × volatility.
 */
export function histogramAtrBound(window: number = SCAN_MIN_CLOSED_CANDLES): number {
  const last = window - 1;
  const unit = (i: number) => Array.from({ length: window }, (_, j) => (j === i ? 1 : 0));
  const zeros = new Array<number>(window).fill(0);
  let step = 0;
  let bound = 0;
  for (let j = last; j >= 1; j -= 1) {
    step += macd(unit(j), MACD_FAST, MACD_SLOW, MACD_SIGNAL).histogram[last] ?? Number.NaN;
    const weight = atr(unit(j), zeros, zeros, ATR_PERIOD)[last] ?? Number.NaN;
    bound = Math.max(bound, Math.abs(step) / weight);
  }
  return bound;
}

/** Share of a flag's rows held by the largest pair, and how many pairs make up half. */
function pairConcentration(rows: readonly DiagnosticRow[]) {
  const counts = [...groupBy(rows, (row) => row.ticker).values()]
    .map((group) => group.length)
    .sort((a, b) => b - a);
  let covered = 0;
  let pairs = 0;
  for (const n of counts) {
    if (covered * 2 >= rows.length) break;
    covered += n;
    pairs += 1;
  }
  return {
    rows: rows.length,
    pairs: counts.length,
    largestPairShare: rows.length === 0 ? null : (counts[0] ?? 0) / rows.length,
    pairsForHalf: rows.length === 0 ? null : pairs,
  };
}

type SignalCounts = {
  observations: number;
  transitions: number;
  onsetUnknown: number;
  standing: number;
};

/** Long and Risk as standing conditions and as onsets, with which clause each Risk onset carried. */
function signalsOf(
  dates: readonly {
    session: string;
    rows: Map<string, DiagnosticRow>;
    statuses: Map<string, ScanAssetStatus>;
  }[],
  covered: ReadonlySet<string>,
) {
  const tally = (): SignalCounts => ({
    observations: 0,
    transitions: 0,
    onsetUnknown: 0,
    standing: 0,
  });
  const long = tally();
  const risk = tally();
  const riskTransitionsByClauses = { both: 0, lowScoreOnly: 0, highVolatilityOnly: 0 };
  const clauseChangesWhileStanding: Record<string, number> = {};
  const onsets = {
    lowScore: { total: 0, withRiskTransition: 0 },
    highVolatility: { total: 0, withRiskTransition: 0 },
  };
  const highConviction = { observations: 0, transitions: 0 };
  const add = (
    counts: SignalCounts,
    holds: boolean,
    before: DiagnosticRow | undefined,
    known: boolean,
    held: (row: DiagnosticRow) => boolean,
  ) => {
    if (!holds) return;
    counts.observations += 1;
    if (!known) counts.onsetUnknown += 1;
    else if (before !== undefined && !held(before)) counts.transitions += 1;
    else counts.standing += 1;
  };
  dates.forEach((date, k) => {
    if (!covered.has(date.session)) return;
    const previous = dates[k - 1];
    for (const row of date.rows.values()) {
      const known = previous?.statuses.get(row.ticker) === 'EVALUATED';
      const before = previous?.rows.get(row.ticker);
      add(long, row.long, before, known, (r) => r.long);
      add(risk, row.risk, before, known, (r) => r.risk);
      if (row.score >= 80) {
        highConviction.observations += 1;
        if (known && before !== undefined && before.score < 80) highConviction.transitions += 1;
      }
      if (!known || before === undefined) continue;
      const clauses = riskClauses(row.gates);
      if (row.risk && !before.risk && clauses !== 'neither') riskTransitionsByClauses[clauses] += 1;
      if (row.risk && before.risk && clauses !== riskClauses(before.gates)) {
        const key = `${riskClauses(before.gates)}>${clauses}`;
        clauseChangesWhileStanding[key] = (clauseChangesWhileStanding[key] ?? 0) + 1;
      }
      for (const clause of ['lowScore', 'highVolatility'] as const) {
        if (row.gates[clause] && !before.gates[clause]) {
          onsets[clause].total += 1;
          if (!before.risk) onsets[clause].withRiskTransition += 1;
        }
      }
    }
  });
  const sorted = Object.fromEntries(
    Object.entries(clauseChangesWhileStanding).sort(([a], [b]) => compareTickers(a, b)),
  );
  return {
    long,
    risk: {
      ...risk,
      transitionsByClauses: riskTransitionsByClauses,
      clauseChangesWhileStanding: sorted,
    },
    clauseOnsets: onsets,
    highConvictionScore80: highConviction,
  };
}

type StudyFacts = Pick<
  CryptoStudyResults,
  'specificationId' | 'evaluationDates' | 'parity' | 'recordedScanParity' | 'coverage' | 'replay'
>;

/** Where this run's replay and counts differ from the frozen study; empty when they reconcile. */
function reconcile(
  study: StudyFacts,
  replayed: readonly string[],
  statusCounts: Record<ScanAssetStatus, number>,
  signals: ReturnType<typeof signalsOf>,
  recordedParity: string,
): string[] {
  const differences: string[] = [];
  const expect = (field: string, actual: unknown, frozen: unknown) => {
    if (stableSerialize(actual) !== stableSerialize(frozen)) {
      differences.push(`${field}: ${stableSerialize(actual)} (frozen ${stableSerialize(frozen)})`);
    }
  };
  expect('specificationId', study.specificationId, CRYPTO_RESEARCH_SPECIFICATION_ID);
  expect('study.parity.status', study.parity.status, 'MATCH');
  expect('study.recordedScanParity.status', study.recordedScanParity.status, 'MATCH');
  expect('recordedScanParity', recordedParity, 'MATCH');
  expect('replay.dates', replayed.length, study.replay.length);
  replayed.forEach((date, k) => {
    if (date !== stableSerialize(study.replay[k]))
      differences.push(`replay ${study.replay[k]?.session ?? k}`);
  });
  expect('coverage.byStatus', statusCounts, study.coverage.byStatus);
  expect('coverage.signals.long', signals.long, study.coverage.signals.long);
  const { transitionsByClauses, clauseChangesWhileStanding, ...risk } = signals.risk;
  expect('coverage.signals.risk', risk, study.coverage.signals.risk);
  return differences;
}

/**
 * The whole diagnostic on the frozen export, the recorded scan and the study's frozen results.
 * Pure: the same inputs always give the same results.
 */
export function modelDiagnostic(
  file: TradingViewOhlcvExport,
  exportSha256: string,
  recorded: Pick<ScanSnapshot, 'scanId' | 'scan'>,
  study: StudyFacts,
  studySha256: string,
) {
  const history = cryptoHistory(file);
  const statusCounts = Object.fromEntries(SCAN_ASSET_STATUSES.map((s) => [s, 0])) as Record<
    ScanAssetStatus,
    number
  >;
  const replayed: string[] = [];
  let recordedDay: ReturnType<typeof replayDay>['scan'] | undefined;
  const dates = study.replay.map(({ session }) => {
    const { scan, date } = replayDay(history, session);
    replayed.push(stableSerialize(date));
    if (session === RECORDED_SCAN.day) recordedDay = scan;
    const statuses = new Map(scan.results.map((r) => [r.ticker, r.status]));
    for (const status of statuses.values()) statusCounts[status] += 1;
    const rows = new Map(
      scan.results
        .filter((r) => r.status === 'EVALUATED')
        .map((r) => [r.ticker, diagnosticRow(session, r)]),
    );
    return { session, evaluated: rows.size, rows, statuses };
  });
  const covered = new Set(
    dates.filter((d) => d.evaluated >= MINIMUM_EVALUATED).map((d) => d.session),
  );
  const signals = signalsOf(dates, covered);
  const parity = recordedScanParity(recordedDay, recorded, Date.parse(file.retrieval.startedAt));
  const differences = reconcile(study, replayed, statusCounts, signals, parity.status);

  const rows = dates
    .filter((d) => covered.has(d.session))
    .flatMap((d) => [...d.rows.values()].sort((a, b) => compareTickers(a.ticker, b.ticker)));
  const column = (value: (row: DiagnosticRow) => number, subset = rows) => subset.map(value);
  const rsiZone = (rsi: number) =>
    rsi <= RSI_OVERSOLD
      ? 'oversold'
      : rsi < 50
        ? 'below50'
        : rsi < RSI_OVERBOUGHT
          ? 'above50'
          : 'overbought';
  const byRegime = <T>(make: (subset: DiagnosticRow[]) => T) =>
    Object.fromEntries(
      REGIMES.map((r) => [r, make(rows.filter((row) => row.regime === r))]),
    ) as Record<MarketRegime, T>;
  const bound = histogramAtrBound();
  const momentumGated = rows.filter((row) => row.gates.momentum);
  const lowScore = rows.filter((row) => row.gates.lowScore);
  const flags: Record<string, (row: DiagnosticRow) => boolean> = {
    long: (row) => row.long,
    scoreGate: (row) => row.gates.score,
    lowScoreOnly: (row) => riskClauses(row.gates) === 'lowScoreOnly',
    lowScore: (row) => row.gates.lowScore,
    notHighVolatility: (row) => !row.gates.highVolatility,
    trending: (row) => row.regime === 'TRENDING',
    rawAtLeast70: (row) => row.raw >= 70,
  };

  return {
    schemaVersion: '1' as const,
    diagnosticId: MODEL_DIAGNOSTIC_DEFINITION.diagnosticId,
    definitionId: MODEL_DIAGNOSTIC_ID,
    definition: MODEL_DIAGNOSTIC_DEFINITION,
    inputs: {
      exportSha256,
      retrieval: file.retrieval,
      inputHashes: instrumentHashes(file),
      recordedScan: { scanId: recorded.scanId },
      study: { specificationId: study.specificationId, resultsSha256: studySha256 },
    },
    versions: {
      model: CANONICAL_MODEL_VERSION,
      scanner: SCANNER_VERSION,
      candlePolicy: TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
      replay: CRYPTO_RESEARCH_SPECIFICATION_ID,
    },
    reconciliation: {
      status: differences.length === 0 ? ('MATCH' as const) : ('MISMATCH' as const),
      datesCompared: replayed.length,
      rowsCompared: rows.length,
      recordedScanParity: parity.status,
      differences,
    },
    coverage: {
      dates: dates.length,
      first: dates[0]?.session ?? null,
      last: dates.at(-1)?.session ?? null,
      datesBelowMinimum: dates.length - covered.size,
      assetDates: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      evaluatedPerDate: {
        min: dates.length === 0 ? null : Math.min(...dates.map((d) => d.evaluated)),
        max: dates.length === 0 ? null : Math.max(...dates.map((d) => d.evaluated)),
      },
    },
    all: cells(rows),
    byRegime: byRegime(cells),
    distributions: {
      rsi: quantiles(column((r) => r.inputs.rsi)),
      momentumPercent: quantiles(column((r) => r.inputs.momentumPercent)),
      volatilityPercent: quantiles(column((r) => r.inputs.volatilityPercent)),
      rsiFactor: quantiles(column((r) => r.factors.rsi)),
      momentumFactor: quantiles(column((r) => r.factors.momentum)),
      volatilityFactor: quantiles(column((r) => r.factors.volatility)),
      raw: quantiles(column((r) => r.raw)),
      rawByRegime: byRegime((subset) => quantiles(column((r) => r.raw, subset))),
      scoreBands: Object.fromEntries(
        Array.from({ length: 10 }, (_, b) => [
          `${b * 10}-${b === 9 ? 100 : b * 10 + 9}`,
          count(rows, (r) => Math.min(9, Math.floor(r.score / 10)) === b),
        ]),
      ),
    },
    saturation: {
      momentumFactor100: count(rows, (r) => r.factors.momentum === 100),
      momentumFactor0: count(rows, (r) => r.factors.momentum === 0),
      volatilityFactor100: count(rows, (r) => r.factors.volatility === 100),
      volatilityFactor0: count(rows, (r) => r.factors.volatility === 0),
      rsiOversold: count(rows, (r) => r.inputs.rsi <= RSI_OVERSOLD),
      rsiOverbought: count(rows, (r) => r.inputs.rsi >= RSI_OVERBOUGHT),
      /** HIGH_VOLATILITY rows whose volatility still leaves the score gate reachable (<= 4.25%). */
      highVolatilityLongBand: count(
        rows,
        (r) => r.gates.highVolatility && r.shortfalls.volatility <= LONG_SHORTFALL_BUDGET,
      ),
    },
    conjunction: {
      rsiMomentumFactorCorrelation: correlation(
        column((r) => r.factors.rsi),
        column((r) => r.factors.momentum),
      ),
      byRegime: byRegime((subset) =>
        correlation(
          column((r) => r.factors.rsi, subset),
          column((r) => r.factors.momentum, subset),
        ),
      ),
      rsiZoneByMomentum: Object.fromEntries(
        ['oversold', 'below50', 'above50', 'overbought'].map((zone) => [
          zone,
          Object.fromEntries(
            (['Bearish', 'Flat', 'Bullish'] as const).map((bias) => [
              bias,
              count(
                rows,
                (r) =>
                  rsiZone(r.inputs.rsi) === zone && momentumBias(r.inputs.momentumPercent) === bias,
              ),
            ]),
          ),
        ]),
      ),
    },
    margins: {
      momentumGatedRawMinusLongBoundary: quantiles(
        column((r) => r.raw - LONG_RAW_BOUNDARY, momentumGated),
      ),
      momentumGatedWithin: Object.fromEntries(
        [1, 2.5, 5, 10].map((points) => [
          String(points),
          count(momentumGated, (r) => r.raw >= LONG_RAW_BOUNDARY - points),
        ]),
      ),
      lowScoreVolatilityShortfallShare: mean(
        lowScore.map((r) => r.shortfalls.volatility / (100 - r.raw)),
      ),
      lowScoreAtZeroVolatilityFactor: count(lowScore, (r) => r.factors.volatility === 0),
    },
    bounds: {
      histogramAtrWindow: SCAN_MIN_CLOSED_CANDLES,
      histogramAtrBound: bound,
      observedAbsMomentumOverVolatility: quantiles(
        column((r) => Math.abs(r.inputs.momentumPercent) / r.inputs.volatilityPercent),
      ),
    },
    riskProfileFit: Object.fromEntries(
      (['conservative', 'moderate', 'aggressive'] as const).map((profile) => [
        profile,
        {
          rows: count(rows, (r) => r.riskProfiles?.[profile] === true),
          withRiskWarning: count(rows, (r) => r.risk && r.riskProfiles?.[profile] === true),
        },
      ]),
    ),
    signals,
    longObservations: rows
      .filter((r) => r.long)
      .map(({ session, ticker, regime, score, raw, inputs, contributions }) => ({
        session,
        ticker,
        regime,
        score,
        raw,
        inputs,
        contributions,
      })),
    concentration: Object.fromEntries(
      Object.entries(flags).map(([name, test]) => [name, pairConcentration(rows.filter(test))]),
    ),
    byQuarter: Object.fromEntries(
      [...groupBy(rows, (r) => quarterOf(r.session))]
        .sort(([a], [b]) => compareTickers(a, b))
        .map(([quarter, subset]) => [quarter, cells(subset)]),
    ),
    byPair: Object.fromEntries(
      [...groupBy(rows, (r) => r.ticker)]
        .sort(([a], [b]) => compareTickers(a, b))
        .map(([ticker, subset]) => [ticker, cells(subset)]),
    ),
    rows,
  };
}

export type ModelDiagnosticResults = ReturnType<typeof modelDiagnostic>;

/** Aggregates only: no pair, date, row or per-pair figure. */
export function diagnosticSummary(results: ModelDiagnosticResults) {
  const { definition, inputs, byPair, rows, longObservations, ...aggregates } = results;
  return {
    ...aggregates,
    inputs: { exportSha256: inputs.exportSha256, study: inputs.study },
    reconciliation: {
      ...results.reconciliation,
      differences: results.reconciliation.differences.length,
    },
    longObservations: longObservations.map(({ session, ticker, ...reading }) => reading),
  };
}

/** The frozen study's results file, only if byte for byte the one this diagnostic names. */
export async function loadStudyFacts(outputDir: string, expectedSha256 = STUDY_RESULTS_SHA256) {
  const path = join(
    resolve(outputDir),
    `scanner-research-${CRYPTO_RESEARCH_SPECIFICATION_ID.slice(0, 12)}.json`,
  );
  const raw = await readFile(path);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  if (sha256 !== expectedSha256) {
    throw new Error(
      `The study results are frozen as sha256 ${expectedSha256}; ${path} is ${sha256}.`,
    );
  }
  const {
    specificationId,
    evaluationDates,
    parity,
    recordedScanParity: recorded,
    coverage,
    replay,
  } = JSON.parse(raw.toString('utf8')) as CryptoStudyResults;
  const facts: StudyFacts = {
    specificationId,
    evaluationDates,
    parity,
    recordedScanParity: recorded,
    coverage,
    replay,
  };
  return { facts, sha256 };
}

const fixed = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? null : value.toFixed(digits);

/** Private HTML: the same results, with pair tables. Deterministic for a given commit. */
export function renderModelDiagnosticReport(
  results: ModelDiagnosticResults,
  meta: { repositoryCommit: string; resultHash: string },
): string {
  const n = results.all.rows;
  const of = (value: number) => `${value} (${share(value / n)})`;
  const cellRows = (groups: Record<string, ReturnType<typeof cells>>): Cell[][] =>
    Object.entries(groups).map(([name, c]) => [
      name,
      c.rows,
      ...REGIMES.map((r) => c.regimes[r] ?? 0),
      c.longGates.both,
      c.longGates.momentumOnly,
      c.riskClauses.highVolatilityOnly,
      c.riskClauses.both,
      c.riskClauses.lowScoreOnly,
      c.riskClauses.neither,
      fixed(c.maxRaw),
    ]);
  const cellHeaders = [
    'Group',
    'Rows',
    ...REGIMES,
    'Long',
    'Momentum gate only',
    'Risk: vol only',
    'Risk: both',
    'Risk: low score only',
    'No Risk',
    'Max raw',
  ];
  const quantileRows = (entries: Record<string, Record<string, number> | null>): Cell[][] =>
    Object.entries(entries).map(([name, q]) => [
      name,
      ...Object.values(q ?? {}).map((v) => fixed(v, 4)),
    ]);
  const quantileHeaders = ['Reading', ...QUANTILES.map((q) => `p${Math.round(q * 100)}`)];
  const { all } = results;
  const { rawByRegime, scoreBands, ...readings } = results.distributions;
  const section = (title: string, body: string) =>
    `<section class="panel">${wrap('h2', esc(title))}${body}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model diagnostic · crypto-usdt-v1</title><style>${REPORT_STYLES}</style></head><body><main class="shell">
<div class="top"><div><p class="eyebrow">Private explanatory diagnostic</p><h1>Why Long is rare and Risk is common</h1><p class="muted">Canonical model ${esc(results.versions.model)} on the frozen crypto replay. No price change or outcome was read.</p></div><p class="privacy">Private: pair names and per-pair readings. Keep this file out of the repository.</p></div>
${section(
  'Provenance',
  table(
    ['Field', 'Value'],
    [
      ['Diagnostic definition', results.definitionId],
      ['Export sha256', results.inputs.exportSha256],
      ['Study results sha256', results.inputs.study.resultsSha256],
      ['Replay (study specification)', results.versions.replay],
      ['Scanner / policy', `${results.versions.scanner} / ${results.versions.candlePolicy}`],
      [
        'Reconciliation',
        `${results.reconciliation.status}: ${results.reconciliation.datesCompared} dates, ${results.reconciliation.rowsCompared} rows, recorded scan ${results.reconciliation.recordedScanParity}`,
      ],
      ['Results sha256', meta.resultHash],
      ['Repository commit', meta.repositoryCommit],
    ],
  ),
)}
${section(
  'Gates (denominator: evaluated pair-days)',
  table(
    ['Cell', 'Count'],
    [
      ['Long: score and momentum gates', of(all.longGates.both)],
      ['Score gate only', of(all.longGates.scoreOnly)],
      ['Momentum gate only', of(all.longGates.momentumOnly)],
      ['Neither', of(all.longGates.neither)],
      ['Risk: high volatility only', of(all.riskClauses.highVolatilityOnly)],
      ['Risk: both clauses', of(all.riskClauses.both)],
      ['Risk: low score only', of(all.riskClauses.lowScoreOnly)],
      ['No Risk', of(all.riskClauses.neither)],
      ['Long and Risk together', of(all.longAndRisk)],
      ['Score gate vetoed by volatility alone', of(all.scoreGateVetoes.volatility)],
      ['… by RSI alone', of(all.scoreGateVetoes.rsi)],
      ['… by momentum alone', of(all.scoreGateVetoes.momentum)],
      ['… by no single factor', of(all.scoreGateVetoes.noSingleFactor)],
    ],
  ),
)}
${section('By regime', table(cellHeaders, cellRows(results.byRegime)))}
${section('Distributions', table(quantileHeaders, quantileRows({ ...readings, ...Object.fromEntries(Object.entries(rawByRegime).map(([r, q]) => [`raw (${r})`, q])) })))}
${section('Score bands', table(['Score', 'Rows'], Object.entries(scoreBands)))}
${section(
  'Long observations',
  table(
    ['Date', 'Pair', 'Regime', 'Score', 'Raw', 'RSI', 'Momentum', 'Volatility'],
    results.longObservations.map((o) => [
      o.session,
      o.ticker,
      o.regime,
      o.score,
      fixed(o.raw, 3),
      fixed(o.inputs.rsi, 1),
      fixed(o.inputs.momentumPercent, 4),
      fixed(o.inputs.volatilityPercent, 4),
    ]),
  ),
)}
${section('By quarter', table(cellHeaders, cellRows(results.byQuarter)))}
${section('By pair (private)', table(cellHeaders, cellRows(results.byPair)))}
<footer>Definition ${esc(results.definitionId)} · results ${esc(meta.resultHash)}</footer></main></body></html>
`;
}

export async function runModelDiagnosticCrypto(options: {
  file: string;
  scanStore: string;
  outputDir: string;
  repositoryCommit: string;
}) {
  const { file, exportSha256 } = verifyCryptoExport(await readFile(options.file));
  const recorded = await loadRecordedScan(options.scanStore);
  const study = await loadStudyFacts(options.outputDir);
  const results = modelDiagnostic(file, exportSha256, recorded, study.facts, study.sha256);
  if (results.reconciliation.status !== 'MATCH') {
    throw new Error(
      `The diagnostic does not reconcile with the frozen study: ${results.reconciliation.differences.slice(0, 5).join('; ')}`,
    );
  }
  const content = `${JSON.stringify(results)}\n`;
  const resultHash = createHash('sha256').update(content).digest('hex');
  const name = `model-diagnostic-${MODEL_DIAGNOSTIC_ID.slice(0, 12)}`;
  const resultsPath = join(resolve(options.outputDir), `${name}.json`);
  const reportPath = join(resolve(options.outputDir), `${name}.html`);
  const status = await saveResearchResults(resultsPath, content);
  if (status !== 'CONFLICT') {
    await writeFile(
      reportPath,
      renderModelDiagnosticReport(results, {
        repositoryCommit: options.repositoryCommit,
        resultHash,
      }),
      'utf8',
    );
  }
  return { status, resultHash, resultsPath, reportPath, results };
}
