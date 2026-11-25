/**
 * Structure-entry development experiment on protocol v1's saved hourly candles
 * (docs/structure-entry-1h-dev-v1.json, docs/STRUCTURE_ENTRY_1H_DEV_V1.md). Pure functions: source
 * opportunities from candles closed by each source decision, the immediate arm A and the waiting
 * arm B on each, their paired rows, groupings, a paired day-block bootstrap and the specification's
 * verdict. Development research only: no network, account, order, wallet or production store.
 */
import { createHash } from 'node:crypto';
import specJson from '../docs/structure-entry-1h-dev-v1.json';
import { atr } from '@/lib/indicators';
import { stableSerialize } from '@/lib/stableSerialize';
import {
  CATEGORIES,
  consecutive,
  dayOf,
  HOUR_MS,
  indexHourly,
  netReturn,
  quantile,
  ratioInterval,
  type Category,
  type HourCandle,
  type HourlyIndex,
} from './spot24h';
import { scanTrade } from './spot24hBreakout';
import { evaluateSwingStructure, type SwingPivot } from './swingStructure';
import { bootstrapOrders } from './swingStructureEvaluation';

export const SPEC = specJson;
export type Spec = typeof specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');

/** screening.order, as a type; a test checks it against the JSON. */
export const SCREEN_REASONS = [
  'INPUT_UNAVAILABLE',
  'NO_CONFIRMED_LOW',
  'NO_CONFIRMED_HIGH',
  'LOW_ALREADY_BREACHED',
  'NO_SWEEP',
  'NOT_RECLAIMED',
  'CLOSE_NOT_BELOW_HIGH',
  'BIAS_UNAVAILABLE',
  'BIAS_NOT_UP',
  'ATR_UNAVAILABLE',
  'PIVOT_ALREADY_USED',
  'BOUNDARY',
] as const;
export type ScreenReason = (typeof SCREEN_REASONS)[number];

/** armB.noEntryReasons */
export const NO_ENTRY_REASONS = [
  'CANCELLED_SWEEP_LOW_BROKEN',
  'NO_STRUCTURE_BREAK',
  'STRUCTURE_BREAK_NOT_BULLISH',
  'NO_FVG',
  'NO_RETURN',
  'RETURN_BELOW_GAP',
  'ENTRY_OPEN_AT_OR_BELOW_SWEEP_LOW',
  'ENTRY_OPEN_BELOW_GAP',
] as const;
export type NoEntryReason = (typeof NO_ENTRY_REASONS)[number];
export type ArmStatus = 'ENTERED' | 'INVALID_LEVELS' | 'INTEGRITY_FAILURE' | NoEntryReason;

const ms = (iso: string) => Date.parse(iso);
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: readonly number[]) => (values.length ? sum(values) / values.length : null);
const monthOf = (time: number) => new Date(time).toISOString().slice(0, 7);
const countBy = <K extends string>(keys: readonly K[], values: readonly K[]) => {
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const value of values) counts[value] += 1;
  return counts;
};

// ---------------------------------------------------------------------------------------------
// Higher-timeframe bias: complete UTC 4h bars closed by the source decision D

/** bias.window: the 50 bars ending with the latest one closed by D, or null if one is incomplete. */
export function biasBars(index: HourlyIndex, decision: number, spec: Spec = SPEC) {
  const step = spec.bias.intervalMs;
  const last = Math.floor(decision / step) * step - step;
  const bars: HourCandle[] = [];
  for (let k = spec.bias.bars - 1; k >= 0; k -= 1) {
    const open = last - k * step;
    const hours = consecutive(index, open, step / HOUR_MS);
    const first = hours?.[0];
    const final = hours?.at(-1);
    if (!hours || !first || !final) return null;
    bars.push({
      timestamp: open,
      closeTime: open + step - 1,
      open: first.open,
      high: Math.max(...hours.map((h) => h.high)),
      low: Math.min(...hours.map((h) => h.low)),
      close: final.close,
    });
  }
  return bars;
}

export interface Bias {
  reason: string;
  establishedAt: number | null;
  lastBarOpen: number;
}

export function biasAt(
  index: HourlyIndex,
  decision: number,
  spec: Spec = SPEC,
): { reason: 'BIAS_UNAVAILABLE' | 'BIAS_NOT_UP' } | { reason: null; bias: Bias } {
  const bars = biasBars(index, decision, spec);
  const lastBar = bars?.at(-1);
  if (!bars || !lastBar) return { reason: 'BIAS_UNAVAILABLE' };
  const observation = evaluateSwingStructure({
    candles: bars,
    timeframe: { label: spec.bias.timeframe, intervalMs: spec.bias.intervalMs },
    config: { leftBars: spec.bias.leftBars, rightBars: spec.bias.rightBars },
    cutoff: decision - 1,
  });
  if (observation.status !== 'EVALUATED') return { reason: 'BIAS_UNAVAILABLE' };
  if (observation.direction !== 'Up') return { reason: 'BIAS_NOT_UP' };
  return {
    reason: null,
    bias: {
      reason: observation.reason,
      establishedAt: observation.establishedAt,
      lastBarOpen: lastBar.timestamp,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Source opportunity at candle S, frozen at D = open(S) + 1h

export interface Source {
  symbol: string;
  /** Open time of the source candle S. */
  sourceOpen: number;
  /** D: S has closed and S+1 opens. */
  decision: number;
  day: number;
  low: SwingPivot;
  high: SwingPivot;
  sweepLow: number;
  sweepClose: number;
  atr: number;
  bias: Bias;
}

const pivot = ({ kind, price, candleOpenTime, availableAt }: SwingPivot): SwingPivot => ({
  kind,
  price,
  candleOpenTime,
  availableAt,
});

/** structure and screening up to PIVOT_ALREADY_USED; `used` holds this pair's consumed pivot lows. */
export function screenHour(
  symbol: string,
  index: HourlyIndex,
  sourceOpen: number,
  used: Set<number>,
  spec: Spec = SPEC,
): { reason: Exclude<ScreenReason, 'BOUNDARY'> } | { reason: null; source: Source } {
  const n = spec.structure.windowCandles;
  const window = consecutive(index, sourceOpen - n * HOUR_MS, n);
  const s = index.valid.get(sourceOpen);
  if (!window || !s) return { reason: 'INPUT_UNAVAILABLE' };
  const structure = evaluateSwingStructure({
    candles: window,
    timeframe: { label: '1h', intervalMs: HOUR_MS },
    config: { leftBars: spec.structure.leftBars, rightBars: spec.structure.rightBars },
    cutoff: sourceOpen - 1,
  });
  if (structure.status === 'INVALID_INPUT') return { reason: 'INPUT_UNAVAILABLE' };
  const low = structure.supportingLows.at(-1);
  if (!low) return { reason: 'NO_CONFIRMED_LOW' };
  const high = structure.supportingHighs.at(-1);
  if (!high) return { reason: 'NO_CONFIRMED_HIGH' };
  if (window.some((c) => c.timestamp > low.availableAt && c.low < low.price)) {
    return { reason: 'LOW_ALREADY_BREACHED' };
  }
  if (s.low >= low.price) return { reason: 'NO_SWEEP' };
  if (s.close <= low.price) return { reason: 'NOT_RECLAIMED' };
  if (s.close >= high.price) return { reason: 'CLOSE_NOT_BELOW_HIGH' };
  const decision = sourceOpen + HOUR_MS;
  const bias = biasAt(index, decision, spec);
  if (bias.reason) return { reason: bias.reason };
  const atrWindow = [...window.slice(1), s];
  const atrValue = atr(
    atrWindow.map((c) => c.high),
    atrWindow.map((c) => c.low),
    atrWindow.map((c) => c.close),
    spec.structure.atrPeriod,
  ).at(-1);
  if (atrValue === undefined || !Number.isFinite(atrValue) || atrValue <= 0) {
    return { reason: 'ATR_UNAVAILABLE' };
  }
  if (used.has(low.candleOpenTime)) return { reason: 'PIVOT_ALREADY_USED' };
  used.add(low.candleOpenTime);
  return {
    reason: null,
    source: {
      symbol,
      sourceOpen,
      decision,
      day: dayOf(decision),
      low: pivot(low),
      high: pivot(high),
      sweepLow: s.low,
      sweepClose: s.close,
      atr: atrValue,
      bias: bias.bias,
    },
  };
}

/** periods.admission: the period holding D and the whole 36-hour follow-up, or null. */
export function periodOf(decision: number, spec: Spec = SPEC): string | null {
  const followUp = spec.periods.followUpHours * HOUR_MS;
  return (
    spec.periods.list.find((p) => ms(p.start) <= decision && decision + followUp <= ms(p.end))
      ?.id ?? null
  );
}

export type AdmittedSource = Source & { period: string };

/** Every hour of one pair in timing.scan order, with its screening reason or admitted source. */
export function pairSources(symbol: string, index: HourlyIndex, spec: Spec = SPEC) {
  const counts = countBy(SCREEN_REASONS, []);
  const sources: AdmittedSource[] = [];
  const used = new Set<number>();
  const first = ms(spec.timing.firstDecision) - HOUR_MS;
  const last = ms(spec.timing.lastCandleClose) - HOUR_MS;
  let hours = 0;
  for (let open = first; open <= last; open += HOUR_MS) {
    hours += 1;
    const screened = screenHour(symbol, index, open, used, spec);
    if (screened.reason) {
      counts[screened.reason] += 1;
      continue;
    }
    const period = periodOf(screened.source.decision, spec);
    if (period) sources.push({ ...screened.source, period });
    else counts.BOUNDARY += 1;
  }
  return { hours, counts, sources };
}

// ---------------------------------------------------------------------------------------------
// Arms: entry, identical exits, v1's costs

export interface Arm {
  status: ArmStatus;
  /** Open time of the entry candle, when the arm entered. */
  entryOpen: number | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  category: Category | null;
  /** Close boundary of the exit candle. */
  exitTime: number | null;
  holdingCandles: number | null;
  gapStop: boolean;
  /** Per source: 0 when the arm did not enter (uninvested cash). */
  gross: number;
  net: number;
  /** The first missing hour, for INTEGRITY_FAILURE. */
  missingOpen: number | null;
}

const NOT_ENTERED = {
  entryOpen: null,
  entry: null,
  stop: null,
  target: null,
  category: null,
  exitTime: null,
  holdingCandles: null,
  gapStop: false,
  gross: 0,
  net: 0,
  missingOpen: null,
} as const;

const notEntered = (status: ArmStatus, missingOpen: number | null = null): Arm => ({
  ...NOT_ENTERED,
  status,
  missingOpen,
});

/** exits: levels from the entry candle's open and the frozen ATR, then v1's scan from that candle. */
export function enter(
  index: HourlyIndex,
  candle: HourCandle,
  atrValue: number,
  spec: Spec = SPEC,
): Arm {
  const entry = candle.open;
  const stop = entry - spec.exits.stopAtrMultiple * atrValue;
  const target = entry + spec.exits.targetAtrMultiple * atrValue;
  if (stop <= 0) return notEntered('INVALID_LEVELS');
  const scan = scanTrade(index, candle.timestamp, stop, target, spec.exits.holdingCandles);
  if (scan.status === 'MISSING') return notEntered('INTEGRITY_FAILURE', scan.missingOpen);
  return {
    status: 'ENTERED',
    entryOpen: candle.timestamp,
    entry,
    stop,
    target,
    category: scan.category,
    exitTime: candle.timestamp + scan.candles.length * HOUR_MS,
    holdingCandles: scan.candles.length,
    gapStop: scan.gapStop,
    gross: scan.exit / entry - 1,
    net: netReturn(entry, scan.exit, scan.category),
    missingOpen: null,
  };
}

/** armA: market entry at the open of S+1. */
export function armA(index: HourlyIndex, source: Source, spec: Spec = SPEC): Arm {
  const candle = index.valid.get(source.decision);
  if (!candle) return notEntered('INTEGRITY_FAILURE', source.decision);
  return enter(index, candle, source.atr, spec);
}

export interface Gap {
  low: number;
  high: number;
  /** Close time of C: the gap exists only from then on. */
  availableAt: number;
}

export interface ArmB extends Arm {
  /** Offsets from S of the structure break M, gap candle C, return J and entry E, where reached. */
  offsets: { m: number | null; c: number | null; j: number | null; e: number | null };
  gap: Gap | null;
  /** Offset of the candle that decided a no-entry, cancellation or expiry. */
  decidedAt: number | null;
  /** Hours from D to E's open, for an entry. */
  waitingHours: number | null;
}

/** armB.read: a candle, or the arm's end if it is missing or breaks the sweep low (checked first). */
function reader(index: HourlyIndex, source: Source) {
  return (k: number): HourCandle | Arm => {
    const open = source.sourceOpen + k * HOUR_MS;
    const candle = index.valid.get(open);
    if (!candle) return notEntered('INTEGRITY_FAILURE', open);
    if (candle.low <= source.sweepLow) return notEntered('CANCELLED_SWEEP_LOW_BROKEN');
    return candle;
  };
}

type Read = ReturnType<typeof reader>;
interface Stop {
  stop: Arm;
  at: number;
}

/** armB.structureBreak: M and the candle before it, or the arm's end by S+6. */
function structureBreak(
  index: HourlyIndex,
  source: Source,
  read: Read,
  last: number,
): { m: number; beforeM: HourCandle } | Stop {
  let beforeM = index.valid.get(source.sourceOpen);
  if (!beforeM) throw new Error('A source needs its own candle S');
  for (let k = 1; k <= last; k += 1) {
    const candle = read(k);
    if ('status' in candle) return { stop: candle, at: k };
    if (candle.close > source.high.price) {
      if (candle.close <= candle.open) {
        return { stop: notEntered('STRUCTURE_BREAK_NOT_BULLISH'), at: k };
      }
      return { m: k, beforeM };
    }
    beforeM = candle;
  }
  return { stop: notEntered('NO_STRUCTURE_BREAK'), at: last };
}

/** armB.return: the first candle after C touching G_high is the only return. */
function firstReturn(
  read: Read,
  gap: Gap,
  from: number,
  last: number,
): { j: number; stop: null } | { j: number | null; stop: Arm; at: number } {
  for (let k = from; k <= last; k += 1) {
    const candle = read(k);
    if ('status' in candle) return { j: null, stop: candle, at: k };
    if (candle.low <= gap.high) {
      if (candle.open < gap.low || candle.close < gap.low) {
        return { j: k, stop: notEntered('RETURN_BELOW_GAP'), at: k };
      }
      return { j: k, stop: null };
    }
  }
  return { j: null, stop: notEntered('NO_RETURN'), at: last };
}

/** armB.entry: only E's open decides, then the shared exit policy. */
function entryAt(index: HourlyIndex, source: Source, gap: Gap, e: number, spec: Spec): Arm {
  const open = source.sourceOpen + e * HOUR_MS;
  const candle = index.valid.get(open);
  if (!candle) return notEntered('INTEGRITY_FAILURE', open);
  if (candle.open <= source.sweepLow) return notEntered('ENTRY_OPEN_AT_OR_BELOW_SWEEP_LOW');
  if (candle.open < gap.low) return notEntered('ENTRY_OPEN_BELOW_GAP');
  return enter(index, candle, source.atr, spec);
}

/** armB: structure break, then the one triplet's gap, then its first return and the next open. */
export function armB(index: HourlyIndex, source: Source, spec: Spec = SPEC): ArmB {
  const read = reader(index, source);
  const offsets: ArmB['offsets'] = { m: null, c: null, j: null, e: null };
  let gap: Gap | null = null;
  const done = (arm: Arm, decidedAt: number, waitingHours: number | null = null): ArmB => ({
    ...arm,
    offsets: { ...offsets },
    gap,
    decidedAt,
    waitingHours,
  });

  const found = structureBreak(index, source, read, spec.armB.structureBreakLastOffset);
  if ('stop' in found) return done(found.stop, found.at);
  const { m, beforeM } = found;
  offsets.m = m;

  const c = read(m + 1);
  offsets.c = m + 1;
  if ('status' in c) return done(c, m + 1);
  if (beforeM.high >= c.low) return done(notEntered('NO_FVG'), m + 1);
  gap = { low: beforeM.high, high: c.low, availableAt: c.closeTime };

  const returned = firstReturn(read, gap, m + 2, spec.armB.returnLastOffset);
  offsets.j = returned.j;
  if (returned.stop) return done(returned.stop, returned.at);
  const e = returned.j + 1;
  offsets.e = e;
  const arm = entryAt(index, source, gap, e, spec);
  return done(arm, e, arm.status === 'ENTERED' ? returned.j : null);
}

// ---------------------------------------------------------------------------------------------
// Paired rows and their summaries

export interface PairedRow {
  source: AdmittedSource;
  a: Arm;
  b: ArmB;
  difference: { net: number; gross: number };
}

export function pairedRow(index: HourlyIndex, source: AdmittedSource, spec: Spec = SPEC) {
  const a = armA(index, source, spec);
  const b = armB(index, source, spec);
  return {
    source,
    a,
    b,
    difference: { net: b.net - a.net, gross: b.gross - a.gross },
  } satisfies PairedRow;
}

const ARM_STATUSES: readonly ArmStatus[] = [
  'ENTERED',
  'INVALID_LEVELS',
  'INTEGRITY_FAILURE',
  ...NO_ENTRY_REASONS,
];

function armSummary(rows: readonly PairedRow[], arm: (row: PairedRow) => Arm) {
  const arms = rows.map(arm);
  const entered = rows.filter((r) => arm(r).status === 'ENTERED').map(arm);
  return {
    entries: entered.length,
    entryDays: new Set(rows.filter((r) => arm(r).status === 'ENTERED').map((r) => r.source.day))
      .size,
    fillRate: rows.length ? entered.length / rows.length : null,
    meanGrossPerSource: mean(arms.map((a) => a.gross)),
    meanNetPerSource: mean(arms.map((a) => a.net)),
    meanGrossPerTrade: mean(entered.map((a) => a.gross)),
    meanNetPerTrade: mean(entered.map((a) => a.net)),
    exits: countBy(
      CATEGORIES,
      entered.flatMap((a) => (a.category ? [a.category] : [])),
    ),
    gapStops: entered.filter((a) => a.gapStop).length,
    statuses: countBy(
      ARM_STATUSES,
      arms.map((a) => a.status),
    ),
  };
}

/** reporting.perGroup */
export function groupSummary(rows: readonly PairedRow[]) {
  const differences = rows.map((r) => r.difference.net);
  return {
    sources: rows.length,
    days: new Set(rows.map((r) => r.source.day)).size,
    a: armSummary(rows, (r) => r.a),
    b: armSummary(rows, (r) => r.b),
    paired: {
      meanNetDifference: mean(differences),
      meanGrossDifference: mean(rows.map((r) => r.difference.gross)),
      bBetter: differences.filter((d) => d > 0).length,
      bWorse: differences.filter((d) => d < 0).length,
      equal: differences.filter((d) => d === 0).length,
    },
  };
}
export type GroupSummary = ReturnType<typeof groupSummary>;

function groupBy(rows: readonly PairedRow[], key: (row: PairedRow) => string) {
  const groups = new Map<string, PairedRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return Object.fromEntries(
    [...groups.keys()]
      .sort((a, b) => (a < b ? -1 : 1))
      .map((k) => [k, groupSummary(groups.get(k) ?? [])]),
  );
}

/** reporting.waiting: B's entries only. */
export function waitingOf(rows: readonly PairedRow[]) {
  const entered = rows.filter((r) => r.b.status === 'ENTERED');
  const hours = entered.flatMap((r) => (r.b.waitingHours === null ? [] : [r.b.waitingHours]));
  const histogram = (values: readonly (number | null)[]) => {
    const counts: Record<string, number> = {};
    for (const v of values) if (v !== null) counts[String(v)] = (counts[String(v)] ?? 0) + 1;
    return counts;
  };
  return {
    entries: entered.length,
    hours: histogram(hours),
    meanHours: mean(hours),
    medianHours: hours.length ? quantile(hours, 0.5) : null,
    structureBreakOffsets: histogram(rows.map((r) => r.b.offsets.m)),
    gapOffsets: histogram(rows.map((r) => (r.b.gap ? r.b.offsets.c : null))),
    returnOffsets: histogram(rows.map((r) => r.b.offsets.j)),
  };
}

/** reporting.concentration: arithmetic on the paired net differences, not a re-run. */
export function concentrationOf(rows: readonly PairedRow[]) {
  const differences = rows.map((r) => r.difference.net);
  const total = sum(differences);
  const largest = [...differences].sort((a, b) => b - a);
  const pairs = new Map<string, number[]>();
  for (const r of rows)
    pairs.set(r.source.symbol, [...(pairs.get(r.source.symbol) ?? []), r.difference.net]);
  const byPair = [...pairs.entries()]
    .map(([symbol, values]) => ({
      symbol,
      sources: values.length,
      sum: sum(values),
      mean: sum(values) / values.length,
    }))
    .sort((a, b) => b.sum - a.sum || (a.symbol < b.symbol ? -1 : 1));
  const positive = sum(differences.filter((d) => d > 0));
  return {
    total,
    nonZero: differences.filter((d) => d !== 0).length,
    bestPair: byPair[0]?.symbol ?? null,
    withoutBestPair: total - (byPair[0]?.sum ?? 0),
    withoutLargest: Object.fromEntries(
      [1, 5, 10].map((k) => [String(k), total - sum(largest.slice(0, k))]),
    ),
    pairsWithPositiveMean: byPair.filter((p) => p.mean > 0).length,
    pairs: byPair.length,
    largestTenShareOfPositive:
      positive > 0 ? sum(largest.slice(0, 10).filter((d) => d > 0)) / positive : null,
    byPair,
  };
}

// ---------------------------------------------------------------------------------------------
// Uncertainty: paired moving block bootstrap over UTC source days

export interface Window {
  id: string;
  start: number;
  end: number;
}

export type BootstrapInterval =
  | { status: 'AVAILABLE'; low: number; high: number; defined: number; replicates: number }
  | { status: 'UNAVAILABLE'; defined: number; replicates: number };

export function windowsOf(spec: Spec = SPEC): Window[] {
  const all = {
    id: 'all',
    start: ms(spec.timing.firstDecision),
    end: ms(spec.timing.lastCandleClose),
  };
  return [all, ...spec.periods.list.map((p) => ({ id: p.id, start: ms(p.start), end: ms(p.end) }))];
}

/** uncertainty: one grid of day positions, common draws for every quantity. */
export function intervalsOf(rows: readonly PairedRow[], window: Window, spec: Spec = SPEC) {
  const u = spec.uncertainty;
  const first = dayOf(window.start);
  const positions = dayOf(window.end - spec.periods.followUpHours * HOUR_MS) - first + 1;
  const count = new Float64Array(positions);
  const difference = new Float64Array(positions);
  const bNet = new Float64Array(positions);
  const aNet = new Float64Array(positions);
  for (const row of rows) {
    const i = row.source.day - first;
    if (i < 0 || i >= positions) throw new Error(`Source day outside window ${window.id}`);
    count[i] = (count[i] ?? 0) + 1;
    difference[i] = (difference[i] ?? 0) + row.difference.net;
    bNet[i] = (bNet[i] ?? 0) + row.b.net;
    aNet[i] = (aNet[i] ?? 0) + row.a.net;
  }
  // With no source every replicate is undefined; drawing them would change nothing.
  const orders = rows.length
    ? bootstrapOrders(u.random, window.id, u.blockDays, u.replicates, positions)
    : [];
  const levels = [u.levels[0] ?? Number.NaN, u.levels[1] ?? Number.NaN] as [number, number];
  const interval = (numerator: Float64Array): BootstrapInterval => {
    const r = ratioInterval(orders, numerator, count, levels);
    const defined = r?.defined ?? 0;
    if (!r || defined < u.minimumDefinedReplicates) {
      return { status: 'UNAVAILABLE', defined, replicates: u.replicates };
    }
    return { status: 'AVAILABLE', low: r.low, high: r.high, defined, replicates: u.replicates };
  };
  return {
    window: window.id,
    positions,
    difference: interval(difference),
    bNet: interval(bNet),
    aNet: interval(aNet),
  };
}
export type Intervals = ReturnType<typeof intervalsOf>;

// ---------------------------------------------------------------------------------------------
// Decision

export type Verdict =
  | 'INTEGRITY_FAILURE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CANDIDATE_FOR_INDEPENDENT_VALIDATION'
  | 'NEGATIVE'
  | 'INCONCLUSIVE';

export type PointCharacter = 'NO_IMPROVEMENT' | 'LOSS_REDUCED_ONLY' | 'POSITIVE_NET';

export function pointCharacterOf(difference: number | null, bNet: number | null) {
  if (difference === null || bNet === null) return null;
  if (difference <= 0) return 'NO_IMPROVEMENT';
  return bNet > 0 ? 'POSITIVE_NET' : 'LOSS_REDUCED_ONLY';
}

const positive = (value: number | null | undefined) =>
  value !== null && value !== undefined && value > 0;

/** decision.rules, in order. */
export function conclude(
  input: {
    integrityFailures: number;
    all: GroupSummary | null;
    periods: Record<string, GroupSummary>;
    pooled: Intervals | null;
  },
  spec: Spec = SPEC,
) {
  const d = spec.decision;
  const { all, pooled } = input;
  const evidence = all && {
    sources: all.sources,
    sourceDays: all.days,
    bEntries: all.b.entries,
    bEntryDays: all.b.entryDays,
  };
  const pointCharacter = all
    ? pointCharacterOf(all.paired.meanNetDifference, all.b.meanNetPerSource)
    : null;
  const base = { evidence, pointCharacter, negativeBecause: [] as string[] };
  if (input.integrityFailures > 0 || !all || !evidence || !pooled) {
    return { ...base, verdict: 'INTEGRITY_FAILURE' as Verdict };
  }
  if (
    evidence.sources < d.minimumSources ||
    evidence.sourceDays < d.minimumSourceDays ||
    evidence.bEntries < d.minimumBEntries ||
    evidence.bEntryDays < d.minimumBEntryDays
  ) {
    return { ...base, verdict: 'INSUFFICIENT_EVIDENCE' as Verdict };
  }
  const { difference, bNet } = pooled;
  const periodsPositive = ['validation', 'test'].every((id) => {
    const p = input.periods[id];
    return positive(p?.paired.meanNetDifference) && positive(p?.b.meanNetPerSource);
  });
  if (
    difference.status === 'AVAILABLE' &&
    bNet.status === 'AVAILABLE' &&
    difference.low > 0 &&
    bNet.low > 0 &&
    periodsPositive
  ) {
    return { ...base, verdict: 'CANDIDATE_FOR_INDEPENDENT_VALIDATION' as Verdict };
  }
  const negativeBecause = [
    ...(difference.status === 'AVAILABLE' && difference.high < 0 ? ['PAIRED_DIFFERENCE'] : []),
    ...(bNet.status === 'AVAILABLE' && bNet.high < 0 ? ['B_NET_PER_SOURCE'] : []),
  ];
  if (negativeBecause.length) return { ...base, negativeBecause, verdict: 'NEGATIVE' as Verdict };
  return { ...base, verdict: 'INCONCLUSIVE' as Verdict };
}

// ---------------------------------------------------------------------------------------------
// The study

const iso = (time: number | null) => (time === null ? null : new Date(time).toISOString());

/** One admitted source as written to the result file. */
const rowRecord = ({ source, a, b, difference }: PairedRow) => ({
  symbol: source.symbol,
  period: source.period,
  sourceOpen: iso(source.sourceOpen),
  decision: iso(source.decision),
  low: source.low,
  high: source.high,
  sweepLow: source.sweepLow,
  sweepClose: source.sweepClose,
  atr: source.atr,
  bias: source.bias,
  a,
  b,
  difference,
});

export function structureEntryStudy(
  candles: Readonly<Record<string, readonly HourCandle[]>>,
  members: readonly string[],
  spec: Spec = SPEC,
) {
  const cutoff = ms(spec.timing.lastCandleClose);
  const byPair: Record<
    string,
    { hours: number; candleIssues: number; counts: Record<ScreenReason, number> }
  > = {};
  const rows: PairedRow[] = [];
  for (const symbol of members) {
    const index = indexHourly(candles[symbol] ?? [], cutoff);
    const { hours, counts, sources } = pairSources(symbol, index, spec);
    byPair[symbol] = { hours, candleIssues: index.issues.length, counts };
    rows.push(...sources.map((source) => pairedRow(index, source, spec)));
  }
  rows.sort(
    (x, y) => x.source.decision - y.source.decision || (x.source.symbol < y.source.symbol ? -1 : 1),
  );
  const screening = {
    hours: sum(Object.values(byPair).map((p) => p.hours)),
    counts: Object.fromEntries(
      SCREEN_REASONS.map((r) => [r, sum(Object.values(byPair).map((p) => p.counts[r]))]),
    ) as Record<ScreenReason, number>,
    admitted: rows.length,
    byPair,
  };
  const failures = rows.filter(
    (r) => r.a.status === 'INTEGRITY_FAILURE' || r.b.status === 'INTEGRITY_FAILURE',
  );
  const specification = { id: spec.specificationId, sha256: specSha256(spec) };
  if (failures.length > 0) {
    return {
      specification,
      screening,
      integrityFailures: failures.map(rowRecord),
      statistics: null,
      conclusion: conclude(
        { integrityFailures: failures.length, all: null, periods: {}, pooled: null },
        spec,
      ),
      rows: rows.map(rowRecord),
    };
  }
  const all = groupSummary(rows);
  const periods = Object.fromEntries(
    spec.periods.list.map((p) => [
      p.id,
      groupSummary(rows.filter((r) => r.source.period === p.id)),
    ]),
  );
  const uncertainty = windowsOf(spec).map((w) =>
    intervalsOf(w.id === 'all' ? rows : rows.filter((r) => r.source.period === w.id), w, spec),
  );
  return {
    specification,
    screening,
    integrityFailures: [],
    statistics: {
      all,
      periods,
      months: groupBy(rows, (r) => monthOf(r.source.decision)),
      pairs: groupBy(rows, (r) => r.source.symbol),
      waiting: waitingOf(rows),
      concentration: concentrationOf(rows),
      uncertainty,
    },
    conclusion: conclude(
      { integrityFailures: 0, all, periods, pooled: uncertainty[0] ?? null },
      spec,
    ),
    rows: rows.map(rowRecord),
  };
}
export type StudyResults = ReturnType<typeof structureEntryStudy>;
