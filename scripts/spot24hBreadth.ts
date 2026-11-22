/**
 * One market-breadth filter over protocol v1's observations (docs/spot-24h-breadth-filter.json,
 * docs/SPOT_24H_BREADTH_FILTER.md). Pure functions: the state at each decision time from candles
 * closed by it, permitted against excluded and all decisions per period and month, a day-block
 * bootstrap and the specification's verdict. Development evidence only. Nothing here tunes the
 * filter, selects a scenario or changes a v1 rule.
 */
import { createHash } from 'node:crypto';
import specJson from '../docs/spot-24h-breadth-filter.json';
import { stableSerialize } from '@/lib/stableSerialize';
import {
  HOUR_MS,
  quantile,
  splitDays,
  type Category,
  type HourCandle,
  type Split,
} from './spot24h';
import { decompose, monthOf, outcomeAttribution, type DiagnosticRow } from './spot24hDiagnostic';
import { bootstrapOrders } from './swingStructureEvaluation';

export const SPEC = specJson;
export type Spec = typeof specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');

export type BreadthState = 'PERMITTED' | 'EXCLUDED' | 'UNAVAILABLE';

export interface Breadth {
  state: BreadthState;
  /** Members with a strictly positive trailing return; null when the state is unavailable. */
  positive: number | null;
  breadth: number | null;
  /** Members whose required candle is missing or invalid. */
  missing: string[];
}

/**
 * filter: the state at T from each member's candles opening at T - 1h and T - 25h. Nothing that
 * opens at or after T is read, and a missing member makes the state unavailable rather than
 * shrinking the denominator.
 */
export function breadthAt(
  members: readonly string[],
  valid: Readonly<Record<string, ReadonlyMap<number, HourCandle>>>,
  time: number,
  spec: Spec = SPEC,
): Breadth {
  const { lastOpenOffsetHours, firstOpenOffsetHours, threshold } = spec.filter;
  let positive = 0;
  const missing: string[] = [];
  for (const symbol of members) {
    const last = valid[symbol]?.get(time - lastOpenOffsetHours * HOUR_MS);
    const first = valid[symbol]?.get(time - firstOpenOffsetHours * HOUR_MS);
    const r = last && first ? last.close / first.close - 1 : Number.NaN;
    if (!Number.isFinite(r)) missing.push(symbol);
    else if (r > 0) positive += 1;
  }
  if (missing.length || members.length === 0) {
    return { state: 'UNAVAILABLE', positive: null, breadth: null, missing };
  }
  const breadth = positive / members.length;
  return { state: breadth > threshold ? 'PERMITTED' : 'EXCLUDED', positive, breadth, missing };
}

export interface StatedRow extends DiagnosticRow {
  split: Split | null;
  breadth: Breadth;
}

const PERIODS = ['train', 'validation', 'test'] as const;
type Period = (typeof PERIODS)[number];
const STATES: readonly BreadthState[] = ['PERMITTED', 'EXCLUDED', 'UNAVAILABLE'];
const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
const distinctDays = (rows: readonly DiagnosticRow[]) => new Set(rows.map((r) => r.day)).size;
const inState = (rows: readonly StatedRow[], state: BreadthState) =>
  rows.filter((row) => row.breadth.state === state);

/** analysis.perGroup for one scenario; coverage is against all observations of the period. */
export function groupSummary(
  rows: readonly DiagnosticRow[],
  s: number,
  periodObservations: number,
) {
  const a = outcomeAttribution(rows, s);
  return {
    observations: rows.length,
    days: distinctDays(rows),
    coverage: periodObservations ? rows.length / periodObservations : null,
    rates: Object.fromEntries(a.categories.map((c) => [c.category, c.share])) as Record<
      Category,
      number | null
    >,
    meanGross: a.meanGross,
    meanNet: a.meanNet,
  };
}
type Summary = ReturnType<typeof groupSummary>;

const differences = (a: Summary, b: Summary) => ({
  targetRate: diff(a.rates.TARGET, b.rates.TARGET),
  meanGross: diff(a.meanGross, b.meanGross),
  meanNet: diff(a.meanNet, b.meanNet),
});

/** Permitted, excluded, unavailable and all observations of one period, for one scenario. */
export function compareStates(rows: readonly StatedRow[], s: number) {
  const n = rows.length;
  const all = groupSummary(rows, s, n);
  const [permitted, excluded, unavailable] = STATES.map((state) =>
    groupSummary(inState(rows, state), s, n),
  ) as [Summary, Summary, Summary];
  return {
    permitted,
    excluded,
    unavailable: {
      observations: unavailable.observations,
      days: unavailable.days,
      coverage: unavailable.coverage,
    },
    all,
    permittedMinusExcluded: differences(permitted, excluded),
    permittedMinusAll: differences(permitted, all),
  };
}
type Comparison = ReturnType<typeof compareStates>;

/** analysis.months: permitted against excluded per period and UTC month, for one scenario. */
export function monthlyComparison(rows: readonly StatedRow[], s: number, spec: Spec = SPEC) {
  const minimum = spec.analysis.months.minimumObservationsPerState;
  const groups = new Map<string, StatedRow[]>();
  for (const row of rows) {
    const key = `${row.split}|${monthOf(row)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const brief = (x: Summary) => ({
    observations: x.observations,
    targetRate: x.rates.TARGET,
    meanGross: x.meanGross,
    meanNet: x.meanNet,
  });
  const months = [...groups.entries()]
    .map(([key, group]) => {
      const [period, month] = key.split('|') as [string, string];
      const p = groupSummary(inState(group, 'PERMITTED'), s, group.length);
      const e = groupSummary(inState(group, 'EXCLUDED'), s, group.length);
      const eligible = p.observations >= minimum && e.observations >= minimum;
      return {
        period,
        month,
        first: group.reduce((low, row) => Math.min(low, row.time), Infinity),
        permitted: brief(p),
        excluded: brief(e),
        eligible,
        permittedHigher: eligible ? (p.meanGross ?? 0) > (e.meanGross ?? 0) : null,
      };
    })
    .sort((a, b) => a.first - b.first)
    .map(({ first: _first, ...month }) => month);
  return {
    eligible: months.filter((m) => m.eligible).length,
    permittedHigher: months.filter((m) => m.permittedHigher).length,
    months,
  };
}

export interface BootstrapSet {
  name: string;
  /** Rows whose day falls in [firstDay, firstDay + positions). */
  rows: readonly StatedRow[];
  firstDay: number;
  positions: number;
}

/** The set's two statistics over the days of one order; null where a needed state is empty. */
export function replicateStatistics(
  days: {
    pn: Float64Array;
    pg: Float64Array;
    pnet: Float64Array;
    en: Float64Array;
    eg: Float64Array;
  },
  order: readonly number[],
) {
  let pn = 0;
  let pg = 0;
  let pnet = 0;
  let en = 0;
  let eg = 0;
  for (const i of order) {
    pn += days.pn[i]!;
    pg += days.pg[i]!;
    pnet += days.pnet[i]!;
    en += days.en[i]!;
    eg += days.eg[i]!;
  }
  return {
    permittedMeanNet: pn ? pnet / pn : null,
    grossDifference: pn && en ? pg / pn - eg / en : null,
  };
}

/** Per-day sums of one set and scenario: the bootstrap's unit is the whole day, never the row. */
export function daySums(set: BootstrapSet, s: number) {
  const zeros = () => new Float64Array(set.positions);
  const days = { pn: zeros(), pg: zeros(), pnet: zeros(), en: zeros(), eg: zeros() };
  for (const row of set.rows) {
    const i = row.day - set.firstDay;
    if (i < 0 || i >= set.positions) throw new Error(`${set.name}: day ${row.day} outside the set`);
    const { category, exit, net } = row.outcomes[s]!;
    const gross = decompose(row.entry, exit, category).gross;
    if (row.breadth.state === 'PERMITTED') {
      days.pn[i]! += 1;
      days.pg[i]! += gross;
      days.pnet[i]! += net;
    } else if (row.breadth.state === 'EXCLUDED') {
      days.en[i]! += 1;
      days.eg[i]! += gross;
    }
  }
  return days;
}

/** uncertainty: intervals of both statistics for every scenario, on common draws. */
export function bootstrapIntervals(set: BootstrapSet, scenarios: number, spec: Spec = SPEC) {
  const { random, blockDays, replicates, familyAlpha, comparisons } = spec.uncertainty;
  const tail = familyAlpha / (2 * comparisons);
  const orders = bootstrapOrders(random, set.name, blockDays, replicates, set.positions);
  const identity = Array.from({ length: set.positions }, (_, i) => i);
  const interval = (values: (number | null)[], estimate: number | null) => {
    const defined = values.filter((v): v is number => v !== null);
    return {
      estimate,
      low: defined.length ? quantile(defined, tail) : null,
      high: defined.length ? quantile(defined, 1 - tail) : null,
      defined: defined.length,
      replicates: values.length,
    };
  };
  return Array.from({ length: scenarios }, (_, s) => {
    const days = daySums(set, s);
    const point = replicateStatistics(days, identity);
    const draws = orders.map((order) => replicateStatistics(days, order));
    return {
      permittedMeanNet: interval(
        draws.map((d) => d.permittedMeanNet),
        point.permittedMeanNet,
      ),
      grossDifference: interval(
        draws.map((d) => d.grossDifference),
        point.grossDifference,
      ),
    };
  });
}

export const percentiles = (spec: Spec = SPEC) => {
  const tail = spec.uncertainty.familyAlpha / (2 * spec.uncertainty.comparisons);
  return [tail, 1 - tail] as const;
};

/** decision: evidence, separation and net return per scenario, then the one verdict. */
export function verdictOf(
  periods: Record<Period, Comparison[]>,
  months: ReturnType<typeof monthlyComparison>[],
  pooled: ReturnType<typeof bootstrapIntervals>,
  scenarios: readonly { id: string }[],
  spec: Spec = SPEC,
) {
  const { minimumObservations, minimumDays } = spec.decision.evidence;
  const [num, den] = spec.decision.separation.monthShare as [number, number];
  const enough = (x: Summary) => x.observations >= minimumObservations && x.days >= minimumDays;
  const evidence = PERIODS.every((p) =>
    periods[p].every((c) => enough(c.permitted) && enough(c.excluded)),
  );
  const perScenario = scenarios.map(({ id }, s) => {
    const m = months[s]!;
    const separation = {
      periods: PERIODS.every((p) => (periods[p][s]!.permittedMinusExcluded.meanGross ?? 0) > 0),
      bound: (pooled[s]!.grossDifference.low ?? 0) > 0,
      months: m.eligible > 0 && m.permittedHigher * den >= m.eligible * num,
    };
    return {
      scenario: id,
      separation,
      netReturn: PERIODS.every((p) => (periods[p][s]!.permitted.meanNet ?? 0) > 0),
    };
  });
  const separated = perScenario.every((x) => Object.values(x.separation).every(Boolean));
  const profitable = perScenario.every((x) => x.netReturn);
  return {
    verdict: verdictFrom(evidence, separated, profitable),
    evidence,
    scenarios: perScenario,
  };
}

/** decision.verdicts, in the specification's order. */
function verdictFrom(evidence: boolean, separated: boolean, profitable: boolean) {
  if (!evidence) return 'INSUFFICIENT_EVIDENCE';
  if (!separated) return 'NO_CONSISTENT_SEPARATION';
  if (!profitable) return 'IMPROVES_BUT_LOSES_MONEY';
  return 'MERITS_SEPARATE_VALIDATION';
}

/** How often each breadth occurred, over the distinct decision times of a set of rows. */
export function stateCounts(rows: readonly StatedRow[], members: number) {
  const times = new Map<number, Breadth>();
  for (const row of rows) times.set(row.time, row.breadth);
  const positives = Array.from({ length: members + 1 }, () => 0);
  const states = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<
    BreadthState,
    number
  >;
  for (const b of times.values()) {
    states[b.state] += 1;
    if (b.positive !== null) positives[b.positive]! += 1;
  }
  return { decisionTimes: times.size, ...states, positives };
}

/** Every table of the specification, for rows already given their state. */
export function analyse(
  rows: readonly StatedRow[],
  scenarios: readonly { id: string }[],
  members: number,
  spec: Spec = SPEC,
) {
  const perPeriod = <T>(f: (p: Period) => T) =>
    Object.fromEntries(PERIODS.map((p) => [p, f(p)])) as Record<Period, T>;
  const named = <T extends object>(list: readonly T[]) =>
    list.map((x, s) => ({ scenario: scenarios[s]!.id, ...x }));
  const byPeriod = perPeriod((p) => rows.filter((row) => row.split === p));
  const analysed = PERIODS.flatMap((p) => byPeriod[p]);
  const periods = perPeriod((p) => scenarios.map((_, s) => compareStates(byPeriod[p], s)));
  const months = scenarios.map((_, s) => monthlyComparison(analysed, s, spec));
  const intervalsOf = (name: string, set: Split | 'all', setRows: readonly StatedRow[]) => {
    const [first, last] = splitDays(set);
    const days = { name, rows: setRows, firstDay: first, positions: last - first + 1 };
    return bootstrapIntervals(days, scenarios.length, spec);
  };
  const intervals = {
    ...perPeriod((p) => intervalsOf(p, p, byPeriod[p])),
    pooled: intervalsOf('pooled', 'all', analysed),
  };
  return {
    states: {
      ...perPeriod((p) => stateCounts(byPeriod[p], members)),
      purgedObservations: rows.length - analysed.length,
    },
    periods: perPeriod((p) => named(periods[p])),
    months: named(months),
    uncertainty: {
      percentiles: percentiles(spec),
      sets: {
        ...perPeriod((p) => named(intervals[p])),
        pooled: named(intervals.pooled),
      },
    },
    decision: verdictOf(periods, months, intervals.pooled, scenarios, spec),
  };
}
