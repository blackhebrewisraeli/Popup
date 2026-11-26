/**
 * activityShock24h incremental-value screen (docs/spot-24h-activity-shock-increment-dev-v1.json,
 * revision 3, frozen). Pure functions over data in memory: request planning and the retrieval
 * loop under the stop rules (network injected), validation and classification of every retrieved
 * hour, OHLC parity with v1, activityShock24h, the joined dataset with #222 row parity, and every
 * metric, interval, floor and the verdict. The four fits live in
 * scripts/activity_shock_classifier.py. #224's, #222's and v1's code is called, never changed.
 * Development research on examined data: no account, order, alert or production store.
 */
import { createHash } from 'node:crypto';
import specJson from '../docs/spot-24h-activity-shock-increment-dev-v1.json';
import { stableSerialize } from '@/lib/stableSerialize';
import { checkRow, ohlcParity, type HourCheck, type HourStatus } from './binanceActivityProbe';
import {
  CLASSES,
  decileBins,
  EXCLUSIONS as PRICE_EXCLUSIONS,
  RULES as STAGE_D_RULES,
  type Klass,
  type Probabilities,
  type Row as StageDRow,
} from './expectedNet';
import { decisionAt, FEATURES } from './quantileForecast';
import {
  dayOf,
  dayOrders,
  featuresAt,
  HOUR_MS,
  PROTOCOL,
  ratioInterval,
  splitDays,
  splitOf,
  type Category,
  type HourlyIndex,
  type Interval,
  type Protocol,
  type Split,
} from './spot24h';

export const SPEC = specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');

/** Numbers the specification states in prose; a test checks each against its text. */
export const RULES = {
  /** retrieval.range */
  firstOpen: 1729555200000,
  endExclusive: 1795305600000,
  hoursPerPair: 18264,
  /** retrieval.requests */
  requestSpanMs: 3_600_000_000,
  limit: 1000,
  requestsPerPair: 19,
  /** retrieval.order */
  pauseMs: 250,
  /** retrieval.stopRules */
  maxRetryAfterS: 120,
  maxUsedWeight: 3000,
  /** validation.ohlcParity.hours: v1's first saved candle */
  v1FirstOpen: Date.parse('2024-11-13T16:00:00.000Z'),
  /** activityFeature.definition */
  windowHours: 744,
  blockHours: 24,
  blocks: 30,
  /** observations.coverage.requirement and evidenceFloors */
  minCoverage: 0.95,
  minObservations: 2000,
  minDays: 90,
  minDefined: 9900,
} as const;

export const HOST = 'https://api.binance.com';
export const ACTIVITY = 'activityShock24h';
export const ACTIVITY_REASONS = [
  'ACTIVITY_WINDOW_MISSING',
  'ACTIVITY_WINDOW_INVALID',
  'ACTIVITY_BLOCK_ZERO',
  'ACTIVITY_DISPERSION_ZERO',
  'ACTIVITY_NOT_FINITE',
] as const;
export type ActivityReason = (typeof ACTIVITY_REASONS)[number];
/** observations.exclusions.order: #222's reasons, then the activity reasons. */
export const EXCLUSIONS = [...PRICE_EXCLUSIONS, ...ACTIVITY_REASONS] as const;
export type Exclusion = (typeof EXCLUSIONS)[number];
export const SPLITS = ['train', 'validation', 'test'] as const;
export const ARMS = ['A', 'B'] as const;
export type Arm = (typeof ARMS)[number];
export const COLUMNS = [
  'symbol',
  'time',
  'split',
  'stageDRow',
  'exclusion',
  ...FEATURES,
  ACTIVITY,
  'outcome',
  'class',
] as const;

const sumOf = (values: readonly number[]) => values.reduce((s, x) => s + x, 0);
const byText = (a: string, b: string) => a.localeCompare(b);
const monthOf = (time: number) => new Date(time).toISOString().slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Retrieval: plan and stop rules

export interface PlannedRequest {
  symbol: string;
  k: number;
  startTime: number;
  endTime: number;
  expectedRows: number;
  url: string;
}

/** retrieval.requests and order: pairs in the given order, then k = 0 … 18. */
export function planRequests(pairs: readonly string[]): PlannedRequest[] {
  return pairs.flatMap((symbol) => {
    if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new Error(`Unexpected symbol ${symbol}`);
    return Array.from({ length: RULES.requestsPerPair }, (_, k) => {
      const startTime = RULES.firstOpen + k * RULES.requestSpanMs;
      const endTime = Math.min(startTime + RULES.requestSpanMs - 1, RULES.endExclusive - 1);
      const url =
        `${HOST}/api/v3/klines?symbol=${symbol}&interval=1h` +
        `&startTime=${startTime}&endTime=${endTime}&limit=${RULES.limit}`;
      return {
        symbol,
        k,
        startTime,
        endTime,
        expectedRows: (endTime + 1 - startTime) / HOUR_MS,
        url,
      };
    });
  });
}

export const rawName = (r: { symbol: string; k: number }) =>
  `raw/${r.symbol}-${String(r.k).padStart(2, '0')}.json`;

export interface RequestLog {
  symbol: string;
  k: number;
  url: string;
  attempt: 1 | 2;
  sentAt: string;
  receivedAt: string;
  status: number | null;
  usedWeight1m: number | null;
  retryAfter: string | null;
  bytes: number | null;
  sha256: string | null;
  error?: string;
}

export interface RetrievalIo {
  fetchImpl: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Writes a raw body once; never overwrites. */
  save: (name: string, bytes: Buffer) => Promise<void>;
}

type Step = { ok: true } | { retryAfterMs: number } | { stop: string };
const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** One attempt of one request, logged, judged by retrieval.stopRules. */
async function attempt(
  request: PlannedRequest,
  attemptNo: 1 | 2,
  io: RetrievalIo,
  log: RequestLog[],
): Promise<Step> {
  const id = `${request.symbol} k=${request.k}`;
  const entry = { symbol: request.symbol, k: request.k, url: request.url, attempt: attemptNo };
  const sentAt = iso(io.now());
  const failed = (error: unknown): Step => {
    log.push({
      ...entry,
      sentAt,
      receivedAt: iso(io.now()),
      status: null,
      usedWeight1m: null,
      retryAfter: null,
      bytes: null,
      sha256: null,
      error: String(error),
    });
    return { stop: `network error or timeout on ${id}: ${String(error)}` };
  };
  let response: Response;
  let bytes: Buffer;
  try {
    response = await io.fetchImpl(request.url);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return failed(error);
  }
  const weight = Number(response.headers.get('x-mbx-used-weight-1m'));
  const usedWeight1m =
    response.headers.has('x-mbx-used-weight-1m') && Number.isFinite(weight) ? weight : null;
  const retryAfter = response.headers.get('retry-after');
  log.push({
    ...entry,
    sentAt,
    receivedAt: iso(io.now()),
    status: response.status,
    usedWeight1m,
    retryAfter,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
  const { status } = response;
  if (status === 429) {
    if (attemptNo === 2) return { stop: `second 429 on ${id}` };
    const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    if (!(seconds >= 0 && seconds <= RULES.maxRetryAfterS)) {
      return { stop: `429 with Retry-After ${retryAfter} on ${id}` };
    }
    return { retryAfterMs: seconds * 1000 };
  }
  if (status === 418 || status === 403 || status === 451)
    return { stop: `HTTP ${status} on ${id}` };
  if (status !== 200) return { stop: `HTTP ${status} on ${id}` };
  await io.save(rawName(request), bytes);
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { stop: `non-JSON body on ${id}` };
  }
  if (!Array.isArray(body)) return { stop: `body is not a JSON array on ${id}` };
  if (usedWeight1m !== null && usedWeight1m > RULES.maxUsedWeight) {
    return { stop: `X-MBX-USED-WEIGHT-1M ${usedWeight1m} above ${RULES.maxUsedWeight}` };
  }
  return { ok: true };
}

/** Requests one at a time, in order, at least pauseMs apart. Returns the log and any stop. */
export async function runRetrieval(requests: readonly PlannedRequest[], io: RetrievalIo) {
  const log: RequestLog[] = [];
  for (const request of requests) {
    let step = await attempt(request, 1, io, log); // NOSONAR(S9382): one at a time
    if ('retryAfterMs' in step) {
      await io.sleep(Math.max(step.retryAfterMs, RULES.pauseMs)); // NOSONAR(S9382): back off
      step = await attempt(request, 2, io, log); // NOSONAR(S9382)
    }
    if ('stop' in step) return { log, stopped: step.stop };
    await io.sleep(RULES.pauseMs); // NOSONAR(S9382): pacing
  }
  return { log, stopped: null as string | null };
}

// ---------------------------------------------------------------------------------------------
// Validation, classification and OHLC parity

export interface HourRecord extends HourCheck {
  /** Base volume (field 5) as float64, for VALID and VALID_ZERO hours only. */
  volume: number | null;
}

export interface ResponseInput {
  request: PlannedRequest;
  body: unknown;
  /** When the request whose body this is was sent (ms). */
  sentAt: number;
}

const missingHour = (openTime: number, issue: string): HourRecord => ({
  openTime,
  status: 'MISSING',
  issues: [issue],
  takerBuyShare: null,
  ohlc: null,
  closeTime: null,
  ignoreField: undefined,
  volume: null,
});

/**
 * validation.checks over one pair's responses: every expected hour from firstOpen to
 * endExclusive classified once, with #224's checkRow per row. Nothing is repaired: a duplicate,
 * an out-of-range or a non-increasing row makes its hour INVALID; a row at no expected hour is a
 * response issue.
 */
export function validatePair(responses: readonly ResponseInput[]) {
  const responseIssues: string[] = [];
  const found = new Map<number, { row: unknown[]; sentAt: number; flags: string[] }[]>();
  for (const { request, body, sentAt } of responses) {
    const id = `k=${request.k}`;
    if (!Array.isArray(body)) {
      responseIssues.push(`${id}: response is not an array`);
      continue;
    }
    if (body.length > RULES.limit) responseIssues.push(`${id}: more than ${RULES.limit} rows`);
    if (body.length !== request.expectedRows) {
      responseIssues.push(`${id}: ${body.length} rows, expected ${request.expectedRows}`);
    }
    let previous = Number.NEGATIVE_INFINITY;
    for (const [i, row] of body.entries()) {
      const openTime: unknown = Array.isArray(row) ? row[0] : undefined;
      if (!Number.isSafeInteger(openTime)) {
        responseIssues.push(`${id} row ${i}: open time is not an integer`);
        continue;
      }
      const t = openTime as number;
      if (t % HOUR_MS !== 0 || t < RULES.firstOpen || t >= RULES.endExclusive) {
        responseIssues.push(`${id} row ${i}: open time ${t} is not an expected hour`);
        continue;
      }
      const flags: string[] = [];
      if (t < request.startTime || t > request.endTime) {
        flags.push("open time outside its request's range");
      }
      if (t <= previous) flags.push('open time not increasing');
      previous = t;
      const list = found.get(t) ?? [];
      list.push({ row: row as unknown[], sentAt, flags });
      found.set(t, list);
    }
  }
  const hours: HourRecord[] = [];
  for (let t = RULES.firstOpen; t < RULES.endExclusive; t += HOUR_MS) {
    const entries = found.get(t);
    if (!entries) {
      hours.push(missingHour(t, 'no row for this hour'));
      continue;
    }
    const first = entries[0]!;
    const check = checkRow(first.row, t, first.sentAt);
    const extra = [...first.flags, ...(entries.length > 1 ? ['duplicate open time'] : [])];
    const status: HourStatus = extra.length > 0 ? 'INVALID' : check.status;
    const usable = status === 'VALID' || status === 'VALID_ZERO';
    hours.push({
      ...check,
      status,
      issues: [...check.issues, ...extra],
      volume: usable ? Number.parseFloat(first.row[5] as string) : null,
    });
  }
  return { hours, responseIssues };
}

export const countStatuses = (hours: readonly { status: HourStatus }[]) => {
  const counts: Record<HourStatus, number> = { VALID: 0, VALID_ZERO: 0, MISSING: 0, INVALID: 0 };
  for (const h of hours) counts[h.status] += 1;
  return counts;
};

export interface SavedCandle {
  timestamp: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * validation.ohlcParity: #224's ohlcParity over every retrieved hour from v1's first saved
 * candle, plus presence both ways. A v1 hour whose retrieved row is missing or unparseable is
 * present in v1 only.
 */
export function pairParity(hours: readonly HourRecord[], v1: ReadonlyMap<number, SavedCandle>) {
  const inRange = hours.filter((h) => h.openTime >= RULES.v1FirstOpen);
  const { compared, mismatches } = ohlcParity([...inRange], new Map(v1));
  const present = new Set(inRange.filter((h) => h.ohlc).map((h) => h.openTime));
  const retrievedOnly = inRange.filter((h) => h.ohlc && !v1.has(h.openTime)).map((h) => h.openTime);
  const v1Only = [...v1.keys()].filter((t) => !present.has(t)).sort((a, b) => a - b);
  return {
    compared,
    mismatches,
    retrievedOnly,
    v1Only,
    pass: mismatches.length === 0 && retrievedOnly.length === 0 && v1Only.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// activityShock24h

export interface ActivityHour {
  status: HourStatus;
  volume: number | null;
}
const ABSENT: ActivityHour = { status: 'MISSING', volume: null };

export type ActivityValue = { value: number } | { unavailable: ActivityReason };

/**
 * activityFeature.definition at decision time T: h_j opens at T − j h, j = 1 … 744, so every
 * candle closed by T and the candle opening at T is never read. Block sums run in increasing open
 * time; unavailable reasons in activityFeature.unavailable.order.
 */
export function activityShockAt(
  hours: ReadonlyMap<number, ActivityHour>,
  time: number,
): ActivityValue {
  const { windowHours: W, blockHours: H, blocks: M } = RULES;
  // window[0] is h_744, window[W − 1] is h_1.
  const window: ActivityHour[] = [];
  for (let j = W; j >= 1; j -= 1) window.push(hours.get(time - j * HOUR_MS) ?? ABSENT);
  if (window.some((h) => h.status === 'MISSING')) return { unavailable: 'ACTIVITY_WINDOW_MISSING' };
  if (window.some((h) => h.status === 'INVALID')) return { unavailable: 'ACTIVITY_WINDOW_INVALID' };
  // R_k covers j = 24k + 1 … 24k + 24, i.e. window[W − 24(k + 1)] … window[W − 24k − 1].
  const block = (k: number) => {
    let sum = 0;
    const from = W - H * (k + 1);
    for (let i = from; i < from + H; i += 1) sum += window[i]!.volume!;
    return sum;
  };
  const R = Array.from({ length: M + 1 }, (_, k) => block(k));
  if (R.some((r) => r === 0)) return { unavailable: 'ACTIVITY_BLOCK_ZERO' };
  const baseline = R.slice(1);
  const logs = baseline.map((r) => Math.log(r));
  const meanLog = sumOf(logs) / M;
  const s = Math.sqrt(sumOf(logs.map((x) => (x - meanLog) ** 2)) / M);
  // s = 0 exactly when the thirty ln R_k are equal; float rounding of their mean would leave
  // s ≈ 1e-16 there, so equality is tested directly.
  if (s === 0 || logs.every((x) => x === logs[0])) {
    return { unavailable: 'ACTIVITY_DISPERSION_ZERO' };
  }
  const mu = (1 / M) * sumOf(baseline);
  const value = (Math.log(R[0]!) - Math.log(mu)) / s;
  return Number.isFinite(value) ? { value } : { unavailable: 'ACTIVITY_NOT_FINITE' };
}

// ---------------------------------------------------------------------------------------------
// The joined dataset

/** observations.priceFeaturesAndLabels: recomputed #222 rows must equal the recorded rows. */
export function stageDParity(recomputed: readonly StageDRow[], recorded: readonly StageDRow[]) {
  const differing: string[] = [];
  const n = Math.max(recomputed.length, recorded.length);
  for (let i = 0; i < n; i += 1) {
    const a = recomputed[i];
    const b = recorded[i];
    const same =
      a !== undefined &&
      b !== undefined &&
      a.symbol === b.symbol &&
      a.time === b.time &&
      a.split === b.split &&
      a.outcome.category === b.outcome.category &&
      a.class === b.class &&
      a.outcome.bar === b.outcome.bar &&
      a.features.length === b.features.length &&
      a.features.every((f, j) => Object.is(f, b.features[j]));
    if (!same) differing.push(`row ${i}`);
  }
  return {
    recomputed: recomputed.length,
    recorded: recorded.length,
    differing: differing.length,
    first: differing.slice(0, 20),
    pass: differing.length === 0,
  };
}

/** #222's exclusion reason for a grid decision that has no #222 row. */
export function priceExclusionAt(index: HourlyIndex, time: number): Exclusion {
  const decision = decisionAt(index, time);
  if ('exclusion' in decision) return decision.exclusion;
  if (!featuresAt(index, time)) return 'V1_FEATURES_UNAVAILABLE';
  throw new Error(`${new Date(time).toISOString()}: an observation is missing from #222's rows`);
}

export interface DatasetRow {
  symbol: string;
  time: number;
  split: Split | null;
  stageDRow: number | null;
  exclusion: Exclusion | null;
  features: number[] | null;
  activity: number | null;
  outcome: Category | null;
  class: Klass | null;
}

/**
 * One row per grid decision in #222's order (T, then member order). #222's rows give features,
 * split, outcome and class; a decision without one gets #222's reason, else the activity reason.
 */
export function buildDataset(
  members: readonly string[],
  times: readonly number[],
  stageD: readonly StageDRow[],
  activityHours: Readonly<Record<string, ReadonlyMap<number, ActivityHour>>>,
  priceExclusion: (symbol: string, time: number) => Exclusion,
): DatasetRow[] {
  const at = new Map(stageD.map((r, i) => [`${r.symbol}|${r.time}`, i]));
  const rows: DatasetRow[] = [];
  for (const time of times) {
    for (const symbol of members) {
      const split = splitOf(time);
      const i = at.get(`${symbol}|${time}`);
      if (i === undefined) {
        rows.push({
          symbol,
          time,
          split,
          stageDRow: null,
          exclusion: priceExclusion(symbol, time),
          features: null,
          activity: null,
          outcome: null,
          class: null,
        });
        continue;
      }
      const r = stageD[i]!;
      const a = activityShockAt(activityHours[symbol] ?? new Map(), time);
      rows.push({
        symbol,
        time,
        split,
        stageDRow: i,
        exclusion: 'unavailable' in a ? a.unavailable : null,
        features: r.features,
        activity: 'value' in a ? a.value : null,
        outcome: r.outcome.category,
        class: r.class,
      });
    }
  }
  const used = rows.filter((r) => r.stageDRow !== null).length;
  if (used !== stageD.length) throw new Error(`${stageD.length - used} #222 rows are off the grid`);
  return rows;
}

export type ColumnValue = string | number | null;
export const toColumns = (r: DatasetRow): ColumnValue[] => [
  r.symbol,
  r.time,
  r.split,
  r.stageDRow,
  r.exclusion,
  ...(r.features ?? FEATURES.map(() => null)),
  r.activity,
  r.outcome,
  r.class,
];
export function fromColumns(v: readonly ColumnValue[]): DatasetRow {
  const n = FEATURES.length;
  const features = v.slice(5, 5 + n);
  return {
    symbol: v[0] as string,
    time: v[1] as number,
    split: v[2] as Split | null,
    stageDRow: v[3] as number | null,
    exclusion: v[4] as Exclusion | null,
    features: features.every((f) => f === null) ? null : (features as number[]),
    activity: v[5 + n] as number | null,
    outcome: v[6 + n] as Category | null,
    class: v[7 + n] as Klass | null,
  };
}

const noReasons = () =>
  Object.fromEntries(EXCLUSIONS.map((reason) => [reason, 0])) as Record<Exclusion, number>;

/** observations.coverage and exclusions.rule counts, per pair and pooled, per split and purged. */
export function coverageOf(rows: readonly DatasetRow[]) {
  type Bucket = { decisions: number; common: number; exclusions: Record<Exclusion, number> };
  const bucket = (): Bucket => ({ decisions: 0, common: 0, exclusions: noReasons() });
  const keys = [...SPLITS, 'purged'] as const;
  const empty = () =>
    Object.fromEntries(keys.map((k) => [k, bucket()])) as Record<(typeof keys)[number], Bucket>;
  const pooled = empty();
  const pairs: Record<string, ReturnType<typeof empty>> = {};
  for (const r of rows) {
    const key = r.split ?? 'purged';
    for (const b of [pooled[key], (pairs[r.symbol] ??= empty())[key]]) {
      b.decisions += 1;
      if (r.exclusion === null) b.common += 1;
      else b.exclusions[r.exclusion] += 1;
    }
  }
  const withCoverage = (b: Record<(typeof keys)[number], Bucket>) =>
    Object.fromEntries(
      keys.map((k) => [
        k,
        k === 'purged'
          ? b[k]
          : { ...b[k], coverage: b[k].decisions ? b[k].common / b[k].decisions : null },
      ]),
    );
  return {
    pooled: withCoverage(pooled),
    pairs: Object.fromEntries(Object.entries(pairs).map(([s, b]) => [s, withCoverage(b)])),
  };
}

/** Hour classifications of the hours entering each split's decision windows, per pair. */
export function windowHoursBySplit(
  hours: readonly { openTime: number; status: HourStatus }[],
  times: readonly number[],
) {
  return Object.fromEntries(
    SPLITS.map((split) => {
      const inSplit = times.filter((t) => splitOf(t) === split);
      const from = inSplit[0]! - RULES.windowHours * HOUR_MS;
      const to = inSplit.at(-1)! - HOUR_MS;
      return [split, countStatuses(hours.filter((h) => h.openTime >= from && h.openTime <= to))];
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Scoring: paired metrics, intervals, months, floors and the verdict

/** uncertainty: v1's dayOrders with this specification's replicates and seed, nothing else. */
export const CONFIG: Protocol = {
  ...PROTOCOL,
  uncertainty: {
    ...PROTOCOL.uncertainty,
    replicates: SPEC.uncertainty.replicates,
    random: { ...PROTOCOL.uncertainty.random, seed: SPEC.uncertainty.random.seed },
  },
};
const LEVELS: [number, number] = [SPEC.uncertainty.levels[0]!, SPEC.uncertainty.levels[1]!];

export type EvaluationId = 'development' | 'final';
export interface EvaluationSpec {
  id: EvaluationId;
  fit: Split[];
  evaluate: Split;
}
export const EVALUATIONS = SPEC.evaluations as EvaluationSpec[];

/** One arm's fit and probabilities as scripts/activity_shock_classifier.py writes them. */
export interface ArmPredictions {
  status: 'FITTED' | 'MISSING_CLASS';
  fit: { observations: number; classes: Record<Klass, number>; [key: string]: unknown };
  rows: [number, number, number, number][];
}
export type Predictions = Record<EvaluationId, Record<Arm, ArmPredictions>>;

interface Axis {
  firstDay: number;
  positions: number;
  orders: number[][];
}

/** #222's axisOf and estimate (private there; that file is not edited). */
function axisOf(split: Split, config: Protocol): Axis {
  const [firstDay, lastDay] = splitDays(split, config);
  const positions = lastDay - firstDay + 1;
  return { firstDay, positions, orders: dayOrders(split, positions, config) };
}

export interface Estimate {
  observations: number;
  mean: number | null;
  interval95: Interval | null;
  nonFinite?: number;
}

interface Item {
  row: DatasetRow;
  y: number;
  A: Probabilities;
  B: Probabilities;
}

/** Mean with its day-block interval; a non-finite value is reported, never clipped. */
function estimate(axis: Axis, items: readonly Item[], value: (item: Item) => number): Estimate {
  const numerator = new Float64Array(axis.positions);
  const denominator = new Float64Array(axis.positions);
  let sum = 0;
  let nonFinite = 0;
  for (const item of items) {
    const x = value(item);
    if (!Number.isFinite(x)) nonFinite += 1;
    const at = dayOf(item.row.time) - axis.firstDay;
    numerator[at]! += x;
    denominator[at]! += 1;
    sum += x;
  }
  if (nonFinite > 0) return { observations: items.length, mean: null, interval95: null, nonFinite };
  return {
    observations: items.length,
    mean: items.length ? sum / items.length : null,
    interval95: items.length ? ratioInterval(axis.orders, numerator, denominator, LEVELS) : null,
  };
}

export const brier3 = (p: Probabilities, y: number) =>
  p.reduce((sum, pk, j) => sum + (pk - (j === y ? 1 : 0)) ** 2, 0);
const classTerm = (p: Probabilities, y: number, j: number) => (p[j]! - (j === y ? 1 : 0)) ** 2;
const logLoss = (p: Probabilities, y: number) => -Math.log(p[y]!);
const d = (i: Item) => brier3(i.B, i.y) - brier3(i.A, i.y);

/** metrics.probabilityCalibration: #222's definition, labelled against #222's limits. */
function calibration(items: readonly Item[], arm: Arm) {
  return Object.fromEntries(
    CLASSES.map((k, j) => {
      const p = items.map((i) => i[arm][j]!);
      const y = items.map((i) => (i.y === j ? 1 : 0));
      const n = p.length;
      const { boundaries, bins, weightedError } = decileBins(p, y);
      const inTheLarge = n ? Math.abs(sumOf(p) / n - sumOf(y) / n) : null;
      const label = (x: number | null, limit: number) =>
        x !== null && x <= limit ? 'WITHIN' : 'OUTSIDE';
      return [
        k,
        {
          observations: n,
          meanPredicted: n ? sumOf(p) / n : null,
          observed: n ? sumOf(y) / n : null,
          inTheLarge,
          inTheLargeLabel: label(inTheLarge, STAGE_D_RULES.maxInTheLarge),
          weightedDecileError: weightedError,
          weightedDecileErrorLabel: label(weightedError, STAGE_D_RULES.maxDecileError),
          boundaries,
          bins,
        },
      ];
    }),
  ) as Record<Klass, unknown>;
}

const meanOf = (items: readonly Item[], f: (i: Item) => number) =>
  items.length ? sumOf(items.map(f)) / items.length : null;

/** metrics.monthly: the table, leave-one-month-out and the count of months favouring B. */
export function monthly(items: readonly Item[]) {
  const months = [...new Set(items.map((i) => monthOf(i.row.time)))].sort(byText);
  const table = months.map((month) => {
    const inMonth = items.filter((i) => monthOf(i.row.time) === month);
    return {
      month,
      observations: inMonth.length,
      days: new Set(inMonth.map((i) => dayOf(i.row.time))).size,
      brierA: meanOf(inMonth, (i) => brier3(i.A, i.y)),
      brierB: meanOf(inMonth, (i) => brier3(i.B, i.y)),
      meanD: meanOf(inMonth, d),
    };
  });
  const leftOut = months.map((month) => ({
    month,
    meanD: meanOf(
      items.filter((i) => monthOf(i.row.time) !== month),
      d,
    ),
  }));
  // An undefined mean (nothing left) counts as +Infinity: it is the maximum and fails.
  const rank = (m: { meanD: number | null }) => m.meanD ?? Infinity;
  const maximum = leftOut.reduce<(typeof leftOut)[number] | null>(
    (best, m) => (best === null || rank(m) > rank(best) ? m : best),
    null,
  );
  return {
    table,
    leaveOneMonthOut: {
      months: leftOut,
      maximum,
      allNegative: leftOut.length > 0 && leftOut.every((m) => m.meanD !== null && m.meanD < 0),
    },
    monthsNegative: table.filter((m) => m.meanD !== null && m.meanD < 0).length,
  };
}

export type PeriodLabel = 'B_BETTER' | 'B_WORSE' | 'NO_CLEAR_DIFFERENCE';
/** verdict.periodLabel; a null figure fails its condition. */
export function periodLabel(e: Estimate): PeriodLabel {
  if (e.mean !== null && e.mean < 0 && e.interval95 !== null && e.interval95.high < 0) {
    return 'B_BETTER';
  }
  if (e.interval95 !== null && e.interval95.low > 0) return 'B_WORSE';
  return 'NO_CLEAR_DIFFERENCE';
}

const classCounts = (rows: readonly DatasetRow[]) => {
  const counts: Record<Klass, number> = { TARGET: 0, STOP: 0, TIMEOUT: 0 };
  for (const r of rows) counts[r.class!] += 1;
  return counts;
};

const integrityFailure = (cause: string) => new Error(`INTEGRITY_FAILURE: ${cause}`);

/** Each arm's probabilities must cover exactly the evaluated common rows, from the same fit set. */
function armProbabilities(
  set: ArmPredictions,
  fitRows: readonly DatasetRow[],
  evaluated: number[],
) {
  const counts = classCounts(fitRows);
  const missing = CLASSES.some((k) => counts[k] === 0);
  if ((set.status === 'MISSING_CLASS') !== missing) {
    throw integrityFailure('the classifier and the fit set disagree on a missing class');
  }
  if (
    set.fit.observations !== fitRows.length ||
    CLASSES.some((k) => set.fit.classes[k] !== counts[k])
  ) {
    throw integrityFailure("an arm's fit set differs from the common fit set");
  }
  if (missing) return null;
  const indices = set.rows.map((r) => r[0]);
  if (indices.length !== evaluated.length || indices.some((x, i) => x !== evaluated[i])) {
    throw integrityFailure('probabilities do not cover exactly the evaluated common observations');
  }
  if (!set.rows.every((r) => r.every(Number.isFinite))) {
    throw integrityFailure('a probability is not finite');
  }
  return set.rows.map(([, ...p]) => p as Probabilities);
}

export function evaluatePeriod(
  rows: readonly DatasetRow[],
  evaluation: EvaluationSpec,
  arms: Readonly<Record<Arm, ArmPredictions>>,
  config: Protocol = CONFIG,
) {
  const fitRows = rows.filter(
    (r) => r.exclusion === null && r.split !== null && evaluation.fit.includes(r.split),
  );
  const evaluated: number[] = [];
  rows.forEach((r, i) => {
    if (r.exclusion === null && r.split === evaluation.evaluate) evaluated.push(i);
  });
  const pA = armProbabilities(arms.A, fitRows, evaluated);
  const pB = armProbabilities(arms.B, fitRows, evaluated);
  const fit = {
    splits: evaluation.fit,
    observations: fitRows.length,
    classes: classCounts(fitRows),
    A: arms.A.fit,
    B: arms.B.fit,
  };
  const days = new Set(evaluated.map((i) => dayOf(rows[i]!.time))).size;
  const base = {
    id: evaluation.id,
    evaluate: evaluation.evaluate,
    fit,
    observations: evaluated.length,
    days,
  };
  if (!pA || !pB) return { ...base, status: 'MISSING_CLASS' as const, metrics: null };
  const items: Item[] = evaluated.map((index, i) => {
    const row = rows[index]!;
    return { row, y: CLASSES.indexOf(row.class!), A: pA[i]!, B: pB[i]! };
  });
  const axis = axisOf(evaluation.evaluate, config);
  const primary = estimate(axis, items, d);
  const brierA = meanOf(items, (i) => brier3(i.A, i.y));
  const brierB = meanOf(items, (i) => brier3(i.B, i.y));
  const classComponents = Object.fromEntries(
    CLASSES.map((k, j) => [
      k,
      estimate(axis, items, (i) => classTerm(i.B, i.y, j) - classTerm(i.A, i.y, j)),
    ]),
  ) as Record<Klass, Estimate>;
  const residual = sumOf(CLASSES.map((k) => classComponents[k].mean!)) - primary.mean!;
  if (!(Math.abs(residual) <= 1e-12)) throw new Error(`Class components do not sum: ${residual}`);
  const loss = (arm: Arm) => {
    const values = items.map((i) => logLoss(i[arm], i.y));
    const bad = values.filter((x) => !Number.isFinite(x)).length;
    return bad ? { mean: null, nonFinite: bad } : { mean: sumOf(values) / values.length };
  };
  const symbols = [...new Set(items.map((i) => i.row.symbol))];
  return {
    ...base,
    status: 'FITTED' as const,
    metrics: {
      brier: {
        A: brierA,
        B: brierB,
        primary,
        relative: primary.mean !== null && brierA ? primary.mean / brierA : null,
        label: periodLabel(primary),
        classComponents,
      },
      logLoss: {
        A: loss('A'),
        B: loss('B'),
        BminusA: estimate(axis, items, (i) => logLoss(i.B, i.y) - logLoss(i.A, i.y)),
      },
      probabilityCalibration: { A: calibration(items, 'A'), B: calibration(items, 'B') },
      monthly: monthly(items),
      pairs: Object.fromEntries(
        symbols.map((symbol) => {
          const mine = items.filter((i) => i.row.symbol === symbol);
          return [
            symbol,
            {
              observations: mine.length,
              brierA: meanOf(mine, (i) => brier3(i.A, i.y)),
              brierB: meanOf(mine, (i) => brier3(i.B, i.y)),
              meanD: meanOf(mine, d),
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
    },
  };
}
export type PeriodResult = ReturnType<typeof evaluatePeriod>;

export interface Check {
  id: string;
  evaluation: string | null;
  holds: boolean;
}

export type Verdict = 'INSUFFICIENT_EVIDENCE' | 'SCREEN_PASSED' | 'STOP' | 'INCONCLUSIVE';

/** evidenceFloors and verdict.order after integrity (which throws before any figure). */
export function conclude(
  coverage: Readonly<Record<Split, number | null>>,
  periods: Readonly<Record<EvaluationId, PeriodResult>>,
) {
  const floors: Check[] = [
    ...SPLITS.map((split) => ({
      id: `coverage.${split}`,
      evaluation: null,
      holds: (coverage[split] ?? 0) >= RULES.minCoverage,
    })),
    ...Object.values(periods).flatMap((p) => [
      { id: 'classes', evaluation: p.id, holds: p.status === 'FITTED' },
      {
        id: 'observations',
        evaluation: p.id,
        holds: p.observations >= RULES.minObservations && p.days >= RULES.minDays,
      },
      {
        id: 'interval',
        evaluation: p.id,
        holds: (p.metrics?.brier.primary.interval95?.defined ?? 0) >= RULES.minDefined,
      },
    ]),
  ];
  const list = Object.values(periods);
  const labels = list.map((p) => p.metrics?.brier.label ?? null);
  const means = list.map((p) => p.metrics?.brier.primary.mean ?? null);
  const conditions = {
    bBetterInBoth: labels.every((l) => l === 'B_BETTER'),
    leaveOneMonthOutInBoth: list.every(
      (p) => p.metrics?.monthly.leaveOneMonthOut.allNegative === true,
    ),
    bWorseInEither: labels.some((l) => l === 'B_WORSE'),
    meanNotNegativeInBoth: means.every((m) => m !== null && m >= 0),
  };
  let verdict: Verdict = 'INCONCLUSIVE';
  if (floors.some((c) => !c.holds)) verdict = 'INSUFFICIENT_EVIDENCE';
  else if (conditions.bBetterInBoth && conditions.leaveOneMonthOutInBoth) verdict = 'SCREEN_PASSED';
  else if (conditions.bWorseInEither || conditions.meanNotNegativeInBoth) verdict = 'STOP';
  return {
    verdict,
    floors,
    failingFloors: floors
      .filter((c) => !c.holds)
      .map((c) => (c.evaluation ? `${c.evaluation}.${c.id}` : c.id)),
    labels: Object.fromEntries(list.map((p, i) => [p.id, labels[i]])),
    conditions,
  };
}

/** The whole frozen comparison over the dataset rows and both arms' probabilities. */
export function evaluateScreen(
  rows: readonly DatasetRow[],
  predictions: Readonly<Predictions>,
  config: Protocol = CONFIG,
) {
  const periods = Object.fromEntries(
    EVALUATIONS.map((e) => {
      const arms = predictions[e.id];
      if (!arms?.A || !arms.B) throw integrityFailure(`no probabilities for ${e.id}`);
      return [e.id, evaluatePeriod(rows, e, arms, config)];
    }),
  ) as Record<EvaluationId, PeriodResult>;
  const coverage = coverageOf(rows);
  const splitCoverage = Object.fromEntries(
    SPLITS.map((s) => [s, (coverage.pooled[s] as { coverage: number | null }).coverage]),
  ) as Record<Split, number | null>;
  return {
    specification: { id: SPEC.specificationId, sha256: specSha256() },
    coverage: splitCoverage,
    evaluations: periods,
    conclusion: conclude(splitCoverage, periods),
  };
}
export type ScreenResults = ReturnType<typeof evaluateScreen>;
