// @vitest-environment node
/**
 * The perpetual breakout scan on deterministic SYNTHETIC fixtures: contract selection, candle
 * validation, the market direction, the frozen rule, quote economics, scan status and the
 * runner's snapshot replay. No request leaves a test.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  breakoutSetup,
  type Candle,
  cryptoPerpetuals,
  DEFAULT_SETTINGS,
  diagnostic,
  evaluateScan,
  INTERVAL_MS,
  INVALID_SNAPSHOT,
  marketDirection,
  normalizeSettings,
  normalizeSnapshot,
  type QuoteRecord,
  reportText,
  RULE,
  type ScanReport,
  type ScanSettings,
  screenUniverse,
  type Setup,
  type Snapshot,
  SNAPSHOT_SCHEMA,
  spreadBps,
  validCandles,
} from './perpBreakoutScan';
import {
  errorReason,
  OUTSIDE_SNAPSHOT_DIR,
  replay,
  replayCommand,
  scan,
  settingsFrom,
  snapshotFile,
  WEIGHTS,
} from './perpBreakoutScanRun';
import { dec } from '../supabase/functions/futures-execution/plan';

const BOUNDARY = Date.UTC(2026, 10, 28, 12, 0);
const IN_WINDOW = BOUNDARY + 210_000; // 3.5 minutes after the confirmation close
const s = DEFAULT_SETTINGS;
const n = (value: number) => value.toFixed(4);

type Ohlc = [number, number, number, number];
/** Kline rows for the 98 closed 15m candles ending at BOUNDARY. */
function klines(bars: Ohlc[], end = BOUNDARY): unknown[][] {
  return bars.map(([o, h, l, c], i) => {
    const openTime = end - (bars.length - i) * INTERVAL_MS;
    return [
      openTime,
      n(o),
      n(h),
      n(l),
      n(c),
      '1',
      openTime + INTERVAL_MS - 1,
      '1',
      1,
      '1',
      '1',
      '0',
    ];
  });
}
/** 96 flat range candles, then the first breakout and its confirmation. */
const breakout = (range: Ohlc, first: Ohlc, confirmation: Ohlc): Ohlc[] => [
  ...Array.from({ length: 96 }, () => range),
  first,
  confirmation,
];
/** A steady trend: each close `step` from the previous one. */
const trend = (start: number, step: number): Ohlc[] =>
  Array.from({ length: 98 }, (_, i) => {
    const o = start + step * (i - 1);
    const c = start + step * i;
    return [o, Math.max(o, c) + 0.5, Math.min(o, c) - 0.5, c];
  });

// AAAUSDT: range 99–101, two closes above 101. BBBUSDT: range 49.5–51, two closes below 49.5.
const AAA = breakout([100, 101, 99, 100], [100.5, 102.4, 100.2, 102], [102, 102.3, 101.9, 102.1]);
const BBB = breakout([50, 51, 49.5, 50], [49.8, 49.9, 48.6, 48.8], [48.8, 49, 48.5, 48.9]);

function perp(symbol: string, tickSize = '0.01', extra: Record<string, unknown> = {}) {
  return {
    symbol,
    status: 'TRADING',
    contractType: 'PERPETUAL',
    quoteAsset: 'USDT',
    marginAsset: 'USDT',
    underlyingType: 'COIN',
    filters: [
      { filterType: 'PRICE_FILTER', tickSize, minPrice: tickSize, maxPrice: '1000000' },
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MARKET_LOT_SIZE', maxQty: '100' },
      { filterType: 'MIN_NOTIONAL', notional: '5' },
      { filterType: 'PERCENT_PRICE', multiplierUp: '1.05' },
    ],
    ...extra,
  };
}

const REFS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const EXCHANGE = [
  ...REFS.map((symbol) => perp(symbol)),
  perp('AAAUSDT'),
  perp('BBBUSDT', '0.001'),
  perp('NEWUSDT'),
  perp('LOWUSDT'),
  perp('WIDEUSDT'),
  perp('NOQUOTEUSDT'),
  perp('CROSSUSDT'),
  perp('TSLAUSDT', '0.01', { contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' }),
  perp('BTCDOMUSDT', '0.1', { underlyingType: 'INDEX' }),
  perp('OLDUSDT', '0.01', { status: 'SETTLING' }),
  perp('BTCUSDT_261225', '0.1', { contractType: 'CURRENT_QUARTER' }),
  perp('BTCUSDC', '0.1', { quoteAsset: 'USDC', marginAsset: 'USDC' }),
];
const TICKERS = [
  ...REFS.map((symbol) => ({ symbol, quoteVolume: '1000' })), // outside the universe
  { symbol: 'AAAUSDT', quoteVolume: '500000000' },
  { symbol: 'NEWUSDT', quoteVolume: '400000000' },
  { symbol: 'BBBUSDT', quoteVolume: '300000000' },
  { symbol: 'LOWUSDT', quoteVolume: '1000000' },
  { symbol: 'WIDEUSDT', quoteVolume: '900000000' },
  { symbol: 'NOQUOTEUSDT', quoteVolume: '800000000' },
  { symbol: 'CROSSUSDT', quoteVolume: '700000000' },
];
const BOOKS = [
  ...REFS.map((symbol) => ({ symbol, bidPrice: '100', askPrice: '100.01' })),
  { symbol: 'AAAUSDT', bidPrice: '102.09', askPrice: '102.1' },
  { symbol: 'NEWUSDT', bidPrice: '10', askPrice: '10.001' },
  { symbol: 'BBBUSDT', bidPrice: '48.88', askPrice: '48.89' },
  { symbol: 'LOWUSDT', bidPrice: '1', askPrice: '1.0001' },
  { symbol: 'WIDEUSDT', bidPrice: '100', askPrice: '100.5' },
  { symbol: 'CROSSUSDT', bidPrice: '10.1', askPrice: '10' },
];

function quote(bid: string, ask: string, mark: string, at = IN_WINDOW, ageMs = 50): QuoteRecord {
  return {
    requestedAt: at - 300,
    receivedAt: at,
    bookTicker: { symbol: 'X', bidPrice: bid, askPrice: ask, time: at - ageMs },
    premiumIndex: { symbol: 'X', markPrice: mark, time: at - ageMs },
  };
}

/** A complete synthetic snapshot: market UP or DOWN, both candidates' quotes in the window. */
function snapshot(direction: 'UP' | 'DOWN', patch: Partial<Snapshot> = {}): Snapshot {
  const step = direction === 'UP' ? 1 : -1;
  return {
    schema: SNAPSHOT_SCHEMA,
    schemaVersion: 1,
    rule: RULE,
    settings: s,
    decisionTime: BOUNDARY + 200_000,
    boundary: BOUNDARY,
    exchangeSymbols: EXCHANGE,
    tickers24h: TICKERS,
    bookTickers: BOOKS,
    candles: {
      ...Object.fromEntries(REFS.map((symbol, i) => [symbol, klines(trend(1000 + i * 100, step))])),
      AAAUSDT: klines(AAA),
      BBBUSDT: klines(BBB),
      NEWUSDT: klines(AAA.slice(48)),
    },
    notEvaluated: {},
    quotes: {
      AAAUSDT: quote('102.04', '102.05', '102.05'),
      BBBUSDT: quote('48.85', '48.86', '48.86'),
    },
    failures: {},
    requestWeight: 57,
    usedWeight1m: 60,
    elapsedMs: 1234,
    ...patch,
  };
}
const rows = (bars: Ohlc[]) => validCandles(klines(bars), BOUNDARY) as Candle[];

describe('contract selection', () => {
  it('keeps active USDT-margined crypto perpetuals only, counting the rest by reason', () => {
    const { perpetuals, excluded } = cryptoPerpetuals(EXCHANGE);
    expect([...perpetuals.keys()]).not.toContain('TSLAUSDT');
    expect(perpetuals.size).toBe(12);
    expect(perpetuals.get('BBBUSDT')).toEqual({
      symbol: 'BBBUSDT',
      tickSize: '0.001',
      minPrice: '0.001',
    });
    expect(excluded).toEqual({
      'contract type TRADIFI_PERPETUAL': 1,
      'underlying INDEX': 1,
      'status SETTLING': 1,
      'contract type CURRENT_QUARTER': 1,
      'not USDT-quoted and USDT-margined': 1,
    });
  });

  it('screens on 24h quote volume and spread before candles, in descending volume', () => {
    const { perpetuals } = cryptoPerpetuals(EXCHANGE);
    const { eligible, rejected } = screenUniverse(perpetuals, TICKERS, BOOKS, s);
    expect(eligible.map((e) => e.symbol)).toEqual(['AAAUSDT', 'NEWUSDT', 'BBBUSDT']);
    expect(Object.fromEntries(rejected.map((r) => [r.symbol, r.reason]))).toEqual({
      BTCUSDT: '24h quote volume below 20000000 USDT',
      ETHUSDT: '24h quote volume below 20000000 USDT',
      SOLUSDT: '24h quote volume below 20000000 USDT',
      BNBUSDT: '24h quote volume below 20000000 USDT',
      XRPUSDT: '24h quote volume below 20000000 USDT',
      LOWUSDT: '24h quote volume below 20000000 USDT',
      WIDEUSDT: 'spread above 10 bps',
      NOQUOTEUSDT: 'no bid/ask',
      CROSSUSDT: 'bid/ask crossed',
    });
    // (ask − bid) ÷ midpoint: 0.5 ÷ 100.25 = 49.875… bps.
    expect(spreadBps(dec('100') as bigint, dec('100.5') as bigint)).toBe(
      ((dec('0.5') as bigint) * 20_000n * 10n ** 18n) / (dec('200.5') as bigint),
    );
    // A looser screen admits the wide contract.
    const loose = screenUniverse(perpetuals, TICKERS, BOOKS, { ...s, maxSpreadBps: '50' });
    expect(loose.eligible.map((e) => e.symbol)).toEqual([
      'WIDEUSDT',
      'AAAUSDT',
      'NEWUSDT',
      'BBBUSDT',
    ]);
  });
});

describe('candles and the market direction', () => {
  it('rejects missing, invalid, stale, gapped and short candle data with a reason', () => {
    expect(validCandles(undefined, BOUNDARY)).toBe('candles missing');
    expect(validCandles(klines(AAA, BOUNDARY - INTERVAL_MS), BOUNDARY)).toBe(
      'stale candles: last closed 2026-11-28T11:45:00.000Z, expected 2026-11-28T12:00:00.000Z',
    );
    const gapped = klines(AAA);
    gapped.splice(40, 1);
    expect(validCandles(gapped, BOUNDARY)).toBe('gapped candles at 2026-11-27T21:30:00.000Z');
    expect(validCandles(klines(AAA.slice(10)), BOUNDARY)).toBe(
      'insufficient history: 88 of 98 closed candles',
    );
    const broken = klines(AAA);
    (broken[5] as unknown[])[2] = '1'; // high below the close
    expect(validCandles(broken, BOUNDARY)).toBe('candle row invalid');
    expect(rows(AAA)).toHaveLength(98);
  });

  it('sets one direction from BTC efficiency and the basket', () => {
    const basket = (steps: number[]) =>
      Object.fromEntries(REFS.map((symbol, i) => [symbol, rows(trend(1000, steps[i] as number))]));
    expect(marketDirection(basket([1, 1, 1, 1, 1]))).toMatchObject({
      direction: 'UP',
      btcEfficiency: '1.0000',
      agreeing: ['ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
    });
    expect(marketDirection(basket([-1, -1, -1, -1, 1])).direction).toBe('DOWN');
    expect(marketDirection(basket([1, 1, 1, -1, -1]))).toMatchObject({
      direction: 'NONE',
      reason: '2 of 4 basket contracts agree with BTC',
    });
    // BTC alternating ±10 each hour: efficiency far below 0.30.
    const choppy: Ohlc[] = Array.from({ length: 98 }, (_, i) => {
      const c = 1000 + (Math.floor(i / 4) % 2) * 10 + i * 0.01;
      return [c, c + 0.5, c - 0.5, c];
    });
    expect(marketDirection({ ...basket([1, 1, 1, 1, 1]), BTCUSDT: rows(choppy) })).toMatchObject({
      direction: 'NONE',
      reason: expect.stringMatching(/^BTC 12h efficiency 0\.0\d+ below 0\.30$/),
    });
  });
});

describe('the frozen two-close breakout', () => {
  it('freezes a Long and a Short from their own levels', () => {
    const long = breakoutSetup('AAAUSDT', rows(AAA), 'UP') as Setup;
    // Stop 1 bp below min(low 100.2, level 101); target 2 × (102 − 100.18998) above 102.
    expect(long).toMatchObject({
      side: 'LONG',
      breakoutLevel: dec('101'),
      stop: dec('100.18998'),
      target: dec('105.62004'),
    });
    const short = breakoutSetup('BBBUSDT', rows(BBB), 'DOWN') as Setup;
    // Stop 1 bp above max(high 49.9, level 49.5); target 2 × (49.90499 − 48.8) below 48.8.
    expect(short).toMatchObject({
      side: 'SHORT',
      breakoutLevel: dec('49.5'),
      stop: dec('49.90499'),
      target: dec('46.59002'),
    });
    expect(breakoutSetup('AAAUSDT', rows(AAA), 'DOWN')).toBe('LONG breakout against a DOWN market');
    expect(breakoutSetup('AAAUSDT', rows(AAA), 'NONE')).toBe('LONG breakout against a NONE market');
    // One close above the range is not a two-close breakout.
    const once = breakout(
      [100, 101, 99, 100],
      [100.5, 102.4, 100.2, 102],
      [102, 102.1, 100.4, 100.5],
    );
    expect(breakoutSetup('AAAUSDT', rows(once), 'UP')).toBe('no two-close breakout');
  });
});

describe('one scan', () => {
  it('reports an eligible Long with exact exits and economics in an UP market', () => {
    const report = evaluateScan(snapshot('UP'));
    expect(report).toMatchObject({
      status: 'complete',
      statusReason: 'Complete: all 3 eligible contracts evaluated',
      shortlist: ['AAAUSDT', 'NEWUSDT', 'BBBUSDT'],
      evaluated: ['AAAUSDT', 'NEWUSDT', 'BBBUSDT'],
      counts: {
        listed: 17,
        cryptoPerpetuals: 12,
        eligible: 3,
        evaluated: 3,
        notEvaluated: 0,
        signals: 1,
        eligibleSignals: 1,
      },
      ruleRejected: [
        { symbol: 'NEWUSDT', reason: 'insufficient history: 50 of 98 closed candles' },
        { symbol: 'BBBUSDT', reason: 'SHORT breakout against a UP market' },
      ],
    });
    expect(report.market?.direction).toBe('UP');
    const [signal] = report.signals;
    expect(signal).toMatchObject({
      symbol: 'AAAUSDT',
      side: 'LONG',
      ruleId: 'two-close-directional-breakout-15m',
      ruleVersion: '1.0.0',
      signalTime: '2026-11-28T12:00:00.000Z',
      quoteWindowOpens: '2026-11-28T12:03:00.000Z',
      expiresAt: '2026-11-28T12:05:00.000Z',
      breakoutLevel: '101',
      rawStop: '100.18998',
      rawTarget: '105.62004',
      tickSize: '0.01',
      stop: '100.18',
      target: '105.62',
      status: 'eligible',
      reasons: [],
      quote: {
        side: 'ask',
        entryQuote: '102.05',
        quoteAgeMs: 50,
        source: 'GET /fapi/v1/ticker/bookTicker',
      },
      economics: {
        // Entry 102.05 × 1.0005; target 105.62 × 0.9995; stop 100.18 × 0.9995; 5 bps fee each fill.
        entryFill: '102.101025',
        targetFill: '105.56719',
        stopFill: '100.12991',
        rewardPerUnit: '3.3623308925',
        riskPerUnit: '2.0722304675',
        basis: 'before funding',
      },
    });
    expect(signal?.economics?.netRewardRisk).toMatch(/^1\.6225/);
  });

  it('reports an eligible Short on another contract with different levels in a DOWN market', () => {
    const report = evaluateScan(snapshot('DOWN'));
    expect(report.ruleRejected).toContainEqual({
      symbol: 'AAAUSDT',
      reason: 'LONG breakout against a DOWN market',
    });
    expect(report.signals).toHaveLength(1);
    const [signal] = report.signals;
    expect(signal).toMatchObject({
      symbol: 'BBBUSDT',
      side: 'SHORT',
      breakoutLevel: '49.5',
      rawStop: '49.90499',
      rawTarget: '46.59002',
      tickSize: '0.001',
      stop: '49.905',
      target: '46.591',
      status: 'eligible',
      quote: { side: 'bid', entryQuote: '48.85' },
      economics: { rewardPerUnit: '2.16355956475', riskPerUnit: '1.15375526375' },
    });
    expect(signal?.economics?.netRewardRisk).toMatch(/^1\.8752/);
  });

  it('keeps an uneconomic quote, an expired window and stale data visible with the reason', () => {
    const at = (quotes: Snapshot['quotes']) => evaluateScan(snapshot('UP', { quotes })).signals[0];
    // An ask 0.55 above the first breakout close leaves 1.07 net reward:risk.
    expect(at({ AAAUSDT: quote('102.59', '102.6', '102.6') })).toMatchObject({
      status: 'rejected',
      reasons: ['uneconomic: net reward:risk 1.07 below 1.5'],
      economics: { rewardPerUnit: '2.811780755', riskPerUnit: '2.622780605' },
    });
    expect(at({ AAAUSDT: quote('102.04', '102.05', '102.05', BOUNDARY + 360_000) })).toMatchObject({
      status: 'not currently eligible',
      reasons: ['expired: quote window closed 2026-11-28T12:05:00.000Z'],
      quote: null,
    });
    expect(at({ AAAUSDT: { requestedAt: BOUNDARY + 60_000 } })).toMatchObject({
      status: 'not currently eligible',
      reasons: ['not yet eligible: quote window opens 2026-11-28T12:03:00.000Z'],
    });
    expect(at({ AAAUSDT: quote('102.04', '102.05', '102.05', IN_WINDOW, 20_000) })).toMatchObject({
      status: 'rejected',
      reasons: ['stale quote: 20000 ms old, maximum 15000 ms'],
    });
    expect(at({ AAAUSDT: quote('102.04', '102.05', '100.1') })?.reasons).toEqual([
      'mark 100.1 already at or beyond the stop',
    ]);
    expect(at({ AAAUSDT: quote('101.9', '102.05', '102') })?.reasons).toEqual([
      'spread 14.7 bps above 10 bps at the quote',
    ]);
    expect(at({ AAAUSDT: { requestedAt: IN_WINDOW, failure: 'HTTP 503' } })?.reasons).toEqual([
      'quote unavailable: HTTP 503',
    ]);
    // Stale candles keep a contract out of the evaluation: the scan is partial.
    const stale = evaluateScan(
      snapshot('UP', {
        candles: { ...snapshot('UP').candles, AAAUSDT: klines(AAA, BOUNDARY - INTERVAL_MS) },
      }),
    );
    expect(stale).toMatchObject({
      status: 'partial',
      counts: { evaluated: 2, notEvaluated: 1, signals: 0 },
    });
    expect(stale.notEvaluated[0]?.reason).toMatch(/^stale candles/);
  });

  it('is incomplete when the reference basket is unusable, even though XRP is outside the universe', () => {
    const { XRPUSDT: _, ...candles } = snapshot('UP').candles;
    const report = evaluateScan(
      snapshot('UP', { candles, failures: { 'klines XRPUSDT': 'HTTP 500' } }),
    );
    expect(report).toMatchObject({
      status: 'incomplete',
      statusReason:
        'Incomplete: reference XRPUSDT unusable: candles missing (HTTP 500); no market direction, so no signal can be judged',
      market: null,
      signals: [],
    });
    expect(report.ruleRejected.map((r) => r.reason)).toContain('market direction unavailable');
    expect(reportText(report)).toContain('Status: INCOMPLETE');
    const zero = evaluateScan(
      snapshot('UP', { candles: { ...snapshot('UP').candles, AAAUSDT: klines(BBB) } }),
    );
    expect(zero).toMatchObject({ status: 'complete', counts: { signals: 0 } });
    expect(reportText(zero)).toContain('Status: COMPLETE');
    expect(reportText(zero)).toContain('Signals: none');
  });
});

/** A fake Binance serving the UP fixture; it checks every kline request's boundary. */
function fakeBinance(overrides: Record<string, () => Response> = {}) {
  const fixture = snapshot('UP');
  const seen: string[] = [];
  const json = (body: unknown, weight = 10) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'x-mbx-used-weight-1m': String(weight) },
    });
  const fetchFake = (async (input: string) => {
    const url = new URL(input);
    const symbol = url.searchParams.get('symbol') ?? '';
    seen.push(`${url.pathname}${symbol ? ` ${symbol}` : ''}`);
    const override = overrides[url.pathname];
    if (override) return override();
    if (url.pathname === '/fapi/v1/time') return json({ serverTime: IN_WINDOW });
    // exchangeInfo's serverTime can be hours old on live Binance; the scan must not use it.
    if (url.pathname === '/fapi/v1/exchangeInfo')
      return json({ serverTime: IN_WINDOW - 4 * 3_600_000, symbols: EXCHANGE });
    if (url.pathname === '/fapi/v1/ticker/24hr') return json(TICKERS);
    if (url.pathname === '/fapi/v1/ticker/bookTicker' && !symbol) return json(BOOKS);
    if (url.pathname === '/fapi/v1/klines') {
      expect(url.searchParams.get('startTime')).toBe(String(BOUNDARY - 98 * INTERVAL_MS));
      expect(url.searchParams.get('endTime')).toBe(String(BOUNDARY - 1));
      expect(url.searchParams.get('limit')).toBe('98');
      return json(fixture.candles[symbol] ?? []);
    }
    const q = fixture.quotes[symbol];
    if (url.pathname === '/fapi/v1/ticker/bookTicker') return json(q?.bookTicker);
    if (url.pathname === '/fapi/v1/premiumIndex') return json(q?.premiumIndex);
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch: fetchFake, now: () => IN_WINDOW, seen };
}

describe('the command', () => {
  it('scans within the budget and replays its snapshot offline to the same report', async () => {
    const binance = fakeBinance();
    const saved = await scan(binance, s);
    expect(saved.requestWeight).toBe(
      1 + 1 + 40 + 5 + 8 * WEIGHTS.klines + WEIGHTS.bookTicker + WEIGHTS.premiumIndex,
    );
    expect(saved.usedWeight1m).toBe(10);
    expect(binance.seen.slice(0, 2)).toEqual(['/fapi/v1/time', '/fapi/v1/exchangeInfo']);
    expect(binance.seen.slice(4, 9)).toEqual(REFS.map((r) => `/fapi/v1/klines ${r}`));
    expect(saved).toMatchObject({ decisionTime: IN_WINDOW, boundary: BOUNDARY });
    expect(saved.report).toMatchObject({
      status: 'complete',
      counts: { signals: 1, eligibleSignals: 1 },
    });
    expect(saved.report?.signals[0]).toMatchObject({
      symbol: 'AAAUSDT',
      status: 'eligible',
      stop: '100.18',
    });
    const fromDisk = JSON.parse(JSON.stringify(saved)) as Snapshot;
    expect(replay(fromDisk).match).toBe(true);
    expect(
      replay({ ...fromDisk, report: { ...(saved.report as ScanReport), status: 'failed' } }).match,
    ).toBe(false);
    expect(() => replay({ ...fromDisk, rule: { ...RULE, version: '0.9.0' } as never })).toThrow(
      INVALID_SNAPSHOT,
    );
  });

  it('reports contracts the weight budget left out, and a quote the budget could not afford', async () => {
    const partial = await scan(fakeBinance(), { ...s, weightBudget: 53 });
    expect(partial.report).toMatchObject({
      status: 'partial',
      notEvaluated: [
        { symbol: 'NEWUSDT', reason: 'weight budget' },
        { symbol: 'BBBUSDT', reason: 'weight budget' },
      ],
    });
    const noQuote = await scan(fakeBinance(), { ...s, weightBudget: 55 });
    expect(noQuote.report?.signals[0]).toMatchObject({
      status: 'rejected',
      reasons: ['quote unavailable: weight budget'],
    });
    expect(replay(JSON.parse(JSON.stringify(noQuote)) as Snapshot).match).toBe(true);
  });

  it('fails when the decision time is far from the book tickers it read', () => {
    const at = (time: number) => BOOKS.map((b) => ({ ...b, time }));
    expect(evaluateScan(snapshot('UP', { bookTickers: at(BOUNDARY + 190_000) })).status).toBe(
      'complete',
    );
    expect(
      evaluateScan(snapshot('UP', { bookTickers: at(BOUNDARY + 200_000 + 4 * 3_600_000) })),
    ).toMatchObject({
      status: 'failed',
      statusReason:
        'Failed: decision time 2026-11-28T12:03:20.000Z is 14400 s from the newest book ticker 2026-11-28T16:03:20.000Z',
      signals: [],
    });
  });

  it('fails when discovery fails, and stops after a rate limit', async () => {
    const failed = await scan(
      fakeBinance({ '/fapi/v1/exchangeInfo': () => new Response('', { status: 500 }) }),
      s,
    );
    expect(failed.report).toMatchObject({
      status: 'failed',
      statusReason: 'Discovery failed (exchangeInfo: HTTP 500)',
    });
    const limited = fakeBinance({
      '/fapi/v1/ticker/24hr': () => new Response('{}', { status: 429 }),
    });
    const halted = await scan(limited, s);
    expect(halted.report?.status).toBe('failed');
    expect(limited.seen.filter((p) => p.startsWith('/fapi/v1/klines'))).toEqual([]);
  });

  it('takes research settings from flags and refuses invalid ones', () => {
    const settings: ScanSettings = settingsFrom({
      'min-quote-volume': '50000000',
      'weight-budget': '400',
    });
    expect(settings).toEqual({
      ...DEFAULT_SETTINGS,
      minQuoteVolumeUsdt: '50000000',
      weightBudget: 400,
    });
    expect(() => settingsFrom({ concurrency: '0' })).toThrow('Invalid settings: concurrency');
    expect(() => settingsFrom({ 'max-spread-bps': 'ten' })).toThrow(
      'Invalid settings: maxSpreadBps',
    );
  });
});

describe('request failures', () => {
  it('name the network cause behind a thrown fetch error', () => {
    const dns = Object.assign(new Error('getaddrinfo ENOTFOUND fapi.binance.com'), {
      code: 'ENOTFOUND',
    });
    expect(errorReason(new TypeError('fetch failed', { cause: dns }))).toBe(
      'TypeError (ENOTFOUND)',
    );
    // The message is never kept: only a known name and a code-shaped cause.
    expect(errorReason(new DOMException('slow', 'TimeoutError'))).toBe('TimeoutError');
    expect(
      errorReason(
        new TypeError('x', { cause: Object.assign(new Error('y'), { code: 'not a code' }) }),
      ),
    ).toBe('TypeError');
    expect(errorReason(Object.assign(new Error('x'), { name: 'WeirdError' }))).toBe(
      'network error',
    );
    expect(errorReason('boom')).toBe('network error');
  });
});

const SENTINEL = 'SENTINEL-c0ffee-42';

describe('the replay boundary', () => {
  let dir = '';
  let outside = '';
  let valid: Record<string, unknown> = {};
  /** Writes a snapshot file into the temporary snapshot directory. */
  const put = (name: string, body: unknown) =>
    writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  /** Runs the replay command in text or JSON mode, capturing everything it prints or throws. */
  async function run(name: string, json: boolean) {
    const lines: string[] = [];
    let code: number | string;
    try {
      code = await replayCommand(name, json, (text) => lines.push(text), dir);
    } catch (error) {
      code = (error as Error).message;
    }
    return { code, output: lines.join('\n') };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perp-breakout-snapshots-'));
    outside = await mkdtemp(join(tmpdir(), 'perp-breakout-outside-'));
    valid = JSON.parse(JSON.stringify(await scan(fakeBinance(), s))) as Record<string, unknown>;
    await put('valid.json', valid);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('replays a valid saved scan offline to MATCH, in text and JSON', async () => {
    const text = await run('valid.json', false);
    expect(text.code).toBe(0);
    expect(text.output).toContain('Status: COMPLETE');
    expect(text.output).toContain('LONG AAAUSDT · eligible');
    expect(text.output).toMatch(/Replay \(offline\): MATCH$/);
    const json = await run('valid.json', true);
    expect(json.code).toBe(0);
    const [body] = json.output.split('\nReplay (offline): ');
    expect(JSON.parse(body as string)).toEqual(valid['report']);
    expect(json.output).toMatch(/Replay \(offline\): MATCH$/);
  });

  it('refuses a snapshot with a sentinel in any diagnostic field without printing it', async () => {
    const quotes = valid['quotes'] as Record<string, QuoteRecord>;
    const variants: Record<string, unknown> = {
      'failure.json': { ...valid, failures: { 'klines AAAUSDT': SENTINEL } },
      'failure-key.json': { ...valid, failures: { [SENTINEL]: 'HTTP 500' } },
      'not-evaluated.json': { ...valid, notEvaluated: { AAAUSDT: SENTINEL } },
      'quote.json': {
        ...valid,
        quotes: { AAAUSDT: { ...quotes['AAAUSDT'], failure: `HTTP 503; ${SENTINEL}` } },
      },
      'error-message.json': { ...valid, failures: { time: `TypeError: ${SENTINEL}` } },
      'settings.json': {
        ...valid,
        settings: { ...(valid['settings'] as object), maxSpreadBps: SENTINEL },
      },
      'rule.json': { ...valid, rule: { ...RULE, version: SENTINEL } },
      'not-json.json': `{"schema": "${SENTINEL}"`,
      'array.json': [SENTINEL],
    };
    for (const [name, body] of Object.entries(variants)) {
      await put(name, body);
      for (const json of [false, true]) {
        const { code, output } = await run(name, json);
        expect(code, name).toBe(INVALID_SNAPSHOT);
        expect(output, name).toBe('');
        expect(String(code)).not.toContain('SENTINEL');
      }
    }
  });

  it('reads only regular files whose real path is in the snapshot directory', async () => {
    await writeFile(join(outside, 'elsewhere.json'), JSON.stringify(valid));
    await symlink(join(outside, 'elsewhere.json'), join(dir, 'link-out.json'));
    await symlink(join(dir, 'valid.json'), join(dir, 'link-in.json'));
    await mkdir(join(dir, 'folder.json'));
    expect(await snapshotFile('link-in.json', dir)).toMatch(/valid\.json$/);
    expect((await run('link-in.json', false)).output).toMatch(/MATCH$/);
    for (const name of ['link-out.json', 'folder.json', 'missing.json', '../x.json', 'valid.txt']) {
      await expect(snapshotFile(name, dir), name).rejects.toThrow(OUTSIDE_SNAPSHOT_DIR);
    }
    // A path to the same file is accepted; a path to another directory is not.
    expect(await snapshotFile(join(dir, 'valid.json'), dir)).toMatch(/valid\.json$/);
    await expect(snapshotFile(join(outside, 'elsewhere.json'), dir)).rejects.toThrow(
      OUTSIDE_SNAPSHOT_DIR,
    );
  });

  it('normalizes market data without changing a decision and rebuilds diagnostics', () => {
    const normalized = normalizeSnapshot(valid) as Snapshot;
    expect(evaluateScan(normalized)).toEqual(valid['report']);
    // Decimals are re-rendered from their exact values; settings are checked at runtime.
    const padded = {
      ...valid,
      settings: { ...(valid['settings'] as object), maxSpreadBps: '10.000' },
    };
    expect(normalizeSnapshot(padded)?.settings.maxSpreadBps).toBe('10');
    expect(
      normalizeSnapshot({
        ...valid,
        settings: { ...(valid['settings'] as object), concurrency: 0 },
      }),
    ).toBeNull();
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, weightBudget: '1000' })).toBeNull();
    expect(diagnostic('HTTP 503')).toBe('HTTP 503');
    expect(diagnostic('TypeError (ENOTFOUND)')).toBe('TypeError (ENOTFOUND)');
    expect(diagnostic('weight budget')).toBe('weight budget');
    expect(diagnostic('HTTP 999')).toBeNull();
    expect(diagnostic('Oops (ENOTFOUND)')).toBeNull();
    // Unreadable market values stay unreadable: the same rejection follows.
    const broken = { ...valid, tickers24h: [{ symbol: 'AAAUSDT', quoteVolume: 'lots' }] };
    expect(evaluateScan(normalizeSnapshot(broken) as Snapshot).screenRejected).toContainEqual({
      symbol: 'AAAUSDT',
      reason: '24h quote volume invalid',
    });
  });
});
