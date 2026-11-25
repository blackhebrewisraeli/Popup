/**
 * One fixed 24-hour channel-breakout design on protocol v1's saved candles
 * (docs/spot-24h-channel-breakout.json, docs/SPOT_24H_CHANNEL_BREAKOUT.md). Pure functions: breakout
 * events from candles closed by each decision time, each event's outcome on its own (set A), a
 * chronological one-position wallet (set B), buy-and-hold references and the specification's
 * verdict. Development research only: no network, account, order or production store.
 */
import { createHash } from 'node:crypto';
import specJson from '../docs/spot-24h-channel-breakout.json';
import { atr } from '@/lib/indicators';
import { stableSerialize } from '@/lib/stableSerialize';
import {
  consecutive,
  dayOf,
  HOUR_MS,
  indexHourly,
  quantile,
  resolveOutcome,
  type Category,
  type HourCandle,
  type HourlyIndex,
} from './spot24h';

export const SPEC = specJson;
export type Spec = typeof specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');

/** metrics.references.buyAndHold */
export const REFERENCE_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
const ms = (iso: string) => Date.parse(iso);
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: readonly number[]) => (values.length ? sum(values) / values.length : null);
const byText = (a: string, b: string) => (a < b ? -1 : Number(a > b));

// ---------------------------------------------------------------------------------------------
// Signal: at decision time T, from candles opening at or before T - 1h

export interface BreakoutEvent {
  symbol: string;
  /** Close of the signal candle t and open of the entry candle. */
  time: number;
  close: number;
  channelHigh: number;
  atr: number;
  /** (close - channelHigh) / ATR14: only to choose between simultaneous events. */
  strength: number;
}

export interface SignalCoverage {
  hours: number;
  unavailable: number;
  events: number;
}

function highest(index: HourlyIndex, firstOpen: number, count: number): number {
  let high = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < count; k += 1) {
    high = Math.max(high, index.valid.get(firstOpen + k * HOUR_MS)?.high ?? Number.NaN);
  }
  return high;
}

/**
 * signal: every decision time in [from, to) whose 200 closed candles are valid and consecutive,
 * with a breakout at t and none at t - 1, each against its own preceding 24 highs.
 */
export function pairEvents(
  symbol: string,
  index: HourlyIndex,
  from: number,
  to: number,
  spec: Spec = SPEC,
): { events: BreakoutEvent[]; coverage: SignalCoverage } {
  const { inputWindowCandles: n, channelCandles: c, atrPeriod } = spec.signal;
  const coverage: SignalCoverage = { hours: 0, unavailable: 0, events: 0 };
  const events: BreakoutEvent[] = [];
  // Valid candles in a row ending at the candle before `time`'s signal candle.
  let run = 0;
  for (let open = from - n * HOUR_MS; open < from - HOUR_MS; open += HOUR_MS) {
    run = index.valid.has(open) ? run + 1 : 0;
  }
  for (let time = from; time < to; time += HOUR_MS) {
    const t = time - HOUR_MS;
    run = index.valid.has(t) ? run + 1 : 0;
    coverage.hours += 1;
    if (run < n) {
      coverage.unavailable += 1;
      continue;
    }
    const close = index.valid.get(t)?.close ?? Number.NaN;
    const previousClose = index.valid.get(t - HOUR_MS)?.close ?? Number.NaN;
    const channelHigh = highest(index, t - c * HOUR_MS, c);
    const previousChannelHigh = highest(index, t - (c + 1) * HOUR_MS, c);
    // Strict: equal prices are not a breakout.
    if (!(close > channelHigh) || previousClose > previousChannelHigh) continue;
    const window = consecutive(index, time - n * HOUR_MS, n) ?? [];
    const a = atr(
      window.map((x) => x.high),
      window.map((x) => x.low),
      window.map((x) => x.close),
      atrPeriod,
    ).at(-1);
    if (a === undefined || !Number.isFinite(a) || a <= 0) {
      coverage.unavailable += 1;
      continue;
    }
    events.push({ symbol, time, close, channelHigh, atr: a, strength: (close - channelHigh) / a });
    coverage.events += 1;
  }
  return { events, coverage };
}

/** portfolio.selection: the largest strength, then symbol ascending. */
export const compareEvents = (a: BreakoutEvent, b: BreakoutEvent) =>
  b.strength - a.strength || byText(a.symbol, b.symbol);

// ---------------------------------------------------------------------------------------------
// One trade: levels, v1's scan one candle at a time, and the cost accounting

export const levels = (entry: number, atrValue: number, spec: Spec = SPEC) => ({
  stop: entry - spec.trade.stopAtrMultiple * atrValue,
  target: entry + spec.trade.targetAtrMultiple * atrValue,
});

export type Scan =
  | { status: 'EXITED'; category: Category; exit: number; candles: HourCandle[]; gapStop: boolean }
  | { status: 'MISSING'; missingOpen: number; candles: HourCandle[] };

/** trade.scan: nothing after the exit candle is read, and a missing candle before it is reported. */
export function scanTrade(
  index: HourlyIndex,
  time: number,
  stop: number,
  target: number,
  holding: number = SPEC.trade.holdingCandles,
): Scan {
  const candles: HourCandle[] = [];
  for (let k = 0; k < holding; k += 1) {
    const candle = index.valid.get(time + k * HOUR_MS);
    if (!candle) return { status: 'MISSING', missingOpen: time + k * HOUR_MS, candles };
    candles.push(candle);
    const { category, exit } = resolveOutcome([candle], target, stop);
    if (category !== 'TIMEOUT') {
      const gapStop = category === 'STOP' && candle.open <= stop;
      return { status: 'EXITED', category, exit, candles, gapStop };
    }
  }
  const last = candles.at(-1);
  if (!last) throw new Error('A trade needs at least one holding candle');
  return { status: 'EXITED', category: 'TIMEOUT', exit: last.close, candles, gapStop: false };
}

/** costs.accounting: spend S at reference O, exit at reference X. */
export function fill(
  spend: number,
  entry: number,
  exit: number,
  category: Category,
  spec: Spec = SPEC,
) {
  const { feePerFill: fee, slippagePerMarketFill: slip } = spec.costs;
  const exitSlip = category === 'TARGET' ? 0 : slip;
  const quantity = (spend * (1 - fee)) / (entry * (1 + slip));
  const exitValue = quantity * exit * (1 - exitSlip);
  const proceeds = exitValue * (1 - fee);
  return {
    quantity,
    exitValue,
    proceeds,
    netPnl: proceeds - spend,
    grossPnl: quantity * (exit - entry),
    fees: spend * fee + exitValue * fee,
    slippage: quantity * entry * slip + quantity * exit * exitSlip,
  };
}

/** costs.markToMarket */
export const liquidationValue = (quantity: number, close: number, spec: Spec = SPEC) =>
  quantity * close * (1 - spec.costs.slippagePerMarketFill) * (1 - spec.costs.feePerFill);

/** Loss per USDT spent if the stop fills exactly at the stop, with its slippage and both fees. */
export const plannedLossFraction = (entry: number, stop: number, spec: Spec = SPEC) =>
  -fill(1, entry, stop, 'STOP', spec).netPnl;

// ---------------------------------------------------------------------------------------------
// Set A: every event's outcome on its own

export type EventStatus = 'COMPLETE' | 'OUTCOME_MISSING' | 'INVALID_LEVELS';

export interface EventRow {
  symbol: string;
  time: number;
  day: number;
  status: EventStatus;
  category: Category | null;
  candles: number | null;
  gapStop: boolean;
  gross: number | null;
  net: number | null;
}

export function eventOutcome(index: HourlyIndex, event: BreakoutEvent, spec: Spec = SPEC) {
  const base = { symbol: event.symbol, time: event.time, day: dayOf(event.time) };
  const none = { category: null, candles: null, gapStop: false, gross: null, net: null };
  const entry = index.valid.get(event.time)?.open;
  if (entry === undefined) return { ...base, ...none, status: 'OUTCOME_MISSING' } as EventRow;
  const { stop, target } = levels(entry, event.atr, spec);
  if (stop <= 0) return { ...base, ...none, status: 'INVALID_LEVELS' } as EventRow;
  const scan = scanTrade(index, event.time, stop, target, spec.trade.holdingCandles);
  if (scan.status === 'MISSING') return { ...base, ...none, status: 'OUTCOME_MISSING' } as EventRow;
  return {
    ...base,
    status: 'COMPLETE',
    category: scan.category,
    candles: scan.candles.length,
    gapStop: scan.gapStop,
    gross: scan.exit / entry - 1,
    net: fill(1, entry, scan.exit, scan.category, spec).netPnl,
  } as EventRow;
}

export interface Window {
  id: string;
  start: number;
  end: number;
}

const CATEGORY_KEYS: readonly Category[] = ['TARGET', 'STOP', 'TIMEOUT', 'AMBIGUOUS'];

/** events.reported for one group of rows. */
export function eventSummary(rows: readonly EventRow[]) {
  const complete = rows.filter((r) => r.status === 'COMPLETE');
  const counts = Object.fromEntries(
    CATEGORY_KEYS.map((c) => [c, complete.filter((r) => r.category === c).length]),
  ) as Record<Category, number>;
  const byPair: Record<string, number> = {};
  for (const row of rows) byPair[row.symbol] = (byPair[row.symbol] ?? 0) + 1;
  return {
    events: rows.length,
    outcomeMissing: rows.filter((r) => r.status === 'OUTCOME_MISSING').length,
    invalidLevels: rows.filter((r) => r.status === 'INVALID_LEVELS').length,
    complete: complete.length,
    days: new Set(rows.map((r) => r.day)).size,
    byPair,
    counts,
    shares: Object.fromEntries(
      CATEGORY_KEYS.map((c) => [c, complete.length ? counts[c] / complete.length : null]),
    ) as Record<Category, number | null>,
    gapStops: complete.filter((r) => r.gapStop).length,
    meanHoldingCandles: mean(complete.map((r) => r.candles ?? 0)),
    meanGross: mean(complete.map((r) => r.gross ?? 0)),
    meanNet: mean(complete.map((r) => r.net ?? 0)),
  };
}

/** events.periods: a period holds an event whose 24 holding candles lie inside it. */
export function eventStatistics(
  rows: readonly EventRow[],
  periods: readonly Window[],
  spec: Spec = SPEC,
) {
  const horizon = spec.trade.holdingCandles * HOUR_MS;
  const periodOf = (time: number) =>
    periods.find((p) => time >= p.start && time + horizon <= p.end)?.id ?? null;
  return {
    all: eventSummary(rows),
    crossingBoundary: rows.filter((r) => periodOf(r.time) === null).length,
    periods: Object.fromEntries(
      periods.map((p) => [p.id, eventSummary(rows.filter((r) => periodOf(r.time) === p.id))]),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Set B: one chronological wallet with one slot

export type SkipReason =
  'BOUNDARY' | 'POSITION_OPEN' | 'NOT_SELECTED' | 'INSUFFICIENT_CASH' | 'INVALID_LEVELS';
export const SKIP_REASONS: readonly SkipReason[] = [
  'BOUNDARY',
  'POSITION_OPEN',
  'NOT_SELECTED',
  'INSUFFICIENT_CASH',
  'INVALID_LEVELS',
];

export interface Trade {
  symbol: string;
  entryTime: number;
  exitTime: number;
  strength: number;
  atr: number;
  entry: number;
  stop: number;
  target: number;
  category: Category;
  exit: number;
  holdingCandles: number;
  gapStop: boolean;
  equityBefore: number;
  plannedLossFraction: number;
  spend: number;
  quantity: number;
  exitValue: number;
  proceeds: number;
  netPnl: number;
  netReturn: number;
  grossPnl: number;
  fees: number;
  slippage: number;
}

export interface Mark {
  time: number;
  equity: number;
}

export interface WalletRun {
  window: Window;
  status: 'COMPLETE' | 'INTEGRITY_FAILURE';
  failure: { symbol: string; entryTime: number; missingOpen: number } | null;
  signals: number;
  skipped: Record<SkipReason, number>;
  trades: Trade[];
  /** Equity at every hour close from start to end; incomplete after an integrity failure. */
  marks: Mark[];
  endingEquity: number | null;
}

/**
 * portfolio and wallets: hour by hour from start, enter only when the slot is free and the
 * holding window ends by `end`, choose among simultaneous events by strength alone, and size from
 * the stop. A trade is resolved when entered, but nothing after the entry candle's open decides
 * whether or how much to enter: the slot is busy until the exit candle closes, as it was in time.
 */
export function simulateWallet(
  window: Window,
  eventsByTime: ReadonlyMap<number, readonly BreakoutEvent[]>,
  indexes: Readonly<Record<string, HourlyIndex>>,
  spec: Spec = SPEC,
): WalletRun {
  const { start, end } = window;
  const { initialCash, riskFraction, maxSpendFraction } = spec.portfolio;
  const horizon = spec.trade.holdingCandles * HOUR_MS;
  const run: WalletRun = {
    window,
    status: 'COMPLETE',
    failure: null,
    signals: 0,
    skipped: Object.fromEntries(SKIP_REASONS.map((r) => [r, 0])) as Record<SkipReason, number>,
    trades: [],
    marks: [],
    endingEquity: null,
  };
  let cash = initialCash;
  let freeAt = start;
  let held = new Map<number, number>();
  const equityAt = (time: number) => (time < freeAt ? (held.get(time) ?? Number.NaN) : cash);

  for (let time = start; time < end; time += HOUR_MS) {
    run.marks.push({ time, equity: equityAt(time) });
    const events = eventsByTime.get(time) ?? [];
    run.signals += events.length;
    if (events.length === 0) continue;
    if (time + horizon > end) {
      run.skipped.BOUNDARY += events.length;
      continue;
    }
    if (time < freeAt) {
      run.skipped.POSITION_OPEN += events.length;
      continue;
    }
    const [chosen, ...others] = [...events].sort(compareEvents);
    run.skipped.NOT_SELECTED += others.length;
    if (!chosen) continue;
    const index = indexes[chosen.symbol];
    const entryCandle = index?.valid.get(time);
    if (!index || !entryCandle) {
      run.status = 'INTEGRITY_FAILURE';
      run.failure = { symbol: chosen.symbol, entryTime: time, missingOpen: time };
      return run;
    }
    const entry = entryCandle.open;
    const { stop, target } = levels(entry, chosen.atr, spec);
    if (stop <= 0) {
      run.skipped.INVALID_LEVELS += 1;
      continue;
    }
    const lossFraction = plannedLossFraction(entry, stop, spec);
    // Flat at every entry, so equity is cash.
    const spend = Math.min((riskFraction * cash) / lossFraction, maxSpendFraction * cash);
    if (!(spend > 0 && Number.isFinite(spend))) {
      run.skipped.INSUFFICIENT_CASH += 1;
      continue;
    }
    const scan = scanTrade(index, time, stop, target, spec.trade.holdingCandles);
    if (scan.status === 'MISSING') {
      run.status = 'INTEGRITY_FAILURE';
      run.failure = { symbol: chosen.symbol, entryTime: time, missingOpen: scan.missingOpen };
      return run;
    }
    const f = fill(spend, entry, scan.exit, scan.category, spec);
    const rest = cash - spend;
    const exitTime = time + scan.candles.length * HOUR_MS;
    held = new Map(
      scan.candles.map((c, k) => [
        time + (k + 1) * HOUR_MS,
        rest + liquidationValue(f.quantity, c.close, spec),
      ]),
    );
    held.set(exitTime, rest + f.proceeds);
    run.trades.push({
      symbol: chosen.symbol,
      entryTime: time,
      exitTime,
      strength: chosen.strength,
      atr: chosen.atr,
      entry,
      stop,
      target,
      category: scan.category,
      exit: scan.exit,
      holdingCandles: scan.candles.length,
      gapStop: scan.gapStop,
      equityBefore: cash,
      plannedLossFraction: lossFraction,
      spend,
      quantity: f.quantity,
      exitValue: f.exitValue,
      proceeds: f.proceeds,
      netPnl: f.netPnl,
      netReturn: f.proceeds / spend - 1,
      grossPnl: f.grossPnl,
      fees: f.fees,
      slippage: f.slippage,
    });
    cash = rest + f.proceeds;
    freeAt = exitTime;
  }
  run.marks.push({ time: end, equity: equityAt(end) });
  run.endingEquity = cash;
  return run;
}

// ---------------------------------------------------------------------------------------------
// Wallet metrics

export function drawdownOf(marks: readonly Mark[]) {
  let peak = Number.NEGATIVE_INFINITY;
  let peakTime: number | null = null;
  const worst = {
    fraction: 0,
    usdt: 0,
    peakTime: null as number | null,
    troughTime: null as number | null,
  };
  for (const { time, equity } of marks) {
    if (equity > peak) {
      peak = equity;
      peakTime = time;
    }
    const drop = peak - equity;
    worst.usdt = Math.max(worst.usdt, drop);
    if (drop / peak > worst.fraction) {
      worst.fraction = drop / peak;
      worst.peakTime = peakTime;
      worst.troughTime = time;
    }
  }
  return worst;
}

export const monthOf = (time: number) => new Date(time).toISOString().slice(0, 7);

/** metrics.monthly: a trade belongs to the month its exit candle closes in. */
export function monthlyOf(marks: readonly Mark[], trades: readonly Trade[]) {
  const rows: {
    month: string;
    startEquity: number;
    endEquity: number;
    return: number;
    tradesExited: number;
    netPnl: number;
  }[] = [];
  marks.forEach(({ time, equity }, i) => {
    const current = rows.at(-1);
    const month = monthOf(time);
    if (current && (month !== current.month || i === marks.length - 1)) {
      current.endEquity = equity;
      current.return = equity / current.startEquity - 1;
    }
    if (month !== current?.month && i < marks.length - 1) {
      rows.push({
        month,
        startEquity: equity,
        endEquity: equity,
        return: 0,
        tradesExited: 0,
        netPnl: 0,
      });
    }
  });
  for (const trade of trades) {
    const row = rows.find((r) => r.month === monthOf(trade.exitTime - 1));
    if (row) {
      row.tradesExited += 1;
      row.netPnl += trade.netPnl;
    }
  }
  return rows;
}

function longestLosingRun(trades: readonly Trade[]): number {
  let longest = 0;
  let current = 0;
  for (const trade of trades) {
    current = trade.netPnl > 0 ? 0 : current + 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

export function concentrationOf(trades: readonly Trade[]) {
  const total = sum(trades.map((t) => t.netPnl));
  const pairs = new Map<string, { trades: number; netPnl: number }>();
  for (const t of trades) {
    const pair = pairs.get(t.symbol) ?? { trades: 0, netPnl: 0 };
    pair.trades += 1;
    pair.netPnl += t.netPnl;
    pairs.set(t.symbol, pair);
  }
  const winners = trades
    .filter((t) => t.netPnl > 0)
    .map((t) => t.netPnl)
    .sort((a, b) => b - a);
  return {
    totalNetPnl: total,
    byPair: [...pairs.entries()]
      .map(([symbol, p]) => ({ symbol, ...p }))
      .sort((a, b) => b.netPnl - a.netPnl || byText(a.symbol, b.symbol)),
    largestWinners: [1, 5, 10].map((n) => {
      const top = sum(winners.slice(0, n));
      return { count: n, netPnl: top, totalWithout: total - top };
    }),
  };
}

/** Boundaries strictly inside (entry, exit): a trade the full wallet held across a period edge. */
export const crossesBoundary = (trade: Trade, boundaries: readonly number[]) =>
  boundaries.some((b) => trade.entryTime < b && b < trade.exitTime);

export function walletMetrics(
  run: WalletRun,
  spec: Spec = SPEC,
  boundaries: readonly number[] = [],
) {
  const base = {
    window: { id: run.window.id, start: iso(run.window.start), end: iso(run.window.end) },
    status: run.status,
    failure: run.failure && {
      symbol: run.failure.symbol,
      entryTime: iso(run.failure.entryTime),
      missingOpen: iso(run.failure.missingOpen),
    },
    signals: run.signals,
    skipped: run.skipped,
    executedTrades: run.trades.length,
  };
  if (run.status !== 'COMPLETE' || run.endingEquity === null) return { ...base, performance: null };
  const initial = spec.portfolio.initialCash;
  const { trades } = run;
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl <= 0);
  const winSum = sum(wins.map((t) => t.netPnl));
  const lossSum = sum(losses.map((t) => t.netPnl));
  const gross = sum(trades.map((t) => t.grossPnl));
  const spends = trades.map((t) => t.spend);
  const held = sum(trades.map((t) => t.exitTime - t.entryTime));
  const turnover = sum(trades.map((t) => t.spend + t.exitValue));
  return {
    ...base,
    performance: {
      initialEquity: initial,
      endingEquity: run.endingEquity,
      netPnl: run.endingEquity - initial,
      netReturn: run.endingEquity / initial - 1,
      grossPnl: gross,
      grossReturn: gross / initial,
      fees: sum(trades.map((t) => t.fees)),
      slippage: sum(trades.map((t) => t.slippage)),
      maxDrawdown: drawdownOf(run.marks),
      counts: {
        ...Object.fromEntries(
          CATEGORY_KEYS.map((c) => [c, trades.filter((t) => t.category === c).length]),
        ),
        gapStops: trades.filter((t) => t.gapStop).length,
      } as Record<Category | 'gapStops', number>,
      winRate: trades.length ? wins.length / trades.length : null,
      meanWin: mean(wins.map((t) => t.netPnl)),
      meanLoss: mean(losses.map((t) => t.netPnl)),
      meanWinReturn: mean(wins.map((t) => t.netReturn)),
      meanLossReturn: mean(losses.map((t) => t.netReturn)),
      meanNetPnl: mean(trades.map((t) => t.netPnl)),
      meanNetReturn: mean(trades.map((t) => t.netReturn)),
      profitFactor: lossSum < 0 ? winSum / -lossSum : null,
      exposure: held / (run.window.end - run.window.start),
      turnover: { usdt: turnover, multipleOfInitial: turnover / initial },
      longestLosingRun: longestLosingRun(trades),
      spend: spends.length
        ? {
            min: Math.min(...spends),
            median: quantile(spends, 0.5),
            max: Math.max(...spends),
          }
        : null,
      crossingBoundaries: trades.filter((t) => crossesBoundary(t, boundaries)).length,
      monthly: monthlyOf(run.marks, trades),
      concentration: concentrationOf(trades),
    },
  };
}

export type WalletMetrics = ReturnType<typeof walletMetrics>;
const iso = (time: number) => new Date(time).toISOString();

// ---------------------------------------------------------------------------------------------
// References

/** metrics.references.buyAndHold: all of the wallet in at the start's open, out at end's close. */
export function buyAndHold(symbol: string, index: HourlyIndex, window: Window, spec: Spec = SPEC) {
  const initial = spec.portfolio.initialCash;
  const marks: Mark[] = [{ time: window.start, equity: initial }];
  let quantity = 0;
  let entry = Number.NaN;
  let exit = Number.NaN;
  for (let open = window.start; open < window.end; open += HOUR_MS) {
    const candle = index.valid.get(open);
    if (!candle) {
      return {
        symbol,
        status: 'INTEGRITY_FAILURE' as const,
        missingOpen: iso(open),
        performance: null,
      };
    }
    if (open === window.start) {
      entry = candle.open;
      quantity = fill(initial, entry, entry, 'TIMEOUT', spec).quantity;
    }
    exit = candle.close;
    marks.push({ time: open + HOUR_MS, equity: liquidationValue(quantity, candle.close, spec) });
  }
  const endingEquity = marks.at(-1)?.equity ?? initial;
  return {
    symbol,
    status: 'COMPLETE' as const,
    missingOpen: null,
    performance: {
      entry,
      exit,
      endingEquity,
      netReturn: endingEquity / initial - 1,
      maxDrawdown: drawdownOf(marks),
      monthly: monthlyOf(marks, []),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Conclusion

export type Consistency = 'CONSISTENT_POSITIVE' | 'CONSISTENT_NEGATIVE' | 'MIXED';
export type Verdict =
  'INTEGRITY_FAILURE' | 'INCONCLUSIVE' | 'JUSTIFIES_INDEPENDENT_VALIDATION' | 'STOP_THIS_DESIGN';

type Summary = Pick<WalletMetrics, 'status' | 'executedTrades'> & {
  performance: { netReturn: number } | null;
};

/** conclusion.verdicts, first match wins. */
export function conclude(full: Summary, periods: readonly Summary[], spec: Spec = SPEC) {
  const wallets = [full, ...periods];
  if (wallets.some((w) => w.status !== 'COMPLETE' || !w.performance)) {
    return {
      verdict: 'INTEGRITY_FAILURE' as Verdict,
      madeMoney: null,
      consistency: null,
      reasons: ['A wallet stopped on missing data'],
    };
  }
  const net = (w: Summary) => w.performance?.netReturn ?? Number.NaN;
  const positive = periods.filter((p) => net(p) > 0).length;
  let consistency: Consistency = 'MIXED';
  if (positive === periods.length) consistency = 'CONSISTENT_POSITIVE';
  else if (positive === 0) consistency = 'CONSISTENT_NEGATIVE';
  const madeMoney = net(full) > 0;
  const minimum = spec.conclusion.minimumTradesPerPeriod;
  const thin = periods.filter((p) => p.executedTrades < minimum).length;
  let verdict: Verdict = 'INCONCLUSIVE';
  let reason: string;
  if (thin > 0) {
    reason = `${thin} period wallet(s) executed fewer than ${minimum} trades`;
  } else if (madeMoney && consistency === 'CONSISTENT_POSITIVE') {
    verdict = 'JUSTIFIES_INDEPENDENT_VALIDATION';
    reason = 'The full wallet and every period wallet gained after modelled costs';
  } else if (!madeMoney && positive <= 1) {
    verdict = 'STOP_THIS_DESIGN';
    reason = `The full wallet lost after modelled costs and ${positive} of ${periods.length} period wallets gained`;
  } else {
    reason = `Full wallet ${madeMoney ? 'gained' : 'lost'}; ${positive} of ${periods.length} period wallets gained`;
  }
  return { verdict, madeMoney, consistency, reasons: [reason] };
}

// ---------------------------------------------------------------------------------------------
// The study

export const walletsOf = (spec: Spec = SPEC) => {
  const toWindow = (id: string, w: { start: string; end: string }): Window => ({
    id,
    start: ms(w.start),
    end: ms(w.end),
  });
  return {
    full: toWindow('full', spec.wallets.full),
    periods: spec.wallets.periods.map((p) => toWindow(p.id, p)),
  };
};

/** Everything the specification reports, from candles already verified against the manifest. */
export function channelBreakoutStudy(
  candles: Readonly<Record<string, readonly HourCandle[]>>,
  members: readonly string[],
  spec: Spec = SPEC,
) {
  const first = ms(spec.timing.firstDecision);
  const lastClose = ms(spec.timing.lastCandleClose);
  const horizon = spec.trade.holdingCandles * HOUR_MS;
  const { full, periods } = walletsOf(spec);
  const indexes: Record<string, HourlyIndex> = {};
  const signals: Record<string, SignalCoverage & { candleIssues: number }> = {};
  const eventsByTime = new Map<number, BreakoutEvent[]>();
  const all: BreakoutEvent[] = [];
  for (const symbol of members) {
    const index = indexHourly(candles[symbol] ?? [], lastClose);
    indexes[symbol] = index;
    const { events, coverage } = pairEvents(symbol, index, first, lastClose, spec);
    signals[symbol] = { ...coverage, candleIssues: index.issues.length };
    for (const event of events) {
      all.push(event);
      eventsByTime.set(event.time, [...(eventsByTime.get(event.time) ?? []), event]);
    }
  }
  const inData = all.filter((e) => e.time + horizon <= lastClose);
  const rows = inData.map((e) => eventOutcome(indexes[e.symbol] as HourlyIndex, e, spec));
  const boundaries = periods.map((p) => p.start).filter((b) => b > full.start);
  const wallet = (w: Window, edges: readonly number[] = []) => ({
    strategy: walletMetrics(simulateWallet(w, eventsByTime, indexes, spec), spec, edges),
    references: {
      cash: { endingEquity: spec.portfolio.initialCash, netReturn: 0 },
      buyAndHold: REFERENCE_SYMBOLS.map((s) =>
        buyAndHold(s, indexes[s] ?? indexHourly([], lastClose), w, spec),
      ),
    },
  });
  const fullWallet = wallet(full, boundaries);
  const periodWallets = periods.map((p) => wallet(p));
  return {
    specification: { id: spec.specificationId, sha256: specSha256(spec) },
    sizingModel: 'IDEAL_FRACTIONAL',
    execution: 'EXECUTION_UNVERIFIED',
    signals,
    events: {
      beyondData: all.length - inData.length,
      ...eventStatistics(rows, periods, spec),
    },
    wallets: {
      full: fullWallet,
      ...Object.fromEntries(periods.map((p, i) => [p.id, periodWallets[i]])),
    },
    conclusion: conclude(
      fullWallet.strategy,
      periodWallets.map((w) => w.strategy),
      spec,
    ),
  };
}

export type StudyResults = ReturnType<typeof channelBreakoutStudy>;
