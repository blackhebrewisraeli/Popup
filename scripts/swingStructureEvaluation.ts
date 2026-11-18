import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DAY_MS, validatePrices, type DailyCandle } from '@/lib/candleValidation';
import { stableSerialize } from './evaluationStore';
import { quantiles } from './modelDiagnostic';
import { mean } from './scannerResearch';
import {
  evaluateSwingStructure,
  SWING_STRUCTURE_CANDIDATE_ID,
  SWING_STRUCTURE_CANDIDATE_VERSION,
  type ReferenceBreach,
  type SwingPivot,
  type SwingStructureObservation,
} from './swingStructure';

/**
 * Computes questions A, B and C of docs/swing-structure-evaluation.v1.json on candles supplied in
 * memory. It reads no export, writes no file and has no real-data entry point: reading the export,
 * verifying its identity and writing the results is a separate, later change. The candidate is
 * called as published. Where this code and the specification differ, the specification governs.
 */
export const SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID =
  '99fff59080a3b2f94ee5fdb1310cce7624912d7eafdad3fe8b82c4c3203dece2';
export const SWING_STRUCTURE_EVALUATION_SPECIFICATION_PATH =
  'docs/swing-structure-evaluation.v1.json';
/** uncertainty.availability: no interval when more than 100 of the 10000 replicates (1%) lack M*. */
const MAXIMUM_UNDEFINED_REPLICATES = 100;
/** uncertainty.availability and degenerateCases.zeroVariance. */
const MINIMUM_DEFINED_REPLICATES = 2;
const DAILY = { label: '1D', intervalMs: DAY_MS } as const;
export const QUANTILE_METHOD =
  'linear interpolation between order statistics (type 7), as quantiles in scripts/modelDiagnostic.ts';

export interface SwingStructureEvaluationSpecification {
  studyId: string;
  specificationId: string;
  candidate: { id: string; version: string };
  data: {
    export: { retrievalStartedAt: string };
    bars: { firstBar: string; lastClosedBar: string };
  };
  universe: { members: Record<string, string> };
  timeframe: { label: string; intervalMs: number };
  window: { closedCandles: number };
  observations: {
    daily: { first: string; last: string; count: number };
    primaryGrid: { id: string; spacingDays: number; count: number; dates: string[] };
    phaseGrids: { count: number };
  };
  configurations: Configuration[];
  horizons: { utcDays: number[]; primary: number };
  primary: { configuration: string; horizonUtcDays: number; grid: string };
  uncertainty: {
    blockLengths: { primary: number; longer: number };
    replicates: number;
    random: BootstrapRandom;
    zQuantile: number;
    intervalHorizons: number[];
    descriptiveOnlyHorizons: number[];
  };
  interpretability: InterpretabilityThresholds;
}

export interface Configuration {
  id: string;
  leftBars: number;
  rightBars: number;
  role: 'primary' | 'exploratory';
}

export interface BootstrapRandom {
  seed: string;
  drawMessage: string;
}

export interface InterpretabilityThresholds {
  minimumDates: number;
  minimumUpObservations: number;
  minimumUpDates: number;
  minimumDownObservations: number;
  minimumDownDates: number;
  maximumInvalidOrIncompleteObservationsPerMember: number;
  maximumUnavailableOutcomesPerMember: number;
}

export type RefusalCode =
  | 'SPECIFICATION'
  | 'DATA_UNAVAILABLE'
  | 'TIMING_INVARIANT'
  | 'LOOK_AHEAD'
  | 'OUTCOME_PENDING'
  | 'EMPTY_BASELINE'
  | 'NON_FINITE';

/** A defect: the run stops. Never an exclusion, and never a result. */
export class SwingStructureEvaluationRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SwingStructureEvaluationRefusal';
  }
}

function refuse(code: RefusalCode, message: string): never {
  throw new SwingStructureEvaluationRefusal(code, message);
}

/** degenerateCases.rule: a non-finite value anywhere in a computation is a defect. */
function finite(value: number, what: string): number {
  if (!Number.isFinite(value)) refuse('NON_FINITE', `${what} is ${value}`);
  return value;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const closeOf = (open: number) => open + DAY_MS - 1;
export const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

export function utcDay(iso: string): number {
  const time = Date.parse(`${iso}T00:00:00.000Z`);
  if (!Number.isSafeInteger(time)) refuse('SPECIFICATION', `${iso} is not a UTC date`);
  return time;
}

/**
 * Reads the frozen specification and refuses unless its content hashes to the identity it
 * declares and that identity is the one this module implements. There is no way around this.
 */
export async function loadSwingStructureEvaluationSpecification(
  path = SWING_STRUCTURE_EVALUATION_SPECIFICATION_PATH,
): Promise<SwingStructureEvaluationSpecification> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as SwingStructureEvaluationSpecification;
  const { specificationId, ...content } = parsed;
  const computed = sha256(stableSerialize(content));
  if (computed !== specificationId) {
    refuse('SPECIFICATION', `content hashes to ${computed}, not its declared ${specificationId}`);
  }
  if (specificationId !== SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID) {
    refuse(
      'SPECIFICATION',
      `this module implements ${SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID}, not ${specificationId}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------------------------
// Schedule

export interface StudySchedule {
  /** observations.daily: every UTC date from first to last. */
  daily: number[];
  /** observations.phaseGrids: G_p for p = 0..19; G_0 is the primary grid. */
  phases: number[][];
}

export function studySchedule(spec: SwingStructureEvaluationSpecification): StudySchedule {
  const { daily: dailySpec, primaryGrid, phaseGrids } = spec.observations;
  const first = utcDay(dailySpec.first);
  const last = utcDay(dailySpec.last);
  const daily: number[] = [];
  for (let time = first; time <= last; time += DAY_MS) daily.push(time);
  if (daily.length !== dailySpec.count) {
    refuse('SPECIFICATION', `${daily.length} daily dates, not ${dailySpec.count}`);
  }
  const spacing = primaryGrid.spacingDays * DAY_MS;
  const phases = Array.from({ length: phaseGrids.count }, (_, p) =>
    daily.filter((time) => (time - first) % spacing === p * DAY_MS),
  );
  const g0 = (phases[0] ?? []).map(isoDate);
  if (
    g0.length !== primaryGrid.count ||
    stableSerialize(g0) !== stableSerialize(primaryGrid.dates)
  ) {
    refuse('SPECIFICATION', 'phase 0 is not the listed primary grid');
  }
  return { daily, phases };
}

// ---------------------------------------------------------------------------------------------
// Candles

/** data.mapping: what tradingViewCryptoCandles yields. Anything else is not this study's input. */
export type MappedCandle = DailyCandle & { open: number };

function mappedSeries(member: string, candles: readonly DailyCandle[]): MappedCandle[] {
  candles.forEach((candle, index) => {
    const prices = [candle.open, candle.high, candle.low, candle.close];
    if (
      !Number.isSafeInteger(candle.timestamp) ||
      candle.timestamp <= 0 ||
      candle.closeTime !== closeOf(candle.timestamp) ||
      !prices.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      refuse('DATA_UNAVAILABLE', `${member} candle ${index} is not a mapped daily bar`);
    }
  });
  return candles as MappedCandle[];
}

/** Candles by exact open time, in export order. Nothing is sorted, merged or deduplicated. */
export type BarIndex = Map<number, { candle: MappedCandle; index: number }[]>;

export function indexBars(candles: readonly MappedCandle[]): BarIndex {
  const index: BarIndex = new Map();
  candles.forEach((candle, i) => {
    index.set(candle.timestamp, [...(index.get(candle.timestamp) ?? []), { candle, index: i }]);
  });
  return index;
}

export type BarCheck =
  | { status: 'OK'; candle: MappedCandle }
  | { status: 'MISSING' }
  | { status: 'INVALID'; issues: string[] };

/** The one bar opening on a UTC day: present exactly once and passing validatePrices. */
export function barOn(index: BarIndex, day: number): BarCheck {
  const bars = index.get(day) ?? [];
  const [only] = bars;
  if (!only) return { status: 'MISSING' };
  if (bars.length > 1) return { status: 'INVALID', issues: ['DUPLICATE_TIMESTAMP'] };
  const issues = validatePrices(only.candle, only.index).map((issue) => issue.code);
  return issues.length > 0 ? { status: 'INVALID', issues } : { status: 'OK', candle: only.candle };
}

const barFact = (check: BarCheck) =>
  check.status === 'OK'
    ? { status: 'OK' as const }
    : check.status === 'MISSING'
      ? { status: 'MISSING' as const }
      : { status: 'INVALID' as const, issues: check.issues };

// ---------------------------------------------------------------------------------------------
// Observations

export type ObservationState =
  | 'INVALID_INPUT'
  | 'WINDOW_INCOMPLETE'
  | 'INSUFFICIENT'
  | 'EQUAL_PIVOT_LEVEL'
  | 'MIXED_STRUCTURE'
  | 'Up'
  | 'Down';
export const OBSERVATION_STATES: readonly ObservationState[] = [
  'INVALID_INPUT',
  'WINDOW_INCOMPLETE',
  'INSUFFICIENT',
  'EQUAL_PIVOT_LEVEL',
  'MIXED_STRUCTURE',
  'Up',
  'Down',
];
export type PreObservationCategory = 'NONE' | 'BEFORE_ESTABLISHMENT' | 'AFTER_ESTABLISHMENT';
export const PRE_OBSERVATION_CATEGORIES: readonly PreObservationCategory[] = [
  'NONE',
  'BEFORE_ESTABLISHMENT',
  'AFTER_ESTABLISHMENT',
];
export type Sign = 1 | -1 | 0;

export interface Observation {
  member: string;
  date: number;
  tau: number;
  configuration: Configuration;
  /** The candidate's output at tau_D, verbatim. */
  candidate: SwingStructureObservation;
  state: ObservationState;
  /** s: +1 Up, -1 Down, 0 for every other state. */
  sign: Sign;
  /** timing.frozenReference: the reference at tau_D, for Up and Down only. Never replaced. */
  reference: SwingPivot | null;
  establishedAt: number | null;
  preObservation: { close: PreObservationCategory; extreme: PreObservationCategory } | null;
}

/** window.rule: the candles opening on the UTC days D-179 through D, in export order. */
export function observationWindow(
  candles: readonly MappedCandle[],
  date: number,
  closedCandles: number,
): MappedCandle[] {
  const first = date - (closedCandles - 1) * DAY_MS;
  return candles.filter((candle) => candle.timestamp >= first && candle.timestamp < date + DAY_MS);
}

/** timing.invariants 1-4, on the candidate's output at tau_D. A violation refuses the run. */
export function checkTimingInvariants(
  output: SwingStructureObservation,
  tau: number,
  where: string,
): void {
  if (output.status === 'INVALID_INPUT') return;
  const fail = (rule: string) => refuse('TIMING_INVARIANT', `${where}: ${rule}`);
  const { rightBars } = output.config;
  const { intervalMs } = output.timeframe;
  const supporting = [...output.supportingHighs, ...output.supportingLows];
  for (const pivot of [...supporting, ...(output.reference ? [output.reference] : [])]) {
    if (pivot.availableAt !== pivot.candleOpenTime + (rightBars + 1) * intervalMs - 1) {
      fail('pivot.availableAt = pivot.candleOpenTime + (R + 1) x interval - 1');
    }
  }
  const { establishedAt } = output;
  const ceiling = establishedAt ?? tau;
  if (supporting.some((pivot) => pivot.availableAt > ceiling) || ceiling > tau) {
    fail("every supporting pivot's availableAt <= establishedAt <= tau_D");
  }
  if (
    establishedAt !== null &&
    establishedAt !== Math.max(...supporting.map((pivot) => pivot.availableAt))
  ) {
    fail('establishedAt is the latest availableAt of the supporting pivots');
  }
  const { reference } = output;
  if (!reference) return;
  if (establishedAt === null || reference.availableAt > establishedAt) {
    fail('reference.availableAt <= establishedAt');
  }
  for (const breach of [output.breach?.firstClose, output.breach?.firstExtreme]) {
    if (breach && !(reference.availableAt < breach.knowableAt && breach.knowableAt <= tau)) {
      fail('a breach reported at tau_D has reference.availableAt < knowableAt <= tau_D');
    }
  }
}

/** timing.preObservationBreach.categories, for one kind of breach. */
export function preObservationCategory(
  breach: ReferenceBreach | null,
  establishedAt: number,
): PreObservationCategory {
  if (!breach) return 'NONE';
  return breach.knowableAt <= establishedAt ? 'BEFORE_ESTABLISHMENT' : 'AFTER_ESTABLISHMENT';
}

function stateOf(
  output: SwingStructureObservation,
  tau: number,
  closedCandles: number,
): ObservationState {
  if (output.status === 'INVALID_INPUT') return 'INVALID_INPUT';
  // missingData.observation.WINDOW_INCOMPLETE: the window's first or last day is absent.
  if (output.closedCandles !== closedCandles || output.latestCloseTime !== tau) {
    return 'WINDOW_INCOMPLETE';
  }
  if (output.status === 'INSUFFICIENT') return 'INSUFFICIENT';
  if (output.direction !== 'Unclear') return output.direction;
  return output.reason === 'EQUAL_PIVOT_LEVEL' ? 'EQUAL_PIVOT_LEVEL' : 'MIXED_STRUCTURE';
}

/** One member, one UTC date D and one configuration: the candidate's full output at tau_D. */
export function observe(
  candles: readonly MappedCandle[],
  member: string,
  date: number,
  configuration: Configuration,
  closedCandles: number,
): Observation {
  const tau = closeOf(date);
  const candidate = evaluateSwingStructure({
    candles: observationWindow(candles, date, closedCandles),
    timeframe: DAILY,
    config: { leftBars: configuration.leftBars, rightBars: configuration.rightBars },
    cutoff: tau,
  });
  checkTimingInvariants(candidate, tau, `${member} ${isoDate(date)} ${configuration.id}`);
  const state = stateOf(candidate, tau, closedCandles);
  const directional = (state === 'Up' || state === 'Down') && candidate.status === 'EVALUATED';
  if (!directional) {
    return {
      member,
      date,
      tau,
      configuration,
      candidate,
      state,
      sign: 0,
      reference: null,
      establishedAt: null,
      preObservation: null,
    };
  }
  const { reference, establishedAt, breach } = candidate;
  if (!reference || establishedAt === null || !breach) {
    return refuse('TIMING_INVARIANT', `${member} ${isoDate(date)}: a state without its reference`);
  }
  return {
    member,
    date,
    tau,
    configuration,
    candidate,
    state,
    sign: state === 'Up' ? 1 : -1,
    reference,
    establishedAt,
    preObservation: {
      close: preObservationCategory(breach.firstClose, establishedAt),
      extreme: preObservationCategory(breach.firstExtreme, establishedAt),
    },
  };
}

/** timing.lookAheadCheck: the output with every later candle appended must be identical. */
export function assertNoLookAhead(
  observed: SwingStructureObservation,
  withLaterCandles: SwingStructureObservation,
  where: string,
): void {
  if (stableSerialize(observed) !== stableSerialize(withLaterCandles)) {
    refuse('LOOK_AHEAD', `${where}: later candles changed the observation`);
  }
}

// ---------------------------------------------------------------------------------------------
// Outcomes and forward breaches

export type Outcome =
  | { status: 'AVAILABLE'; referenceOpen: number; endpointOpen: number; r: number }
  | {
      status: 'MISSING' | 'INVALID';
      reference: ReturnType<typeof barFact>;
      endpoint: ReturnType<typeof barFact>;
    };

/** outcomes: r = ln O(D+1+h) - ln O(D+1). D's own close is never the reference. */
export function outcomeAt(
  index: BarIndex,
  date: number,
  horizon: number,
  exportCutoff: number,
): Outcome {
  const tau = closeOf(date);
  const referenceDay = tau + 1;
  const endpointDay = referenceDay + horizon * DAY_MS;
  if (closeOf(endpointDay) > exportCutoff) {
    refuse('OUTCOME_PENDING', `${isoDate(date)} + ${horizon}: the endpoint bar has not closed`);
  }
  const reference = barOn(index, referenceDay);
  const endpoint = barOn(index, endpointDay);
  if (reference.status === 'OK' && endpoint.status === 'OK') {
    if (reference.candle.timestamp !== tau + 1) {
      refuse('TIMING_INVARIANT', 'the outcome reference bar opens at tau_D + 1 ms');
    }
    const r = Math.log(endpoint.candle.open) - Math.log(reference.candle.open);
    return {
      status: 'AVAILABLE',
      referenceOpen: reference.candle.open,
      endpointOpen: endpoint.candle.open,
      r: finite(r, `r at ${isoDate(date)} + ${horizon}`),
    };
  }
  return {
    status: reference.status === 'MISSING' || endpoint.status === 'MISSING' ? 'MISSING' : 'INVALID',
    reference: barFact(reference),
    endpoint: barFact(endpoint),
  };
}

/** The candidate's predicate: strict, so equal is not beyond. */
const beyond = (reference: SwingPivot, price: number) =>
  reference.kind === 'low' ? price < reference.price : price > reference.price;

export interface FirstBreach {
  breached: boolean;
  /** 1 to h: the breaching bar opens on D + days. Null when not breached by h. */
  days: number | null;
}

export type ForwardScan =
  | { status: 'COMPLETE'; close: FirstBreach; extreme: FirstBreach }
  | { status: 'INCOMPLETE'; bars: { date: string; status: 'MISSING' | 'INVALID' }[] };

/**
 * analyses.C.forward: bars opening D+1 through D+h against the frozen reference price only. A
 * missing or invalid bar makes the horizon INCOMPLETE, never "no breach".
 */
export function forwardScan(
  index: BarIndex,
  date: number,
  reference: SwingPivot,
  horizon: number,
  exportCutoff: number,
): ForwardScan {
  const tau = closeOf(date);
  const bars: MappedCandle[] = [];
  const problems: { date: string; status: 'MISSING' | 'INVALID' }[] = [];
  for (let days = 1; days <= horizon; days++) {
    const day = tau + 1 + (days - 1) * DAY_MS;
    if (closeOf(day) > exportCutoff) {
      refuse('OUTCOME_PENDING', `${isoDate(date)}: forward bar ${isoDate(day)} has not closed`);
    }
    const check = barOn(index, day);
    if (check.status === 'OK') bars.push(check.candle);
    else problems.push({ date: isoDate(day), status: check.status });
  }
  if (problems.length > 0) return { status: 'INCOMPLETE', bars: problems };
  if (bars.some((bar) => bar.timestamp < tau + 1)) {
    refuse('TIMING_INVARIANT', 'a forward breach candle opens at or after tau_D + 1 ms');
  }
  const first = (price: (bar: MappedCandle) => number): FirstBreach => {
    const at = bars.findIndex((bar) => beyond(reference, price(bar)));
    return at < 0 ? { breached: false, days: null } : { breached: true, days: at + 1 };
  };
  return {
    status: 'COMPLETE',
    close: first((bar) => bar.close),
    extreme: first((bar) => bar[reference.kind]),
  };
}

/** analyses.C.atObservation: D's close against the frozen price, negative distance when beyond. */
export function atObservation(close: number, reference: SwingPivot, sign: 1 | -1) {
  return {
    closeBeyond: beyond(reference, close),
    signedDistance: finite(
      sign === 1 ? Math.log(close / reference.price) : Math.log(reference.price / close),
      'signed distance',
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Question B: base rates, signed excess and its aggregates

export type UnavailableReason =
  | 'NO_DIRECTIONAL_DATES'
  | 'TOO_FEW_DATES'
  | 'TOO_MANY_UNDEFINED_REPLICATES'
  | 'ZERO_VARIANCE'
  | 'NO_UP'
  | 'NO_DOWN'
  | 'NO_DATES_WITHOUT_MEMBER'
  | 'PHASE_UNAVAILABLE'
  | 'NO_VALUES';

/** degenerateCases.rule: a finite number, or UNAVAILABLE with its reason. Never a stand-in zero. */
export type Stat =
  { status: 'AVAILABLE'; value: number } | { status: 'UNAVAILABLE'; reason: UnavailableReason };

const unavailable = (reason: UnavailableReason): Stat => ({ status: 'UNAVAILABLE', reason });

function stat(value: number | null, reason: UnavailableReason): Stat {
  return value === null
    ? unavailable(reason)
    : { status: 'AVAILABLE', value: finite(value, `statistic (${reason} when absent)`) };
}

/** One grid analysed at one horizon. Rows are members in ticker order; columns are dates. */
export interface CellTable {
  members: readonly string[];
  /** The grid's UTC dates, ascending. */
  dates: readonly number[];
  sign: readonly (readonly Sign[])[];
  /** r_i(D,h), or null when the outcome is not AVAILABLE. Never zero for missing. */
  r: readonly (readonly (number | null)[])[];
  closeCategory: readonly (readonly (PreObservationCategory | null)[])[];
}

/**
 * baseline.eligibleBaselineDates: D' >= D (the path starts after tau_D), or D' <= D - h - 180
 * (the path ends, at the open of D'+1+h, no later than the open of D-179).
 */
export function baselineEligible(
  date: number,
  other: number,
  horizon: number,
  closedCandles: number,
): boolean {
  return other >= date || other <= date - (horizon + closedCandles) * DAY_MS;
}

export interface PreparedCell {
  table: CellTable;
  horizon: number;
  /** [k * positions + k']: whether original date k' may enter the base rate of date k. */
  eligible: Uint8Array;
  /** [member * positions + k]: r, or NaN when not AVAILABLE. NaN is skipped, never read as 0. */
  outcomes: Float64Array;
}

export function prepareCell(
  table: CellTable,
  horizon: number,
  closedCandles: number,
): PreparedCell {
  const n = table.dates.length;
  const eligible = new Uint8Array(n * n);
  table.dates.forEach((date, k) =>
    table.dates.forEach((other, kk) => {
      eligible[k * n + kk] = baselineEligible(date, other, horizon, closedCandles) ? 1 : 0;
    }),
  );
  const outcomes = new Float64Array(table.members.length * n).fill(Number.NaN);
  table.r.forEach((row, member) =>
    row.forEach((r, k) => {
      if (r !== null) outcomes[member * n + k] = finite(r, 'outcome');
    }),
  );
  return { table, horizon, eligible, outcomes };
}

export interface Term {
  member: number;
  /** The original grid position of this term's date. */
  original: number;
  sign: 1 | -1;
  r: number;
  b: number;
  piPlus: number;
  piMinus: number;
  baselineDates: number;
  e: number;
  a: number;
}

/**
 * b, pi+ and pi- for member i at original date k, over the positions of `order` (a replicate, or
 * the grid itself), each counted once per appearance, in that order. Eligibility always compares
 * original calendar dates.
 */
function baseRate(cell: PreparedCell, member: number, k: number, order: readonly number[]) {
  const n = cell.table.dates.length;
  const { eligible, outcomes } = cell;
  let sum = 0;
  let count = 0;
  let rises = 0;
  let falls = 0;
  const row = member * n;
  const from = k * n;
  for (let j = 0; j < order.length; j++) {
    const kk = order[j]!;
    if (eligible[from + kk] !== 1) continue;
    const value = outcomes[row + kk]!;
    if (Number.isNaN(value)) continue;
    sum += value;
    count += 1;
    // baseline.rateBaseRates and outcomes.ties: r = 0 is neither, and stays in the denominator.
    if (value > 0) rises += 1;
    else if (value < 0) falls += 1;
  }
  if (count === 0) {
    return refuse('EMPTY_BASELINE', `member ${member}, date ${isoDate(cell.table.dates[k] ?? 0)}`);
  }
  return {
    b: finite(sum / count, 'base rate'),
    piPlus: rises / count,
    piMinus: falls / count,
    baselineDates: count,
  };
}

/** e and a for every Up or Down observation with an AVAILABLE outcome, position by position. */
export function cellTerms(
  cell: PreparedCell,
  order: readonly number[] = cell.table.dates.map((_, k) => k),
): Term[][] {
  const { table } = cell;
  const n = table.dates.length;
  // A repeated date has the same base rate at every appearance: computed once per replicate.
  const memo: (ReturnType<typeof baseRate> | undefined)[] = new Array(table.members.length * n);
  const positions: Term[][] = [];
  for (const k of order) {
    const terms: Term[] = [];
    for (let member = 0; member < table.members.length; member++) {
      const sign = table.sign[member]?.[k] ?? 0;
      const r = table.r[member]?.[k] ?? null;
      if (sign === 0 || r === null) continue;
      const base = (memo[member * n + k] ??= baseRate(cell, member, k, order));
      terms.push({
        member,
        original: k,
        sign,
        r,
        b: base.b,
        piPlus: base.piPlus,
        piMinus: base.piMinus,
        baselineDates: base.baselineDates,
        e: finite(sign * (r - base.b), 'signed excess'),
        a: finite((sign * r > 0 ? 1 : 0) - (sign === 1 ? base.piPlus : base.piMinus), 'hit'),
      });
    }
    positions.push(terms);
  }
  return positions;
}

export interface CellAggregate {
  M: Stat;
  U: Stat;
  Dn: Stat;
  hitExcess: Stat;
  /** n = |G*|. */
  dates: number;
  observations: number;
  upDates: number;
  upObservations: number;
  downDates: number;
  downObservations: number;
  /** E(D) for each date in G*, in order. */
  E: number[];
}

/**
 * E(D), M, U, Dn and the hit excess over the terms that `include` keeps. Each position counts once,
 * members equally within it. For Down, b - r is computed as s x (r - b) = e, which is exact.
 */
export function aggregateTerms(
  positions: readonly (readonly Term[])[],
  include: (term: Term) => boolean = () => true,
): CellAggregate {
  const E: number[] = [];
  const A: number[] = [];
  const U: number[] = [];
  const Dn: number[] = [];
  let observations = 0;
  let upObservations = 0;
  let downObservations = 0;
  for (const terms of positions) {
    let sumE = 0;
    let sumA = 0;
    let count = 0;
    let sumUp = 0;
    let ups = 0;
    let sumDown = 0;
    let downs = 0;
    for (const term of terms) {
      if (!include(term)) continue;
      sumE += term.e;
      sumA += term.a;
      count += 1;
      if (term.sign === 1) {
        sumUp += term.e;
        ups += 1;
      } else {
        sumDown += term.e;
        downs += 1;
      }
    }
    // degenerateCases.emptyDate: K_D empty, so E(D) is undefined and D is not in G*.
    if (count === 0) continue;
    E.push(sumE / count);
    A.push(sumA / count);
    observations += count;
    if (ups > 0) {
      U.push(sumUp / ups);
      upObservations += ups;
    }
    if (downs > 0) {
      Dn.push(sumDown / downs);
      downObservations += downs;
    }
  }
  return {
    M: stat(mean(E), 'NO_DIRECTIONAL_DATES'),
    U: stat(mean(U), 'NO_UP'),
    Dn: stat(mean(Dn), 'NO_DOWN'),
    hitExcess: stat(mean(A), 'NO_DIRECTIONAL_DATES'),
    dates: E.length,
    observations,
    upDates: U.length,
    upObservations,
    downDates: Dn.length,
    downObservations,
    E,
  };
}

/** baseline.leaveOneMemberOut: base rates unchanged; dates left empty drop out. */
export function leaveOneMemberOut(
  members: readonly string[],
  positions: readonly (readonly Term[])[],
): Record<string, { M: Stat; dates: number; observations: number }> {
  return Object.fromEntries(
    members.map((ticker, member) => {
      const { M, dates, observations } = aggregateTerms(positions, (t) => t.member !== member);
      return [
        ticker,
        {
          M: M.status === 'AVAILABLE' ? M : unavailable('NO_DATES_WITHOUT_MEMBER'),
          dates,
          observations,
        },
      ];
    }),
  );
}

/** degenerateCases.phase: the median of M_0 to M_19 only when every M_p is available. */
export function medianOfPhases(values: readonly Stat[]): Stat {
  const available = values.flatMap((v) => (v.status === 'AVAILABLE' ? [v.value] : []));
  if (available.length === 0 || available.length !== values.length) {
    return unavailable('PHASE_UNAVAILABLE');
  }
  return stat(quantiles(available)?.['p50'] ?? null, 'PHASE_UNAVAILABLE');
}

// ---------------------------------------------------------------------------------------------
// Moving block bootstrap

/** uncertainty.random.draw: the block starts of one replicate. */
export function blockStarts(
  random: BootstrapRandom,
  grid: string,
  blockLength: number,
  replicate: number,
  positions: number,
): number[] {
  const blocks = positions + 1 - blockLength;
  const limit = Math.floor(2 ** 32 / blocks) * blocks;
  return Array.from({ length: Math.ceil(positions / blockLength) }, (_, j) => {
    for (let attempt = 0; ; attempt++) {
      const message = random.drawMessage
        .replace('{seed}', () => random.seed)
        .replace('{grid}', () => grid)
        .replace('{blockLength}', () => String(blockLength))
        .replace('{replicate}', () => String(replicate))
        .replace('{draw}', () => String(j + 1))
        .replace('{attempt}', () => String(attempt));
      const x = createHash('sha256').update(message, 'utf8').digest().readUInt32BE(0);
      if (x < limit) return x % blocks;
    }
  });
}

/** uncertainty.blocks: blocks in draw order, cut to the grid's length. Never wrapped. */
export function replicateOrder(
  starts: readonly number[],
  blockLength: number,
  positions: number,
): number[] {
  return starts
    .flatMap((start) => Array.from({ length: blockLength }, (_, offset) => start + offset))
    .slice(0, positions);
}

/** uncertainty.random.commonDraws: replicates r = 1..R, shared by every configuration and horizon. */
export function bootstrapOrders(
  random: BootstrapRandom,
  grid: string,
  blockLength: number,
  replicates: number,
  positions: number,
): number[][] {
  return Array.from({ length: replicates }, (_, r) =>
    replicateOrder(
      blockStarts(random, grid, blockLength, r + 1, positions),
      blockLength,
      positions,
    ),
  );
}

/** M* of one replicate, every quantity of the cell recomputed from its positions. */
export function replicateM(cell: PreparedCell, order: readonly number[]): Stat {
  return aggregateTerms(cellTerms(cell, order)).M;
}

export type Interval =
  | {
      blockLength: number;
      status: 'AVAILABLE';
      lower: number;
      upper: number;
      se: number;
      definedReplicates: number;
      replicateMean: number;
    }
  | {
      blockLength: number;
      status: 'UNAVAILABLE';
      reason: UnavailableReason;
      /** Null when no replicate was drawn. */
      definedReplicates: number | null;
      replicateMean: number | null;
    };

/** uncertainty.interval and uncertainty.availability, in that order of refusal. */
export function bootstrapInterval(
  cell: PreparedCell,
  observed: Pick<CellAggregate, 'M' | 'dates'>,
  orders: readonly (readonly number[])[],
  options: { blockLength: number; z: number; minimumDates: number },
): Interval {
  const { blockLength } = options;
  const none = (reason: UnavailableReason): Interval => ({
    blockLength,
    status: 'UNAVAILABLE',
    reason,
    definedReplicates: null,
    replicateMean: null,
  });
  if (observed.M.status === 'UNAVAILABLE') return none('NO_DIRECTIONAL_DATES');
  if (observed.dates < options.minimumDates) return none('TOO_FEW_DATES');
  const values: number[] = [];
  for (const order of orders) {
    const M = replicateM(cell, order);
    if (M.status === 'AVAILABLE') values.push(M.value);
  }
  const replicateMean = mean(values);
  const after = (reason: UnavailableReason): Interval => ({
    blockLength,
    status: 'UNAVAILABLE',
    reason,
    definedReplicates: values.length,
    replicateMean,
  });
  if (orders.length - values.length > MAXIMUM_UNDEFINED_REPLICATES) {
    return after('TOO_MANY_UNDEFINED_REPLICATES');
  }
  if (values.length < MINIMUM_DEFINED_REPLICATES || replicateMean === null) {
    return after('ZERO_VARIANCE');
  }
  let squares = 0;
  for (const value of values) squares += (value - replicateMean) ** 2;
  const se = finite(Math.sqrt(squares / (values.length - 1)), 'se*');
  if (se === 0) return after('ZERO_VARIANCE');
  // The centre is always the observed M, never the replicates' mean.
  const centre = observed.M.value;
  return {
    blockLength,
    status: 'AVAILABLE',
    lower: finite(centre - options.z * se, 'lower bound'),
    upper: finite(centre + options.z * se, 'upper bound'),
    se,
    definedReplicates: values.length,
    replicateMean,
  };
}

// ---------------------------------------------------------------------------------------------
// Classification of the primary cell

export type GateValue =
  { value: 'TRUE' | 'FALSE' } | { value: 'UNAVAILABLE'; reason: UnavailableReason };

/** Strict: exactly 0 fails, and UNAVAILABLE is never compared as a number. */
function positive(value: Stat): GateValue {
  if (value.status === 'UNAVAILABLE') return { value: 'UNAVAILABLE', reason: value.reason };
  return { value: value.value > 0 ? 'TRUE' : 'FALSE' };
}

function lowerBoundPositive(interval: Interval): GateValue {
  if (interval.status === 'UNAVAILABLE') return { value: 'UNAVAILABLE', reason: interval.reason };
  return { value: interval.lower > 0 ? 'TRUE' : 'FALSE' };
}

export type Classification = 'INFORMATIVE' | 'INCONCLUSIVE' | 'ADVERSE' | 'NOT_INTERPRETABLE';

export interface PrimaryClassificationInput {
  aggregate: Pick<
    CellAggregate,
    'dates' | 'upObservations' | 'upDates' | 'downObservations' | 'downDates' | 'U' | 'Dn'
  > & { hitExcess: Stat };
  intervals: { primary: Interval; longer: Interval };
  leaveOneMemberOut: Record<string, Stat>;
  phaseMedian: Stat;
  invalidOrIncompleteByMember: Record<string, number>;
  unavailableOutcomesByMember: Record<string, number>;
  thresholds: InterpretabilityThresholds;
}

export function classifyPrimaryCell(input: PrimaryClassificationInput) {
  const { aggregate, intervals, thresholds: t } = input;
  const atLeast = (id: string, value: number, minimum: number) => ({
    id,
    value,
    minimum,
    satisfied: value >= minimum,
  });
  const atMost = (id: string, byMember: Record<string, number>, maximum: number) => {
    const failing = Object.keys(byMember).filter((member) => (byMember[member] ?? 0) > maximum);
    return { id, byMember, maximum, failing, satisfied: failing.length === 0 };
  };
  const interpretability = [
    atLeast('minimumDates', aggregate.dates, t.minimumDates),
    atLeast('minimumUpObservations', aggregate.upObservations, t.minimumUpObservations),
    atLeast('minimumUpDates', aggregate.upDates, t.minimumUpDates),
    atLeast('minimumDownObservations', aggregate.downObservations, t.minimumDownObservations),
    atLeast('minimumDownDates', aggregate.downDates, t.minimumDownDates),
    atMost(
      'maximumInvalidOrIncompleteObservationsPerMember',
      input.invalidOrIncompleteByMember,
      t.maximumInvalidOrIncompleteObservationsPerMember,
    ),
    atMost(
      'maximumUnavailableOutcomesPerMember',
      input.unavailableOutcomesByMember,
      t.maximumUnavailableOutcomesPerMember,
    ),
    {
      id: 'primaryIntervalAvailable',
      satisfied: intervals.primary.status === 'AVAILABLE',
      ...(intervals.primary.status === 'UNAVAILABLE' && { reason: intervals.primary.reason }),
    },
  ];

  const memberGates = Object.entries(input.leaveOneMemberOut).map(([member, value]) => ({
    member,
    ...positive(value),
  }));
  const missing = memberGates.find((gate) => gate.value === 'UNAVAILABLE');
  const gate5: GateValue = missing
    ? { value: 'UNAVAILABLE', reason: 'NO_DATES_WITHOUT_MEMBER' }
    : { value: memberGates.every((gate) => gate.value === 'TRUE') ? 'TRUE' : 'FALSE' };
  const gates = [
    {
      gate: 1,
      test: 'lower bound of the ell = 4 interval > 0',
      ...lowerBoundPositive(intervals.primary),
    },
    {
      gate: 2,
      test: 'lower bound of the ell = 8 interval > 0',
      ...lowerBoundPositive(intervals.longer),
    },
    { gate: 3, test: 'U > 0', ...positive(aggregate.U) },
    { gate: 4, test: 'Dn > 0', ...positive(aggregate.Dn) },
    { gate: 5, test: 'M(-j) > 0 for each member', ...gate5, members: memberGates },
    { gate: 6, test: 'hit excess > 0', ...positive(aggregate.hitExcess) },
    { gate: 7, test: 'median of M_0 to M_19 > 0', ...positive(input.phaseMedian) },
  ];

  const failingConditions = interpretability.filter((c) => !c.satisfied).map((c) => c.id);
  let classification: Classification;
  let reasons: string[];
  if (failingConditions.length > 0) {
    classification = 'NOT_INTERPRETABLE';
    reasons = failingConditions;
  } else if (gates.every((gate) => gate.value === 'TRUE')) {
    classification = 'INFORMATIVE';
    reasons = [];
  } else if (
    intervals.primary.status === 'AVAILABLE' &&
    intervals.longer.status === 'AVAILABLE' &&
    intervals.primary.upper < 0 &&
    intervals.longer.upper < 0
  ) {
    classification = 'ADVERSE';
    reasons = [];
  } else {
    classification = 'INCONCLUSIVE';
    reasons = gates
      .filter((gate) => gate.value !== 'TRUE')
      .map((gate) => `gate ${gate.gate} ${gate.value}`);
  }
  return { interpretability, gates, classification, reasons };
}

// ---------------------------------------------------------------------------------------------
// Descriptive summaries

export type Summary =
  | {
      status: 'AVAILABLE';
      count: number;
      min: number;
      p25: number;
      median: number;
      p75: number;
      max: number;
    }
  | { status: 'UNAVAILABLE'; reason: 'NO_VALUES' };

export function summarize(values: readonly number[]): Summary {
  const q = quantiles(values);
  if (!q) return { status: 'UNAVAILABLE', reason: 'NO_VALUES' };
  const at = (key: string) => finite(q[key] ?? Number.NaN, `quantile ${key}`);
  return {
    status: 'AVAILABLE',
    count: values.length,
    min: at('p0'),
    p25: at('p25'),
    median: at('p50'),
    p75: at('p75'),
    max: at('p100'),
  };
}

const share = (count: number, total: number) =>
  stat(total === 0 ? null : count / total, 'NO_VALUES');

function wholeDays(ms: number, what: string): number {
  if (ms % DAY_MS !== 0) refuse('TIMING_INVARIANT', `${what} is not a whole number of UTC days`);
  return ms / DAY_MS;
}

function perMember<T>(tickers: readonly string[], build: (ticker: string) => T): Record<string, T> {
  return Object.fromEntries(tickers.map((ticker) => [ticker, build(ticker)]));
}

/** analyses.A.statuses and definitions, over all member-dates and over valid input. */
function coverage(observations: readonly Observation[]) {
  const count = (states: readonly ObservationState[]) =>
    observations.filter((o) => states.includes(o.state)).length;
  const total = observations.length;
  const invalid = count(['INVALID_INPUT', 'WINDOW_INCOMPLETE']);
  const validInput = total - invalid;
  const shares = (states: readonly ObservationState[], overValid = true) => {
    const n = count(states);
    return {
      count: n,
      ofAll: share(n, total),
      ...(overValid && { ofValidInput: share(n, validInput) }),
    };
  };
  return {
    memberDates: total,
    validInput,
    states: Object.fromEntries(
      OBSERVATION_STATES.map((state) => [
        state,
        shares([state], state !== 'INVALID_INPUT' && state !== 'WINDOW_INCOMPLETE'),
      ]),
    ),
    evaluable: shares(['EQUAL_PIVOT_LEVEL', 'MIXED_STRUCTURE', 'Up', 'Down']),
    directional: shares(['Up', 'Down']),
    unclear: shares(['INSUFFICIENT', 'EQUAL_PIVOT_LEVEL', 'MIXED_STRUCTURE']),
  };
}

/** analyses.A.latency, in whole days, for Up and Down separately. */
function latency(observations: readonly Observation[]) {
  const forState = (state: 'Up' | 'Down') => {
    const rows = observations.filter((o) => o.state === state);
    const lags = new Set<number>();
    const delay: number[] = [];
    const stateAge: number[] = [];
    const referenceAge: number[] = [];
    for (const o of rows) {
      if (o.candidate.status !== 'EVALUATED' || !o.reference || o.establishedAt === null) {
        return refuse('TIMING_INVARIANT', `${o.member} ${isoDate(o.date)}: state without timing`);
      }
      for (const pivot of [...o.candidate.supportingHighs, ...o.candidate.supportingLows]) {
        const lag = wholeDays(
          pivot.availableAt - closeOf(pivot.candleOpenTime),
          'confirmation lag',
        );
        if (lag !== o.configuration.rightBars) {
          refuse('TIMING_INVARIANT', `${o.member} ${isoDate(o.date)}: confirmation lag ${lag}`);
        }
        lags.add(lag);
      }
      const referenceClose = closeOf(o.reference.candleOpenTime);
      delay.push(wholeDays(o.establishedAt - referenceClose, 'establishment delay'));
      stateAge.push(wholeDays(o.tau - o.establishedAt, 'state age'));
      referenceAge.push(wholeDays(o.tau - referenceClose, 'reference age'));
    }
    return {
      observations: rows.length,
      confirmationLagDays: [...lags],
      establishmentDelay: summarize(delay),
      stateAge: summarize(stateAge),
      referenceAge: summarize(referenceAge),
    };
  };
  return { Up: forState('Up'), Down: forState('Down') };
}

const directionOf = (o: Observation) =>
  o.state === 'INVALID_INPUT' || o.state === 'WINDOW_INCOMPLETE'
    ? null
    : o.state === 'Up' || o.state === 'Down'
      ? o.state
      : 'Unclear';

/**
 * analyses.A.transitions on consecutive daily dates: a change is a different direction (Up, Down
 * or Unclear) on the next day, both days having valid input. Runs touching an end are kept.
 */
function transitions(byMember: Record<string, readonly Observation[]>) {
  const runs: Record<'Up' | 'Down', number[]> = { Up: [], Down: [] };
  const members = perMember(Object.keys(byMember), (ticker) => {
    const daily = byMember[ticker] ?? [];
    let compared = 0;
    let changes = 0;
    let runState: 'Up' | 'Down' | null = null;
    let runLength = 0;
    daily.forEach((o, i) => {
      const previous = daily[i - 1];
      const before = previous ? directionOf(previous) : null;
      const now = directionOf(o);
      if (before !== null && now !== null) {
        compared += 1;
        if (before !== now) changes += 1;
      }
      if (runState !== null && o.state === runState) {
        runLength += 1;
        return;
      }
      if (runState !== null) runs[runState].push(runLength);
      runState = o.state === 'Up' || o.state === 'Down' ? o.state : null;
      runLength = runState === null ? 0 : 1;
    });
    const last = runState as 'Up' | 'Down' | null;
    if (last !== null) runs[last].push(runLength);
    return {
      comparedDayPairs: compared,
      changes,
      changesPer365Days: stat(compared === 0 ? null : (changes * 365) / compared, 'NO_VALUES'),
    };
  });
  return { members, runLengths: { Up: summarize(runs.Up), Down: summarize(runs.Down) } };
}

// ---------------------------------------------------------------------------------------------
// The study, on candles supplied in memory

interface MemberSeries {
  usable: MappedCandle[];
  index: BarIndex;
}

const halfYear = (date: number) => {
  const d = new Date(date);
  return `${d.getUTCFullYear()}H${d.getUTCMonth() < 6 ? 1 : 2}`;
};

/**
 * Runs A, B and C on `members`, the mapped candles of each universe member in export order. Only
 * bars closed by the export cutoff are used. Any refusal stops the whole study.
 */
export function evaluateSwingStructureStudy(
  spec: SwingStructureEvaluationSpecification,
  members: Readonly<Record<string, readonly DailyCandle[]>>,
) {
  if (spec.specificationId !== SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID) {
    refuse('SPECIFICATION', `not specification ${SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID}`);
  }
  if (
    spec.candidate.id !== SWING_STRUCTURE_CANDIDATE_ID ||
    spec.candidate.version !== SWING_STRUCTURE_CANDIDATE_VERSION ||
    spec.timeframe.label !== DAILY.label ||
    spec.timeframe.intervalMs !== DAILY.intervalMs
  ) {
    refuse('SPECIFICATION', 'candidate or timeframe differs from the one implemented');
  }
  const schedule = studySchedule(spec);
  const tickers = Object.keys(spec.universe.members).sort(byCodeUnit);
  // universe.fixed: never fewer members, never others.
  if (stableSerialize(Object.keys(members).sort(byCodeUnit)) !== stableSerialize(tickers)) {
    refuse('DATA_UNAVAILABLE', `members must be exactly ${tickers.join(', ')}`);
  }
  const exportCutoff = Date.parse(spec.data.export.retrievalStartedAt);
  const W = spec.window.closedCandles;
  const configurations = spec.configurations;
  const horizons = [...spec.horizons.utcDays].sort((a, b) => a - b);
  const series = new Map<string, MemberSeries>(
    tickers.map((ticker) => {
      // The forming bar, and anything else not closed by the cutoff, is never used.
      const usable = mappedSeries(ticker, members[ticker] ?? []).filter(
        (candle) => closeOf(candle.timestamp) <= exportCutoff,
      );
      return [ticker, { usable, index: indexBars(usable) }];
    }),
  );
  const seriesOf = (ticker: string) => series.get(ticker) ?? refuse('DATA_UNAVAILABLE', ticker);
  const first = schedule.daily[0] ?? refuse('SPECIFICATION', 'no daily dates');
  const position = (date: number) => (date - first) / DAY_MS;
  const g0 = schedule.phases[0] ?? [];

  // Every observation on every daily date: A uses them all, B and C the grids among them.
  const observations = new Map(
    configurations.map((configuration) => [
      configuration.id,
      new Map(
        tickers.map((ticker) => [
          ticker,
          schedule.daily.map((date) =>
            observe(seriesOf(ticker).usable, ticker, date, configuration, W),
          ),
        ]),
      ),
    ]),
  );
  const observationsOf = (configurationId: string, ticker: string) =>
    observations.get(configurationId)?.get(ticker) ?? refuse('SPECIFICATION', configurationId);
  const observationAt = (configurationId: string, ticker: string, date: number) =>
    observationsOf(configurationId, ticker)[position(date)] ??
    refuse('SPECIFICATION', `${ticker} ${isoDate(date)}`);

  // timing.lookAheadCheck on every primary-grid observation.
  for (const configuration of configurations) {
    for (const ticker of tickers) {
      const { usable } = seriesOf(ticker);
      for (const date of g0) {
        const tau = closeOf(date);
        const extended = evaluateSwingStructure({
          candles: [
            ...observationWindow(usable, date, W),
            ...usable.filter((candle) => candle.timestamp > tau),
          ],
          timeframe: DAILY,
          config: { leftBars: configuration.leftBars, rightBars: configuration.rightBars },
          cutoff: tau,
        });
        assertNoLookAhead(
          observationAt(configuration.id, ticker, date).candidate,
          extended,
          `${ticker} ${isoDate(date)} ${configuration.id}`,
        );
      }
    }
  }

  const outcomes = new Map(
    tickers.map((ticker) => [
      ticker,
      new Map(
        horizons.map((h) => [
          h,
          schedule.daily.map((date) => outcomeAt(seriesOf(ticker).index, date, h, exportCutoff)),
        ]),
      ),
    ]),
  );
  const outcomeOf = (ticker: string, h: number, date: number) =>
    outcomes.get(ticker)?.get(h)?.[position(date)] ?? refuse('SPECIFICATION', `${ticker} ${h}`);

  const table = (configurationId: string, h: number, dates: readonly number[]): CellTable => ({
    members: tickers,
    dates,
    sign: tickers.map((ticker) => dates.map((d) => observationAt(configurationId, ticker, d).sign)),
    r: tickers.map((ticker) =>
      dates.map((d) => {
        const outcome = outcomeOf(ticker, h, d);
        return outcome.status === 'AVAILABLE' ? outcome.r : null;
      }),
    ),
    closeCategory: tickers.map((ticker) =>
      dates.map((d) => observationAt(configurationId, ticker, d).preObservation?.close ?? null),
    ),
  });

  // ------------------------------------------------------------------------------- B
  const { primary: shortBlock, longer: longBlock } = spec.uncertainty.blockLengths;
  const gridId = spec.observations.primaryGrid.id;
  const orders = new Map(
    [shortBlock, longBlock].map((ell) => [
      ell,
      bootstrapOrders(spec.uncertainty.random, gridId, ell, spec.uncertainty.replicates, g0.length),
    ]),
  );
  const intervalOptions = (blockLength: number) => ({
    blockLength,
    z: spec.uncertainty.zQuantile,
    minimumDates: spec.interpretability.minimumDates,
  });
  const halfYears = [...new Set(g0.map(halfYear))];
  const summaryOf = (a: CellAggregate) => ({
    dates: a.dates,
    observations: a.observations,
    upObservations: a.upObservations,
    downObservations: a.downObservations,
    M: a.M,
    U: a.U,
    Dn: a.Dn,
    hitExcess: a.hitExcess,
  });

  const analysed = configurations.flatMap((configuration) =>
    horizons.map((h) => {
      const cell = prepareCell(table(configuration.id, h, g0), h, W);
      const positions = cellTerms(cell);
      const aggregate = aggregateTerms(positions);
      const interval = (ell: number) =>
        bootstrapInterval(cell, aggregate, orders.get(ell) ?? [], intervalOptions(ell));
      // uncertainty.overlapRule: no interval and no standard error at h = 60.
      const intervals = spec.uncertainty.intervalHorizons.includes(h)
        ? { primary: interval(shortBlock), longer: interval(longBlock) }
        : null;
      const isPrimary =
        configuration.id === spec.primary.configuration && h === spec.primary.horizonUtcDays;
      return { configuration, h, cell, positions, aggregate, intervals, isPrimary };
    }),
  );

  // analyses.B.primaryCell: the only classified result.
  const primaryInput = analysed.find((a) => a.isPrimary);
  if (!primaryInput?.intervals) return refuse('SPECIFICATION', 'no primary cell with intervals');
  const primary = (() => {
    const { configuration, h, positions, aggregate, intervals } = primaryInput;
    const phases = schedule.phases.map((dates, p) => {
      const a = aggregateTerms(cellTerms(prepareCell(table(configuration.id, h, dates), h, W)));
      return {
        phase: p,
        gridDates: dates.length,
        dates: a.dates,
        observations: a.observations,
        M: a.M,
      };
    });
    const phaseMedian = medianOfPhases(phases.map((p) => p.M));
    const lomo = leaveOneMemberOut(tickers, positions);
    const countOnGrid = (test: (date: number) => boolean) => g0.filter(test).length;
    return {
      configuration: configuration.id,
      horizon: h,
      grid: gridId,
      ...summaryOf(aggregate),
      upDates: aggregate.upDates,
      downDates: aggregate.downDates,
      intervals,
      leaveOneMemberOut: lomo,
      phases,
      phaseMedian,
      ...classifyPrimaryCell({
        aggregate,
        intervals,
        leaveOneMemberOut: perMember(tickers, (t) => lomo[t]?.M ?? unavailable('NO_VALUES')),
        phaseMedian,
        invalidOrIncompleteByMember: perMember(tickers, (ticker) =>
          countOnGrid((d) => {
            const { state } = observationAt(configuration.id, ticker, d);
            return state === 'INVALID_INPUT' || state === 'WINDOW_INCOMPLETE';
          }),
        ),
        unavailableOutcomesByMember: perMember(tickers, (ticker) =>
          countOnGrid((d) => outcomeOf(ticker, h, d).status !== 'AVAILABLE'),
        ),
        thresholds: spec.interpretability,
      }),
    };
  })();

  const cells = analysed.map(
    ({ configuration, h, cell, positions, aggregate, intervals, isPrimary }) => {
      return {
        configuration: configuration.id,
        horizon: h,
        grid: gridId,
        role: isPrimary ? ('primary' as const) : ('exploratory' as const),
        ...summaryOf(aggregate),
        upDates: aggregate.upDates,
        downDates: aggregate.downDates,
        ...(intervals ? { intervals } : { quartilesOfE: summarize(aggregate.E) }),
        breakdowns: {
          members: perMember(tickers, (ticker) =>
            summaryOf(aggregateTerms(positions, (t) => tickers[t.member] === ticker)),
          ),
          halfYears: Object.fromEntries(
            halfYears.map((label) => [
              label,
              {
                gridDates: g0.filter((d) => halfYear(d) === label).length,
                ...summaryOf(
                  aggregateTerms(positions, (t) => halfYear(g0[t.original] ?? 0) === label),
                ),
              },
            ]),
          ),
          preObservationClose: Object.fromEntries(
            PRE_OBSERVATION_CATEGORIES.map((category) => [
              category,
              summaryOf(
                aggregateTerms(
                  positions,
                  (t) => cell.table.closeCategory[t.member]?.[t.original] === category,
                ),
              ),
            ]),
          ),
        },
        terms: positions.flat().map((t) => ({
          member: tickers[t.member] ?? '',
          date: isoDate(g0[t.original] ?? 0),
          sign: t.sign,
          r: t.r,
          b: t.b,
          piPlus: t.piPlus,
          piMinus: t.piMinus,
          baselineDates: t.baselineDates,
          e: t.e,
          a: t.a,
        })),
      };
    },
  );

  // ------------------------------------------------------------------------------- A
  const A = configurations.map((configuration) => {
    const byMember = (dates: readonly number[]) =>
      perMember(tickers, (ticker) => dates.map((d) => observationAt(configuration.id, ticker, d)));
    const dateSet = (dates: readonly number[]) => {
      const rows = byMember(dates);
      const pooled = tickers.flatMap((ticker) => rows[ticker] ?? []);
      return {
        coverage: {
          pooled: coverage(pooled),
          members: perMember(tickers, (t) => coverage(rows[t] ?? [])),
        },
        latency: latency(pooled),
      };
    };
    return {
      configuration: configuration.id,
      daily: dateSet(schedule.daily),
      primaryGrid: dateSet(g0),
      transitions: transitions(byMember(schedule.daily)),
    };
  });

  // ------------------------------------------------------------------------------- C
  const forwardRows: {
    configuration: string;
    member: string;
    date: number;
    observation: Observation;
    at: ReturnType<typeof atObservation>;
    forward: Record<number, ForwardScan>;
  }[] = [];
  for (const configuration of configurations) {
    for (const ticker of tickers) {
      const { index } = seriesOf(ticker);
      for (const date of g0) {
        const observation = observationAt(configuration.id, ticker, date);
        const { reference, sign } = observation;
        if (!reference || sign === 0) continue;
        const dayBar = barOn(index, date);
        if (dayBar.status !== 'OK') {
          return refuse('TIMING_INVARIANT', `${ticker} ${isoDate(date)}: D's bar is not usable`);
        }
        forwardRows.push({
          configuration: configuration.id,
          member: ticker,
          date,
          observation,
          at: atObservation(dayBar.candle.close, reference, sign),
          forward: Object.fromEntries(
            horizons.map((h) => [h, forwardScan(index, date, reference, h, exportCutoff)]),
          ),
        });
      }
    }
  }
  const referenceKey = (row: (typeof forwardRows)[number]) =>
    `${row.member}|${row.observation.reference?.kind}|${row.observation.reference?.candleOpenTime}`;
  const distinct = (rows: readonly (typeof forwardRows)[number][]) =>
    new Set(rows.map(referenceKey)).size;
  const C = configurations.map((configuration) => {
    const rows = forwardRows.filter((row) => row.configuration === configuration.id);
    const pooledAndMembers = <T>(build: (subset: typeof rows) => T) => ({
      pooled: build(rows),
      members: perMember(tickers, (ticker) => build(rows.filter((row) => row.member === ticker))),
    });
    const categories = (kind: 'close' | 'extreme') =>
      pooledAndMembers((subset) =>
        Object.fromEntries(
          PRE_OBSERVATION_CATEGORIES.map((category) => [
            category,
            subset.filter((row) => row.observation.preObservation?.[kind] === category).length,
          ]),
        ),
      );
    const forwardGroup = (h: number, kind: 'close' | 'extreme', category: PreObservationCategory) =>
      pooledAndMembers((subset) => {
        const group = subset.filter((row) => row.observation.preObservation?.[kind] === category);
        const complete = group.flatMap((row) => {
          const scan = row.forward[h];
          return scan?.status === 'COMPLETE' ? [scan[kind]] : [];
        });
        const breached = complete.flatMap((b) => (b.breached && b.days !== null ? [b.days] : []));
        return {
          observations: group.length,
          incomplete: group.length - complete.length,
          complete: complete.length,
          breached: breached.length,
          shareBreached: share(breached.length, complete.length),
          daysToFirstBreach: summarize(breached),
          distinctReferences: distinct(group),
        };
      });
    return {
      configuration: configuration.id,
      observations: rows.length,
      distinctReferences: distinct(rows),
      atObservation: {
        close: categories('close'),
        extreme: categories('extreme'),
        closeBeyondReference: pooledAndMembers((s) => s.filter((row) => row.at.closeBeyond).length),
        signedDistance: pooledAndMembers((s) => summarize(s.map((row) => row.at.signedDistance))),
      },
      forward: Object.fromEntries(
        horizons.map((h) => [
          h,
          {
            close: Object.fromEntries(
              PRE_OBSERVATION_CATEGORIES.map((c) => [c, forwardGroup(h, 'close', c)]),
            ),
            extreme: Object.fromEntries(
              PRE_OBSERVATION_CATEGORIES.map((c) => [c, forwardGroup(h, 'extreme', c)]),
            ),
          },
        ]),
      ),
    };
  });

  // ------------------------------------------------------------------------------- exclusions
  const required: number[] = [];
  for (
    let d = utcDay(spec.data.bars.firstBar);
    d <= utcDay(spec.data.bars.lastClosedBar);
    d += DAY_MS
  ) {
    required.push(d);
  }
  const requiredDays = new Set(required);
  const completeness = perMember(tickers, (ticker) => {
    const { index, usable } = seriesOf(ticker);
    const checks = required.map((d) => ({ date: isoDate(d), check: barOn(index, d) }));
    return {
      required: required.length,
      found: checks.filter((c) => c.check.status === 'OK').length,
      missing: checks.filter((c) => c.check.status === 'MISSING').map((c) => c.date),
      duplicate: required.filter((d) => (index.get(d)?.length ?? 0) > 1).map(isoDate),
      invalid: checks.flatMap((c) =>
        c.check.status === 'INVALID' ? [{ date: c.date, issues: c.check.issues }] : [],
      ),
      /** Closed bars whose open is not a required UTC midnight, by open time. */
      notOnRequiredDays: usable
        .filter((candle) => !requiredDays.has(candle.timestamp))
        .map((candle) => candle.timestamp),
    };
  });
  const exclusions = {
    observations: configurations.flatMap((configuration) =>
      tickers.flatMap((ticker) =>
        observationsOf(configuration.id, ticker).flatMap((o) =>
          o.state === 'INVALID_INPUT' || o.state === 'WINDOW_INCOMPLETE'
            ? [
                {
                  member: ticker,
                  configuration: configuration.id,
                  date: isoDate(o.date),
                  state: o.state,
                  issues:
                    o.candidate.status === 'INVALID_INPUT'
                      ? o.candidate.issues.map((issue) => issue.code)
                      : [],
                },
              ]
            : [],
        ),
      ),
    ),
    outcomes: tickers.flatMap((ticker) =>
      horizons.flatMap((h) =>
        schedule.daily.flatMap((date) => {
          const outcome = outcomeOf(ticker, h, date);
          return outcome.status === 'AVAILABLE'
            ? []
            : [{ member: ticker, horizon: h, date: isoDate(date), ...outcome }];
        }),
      ),
    ),
    forward: forwardRows.flatMap((row) =>
      horizons.flatMap((h) => {
        const scan = row.forward[h];
        return scan?.status === 'INCOMPLETE'
          ? [
              {
                member: row.member,
                configuration: row.configuration,
                date: isoDate(row.date),
                horizon: h,
                bars: scan.bars,
              },
            ]
          : [];
      }),
    ),
    outcomeCounts: Object.fromEntries(
      (
        [
          ['daily', schedule.daily],
          ['primaryGrid', g0],
        ] as const
      ).map(([name, dates]) => [
        name,
        Object.fromEntries(
          horizons.map((h) => [
            h,
            perMember(tickers, (ticker) =>
              Object.fromEntries(
                (['AVAILABLE', 'MISSING', 'INVALID'] as const).map((status) => [
                  status,
                  dates.filter((d) => outcomeOf(ticker, h, d).status === status).length,
                ]),
              ),
            ),
          ]),
        ),
      ]),
    ),
  };

  // ------------------------------------------------------------------------------- rows
  const forwardByKey = new Map(
    forwardRows.map((row) => [`${row.configuration}|${row.member}|${row.date}`, row]),
  );
  const g0Set = new Set(g0);
  const rows = configurations.flatMap((configuration) =>
    tickers.flatMap((ticker) =>
      observationsOf(configuration.id, ticker).map((o) => {
        const c = forwardByKey.get(`${configuration.id}|${ticker}|${o.date}`);
        return {
          // reproducibility.attribution, in its order.
          studyId: spec.studyId,
          specificationId: spec.specificationId,
          candidateId: SWING_STRUCTURE_CANDIDATE_ID,
          candidateVersion: SWING_STRUCTURE_CANDIDATE_VERSION,
          configuration: configuration.id,
          leftBars: configuration.leftBars,
          rightBars: configuration.rightBars,
          timeframe: spec.timeframe.label,
          member: ticker,
          symbol: spec.universe.members[ticker] ?? null,
          date: isoDate(o.date),
          tau: o.tau,
          candidate: o.candidate,
          state: o.state,
          primaryGrid: g0Set.has(o.date),
          phase: position(o.date) % spec.observations.primaryGrid.spacingDays,
          preObservation: o.preObservation,
          outcomes: Object.fromEntries(horizons.map((h) => [h, outcomeOf(ticker, h, o.date)])),
          ...(c && { atObservation: c.at, forward: c.forward }),
        };
      }),
    ),
  );

  return {
    studyId: spec.studyId,
    specificationId: spec.specificationId,
    candidate: { id: SWING_STRUCTURE_CANDIDATE_ID, version: SWING_STRUCTURE_CANDIDATE_VERSION },
    members: Object.fromEntries(tickers.map((t) => [t, spec.universe.members[t] ?? null])),
    timeframe: DAILY,
    exportCutoff,
    quantileMethod: QUANTILE_METHOD,
    schedule: {
      daily: {
        first: isoDate(first),
        last: isoDate(schedule.daily.at(-1) ?? first),
        count: schedule.daily.length,
      },
      primaryGrid: g0.map(isoDate),
      phaseGridSizes: schedule.phases.map((dates) => dates.length),
    },
    completeness,
    A,
    B: { primary, cells },
    C: {
      headlineCell: {
        configuration: spec.primary.configuration,
        horizon: spec.primary.horizonUtcDays,
      },
      configurations: C,
    },
    exclusions,
    observations: rows,
  };
}

export type SwingStructureEvaluationResults = ReturnType<typeof evaluateSwingStructureStudy>;

/** reproducibility.determinism: numbers serialized by JSON.stringify, no wall-clock time. */
export function serializeSwingStructureResults(results: SwingStructureEvaluationResults): string {
  return `${JSON.stringify(results)}\n`;
}
