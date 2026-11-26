import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkResponse,
  checkRow,
  compareDecimal,
  ohlcParity,
  probeRequests,
  runProbe,
  summarize,
  validateProbe,
} from './binanceActivityProbe';

const START = Date.parse('2024-11-22T00:00:00.000Z');
const HOUR = 3_600_000;
const LATER = START + 10 * 86_400_000;

/** A synthetic, internally consistent 1h kline row (field order as Binance documents it). */
function row(hour: number, overrides: Record<number, unknown> = {}): unknown[] {
  const open = START + hour * HOUR;
  const base: unknown[] = [
    open,
    '100.00000000',
    '101.00000000',
    '99.00000000',
    '100.50000000',
    '10.00000000',
    open + HOUR - 1,
    '1000.00000000',
    50,
    '6.00000000',
    '600.00000000',
    '0',
  ];
  for (const [index, value] of Object.entries(overrides)) base[Number(index)] = value;
  return base;
}

const day = () => Array.from({ length: 24 }, (_, hour) => row(hour));

describe('probeRequests', () => {
  it('builds the plan bound: pairs × dates, UTC days, 24 hourly candles each', () => {
    const requests = probeRequests({
      pairs: ['BTCUSDT', 'ETHUSDT'],
      dates: ['2024-11-22', '2026-11-21'],
    });
    expect(requests.map((r) => `${r.symbol} ${r.date}`)).toEqual([
      'BTCUSDT 2024-11-22',
      'BTCUSDT 2026-11-21',
      'ETHUSDT 2024-11-22',
      'ETHUSDT 2026-11-21',
    ]);
    const [first] = requests;
    expect(first?.startTime).toBe(START);
    expect(first?.endTime).toBe(START + 24 * HOUR - 1);
    expect(first?.url).toBe(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h' +
        `&startTime=${START}&endTime=${START + 24 * HOUR - 1}&limit=24`,
    );
  });

  it('refuses more than 60 requests and unexpected symbols', () => {
    const pairs = Array.from({ length: 21 }, (_, i) => `P${i}USDT`);
    expect(() =>
      probeRequests({ pairs, dates: ['2024-11-22', '2025-11-22', '2026-11-21'] }),
    ).toThrow(/exceed the authorized 60/);
    expect(() => probeRequests({ pairs: ['BTC&x=1'], dates: ['2024-11-22'] })).toThrow(/symbol/);
  });
});

describe('compareDecimal', () => {
  it('compares exactly across different decimal widths', () => {
    expect(compareDecimal('6.00000000', '6')).toBe(0);
    expect(compareDecimal('0.30000001', '0.3')).toBe(1);
    expect(compareDecimal('148976.1', '148976.11427815')).toBe(-1);
  });
});

describe('checkRow', () => {
  it('accepts a consistent row and reports the taker-buy share of quote volume', () => {
    const check = checkRow(row(0), START, LATER);
    expect(check).toMatchObject({
      status: 'VALID',
      issues: [],
      takerBuyShare: 0.6,
      closeTime: START + HOUR - 1,
    });
    expect(check.ohlc).toEqual([100, 101, 99, 100.5]);
  });

  it('classifies an hour without trades as a valid zero', () => {
    const zero = row(0, {
      5: '0.00000000',
      7: '0.00000000',
      8: 0,
      9: '0.00000000',
      10: '0.00000000',
    });
    expect(checkRow(zero, START, LATER)).toMatchObject({
      status: 'VALID_ZERO',
      takerBuyShare: null,
    });
  });

  it.each([
    ['taker-buy base above base volume', { 9: '10.00000001' }],
    ['taker-buy quote above quote volume', { 10: '1000.1', 9: '9.99' }],
    ['number of trades and base volume disagree on zero', { 8: 0 }],
    ['zero base volume with nonzero quote or taker-buy volume', { 5: '0', 8: 0, 9: '0', 10: '0' }],
    ['quote ÷ base outside [low, high]', { 7: '2000.00000000', 10: '600' }],
    ['taker-buy quote ÷ taker-buy base outside [low, high]', { 10: '700.00000000' }],
    ['high below open, close or low', { 2: '100.10000000' }],
    ['low above open or close', { 3: '100.20000000' }],
  ])('flags %s', (issue, overrides) => {
    const check = checkRow(row(0, overrides), START, LATER);
    expect(check.status).toBe('INVALID');
    expect(check.issues).toContain(issue);
  });

  it.each([
    ['number of trades is not a nonnegative integer', { 8: 50.5 }],
    ['number of trades is not a nonnegative integer', { 8: '50' }],
    ['base volume is not a nonnegative decimal string', { 5: 10 }],
    ['taker-buy quote is not a nonnegative decimal string', { 10: '-1' }],
    ['close time is not open time + 3,599,999', { 6: START + HOUR }],
  ])('flags a type error: %s', (issue, overrides) => {
    expect(checkRow(row(0, overrides), START, LATER)).toMatchObject({
      status: 'INVALID',
      issues: [issue],
    });
  });

  it('flags a candle still open when the request was sent', () => {
    expect(checkRow(row(0), START, START + HOUR - 1).issues).toEqual([
      'candle had not closed when the request was sent',
    ]);
  });

  it('treats a short row or a null field as missing, not invalid', () => {
    expect(checkRow(row(0).slice(0, 11), START, LATER).status).toBe('MISSING');
    expect(checkRow(row(0, { 9: null }), START, LATER).status).toBe('MISSING');
  });
});

describe('checkResponse', () => {
  it('accepts 24 ordered hours', () => {
    const result = checkResponse(day(), START, LATER);
    expect(result.issues).toEqual([]);
    expect(result.hours.map((hour) => hour.status)).toEqual(Array(24).fill('VALID'));
  });

  it('marks absent hours missing and duplicates invalid, never filling either', () => {
    const rows = day();
    rows.splice(5, 1);
    rows.splice(9, 0, row(9));
    const result = checkResponse(rows, START, LATER);
    expect(result.issues).toEqual(['row 9: open time not increasing']);
    expect(result.hours[5]).toMatchObject({ status: 'MISSING', issues: ['no row for this hour'] });
    expect(result.hours[9]).toMatchObject({ status: 'INVALID', issues: ['duplicate open time'] });
  });

  it('reports rows outside the requested day and a non-array body', () => {
    const shifted = [...day().slice(1), row(24)];
    expect(checkResponse(shifted, START, LATER).issues).toContain(
      'row 23: open time outside the requested hours',
    );
    const broken = checkResponse({ code: -1121 }, START, LATER);
    expect(broken.issues).toEqual(['response is not an array']);
    expect(broken.hours.every((hour) => hour.status === 'MISSING')).toBe(true);
  });
});

describe('ohlcParity', () => {
  it('compares parsed OHLC and close time with v1 and lists every difference', () => {
    const hours = checkResponse(day().slice(0, 24), START, LATER).hours.slice(0, 3);
    const saved = (hour: number, close = 100.5) => ({
      timestamp: START + hour * HOUR,
      closeTime: START + (hour + 1) * HOUR - 1,
      open: 100,
      high: 101,
      low: 99,
      close,
    });
    const v1 = new Map([saved(0), saved(1, 100.51)].map((c) => [c.timestamp, c]));
    expect(ohlcParity(hours, v1)).toEqual({
      compared: 2,
      absent: 1,
      mismatches: [{ openTime: START + HOUR, field: 'close', probe: 100.5, v1: 100.51 }],
    });
  });
});

describe('summarize', () => {
  it('counts statuses and issues and gives the taker-buy share range', () => {
    const hours = checkResponse(
      [row(0), row(1, { 10: '0.00000000', 9: '0.00000000' }), row(2, { 9: '11' })],
      START,
      LATER,
    ).hours.map((hour) => ({ ...hour, symbol: 'BTCUSDT', date: '2024-11-22' }));
    const summary = summarize(hours);
    expect(summary.status).toEqual({ VALID: 2, VALID_ZERO: 0, MISSING: 21, INVALID: 1 });
    expect(summary.issues['taker-buy base above base volume']).toBe(1);
    expect(summary.ignoreFieldValues).toEqual(['"0"']);
    expect(summary.takerBuyShareOfQuote).toEqual({
      hours: 3,
      min: 0,
      max: 0.6,
      exactlyZero: 1,
      exactlyOne: 0,
    });
  });
});

describe('runProbe', () => {
  const requests = probeRequests({ pairs: ['BTCUSDT', 'ETHUSDT'], dates: ['2024-11-22'] });
  const reply = (status: number, headers: Record<string, string> = {}, body = '[]') =>
    new Response(body, { status, headers });

  function io(replies: Response[]) {
    const saved: string[] = [];
    const slept: number[] = [];
    let clock = LATER;
    return {
      saved,
      slept,
      io: {
        fetchImpl: async () => {
          const next = replies.shift();
          if (!next) throw new Error('network down');
          return next;
        },
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        now: () => (clock += 1000),
        save: async (name: string) => {
          saved.push(name);
        },
      },
    };
  }

  it('saves 200 responses with hashes and paces requests', async () => {
    const run = io([reply(200, { 'x-mbx-used-weight-1m': '2' }), reply(200)]);
    const { log, stopped } = await runProbe(requests, run.io);
    expect(stopped).toBeNull();
    expect(run.saved).toEqual(['raw/BTCUSDT-2024-11-22.json', 'raw/ETHUSDT-2024-11-22.json']);
    expect(log[0]).toMatchObject({ counted: true, status: 200, usedWeight1m: 2, bytes: 2 });
    expect(log[0]?.sha256).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    expect(run.slept).toEqual([250, 250]);
  });

  it('retries a 429 once after Retry-After without counting it, and stops on a second', async () => {
    const once = io([reply(429, { 'retry-after': '3' }), reply(200), reply(200)]);
    const first = await runProbe(requests, once.io);
    expect(first.stopped).toBeNull();
    expect(first.log.map((e) => [e.status, e.counted])).toEqual([
      [429, false],
      [200, true],
      [200, true],
    ]);
    expect(once.slept[0]).toBe(3000);

    const twice = io([reply(429, { 'retry-after': '3' }), reply(429, { 'retry-after': '3' })]);
    expect((await runProbe(requests, twice.io)).stopped).toBe('HTTP 429 on BTCUSDT 2024-11-22');
  });

  it('stops on 403, 418, 451, a long Retry-After or high used weight', async () => {
    for (const status of [403, 418, 451]) {
      const run = io([reply(status)]);
      expect((await runProbe(requests, run.io)).stopped).toBe(
        `HTTP ${status} on BTCUSDT 2024-11-22`,
      );
      expect(run.saved).toEqual([]);
    }
    expect(
      (await runProbe(requests, io([reply(429, { 'retry-after': '600' })]).io)).stopped,
    ).toMatch(/Retry-After 600/);
    const heavy = io([reply(200, { 'x-mbx-used-weight-1m': '3001' })]);
    expect((await runProbe(requests, heavy.io)).stopped).toMatch(/3001 above 3000/);
  });

  it('records other failures and continues without retrying', async () => {
    const run = io([reply(500)]);
    const { log, stopped } = await runProbe(requests, run.io);
    expect(stopped).toBeNull();
    expect(log.map((e) => [e.symbol, e.status, e.error ?? null])).toEqual([
      ['BTCUSDT', 500, null],
      ['ETHUSDT', null, 'Error: network down'],
    ]);
    expect(run.saved).toEqual([]);
  });
});

describe('validateProbe', () => {
  it('checks saved responses against their hashes and v1, and writes validation.json once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'activity-probe-'));
    const out = join(root, '.zerochart-market-data/binance-activity-probe-2026-11-26');
    const v1Dir = join(root, '.zerochart-market-data/spot-24h-v1/klines');
    await mkdir(join(out, 'raw'), { recursive: true });
    await mkdir(v1Dir, { recursive: true });
    const body = JSON.stringify([...day().slice(0, 23), row(23, { 9: '20' })]);
    await writeFile(join(out, 'raw/BTCUSDT-2024-11-22.json'), body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const entry = { symbol: 'BTCUSDT', date: '2024-11-22', sentAt: new Date(LATER).toISOString() };
    const log = [
      { ...entry, counted: false, status: 429, sha256: null },
      { ...entry, counted: true, status: 200, sha256 },
    ];
    await writeFile(join(out, 'manifest.json'), JSON.stringify({ log }));
    const candles = Array.from({ length: 24 }, (_, hour) => ({
      timestamp: START + hour * HOUR,
      closeTime: START + (hour + 1) * HOUR - 1,
      open: 100,
      high: 101,
      low: 99,
      close: hour === 2 ? 100.4 : 100.5,
    }));
    await writeFile(join(v1Dir, 'BTCUSDT-1h.json'), JSON.stringify({ candles }));

    const validation = await validateProbe(root);
    expect(validation.requestsValidated).toBe(1);
    expect(validation.summary.status).toEqual({ VALID: 23, VALID_ZERO: 0, MISSING: 0, INVALID: 1 });
    expect(validation.perRequest[0]?.notValid).toEqual([
      {
        openTime: START + 23 * HOUR,
        status: 'INVALID',
        issues: [
          'taker-buy base above base volume',
          'taker-buy quote ÷ taker-buy base outside [low, high]',
        ],
      },
    ]);
    expect(validation.ohlcParityWithV1).toEqual({
      compared: 24,
      absent: 0,
      mismatches: [
        { symbol: 'BTCUSDT', openTime: START + 2 * HOUR, field: 'close', probe: 100.5, v1: 100.4 },
      ],
    });
    await expect(validateProbe(root)).rejects.toThrow(/EEXIST/);

    await writeFile(join(out, 'raw/BTCUSDT-2024-11-22.json'), `${body} `);
    await rm(join(out, 'validation.json'));
    await expect(validateProbe(root)).rejects.toThrow(/hash changed/);
    await rm(root, { recursive: true });
  });
});
