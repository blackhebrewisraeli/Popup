import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atr } from '@/lib/indicators';
import { HOUR_MS, PROTOCOL, indexHourly, netReturn, type HourCandle } from './spot24h';
import {
  REFERENCE_SYMBOLS,
  SPEC,
  buyAndHold,
  channelBreakoutStudy,
  compareEvents,
  conclude,
  crossesBoundary,
  drawdownOf,
  eventOutcome,
  eventStatistics,
  fill,
  levels,
  liquidationValue,
  monthlyOf,
  pairEvents,
  plannedLossFraction,
  scanTrade,
  simulateWallet,
  walletMetrics,
  type BreakoutEvent,
  type Spec,
  type WalletRun,
} from './spot24hBreakout';
import { breakoutIdentity, runChannelBreakout } from './spot24hBreakoutRun';
import type { Git } from './spot24hDiagnosticRun';

const H = HOUR_MS;
const START = Date.UTC(2025, 0, 1);
const FAR = Date.UTC(2030, 0, 1);
const iso = (time: number) => new Date(time).toISOString();
const bar = (timestamp: number, open: number, high: number, low: number, close: number) =>
  ({ timestamp, closeTime: timestamp + H - 1, open, high, low, close }) as HourCandle;
const flatBar = (timestamp: number, price = 100) =>
  bar(timestamp, price, price + 0.5, price - 0.5, price);

/** Flat candles at 100 (range 1, so ATR14 is 1) from START for `hours` hours. */
function flat(hours: number, price = 100) {
  const candles = new Map<number, HourCandle>();
  for (let k = 0; k < hours; k += 1) candles.set(START + k * H, flatBar(START + k * H, price));
  return candles;
}
const indexOf = (candles: Map<number, HourCandle>) => indexHourly([...candles.values()], FAR);

/** First decision time with a full 200-candle window, and a later one used for breakouts. */
const FIRST = START + 200 * H;
const T = START + 240 * H;

/** A breakout candle t (opening at T - 1h) above the flat 100.5 highs, then the entry candle. */
function breakoutAt(candles: Map<number, HourCandle>, time = T, close = 101, entryOpen = 101) {
  candles.set(time - H, bar(time - H, 100, 101.2, 99.5, close));
  candles.set(time, bar(time, entryOpen, entryOpen + 0.5, entryOpen - 0.5, entryOpen));
  for (let k = 1; k < 30; k += 1) candles.set(time + k * H, flatBar(time + k * H, entryOpen));
  return candles;
}

const eventsOf = (candles: Map<number, HourCandle>, symbol = 'AAAUSDT') =>
  pairEvents(symbol, indexOf(candles), FIRST, START + 300 * H).events;

const byTime = (events: readonly BreakoutEvent[]) => {
  const map = new Map<number, BreakoutEvent[]>();
  for (const e of events) map.set(e.time, [...(map.get(e.time) ?? []), e]);
  return map;
};

/** One wallet over [FIRST, end) for the given pairs. */
function wallet(
  pairs: Record<string, Map<number, HourCandle>>,
  end = START + 300 * H,
  spec = SPEC,
) {
  const indexes = Object.fromEntries(Object.entries(pairs).map(([s, c]) => [s, indexOf(c)]));
  const events = Object.entries(indexes).flatMap(
    ([s, index]) => pairEvents(s, index, FIRST, end, spec).events,
  );
  return simulateWallet({ id: 'w', start: FIRST, end }, byTime(events), indexes, spec);
}

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

function randomWalk(seed: number, hours: number, start = START) {
  const next = random32(seed);
  const candles: HourCandle[] = [];
  let close = 50 + 100 * next();
  for (let k = 0; k < hours; k += 1) {
    const open = close;
    close = open * Math.exp(0.012 * (next() - 0.5));
    const high = Math.max(open, close) * (1 + 0.004 * next());
    const low = Math.min(open, close) * (1 - 0.004 * next());
    candles.push(bar(start + k * H, open, high, low, close));
  }
  return candles;
}

describe('signal', () => {
  it('excludes candle t from its own channel and reads ATR14 through t', () => {
    // high(t) = 101.2 is above close(t) = 101: an inclusive channel would never break out.
    const candles = breakoutAt(flat(300));
    const [event, ...rest] = eventsOf(candles);
    expect(rest).toEqual([]);
    expect(event?.time).toBe(T);
    expect(event?.channelHigh).toBe(100.5);
    const window = [...candles.values()].filter((c) => c.timestamp < T).slice(-200);
    const expected = atr(
      window.map((c) => c.high),
      window.map((c) => c.low),
      window.map((c) => c.close),
      14,
    ).at(-1);
    expect(event?.atr).toBe(expected);
    expect(event?.atr).toBeCloseTo((13 + 1.7) / 14, 12);
    expect(event?.strength).toBeCloseTo(0.5 / event!.atr, 12);
  });

  it('treats a close equal to the channel high as no breakout', () => {
    expect(eventsOf(breakoutAt(flat(300), T, 100.5))).toEqual([]);
    expect(eventsOf(breakoutAt(flat(300), T, 100.5000001)).map((e) => e.time)).toEqual([T]);
  });

  it('counts only the transition, each breakout judged against its own preceding window', () => {
    const candles = breakoutAt(flat(300));
    // t + 1 breaks out again (102 above 101.2): still the same run, no second event.
    candles.set(T, bar(T, 101, 102.2, 100.5, 102));
    expect(eventsOf(candles).map((e) => e.time)).toEqual([T]);

    // t - 1's own window holds an old high at t - 25 that t's window no longer holds.
    const own = flat(300);
    own.set(T - 26 * H, bar(T - 26 * H, 100, 105, 99.5, 100));
    own.set(T - 2 * H, bar(T - 2 * H, 100, 104, 99.5, 104));
    own.set(T - H, bar(T - H, 104, 104.6, 103.5, 104.5));
    expect(eventsOf(own).map((e) => e.time)).toContain(T);
    // Remove the old high: t - 1 becomes a breakout itself, so t is not a new event.
    own.set(T - 26 * H, flatBar(T - 26 * H));
    expect(eventsOf(own).map((e) => e.time)).toEqual([T - H]);
  });

  it('is immune to every candle opening at or after the decision time', () => {
    const base = randomWalk(7, 600);
    const all = pairEvents('X', indexHourly(base, FAR), FIRST, START + 600 * H).events;
    const cut = all[Math.floor(all.length / 2)]!.time;
    const changed = base.map((c) =>
      c.timestamp >= cut ? bar(c.timestamp, c.open * 2, c.high * 3, c.low, c.close * 2.5) : c,
    );
    const again = pairEvents('X', indexHourly(changed, FAR), FIRST, START + 600 * H).events;
    expect(again.filter((e) => e.time <= cut)).toEqual(all.filter((e) => e.time <= cut));
  });

  it('refuses a decision whose 200 candles are not all valid and consecutive', () => {
    const candles = breakoutAt(flat(300));
    candles.delete(T - 150 * H);
    const { events, coverage } = pairEvents('A', indexOf(candles), FIRST, START + 300 * H);
    expect(events).toEqual([]);
    // Every decision whose window holds that hour, inside the tested range: FIRST to T + 50h.
    expect(coverage.unavailable).toBe((T + 50 * H - FIRST) / H + 1);
    const invalid = breakoutAt(flat(300));
    invalid.set(T - 3 * H, bar(T - 3 * H, 100, 99, 101, 100)); // high below low
    expect(eventsOf(invalid)).toEqual([]);
  });
});

describe('one trade', () => {
  const index = indexOf(breakoutAt(flat(300)));

  it('enters at the next open and freezes the levels from it', () => {
    const candles = breakoutAt(flat(300), T, 101, 101.3);
    const [event] = eventsOf(candles);
    const run = wallet({ AAAUSDT: candles });
    const trade = run.trades[0]!;
    expect(trade.entry).toBe(101.3);
    expect(trade.stop).toBe(101.3 - 2 * event!.atr);
    expect(trade.target).toBe(101.3 + 4 * event!.atr);
    expect(trade.quantity).toBeCloseTo((trade.spend * 0.999) / (101.3 * 1.0005), 12);
  });

  it('exits a stop gapped through at the open, and a target gapped through at the target', () => {
    const { stop, target } = levels(101, 1);
    const down = new Map([[T, bar(T, 101, 101.5, 100.5, 101)]]);
    down.set(T + H, bar(T + H, 98, 98.5, 97.5, 98));
    const gap = scanTrade(indexOf(down), T, stop, target, 24);
    expect(gap).toMatchObject({ status: 'EXITED', category: 'STOP', exit: 98, gapStop: true });
    const up = new Map([[T, bar(T, 101, 101.5, 100.5, 101)]]);
    up.set(T + H, bar(T + H, 110, 111, 109, 110));
    expect(scanTrade(indexOf(up), T, stop, target, 24)).toMatchObject({
      category: 'TARGET',
      exit: target,
      gapStop: false,
    });
  });

  it('books a candle touching both levels as AMBIGUOUS at the stop', () => {
    const { stop, target } = levels(101, 1);
    const both = new Map([[T, bar(T, 101, 106, 98, 101)]]);
    expect(scanTrade(indexOf(both), T, stop, target, 24)).toMatchObject({
      category: 'AMBIGUOUS',
      exit: stop,
    });
    expect(fill(10, 101, stop, 'AMBIGUOUS').netPnl).toBe(fill(10, 101, stop, 'STOP').netPnl);
  });

  it('times out at the close of the 24th holding candle and reads nothing after it', () => {
    const { stop, target } = levels(101, 1);
    const scan = scanTrade(index, T, stop, target, 24);
    expect(scan).toMatchObject({ status: 'EXITED', category: 'TIMEOUT', exit: 101 });
    expect(scan.candles.map((c) => c.timestamp)).toEqual(
      Array.from({ length: 24 }, (_, k) => T + k * H),
    );
    const late = breakoutAt(flat(300));
    late.set(T + 24 * H, bar(T + 24 * H, 101, 200, 1, 101));
    expect(scanTrade(indexOf(late), T, stop, target, 24)).toEqual(scan);
    const last = breakoutAt(flat(300));
    last.set(T + 23 * H, bar(T + 23 * H, 101, target, 100.5, 101));
    expect(scanTrade(indexOf(last), T, stop, target, 24)).toMatchObject({
      category: 'TARGET',
      candles: { length: 24 },
    });
  });

  it('reports a missing holding candle before the exit, and ignores one after it', () => {
    const { stop, target } = levels(101, 1);
    const hole = breakoutAt(flat(300));
    hole.delete(T + 5 * H);
    expect(scanTrade(indexOf(hole), T, stop, target, 24)).toMatchObject({
      status: 'MISSING',
      missingOpen: T + 5 * H,
    });
    hole.set(T + 2 * H, bar(T + 2 * H, 101, 101.5, 90, 95));
    expect(scanTrade(indexOf(hole), T, stop, target, 24)).toMatchObject({ category: 'STOP' });
  });

  it('accounts costs exactly as protocol v1 and splits net into gross, fees and slippage', () => {
    expect(SPEC.costs.feePerFill).toBe(PROTOCOL.costs.feePerFill);
    expect(SPEC.costs.slippagePerMarketFill).toBe(PROTOCOL.costs.slippagePerMarketFill);
    for (const [exit, category] of [
      [105.2, 'TARGET'],
      [98.9, 'STOP'],
      [97, 'STOP'],
      [98.9, 'AMBIGUOUS'],
      [100.2, 'TIMEOUT'],
    ] as const) {
      const f = fill(17, 101, exit, category);
      expect(f.proceeds / 17 - 1).toBeCloseTo(netReturn(101, exit, category), 14);
      expect(f.grossPnl - f.fees - f.slippage).toBeCloseTo(f.netPnl, 12);
    }
    const target = fill(17, 101, 105.2, 'TARGET');
    expect(target.slippage).toBeCloseTo(target.quantity * 101 * 0.0005, 12);
    expect(liquidationValue(2, 100)).toBeCloseTo(2 * 100 * 0.9995 * 0.999, 12);
  });
});

describe('the wallet', () => {
  it('risks 1% of equity at the stop, costs included, and caps spend at 95% of cash', () => {
    const run = wallet({ AAAUSDT: breakoutAt(flat(300)) });
    const trade = run.trades[0]!;
    expect(trade.equityBefore).toBe(44);
    const atStop = fill(trade.spend, trade.entry, trade.stop, 'STOP');
    expect(atStop.netPnl).toBeCloseTo(-0.44, 12);
    expect(trade.plannedLossFraction).toBe(plannedLossFraction(trade.entry, trade.stop));
    // A tiny ATR makes the risk budget larger than the cash: the 95% cap binds.
    const quiet = new Map<number, HourCandle>();
    for (let k = 0; k < 300; k += 1) {
      quiet.set(START + k * H, bar(START + k * H, 100, 100.001, 99.999, 100));
    }
    breakoutAt(quiet, T, 100.0015, 100.0015);
    quiet.set(T - H, bar(T - H, 100, 100.002, 99.999, 100.0015));
    for (let k = 0; k < 30; k += 1) {
      quiet.set(T + k * H, bar(T + k * H, 100.0015, 100.002, 100.001, 100.0015));
    }
    const capped = wallet({ AAAUSDT: quiet }).trades[0]!;
    expect(capped.spend).toBeCloseTo(0.95 * 44, 12);
  });

  it('marks an open position at liquidation value every hour and books the exit in cash', () => {
    const candles = breakoutAt(flat(300));
    candles.set(T + 3 * H, bar(T + 3 * H, 101, 101.5, 99.5, 99.8)); // an interim dip
    const run = wallet({ AAAUSDT: candles });
    const trade = run.trades[0]!;
    const markAt = (time: number) => run.marks.find((m) => m.time === time)?.equity;
    expect(markAt(T)).toBe(44);
    expect(markAt(T + 4 * H)).toBeCloseTo(
      44 - trade.spend + liquidationValue(trade.quantity, 99.8),
      12,
    );
    expect(markAt(trade.exitTime)).toBeCloseTo(44 + trade.netPnl, 12);
    expect(run.endingEquity).toBeCloseTo(44 + trade.netPnl, 12);
    const drawdown = drawdownOf(run.marks);
    expect(drawdown.usdt).toBeGreaterThan(-trade.netPnl);
    expect(drawdown.troughTime).toBe(T + 4 * H);
  });

  it('chooses the largest strength among simultaneous events, then the symbol', () => {
    const weak = breakoutAt(flat(300), T, 100.8);
    const strong = breakoutAt(flat(300), T, 101.1);
    const run = wallet({ AAAUSDT: weak, BBBUSDT: strong });
    expect(run.trades.map((t) => t.symbol)).toEqual(['BBBUSDT']);
    expect(run.skipped.NOT_SELECTED).toBe(1);
    const tie = wallet({ BBBUSDT: breakoutAt(flat(300)), AAAUSDT: breakoutAt(flat(300)) });
    expect(tie.trades.map((t) => t.symbol)).toEqual(['AAAUSDT']);
    const a = { symbol: 'B', strength: 1 } as BreakoutEvent;
    const b = { symbol: 'A', strength: 1 } as BreakoutEvent;
    expect([a, b].sort(compareEvents).map((e) => e.symbol)).toEqual(['A', 'B']);
  });

  it('chooses and sizes without reading anything after the entry open', () => {
    const pairs = Object.fromEntries(
      ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'].map((s, i) => [s, randomWalk(31 + i, 700)]),
    );
    const toMaps = (list: Record<string, HourCandle[]>) =>
      Object.fromEntries(
        Object.entries(list).map(([s, c]) => [s, new Map(c.map((x) => [x.timestamp, x]))]),
      );
    const first = wallet(toMaps(pairs), START + 700 * H).trades[0]!;
    const changed = Object.fromEntries(
      Object.entries(pairs).map(([s, list]) => [
        s,
        list.map((c) => {
          if (c.timestamp > first.entryTime)
            return bar(c.timestamp, c.open, c.high * 1.5, c.low * 0.5, c.close);
          if (c.timestamp === first.entryTime)
            return bar(c.timestamp, c.open, c.high * 1.2, c.low * 0.8, c.close * 1.1);
          return c;
        }),
      ]),
    );
    const again = wallet(toMaps(changed), START + 700 * H).trades[0]!;
    const decided = (t: typeof first) => [
      t.symbol,
      t.entryTime,
      t.entry,
      t.stop,
      t.target,
      t.spend,
    ];
    expect(decided(again)).toEqual(decided(first));
    expect(again.exitTime).not.toBe(first.exitTime);
  });

  it('holds one position: events while it is open are skipped, one at its exit close is taken', () => {
    const first = breakoutAt(flat(300));
    const during = breakoutAt(flat(300), T + 5 * H);
    const run = wallet({ AAAUSDT: first, BBBUSDT: during });
    expect(run.trades.map((t) => t.symbol)).toEqual(['AAAUSDT']);
    expect(run.skipped.POSITION_OPEN).toBe(1);
    const after = breakoutAt(flat(330), T + 24 * H);
    const next = wallet({ AAAUSDT: first, BBBUSDT: after }, START + 330 * H);
    expect(next.trades.map((t) => [t.symbol, iso(t.entryTime)])).toEqual([
      ['AAAUSDT', iso(T)],
      ['BBBUSDT', iso(T + 24 * H)],
    ]);
  });

  it('records an event it cannot fund, and stops visibly on missing data inside a trade', () => {
    const broke = structuredClone(SPEC) as Spec;
    broke.portfolio.initialCash = 0;
    expect(
      wallet({ AAAUSDT: breakoutAt(flat(300)) }, START + 300 * H, broke).skipped,
    ).toMatchObject({
      INSUFFICIENT_CASH: 1,
    });

    const hole = breakoutAt(flat(300));
    hole.delete(T + 6 * H);
    const run = wallet({ AAAUSDT: hole });
    expect(run.status).toBe('INTEGRITY_FAILURE');
    expect(run.failure).toEqual({ symbol: 'AAAUSDT', entryTime: T, missingOpen: T + 6 * H });
    expect(run.trades).toEqual([]);
    expect(run.endingEquity).toBeNull();
    expect(walletMetrics(run).performance).toBeNull();

    const noEntry = breakoutAt(flat(300));
    noEntry.delete(T);
    expect(wallet({ AAAUSDT: noEntry }).failure).toMatchObject({ missingOpen: T });
    const [event] = eventsOf(breakoutAt(flat(300)));
    expect(eventOutcome(indexOf(hole), event!).status).toBe('OUTCOME_MISSING');
  });

  it('never holds across its window end, and counts what it skips there', () => {
    const candles = breakoutAt(flat(300));
    const tight = wallet({ AAAUSDT: candles }, T + 24 * H - H);
    expect(tight.trades).toEqual([]);
    expect(tight.skipped.BOUNDARY).toBe(1);
    const exact = wallet({ AAAUSDT: candles }, T + 24 * H);
    expect(exact.trades[0]?.exitTime).toBe(T + 24 * H);
    expect(exact.marks.at(-1)).toEqual({ time: T + 24 * H, equity: exact.endingEquity });
    const trade = exact.trades[0]!;
    expect(crossesBoundary(trade, [T + 10 * H])).toBe(true);
    expect(crossesBoundary(trade, [T + 24 * H, T])).toBe(false);
  });
});

describe('reporting', () => {
  it('assigns events to the period that holds their whole window', () => {
    const rows = [T, T + 10 * H, T + 30 * H].map((time) => ({
      symbol: 'A',
      time,
      day: Math.floor(time / 86_400_000),
      status: 'COMPLETE' as const,
      category: 'TIMEOUT' as const,
      candles: 24,
      gapStop: false,
      gross: 0.01,
      net: -0.002,
    }));
    const periods = [
      { id: 'a', start: T, end: T + 30 * H },
      { id: 'b', start: T + 30 * H, end: T + 60 * H },
    ];
    const stats = eventStatistics(rows, periods);
    expect(stats.periods['a']?.events).toBe(1);
    expect(stats.periods['b']?.events).toBe(1);
    expect(stats.crossingBoundary).toBe(1);
    expect(stats.all.shares.TIMEOUT).toBe(1);
  });

  it('splits months at their first mark and puts a trade in the month its exit closes in', () => {
    const m = Date.UTC(2025, 1, 1);
    const marks = [m - 2 * H, m - H, m, m + H].map((time, i) => ({ time, equity: 40 + i }));
    const rows = monthlyOf(marks, [{ exitTime: m, netPnl: 1.5 } as never]);
    expect(rows.map((r) => [r.month, r.startEquity, r.endEquity, r.tradesExited])).toEqual([
      ['2025-01', 40, 42, 1],
      ['2025-02', 42, 43, 0],
    ]);
  });

  it('reaches each verdict only by its predeclared rule', () => {
    const w = (netReturn: number, executedTrades = 40) =>
      ({ status: 'COMPLETE', executedTrades, performance: { netReturn } }) as const;
    const failed = { status: 'INTEGRITY_FAILURE', executedTrades: 0, performance: null } as const;
    expect(conclude(w(0.1), [w(0.1), w(0.1), failed]).verdict).toBe('INTEGRITY_FAILURE');
    expect(conclude(w(0.1), [w(0.1), w(0.1, 29), w(0.1)]).verdict).toBe('INCONCLUSIVE');
    expect(conclude(w(0.1), [w(0.1), w(0.1), w(0.1)])).toMatchObject({
      verdict: 'JUSTIFIES_INDEPENDENT_VALIDATION',
      consistency: 'CONSISTENT_POSITIVE',
    });
    expect(conclude(w(0.1), [w(0.1), w(-0.1), w(0.1)]).verdict).toBe('INCONCLUSIVE');
    expect(conclude(w(0), [w(0.1), w(0), w(-0.1)])).toMatchObject({
      verdict: 'STOP_THIS_DESIGN',
      madeMoney: false,
      consistency: 'MIXED',
    });
    expect(conclude(w(-0.1), [w(-0.1), w(-0.2), w(-0.3)]).consistency).toBe('CONSISTENT_NEGATIVE');
    expect(conclude(w(-0.1), [w(0.1), w(0.1), w(-0.3)]).verdict).toBe('INCONCLUSIVE');
  });

  it('values a buy-and-hold reference with the same fills and refuses a gap in it', () => {
    const candles = flat(30);
    candles.set(START, bar(START, 100, 102.5, 99.5, 102));
    const window = { id: 'r', start: START, end: START + 30 * H };
    const ref = buyAndHold('X', indexOf(candles), window);
    const q = fill(44, 100, 100, 'TIMEOUT').quantity;
    expect(ref.performance?.endingEquity).toBeCloseTo(fill(44, 100, 100, 'TIMEOUT').proceeds, 12);
    expect(ref.performance?.endingEquity).toBeCloseTo(liquidationValue(q, 100), 12);
    candles.delete(START + 10 * H);
    expect(buyAndHold('X', indexOf(candles), window)).toMatchObject({
      status: 'INTEGRITY_FAILURE',
      performance: null,
    });
  });

  it('mirrors the specification: v1 members, boundaries, decision start and references', () => {
    expect(SPEC.data.universe).toContain(
      PROTOCOL.universe.members.map((s) => s.replace('USDT', '')).join(', '),
    );
    expect(SPEC.wallets.periods.map((p) => p.end).slice(0, 2)).toEqual(PROTOCOL.splits.boundaries);
    expect(SPEC.timing.firstDecision).toBe(PROTOCOL.decisions.firstDecision);
    expect(SPEC.timing.lastCandleClose).toBe(PROTOCOL.data.collectionCutoff);
    for (const s of REFERENCE_SYMBOLS) expect(SPEC.metrics.references.buyAndHold).toContain(s);
  });
});

describe('end to end on a synthetic 20-pair market', () => {
  const symbols = Array.from({ length: 20 }, (_, i) => `P${String(i).padStart(2, '0')}USDT`);
  symbols[0] = 'BTCUSDT';
  symbols[1] = 'ETHUSDT';
  const hours = 200 + 24 * 75;
  const candles = Object.fromEntries(symbols.map((s, i) => [s, randomWalk(1000 + i, hours)]));
  const spec = structuredClone(SPEC) as Spec;
  const at = (h: number) => iso(START + h * H);
  spec.timing.firstDecision = at(200);
  spec.timing.lastCandleClose = at(hours);
  spec.wallets.full = { ...spec.wallets.full, start: at(200), end: at(hours) };
  spec.wallets.periods = [
    { id: 'train', start: at(200), end: at(200 + 24 * 30) },
    { id: 'validation', start: at(200 + 24 * 30), end: at(200 + 24 * 50) },
    { id: 'test', start: at(200 + 24 * 50), end: at(hours) },
  ];
  const results = channelBreakoutStudy(candles, symbols, spec);
  const wallets = Object.values(results.wallets);

  it('reconciles every wallet: signals, cash, costs, months and pairs', () => {
    for (const { strategy } of wallets) {
      const p = strategy.performance!;
      const skipped = Object.values(strategy.skipped).reduce((a, b) => a + b, 0);
      expect(strategy.signals).toBe(strategy.executedTrades + skipped);
      expect(p.endingEquity).toBeCloseTo(44 + p.concentration.totalNetPnl, 9);
      expect(p.grossPnl - p.fees - p.slippage).toBeCloseTo(p.netPnl, 9);
      const compounded = p.monthly.reduce((acc, r) => acc * (1 + r.return), 1);
      expect(compounded).toBeCloseTo(p.endingEquity / 44, 9);
      const byPair = p.concentration.byPair.reduce((a, r) => a + r.netPnl, 0);
      expect(byPair).toBeCloseTo(p.netPnl, 9);
    }
    expect(results.wallets.full.strategy.executedTrades).toBeGreaterThan(30);
  });

  it('keeps each period wallet inside its window and identical to the full wallet until then', () => {
    const run = (w: { start: string; end: string }) => ({
      start: Date.parse(w.start),
      end: Date.parse(w.end),
    });
    const train = run(spec.wallets.periods[0]!);
    const indexes = Object.fromEntries(symbols.map((s) => [s, indexHourly(candles[s]!, FAR)]));
    const events = byTime(
      symbols.flatMap(
        (s) => pairEvents(s, indexes[s]!, train.start, run(spec.wallets.full).end, spec).events,
      ),
    );
    const sim = (w: { start: number; end: number }): WalletRun =>
      simulateWallet({ id: 'x', ...w }, events, indexes, spec);
    const full = sim(run(spec.wallets.full));
    const trainRun = sim(train);
    expect(trainRun.trades.length).toBeGreaterThan(0);
    for (const t of trainRun.trades) expect(t.exitTime).toBeLessThanOrEqual(train.end);
    expect(trainRun.trades).toEqual(full.trades.filter((t) => t.entryTime + 24 * H <= train.end));
    for (let i = 1; i < full.trades.length; i += 1) {
      expect(full.trades[i]!.entryTime).toBeGreaterThanOrEqual(full.trades[i - 1]!.exitTime);
    }
    for (const t of full.trades) {
      expect(t.spend).toBeLessThanOrEqual(0.95 * t.equityBefore + 1e-12);
      expect(-fill(t.spend, t.entry, t.stop, 'STOP').netPnl).toBeLessThanOrEqual(
        0.01 * t.equityBefore + 1e-12,
      );
    }
  });

  it('describes all events apart from the wallet and labels the sizing honestly', () => {
    const { events } = results;
    const inPeriods = Object.values(events.periods).reduce((a, p) => a + p.events, 0);
    expect(inPeriods + events.crossingBoundary).toBe(events.all.events);
    expect(events.all.events).toBeGreaterThan(results.wallets.full.strategy.executedTrades);
    expect(results.execution).toBe('EXECUTION_UNVERIFIED');
    expect(results.wallets.full.references.buyAndHold.map((r) => r.status)).toEqual([
      'COMPLETE',
      'COMPLETE',
    ]);
  });
});

describe('the runner', () => {
  const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('refuses to run while a tracked file differs from the commit', async () => {
    const dirty: Git = async (...args) => (args[0] === 'status' ? ' M scripts/x.ts' : 'abc');
    await expect(breakoutIdentity(dirty)).rejects.toThrow('commit before running');
  });

  it('verifies every input, writes once and never overwrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'breakout-'));
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'klines'), { recursive: true });
    const candleFiles: Record<string, { sha256: string; candles: number; retrievedAt: string }> =
      {};
    for (const symbol of PROTOCOL.universe.members) {
      const text = JSON.stringify({ symbol, candles: [flatBar(START)] });
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

    const first = await runChannelBreakout(dataDir, out, identity, recorded);
    expect(first.status).toBe('CREATED');
    expect(sha256(await readFile(first.path))).toBe(first.contentSha256);
    expect((await runChannelBreakout(dataDir, out, identity, recorded)).status).toBe('UNCHANGED');
    const other = async () => ({ codeCommit: 'd', codeBlobs: {} });
    expect((await runChannelBreakout(dataDir, out, other, recorded)).status).toBe('CONFLICT');

    await writeFile(
      join(dataDir, 'klines', 'BTCUSDT-1h.json'),
      '{"symbol":"BTCUSDT","candles":[]}',
    );
    await expect(runChannelBreakout(dataDir, out, identity, recorded)).rejects.toThrow(
      'differs from the manifest',
    );
    await expect(
      runChannelBreakout(dataDir, out, identity, { ...recorded, sha256: 'x' }),
    ).rejects.toThrow('is not x');
  });
});
