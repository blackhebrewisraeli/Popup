import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atr } from '@/lib/indicators';
import { mulberry32 } from './opportunityAnalysis';
import {
  dayOf,
  HOUR_MS,
  indexHourly,
  netReturn,
  PROTOCOL,
  protocolSha256,
  type HourCandle,
} from './spot24h';
import type { Git } from './spot24hDiagnosticRun';
import {
  NO_ENTRY_REASONS,
  SCREEN_REASONS,
  SPEC,
  armA,
  armB,
  biasAt,
  biasBars,
  conclude,
  enter,
  groupSummary,
  intervalsOf,
  pairedRow,
  periodOf,
  pointCharacterOf,
  screenHour,
  structureEntryStudy,
  type GroupSummary,
  type Intervals,
  type PairedRow,
  type Source,
  type Spec,
} from './structureEntry';
import { runStructureEntry, studyIdentity } from './structureEntryRun';

const H = HOUR_MS;
const START = Date.UTC(2025, 0, 1);
const FAR = Date.UTC(2030, 0, 1);
const iso = (time: number) => new Date(time).toISOString();
type Ohlc = [number, number, number, number];
const bar = (timestamp: number, [open, high, low, close]: Ohlc) =>
  ({ timestamp, closeTime: timestamp + H - 1, open, high, low, close }) as HourCandle;
const indexOf = (candles: Map<number, HourCandle>) => indexHourly([...candles.values()], FAR);

// ---------------------------------------------------------------------------------------------
// Arms on a hand-built source: L = 100, H = 110, sweepLow = low(S) = 99, ATR 1

const S0 = START + 300 * H;
const SOURCE: Source = {
  symbol: 'AAAUSDT',
  sourceOpen: S0,
  decision: S0 + H,
  day: dayOf(S0 + H),
  low: { kind: 'low', price: 100, candleOpenTime: S0 - 10 * H, availableAt: S0 - 7 * H - 1 },
  high: { kind: 'high', price: 110, candleOpenTime: S0 - 5 * H, availableAt: S0 - 2 * H - 1 },
  sweepLow: 99,
  sweepClose: 100.5,
  atr: 1,
  bias: { reason: 'HIGHER_HIGH_AND_HIGHER_LOW', establishedAt: S0 - 20 * H, lastBarOpen: S0 },
};
const neutral = (p: number): Ohlc => [p, p + 0.5, p - 0.5, p];

/** S (high 101, low 99) and S+1 ... S+40; an unlisted offset repeats the last close, range 1. */
function market(path: Record<number, Ohlc>, without: readonly number[] = []) {
  const candles = new Map<number, HourCandle>([[S0, bar(S0, [100.5, 101, 99, 100.5])]]);
  let last = 105;
  for (let k = 1; k <= 40; k += 1) {
    const ohlc = path[k] ?? neutral(last);
    last = ohlc[3];
    if (!without.includes(k)) candles.set(S0 + k * H, bar(S0 + k * H, ohlc));
  }
  return indexOf(candles);
}

/** M = S+1 closes above 110; C = S+2 leaves the gap [high(S) = 101, 103]; J = S+5; E = S+6 at 104. */
const BASE: Record<number, Ohlc> = {
  1: [101, 111, 100.8, 110.5],
  2: [110.5, 112, 103, 111],
  3: neutral(111),
  4: neutral(111),
  5: [106, 106.5, 102.5, 104],
  6: [104, 104.5, 103.5, 104],
};
const b = (path: Record<number, Ohlc>, without: readonly number[] = []) =>
  armB(market(path, without), SOURCE);

describe('arm B: the waiting sequence', () => {
  it('enters at the open after the first return, from M, the triplet gap and J', () => {
    const arm = b(BASE);
    expect(arm).toMatchObject({
      status: 'ENTERED',
      offsets: { m: 1, c: 2, j: 5, e: 6 },
      gap: { low: 101, high: 103, availableAt: S0 + 3 * H - 1 },
      entryOpen: S0 + 6 * H,
      entry: 104,
      stop: 102,
      target: 108,
      waitingHours: 5,
      category: 'TIMEOUT',
      holdingCandles: 24,
      exitTime: S0 + 30 * H,
    });
    expect(arm.net).toBe(netReturn(104, 104, 'TIMEOUT'));
    expect(arm.gross).toBe(0);
  });

  it('decides on E by its open only; its own low never cancels the entry', () => {
    const arm = b({ ...BASE, 6: [104, 104.5, 98, 104] });
    expect(arm).toMatchObject({ status: 'ENTERED', category: 'STOP', holdingCandles: 1 });
    expect(arm.net).toBe(netReturn(104, 102, 'STOP'));
  });

  it('accepts a structure break at S+6 and expires without one by then', () => {
    const late = {
      6: [105, 111, 104.8, 110.5],
      7: [110.5, 112, 106, 111],
      12: [107, 107.5, 105.8, 106],
      13: [106, 106.5, 105.5, 106],
    } satisfies Record<number, Ohlc>;
    expect(b(late)).toMatchObject({
      status: 'ENTERED',
      offsets: { m: 6, c: 7, j: 12, e: 13 },
      waitingHours: 12,
    });
    expect(b({ 7: [105, 111, 104.8, 110.5] })).toMatchObject({
      status: 'NO_STRUCTURE_BREAK',
      decidedAt: 6,
    });
    expect(b({ ...late, 12: neutral(111), 13: [107, 107.5, 105.8, 106] })).toMatchObject({
      status: 'NO_RETURN',
      decidedAt: 12,
      offsets: { j: null, e: null },
    });
  });

  it('takes only the first close above H: a bearish one ends the arm', () => {
    const arm = b({ 1: [111, 112, 104, 110.5], 2: [110.5, 113, 110, 112.5] });
    expect(arm).toMatchObject({ status: 'STRUCTURE_BREAK_NOT_BULLISH', decidedAt: 1 });
    expect(b({ 1: [105, 110.2, 104.5, 110] }).status).toBe('NO_STRUCTURE_BREAK');
  });

  it('examines only the triplet M-1, M, M+1, with S itself as M-1', () => {
    const noGap = b({ ...BASE, 2: [110.5, 112, 101, 111], 3: [111, 115, 112, 114] });
    expect(noGap).toMatchObject({ status: 'NO_FVG', decidedAt: 2, gap: null });
    // high(S) = 101 equal to low(C) is no gap: the inequality is strict.
    expect(b({ ...BASE, 2: [110.5, 112, 101, 111] }).status).toBe('NO_FVG');
  });

  it('makes the gap usable only after C closes: the earliest return is S+3', () => {
    const arm = b({ ...BASE, 3: [106, 106.5, 102.5, 104], 4: [104, 104.5, 103.5, 104] });
    expect(arm).toMatchObject({ status: 'ENTERED', offsets: { j: 3, e: 4 }, waitingHours: 3 });
  });

  it('counts a low exactly at G_high as the return', () => {
    expect(b({ ...BASE, 4: [111, 111.5, 103, 111] })).toMatchObject({ offsets: { j: 4, e: 5 } });
  });

  it('takes A = M-1, not S, when the break comes later', () => {
    const later = { 1: neutral(105), 2: [105, 111, 104.8, 110.5] } satisfies Record<number, Ohlc>;
    expect(b({ ...later, 3: [110.5, 112, 105.2, 111] }).status).toBe('NO_FVG');
    expect(b({ ...later, 3: [110.5, 112, 106, 111] }).gap).toMatchObject({ low: 105.5, high: 106 });
  });

  it('consumes the first return: one below the gap ends the arm, no second return', () => {
    const closesBelow: Record<number, Ohlc> = {
      ...BASE,
      5: [106, 106.5, 100.5, 100.8],
      6: [102, 102.5, 101.5, 102],
    };
    expect(b(closesBelow)).toMatchObject({
      status: 'RETURN_BELOW_GAP',
      decidedAt: 5,
    });
    expect(b({ ...BASE, 5: [100.8, 102.6, 100.5, 102] }).status).toBe('RETURN_BELOW_GAP');
  });

  it('cancels on any low at or below the sweep low through J, before any other test', () => {
    expect(b({ 1: [100, 101, 98.9, 100.5] })).toMatchObject({
      status: 'CANCELLED_SWEEP_LOW_BROKEN',
      decidedAt: 1,
    });
    expect(b({ ...BASE, 1: [101, 111, 99, 110.5] })).toMatchObject({
      status: 'CANCELLED_SWEEP_LOW_BROKEN',
      offsets: { m: null },
    });
    expect(b({ ...BASE, 4: [111, 111.5, 99, 111] })).toMatchObject({
      status: 'CANCELLED_SWEEP_LOW_BROKEN',
      decidedAt: 4,
      offsets: { j: null },
    });
    expect(b({ ...BASE, 5: [106, 106.5, 98.5, 104] }).status).toBe('CANCELLED_SWEEP_LOW_BROKEN');
  });

  it('refuses an entry open at or below the sweep low, then one below the gap', () => {
    expect(b({ ...BASE, 6: [99, 104.5, 98.5, 104] })).toMatchObject({
      status: 'ENTRY_OPEN_AT_OR_BELOW_SWEEP_LOW',
      offsets: { e: 6 },
      waitingHours: null,
      net: 0,
    });
    expect(b({ ...BASE, 6: [100.5, 104.5, 100, 104] }).status).toBe('ENTRY_OPEN_BELOW_GAP');
  });

  it('fails visibly on a missing candle it must read, and ignores one after the exit', () => {
    expect(b(BASE, [3])).toMatchObject({ status: 'INTEGRITY_FAILURE', missingOpen: S0 + 3 * H });
    expect(b(BASE, [6])).toMatchObject({ status: 'INTEGRITY_FAILURE', missingOpen: S0 + 6 * H });
    expect(b(BASE, [20])).toMatchObject({ status: 'INTEGRITY_FAILURE', missingOpen: S0 + 20 * H });
    expect(b(BASE, [35]).status).toBe('ENTERED');
  });

  it('is immune to every candle after the exit, and to E beyond its open', () => {
    const later = { ...BASE } as Record<number, Ohlc>;
    for (let k = 30; k <= 40; k += 1) later[k] = neutral(50);
    expect(b(later)).toEqual(b(BASE));
    expect(armA(market(later), SOURCE)).toEqual(armA(market(BASE), SOURCE));
  });
});

describe('arm A and the shared exit policy', () => {
  const a = (path: Record<number, Ohlc>, without: readonly number[] = []) =>
    armA(market({ 1: neutral(101), ...path }, without), SOURCE);

  it('enters at the open of S+1 and times out at the 24th candle close, reading nothing after', () => {
    const arm = a({});
    expect(arm).toMatchObject({
      status: 'ENTERED',
      entryOpen: S0 + H,
      entry: 101,
      stop: 99,
      target: 105,
      category: 'TIMEOUT',
      holdingCandles: 24,
      exitTime: S0 + 25 * H,
    });
    expect(a({ 25: [50, 51, 49, 50] })).toEqual(arm);
  });

  it('exits a gap through the stop at the open and through the target at the target', () => {
    const gapStop = a({ 3: [98, 98.5, 97, 98] });
    expect(gapStop).toMatchObject({ category: 'STOP', gapStop: true, holdingCandles: 3 });
    expect(gapStop.gross).toBe(98 / 101 - 1);
    expect(gapStop.net).toBe(netReturn(101, 98, 'STOP'));
    const gapTarget = a({ 3: [107, 108, 106.5, 107] });
    expect(gapTarget.net).toBe(netReturn(101, 105, 'TARGET'));
  });

  it('books a candle touching both levels as AMBIGUOUS at the stop', () => {
    const arm = a({ 2: [101, 106, 98, 101] });
    expect(arm).toMatchObject({ category: 'AMBIGUOUS', gapStop: false });
    expect(arm.net).toBe(netReturn(101, 99, 'AMBIGUOUS'));
  });

  it('uses the source ATR from each arm’s own entry; invalid levels do not enter', () => {
    const index = market(BASE);
    expect(armA(index, SOURCE)).toMatchObject({ entry: 101, stop: 99, target: 105 });
    expect(armB(index, SOURCE)).toMatchObject({ entry: 104, stop: 102, target: 108 });
    const candle = index.valid.get(S0 + H);
    if (!candle) throw new Error('fixture');
    expect(enter(index, candle, 60)).toMatchObject({ status: 'INVALID_LEVELS', net: 0, gross: 0 });
  });

  it('reports a missing entry or holding candle as an integrity failure', () => {
    expect(a({}, [1])).toMatchObject({ status: 'INTEGRITY_FAILURE', missingOpen: S0 + H });
    expect(a({}, [10])).toMatchObject({ status: 'INTEGRITY_FAILURE', missingOpen: S0 + 10 * H });
  });
});

describe('paired rows', () => {
  const row = (path: Record<number, Ohlc>, source = SOURCE) =>
    pairedRow(market(path), { ...source, period: 'train' });

  it('keeps every source: no entry is zero return, and the difference is per source', () => {
    const rows = [
      row(BASE),
      row({ 1: neutral(101) }),
      row(BASE, { ...SOURCE, atr: 60, sourceOpen: S0, day: SOURCE.day + 1 }),
    ];
    expect(rows.map((r) => r.b.status)).toEqual([
      'ENTERED',
      'NO_STRUCTURE_BREAK',
      'INVALID_LEVELS',
    ]);
    const g = groupSummary(rows);
    const entered = rows[0]?.b.net ?? Number.NaN;
    expect(g.sources).toBe(3);
    expect(g.days).toBe(2);
    expect(g.b.entries).toBe(1);
    expect(g.b.fillRate).toBe(1 / 3);
    expect(g.b.meanNetPerSource).toBeCloseTo(entered / 3, 15);
    expect(g.b.meanNetPerTrade).toBe(entered);
    expect(g.b.statuses.NO_STRUCTURE_BREAK).toBe(1);
    expect(g.a.statuses.INVALID_LEVELS).toBe(1);
    const aMean = g.a.meanNetPerSource ?? Number.NaN;
    expect(g.paired.meanNetDifference).toBeCloseTo((g.b.meanNetPerSource ?? 0) - aMean, 15);
    expect(rows[1]?.difference.net).toBe(-(rows[1]?.a.net ?? 0));
  });
});

// ---------------------------------------------------------------------------------------------
// Sources on a rising zigzag: 8 hours up by 1, 8 down by 0.75, every candle's range ±0.1 beyond
// its body. Hourly pivot lows sit at cycle hour 15, highs at 7; 4h bars rise and fall in pairs.

function zigzag(hours: number, up = 1, down = 0.75) {
  const candles = new Map<number, HourCandle>();
  let close = 100;
  for (let h = 0; h < hours; h += 1) {
    const open = close;
    close = open + (h % 16 < 8 ? up : -down);
    const range: Ohlc = [open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close];
    candles.set(START + h * H, bar(START + h * H, range));
  }
  return candles;
}

/** S at hour 253 (cycle 15, sixth down hour): low 129.5 under the cycle-14 bottom low 129.9. */
const S_HOUR = 253;
const SWEEP: Ohlc = [134.25, 134.35, 129.5, 133.5];
function zigzagWith(overrides: Record<number, Ohlc>, hours = 330) {
  const candles = zigzag(hours);
  for (const [h, ohlc] of Object.entries(overrides)) {
    candles.set(START + Number(h) * H, bar(START + Number(h) * H, ohlc));
  }
  return candles;
}
const screen = (candles: Map<number, HourCandle>, hour = S_HOUR, used = new Set<number>()) =>
  screenHour('AAAUSDT', indexOf(candles), START + hour * H, used);

describe('source opportunity', () => {
  it('freezes the latest confirmed pivots, the sweep low, ATR14 through S and the 4h bias', () => {
    const candles = zigzagWith({ [S_HOUR]: SWEEP });
    const result = screen(candles);
    if (result.reason) throw new Error(result.reason);
    const window = [...candles.values()].slice(S_HOUR - 199, S_HOUR + 1);
    const expectedAtr = atr(
      window.map((c) => c.high),
      window.map((c) => c.low),
      window.map((c) => c.close),
      14,
    ).at(-1);
    expect(result.source).toMatchObject({
      sourceOpen: START + S_HOUR * H,
      decision: START + (S_HOUR + 1) * H,
      low: { price: 129.9, candleOpenTime: START + 239 * H, availableAt: START + 242 * H - 1 },
      high: { price: 138.1, candleOpenTime: START + 247 * H, availableAt: START + 250 * H - 1 },
      sweepLow: 129.5,
      sweepClose: 133.5,
      atr: expectedAtr,
      bias: { reason: 'HIGHER_HIGH_AND_HIGHER_LOW', lastBarOpen: START + 248 * H },
    });
    expect(result.source.low.price).toBeCloseTo(129.9, 9);
  });

  it('uses a pivot confirmed by the close of S-1, never one still awaiting its right bars', () => {
    // A lower low at S-3 is confirmed by S-2 and S-1: it becomes L.
    const confirmed = screen(zigzagWith({ [S_HOUR]: SWEEP, 250: [136.5, 136.6, 129.7, 135.75] }));
    if (confirmed.reason) throw new Error(confirmed.reason);
    expect(confirmed.source.low).toMatchObject({ candleOpenTime: START + 250 * H, price: 129.7 });
    // At S-2 it is not yet a pivot when S opens; it breaches the old L, which is not replaced.
    const pending = screen(zigzagWith({ [S_HOUR]: SWEEP, 251: [135.75, 135.85, 129.7, 135] }));
    expect(pending.reason).toBe('LOW_ALREADY_BREACHED');
  });

  it('requires a sweep below L, a close back above L and below H', () => {
    expect(screen(zigzagWith({})).reason).toBe('NO_SWEEP');
    expect(screen(zigzagWith({ [S_HOUR]: [134.25, 134.35, 129.5, 129.9] })).reason).toBe(
      'NOT_RECLAIMED',
    );
    expect(screen(zigzagWith({ [S_HOUR]: [134.25, 139, 129.5, 138.5] })).reason).toBe(
      'CLOSE_NOT_BELOW_HIGH',
    );
  });

  it('gives each pivot low at most one source; the sweep itself breaches it for later hours', () => {
    const candles = zigzagWith({ [S_HOUR]: SWEEP });
    expect(screen(candles, S_HOUR, new Set([START + 239 * H])).reason).toBe('PIVOT_ALREADY_USED');
    expect(screen(candles, S_HOUR + 1).reason).toBe('LOW_ALREADY_BREACHED');
  });

  it('refuses a source whose 200-candle window has a gap', () => {
    const candles = zigzagWith({ [S_HOUR]: SWEEP });
    candles.delete(START + 60 * H);
    expect(screen(candles).reason).toBe('INPUT_UNAVAILABLE');
  });

  it('is immune to every candle opening after S', () => {
    const before = screen(zigzagWith({ [S_HOUR]: SWEEP }));
    const changed = zigzagWith({ [S_HOUR]: SWEEP });
    for (let h = S_HOUR + 1; h < 330; h += 1)
      changed.set(START + h * H, bar(START + h * H, [50, 51, 49, 50]));
    expect(screen(changed)).toEqual(before);
  });
});

describe('the 4h bias', () => {
  it('aggregates complete UTC 4h bars and never uses the forming one', () => {
    const index = indexOf(zigzag(330));
    const aligned = biasBars(index, START + 252 * H);
    expect(aligned?.at(-1)).toEqual({
      timestamp: START + 248 * H,
      closeTime: START + 252 * H - 1,
      open: 138,
      high: 138.1,
      low: 134.9,
      close: 135,
    });
    expect(aligned).toHaveLength(50);
    expect(aligned?.[0]?.timestamp).toBe(START + 52 * H);
    // One hour later the bar opening at 252 is forming: the latest bar is still the one at 248.
    const changed = zigzag(330);
    changed.set(START + 252 * H, bar(START + 252 * H, [135, 200, 1, 150]));
    expect(biasBars(indexOf(changed), START + 253 * H)).toEqual(aligned);
  });

  it('is Up on the rising zigzag, not Up on a falling one, unavailable on a gap or no pivots', () => {
    const decision = START + 254 * H;
    expect(biasAt(indexOf(zigzag(330)), decision)).toMatchObject({ reason: null });
    expect(biasAt(indexOf(zigzag(330, 0.75, 1)), decision)).toEqual({ reason: 'BIAS_NOT_UP' });
    const gap = zigzag(330);
    gap.delete(START + 100 * H);
    expect(biasAt(indexOf(gap), decision)).toEqual({ reason: 'BIAS_UNAVAILABLE' });
    const flat = new Map<number, HourCandle>();
    for (let h = 0; h < 330; h += 1) flat.set(START + h * H, bar(START + h * H, neutral(100)));
    expect(biasAt(indexOf(flat), decision)).toEqual({ reason: 'BIAS_UNAVAILABLE' });
  });
});

describe('admission', () => {
  it('admits a source only when D and D + 36h lie inside one period', () => {
    const [b1, b2] = PROTOCOL.splits.boundaries.map(Date.parse) as [number, number];
    expect(periodOf(b1 - 36 * H)).toBe('train');
    expect(periodOf(b1 - 35 * H)).toBeNull();
    expect(periodOf(b1)).toBe('validation');
    expect(periodOf(b2 - 36 * H)).toBe('validation');
    expect(periodOf(Date.parse(SPEC.timing.firstDecision) - H)).toBeNull();
    expect(periodOf(Date.parse(SPEC.timing.lastCandleClose) - 36 * H)).toBe('test');
  });
});

// ---------------------------------------------------------------------------------------------
// Uncertainty and decision

function smallSpec(): Spec {
  const spec = structuredClone(SPEC) as Spec;
  spec.uncertainty.replicates = 400;
  spec.uncertainty.minimumDefinedReplicates = 396;
  return spec;
}

const fakeRow = (day: number, a: number, bNet: number) =>
  ({
    source: { day, symbol: 'X', period: 'train' },
    a: { net: a },
    b: { net: bNet },
    difference: { net: bNet - a, gross: 0 },
  }) as unknown as PairedRow;

describe('paired day-block bootstrap', () => {
  const window = { id: 'w', start: START, end: START + 60 * 24 * H };
  const first = dayOf(START);

  it('is deterministic, keeps both arms of a day together and uses type-7 percentiles', () => {
    const spec = smallSpec();
    const rows = Array.from({ length: 58 }, (_, i) =>
      fakeRow(first + i, -0.01 + 0.0003 * i, -0.005 + 0.0003 * i),
    );
    const one = intervalsOf(rows, window, spec);
    expect(intervalsOf(rows, window, spec)).toEqual(one);
    expect(one.positions).toBe(59);
    // Every source improves by exactly 0.005, so every replicate does too.
    expect(one.difference).toMatchObject({ status: 'AVAILABLE', defined: 400 });
    if (one.difference.status !== 'AVAILABLE' || one.bNet.status !== 'AVAILABLE') return;
    expect(one.difference.low).toBeCloseTo(0.005, 12);
    expect(one.difference.high).toBeCloseTo(0.005, 12);
    expect(one.bNet.low).toBeLessThan(one.bNet.high);
  });

  it('counts replicates without a source as undefined and withholds a thin interval', () => {
    const result = intervalsOf([fakeRow(first + 3, 0, 0.01)], window, smallSpec());
    expect(result.difference.status).toBe('UNAVAILABLE');
    expect(result.difference.defined).toBeLessThan(396);
    expect(intervalsOf([], window, smallSpec()).bNet).toEqual({
      status: 'UNAVAILABLE',
      defined: 0,
      replicates: 400,
    });
    expect(() => intervalsOf([fakeRow(first + 80, 0, 0)], window, smallSpec())).toThrow(
      'outside window',
    );
  });
});

describe('the decision', () => {
  const group = (
    sources: number,
    days: number,
    entries: number,
    entryDays: number,
    diff: number,
    bNet: number,
  ) =>
    ({
      sources,
      days,
      b: { entries, entryDays, meanNetPerSource: bNet },
      paired: { meanNetDifference: diff },
    }) as unknown as GroupSummary;
  const interval = (low: number, high: number) => ({
    status: 'AVAILABLE' as const,
    low,
    high,
    defined: 10000,
    replicates: 10000,
  });
  const pooled = (diff: [number, number], bNet: [number, number]) =>
    ({ difference: interval(...diff), bNet: interval(...bNet) }) as unknown as Intervals;
  const ok = group(400, 100, 150, 60, 0.002, 0.001);
  const periods = { validation: ok, test: ok };
  const run = (overrides: Partial<Parameters<typeof conclude>[0]>) =>
    conclude({
      integrityFailures: 0,
      all: ok,
      periods,
      pooled: pooled([0.001, 0.003], [0.0005, 0.002]),
      ...overrides,
    });

  it('reaches each verdict only by its predeclared rule, in order', () => {
    expect(run({}).verdict).toBe('CANDIDATE_FOR_INDEPENDENT_VALIDATION');
    expect(run({ integrityFailures: 1 }).verdict).toBe('INTEGRITY_FAILURE');
    expect(run({ all: group(299, 100, 150, 60, 0.002, 0.001) }).verdict).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
    expect(run({ all: group(400, 59, 150, 60, 0.002, 0.001) }).verdict).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
    expect(run({ all: group(400, 100, 99, 60, 0.002, 0.001) }).verdict).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
    expect(run({ all: group(400, 100, 150, 29, 0.002, 0.001) }).verdict).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
    const weakTest = { validation: ok, test: group(100, 30, 40, 20, 0.002, -0.0001) };
    expect(run({ periods: weakTest }).verdict).toBe('INCONCLUSIVE');
    expect(run({ pooled: pooled([-0.001, 0.003], [0.0005, 0.002]) }).verdict).toBe('INCONCLUSIVE');
    const lost = run({ pooled: pooled([0.001, 0.003], [-0.004, -0.001]) });
    expect(lost).toMatchObject({ verdict: 'NEGATIVE', negativeBecause: ['B_NET_PER_SOURCE'] });
    const worse = run({ pooled: pooled([-0.003, -0.001], [-0.004, -0.001]) });
    expect(worse.negativeBecause).toEqual(['PAIRED_DIFFERENCE', 'B_NET_PER_SOURCE']);
  });

  it('labels the point estimates without ever calling a smaller loss a profit', () => {
    expect(pointCharacterOf(0, 0.01)).toBe('NO_IMPROVEMENT');
    expect(pointCharacterOf(0.002, -0.001)).toBe('LOSS_REDUCED_ONLY');
    expect(pointCharacterOf(0.002, 0)).toBe('LOSS_REDUCED_ONLY');
    expect(pointCharacterOf(0.002, 0.001)).toBe('POSITIVE_NET');
  });
});

// ---------------------------------------------------------------------------------------------
// The whole study

function syntheticSpec(firstHour: number, endHour: number, periods: [number, number]): Spec {
  const spec = smallSpec();
  const at = (h: number) => iso(START + h * H);
  spec.timing.firstDecision = at(firstHour);
  spec.timing.lastCandleClose = at(endHour);
  spec.periods.list = [
    { id: 'train', start: at(firstHour), end: at(periods[0]) },
    { id: 'validation', start: at(periods[0]), end: at(periods[1]) },
    { id: 'test', start: at(periods[1]), end: at(endHour) },
  ];
  return spec;
}

describe('the study on synthetic markets', () => {
  it('admits the zigzag source, pairs it and accounts for every scanned hour', () => {
    const candles = { AAAUSDT: [...zigzagWith({ [S_HOUR]: SWEEP }).values()] };
    const results = structureEntryStudy(candles, ['AAAUSDT'], syntheticSpec(210, 330, [300, 320]));
    expect(results.rows).toHaveLength(1);
    expect(results.rows[0]).toMatchObject({ symbol: 'AAAUSDT', period: 'train' });
    const counted = Object.values(results.screening.counts).reduce((a, n) => a + n, 0);
    expect(counted + results.screening.admitted).toBe(results.screening.hours);
    expect(results.screening.hours).toBe(121);
    expect(results.statistics?.all.sources).toBe(1);
    expect(results.conclusion.verdict).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('stops with INTEGRITY_FAILURE and no statistic when an admitted source misses a candle', () => {
    const zz = zigzagWith({ [S_HOUR]: SWEEP });
    zz.delete(START + (S_HOUR + 3) * H);
    const results = structureEntryStudy(
      { AAAUSDT: [...zz.values()] },
      ['AAAUSDT'],
      syntheticSpec(210, 330, [300, 320]),
    );
    expect(results.integrityFailures).toHaveLength(1);
    expect(results.statistics).toBeNull();
    expect(results.conclusion.verdict).toBe('INTEGRITY_FAILURE');
  });

  it('turns a detected source whose follow-up crosses a period end into BOUNDARY', () => {
    const candles = { AAAUSDT: [...zigzagWith({ [S_HOUR]: SWEEP }).values()] };
    const results = structureEntryStudy(candles, ['AAAUSDT'], syntheticSpec(210, 330, [280, 320]));
    expect(results.rows).toHaveLength(0);
    expect(results.screening.counts.BOUNDARY).toBe(1);
  });

  describe('on a 20-pair random walk', () => {
    const hours = 24 * 120;
    const symbols = Array.from({ length: 20 }, (_, i) => `P${String(i).padStart(2, '0')}USDT`);
    const walk = (seed: number) => {
      const next = mulberry32(seed);
      const candles: HourCandle[] = [];
      let close = 50 + 100 * next();
      for (let h = 0; h < hours; h += 1) {
        const open = close;
        close = open * Math.exp(0.012 * (next() - 0.5) + 0.0004);
        const high = Math.max(open, close) * (1 + 0.004 * next());
        const low = Math.min(open, close) * (1 - 0.004 * next());
        candles.push(bar(START + h * H, [open, high, low, close]));
      }
      return candles;
    };
    const candles = Object.fromEntries(symbols.map((s, i) => [s, walk(7000 + i)]));
    const spec = syntheticSpec(216, hours, [216 + 24 * 50, 216 + 24 * 85]);
    const results = structureEntryStudy(candles, symbols, spec);
    const stats = results.statistics;

    it('pairs every admitted source exactly once and keeps no-entry rows at zero', () => {
      if (!stats) throw new Error('integrity failure');
      expect(results.rows.length).toBeGreaterThan(20);
      expect(stats.all.sources).toBe(results.rows.length);
      expect(results.rows.filter((r) => r.b.status !== 'ENTERED').every((r) => r.b.net === 0)).toBe(
        true,
      );
      expect(new Set(results.rows.map((r) => `${r.symbol}|${r.low.candleOpenTime}`)).size).toBe(
        results.rows.length,
      );
      const { a, b: bArm, paired } = stats.all;
      expect(paired.meanNetDifference).toBeCloseTo(
        (bArm.meanNetPerSource ?? 0) - (a.meanNetPerSource ?? 0),
        12,
      );
      expect(Object.values(bArm.statuses).reduce((x, n) => x + n, 0)).toBe(stats.all.sources);
      expect(paired.bBetter + paired.bWorse + paired.equal).toBe(stats.all.sources);
    });

    it('splits sources across periods, months and pairs without losing one', () => {
      if (!stats) throw new Error('integrity failure');
      const total = (groups: Record<string, GroupSummary>) =>
        Object.values(groups).reduce((x, g) => x + g.sources, 0);
      expect(total(stats.periods)).toBe(stats.all.sources);
      expect(total(stats.months)).toBe(stats.all.sources);
      expect(total(stats.pairs)).toBe(stats.all.sources);
      expect(stats.concentration.total).toBeCloseTo(
        (stats.all.paired.meanNetDifference ?? 0) * stats.all.sources,
        12,
      );
      const waits = Object.entries(stats.waiting.hours);
      expect(waits.reduce((x, [, n]) => x + n, 0)).toBe(stats.all.b.entries);
      for (const [h] of waits) expect(Number(h)).toBeGreaterThanOrEqual(3);
      for (const [h] of waits) expect(Number(h)).toBeLessThanOrEqual(12);
    });

    it('keeps every row whose follow-up ends before a change of all later candles', () => {
      const five = symbols.slice(0, 5);
      const cut = START + 24 * 90 * H;
      const changed = Object.fromEntries(
        five.map((s) => [
          s,
          (candles[s] ?? []).map((c) => (c.timestamp >= cut ? bar(c.timestamp, [9, 10, 8, 9]) : c)),
        ]),
      );
      const settled = (r: { decision: string | null }) =>
        Date.parse(r.decision ?? '') + 36 * H <= cut;
      const original = results.rows.filter((r) => five.includes(r.symbol) && settled(r));
      expect(original.length).toBeGreaterThan(5);
      expect(structureEntryStudy(changed, five, spec).rows.filter(settled)).toEqual(original);
    }, 30_000);
  });
});

describe('the specification', () => {
  it('mirrors its reason lists, v1 costs, members and v1 boundaries', () => {
    expect(SCREEN_REASONS).toEqual(SPEC.screening.order);
    expect(NO_ENTRY_REASONS).toEqual(SPEC.armB.noEntryReasons);
    expect(SPEC.costs.feePerFill).toBe(PROTOCOL.costs.feePerFill);
    expect(SPEC.costs.slippagePerMarketFill).toBe(PROTOCOL.costs.slippagePerMarketFill);
    expect(SPEC.timing.firstDecision).toBe(PROTOCOL.decisions.firstDecision);
    expect(SPEC.timing.lastCandleClose).toBe(PROTOCOL.data.collectionCutoff);
    expect(SPEC.periods.list.map((p) => p.end).slice(0, 2)).toEqual(PROTOCOL.splits.boundaries);
    expect(SPEC.periods.list.at(-1)?.end).toBe(PROTOCOL.data.collectionCutoff);
    expect(SPEC.data.universe).toContain(String(PROTOCOL.universe.members.length));
    expect(SPEC.basis.protocol.sha256).toBe(protocolSha256());
  });
});

describe('the runner', () => {
  const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('refuses to run while a tracked file differs from the commit', async () => {
    const dirty: Git = async (...args) => (args[0] === 'status' ? ' M scripts/x.ts' : 'abc');
    await expect(studyIdentity(dirty)).rejects.toThrow('commit before running');
  });

  it('verifies every input, writes once and never overwrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'structure-entry-'));
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'klines'), { recursive: true });
    const candleFiles: Record<string, { sha256: string; candles: number; retrievedAt: string }> =
      {};
    for (const symbol of PROTOCOL.universe.members) {
      const text = JSON.stringify({ symbol, candles: [bar(START, neutral(100))] });
      await writeFile(join(dataDir, 'klines', `${symbol}-1h.json`), text);
      candleFiles[symbol] = { sha256: sha256(text), candles: 1, retrievedAt: iso(START) };
    }
    await writeFile(join(dataDir, 'universe.json'), 'universe');
    const manifest = {
      repositoryCommit: 'run',
      protocol: { id: PROTOCOL.protocolId, sha256: SPEC.basis.protocol.sha256 },
      universe: { path: 'universe.json', sha256: sha256('universe') },
      candleFiles,
    };
    const recordedPath = join(root, 'recorded.json');
    await writeFile(recordedPath, JSON.stringify({ manifest }));
    const recorded = {
      path: recordedPath,
      sha256: sha256(await readFile(recordedPath)),
      runCommit: 'run',
    };
    const identity = async () => ({ codeCommit: 'c', codeBlobs: {} });
    const out = join(root, 'out');

    const first = await runStructureEntry(dataDir, out, identity, recorded);
    expect(first.status).toBe('CREATED');
    expect(first.summary.screening.counts.INPUT_UNAVAILABLE).toBe(first.summary.screening.hours);
    expect(sha256(await readFile(first.path))).toBe(first.contentSha256);
    expect((await runStructureEntry(dataDir, out, identity, recorded)).status).toBe('UNCHANGED');
    const other = async () => ({ codeCommit: 'd', codeBlobs: {} });
    expect((await runStructureEntry(dataDir, out, other, recorded)).status).toBe('CONFLICT');

    await writeFile(join(dataDir, 'klines', 'BTCUSDT-1h.json'), '{"candles":[]}');
    await expect(runStructureEntry(dataDir, out, identity, recorded)).rejects.toThrow(
      'differs from the manifest',
    );
    await expect(
      runStructureEntry(dataDir, out, identity, { ...recorded, sha256: 'x' }),
    ).rejects.toThrow('is not x');
  }, 60_000);
});
