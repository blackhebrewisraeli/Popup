/**
 * Stage D of the 24-hour Spot decision contract (docs/spot-24h-expected-net-t3s3-dev-v1.json,
 * docs/SPOT_24H_DECISION_CONTRACT.md). Pure functions over candles and rows in memory: the joined
 * T3S3 observations, v1 parity, the U and V1 forecasters, the restricted expected-net plug-in for
 * U and C (C's probabilities come from scripts/expected_net_classifier.py), every metric,
 * interval and gate, and the verdict. v1's and #220's code is called, never changed. No network,
 * account, order or production store. Every return figure is simulated research.
 */
import { createHash } from 'node:crypto';
import specJson from '../docs/spot-24h-expected-net-t3s3-dev-v1.json';
import { stableSerialize } from '@/lib/stableSerialize';
import { decisionAt, decisionTimes, FEATURES } from './quantileForecast';
import {
  CELLS,
  consecutive,
  dayOf,
  dayOrders,
  evaluateFit,
  extent,
  featuresAt,
  fitFrequencies,
  HORIZON_BARS,
  HOUR_MS,
  indexHourly,
  netReturn,
  pairObservations,
  PROTOCOL,
  quantile,
  ratioInterval,
  resolveOutcome,
  splitDays,
  splitOf,
  type Category,
  type HourCandle,
  type Interval,
  type Observation,
  type Protocol,
  type ProtocolResults,
  type Split,
} from './spot24h';
import { decompose } from './spot24hDiagnostic';

export const SPEC = specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');

const SCENARIO = SPEC.outcome.scenario;
const CUTOFF = Date.parse(PROTOCOL.data.collectionCutoff);

/** parity: protocol v1 with T3S3 only, keeping v1's own uncertainty settings. */
export const V1_T3S3: Protocol = { ...PROTOCOL, scenarios: [SCENARIO] };
/** uncertainty: v1's dayOrders with this specification's replicates and seed, nothing else. */
export const STUDY: Protocol = {
  ...V1_T3S3,
  uncertainty: {
    ...PROTOCOL.uncertainty,
    replicates: SPEC.uncertainty.replicates,
    random: { ...PROTOCOL.uncertainty.random, seed: SPEC.uncertainty.random.seed },
  },
};
const LEVELS: [number, number] = [SPEC.uncertainty.levels[0]!, SPEC.uncertainty.levels[1]!];

/** Numbers the specification states in prose; a test checks each against its text. */
export const RULES = {
  /** metrics.sensitivities.targetOvershoot */
  overshoot: 1.0005,
  /** scoring.coverage */
  minCoverage: 0.95,
  /** metrics.expectedNetCalibration.labels */
  minSelected: 300,
  minSelectedDays: 30,
  /** metrics.probabilityCalibration.limits */
  maxInTheLarge: 0.03,
  maxDecileError: 0.05,
  /** gate.insufficientEvidence entryFloor */
  floor: { entries: 300, days: 30, months: 3 },
  /** metrics.probabilityCalibration.deciles */
  deciles: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
  /** parity.tolerance */
  parityTolerance: 1e-12,
} as const;
const TOLERANCE = SPEC.metrics.expectedNetCalibration.tolerance;

export const CLASSES = ['TARGET', 'STOP', 'TIMEOUT'] as const;
export type Klass = (typeof CLASSES)[number];
export type Probabilities = [number, number, number];
/** outcome.classes.mapping: AMBIGUOUS is a STOP for the classifier, and only there. */
export const classOf = (category: Category): Klass =>
  category === 'AMBIGUOUS' ? 'STOP' : category;

export const EXCLUSIONS = [
  'FEATURE_WINDOW_UNAVAILABLE',
  'FEATURES_NOT_FINITE',
  'VOLATILITY_NOT_POSITIVE',
  'LABEL_WINDOW_UNAVAILABLE',
  'V1_FEATURES_UNAVAILABLE',
] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];

export const COLUMNS = [
  'symbol',
  'time',
  'split',
  ...FEATURES,
  'cell',
  'v',
  'outcome',
  'class',
  'bar',
  'gross',
  'net',
  'overshootOutcome',
  'overshootBar',
  'overshootGross',
  'overshootNet',
  'orderingNet',
] as const;

// ---------------------------------------------------------------------------------------------
// Joined observations

export interface Outcome {
  category: Category;
  bar: number;
  gross: number;
  net: number;
}

export interface Row {
  symbol: string;
  time: number;
  split: Split | null;
  features: number[];
  cell: string;
  v: number;
  outcome: Outcome;
  class: Klass;
  overshoot: Outcome;
  orderingNet: number;
}

/** outcome and metrics.sensitivities: the primary record and the two sensitivity bookings. */
export function outcomesOf(bars: readonly HourCandle[], v: number) {
  const entry = bars[0]!.open;
  // v1's own expressions (pairObservations), so the levels are bit-identical.
  const target = entry * (1 + SCENARIO.targetV * v);
  const stop = entry * (1 - SCENARIO.stopV * v);
  const book = (category: Category, exit: number, bar: number): Outcome => ({
    category,
    bar,
    gross: decompose(entry, exit, category).gross,
    net: netReturn(entry, exit, category),
  });
  const primary = resolveOutcome(bars, target, stop);
  const over = resolveOutcome(bars, target * RULES.overshoot, stop);
  const outcome = book(primary.category, primary.exit, primary.bar);
  return {
    outcome,
    overshoot: book(over.category, over.category === 'TARGET' ? target : over.exit, over.bar),
    orderingNet:
      primary.category === 'AMBIGUOUS' ? netReturn(entry, target, 'TARGET') : outcome.net,
  };
}

const noExclusions = () =>
  Object.fromEntries(EXCLUSIONS.map((reason) => [reason, 0])) as Record<Exclusion, number>;

/** exclusions.rule, then the observation: #220's features, v1's cell and v, the outcomes. */
export function pairRows(symbol: string, candles: readonly HourCandle[], times = decisionTimes()) {
  const index = indexHourly(candles, CUTOFF);
  const candleIssues: Record<string, number> = {};
  for (const { code } of index.issues) candleIssues[code] = (candleIssues[code] ?? 0) + 1;
  const exclusions = noExclusions();
  const rows: Row[] = [];
  for (const time of times) {
    const decision = decisionAt(index, time);
    if ('exclusion' in decision) {
      exclusions[decision.exclusion] += 1;
      continue;
    }
    const v1 = featuresAt(index, time);
    if (!v1) {
      exclusions.V1_FEATURES_UNAVAILABLE += 1;
      continue;
    }
    if (v1.v !== decision.features.atr14OverClose) {
      throw new Error(`${symbol} ${new Date(time).toISOString()}: v differs from atr14OverClose`);
    }
    const bars = consecutive(index, time, HORIZON_BARS)!;
    const { outcome, overshoot, orderingNet } = outcomesOf(bars, v1.v);
    rows.push({
      symbol,
      time,
      split: splitOf(time),
      features: FEATURES.map((feature) => decision.features[feature]),
      cell: v1.cell,
      v: v1.v,
      outcome,
      class: classOf(outcome.category),
      overshoot,
      orderingNet,
    });
  }
  return {
    rows,
    coverage: {
      candlesIncluded: index.included,
      candleIssues,
      decisions: times.length,
      observations: rows.length,
      exclusions,
    },
  };
}

/** Every pair's rows, ordered by T and then by v1's member order (decisions.order). */
export function exportRows(
  candles: Readonly<Record<string, readonly HourCandle[]>>,
  members: readonly string[],
) {
  const pairs = members.map((symbol) => ({ symbol, ...pairRows(symbol, candles[symbol] ?? []) }));
  const rank = new Map(members.map((symbol, i) => [symbol, i]));
  const rows = pairs
    .flatMap((pair) => pair.rows)
    .sort((a, b) => a.time - b.time || rank.get(a.symbol)! - rank.get(b.symbol)!);
  const total = { decisions: 0, observations: 0, exclusions: noExclusions() };
  for (const { coverage } of pairs) {
    total.decisions += coverage.decisions;
    total.observations += coverage.observations;
    for (const reason of EXCLUSIONS) total.exclusions[reason] += coverage.exclusions[reason];
  }
  return {
    rows,
    coverage: { pairs: Object.fromEntries(pairs.map((p) => [p.symbol, p.coverage])), total },
  };
}

export type ColumnValue = string | number | null;

export const toColumns = (r: Row): ColumnValue[] => [
  r.symbol,
  r.time,
  r.split,
  ...r.features,
  r.cell,
  r.v,
  r.outcome.category,
  r.class,
  r.outcome.bar,
  r.outcome.gross,
  r.outcome.net,
  r.overshoot.category,
  r.overshoot.bar,
  r.overshoot.gross,
  r.overshoot.net,
  r.orderingNet,
];

export function fromColumns(values: readonly ColumnValue[]): Row {
  const n = FEATURES.length;
  const at = (i: number) => values[i] as number;
  return {
    symbol: values[0] as string,
    time: at(1),
    split: values[2] as Split | null,
    features: values.slice(3, 3 + n) as number[],
    cell: values[3 + n] as string,
    v: at(4 + n),
    outcome: {
      category: values[5 + n] as Category,
      bar: at(7 + n),
      gross: at(8 + n),
      net: at(9 + n),
    },
    class: values[6 + n] as Klass,
    overshoot: {
      category: values[10 + n] as Category,
      bar: at(11 + n),
      gross: at(12 + n),
      net: at(13 + n),
    },
    orderingNet: at(14 + n),
  };
}

// ---------------------------------------------------------------------------------------------
// v1 parity

/** Paths where `actual` differs from `expected`: integers and nulls exactly, else within 1e-12. */
export function differences(actual: unknown, expected: unknown, path = '$'): string[] {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const exact = Number.isInteger(actual) && Number.isInteger(expected);
    const same = exact ? actual === expected : Math.abs(actual - expected) <= RULES.parityTolerance;
    return same ? [] : [path];
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
    return [...keys].flatMap((key) => differences(a[key], e[key], `${path}.${key}`));
  }
  return Object.is(actual, expected) ? [] : [path];
}

export type RecordedV1 = Pick<ProtocolResults, 'splits' | 'development' | 'confirmatory'>;

/** parity: exported outcomes, split sizes and both recorded T3S3 evaluations. */
export function v1Parity(
  candles: Readonly<Record<string, readonly HourCandle[]>>,
  members: readonly string[],
  rows: readonly Row[],
  recorded: RecordedV1,
) {
  const observations = members.flatMap(
    (symbol) =>
      pairObservations(symbol, indexHourly(candles[symbol] ?? [], CUTOFF), V1_T3S3).observations,
  );
  const v1 = new Map(observations.map((o) => [`${o.symbol}|${o.time}`, o.outcomes[0]!]));
  const unmatched = rows.filter((r) => {
    const o = v1.get(`${r.symbol}|${r.time}`);
    return o?.category !== r.outcome.category || o.net !== r.outcome.net;
  }).length;
  const inSplit = (split: Split) => observations.filter((o) => splitOf(o.time) === split);
  const [train, validation, test] = (['train', 'validation', 'test'] as const).map(inSplit);
  const splits = {
    train: train!.length,
    validation: validation!.length,
    test: test!.length,
    purged: observations.length - train!.length - validation!.length - test!.length,
  };
  const development = evaluateFit(
    fitFrequencies(train!, V1_T3S3),
    validation!,
    'validation',
    V1_T3S3,
  )[0];
  const confirmatory = evaluateFit(
    fitFrequencies([...train!, ...validation!], V1_T3S3),
    test!,
    'test',
    V1_T3S3,
  )[0];
  const recordedConfirmatory = recorded.confirmatory[0];
  // The recorded confirmatory entry adds v1's gate fields, which belong to six scenarios.
  const recordedT3S3 =
    recordedConfirmatory &&
    Object.fromEntries(
      Object.entries(recordedConfirmatory).filter(
        ([key]) => key !== 'support' && key !== 'expectancy',
      ),
    );
  const found = [
    ...(unmatched ? [`$.observations: ${unmatched} exported outcomes differ from v1`] : []),
    ...differences(splits, {
      train: recorded.splits.train.observations,
      validation: recorded.splits.validation.observations,
      test: recorded.splits.test.observations,
      purged: recorded.splits.purged,
    }).map((p) => p.replace('$', '$.splits')),
    ...differences(development, recorded.development[0]).map((p) =>
      p.replace('$', '$.development'),
    ),
    ...differences(confirmatory, recordedT3S3).map((p) => p.replace('$', '$.confirmatory')),
  ];
  return {
    v1Observations: observations.length,
    exported: rows.length,
    v1NotExported: observations.length - (rows.length - unmatched),
    splits,
    tolerance: RULES.parityTolerance,
    differences: found,
    pass: found.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Forecasters fitted on the fit set only

const countCategories = (rows: readonly Row[]) => {
  const counts: Record<Category, number> = { TARGET: 0, STOP: 0, TIMEOUT: 0, AMBIGUOUS: 0 };
  for (const r of rows) counts[r.outcome.category] += 1;
  return counts;
};

/** forecasters.fitSetRequirement, payoffs and U: class frequencies and pooled gross ÷ v. */
export function fitBaseline(rows: readonly Row[]) {
  const classes: Record<Klass, number> = { TARGET: 0, STOP: 0, TIMEOUT: 0 };
  let stop = 0;
  let timeout = 0;
  for (const r of rows) {
    classes[r.class] += 1;
    if (r.class === 'STOP') stop += r.outcome.gross / r.v;
    if (r.class === 'TIMEOUT') timeout += r.outcome.gross / r.v;
  }
  const missingClass = CLASSES.some((k) => classes[k] === 0);
  return {
    observations: rows.length,
    days: new Set(rows.map((r) => dayOf(r.time))).size,
    outcomes: countCategories(rows),
    classes,
    missingClass,
    gStop: classes.STOP ? stop / classes.STOP : null,
    gTimeout: classes.TIMEOUT ? timeout / classes.TIMEOUT : null,
    probabilities: missingClass
      ? null
      : (CLASSES.map((k) => classes[k] / rows.length) as Probabilities),
  };
}
export type Baseline = ReturnType<typeof fitBaseline>;

/** forecasters.expectedNet.formula: the restricted plug-in with pooled payoffs. */
export function expectedNet(p: Probabilities, v: number, gStop: number, gTimeout: number): number {
  return (
    p[0] * netReturn(1, 1 + SCENARIO.targetV * v, 'TARGET') +
    p[1] * netReturn(1, 1 + gStop * v, 'STOP') +
    p[2] * netReturn(1, 1 + gTimeout * v, 'TIMEOUT')
  );
}

export const toObservation = (r: Row): Observation => ({
  symbol: r.symbol,
  time: r.time,
  day: dayOf(r.time),
  cell: r.cell,
  v: r.v,
  outcomes: [{ category: r.outcome.category, net: r.outcome.net }],
});

/** forecasters.V1: v1's fitFrequencies unchanged, with STOP and TIMEOUT counted per cell. */
export function fitV1(rows: readonly Row[]) {
  const fit = fitFrequencies(rows.map(toObservation), V1_T3S3)[0]!;
  const byCell = new Map(CELLS.map((cell) => [cell, countCategories([])]));
  for (const r of rows) byCell.get(r.cell)![r.outcome.category] += 1;
  const cells = Object.fromEntries(
    CELLS.map((cell) => {
      const c = fit.cells[cell]!;
      const k = byCell.get(cell)!;
      const stop = k.STOP + k.AMBIGUOUS;
      return [
        cell,
        {
          ...c,
          outcomes: k,
          probabilities:
            c.p === null ? null : ([c.p, stop / c.n, k.TIMEOUT / c.n] as Probabilities),
        },
      ];
    }),
  );
  return { base: fit.base, cells, fit };
}
export type V1Fit = ReturnType<typeof fitV1>;

// ---------------------------------------------------------------------------------------------
// Forecasts, scoring and metrics of one evaluation

export const FORECASTERS = ['U', 'V1', 'C'] as const;
export type Forecaster = (typeof FORECASTERS)[number];

export interface Forecast {
  p: Probabilities;
  expected: number;
  enter: boolean;
}

export interface Item {
  index: number;
  row: Row;
  U: Forecast | null;
  V1: Forecast | null;
  C: Forecast | null;
}
type Scored = Item & Record<Forecaster, Forecast>;

export type EvaluationId = 'development' | 'final';
export type EvaluationSpec = { id: EvaluationId; fit: Split[]; evaluate: Split };

/** One evaluation's C probabilities as scripts/expected_net_classifier.py writes them. */
export interface PredictionSet {
  status: 'FITTED' | 'MISSING_CLASS';
  fit: { observations: number; classes: Record<Klass, number>; [key: string]: unknown };
  rows: [number, number, number, number][];
}

interface Axis {
  firstDay: number;
  positions: number;
  orders: number[][];
}

function axisOf(split: Split, config: Protocol): Axis {
  const [firstDay, lastDay] = splitDays(split, config);
  const positions = lastDay - firstDay + 1;
  return { firstDay, positions, orders: dayOrders(split, positions, config) };
}

export interface Estimate {
  observations: number;
  mean: number | null;
  interval95: Interval | null;
}

/** A mean over items with its day-block interval; one axis per evaluation pairs every quantity. */
function estimate<T extends { row: Row }>(
  axis: Axis,
  items: readonly T[],
  value: (item: T) => number,
): Estimate {
  const numerator = new Float64Array(axis.positions);
  const denominator = new Float64Array(axis.positions);
  let sum = 0;
  for (const item of items) {
    const x = value(item);
    const at = dayOf(item.row.time) - axis.firstDay;
    numerator[at]! += x;
    denominator[at]! += 1;
    sum += x;
  }
  return {
    observations: items.length,
    mean: items.length ? sum / items.length : null,
    interval95: items.length ? ratioInterval(axis.orders, numerator, denominator, LEVELS) : null,
  };
}

/** metrics.probabilityCalibration.deciles, also used for expected net by decile. */
export function decileBins(predicted: readonly number[], actual: readonly number[]) {
  const n = predicted.length;
  const boundaries = n ? RULES.deciles.map((q) => quantile(predicted, q)) : [];
  const groups = Array.from({ length: RULES.deciles.length + 1 }, () => ({
    n: 0,
    predicted: 0,
    actual: 0,
  }));
  predicted.forEach((p, i) => {
    const group = groups[boundaries.filter((b) => b < p).length]!;
    group.n += 1;
    group.predicted += p;
    group.actual += actual[i]!;
  });
  const bins = groups.map((g, bin) => ({
    bin,
    n: g.n,
    meanPredicted: g.n ? g.predicted / g.n : null,
    meanActual: g.n ? g.actual / g.n : null,
  }));
  let error = 0;
  for (const b of bins) {
    if (b.n) error += b.n * Math.abs(b.meanPredicted! - b.meanActual!);
  }
  return { boundaries, bins, weightedError: n ? error / n : null };
}

const sumOf = (values: readonly number[]) => values.reduce((s, x) => s + x, 0);

/** metrics.probabilityCalibration for one forecaster: each class against its one-hot outcome. */
function probabilityCalibration(scored: readonly Scored[], name: Forecaster) {
  const ofClass = (j: number) => {
    const p = scored.map((s) => s[name].p[j]!);
    const y = scored.map((s) => (s.row.class === CLASSES[j] ? 1 : 0));
    const n = p.length;
    const { boundaries, bins, weightedError } = decileBins(p, y);
    return {
      observations: n,
      meanPredicted: n ? sumOf(p) / n : null,
      observed: n ? sumOf(y) / n : null,
      inTheLarge: n ? Math.abs(sumOf(p) / n - sumOf(y) / n) : null,
      weightedDecileError: weightedError,
      boundaries,
      bins,
    };
  };
  return { TARGET: ofClass(0), STOP: ofClass(1), TIMEOUT: ofClass(2) };
}

export type CalibrationLabel =
  'NO_ENTRIES' | 'INSUFFICIENT_SELECTED' | 'WITHIN_TOLERANCE' | 'OVERPREDICTED' | 'UNDERPREDICTED';

/** metrics.expectedNetCalibration.labels, on the point difference. */
export function calibrationLabel(
  observations: number,
  days: number,
  difference: number | null,
): CalibrationLabel {
  if (observations === 0 || difference === null) return 'NO_ENTRIES';
  if (observations < RULES.minSelected || days < RULES.minSelectedDays)
    return 'INSUFFICIENT_SELECTED';
  if (Math.abs(difference) <= TOLERANCE) return 'WITHIN_TOLERANCE';
  return difference < -TOLERANCE ? 'OVERPREDICTED' : 'UNDERPREDICTED';
}

function expectedNetCalibration(axis: Axis, items: readonly Scored[], name: Forecaster) {
  const days = new Set(items.map((s) => dayOf(s.row.time))).size;
  const expected = items.map((s) => s[name].expected);
  const net = items.map((s) => s.row.outcome.net);
  const difference = estimate(axis, items, (s) => s.row.outcome.net - s[name].expected);
  const n = items.length;
  return {
    observations: n,
    days,
    meanExpected: n ? sumOf(expected) / n : null,
    meanNet: n ? sumOf(net) / n : null,
    difference: difference.mean,
    interval95: difference.interval95,
    label: calibrationLabel(n, days, difference.mean),
    deciles: decileBins(expected, net),
  };
}
export type ExpectedNetCalibration = ReturnType<typeof expectedNetCalibration>;

const monthOf = (time: number) => new Date(time).toISOString().slice(0, 7);
const byText = (a: string, b: string) => a.localeCompare(b);

const categoryCounts = (outcomes: readonly Outcome[]) => {
  const counts: Record<Category, number> = { TARGET: 0, STOP: 0, TIMEOUT: 0, AMBIGUOUS: 0 };
  for (const o of outcomes) counts[o.category] += 1;
  return counts;
};

/** accounting.concurrency over the evaluation's hours and grid decision times. */
export function concurrency(
  entered: readonly { row: Row }[],
  start: number,
  end: number,
  times: number[],
) {
  const open = new Array<number>((end - start) / HOUR_MS).fill(0);
  const perTime = new Map<number, number>();
  for (const { row } of entered) {
    const first = (row.time - start) / HOUR_MS;
    for (let k = 0; k < row.outcome.bar; k += 1) open[first + k]! += 1;
    perTime.set(row.time, (perTime.get(row.time) ?? 0) + 1);
  }
  const pairs = times.map((t) => perTime.get(t) ?? 0);
  return {
    hours: open.length,
    maxOpen: extent(open)[1],
    medianOpen: open.length ? quantile(open, 0.5) : null,
    decisionTimes: times.length,
    timesWithEntry: pairs.filter((n) => n > 0).length,
    maxPairsPerTime: extent(pairs)[1],
    medianPairsPerTime: pairs.length ? quantile(pairs, 0.5) : null,
    meanPairsPerTime: pairs.length ? sumOf(pairs) / pairs.length : null,
  };
}

interface Period {
  split: Split;
  start: number;
  end: number;
  times: number[];
}

function periodOf(split: Split): Period {
  const [b1, b2] = PROTOCOL.splits.boundaries.map((t) => Date.parse(t)) as [number, number];
  const ranges: Record<Split, [number, number]> = {
    train: [Date.parse(PROTOCOL.decisions.firstDecision), b1],
    validation: [b1, b2],
    test: [b2, CUTOFF],
  };
  const [start, end] = ranges[split];
  return { split, start, end, times: decisionTimes().filter((t) => splitOf(t) === split) };
}

/** metrics.economic and metrics.sensitivities for one forecaster's decisions, held fixed. */
function economics(axis: Axis, scored: readonly Scored[], name: Forecaster, period: Period) {
  const d = (s: Scored) => (s[name].enter ? 1 : 0);
  const entered = scored.filter((s) => s[name].enter);
  const months = [...new Set(scored.map((s) => monthOf(s.row.time)))].sort(byText);
  const perMonth = months.map((month) => {
    const inMonth = scored.filter((s) => monthOf(s.row.time) === month);
    return {
      month,
      observations: inMonth.length,
      entries: inMonth.filter((s) => s[name].enter).length,
      perOpportunity: sumOf(inMonth.map((s) => d(s) * s.row.outcome.net)) / inMonth.length,
    };
  });
  const leftOut = months.map((month) => {
    const others = scored.filter((s) => monthOf(s.row.time) !== month);
    return {
      month,
      perOpportunity: others.length
        ? sumOf(others.map((s) => d(s) * s.row.outcome.net)) / others.length
        : null,
    };
  });
  // An undefined mean (nothing left) sorts first: it fails the condition.
  const minimum =
    [...leftOut].sort(
      (a, b) => (a.perOpportunity ?? -Infinity) - (b.perOpportunity ?? -Infinity) || 0,
    )[0] ?? null;
  return {
    entries: entered.length,
    entryRate: scored.length ? entered.length / scored.length : null,
    days: new Set(entered.map((s) => dayOf(s.row.time))).size,
    entryMonths: [...new Set(entered.map((s) => monthOf(s.row.time)))].sort(byText),
    perOpportunity: estimate(axis, scored, (s) => d(s) * s.row.outcome.net),
    perTrade: estimate(axis, entered, (s) => s.row.outcome.net),
    enteredOutcomes: categoryCounts(entered.map((s) => s.row.outcome)),
    months: perMonth,
    leaveOneMonthOut: { minimum, months: leftOut },
    overshoot: {
      perOpportunity: estimate(axis, scored, (s) => d(s) * s.row.overshoot.net),
      perTrade: estimate(axis, entered, (s) => s.row.overshoot.net),
      enteredOutcomes: categoryCounts(entered.map((s) => s.row.overshoot)),
    },
    ordering: {
      perOpportunity: estimate(axis, scored, (s) => d(s) * s.row.orderingNet),
      enteredAmbiguous: entered.filter((s) => s.row.outcome.category === 'AMBIGUOUS').length,
    },
    concurrency: concurrency(entered, period.start, period.end, period.times),
  };
}
export type Economics = ReturnType<typeof economics>;

const brier3 = (p: Probabilities, k: Klass) =>
  p.reduce((sum, pk, j) => sum + (pk - (CLASSES[j] === k ? 1 : 0)) ** 2, 0);

/** C's probabilities for exactly the evaluated rows, in dataset order. */
function classifierProbabilities(
  predictions: PredictionSet,
  evaluated: readonly number[],
  baseline: Baseline,
): Map<number, Probabilities> | null {
  const missing = predictions.status === 'MISSING_CLASS';
  if (missing !== baseline.missingClass) {
    throw new Error('The classifier and the fit set disagree on a missing class');
  }
  if (
    predictions.fit.observations !== baseline.observations ||
    CLASSES.some((k) => predictions.fit.classes[k] !== baseline.classes[k])
  ) {
    throw new Error("The classifier's fit set differs from this evaluation's");
  }
  if (missing) return null;
  const indices = predictions.rows.map((r) => r[0]);
  if (differences(indices, [...evaluated]).length) {
    throw new Error('Classifier probabilities do not cover exactly the evaluated observations');
  }
  if (!predictions.rows.every((r) => r.every(Number.isFinite))) {
    throw new Error('A classifier probability is not finite');
  }
  return new Map(predictions.rows.map(([i, ...p]) => [i, p as Probabilities]));
}

export function evaluatePeriod(
  rows: readonly Row[],
  evaluation: EvaluationSpec,
  predictions: PredictionSet,
  pairs: number,
  config: Protocol = STUDY,
) {
  const fitRows = rows.filter((r) => r.split !== null && evaluation.fit.includes(r.split));
  const evaluated: number[] = [];
  rows.forEach((r, i) => {
    if (r.split === evaluation.evaluate) evaluated.push(i);
  });
  const baseline = fitBaseline(fitRows);
  const v1 = fitV1(fitRows);
  const c = classifierProbabilities(predictions, evaluated, baseline);
  const { gStop, gTimeout } = baseline;
  const plugIn = (p: Probabilities, v: number): Forecast => {
    const expected = expectedNet(p, v, gStop!, gTimeout!);
    return { p, expected, enter: expected > 0 };
  };
  const items: Item[] = evaluated.map((index) => {
    const row = rows[index]!;
    const cell = v1.cells[row.cell];
    const cp = c?.get(index);
    return {
      index,
      row,
      U: baseline.probabilities ? plugIn(baseline.probabilities, row.v) : null,
      V1: cell?.probabilities
        ? { p: cell.probabilities, expected: cell.meanNet!, enter: (cell.meanNet ?? 0) > 0 }
        : null,
      C: cp ? plugIn(cp, row.v) : null,
    };
  });
  const scored = items.filter((i): i is Scored => !!(i.U && i.V1 && i.C));
  const period = periodOf(evaluation.evaluate);
  const eligible = period.times.length * pairs;
  const axis = axisOf(evaluation.evaluate, config);
  const per = <T>(f: (name: Forecaster) => T) =>
    Object.fromEntries(FORECASTERS.map((name) => [name, f(name)])) as Record<Forecaster, T>;
  const brier = (name: Forecaster) =>
    scored.length ? sumOf(scored.map((s) => brier3(s[name].p, s.row.class))) / scored.length : null;
  const binary = evaluateFit(
    [v1.fit],
    items.map((i) => toObservation(i.row)),
    evaluation.evaluate,
    config,
  )[0]!;
  const symbols = [...new Set(items.map((i) => i.row.symbol))];
  return {
    id: evaluation.id,
    fit: {
      splits: evaluation.fit,
      observations: baseline.observations,
      days: baseline.days,
      outcomes: baseline.outcomes,
      classes: baseline.classes,
      missingClass: baseline.missingClass,
      payoffs: { gStop, gTimeout },
      U: baseline.probabilities,
      V1: { base: v1.base, cells: v1.cells },
      C: predictions.fit,
    },
    coverage: {
      eligible,
      observations: items.length,
      forecasts: per((name) => items.filter((i) => i[name]).length),
      scored: scored.length,
      coverage: eligible ? scored.length / eligible : null,
      days: new Set(scored.map((s) => dayOf(s.row.time))).size,
    },
    outcomes: {
      scored: categoryCounts(scored.map((s) => s.row.outcome)),
      overshoot: categoryCounts(scored.map((s) => s.row.overshoot)),
    },
    brier: {
      threeClass: per(brier),
      CminusU: estimate(
        axis,
        scored,
        (s) => brier3(s.C.p, s.row.class) - brier3(s.U.p, s.row.class),
      ),
      CminusV1: estimate(
        axis,
        scored,
        (s) => brier3(s.C.p, s.row.class) - brier3(s.V1.p, s.row.class),
      ),
      binaryTarget: {
        v1: binary,
        cTarget: scored.length
          ? sumOf(scored.map((s) => (s.C.p[0] - (s.row.class === 'TARGET' ? 1 : 0)) ** 2)) /
            scored.length
          : null,
      },
    },
    probabilityCalibration: per((name) => probabilityCalibration(scored, name)),
    expectedNetCalibration: per((name) => ({
      ALL: expectedNetCalibration(axis, scored, name),
      ENTER: expectedNetCalibration(
        axis,
        scored.filter((s) => s[name].enter),
        name,
      ),
    })),
    economics: per((name) => economics(axis, scored, name, period)),
    paired: {
      CminusU: estimate(
        axis,
        scored,
        (s) => ((s.C.enter ? 1 : 0) - (s.U.enter ? 1 : 0)) * s.row.outcome.net,
      ),
      CminusV1: estimate(
        axis,
        scored,
        (s) => ((s.C.enter ? 1 : 0) - (s.V1.enter ? 1 : 0)) * s.row.outcome.net,
      ),
    },
    pairs: Object.fromEntries(
      symbols.map((symbol) => {
        const mine = scored.filter((s) => s.row.symbol === symbol);
        return [
          symbol,
          {
            scored: mine.length,
            ...per((name) => ({
              entries: mine.filter((s) => s[name].enter).length,
              perOpportunity: mine.length
                ? sumOf(mine.map((s) => (s[name].enter ? s.row.outcome.net : 0))) / mine.length
                : null,
            })),
          },
        ];
      }),
    ),
    uncertainty: {
      grid: evaluation.evaluate,
      positions: axis.positions,
      replicates: config.uncertainty.replicates,
      seed: config.uncertainty.random.seed,
      blockDays: 7,
      levels: LEVELS,
    },
  };
}
export type PeriodResult = ReturnType<typeof evaluatePeriod>;

// ---------------------------------------------------------------------------------------------
// Gate and verdict

export interface Check {
  id: string;
  evaluation: string | null;
  kind: 'insufficientEvidence' | 'condition';
  holds: boolean;
}

const positive = (x: number | null | undefined) => x !== null && x !== undefined && x > 0;
const clearlyBelowZero = (e: Estimate) =>
  e.mean !== null && e.mean < 0 && e.interval95 !== null && e.interval95.high < 0;
const within = (x: number | null, limit: number) => x !== null && x <= limit;

/** gate.insufficientEvidence and gate.conditions for one evaluation, in specification order. */
function periodChecks(evaluation: string, e: PeriodResult): Check[] {
  const c = e.economics.C;
  const enter = e.expectedNetCalibration.C.ENTER.label;
  const check = (id: string, kind: Check['kind'], holds: boolean): Check => ({
    id,
    evaluation,
    kind,
    holds,
  });
  return [
    check('coverage', 'insufficientEvidence', (e.coverage.coverage ?? 0) >= RULES.minCoverage),
    check(
      'enterSubset',
      'insufficientEvidence',
      enter !== 'NO_ENTRIES' && enter !== 'INSUFFICIENT_SELECTED',
    ),
    check('brierVsU', 'condition', clearlyBelowZero(e.brier.CminusU)),
    check('brierVsV1', 'condition', clearlyBelowZero(e.brier.CminusV1)),
    ...CLASSES.map((k) => {
      const p = e.probabilityCalibration.C[k];
      return check(
        `probabilityCalibration.${k}`,
        'condition',
        within(p.inTheLarge, RULES.maxInTheLarge) &&
          within(p.weightedDecileError, RULES.maxDecileError),
      );
    }),
    check(
      'expectedNetCalibration',
      'condition',
      enter === 'WITHIN_TOLERANCE' || enter === 'UNDERPREDICTED',
    ),
    check('perOpportunity', 'condition', positive(c.perOpportunity.mean)),
    check('perTrade', 'condition', positive(c.perTrade.mean)),
    check(
      'leaveOneMonthOut',
      'condition',
      c.leaveOneMonthOut.months.length > 0 &&
        c.leaveOneMonthOut.months.every((m) => positive(m.perOpportunity)),
    ),
    check('targetOvershoot', 'condition', positive(c.overshoot.perOpportunity.mean)),
  ];
}

/** gate.labels.ORDERING_SENSITIVE: a conservative loss that optimistic ordering would rescue. */
const orderingSensitive = ({ economics: { C } }: PeriodResult) =>
  C.perOpportunity.mean !== null &&
  C.perOpportunity.mean <= 0 &&
  positive(C.ordering.perOpportunity.mean);

/** gate and verdict.order. Every check is evaluated whatever the verdict. */
export function conclude(evaluations: Readonly<Record<string, PeriodResult>>) {
  const periods = Object.entries(evaluations);
  const checks = periods.flatMap(([id, e]) => periodChecks(id, e));
  const labels: { label: 'ORDERING_SENSITIVE' | 'FILL_SENSITIVE'; evaluation: string | null }[] =
    periods
      .filter(([, e]) => orderingSensitive(e))
      .map(([id]) => ({ label: 'ORDERING_SENSITIVE', evaluation: id }));
  const entered = periods.map(([, e]) => e.economics.C);
  const entries = sumOf(entered.map((c) => c.entries));
  // Evaluation periods never share a decision day (v1's purge), so days add up.
  const days = sumOf(entered.map((c) => c.days));
  const months = new Set(entered.flatMap((c) => c.entryMonths));
  checks.push({
    id: 'entryFloor',
    evaluation: null,
    kind: 'insufficientEvidence',
    holds:
      entries >= RULES.floor.entries &&
      days >= RULES.floor.days &&
      months.size >= RULES.floor.months,
  });
  const failing = checks.filter((c) => !c.holds);
  if (failing.length > 0 && failing.every((c) => c.id === 'targetOvershoot')) {
    labels.push({ label: 'FILL_SENSITIVE', evaluation: null });
  }
  let verdict: 'INSUFFICIENT_EVIDENCE' | 'GATE_PASSED' | 'STOP' = 'STOP';
  if (failing.some((c) => c.kind === 'insufficientEvidence')) verdict = 'INSUFFICIENT_EVIDENCE';
  else if (failing.length === 0) verdict = 'GATE_PASSED';
  return {
    verdict,
    failing: failing.map((c) => (c.evaluation ? `${c.evaluation}.${c.id}` : c.id)),
    labels,
    entryFloor: { entries, days, months: [...months].sort(byText) },
    checks,
  };
}

/** The whole fixed comparison over the exported rows and C's probabilities. */
export function evaluateStudy(
  rows: readonly Row[],
  predictions: Readonly<Partial<Record<EvaluationId, PredictionSet>>>,
  pairs: number,
  config: Protocol = STUDY,
) {
  const evaluations = Object.fromEntries(
    (SPEC.periods.evaluations as EvaluationSpec[]).map((e) => {
      const set = predictions[e.id];
      if (!set) throw new Error(`No classifier probabilities for ${e.id}`);
      return [e.id, evaluatePeriod(rows, e, set, pairs, config)];
    }),
  ) as Record<EvaluationId, PeriodResult>;
  const bySplit = (split: Split) => rows.filter((r) => r.split === split).length;
  return {
    specification: { id: SPEC.specificationId, sha256: specSha256() },
    observations: {
      exported: rows.length,
      bySplit: {
        train: bySplit('train'),
        validation: bySplit('validation'),
        test: bySplit('test'),
      },
      purged: rows.filter((r) => r.split === null).length,
    },
    evaluations,
    conclusion: conclude(evaluations),
  };
}
export type StudyResults = ReturnType<typeof evaluateStudy>;
