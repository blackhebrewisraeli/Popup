/**
 * Offline prototype of Popup's 24-hour Spot target-before-stop evaluation, protocol v1
 * (docs/spot-24h-probability.v1.json, docs/SPOT_24H_PROBABILITY.md). Pure functions over
 * candles passed in memory: no network, no account, no order. The JSON is the protocol and its
 * SHA-256 the identity. Numbers it states only in prose are mirrored in RULES below, and a test
 * checks each one against the JSON's text.
 */
import { createHash } from 'node:crypto';
import protocolJson from '../docs/spot-24h-probability.v1.json';
import { atr, macd, rsi } from '@/lib/indicators';
import { validatePrices, type CandleIssueCode } from '@/lib/candleValidation';
import { stableSerialize } from '@/lib/stableSerialize';
import type { DiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscovery';
import { bootstrapOrders } from './swingStructureEvaluation';

export const PROTOCOL = protocolJson;
export type Protocol = typeof protocolJson;
export const protocolSha256 = (protocol: unknown = PROTOCOL) =>
  createHash('sha256').update(stableSerialize(protocol)).digest('hex');

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const HORIZON_BARS = 24;
const ms = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------------------------------------
// Universe

export type UniverseSkip =
  'EXCLUDED_BASE' | 'LEVERAGED_PRODUCT' | 'LABELLED_BY_DISCOVERY' | 'INSUFFICIENT_HISTORY';

export interface UniverseSelection {
  members: { rank: number; symbol: string; firstOpenTime: number }[];
  skipped: { rank: number; symbol: string; reason: UniverseSkip }[];
}

const LEVERAGED_SUFFIX = /(UP|DOWN|BULL|BEAR)$/;

/** Base assets that look like a leveraged product of another listed base asset. */
export function isLeveragedProduct(baseAsset: string, bases: ReadonlySet<string>): boolean {
  const match = LEVERAGED_SUFFIX.exec(baseAsset);
  return match !== null && bases.has(baseAsset.slice(0, match.index));
}

/** Members needing a first-candle check: the discovery members not excluded by label or product. */
export function universeCandidates(evidence: DiscoveryEvidence, protocol: Protocol = PROTOCOL) {
  const bases = new Set(evidence.inputs.usdtInstruments.map((i) => i.baseAsset));
  const labelled: readonly string[] = protocol.universe.exclude.labelledByDiscovery;
  const excluded = new Set(Object.values(protocol.universe.exclude.additionalBases).flat());
  return evidence.result.members.map((member) => {
    let reason: UniverseSkip | null = null;
    if (excluded.has(member.baseAsset)) reason = 'EXCLUDED_BASE';
    else if (isLeveragedProduct(member.baseAsset, bases)) reason = 'LEVERAGED_PRODUCT';
    else if (labelled.includes(member.category)) reason = 'LABELLED_BY_DISCOVERY';
    return { rank: member.rank, symbol: member.symbol, reason };
  });
}

/** The protocol's universe walk, given each candidate's first 1h candle open time. */
export function selectUniverse(
  evidence: DiscoveryEvidence,
  firstOpenTimes: Readonly<Record<string, number>>,
  protocol: Protocol = PROTOCOL,
): UniverseSelection {
  const historyStart = ms(protocol.data.historyStart);
  const selection: UniverseSelection = { members: [], skipped: [] };
  for (const { rank, symbol, reason } of universeCandidates(evidence, protocol)) {
    if (selection.members.length === protocol.universe.size) break;
    const firstOpenTime = firstOpenTimes[symbol];
    if (reason) selection.skipped.push({ rank, symbol, reason });
    else if (firstOpenTime === undefined || firstOpenTime > historyStart)
      selection.skipped.push({ rank, symbol, reason: 'INSUFFICIENT_HISTORY' });
    else selection.members.push({ rank, symbol, firstOpenTime });
  }
  return selection;
}

/** Prose numbers of the protocol (see the JSON field named in each comment). */
export const RULES = {
  /** features.indicators */
  rsiPeriod: 14,
  macd: [12, 26, 9] as const,
  atrPeriod: 14,
  /** features.rsiBands */
  rsiLow: 40,
  rsiHigh: 60,
  /** uncertainty.method */
  blockDays: 7,
  /** support.evidence */
  minTestObservations: 2000,
  minTestDays: 90,
  minTestCoverage: 0.95,
  /** support.calibration */
  maxCalibrationInTheLarge: 0.03,
  maxWeightedCellError: 0.05,
  /** ranking.netGainNormalization */
  netGainCap: 0.1,
} as const;

export const CELLS = ['low', 'mid', 'high'].flatMap((band) =>
  ['positive', 'nonPositive'].map((state) => `${band}/${state}`),
);

// ---------------------------------------------------------------------------------------------
// Hourly candles: validated, never repaired

export interface HourCandle {
  timestamp: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type HourlyIssueCode = CandleIssueCode | 'TIMESTAMP_NOT_HOUR_ALIGNED';

export interface HourlyIndex {
  /** Valid, unique candles by open time. A missing or invalid hour is simply absent. */
  valid: Map<number, HourCandle>;
  issues: { timestamp: number; code: HourlyIssueCode }[];
  included: number;
}

/** Candles closed before the cutoff, each either valid or listed with its issues. */
export function indexHourly(
  candles: readonly HourCandle[],
  cutoff: number,
  protocol: Protocol = PROTOCOL,
): HourlyIndex {
  const { intervalMs, closeOffsetMs } = protocol.data;
  const included = candles.filter((c) => c.timestamp + closeOffsetMs < cutoff);
  const copies = new Map<number, number>();
  for (const c of included) copies.set(c.timestamp, (copies.get(c.timestamp) ?? 0) + 1);
  const index: HourlyIndex = { valid: new Map(), issues: [], included: included.length };
  included.forEach((candle, i) => {
    const codes: HourlyIssueCode[] = [];
    if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp % intervalMs !== 0)
      codes.push('TIMESTAMP_NOT_HOUR_ALIGNED');
    if (candle.closeTime !== candle.timestamp + closeOffsetMs)
      codes.push('CLOSE_TIME_CONVENTION_MISMATCH');
    // Both copies are refused: duplicates are never deduplicated.
    if ((copies.get(candle.timestamp) ?? 0) > 1) codes.push('DUPLICATE_TIMESTAMP');
    codes.push(...validatePrices(candle, i).map((item) => item.code));
    if (codes.length === 0) index.valid.set(candle.timestamp, candle);
    else index.issues.push(...codes.map((code) => ({ timestamp: candle.timestamp, code })));
  });
  return index;
}

/** `count` consecutive valid candles from `firstOpen`, or null if any hour is absent. */
export function consecutive(
  index: HourlyIndex,
  firstOpen: number,
  count: number,
): HourCandle[] | null {
  const run: HourCandle[] = [];
  for (let k = 0; k < count; k += 1) {
    const candle = index.valid.get(firstOpen + k * HOUR_MS);
    if (!candle) return null;
    run.push(candle);
  }
  return run;
}

// ---------------------------------------------------------------------------------------------
// Features at a decision time T: only candles closed by T

export interface Features {
  rsi: number;
  macdHistogram: number;
  atr: number;
  close: number;
  v: number;
  cell: string;
}

export function featuresAt(
  index: HourlyIndex,
  time: number,
  protocol: Protocol = PROTOCOL,
): Features | null {
  const n = protocol.features.windowCandles;
  const window = consecutive(index, time - n * HOUR_MS, n);
  if (!window) return null;
  const closes = window.map((c) => c.close);
  const r = rsi(closes, RULES.rsiPeriod).at(-1);
  const h = macd(closes, ...RULES.macd).histogram.at(-1);
  const a = atr(
    window.map((c) => c.high),
    window.map((c) => c.low),
    closes,
    RULES.atrPeriod,
  ).at(-1);
  const close = closes.at(-1);
  if (r === undefined || h === undefined || a === undefined || close === undefined) return null;
  if (![r, h, a, close].every(Number.isFinite) || a <= 0) return null;
  let band = 'mid';
  if (r < RULES.rsiLow) band = 'low';
  else if (r > RULES.rsiHigh) band = 'high';
  return {
    rsi: r,
    macdHistogram: h,
    atr: a,
    close,
    v: a / close,
    cell: `${band}/${h > 0 ? 'positive' : 'nonPositive'}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Outcome of one position: target, stop, ambiguous or timeout

export type Category = 'TARGET' | 'STOP' | 'TIMEOUT' | 'AMBIGUOUS';
export const CATEGORIES: readonly Category[] = ['TARGET', 'STOP', 'TIMEOUT', 'AMBIGUOUS'];

/** outcome.scan: the first bar that decides, read in order. */
export function resolveOutcome(
  bars: readonly HourCandle[],
  target: number,
  stop: number,
): { category: Category; exit: number; bar: number } {
  for (const [i, bar] of bars.entries()) {
    if (bar.open <= stop) return { category: 'STOP', exit: bar.open, bar: i + 1 };
    if (bar.open >= target) return { category: 'TARGET', exit: target, bar: i + 1 };
    const hitTarget = bar.high >= target;
    const hitStop = bar.low <= stop;
    // 1h bars cannot order two touches inside one bar; never assume the target came first.
    if (hitTarget && hitStop) return { category: 'AMBIGUOUS', exit: stop, bar: i + 1 };
    if (hitStop) return { category: 'STOP', exit: stop, bar: i + 1 };
    if (hitTarget) return { category: 'TARGET', exit: target, bar: i + 1 };
  }
  const last = bars.at(-1);
  if (!last) throw new Error('resolveOutcome needs at least one bar');
  return { category: 'TIMEOUT', exit: last.close, bar: bars.length };
}

/** costs.netReturn: a TARGET exit is a resting limit, every other fill a market fill. */
export function netReturn(
  entry: number,
  exit: number,
  category: Category,
  protocol: Protocol = PROTOCOL,
): number {
  const { feePerFill: fee, slippagePerMarketFill: slip } = protocol.costs;
  const exitSlip = category === 'TARGET' ? 0 : slip;
  return ((1 - fee) ** 2 * exit * (1 - exitSlip)) / (entry * (1 + slip)) - 1;
}

export const potentialNetGain = (v: number, targetV: number, protocol: Protocol = PROTOCOL) =>
  netReturn(1, 1 + targetV * v, 'TARGET', protocol);

// ---------------------------------------------------------------------------------------------
// Observations

export interface Observation {
  symbol: string;
  time: number;
  day: number;
  cell: string;
  v: number;
  /** One per protocol scenario, in protocol order. */
  outcomes: { category: Category; net: number }[];
}

export interface PairCoverage {
  included: number;
  firstOpen: number | null;
  lastOpen: number | null;
  issues: Record<string, number>;
  decisions: number;
  featuresUnavailable: number;
  outcomeMissing: number;
  observations: number;
}

export const dayOf = (time: number) => Math.floor(time / DAY_MS);

/** Every grid decision whose 24-hour label ended by the cutoff, with its outcome per scenario. */
export function pairObservations(
  symbol: string,
  index: HourlyIndex,
  protocol: Protocol = PROTOCOL,
): { observations: Observation[]; coverage: PairCoverage } {
  const cutoff = ms(protocol.data.collectionCutoff);
  const hours: readonly number[] = protocol.decisions.gridUtcHours;
  const opens = [...index.valid.keys()];
  const issues: Record<string, number> = {};
  for (const { code } of index.issues) issues[code] = (issues[code] ?? 0) + 1;
  const coverage: PairCoverage = {
    included: index.included,
    firstOpen: opens.length ? Math.min(...opens) : null,
    lastOpen: opens.length ? Math.max(...opens) : null,
    issues,
    decisions: 0,
    featuresUnavailable: 0,
    outcomeMissing: 0,
    observations: 0,
  };
  const observations: Observation[] = [];
  for (let time = ms(protocol.decisions.firstDecision); time + DAY_MS <= cutoff; time += HOUR_MS) {
    if (!hours.includes(new Date(time).getUTCHours())) continue;
    coverage.decisions += 1;
    const features = featuresAt(index, time, protocol);
    if (!features) {
      coverage.featuresUnavailable += 1;
      continue;
    }
    const bars = consecutive(index, time, HORIZON_BARS);
    if (!bars) {
      coverage.outcomeMissing += 1;
      continue;
    }
    const entry = bars[0]!.open;
    const outcomes = protocol.scenarios.map(({ targetV, stopV }) => {
      const { category, exit } = resolveOutcome(
        bars,
        entry * (1 + targetV * features.v),
        entry * (1 - stopV * features.v),
      );
      return { category, net: netReturn(entry, exit, category, protocol) };
    });
    observations.push({
      symbol,
      time,
      day: dayOf(time),
      cell: features.cell,
      v: features.v,
      outcomes,
    });
  }
  coverage.observations = observations.length;
  return { observations, coverage };
}

// ---------------------------------------------------------------------------------------------
// Chronological splits

export type Split = 'train' | 'validation' | 'test';

/** splits: the label [T, T + 24h] must lie inside one split, or the decision is purged. */
export function splitOf(time: number, protocol: Protocol = PROTOCOL): Split | null {
  const [b1, b2] = protocol.splits.boundaries.map(ms) as [number, number];
  const end = time + DAY_MS;
  if (time >= ms(protocol.decisions.firstDecision) && end <= b1) return 'train';
  if (time >= b1 && end <= b2) return 'validation';
  if (time >= b2 && end <= ms(protocol.data.collectionCutoff)) return 'test';
  return null;
}

/** First and last decision day a split can hold; bootstrap positions are every day between. */
export function splitDays(split: Split | 'all', protocol: Protocol = PROTOCOL): [number, number] {
  const [b1, b2] = protocol.splits.boundaries.map(ms) as [number, number];
  const first = ms(protocol.decisions.firstDecision);
  const cutoff = ms(protocol.data.collectionCutoff);
  const ranges: Record<Split | 'all', [number, number]> = {
    train: [first, b1],
    validation: [b1, b2],
    test: [b2, cutoff],
    all: [first, cutoff],
  };
  const [start, end] = ranges[split];
  return [dayOf(start), dayOf(end - DAY_MS)];
}

// ---------------------------------------------------------------------------------------------
// The method: conditional empirical frequency, and the base-rate benchmark

export interface CellFit {
  n: number;
  wins: number;
  days: number;
  meanNet: number | null;
  /** null: INSUFFICIENT_EVIDENCE */
  p: number | null;
}

export interface ScenarioFit {
  scenario: string;
  base: { n: number; wins: number; p: number | null };
  cells: Record<string, CellFit>;
}

export function fitFrequencies(
  observations: readonly Observation[],
  protocol: Protocol = PROTOCOL,
): ScenarioFit[] {
  const { observations: minN, distinctDays: minDays } = protocol.estimation.minimumFitEvidence;
  return protocol.scenarios.map(({ id }, s) => {
    const cells = Object.fromEntries(
      CELLS.map((cell) => [cell, { n: 0, wins: 0, net: 0, days: new Set<number>() }]),
    );
    let n = 0;
    let wins = 0;
    for (const o of observations) {
      const outcome = o.outcomes[s]!;
      const cell = cells[o.cell]!;
      const win = outcome.category === 'TARGET' ? 1 : 0;
      cell.n += 1;
      cell.wins += win;
      cell.net += outcome.net;
      cell.days.add(o.day);
      n += 1;
      wins += win;
    }
    return {
      scenario: id,
      base: { n, wins, p: n ? wins / n : null },
      cells: Object.fromEntries(
        Object.entries(cells).map(([key, c]) => [
          key,
          {
            n: c.n,
            wins: c.wins,
            days: c.days.size,
            meanNet: c.n ? c.net / c.n : null,
            p: c.n >= minN && c.days.size >= minDays ? c.wins / c.n : null,
          },
        ]),
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Uncertainty: moving block bootstrap over UTC days

/** Type 7 quantile of unsorted values. */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q * (sorted.length - 1);
  const low = sorted[Math.floor(at)]!;
  return low + (sorted[Math.ceil(at)]! - low) * (at - Math.floor(at));
}

export interface Interval {
  low: number;
  high: number;
  defined: number;
  replicates: number;
}

export function dayOrders(label: string, positions: number, protocol: Protocol = PROTOCOL) {
  return bootstrapOrders(
    protocol.uncertainty.random,
    label,
    RULES.blockDays,
    protocol.uncertainty.replicates,
    positions,
  );
}

/** Interval of Σnumerator ÷ Σdenominator over resampled days; replicates with Σden = 0 are undefined. */
export function ratioInterval(
  orders: readonly (readonly number[])[],
  numerator: ArrayLike<number>,
  denominator: ArrayLike<number>,
  levels: [number, number],
): Interval | null {
  const values: number[] = [];
  for (const order of orders) {
    let num = 0;
    let den = 0;
    for (const i of order) {
      num += numerator[i]!;
      den += denominator[i]!;
    }
    if (den > 0) values.push(num / den);
  }
  if (values.length === 0) return null;
  return {
    low: quantile(values, levels[0]),
    high: quantile(values, levels[1]),
    defined: values.length,
    replicates: orders.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Out-of-sample evaluation of one fit

export interface ScenarioEvaluation {
  scenario: string;
  observations: number;
  counts: Record<Category, number>;
  evaluated: number;
  days: number;
  coverage: number | null;
  brier: {
    method: number | null;
    base: number | null;
    delta: number | null;
    skillScore: number | null;
    interval95: Interval | null;
  };
  calibration: {
    inTheLarge: number | null;
    weightedCellError: number | null;
    cells: { cell: string; n: number; predicted: number | null; observed: number | null }[];
  };
  meanNetReturn: number | null;
}

export function evaluateFit(
  fits: readonly ScenarioFit[],
  observations: readonly Observation[],
  split: Split,
  protocol: Protocol = PROTOCOL,
): ScenarioEvaluation[] {
  const [firstDay, lastDay] = splitDays(split, protocol);
  const positions = lastDay - firstDay + 1;
  const orders = dayOrders(split, positions, protocol);
  return fits.map((fit, s) => {
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
    const deltaByDay = new Float64Array(positions);
    const nByDay = new Float64Array(positions);
    const days = new Set<number>();
    const byCell = new Map<string, { n: number; wins: number }>();
    let net = 0;
    let evaluated = 0;
    let wins = 0;
    let predictedSum = 0;
    let methodSum = 0;
    let baseSum = 0;
    const base = fit.base.p;
    for (const o of observations) {
      const outcome = o.outcomes[s]!;
      counts[outcome.category] += 1;
      net += outcome.net;
      const p = fit.cells[o.cell]?.p ?? null;
      if (p === null || base === null) continue;
      const y = outcome.category === 'TARGET' ? 1 : 0;
      const method = (p - y) ** 2;
      const benchmark = (base - y) ** 2;
      evaluated += 1;
      wins += y;
      predictedSum += p;
      methodSum += method;
      baseSum += benchmark;
      days.add(o.day);
      deltaByDay[o.day - firstDay]! += method - benchmark;
      nByDay[o.day - firstDay]! += 1;
      const cell = byCell.get(o.cell) ?? { n: 0, wins: 0 };
      byCell.set(o.cell, { n: cell.n + 1, wins: cell.wins + y });
    }
    const cells = CELLS.map((cell) => {
      const c = byCell.get(cell);
      return {
        cell,
        n: c?.n ?? 0,
        predicted: fit.cells[cell]?.p ?? null,
        observed: c ? c.wins / c.n : null,
      };
    });
    const methodBrier = evaluated ? methodSum / evaluated : null;
    const baseBrier = evaluated ? baseSum / evaluated : null;
    return {
      scenario: fit.scenario,
      observations: observations.length,
      counts,
      evaluated,
      days: days.size,
      coverage: observations.length ? evaluated / observations.length : null,
      brier: {
        method: methodBrier,
        base: baseBrier,
        delta: methodBrier === null || baseBrier === null ? null : methodBrier - baseBrier,
        skillScore: methodBrier === null || !baseBrier ? null : 1 - methodBrier / baseBrier,
        interval95: evaluated ? ratioInterval(orders, deltaByDay, nByDay, [0.025, 0.975]) : null,
      },
      calibration: {
        inTheLarge: evaluated ? Math.abs(predictedSum / evaluated - wins / evaluated) : null,
        weightedCellError: evaluated
          ? cells.reduce(
              (sum, c) =>
                c.observed === null || c.predicted === null
                  ? sum
                  : sum + c.n * Math.abs(c.predicted - c.observed),
              0,
            ) / evaluated
          : null,
        cells,
      },
      meanNetReturn: observations.length ? net / observations.length : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Support: decided on test only

export type SupportCriterion = 'EVIDENCE' | 'SKILL' | 'CALIBRATION' | 'CONSISTENCY';

export function supportOf(
  test: ScenarioEvaluation,
  validation: ScenarioEvaluation,
): { status: 'SUPPORTED' | 'NOT_SUPPORTED'; failing: SupportCriterion[] } {
  const failing: SupportCriterion[] = [];
  if (
    test.evaluated < RULES.minTestObservations ||
    test.days < RULES.minTestDays ||
    (test.coverage ?? 0) < RULES.minTestCoverage
  )
    failing.push('EVIDENCE');
  const { delta, interval95 } = test.brier;
  if (delta === null || !(delta < 0) || interval95 === null || !(interval95.high < 0))
    failing.push('SKILL');
  const { inTheLarge, weightedCellError } = test.calibration;
  if (
    inTheLarge === null ||
    weightedCellError === null ||
    inTheLarge > RULES.maxCalibrationInTheLarge ||
    weightedCellError > RULES.maxWeightedCellError
  )
    failing.push('CALIBRATION');
  if (validation.brier.delta === null || !(validation.brier.delta < 0)) failing.push('CONSISTENCY');
  return { status: failing.length ? 'NOT_SUPPORTED' : 'SUPPORTED', failing };
}

// ---------------------------------------------------------------------------------------------
// Current candidates and the proposed ranking

export type DisqualifyReason =
  | 'SCENARIO_NOT_SUPPORTED'
  | 'FEATURES_UNAVAILABLE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'NO_NET_GAIN'
  | 'NON_POSITIVE_HISTORICAL_NET';

export interface Candidate {
  symbol: string;
  scenario: string;
  cell: string | null;
  referencePrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  potentialNetGain: number | null;
  probability: number | null;
  probabilityInterval90: Interval | null;
  fitObservations: number | null;
  historicalMeanNet: number | null;
  historicalMeanNetInterval90: Interval | null;
  score: number | null;
  reasons: DisqualifyReason[];
  rank: number | null;
}

export const rankingScore = (p: number, gain: number, protocol: Protocol = PROTOCOL) =>
  protocol.ranking.weights.probability * p +
  (protocol.ranking.weights.netGain * Math.min(Math.max(gain, 0), RULES.netGainCap)) /
    RULES.netGainCap;

/** ranking.order: a total order, so equal scores never depend on input order. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    (b.score ?? -Infinity) - (a.score ?? -Infinity) ||
    (b.probability ?? -Infinity) - (a.probability ?? -Infinity) ||
    (b.potentialNetGain ?? -Infinity) - (a.potentialNetGain ?? -Infinity) ||
    (a.symbol < b.symbol ? -1 : Number(a.symbol > b.symbol)) ||
    (a.scenario < b.scenario ? -1 : Number(a.scenario > b.scenario))
  );
}

/** Ranks the qualifying candidates in place and returns every candidate in ranking order. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const ordered = [...candidates].sort(compareCandidates);
  let rank = 0;
  return ordered.map((c) => ({ ...c, rank: c.reasons.length ? null : (rank += 1) }));
}

export function currentCandidates(
  current: Readonly<Record<string, Features | null>>,
  fits: readonly ScenarioFit[],
  support: readonly { status: string }[],
  intervals: (scenario: number, cell: string) => { p: Interval | null; net: Interval | null },
  protocol: Protocol = PROTOCOL,
): Candidate[] {
  const candidates = Object.entries(current).flatMap(([symbol, features]) =>
    protocol.scenarios.map(({ id, targetV, stopV }, s): Candidate => {
      const reasons: DisqualifyReason[] = [];
      if (support[s]?.status !== 'SUPPORTED') reasons.push('SCENARIO_NOT_SUPPORTED');
      if (!features) {
        reasons.push('FEATURES_UNAVAILABLE');
        return {
          symbol,
          scenario: id,
          cell: null,
          referencePrice: null,
          targetPrice: null,
          stopPrice: null,
          potentialNetGain: null,
          probability: null,
          probabilityInterval90: null,
          fitObservations: null,
          historicalMeanNet: null,
          historicalMeanNetInterval90: null,
          score: null,
          reasons,
          rank: null,
        };
      }
      const cell = fits[s]!.cells[features.cell]!;
      const gain = potentialNetGain(features.v, targetV, protocol);
      if (cell.p === null) reasons.push('INSUFFICIENT_EVIDENCE');
      if (!(gain > 0)) reasons.push('NO_NET_GAIN');
      if (cell.meanNet === null || !(cell.meanNet > 0)) reasons.push('NON_POSITIVE_HISTORICAL_NET');
      const interval = intervals(s, features.cell);
      return {
        symbol,
        scenario: id,
        cell: features.cell,
        referencePrice: features.close,
        targetPrice: features.close * (1 + targetV * features.v),
        stopPrice: features.close * (1 - stopV * features.v),
        potentialNetGain: gain,
        probability: cell.p,
        probabilityInterval90: interval.p,
        fitObservations: cell.n,
        historicalMeanNet: cell.meanNet,
        historicalMeanNetInterval90: interval.net,
        score: cell.p === null ? null : rankingScore(cell.p, gain, protocol),
        reasons,
        rank: null,
      };
    }),
  );
  return rankCandidates(candidates);
}

// ---------------------------------------------------------------------------------------------
// The whole protocol over in-memory candles

export function evaluateProtocol(
  candlesBySymbol: Readonly<Record<string, readonly HourCandle[]>>,
  protocol: Protocol = PROTOCOL,
) {
  const cutoff = ms(protocol.data.collectionCutoff);
  const evaluationTime = ms(protocol.decisions.currentEvaluation);
  const coverage: Record<string, PairCoverage> = {};
  const current: Record<string, Features | null> = {};
  const observations: Observation[] = [];
  for (const symbol of protocol.universe.members) {
    const index = indexHourly(candlesBySymbol[symbol] ?? [], cutoff, protocol);
    const pair = pairObservations(symbol, index, protocol);
    coverage[symbol] = pair.coverage;
    observations.push(...pair.observations);
    current[symbol] = featuresAt(index, evaluationTime, protocol);
  }
  const bySplit = (split: Split) => observations.filter((o) => splitOf(o.time, protocol) === split);
  const train = bySplit('train');
  const validation = bySplit('validation');
  const test = bySplit('test');

  const development = evaluateFit(
    fitFrequencies(train, protocol),
    validation,
    'validation',
    protocol,
  );
  const confirmatoryFit = fitFrequencies([...train, ...validation], protocol);
  const confirmatory = evaluateFit(confirmatoryFit, test, 'test', protocol);
  const support = confirmatory.map((t, s) => supportOf(t, development[s]!));

  // Current fit: every decision whose label ended by the cutoff, purged ones included.
  const currentFit = fitFrequencies(observations, protocol);
  const [firstDay, lastDay] = splitDays('all', protocol);
  const positions = lastDay - firstDay + 1;
  const orders = dayOrders('current', positions, protocol);
  const intervals = (s: number, cell: string) => {
    const n = new Float64Array(positions);
    const wins = new Float64Array(positions);
    const net = new Float64Array(positions);
    for (const o of observations) {
      if (o.cell !== cell) continue;
      const outcome = o.outcomes[s]!;
      n[o.day - firstDay]! += 1;
      wins[o.day - firstDay]! += outcome.category === 'TARGET' ? 1 : 0;
      net[o.day - firstDay]! += outcome.net;
    }
    return {
      p: ratioInterval(orders, wins, n, [0.05, 0.95]),
      net: ratioInterval(orders, net, n, [0.05, 0.95]),
    };
  };
  const candidates = currentCandidates(current, currentFit, support, intervals, protocol);
  const shortlist = candidates.filter((c) => c.rank !== null);
  let verdict: 'SHORTLIST' | 'NO_QUALIFYING_CANDIDATE' | 'INSUFFICIENT_EVIDENCE' = 'SHORTLIST';
  if (!support.some((s) => s.status === 'SUPPORTED')) verdict = 'INSUFFICIENT_EVIDENCE';
  else if (shortlist.length === 0) verdict = 'NO_QUALIFYING_CANDIDATE';

  const splitSummary = (rows: readonly Observation[]) => ({
    observations: rows.length,
    days: new Set(rows.map((o) => o.day)).size,
    firstDecision: rows.length ? new Date(rows[0]!.time).toISOString() : null,
    lastDecision: rows.length ? new Date(Math.max(...rows.map((o) => o.time))).toISOString() : null,
  });
  return {
    protocol: { id: protocol.protocolId, sha256: protocolSha256(protocol) },
    evaluationTime: new Date(evaluationTime).toISOString(),
    coverage,
    splits: {
      train: splitSummary(train),
      validation: splitSummary(validation),
      test: splitSummary(test),
      purged: observations.length - train.length - validation.length - test.length,
      currentFit: splitSummary(observations),
    },
    development,
    confirmatory: confirmatory.map((evaluation, s) => ({ ...evaluation, support: support[s]! })),
    currentFit,
    current: { verdict, candidates, shortlist },
  };
}

export type ProtocolResults = ReturnType<typeof evaluateProtocol>;
