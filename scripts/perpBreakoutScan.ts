/**
 * Read-only scan of Binance USDⓈ-M crypto perpetuals (docs/PERP_BREAKOUT_SCAN.md): the pure part.
 * Contract selection, the frozen two-close directional breakout rule and quote economics are
 * separate functions. evaluateScan composes them over one snapshot of public market data, so a live
 * run (perpBreakoutScanRun.ts) and the replay of its saved snapshot take the same path. No network,
 * clock or file access here. Prices are exact decimals (BigInt counts of 1e-18) from plan.ts.
 *
 * Research baseline only: the rule's historical performance after costs did not support live use.
 * Nothing here reads the owner's execution allowlist or places an order.
 */
import {
  dec,
  fmt,
  parseSymbolRules,
  signedDec,
} from '../supabase/functions/futures-execution/plan';

export const RULE = { id: 'two-close-directional-breakout-15m', version: '1.0.0' } as const;
export const INTERVAL_MS = 15 * 60_000;
/** Closed 15m candles before the first breakout candle that freeze the range. */
export const RANGE_CANDLES = 96;
/** The range, the first breakout candle and its immediate confirmation. */
export const CANDLES = RANGE_CANDLES + 2;
/** Fixed market basket: BTC's trend and the other four's agreement set the scan's direction. */
export const REFERENCE = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'] as const;
const MIN_EFFICIENCY = 0.3;
const MIN_AGREEING = 3;
const PER_HOUR = 4; // 15m candles
const TREND_HOURS = 12;
export const QUOTE_SOURCE = 'GET /fapi/v1/ticker/bookTicker';
export const MARK_SOURCE = 'GET /fapi/v1/premiumIndex';

const SCALE = 10n ** 18n;
const BP = SCALE / 10_000n;
const mul = (a: bigint, b: bigint) => (a * b) / SCALE;
const div = (a: bigint, b: bigint) => (a * SCALE) / b;
const bpsOf = (value: string) => (dec(value) as bigint) / 10_000n;
const iso = (ms: number) => new Date(ms).toISOString();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** Truncated to `places` decimals, for display only; decisions use the exact values. */
export const fixed = (value: bigint, places: number) => {
  const unit = 10n ** BigInt(18 - places);
  return fmt((value / unit) * unit);
};

// ---------------------------------------------------------------- settings

/** Research defaults, all overridable from the command line and recorded in every snapshot. */
export interface ScanSettings {
  minQuoteVolumeUsdt: string;
  maxSpreadBps: string;
  weightBudget: number;
  deadlineMs: number;
  concurrency: number;
  quoteWindowStartMs: number;
  quoteWindowEndMs: number;
  maxQuoteAgeMs: number;
  takerFeeBps: string;
  slippageBps: string;
  minNetRewardRisk: string;
}

export const DEFAULT_SETTINGS: ScanSettings = {
  minQuoteVolumeUsdt: '20000000',
  maxSpreadBps: '10',
  weightBudget: 1000,
  deadlineMs: 60_000,
  concurrency: 8,
  quoteWindowStartMs: 3 * 60_000,
  quoteWindowEndMs: 5 * 60_000,
  maxQuoteAgeMs: 15_000,
  takerFeeBps: '5',
  slippageBps: '5',
  minNetRewardRisk: '1.5',
};

/** Why these settings can't run, or null. */
export function settingsRefusal(s: ScanSettings): string | null {
  const decimals = [
    'minQuoteVolumeUsdt',
    'maxSpreadBps',
    'takerFeeBps',
    'slippageBps',
    'minNetRewardRisk',
  ] as const;
  const bad: string[] = decimals.filter((key) => dec(s[key]) === null);
  const ints = [
    'weightBudget',
    'deadlineMs',
    'concurrency',
    'quoteWindowStartMs',
    'quoteWindowEndMs',
    'maxQuoteAgeMs',
  ] as const;
  bad.push(...ints.filter((key) => !Number.isSafeInteger(s[key]) || s[key] < 0));
  if (bad.length > 0) return `Invalid settings: ${bad.join(', ')}`;
  if (s.concurrency < 1) return 'Invalid settings: concurrency';
  if (s.quoteWindowEndMs < s.quoteWindowStartMs) return 'Invalid settings: quote window';
  return null;
}

// ---------------------------------------------------------------- 1. contract selection

/** Exchange facts of one tradable crypto perpetual: its price grid. */
export interface Perpetual {
  symbol: string;
  tickSize: string;
  minPrice: string;
}

/** Why an exchangeInfo entry is not an active USDT-quoted, USDT-margined crypto perpetual, or null. */
function productRefusal(entry: Record<string, unknown>): string | null {
  if (entry['status'] !== 'TRADING') return `status ${String(entry['status'])}`;
  if (entry['contractType'] !== 'PERPETUAL')
    return `contract type ${String(entry['contractType'])}`;
  if (entry['quoteAsset'] !== 'USDT' || entry['marginAsset'] !== 'USDT')
    return 'not USDT-quoted and USDT-margined';
  if (entry['underlyingType'] !== 'COIN') return `underlying ${String(entry['underlyingType'])}`;
  return null;
}

/**
 * Active crypto perpetuals from exchangeInfo's symbols: TRADING, contract type PERPETUAL (not
 * TRADIFI_PERPETUAL or a quarterly), USDT quote and margin, underlying type COIN (not INDEX,
 * EQUITY, COMMODITY or PREMARKET), with readable filters. Excluded entries are counted by reason.
 */
export function cryptoPerpetuals(symbols: unknown[]): {
  perpetuals: Map<string, Perpetual>;
  excluded: Record<string, number>;
} {
  const perpetuals = new Map<string, Perpetual>();
  const excluded: Record<string, number> = {};
  for (const entry of symbols) {
    const symbol = isRecord(entry) && typeof entry['symbol'] === 'string' ? entry['symbol'] : '';
    const refusal = isRecord(entry) && symbol ? productRefusal(entry) : 'unreadable entry';
    const rules = refusal ? null : parseSymbolRules({ symbols: [entry] }, symbol);
    if (refusal || !rules || typeof rules === 'string') {
      const reason = refusal ?? 'filters unreadable';
      excluded[reason] = (excluded[reason] ?? 0) + 1;
      continue;
    }
    perpetuals.set(symbol, { symbol, tickSize: rules.tickSize, minPrice: rules.minPrice });
  }
  return { perpetuals, excluded };
}

export interface Eligible extends Perpetual {
  quoteVolume: string;
  bid: string;
  ask: string;
  spreadBps: string;
}

export interface Rejection {
  symbol: string;
  reason: string;
}

/** Spread as (ask − bid) ÷ midpoint, in basis points; exact to 1e-18. */
export const spreadBps = (bid: bigint, ask: bigint) => div((ask - bid) * 20_000n, ask + bid);

/** A readable, uncrossed bid and ask from one book ticker, or why not. */
export function readQuote(book: unknown): { bid: bigint; ask: bigint } | string {
  if (!isRecord(book)) return 'no bid/ask';
  const bid = dec(book['bidPrice']);
  const ask = dec(book['askPrice']);
  if (!bid || !ask) return 'bid/ask missing or invalid';
  if (ask < bid) return 'bid/ask crossed';
  return { bid, ask };
}

const bySymbol = (rows: unknown) =>
  new Map(
    (Array.isArray(rows) ? rows : [])
      .filter(
        (row): row is Record<string, unknown> => isRecord(row) && typeof row['symbol'] === 'string',
      )
      .map((row) => [row['symbol'] as string, row]),
  );

/** Why one perpetual fails the liquidity screen, or its screened facts. */
function screenOne(
  perp: Perpetual,
  ticker: Record<string, unknown> | undefined,
  book: Record<string, unknown> | undefined,
  minVolume: bigint,
  maxSpread: bigint,
  s: ScanSettings,
): Eligible | string {
  if (!ticker) return 'no 24h ticker';
  const volume = dec(ticker['quoteVolume']);
  if (volume === null) return '24h quote volume invalid';
  if (volume < minVolume) return `24h quote volume below ${s.minQuoteVolumeUsdt} USDT`;
  const quote = readQuote(book);
  if (typeof quote === 'string') return quote;
  const spread = spreadBps(quote.bid, quote.ask);
  if (spread > maxSpread) return `spread above ${s.maxSpreadBps} bps`;
  return {
    ...perp,
    quoteVolume: fmt(volume),
    bid: fmt(quote.bid),
    ask: fmt(quote.ask),
    spreadBps: fmt(spread),
  };
}

/** Descending 24h quote volume, then symbol. */
function byVolume(a: Eligible, b: Eligible): number {
  const difference = (dec(b.quoteVolume) as bigint) - (dec(a.quoteVolume) as bigint);
  if (difference !== 0n) return difference > 0n ? 1 : -1;
  return a.symbol.localeCompare(b.symbol);
}

/**
 * The liquidity screen on bulk 24h tickers and best bid/ask, before any candle is requested:
 * 24h quote volume at least the minimum and spread at most the maximum. Eligible contracts come
 * in descending 24h quote volume (then symbol), the order candles are requested in.
 */
export function screenUniverse(
  perpetuals: Map<string, Perpetual>,
  tickers24h: unknown,
  bookTickers: unknown,
  s: ScanSettings,
): { eligible: Eligible[]; rejected: Rejection[] } {
  const tickers = bySymbol(tickers24h);
  const books = bySymbol(bookTickers);
  const minVolume = dec(s.minQuoteVolumeUsdt) as bigint;
  const maxSpread = dec(s.maxSpreadBps) as bigint;
  const eligible: Eligible[] = [];
  const rejected: Rejection[] = [];
  for (const perp of perpetuals.values()) {
    const result = screenOne(
      perp,
      tickers.get(perp.symbol),
      books.get(perp.symbol),
      minVolume,
      maxSpread,
      s,
    );
    if (typeof result === 'string') rejected.push({ symbol: perp.symbol, reason: result });
    else eligible.push(result);
  }
  eligible.sort(byVolume);
  rejected.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { eligible, rejected };
}

// ---------------------------------------------------------------- 2. candles and the rule

export interface Candle {
  openTime: number;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
}

function parseCandle(row: unknown): Candle | null {
  if (!Array.isArray(row)) return null;
  const [openTime, o, h, l, c, , closeTime] = row as unknown[];
  const open = dec(o);
  const high = dec(h);
  const low = dec(l);
  const close = dec(c);
  if (!Number.isSafeInteger(openTime) || closeTime !== (openTime as number) + INTERVAL_MS - 1)
    return null;
  if (!open || !high || !low || !close) return null;
  const top = open > close ? open : close;
  const bottom = open < close ? open : close;
  if (low > bottom || high < top) return null;
  return { openTime: openTime as number, open, high, low, close };
}

/**
 * The CANDLES closed 15m candles ending at the common boundary, well formed and contiguous, or
 * why not: missing, invalid, stale (the last closed candle is not the boundary's), gapped, or
 * insufficient history (a contract listed less than CANDLES intervals ago).
 */
export function validCandles(rows: unknown, boundary: number): Candle[] | string {
  if (!Array.isArray(rows) || rows.length === 0) return 'candles missing';
  const candles = rows.map(parseCandle);
  if (candles.includes(null)) return 'candle row invalid';
  const valid = candles as Candle[];
  const last = (valid.at(-1) as Candle).openTime;
  const expectedLast = boundary - INTERVAL_MS;
  if (last < expectedLast)
    return `stale candles: last closed ${iso(last + INTERVAL_MS)}, expected ${iso(boundary)}`;
  if (last > expectedLast) return 'candle after the boundary';
  const gap = valid.findIndex(
    (c, i) => i > 0 && c.openTime !== (valid[i - 1] as Candle).openTime + INTERVAL_MS,
  );
  if (gap !== -1)
    return `gapped candles at ${iso((valid[gap - 1] as Candle).openTime + INTERVAL_MS)}`;
  if (valid.length < CANDLES)
    return `insufficient history: ${valid.length} of ${CANDLES} closed candles`;
  if (valid.length > CANDLES) return `${valid.length} candles, expected ${CANDLES}`;
  return valid;
}

export type Direction = 'UP' | 'DOWN' | 'NONE';

export interface Market {
  direction: Direction;
  /** BTC's 12h trend efficiency at the first breakout close, 4 decimals. */
  btcEfficiency: string;
  /** BTC's 12h log return at the first breakout close, 6 decimals. */
  btcReturn12h: string;
  agreeing: string[];
  reason: string;
}

const toNumber = (value: bigint) => Number(fmt(value));
function sign(a: bigint, b: bigint): number {
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/** Closes at the first breakout candle and each whole hour back over TREND_HOURS. */
function hourlyCloses(candles: Candle[]): bigint[] {
  return Array.from(
    { length: TREND_HOURS + 1 },
    (_, k) => (candles[RANGE_CANDLES - k * PER_HOUR] as Candle).close,
  );
}

/**
 * The scan's market direction at the first breakout close. BTC's 12h trend efficiency is the
 * absolute net log return over the sum of absolute hourly log changes (12 intervals, sampled
 * backward from that close); it must be at least 0.30, and at least three of ETH, SOL, BNB and XRP
 * must have the same signed 12h return as BTC.
 */
export function marketDirection(reference: Record<string, Candle[]>): Market {
  const btc = hourlyCloses(reference['BTCUSDT'] as Candle[]);
  const now = btc[0] as bigint;
  const then = btc[TREND_HOURS] as bigint;
  const net = Math.log(toNumber(now) / toNumber(then));
  let path = 0;
  for (let k = 0; k < TREND_HOURS; k++) {
    path += Math.abs(Math.log(toNumber(btc[k] as bigint) / toNumber(btc[k + 1] as bigint)));
  }
  const efficiency = path === 0 ? 0 : Math.abs(net) / path;
  const btcSign = sign(now, then);
  const agreeing = REFERENCE.slice(1).filter((symbol) => {
    const closes = hourlyCloses(reference[symbol] as Candle[]);
    return btcSign !== 0 && sign(closes[0] as bigint, closes[TREND_HOURS] as bigint) === btcSign;
  });
  const market = { btcEfficiency: efficiency.toFixed(4), btcReturn12h: net.toFixed(6), agreeing };
  if (btcSign === 0) return { ...market, direction: 'NONE', reason: 'BTC 12h return is zero' };
  if (efficiency < MIN_EFFICIENCY) {
    return {
      ...market,
      direction: 'NONE',
      reason: `BTC 12h efficiency ${market.btcEfficiency} below 0.30`,
    };
  }
  if (agreeing.length < MIN_AGREEING) {
    return {
      ...market,
      direction: 'NONE',
      reason: `${agreeing.length} of 4 basket contracts agree with BTC`,
    };
  }
  const direction = btcSign > 0 ? 'UP' : 'DOWN';
  return {
    ...market,
    direction,
    reason: `BTC efficiency ≥ 0.30 and ${agreeing.length} of 4 agree`,
  };
}

export type Side = 'LONG' | 'SHORT';

/** The frozen research levels of one detected breakout, exact. */
export interface Setup {
  symbol: string;
  side: Side;
  rangeHigh: bigint;
  rangeLow: bigint;
  breakoutLevel: bigint;
  firstClose: bigint;
  confirmationClose: bigint;
  stop: bigint;
  target: bigint;
}

/**
 * The frozen rule on one contract's validated candles. The last two closed candles are the first
 * breakout and its immediate confirmation; the CANDLES − 2 before them freeze the range. A Long
 * needs an UP market and both closes strictly above the range high; a Short a DOWN market and both
 * strictly below the range low. Exits come from the first breakout candle: the stop 1 bp beyond
 * the farther of its extreme and the breakout level, the target twice the close-to-stop distance
 * from its close. Returns the setup or why there is none.
 */
export function breakoutSetup(
  symbol: string,
  candles: Candle[],
  direction: Direction,
): Setup | string {
  const range = candles.slice(0, RANGE_CANDLES);
  const rangeHigh = range.reduce((m, c) => (c.high > m ? c.high : m), 0n);
  const rangeLow = range.reduce((m, c) => (c.low < m ? c.low : m), (range[0] as Candle).low);
  const first = candles[RANGE_CANDLES] as Candle;
  const confirmation = candles[RANGE_CANDLES + 1] as Candle;
  const above = first.close > rangeHigh && confirmation.close > rangeHigh;
  const below = first.close < rangeLow && confirmation.close < rangeLow;
  if (!above && !below) return 'no two-close breakout';
  const side: Side = above ? 'LONG' : 'SHORT';
  if (direction !== (above ? 'UP' : 'DOWN')) {
    return `${side} breakout against a ${direction} market`;
  }
  const level = above ? rangeHigh : rangeLow;
  const base = {
    symbol,
    side,
    rangeHigh,
    rangeLow,
    breakoutLevel: level,
    firstClose: first.close,
    confirmationClose: confirmation.close,
  };
  if (above) {
    const stop = mul(first.low < level ? first.low : level, SCALE - BP);
    return { ...base, stop, target: first.close + 2n * (first.close - stop) };
  }
  const stop = mul(first.high > level ? first.high : level, SCALE + BP);
  const target = first.close - 2n * (stop - first.close);
  if (target <= 0n) return 'SHORT target at or below zero';
  return { ...base, stop, target };
}

// ---------------------------------------------------------------- 3. quote economics

/** A fresh quote and mark price fetched for one signal, as recorded. */
export interface QuoteRecord {
  /** Server-aligned time the scan decided about this quote (and requested it, if in the window). */
  requestedAt: number;
  /** Server-aligned time both answers had arrived: the evaluation time. */
  receivedAt?: number;
  bookTicker?: unknown;
  premiumIndex?: unknown;
  failure?: string;
}

export type SignalStatus = 'eligible' | 'not currently eligible' | 'rejected';

export interface SignalQuote {
  source: typeof QUOTE_SOURCE;
  side: 'ask' | 'bid';
  entryQuote: string;
  bid: string;
  ask: string;
  spreadBps: string;
  quoteTime: string;
  quoteAgeMs: number;
  markSource: typeof MARK_SOURCE;
  markPrice: string;
  markTime: string;
  markAgeMs: number;
  evaluatedAt: string;
}

export interface Economics {
  entryFill: string;
  targetFill: string;
  stopFill: string;
  rewardPerUnit: string;
  riskPerUnit: string;
  netRewardRisk: string;
  takerFeeBps: string;
  slippageBps: string;
  basis: 'before funding';
}

/** One detected signal with typed decimal-string fields. */
export interface Signal {
  symbol: string;
  side: Side;
  ruleId: typeof RULE.id;
  ruleVersion: typeof RULE.version;
  /** The confirmation candle's close: the decision timestamp of the signal. */
  signalTime: string;
  quoteWindowOpens: string;
  /** The end of the quote window: after it the signal is not currently eligible. */
  expiresAt: string;
  breakoutLevel: string;
  rangeHigh: string;
  rangeLow: string;
  firstBreakoutClose: string;
  confirmationClose: string;
  /** Raw research levels, exact. */
  rawStop: string;
  rawTarget: string;
  /** On the tick grid against the trade: the stop away from the entry, the target toward it. */
  tickSize: string;
  stop: string;
  target: string;
  quote: SignalQuote | null;
  economics: Economics | null;
  status: SignalStatus;
  reasons: string[];
}

const floorGrid = (value: bigint, min: bigint, step: bigint) =>
  value <= min ? min : min + ((value - min) / step) * step;
const ceilGrid = (value: bigint, min: bigint, step: bigint) =>
  value <= min ? min : min + ((value - min + step - 1n) / step) * step;

/** The setup's exits on the tick grid: a Long rounds both down, a Short both up. */
export function tickLevels(setup: Setup, perp: Perpetual): { stop: bigint; target: bigint } {
  const step = dec(perp.tickSize) as bigint;
  const min = dec(perp.minPrice) as bigint;
  const round = setup.side === 'LONG' ? floorGrid : ceilGrid;
  return { stop: round(setup.stop, min, step), target: round(setup.target, min, step) };
}

/**
 * Net reward and risk per unit at an entry quote: entry and exits each fill `slippageBps` against
 * the trade and pay `takerFeeBps`. Before funding.
 */
export function economics(
  side: Side,
  quote: bigint,
  levels: { stop: bigint; target: bigint },
  s: ScanSettings,
): { reward: bigint; risk: bigint; fields: Economics } {
  const slip = bpsOf(s.slippageBps);
  const fee = bpsOf(s.takerFeeBps);
  const long = side === 'LONG';
  const against = (price: bigint, buying: boolean) =>
    mul(price, buying ? SCALE + slip : SCALE - slip);
  const entry = against(quote, long);
  const target = against(levels.target, !long);
  const stop = against(levels.stop, !long);
  const reward = (long ? target - entry : entry - target) - mul(entry + target, fee);
  const risk = (long ? entry - stop : stop - entry) + mul(entry + stop, fee);
  const ratio = risk > 0n ? fmt(div(reward, risk)) : 'undefined';
  return {
    reward,
    risk,
    fields: {
      entryFill: fmt(entry),
      targetFill: fmt(target),
      stopFill: fmt(stop),
      rewardPerUnit: fmt(reward),
      riskPerUnit: fmt(risk),
      netRewardRisk: ratio,
      takerFeeBps: s.takerFeeBps,
      slippageBps: s.slippageBps,
      basis: 'before funding',
    },
  };
}

/** Why the evaluation time is outside the quote window, or null. */
function windowRefusal(at: number, opens: number, expires: number): string | null {
  if (at < opens) return `not yet eligible: quote window opens ${iso(opens)}`;
  if (at > expires) return `expired: quote window closed ${iso(expires)}`;
  return null;
}

/** The recorded quote and mark price, read and timed, or why they can't be used. */
function readSignalQuote(
  side: Side,
  record: QuoteRecord,
  s: ScanSettings,
): { quote: SignalQuote; entry: bigint; mark: bigint; spread: bigint } | string {
  if (record.failure || record.receivedAt === undefined)
    return `quote unavailable: ${record.failure ?? 'not requested'}`;
  const book = readQuote(record.bookTicker);
  if (typeof book === 'string') return `quote ${book}`;
  const bookTime = isRecord(record.bookTicker) ? record.bookTicker['time'] : undefined;
  const premium = isRecord(record.premiumIndex) ? record.premiumIndex : {};
  const mark = dec(premium['markPrice']);
  const markTime = premium['time'];
  if (!Number.isSafeInteger(bookTime)) return 'quote time missing';
  if (!mark || !Number.isSafeInteger(markTime)) return 'mark price missing or invalid';
  const quoteAgeMs = record.receivedAt - (bookTime as number);
  const markAgeMs = record.receivedAt - (markTime as number);
  if (quoteAgeMs > s.maxQuoteAgeMs)
    return `stale quote: ${quoteAgeMs} ms old, maximum ${s.maxQuoteAgeMs} ms`;
  if (markAgeMs > s.maxQuoteAgeMs)
    return `stale mark price: ${markAgeMs} ms old, maximum ${s.maxQuoteAgeMs} ms`;
  const entry = side === 'LONG' ? book.ask : book.bid;
  const spread = spreadBps(book.bid, book.ask);
  return {
    entry,
    mark,
    spread,
    quote: {
      source: QUOTE_SOURCE,
      side: side === 'LONG' ? 'ask' : 'bid',
      entryQuote: fmt(entry),
      bid: fmt(book.bid),
      ask: fmt(book.ask),
      spreadBps: fmt(spread),
      quoteTime: iso(bookTime as number),
      quoteAgeMs,
      markSource: MARK_SOURCE,
      markPrice: fmt(mark),
      markTime: iso(markTime as number),
      markAgeMs,
      evaluatedAt: iso(record.receivedAt),
    },
  };
}

/** Why the mark price is already at or beyond a barrier, or null. */
function barrierRefusal(
  side: Side,
  mark: bigint,
  levels: { stop: bigint; target: bigint },
): string | null {
  const long = side === 'LONG';
  if (long ? mark <= levels.stop : mark >= levels.stop)
    return `mark ${fmt(mark)} already at or beyond the stop`;
  if (long ? mark >= levels.target : mark <= levels.target)
    return `mark ${fmt(mark)} already at or beyond the target`;
  return null;
}

/**
 * Time, quote, barrier and economics checks for one setup, in that order. The signal stays in the
 * report whatever fails: outside the window it is not currently eligible, otherwise rejected.
 */
export function evaluateSignal(
  setup: Setup,
  perp: Perpetual,
  boundary: number,
  record: QuoteRecord | undefined,
  s: ScanSettings,
): Signal {
  const levels = tickLevels(setup, perp);
  const opens = boundary + s.quoteWindowStartMs;
  const expires = boundary + s.quoteWindowEndMs;
  const signal: Signal = {
    symbol: setup.symbol,
    side: setup.side,
    ruleId: RULE.id,
    ruleVersion: RULE.version,
    signalTime: iso(boundary),
    quoteWindowOpens: iso(opens),
    expiresAt: iso(expires),
    breakoutLevel: fmt(setup.breakoutLevel),
    rangeHigh: fmt(setup.rangeHigh),
    rangeLow: fmt(setup.rangeLow),
    firstBreakoutClose: fmt(setup.firstClose),
    confirmationClose: fmt(setup.confirmationClose),
    rawStop: fmt(setup.stop),
    rawTarget: fmt(setup.target),
    tickSize: perp.tickSize,
    stop: fmt(levels.stop),
    target: fmt(levels.target),
    quote: null,
    economics: null,
    status: 'rejected',
    reasons: [],
  };
  if (!record) return { ...signal, reasons: ['quote unavailable: not requested'] };
  const late = windowRefusal(record.receivedAt ?? record.requestedAt, opens, expires);
  if (late) return { ...signal, status: 'not currently eligible', reasons: [late] };
  const read = readSignalQuote(setup.side, record, s);
  if (typeof read === 'string') return { ...signal, reasons: [read] };
  const result = economics(setup.side, read.entry, levels, s);
  const priced = { ...signal, quote: read.quote, economics: result.fields };
  const reasons = [
    read.spread > (dec(s.maxSpreadBps) as bigint)
      ? `spread ${fixed(read.spread, 2)} bps above ${s.maxSpreadBps} bps at the quote`
      : '',
    barrierRefusal(setup.side, read.mark, levels) ?? '',
    economicsRefusal(result.reward, result.risk, s) ?? '',
  ].filter(Boolean);
  return { ...priced, status: reasons.length === 0 ? 'eligible' : 'rejected', reasons };
}

function economicsRefusal(reward: bigint, risk: bigint, s: ScanSettings): string | null {
  if (reward <= 0n || risk <= 0n) return 'uneconomic: no net reward after costs';
  const min = dec(s.minNetRewardRisk) as bigint;
  if (reward * SCALE < min * risk) {
    return `uneconomic: net reward:risk ${fixed(div(reward, risk), 2)} below ${s.minNetRewardRisk}`;
  }
  return null;
}

// ---------------------------------------------------------------- 4. one scan

export const SNAPSHOT_SCHEMA = 'popup.perp-breakout-scan.snapshot';

/** Everything a scan used to decide, as fetched. Replaying it reproduces the report exactly. */
export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  schemaVersion: 1;
  rule: typeof RULE;
  settings: ScanSettings;
  /** Binance server time when the scan started: the common decision timestamp. */
  decisionTime: number;
  /** Close of the last closed 15m candle at the decision time, the same for every symbol. */
  boundary: number;
  exchangeSymbols: unknown[] | null;
  tickers24h: unknown;
  bookTickers: unknown;
  /** Raw kline rows by symbol, as received. */
  candles: Record<string, unknown>;
  /** Eligible contracts whose candles were never requested, and why. */
  notEvaluated: Record<string, string>;
  quotes: Record<string, QuoteRecord>;
  /** Requests that failed, by request. */
  failures: Record<string, string>;
  requestWeight: number;
  usedWeight1m: number | null;
  elapsedMs: number;
  report?: ScanReport;
}

export type ScanStatus = 'complete' | 'partial' | 'incomplete' | 'failed';

export interface ScanReport {
  rule: typeof RULE & { note: string };
  settings: ScanSettings;
  status: ScanStatus;
  statusReason: string;
  decisionTime: string;
  candleBoundary: string;
  counts: {
    listed: number;
    cryptoPerpetuals: number;
    eligible: number;
    evaluated: number;
    notEvaluated: number;
    signals: number;
    eligibleSignals: number;
  };
  excluded: Record<string, number>;
  screenRejected: Rejection[];
  /** Eligible contracts in the order candles were requested: descending 24h quote volume. */
  shortlist: string[];
  notEvaluated: Rejection[];
  evaluated: string[];
  ruleRejected: Rejection[];
  market: Market | null;
  signals: Signal[];
  failures: Record<string, string>;
  requestWeight: number;
  usedWeight1m: number | null;
  elapsedMs: number;
}

const NOTE = 'Research baseline: its historical performance after costs did not support live use.';

/** Reference candles validated, or why the market direction can't be known. */
function referenceCandles(snapshot: Snapshot): Record<string, Candle[]> | string {
  const out: Record<string, Candle[]> = {};
  for (const symbol of REFERENCE) {
    const candles = validCandles(snapshot.candles[symbol], snapshot.boundary);
    if (typeof candles === 'string') {
      const reason = snapshot.notEvaluated[symbol] ?? withFailure(snapshot, symbol, candles);
      return `reference ${symbol} unusable: ${reason}`;
    }
    out[symbol] = candles;
  }
  return out;
}

/** A candle rejection with the request failure behind it, if one was recorded. */
function withFailure(snapshot: Snapshot, symbol: string, reason: string): string {
  const failure = snapshot.failures[`klines ${symbol}`];
  return failure ? `${reason} (${failure})` : reason;
}

const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * Why the decision timestamp can't be trusted, or null: more than a minute from the newest bulk
 * book ticker. A stale clock would fix an old candle boundary that every candle check then accepts.
 */
function clockRefusal(decisionTime: number, bookTickers: unknown[]): string | null {
  const times = bookTickers
    .map((b) => (isRecord(b) ? b['time'] : undefined))
    .filter(Number.isSafeInteger) as number[];
  if (times.length === 0) return null;
  const newest = Math.max(...times);
  if (Math.abs(decisionTime - newest) <= MAX_CLOCK_SKEW_MS) return null;
  return `Failed: decision time ${iso(decisionTime)} is ${Math.round((newest - decisionTime) / 1000)} s from the newest book ticker ${iso(newest)}`;
}

/** Candle problems that mean the contract was not evaluated (insufficient history is the rule's). */
const DATA_REJECTIONS = [
  'candles missing',
  'candle row invalid',
  'stale candles',
  'candle after',
  'gapped candles',
];
const isDataRejection = (reason: string) =>
  DATA_REJECTIONS.some((prefix) => reason.startsWith(prefix)) || /^\d/.test(reason);

/** The rule over every eligible contract in order, with what kept each one from a setup. */
function evaluateContracts(snapshot: Snapshot, eligible: Eligible[], market: Market | null) {
  const notEvaluated: Rejection[] = [];
  const evaluated: string[] = [];
  const ruleRejected: Rejection[] = [];
  const setups: { setup: Setup; perp: Eligible }[] = [];
  for (const perp of eligible) {
    const skipped = snapshot.notEvaluated[perp.symbol];
    const candles = skipped ?? validCandles(snapshot.candles[perp.symbol], snapshot.boundary);
    if (typeof candles === 'string' && (skipped || isDataRejection(candles))) {
      notEvaluated.push({
        symbol: perp.symbol,
        reason: withFailure(snapshot, perp.symbol, candles),
      });
      continue;
    }
    evaluated.push(perp.symbol);
    let setup: Setup | string = 'market direction unavailable';
    if (typeof candles === 'string') setup = candles;
    else if (market) setup = breakoutSetup(perp.symbol, candles, market.direction);
    if (typeof setup === 'string') ruleRejected.push({ symbol: perp.symbol, reason: setup });
    else setups.push({ setup, perp });
  }
  return { notEvaluated, evaluated, ruleRejected, setups };
}

/** Complete, partial (some eligible contracts not evaluated) or incomplete (no market direction). */
function scanStatus(
  reference: unknown,
  notEvaluated: number,
  eligible: number,
): { status: ScanStatus; statusReason: string } {
  if (typeof reference === 'string') {
    return {
      status: 'incomplete',
      statusReason: `Incomplete: ${reference}; no market direction, so no signal can be judged`,
    };
  }
  if (notEvaluated > 0) {
    return {
      status: 'partial',
      statusReason: `Partial: ${notEvaluated} of ${eligible} eligible contracts not evaluated`,
    };
  }
  return {
    status: 'complete',
    statusReason: `Complete: all ${eligible} eligible contracts evaluated`,
  };
}

/** The whole decision for one snapshot: the same function for a live run and its replay. */
export function evaluateScan(snapshot: Snapshot): ScanReport {
  const s = snapshot.settings;
  const base = {
    rule: { ...RULE, note: NOTE },
    settings: s,
    decisionTime: iso(snapshot.decisionTime),
    candleBoundary: iso(snapshot.boundary),
    failures: snapshot.failures,
    requestWeight: snapshot.requestWeight,
    usedWeight1m: snapshot.usedWeight1m,
    elapsedMs: snapshot.elapsedMs,
  };
  const empty = {
    excluded: {},
    screenRejected: [],
    shortlist: [],
    notEvaluated: [],
    evaluated: [],
    ruleRejected: [],
    market: null,
    signals: [],
  };
  const counts = {
    listed: 0,
    cryptoPerpetuals: 0,
    eligible: 0,
    evaluated: 0,
    notEvaluated: 0,
    signals: 0,
    eligibleSignals: 0,
  };
  if (
    !snapshot.exchangeSymbols ||
    !Array.isArray(snapshot.tickers24h) ||
    !Array.isArray(snapshot.bookTickers)
  ) {
    const reason =
      Object.entries(snapshot.failures)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ') || 'discovery data missing';
    return {
      ...base,
      ...empty,
      counts,
      status: 'failed',
      statusReason: `Discovery failed (${reason})`,
    };
  }
  const skew = clockRefusal(snapshot.decisionTime, snapshot.bookTickers);
  if (skew) return { ...base, ...empty, counts, status: 'failed', statusReason: skew };
  const { perpetuals, excluded } = cryptoPerpetuals(snapshot.exchangeSymbols);
  const { eligible, rejected } = screenUniverse(
    perpetuals,
    snapshot.tickers24h,
    snapshot.bookTickers,
    s,
  );
  const reference = referenceCandles(snapshot);
  const market = typeof reference === 'string' ? null : marketDirection(reference);
  const { notEvaluated, evaluated, ruleRejected, setups } = evaluateContracts(
    snapshot,
    eligible,
    market,
  );
  const signals = setups.map(({ setup, perp }) =>
    evaluateSignal(setup, perp, snapshot.boundary, snapshot.quotes[setup.symbol], s),
  );
  return {
    ...base,
    ...scanStatus(reference, notEvaluated.length, eligible.length),
    counts: {
      listed: snapshot.exchangeSymbols.length,
      cryptoPerpetuals: perpetuals.size,
      eligible: eligible.length,
      evaluated: evaluated.length,
      notEvaluated: notEvaluated.length,
      signals: signals.length,
      eligibleSignals: signals.filter((x) => x.status === 'eligible').length,
    },
    excluded,
    screenRejected: rejected,
    shortlist: eligible.map((e) => e.symbol),
    notEvaluated,
    evaluated,
    ruleRejected,
    market,
    signals,
  };
}

// ---------------------------------------------------------------- 5. replay boundary

/** The only message a malformed snapshot produces: nothing from the file is echoed. */
export const INVALID_SNAPSHOT = `Not a valid perp breakout scan snapshot for ${RULE.id} ${RULE.version}`;

/** Contract symbols: letters of any script (Binance lists e.g. 币安人生USDT), digits, underscore. */
const SYMBOL = /^[\p{L}\p{N}_]{1,40}$/u;
/** Exchange codes such as status, contract type, assets and underlying type. */
const CODE = /^[A-Z0-9_]{1,40}$/;
const ERROR_NAMES = ['TypeError', 'TimeoutError', 'AbortError', 'SyntaxError', 'Error'] as const;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
/** Why the scanner skipped a request: its only notEvaluated values. */
export const SKIP_REASONS = [
  'weight budget',
  'deadline',
  'rate limited (HTTP 429)',
  'rate limited (HTTP 418)',
] as const;
const FIXED_FAILURES = [...SKIP_REASONS, 'unreadable answer', 'network error'] as const;
const DISCOVERY_REQUESTS = ['time', 'exchangeInfo', 'tickers24h', 'bookTickers'] as const;

const symbolOf = (value: unknown) => (typeof value === 'string' && SYMBOL.test(value) ? value : '');
const codeOf = (value: unknown) =>
  typeof value === 'string' && CODE.test(value) ? value : 'INVALID';
/** A decimal re-rendered from its exact value, or null: the same number for every decision. */
const canonical = (value: unknown) => {
  const exact = dec(value);
  return exact === null ? null : fmt(exact);
};
const safeInt = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : null);
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;

/** A thrown request error as the scanner reports it: a known name, plus a network code if any. */
export function errorName(name: unknown, code: unknown): string | null {
  const known = ERROR_NAMES.find((n) => n === name);
  if (!known) return null;
  return typeof code === 'string' && ERROR_CODE.test(code) ? `${known} (${code})` : known;
}

/**
 * One diagnostic exactly as the scanner emits it, rebuilt from its validated parts, or null:
 * a skip or fixed reason, `HTTP <status>`, or a known error name with an optional network code.
 */
export function diagnostic(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const fixed = FIXED_FAILURES.find((reason) => reason === value);
  if (fixed) return fixed;
  const http = /^HTTP (\d{3})$/.exec(value);
  const status = http ? Number(http[1]) : 0;
  if (status >= 100 && status <= 599) return `HTTP ${status}`;
  const error = /^([A-Za-z]{1,20})(?: \(([A-Z0-9_]{2,64})\))?$/.exec(value);
  return error ? errorName(error[1], error[2]) : null;
}

/** A quote failure: diagnostics joined by '; ', each rebuilt. */
function quoteFailure(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('; ').map(diagnostic);
  return parts.some((p) => p === null) ? null : parts.join('; ');
}

/** Settings checked at runtime and rebuilt from DEFAULT_SETTINGS' keys, or null. */
export function normalizeSettings(value: unknown): ScanSettings | null {
  if (!isRecord(value)) return null;
  const settings: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    const read = typeof fallback === 'number' ? safeInt(value[key]) : canonical(value[key]);
    if (read === null) return null;
    settings[key] = read;
  }
  return settingsRefusal(settings as unknown as ScanSettings)
    ? null
    : (settings as unknown as ScanSettings);
}

/** The exchangeInfo fields the selection reads; anything unreadable stays unreadable. */
function exchangeEntry(entry: unknown): Record<string, unknown> {
  if (!isRecord(entry)) return {};
  const filters = Array.isArray(entry['filters']) ? entry['filters'].filter(isRecord) : [];
  const filter = (type: string): Record<string, unknown> =>
    filters.find((f) => f['filterType'] === type) ?? {};
  const price = filter('PRICE_FILTER');
  const lot = filter('LOT_SIZE');
  return {
    symbol: symbolOf(entry['symbol']),
    status: codeOf(entry['status']),
    contractType: codeOf(entry['contractType']),
    quoteAsset: codeOf(entry['quoteAsset']),
    marginAsset: codeOf(entry['marginAsset']),
    underlyingType: codeOf(entry['underlyingType']),
    filters: [
      {
        filterType: 'PRICE_FILTER',
        tickSize: canonical(price['tickSize']),
        minPrice: canonical(price['minPrice']),
        maxPrice: canonical(price['maxPrice']),
      },
      {
        filterType: 'LOT_SIZE',
        stepSize: canonical(lot['stepSize']),
        minQty: canonical(lot['minQty']),
        maxQty: canonical(lot['maxQty']),
      },
      { filterType: 'MARKET_LOT_SIZE', maxQty: canonical(filter('MARKET_LOT_SIZE')['maxQty']) },
      { filterType: 'MIN_NOTIONAL', notional: canonical(filter('MIN_NOTIONAL')['notional']) },
      {
        filterType: 'PERCENT_PRICE',
        multiplierUp: canonical(filter('PERCENT_PRICE')['multiplierUp']),
      },
    ],
  };
}

/** Rows that carry a valid symbol, reduced to the given decimal and time fields. */
function marketRows(value: unknown, decimals: string[], times: string[] = []): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter(isRecord).flatMap((row) => {
    const symbol = symbolOf(row['symbol']);
    if (!symbol) return [];
    const out: Record<string, unknown> = { symbol };
    for (const key of decimals) out[key] = canonical(row[key]);
    for (const key of times) {
      const time = safeInt(row[key]);
      if (time !== null) out[key] = time;
    }
    return [out];
  });
}

/** A kline row reduced to what validCandles reads: open time, OHLC and close time. */
const candleRow = (row: unknown) =>
  Array.isArray(row)
    ? [
        safeInt(row[0]),
        canonical(row[1]),
        canonical(row[2]),
        canonical(row[3]),
        canonical(row[4]),
        null,
        safeInt(row[6]),
      ]
    : null;

function normalizeCandles(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, rows] of Object.entries(value)) {
    if (symbolOf(key) !== key) return null;
    out[key] = Array.isArray(rows) ? rows.map(candleRow) : null;
  }
  return out;
}

/** A recorded book ticker or mark price reduced to its prices and time; a non-object stays null. */
const bookRecord = (value: unknown) =>
  isRecord(value)
    ? {
        bidPrice: canonical(value['bidPrice']),
        askPrice: canonical(value['askPrice']),
        time: safeInt(value['time']),
      }
    : null;
const markRecord = (value: unknown) =>
  isRecord(value)
    ? { markPrice: canonical(value['markPrice']), time: safeInt(value['time']) }
    : null;

function quoteRecord(value: unknown): QuoteRecord | null {
  if (!isRecord(value)) return null;
  const requestedAt = safeInt(value['requestedAt']);
  if (requestedAt === null) return null;
  const record: QuoteRecord = { requestedAt };
  if (value['receivedAt'] !== undefined) {
    const receivedAt = safeInt(value['receivedAt']);
    if (receivedAt === null) return null;
    record.receivedAt = receivedAt;
  }
  if (value['failure'] !== undefined) {
    const failure = quoteFailure(value['failure']);
    if (failure === null) return null;
    record.failure = failure;
  }
  if ('bookTicker' in value) record.bookTicker = bookRecord(value['bookTicker']);
  if ('premiumIndex' in value) record.premiumIndex = markRecord(value['premiumIndex']);
  return record;
}

/** A record of symbol → value, each value rebuilt, or null if any key or value is not the scanner's. */
function bySymbolRecord<T>(
  value: unknown,
  read: (v: unknown) => T | null,
): Record<string, T> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    const rebuilt = read(item);
    if (symbolOf(key) !== key || rebuilt === null) return null;
    out[key] = rebuilt;
  }
  return out;
}

function normalizeFailures(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, reason] of Object.entries(value)) {
    const request = DISCOVERY_REQUESTS.find((r) => r === key);
    const symbol = key.startsWith('klines ') ? symbolOf(key.slice(7)) : '';
    const rebuilt = diagnostic(reason);
    if ((!request && !symbol) || rebuilt === null) return null;
    out[request ?? `klines ${symbol}`] = rebuilt;
  }
  return out;
}

/**
 * The replay input boundary. A parsed file (unknown) becomes the snapshot evaluateScan reads, built
 * only from the fields the scan uses: settings checked at runtime, market answers reduced to their
 * fields with every decimal re-rendered from its exact value (unreadable values stay unreadable, so
 * the same decisions follow), and diagnostics accepted only in the scanner's own forms. Null when
 * anything else is malformed; the caller reports INVALID_SNAPSHOT and echoes nothing. A live scan
 * evaluates the same normalized view, so a run and its replay agree by construction.
 */
/** The snapshot's identity, clock and accounting, checked and rebuilt, or null. */
function snapshotMeta(raw: Record<string, unknown>) {
  const rule = raw['rule'];
  const identity =
    raw['schema'] === SNAPSHOT_SCHEMA &&
    raw['schemaVersion'] === 1 &&
    isRecord(rule) &&
    rule['id'] === RULE.id &&
    rule['version'] === RULE.version;
  const settings = normalizeSettings(raw['settings']);
  const decisionTime = safeInt(raw['decisionTime']);
  if (!identity || !settings || decisionTime === null) return null;
  const boundary = Math.floor(decisionTime / INTERVAL_MS) * INTERVAL_MS;
  const requestWeight = count(raw['requestWeight']);
  const elapsedMs = count(raw['elapsedMs']);
  const usedWeight1m = raw['usedWeight1m'] === null ? null : count(raw['usedWeight1m']);
  if (raw['boundary'] !== boundary || requestWeight === null || elapsedMs === null) return null;
  if (usedWeight1m === null && raw['usedWeight1m'] !== null) return null;
  return { settings, decisionTime, boundary, requestWeight, usedWeight1m, elapsedMs };
}

export function normalizeSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw)) return null;
  const meta = snapshotMeta(raw);
  const candles = normalizeCandles(raw['candles']);
  const notEvaluated = bySymbolRecord(
    raw['notEvaluated'],
    (v) => SKIP_REASONS.find((r) => r === v) ?? null,
  );
  const quotes = bySymbolRecord(raw['quotes'], quoteRecord);
  const failures = normalizeFailures(raw['failures']);
  const symbols = raw['exchangeSymbols'];
  if (!meta || !candles || !notEvaluated || !quotes || !failures) return null;
  if (symbols !== null && !Array.isArray(symbols)) return null;
  return {
    schema: SNAPSHOT_SCHEMA,
    schemaVersion: 1,
    rule: RULE,
    ...meta,
    exchangeSymbols: Array.isArray(symbols) ? symbols.map(exchangeEntry) : null,
    tickers24h: marketRows(raw['tickers24h'], ['quoteVolume']),
    bookTickers: marketRows(raw['bookTickers'], ['bidPrice', 'askPrice'], ['time']),
    candles,
    notEvaluated,
    quotes,
    failures,
  };
}

// ---------------------------------------------------------------- report text

const tally = (rows: Rejection[]) => {
  const counts: Record<string, number> = {};
  for (const { reason } of rows) {
    const colon = reason.indexOf(':');
    const key = colon === -1 ? reason : reason.slice(0, colon);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return (
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} ${v}`)
      .join(', ') || 'none'
  );
};

function signalLines(x: Signal): string[] {
  const lines = [
    `${x.side} ${x.symbol} · ${x.status}${x.reasons.length > 0 ? ': ' + x.reasons.join('; ') : ''}`,
    `  breakout level ${x.breakoutLevel} (range ${x.rangeLow}–${x.rangeHigh}) · closes ${x.firstBreakoutClose}, ${x.confirmationClose} · signal ${x.signalTime}, expires ${x.expiresAt}`,
    `  exits raw stop ${x.rawStop} / target ${x.rawTarget} → tick ${x.tickSize}: stop ${x.stop} / target ${x.target}`,
  ];
  if (x.quote && x.economics) {
    const ratio = signedDec(x.economics.netRewardRisk);
    lines.push(
      `  entry ${x.quote.side} ${x.quote.entryQuote} (book ticker ${x.quote.quoteTime}, age ${x.quote.quoteAgeMs} ms; mark ${x.quote.markPrice}) · net reward:risk ${ratio === null ? 'undefined' : fixed(ratio, 2)} before funding`,
    );
  }
  return lines;
}

/** The report as plain text for the terminal. */
export function reportText(r: ScanReport): string {
  const c = r.counts;
  const m = r.market;
  return [
    `Binance USDⓈ-M crypto perpetual scan · rule ${r.rule.id} ${r.rule.version} · ${r.rule.note}`,
    `Status: ${r.status.toUpperCase()} · ${r.statusReason} · ${c.signals} signals, ${c.eligibleSignals} eligible`,
    `Decision ${r.decisionTime} · closed 15m boundary ${r.candleBoundary}`,
    m
      ? `Market: ${m.direction} · BTC 12h efficiency ${m.btcEfficiency}, log return ${m.btcReturn12h} · agreeing ${m.agreeing.join(', ') || 'none'} · ${m.reason}`
      : 'Market: unavailable',
    `Stages: ${c.listed} listed → ${c.cryptoPerpetuals} crypto perpetuals → ${c.eligible} eligible (24h quote volume ≥ ${r.settings.minQuoteVolumeUsdt} USDT, spread ≤ ${r.settings.maxSpreadBps} bps) → ${c.evaluated} evaluated, ${c.notEvaluated} not evaluated → ${c.signals} signals → ${c.eligibleSignals} eligible`,
    `Excluded from exchangeInfo: ${
      Object.entries(r.excluded)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
    `Screen rejections: ${tally(r.screenRejected)}`,
    `Not evaluated: ${tally(r.notEvaluated)}`,
    `Rule outcomes: ${tally(r.ruleRejected)}`,
    `Request weight ${r.requestWeight} (budget ${r.settings.weightBudget}) · Binance used weight (1m) ${r.usedWeight1m ?? 'unknown'} · elapsed ${(r.elapsedMs / 1000).toFixed(1)} s`,
    `Costs: ${r.settings.takerFeeBps} bps taker fee and ${r.settings.slippageBps} bps slippage per fill, minimum net reward:risk ${r.settings.minNetRewardRisk}, before funding`,
    ...(r.signals.length > 0 ? r.signals.flatMap(signalLines) : ['Signals: none']),
    `Evaluated (${r.evaluated.length}): ${r.evaluated.join(', ') || 'none'}`,
  ].join('\n');
}
