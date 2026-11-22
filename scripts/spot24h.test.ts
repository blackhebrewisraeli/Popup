import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscovery';
import {
  CELLS,
  DAY_MS,
  HOUR_MS,
  PROTOCOL,
  RULES,
  consecutive,
  dayOf,
  dayOrders,
  evaluateFit,
  evaluateProtocol,
  featuresAt,
  fitFrequencies,
  indexHourly,
  isLeveragedProduct,
  netReturn,
  potentialNetGain,
  protocolSha256,
  rankCandidates,
  rankingScore,
  ratioInterval,
  resolveOutcome,
  selectUniverse,
  splitOf,
  supportOf,
  expectancyOf,
  currentCandidates,
  type Candidate,
  type Features,
  type HourCandle,
  type Observation,
  type Protocol,
  type ScenarioEvaluation,
} from './spot24h';
import {
  codeIdentity,
  collectHistory,
  fetchHistory,
  SOURCE_FILES,
  verifyUniverse,
} from './spot24hRun';

const ms = Date.parse;
const bar = (t: number, open: number, high: number, low: number, close: number): HourCandle => ({
  timestamp: t,
  closeTime: t + HOUR_MS - 1,
  open,
  high,
  low,
  close,
});

/** mulberry32: exact 32-bit arithmetic, so successive draws are independent. */
function random32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** I.i.d. random walk of hourly candles from `start`: no candle carries information about the next. */
function walk(start: number, hours: number, seed = 7, price = 100): HourCandle[] {
  const random = random32(seed);
  return Array.from({ length: hours }, (_, k) => {
    const open = price;
    const close = open * (1 + (random() - 0.5) * 0.03);
    price = close;
    return bar(
      start + k * HOUR_MS,
      open,
      Math.max(open, close) * (1 + random() * 0.006),
      Math.min(open, close) * (1 - random() * 0.006),
      close,
    );
  });
}

describe('protocol', () => {
  it('has a stable identity that changes with any field', () => {
    expect(protocolSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(protocolSha256()).toBe(protocolSha256(structuredClone(PROTOCOL)));
    expect(protocolSha256({ ...PROTOCOL, version: 2 })).not.toBe(protocolSha256());
  });

  it('mirrors every prose number of the JSON', () => {
    expect(PROTOCOL.features.indicators).toContain('rsi(close, 14)');
    expect(PROTOCOL.features.indicators).toContain('macd(close, 12, 26, 9)');
    expect(PROTOCOL.features.indicators).toContain('atr(high, low, close, 14)');
    expect(PROTOCOL.features.rsiBands.low).toBe(`RSI < ${RULES.rsiLow}`);
    expect(PROTOCOL.features.rsiBands.high).toBe(`RSI > ${RULES.rsiHigh}`);
    expect(PROTOCOL.uncertainty.method).toContain(`blocks of ${RULES.blockDays} consecutive days`);
    expect(PROTOCOL.support.evidence).toBe(
      "At least 2,000 test observations with a probability on at least 90 distinct days, covering at least 95% of the scenario's test observations",
    );
    expect([RULES.minTestObservations, RULES.minTestDays, RULES.minTestCoverage]).toEqual([
      2000, 90, 0.95,
    ]);
    expect(PROTOCOL.support.calibration).toBe(
      `Calibration in the large <= ${RULES.maxCalibrationInTheLarge} and weighted cell error <= ${RULES.maxWeightedCellError}`,
    );
    expect(PROTOCOL.ranking.netGainNormalization).toContain('0.10) / 0.10');
    expect(RULES.netGainCap).toBe(0.1);
  });

  it('names 20 distinct members and 6 scenarios', () => {
    expect(new Set(PROTOCOL.universe.members).size).toBe(20);
    expect(PROTOCOL.scenarios.map((s) => s.id)).toEqual([
      'T3S3',
      'T5S3',
      'T8S3',
      'T3S5',
      'T5S5',
      'T8S5',
    ]);
  });
});

describe('universe', () => {
  it('detects leveraged products only against another listed base', () => {
    const bases = new Set(['BTC', 'ETH', 'S']);
    expect(isLeveragedProduct('BTCUP', bases)).toBe(true);
    expect(isLeveragedProduct('ETHBEAR', bases)).toBe(true);
    expect(isLeveragedProduct('JUP', bases)).toBe(false);
    expect(isLeveragedProduct('BTC', bases)).toBe(false);
  });

  it('walks discovery members in rank order and stops at the size', () => {
    const members = [
      ['BTCUSDT', 'BTC', 'unclassified'],
      ['FDUSDUSDT', 'FDUSD', 'unclassified'],
      ['BTCUPUSDT', 'BTCUP', 'unclassified'],
      ['XAUTUSDT', 'XAUT', 'tokenized-commodity'],
      ['NEWUSDT', 'NEW', 'unclassified'],
      ...Array.from({ length: 25 }, (_, i) => [`P${i}USDT`, `P${i}`, 'unclassified']),
    ].map(([symbol, baseAsset, category], i) => ({ rank: i + 1, symbol, baseAsset, category }));
    const evidence = {
      inputs: { usdtInstruments: members.map((m) => ({ baseAsset: m.baseAsset })) },
      result: { members },
    } as unknown as DiscoveryEvidence;
    const early = ms(PROTOCOL.data.historyStart);
    const firstOpenTimes = Object.fromEntries(
      members.map((m) => [m.symbol, m.symbol === 'NEWUSDT' ? early + HOUR_MS : early]),
    );
    const selection = selectUniverse(evidence, firstOpenTimes);
    expect(selection.members.map((m) => m.symbol)).toEqual([
      'BTCUSDT',
      ...Array.from({ length: 19 }, (_, i) => `P${i}USDT`),
    ]);
    expect(selection.skipped).toEqual([
      { rank: 2, symbol: 'FDUSDUSDT', reason: 'EXCLUDED_BASE' },
      { rank: 3, symbol: 'BTCUPUSDT', reason: 'LEVERAGED_PRODUCT' },
      { rank: 4, symbol: 'XAUTUSDT', reason: 'LABELLED_BY_DISCOVERY' },
      { rank: 5, symbol: 'NEWUSDT', reason: 'INSUFFICIENT_HISTORY' },
    ]);
  });
});

describe('hourly candles', () => {
  const t0 = ms('2026-01-01T00:00:00.000Z');

  it('refuses invalid, duplicate and open candles without repairing them', () => {
    const candles = [
      bar(t0, 1, 2, 0.5, 1.5),
      bar(t0 + HOUR_MS, 1, 2, 0.5, 1.5),
      bar(t0 + HOUR_MS, 1, 2, 0.5, 1.5),
      bar(t0 + 2 * HOUR_MS + 1, 1, 2, 0.5, 1.5),
      { ...bar(t0 + 3 * HOUR_MS, 1, 2, 0.5, 1.5), closeTime: t0 + 4 * HOUR_MS },
      bar(t0 + 4 * HOUR_MS, 1, 0.5, 2, 1),
      bar(t0 + 5 * HOUR_MS, 1, 2, 0.5, 1.5),
      bar(t0 + 6 * HOUR_MS, 1, 2, 0.5, 1.5),
    ];
    const index = indexHourly(candles, t0 + 6 * HOUR_MS + HOUR_MS - 1);
    expect([...index.valid.keys()]).toEqual([t0, t0 + 5 * HOUR_MS]);
    expect(index.included).toBe(7);
    expect(index.issues.map((i) => i.code)).toEqual([
      'DUPLICATE_TIMESTAMP',
      'DUPLICATE_TIMESTAMP',
      'TIMESTAMP_NOT_HOUR_ALIGNED',
      'CLOSE_TIME_CONVENTION_MISMATCH',
      'HIGH_BELOW_LOW',
      'OPEN_OUTSIDE_RANGE',
      'CLOSE_OUTSIDE_RANGE',
    ]);
    expect(consecutive(index, t0, 2)).toBeNull();
    expect(consecutive(index, t0 + 5 * HOUR_MS, 1)).toHaveLength(1);
  });
});

describe('features', () => {
  const start = ms('2026-01-01T00:00:00.000Z');
  const series = walk(start, 300);
  const time = start + 240 * HOUR_MS;
  const index = (candles: HourCandle[]) => indexHourly(candles, Number.MAX_SAFE_INTEGER);
  const base = featuresAt(index(series), time);

  it('reads the 200 candles closed by T and nothing later', () => {
    expect(base).not.toBeNull();
    const future = series.map((c) =>
      c.timestamp >= time ? bar(c.timestamp, 500, 900, 400, 800) : c,
    );
    expect(featuresAt(index(future), time)).toEqual(base);
    expect(featuresAt(index(series.slice(0, 240)), time)).toEqual(base);
    const older = series.map((c) =>
      c.timestamp === time - 201 * HOUR_MS ? bar(c.timestamp, 1, 1000, 0.5, 900) : c,
    );
    expect(featuresAt(index(older), time)).toEqual(base);
  });

  it('changes when the last closed candle changes, and refuses a gap', () => {
    const last = series.map((c) =>
      c.timestamp === time - HOUR_MS ? { ...c, high: c.high * 1.2, close: c.high * 1.1 } : c,
    );
    expect(featuresAt(index(last), time)).not.toEqual(base);
    const gap = series.filter((c) => c.timestamp !== time - 100 * HOUR_MS);
    expect(featuresAt(index(gap), time)).toBeNull();
  });

  it('places each decision in one of the six cells', () => {
    expect(CELLS).toHaveLength(6);
    expect(CELLS).toContain(base?.cell);
    expect(base?.v).toBeCloseTo((base?.atr ?? 0) / (base?.close ?? 1), 12);
  });
});

describe('outcomes', () => {
  const t = ms('2026-01-01T00:00:00.000Z');
  const flat = (n = 24) =>
    Array.from({ length: n }, (_, k) => bar(t + k * HOUR_MS, 100, 101, 99, 100));
  const set = (bars: HourCandle[], k: number, c: Partial<HourCandle>) =>
    bars.map((b, i) => (i === k ? { ...b, ...c } : b));

  it('orders the target before a later stop, and the stop before a later target', () => {
    let bars = set(set(flat(), 1, { high: 110 }), 4, { low: 90 });
    expect(resolveOutcome(bars, 105, 95)).toEqual({ category: 'TARGET', exit: 105, bar: 2 });
    bars = set(set(flat(), 1, { low: 90 }), 4, { high: 110 });
    expect(resolveOutcome(bars, 105, 95)).toEqual({ category: 'STOP', exit: 95, bar: 2 });
  });

  it('reports a bar touching both levels as ambiguous, never a success', () => {
    const bars = set(flat(), 6, { high: 110, low: 90 });
    expect(resolveOutcome(bars, 105, 95)).toEqual({ category: 'AMBIGUOUS', exit: 95, bar: 7 });
  });

  it('times out at the 24th close and counts equality as a touch', () => {
    const bars = set(flat(), 23, { close: 100.5 });
    expect(resolveOutcome(bars, 105, 95)).toEqual({ category: 'TIMEOUT', exit: 100.5, bar: 24 });
    expect(resolveOutcome(set(flat(), 3, { high: 105 }), 105, 95).category).toBe('TARGET');
    expect(resolveOutcome(set(flat(), 3, { low: 95 }), 105, 95).category).toBe('STOP');
  });

  it('fills a gap through the stop at the open and a gap over the target at the target', () => {
    const down = set(flat(), 2, { open: 93, high: 108, low: 92, close: 107 });
    expect(resolveOutcome(down, 105, 95)).toEqual({ category: 'STOP', exit: 93, bar: 3 });
    const up = set(flat(), 2, { open: 106, high: 107, low: 90, close: 91 });
    expect(resolveOutcome(up, 105, 95)).toEqual({ category: 'TARGET', exit: 105, bar: 3 });
  });

  it('charges fees on both fills and slippage on market fills only', () => {
    expect(netReturn(100, 103, 'TARGET')).toBeCloseTo((0.999 ** 2 * 103) / (100 * 1.0005) - 1, 15);
    expect(netReturn(100, 97, 'STOP')).toBeCloseTo(
      (0.999 ** 2 * 97 * 0.9995) / (100 * 1.0005) - 1,
      15,
    );
    expect(potentialNetGain(0.01, 3)).toBeCloseTo((0.999 ** 2 * 1.03) / 1.0005 - 1, 15);
    expect(potentialNetGain(0.0001, 3)).toBeLessThan(0);
  });
});

describe('splits', () => {
  const [b1, b2] = PROTOCOL.splits.boundaries.map(ms) as [number, number];
  const cutoff = ms(PROTOCOL.data.collectionCutoff);
  const first = ms(PROTOCOL.decisions.firstDecision);

  it('purges every decision whose 24-hour label crosses a boundary', () => {
    expect(splitOf(first - 4 * HOUR_MS)).toBeNull();
    expect(splitOf(first)).toBe('train');
    expect(splitOf(b1 - DAY_MS)).toBe('train');
    expect(splitOf(b1 - 20 * HOUR_MS)).toBeNull();
    expect(splitOf(b1 - 4 * HOUR_MS)).toBeNull();
    expect(splitOf(b1)).toBe('validation');
    expect(splitOf(b2 - DAY_MS)).toBe('validation');
    expect(splitOf(b2 - 4 * HOUR_MS)).toBeNull();
    expect(splitOf(b2)).toBe('test');
    expect(splitOf(cutoff - DAY_MS)).toBe('test');
    expect(splitOf(cutoff - 20 * HOUR_MS)).toBeNull();
  });
});

const obs = (
  day: number,
  cell: string,
  categories: Observation['outcomes'][number]['category'][],
) =>
  ({
    symbol: 'X',
    time: day * DAY_MS,
    day,
    cell,
    v: 0.01,
    outcomes: categories.map((category) => ({
      category,
      net: category === 'TARGET' ? 0.02 : -0.01,
    })),
  }) satisfies Observation;
const six = (category: Observation['outcomes'][number]['category']) =>
  Array.from({ length: 6 }, () => category);

describe('estimation', () => {
  it('gives a probability only with 300 observations on 30 days', () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      obs(i % 30, 'low/positive', six(i % 3 ? 'STOP' : 'TARGET')),
    );
    const fit = fitFrequencies(rows)[0]!;
    expect(fit.cells['low/positive']).toMatchObject({ n: 300, wins: 100, days: 30, p: 1 / 3 });
    expect(fit.base.p).toBe(1 / 3);
    expect(fitFrequencies(rows.slice(1))[0]!.cells['low/positive']!.p).toBeNull();
    const fewDays = rows.map((o) => ({ ...o, day: o.day % 29 }));
    expect(fitFrequencies(fewDays)[0]!.cells['low/positive']!.p).toBeNull();
  });

  it('counts ambiguous outcomes as failures', () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      obs(i % 30, 'mid/positive', six(i % 2 ? 'AMBIGUOUS' : 'TARGET')),
    );
    expect(fitFrequencies(rows)[0]!.cells['mid/positive']!.p).toBe(0.5);
  });

  it('scores the method and the base rate on the same observations', () => {
    const train = [
      ...Array.from({ length: 300 }, (_, i) => obs(i % 30, 'low/positive', six('TARGET'))),
      ...Array.from({ length: 300 }, (_, i) => obs(i % 30, 'high/positive', six('STOP'))),
      obs(1, 'mid/positive', six('TARGET')),
    ];
    const fits = fitFrequencies(train);
    const testDay = dayOf(ms(PROTOCOL.splits.boundaries[1]!));
    const test = [
      obs(testDay, 'low/positive', six('TARGET')),
      obs(testDay + 1, 'high/positive', six('TARGET')),
      obs(testDay + 2, 'mid/positive', six('TARGET')),
    ];
    const [evaluation] = evaluateFit(fits, test, 'test');
    const base = 301 / 601;
    expect(evaluation).toMatchObject({ observations: 3, evaluated: 2, days: 2 });
    expect(evaluation!.coverage).toBeCloseTo(2 / 3, 12);
    expect(evaluation!.brier.method).toBeCloseTo(0.5, 12);
    expect(evaluation!.brier.base).toBeCloseTo((1 - base) ** 2, 12);
    expect(evaluation!.counts).toEqual({ TARGET: 3, STOP: 0, TIMEOUT: 0, AMBIGUOUS: 0 });
    expect(evaluation!.calibration.inTheLarge).toBeCloseTo(0.5, 12);
    // Only low/positive has a probability and a positive fit-set mean net return.
    expect(evaluation!.selected).toMatchObject({ observations: 1, days: 1, meanNet: 0.02 });
  });
});

describe('uncertainty', () => {
  it('draws the same day blocks every time', () => {
    expect(dayOrders('test', 30)).toEqual(dayOrders('test', 30));
    expect(dayOrders('test', 30)).not.toEqual(dayOrders('validation', 30));
    expect(dayOrders('test', 30)[0]).toHaveLength(30);
  });

  it('returns a degenerate interval for a constant ratio, and none without data', () => {
    const orders = dayOrders('test', 10);
    const interval = ratioInterval(orders, Array(10).fill(2), Array(10).fill(4), [0.025, 0.975]);
    expect(interval).toMatchObject({ low: 0.5, high: 0.5, defined: 2000, replicates: 2000 });
    expect(ratioInterval(orders, Array(10).fill(0), Array(10).fill(0), [0.05, 0.95])).toBeNull();
  });
});

const evaluation = (overrides: Partial<ScenarioEvaluation>): ScenarioEvaluation => ({
  scenario: 'T3S3',
  observations: 3000,
  counts: { TARGET: 1000, STOP: 1500, TIMEOUT: 400, AMBIGUOUS: 100 },
  evaluated: 3000,
  days: 180,
  coverage: 1,
  brier: {
    method: 0.2,
    base: 0.21,
    delta: -0.01,
    skillScore: 0.05,
    interval95: { low: -0.02, high: -0.001, defined: 2000, replicates: 2000 },
  },
  calibration: { inTheLarge: 0.01, weightedCellError: 0.02, cells: [] },
  meanNetReturn: 0,
  selected: {
    observations: 600,
    days: 60,
    meanNet: 0.002,
    interval95: { low: 0.0005, high: 0.004, defined: 2000, replicates: 2000 },
  },
  ...overrides,
});

describe('expectancy', () => {
  it('needs 300 selected test observations on 30 days with a positive lower bound', () => {
    expect(expectancyOf(evaluation({}))).toEqual({ status: 'SUPPORTED', failing: [] });
    const selected = evaluation({}).selected;
    expect(
      expectancyOf(evaluation({ selected: { ...selected, observations: 299 } })).failing,
    ).toEqual(['EXPECTANCY_EVIDENCE']);
    expect(expectancyOf(evaluation({ selected: { ...selected, days: 29 } })).failing).toEqual([
      'EXPECTANCY_EVIDENCE',
    ]);
    const atZero = { ...selected, interval95: { ...selected.interval95!, low: 0 } };
    expect(expectancyOf(evaluation({ selected: atZero })).failing).toEqual(['EXPECTANCY']);
    const none = { observations: 0, days: 0, meanNet: null, interval95: null };
    expect(expectancyOf(evaluation({ selected: none })).failing).toEqual([
      'EXPECTANCY_EVIDENCE',
      'EXPECTANCY',
    ]);
  });
});

describe('support', () => {
  it('supports a scenario only when every criterion holds', () => {
    expect(supportOf(evaluation({}), evaluation({}))).toEqual({ status: 'SUPPORTED', failing: [] });
  });

  it('names each failing criterion', () => {
    const weak = evaluation({
      evaluated: 1999,
      brier: {
        method: 0.2,
        base: 0.21,
        delta: -0.01,
        skillScore: 0.05,
        interval95: { low: -0.02, high: 0, defined: 2000, replicates: 2000 },
      },
      calibration: { inTheLarge: 0.031, weightedCellError: 0.02, cells: [] },
    });
    const validation = evaluation({
      brier: { method: 0.2, base: 0.2, delta: 0, skillScore: 0, interval95: null },
    });
    expect(supportOf(weak, validation)).toEqual({
      status: 'NOT_SUPPORTED',
      failing: ['EVIDENCE', 'SKILL', 'CALIBRATION', 'CONSISTENCY'],
    });
    expect(supportOf(evaluation({ coverage: 0.94 }), evaluation({})).failing).toEqual(['EVIDENCE']);
    expect(
      supportOf(
        evaluation({ brier: { ...evaluation({}).brier, interval95: null } }),
        evaluation({}),
      ).failing,
    ).toEqual(['SKILL']);
  });
});

describe('ranking', () => {
  const candidate = (symbol: string, scenario: string, p: number, gain: number): Candidate => ({
    symbol,
    scenario,
    cell: 'mid/positive',
    referencePrice: 1,
    targetPrice: 1,
    stopPrice: 1,
    potentialNetGain: gain,
    probability: p,
    probabilityInterval90: null,
    fitObservations: 300,
    historicalMeanNet: 0.001,
    historicalMeanNetInterval90: null,
    score: rankingScore(p, gain),
    reasons: [],
    rank: null,
  });

  it('weights probability 55% and capped net gain 45%', () => {
    expect(rankingScore(0.4, 0.05)).toBeCloseTo(0.55 * 0.4 + 0.45 * 0.5, 15);
    expect(rankingScore(0.4, 0.2)).toBeCloseTo(0.55 * 0.4 + 0.45, 15);
    expect(rankingScore(0.4, -0.01)).toBeCloseTo(0.55 * 0.4, 15);
  });

  it('orders ties deterministically, whatever the input order', () => {
    const items = [
      candidate('BBB', 'T3S3', 0.4, 0.05),
      candidate('AAA', 'T5S3', 0.4, 0.05),
      candidate('AAA', 'T3S3', 0.4, 0.05),
      candidate('CCC', 'T3S3', 0.5, 0.05 - (0.55 * 0.1) / 0.45 / 10),
      { ...candidate('DDD', 'T3S3', 0.9, 0.09), reasons: ['SCENARIO_NOT_SUPPORTED' as const] },
    ];
    const ranked = rankCandidates(items);
    expect(rankCandidates([...items].reverse())).toEqual(ranked);
    expect(ranked.map((c) => [c.symbol, c.scenario, c.rank])).toEqual([
      ['DDD', 'T3S3', null],
      ['CCC', 'T3S3', 1],
      ['AAA', 'T3S3', 2],
      ['AAA', 'T5S3', 3],
      ['BBB', 'T3S3', 4],
    ]);
  });

  it('qualifies only candidates passing both gates, with a complete window and a positive history', () => {
    // low/positive: one TARGET (+2%) per three STOPs (-1%), a negative mean net return.
    // mid/positive: one TARGET per STOP, a positive one.
    const rows = Array.from({ length: 300 }, (_, i) => [
      obs(i % 30, 'low/positive', six(i % 4 ? 'STOP' : 'TARGET')),
      obs(i % 30, 'mid/positive', six(i % 2 ? 'STOP' : 'TARGET')),
    ]).flat();
    const fits = fitFrequencies(rows);
    const features: Features = {
      rsi: 30,
      macdHistogram: 1,
      atr: 1,
      close: 100,
      v: 0.01,
      cell: 'low/positive',
    };
    const gates = PROTOCOL.scenarios.map((_, s) => ({
      probability: s <= 1 ? 'SUPPORTED' : 'NOT_SUPPORTED',
      expectancy: s === 0 ? 'SUPPORTED' : 'NOT_SUPPORTED',
    }));
    const none = () => ({ p: null, net: null });
    const candidates = currentCandidates(
      { AAA: features, BBB: null, CCC: { ...features, cell: 'mid/positive' } },
      fits,
      gates,
      none,
    );
    const first = candidates.find((c) => c.symbol === 'AAA' && c.scenario === 'T3S3')!;
    expect(first.reasons).toEqual(['NON_POSITIVE_HISTORICAL_NET']);
    expect(candidates.find((c) => c.symbol === 'AAA' && c.scenario === 'T5S3')!.reasons).toEqual([
      'EXPECTANCY_NOT_SUPPORTED',
      'NON_POSITIVE_HISTORICAL_NET',
    ]);
    const qualified = candidates.filter((c) => c.rank !== null);
    expect(qualified.map((c) => [c.symbol, c.scenario, c.rank])).toEqual([['CCC', 'T3S3', 1]]);
    expect(qualified[0]!.probability).toBe(0.5);
    expect(qualified[0]!.score).toBeCloseTo(rankingScore(0.5, potentialNetGain(0.01, 3)), 15);
    expect(first.targetPrice).toBeCloseTo(103, 12);
    expect(first.stopPrice).toBeCloseTo(97, 12);
    expect(candidates.find((c) => c.symbol === 'BBB')!.reasons).toEqual(['FEATURES_UNAVAILABLE']);
    expect(candidates.find((c) => c.scenario === 'T8S3' && c.symbol === 'CCC')!.reasons).toEqual([
      'SCENARIO_NOT_SUPPORTED',
      'EXPECTANCY_NOT_SUPPORTED',
    ]);
  });
});

describe('evaluateProtocol on synthetic candles', () => {
  const protocol: Protocol = {
    ...PROTOCOL,
    data: { ...PROTOCOL.data, collectionCutoff: '2026-03-12T00:00:00.000Z' },
    universe: { ...PROTOCOL.universe, members: ['AAAUSDT', 'BBBUSDT'] },
    decisions: {
      ...PROTOCOL.decisions,
      firstDecision: '2026-01-10T00:00:00.000Z',
      currentEvaluation: '2026-03-12T00:00:00.000Z',
    },
    splits: {
      ...PROTOCOL.splits,
      boundaries: ['2026-02-10T00:00:00.000Z', '2026-02-25T00:00:00.000Z'],
    },
    estimation: {
      ...PROTOCOL.estimation,
      minimumFitEvidence: { observations: 5, distinctDays: 2 },
    },
    uncertainty: { ...PROTOCOL.uncertainty, replicates: 50 },
  };
  const start = ms(protocol.decisions.firstDecision) - 200 * HOUR_MS;
  const hours = (ms(protocol.data.collectionCutoff) - start) / HOUR_MS;
  const candles = { AAAUSDT: walk(start, hours, 11), BBBUSDT: walk(start, hours, 23, 3) };
  const results = evaluateProtocol(candles, protocol);

  it('observes every decision once, deterministically', () => {
    expect(results.coverage['AAAUSDT']).toMatchObject({
      decisions: 361,
      featuresUnavailable: 0,
      outcomeMissing: 0,
      observations: 361,
    });
    expect(results.splits.test.firstDecision).toBe('2026-02-25T00:00:00.000Z');
    expect(results.splits.validation.lastDecision).toBe('2026-02-24T00:00:00.000Z');
    expect(results.splits.purged).toBe(2 * 2 * 5);
    expect(JSON.stringify(evaluateProtocol(candles, protocol))).toBe(JSON.stringify(results));
    expect(results.current.candidates).toHaveLength(12);
  });

  it('fits on test-free data: test-period candles change no development or confirmatory fit', () => {
    const b2 = ms(protocol.splits.boundaries[1]!);
    const shifted = (rows: HourCandle[]) =>
      rows.map((c) =>
        c.timestamp >= b2
          ? { ...c, open: c.open * 2, high: c.high * 2.2, low: c.low * 1.9, close: c.close * 2.1 }
          : c,
      );
    const changed = evaluateProtocol(
      { AAAUSDT: shifted(candles.AAAUSDT), BBBUSDT: shifted(candles.BBBUSDT) },
      protocol,
    );
    expect(changed.development).toEqual(results.development);
    const predicted = (r: typeof results) =>
      r.confirmatory.map((e) => e.calibration.cells.map((c) => c.predicted));
    expect(predicted(changed)).toEqual(predicted(results));
    expect(changed.confirmatory).not.toEqual(results.confirmatory);
  });

  it('counts a missing candle against every decision that needs it, and fills nothing', () => {
    const gapAt = ms('2026-02-01T10:00:00.000Z');
    const gapped = {
      ...candles,
      AAAUSDT: candles.AAAUSDT.filter((c) => c.timestamp !== gapAt),
    };
    const coverage = evaluateProtocol(gapped, protocol).coverage['AAAUSDT']!;
    // Outcomes of decisions 23h to 0h before the gap; features of decisions 1h to 200h after it.
    expect(coverage.outcomeMissing).toBe(6);
    expect(coverage.featuresUnavailable).toBe(50);
    expect(coverage.observations).toBe(361 - 56);
  });
});

describe('negative control', () => {
  // On an i.i.d. walk nothing is predictable, so any skill or expectancy here would mean look-ahead.
  it('finds no skill, no expectancy and no shortlist in random walks over the protocol dates', () => {
    const protocol: Protocol = {
      ...PROTOCOL,
      universe: { ...PROTOCOL.universe, members: ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT'] },
      uncertainty: { ...PROTOCOL.uncertainty, replicates: 200 },
    };
    const start = ms(PROTOCOL.data.historyStart);
    const hours = (ms(PROTOCOL.data.collectionCutoff) - start) / HOUR_MS;
    const candles = Object.fromEntries(
      protocol.universe.members.map((symbol, j) => [symbol, walk(start, hours, 1000 + j, 50 + j)]),
    );
    const results = evaluateProtocol(candles, protocol);
    expect(results.confirmatory.map((e) => e.support.status)).toEqual(
      Array(6).fill('NOT_SUPPORTED'),
    );
    expect(results.confirmatory.map((e) => e.expectancy.status)).toEqual(
      Array(6).fill('NOT_SUPPORTED'),
    );
    expect(results.current.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(results.current.shortlist).toEqual([]);
  }, 30_000);
});

describe('runner', () => {
  it('refuses to collect history before the cutoff', async () => {
    await expect(
      collectHistory('unused', () => ms(PROTOCOL.data.collectionCutoff) - 1),
    ).rejects.toThrow('only after the collection cutoff');
  });

  it('records the commit and source blobs only from an unmodified tracked tree', async () => {
    const clean = async (...args: string[]) => {
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return 'c0ffee';
      return `blob:${args[1]}`;
    };
    const identity = await codeIdentity(clean);
    expect(identity.repositoryCommit).toBe('c0ffee');
    expect(Object.keys(identity.sourceBlobs)).toEqual([...SOURCE_FILES]);
    expect(identity.sourceBlobs['scripts/spot24h.ts']).toBe('blob:scripts/spot24h.ts');
    const dirty = async (...args: string[]) =>
      args[0] === 'status' ? ' M scripts/spot24h.ts' : clean(...args);
    await expect(codeIdentity(dirty)).rejects.toThrow('commit before running');
  });

  it('refuses a universe file that is not the recorded one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot24h-'));
    await writeFile(join(dir, 'universe.json'), '{}\n');
    await expect(verifyUniverse(dir)).rejects.toThrow('is not the recorded');
  });

  it('pages through history by open time and stops at the cutoff', async () => {
    const start = ms('2026-01-01T00:00:00.000Z');
    const all = walk(start, 2500);
    const calls: { startTime: number | undefined; endTime: number | undefined }[] = [];
    const fake = async (
      _symbol: string,
      options: { limit: number; startTime?: number; endTime?: number },
    ) => {
      calls.push({ startTime: options.startTime, endTime: options.endTime });
      return all
        .filter(
          (c) =>
            c.timestamp >= (options.startTime ?? 0) && c.timestamp <= (options.endTime ?? Infinity),
        )
        .slice(0, options.limit);
    };
    const cutoff = start + 2200 * HOUR_MS;
    const candles = await fetchHistory('AAAUSDT', fake, start, cutoff, 1000, 0);
    expect(candles).toEqual(all.slice(0, 2200));
    expect(calls.map((c) => c.startTime)).toEqual([
      start,
      start + 1000 * HOUR_MS,
      start + 2000 * HOUR_MS,
    ]);
    expect(calls.every((c) => c.endTime === cutoff - 1)).toBe(true);
  });
});
