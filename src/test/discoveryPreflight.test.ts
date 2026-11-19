import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handleDiscoveryPreflight,
  PREFLIGHT_ENDPOINTS,
  PREFLIGHT_REGION,
  PREFLIGHT_TIMEOUT_MS,
  type PreflightReport,
} from '../../supabase/functions/discovery-preflight/handler';
import { REQUEST_BOUNDS } from '../../scripts/dailyDiscovery';
import { DISCOVERY_POLICY, parseExchangeInfo, parseTickers } from '@/lib/dailyDiscovery';
import {
  at,
  binanceFake,
  json,
  syntheticMarket,
  testClock,
  timeoutError,
  type Scripted,
  type SyntheticMarket,
} from './dailyDiscoveryFixtures';

// SYNTHETIC only: invented ZCT pairs, volumes and keys. No request leaves the test.
const SECRET = 'sb_secret_synthetic_for_tests';
const ENV: Record<string, string> = {
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  SB_REGION: PREFLIGHT_REGION,
};
const URL_ = 'https://example.supabase.co/functions/v1/discovery-preflight';
const ENDPOINTS = [PREFLIGHT_ENDPOINTS.exchangeInfo, PREFLIGHT_ENDPOINTS.ticker];

function run(
  options: {
    market?: SyntheticMarket;
    script?: { exchangeInfo?: readonly Scripted[]; ticker?: readonly Scripted[] };
    env?: Record<string, string | undefined>;
    request?: Request;
  } = {},
) {
  const clock = testClock(at(0, 31));
  const binance = binanceFake(options.market ?? syntheticMarket(), clock, options.script);
  const signals: unknown[] = [];
  const logs: string[] = [];
  const env = { ...ENV, ...options.env };
  const response = handleDiscoveryPreflight(
    options.request ?? new Request(URL_, { method: 'POST', headers: { apikey: SECRET } }),
    {
      env: (name) => env[name],
      fetch: ((input: string, init?: RequestInit) => {
        signals.push(init?.signal);
        return binance.fetch(input);
      }) as typeof fetch,
      now: clock.now,
      log: (line) => logs.push(line),
    },
  );
  return { response, calls: binance.calls, signals, logs };
}

async function report(response: Promise<Response>) {
  const res = await response;
  return { status: res.status, body: (await res.json()) as PreflightReport };
}

describe('discovery preflight endpoints', () => {
  it('asks exactly the policy’s two endpoints, with the collector’s timeout', () => {
    expect(PREFLIGHT_ENDPOINTS).toEqual({
      exchangeInfo: DISCOVERY_POLICY.source.exchangeInfo,
      ticker: DISCOVERY_POLICY.source.ticker,
    });
    expect(PREFLIGHT_TIMEOUT_MS).toBe(REQUEST_BOUNDS.timeoutMs);
    expect(PREFLIGHT_REGION).toBe('eu-west-1');
  });
});

describe('discovery preflight on a healthy synthetic market', () => {
  it('reports both endpoints reachable with aggregate counts only', async () => {
    const { response, calls, signals, logs } = run();
    const { status, body } = await report(response);
    expect(status).toBe(200);
    expect(calls).toEqual(ENDPOINTS);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(body).toEqual({
      region: 'eu-west-1',
      checkedAt: new Date(at(0, 31)).toISOString(),
      reachable: true,
      exchangeInfo: {
        status: 200,
        durationMs: 0,
        outcome: 'ok',
        // 60 ZCT, USDC, XAUT, BTC, a halted and a no-spot pair, and one BTC-quoted pair.
        listedSymbols: 66,
        usdtInstruments: 65,
        tradingSpotUsdt: 63,
        malformedInstruments: 0,
      },
      ticker: {
        status: 200,
        durationMs: 0,
        outcome: 'ok',
        entries: 66,
        validFigures: 63,
        invalidFigures: 0,
      },
    });
    // No pair, volume or body leaves the function, in the answer or the log.
    for (const text of [JSON.stringify(body), ...logs]) {
      expect(text).not.toMatch(/ZCT|BTC|USDC|XAUT|quoteVolume|000000\.5/);
    }
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ event: 'preflight', reachable: true });
  });

  it('counts what the collector’s own parsers count', async () => {
    const market = syntheticMarket({
      volumeOf: (symbol, fallback) =>
        symbol === 'ZCT002USDT' ? 1.5 : symbol === 'ZCT003USDT' ? '1e6' : fallback,
    });
    market.instruments.push({ symbol: 'BAD SYMBOL', quoteAsset: 'USDT' }, 'not an object', {
      symbol: 'ZCTNOFLAGUSDT',
      quoteAsset: 'USDT',
      baseAsset: 'ZCTNOFLAG',
      status: 'TRADING',
    });
    const { response } = run({ market });
    const { body } = await report(response);

    const now = at(0, 31);
    const parsed = parseExchangeInfo({ serverTime: now, symbols: market.instruments });
    const tradable = (parsed?.usdtInstruments ?? [])
      .filter((i) => i.status === 'TRADING' && i.spotTradingAllowed)
      .map((i) => i.symbol);
    const figures = parseTickers(market.tickers(now), tradable, {
      requestedAt: now,
      receivedAt: now,
    });
    expect(body.exchangeInfo).toMatchObject({
      outcome: 'ok',
      usdtInstruments: parsed?.usdtInstruments.length,
      tradingSpotUsdt: tradable.length,
      malformedInstruments: parsed?.malformedInstruments,
    });
    expect(body.exchangeInfo.malformedInstruments).toBe(3);
    expect(body.ticker).toMatchObject({
      outcome: 'ok',
      validFigures: figures?.tickers.length,
      invalidFigures: figures?.invalidTickers.length,
    });
    expect(body.ticker.invalidFigures).toBe(2);
  });
});

describe('discovery preflight refuses before asking Binance', () => {
  const refused = async (
    request: Request,
    env: Record<string, string | undefined> = {},
  ): Promise<{ status: number; body: unknown; calls: string[] }> => {
    const { response, calls, logs } = run({ request, env });
    const res = await response;
    expect(logs).toEqual([]);
    return { status: res.status, body: await res.json(), calls };
  };
  const post = (headers: Record<string, string> = {}) =>
    new Request(URL_, { method: 'POST', headers });

  it('accepts POST only', async () => {
    const result = await refused(new Request(URL_, { headers: { apikey: SECRET } }));
    expect(result).toMatchObject({ status: 405, calls: [] });
  });

  it('needs a project secret key', async () => {
    expect(await refused(post())).toMatchObject({ status: 401, calls: [] });
    expect(await refused(post({ apikey: 'sb_publishable_synthetic' }))).toMatchObject({
      status: 401,
      calls: [],
    });
    expect(
      await refused(post({ apikey: SECRET }), { SUPABASE_SECRET_KEYS: 'not json' }),
    ).toMatchObject({ status: 401, calls: [] });
    expect(
      await refused(post({ apikey: SECRET }), { SUPABASE_SECRET_KEYS: undefined }),
    ).toMatchObject({ status: 401, calls: [] });
  });

  it('runs only in eu-west-1, never silently elsewhere', async () => {
    expect(await refused(post({ apikey: SECRET }), { SB_REGION: 'eu-central-2' })).toEqual({
      status: 421,
      body: { error: 'Wrong region', region: 'eu-central-2', expected: 'eu-west-1' },
      calls: [],
    });
    expect(await refused(post({ apikey: SECRET }), { SB_REGION: undefined })).toMatchObject({
      status: 421,
      body: { region: null },
      calls: [],
    });
  });

  it('is not a proxy: the request cannot choose what is fetched', async () => {
    const request = new Request(`${URL_}?url=https://example.com/`, {
      method: 'POST',
      headers: { apikey: SECRET, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/', endpoint: '/api/v3/account' }),
    });
    const { response, calls } = run({ request });
    expect((await response).status).toBe(200);
    expect(calls).toEqual(ENDPOINTS);
  });
});

describe('discovery preflight failures', () => {
  const failing = (status: number) => () => json(status, { code: 0, msg: 'synthetic' });

  it('reports a regional block on exchangeInfo and does not ask for the ticker', async () => {
    const { response, calls, logs } = run({ script: { exchangeInfo: [failing(451)] } });
    const { status, body } = await report(response);
    expect(status).toBe(502);
    expect(calls).toEqual([PREFLIGHT_ENDPOINTS.exchangeInfo]);
    expect(body.reachable).toBe(false);
    expect(body.exchangeInfo).toMatchObject({
      status: 451,
      outcome: 'http_error',
      listedSymbols: null,
    });
    expect(body.ticker).toEqual({
      status: null,
      durationMs: null,
      outcome: 'not_requested',
      entries: null,
      validFigures: null,
      invalidFigures: null,
    });
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ reachable: false });
  });

  it.each([202, 429, 418, 500, 503])(
    'reports HTTP %i on the ticker once, without retrying',
    async (code) => {
      const { response, calls } = run({ script: { ticker: [failing(code)] } });
      const { status, body } = await report(response);
      expect(status).toBe(502);
      expect(calls).toEqual(ENDPOINTS);
      expect(body.exchangeInfo.outcome).toBe('ok');
      expect(body.ticker).toMatchObject({ status: code, outcome: 'http_error', entries: null });
    },
  );

  it('reports timeouts and network errors', async () => {
    const throwing = (error: Error) => () => Promise.reject(error);
    let result = await report(
      run({ script: { exchangeInfo: [throwing(timeoutError())] } }).response,
    );
    expect(result.body.exchangeInfo).toMatchObject({ status: null, outcome: 'timeout' });

    result = await report(run({ script: { ticker: [throwing(timeoutError())] } }).response);
    expect(result.body.ticker).toMatchObject({ status: null, outcome: 'timeout' });

    result = await report(
      run({ script: { exchangeInfo: [throwing(new TypeError('fetch failed'))] } }).response,
    );
    expect(result).toMatchObject({
      status: 502,
      body: { exchangeInfo: { outcome: 'network_error' } },
    });

    const stalledBody = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(timeoutError());
          },
        }),
        { status: 200 },
      );
    result = await report(run({ script: { ticker: [stalledBody] } }).response);
    expect(result.body.ticker).toMatchObject({ status: 200, outcome: 'timeout' });
  });

  it('rejects malformed exchangeInfo responses', async () => {
    const answers: [string, Scripted][] = [
      ['not JSON', () => new Response('<html>', { status: 200 })],
      ['no serverTime', () => json(200, { symbols: [] })],
      ['symbols not a list', () => json(200, { serverTime: at(0, 31), symbols: {} })],
      ['a list', () => json(200, [])],
      [
        'no tradable USDT pair',
        () =>
          json(200, {
            serverTime: at(0, 31),
            symbols: [{ symbol: 'ZCT001BTC', quoteAsset: 'BTC' }],
          }),
      ],
    ];
    for (const [label, answer] of answers) {
      const { response, calls } = run({ script: { exchangeInfo: [answer] } });
      const { status, body } = await report(response);
      expect({ label, status, calls }).toEqual({
        label,
        status: 502,
        calls: [PREFLIGHT_ENDPOINTS.exchangeInfo],
      });
      expect(body.exchangeInfo.outcome).toBe(
        label === 'not JSON' ? 'not_json' : 'invalid_structure',
      );
      expect(body.ticker.outcome).toBe('not_requested');
    }
  });

  it('rejects malformed ticker responses', async () => {
    const now = at(0, 31);
    const allInvalid = syntheticMarket({ volumeOf: () => 12.5 });
    const answers: [string, Scripted][] = [
      ['an error object', () => json(200, { code: -1121, msg: 'synthetic' })],
      ['an empty list', () => json(200, [])],
      ['no valid figure', () => json(200, allInvalid.tickers(now))],
      [
        'only stale windows',
        () =>
          json(
            200,
            syntheticMarket()
              .tickers(now)
              .map((t) => ({
                ...(t as object),
                closeTime: now - 2 * 3_600_000,
                openTime: now - 26 * 3_600_000,
              })),
          ),
      ],
      [
        'only 23-hour windows',
        () =>
          json(
            200,
            syntheticMarket()
              .tickers(now)
              .map((t) => ({ ...(t as object), closeTime: now, openTime: now - 23 * 3_600_000 })),
          ),
      ],
    ];
    for (const [label, answer] of answers) {
      const { response, calls } = run({ script: { ticker: [answer] } });
      const { status, body } = await report(response);
      expect({ label, status, calls, outcome: body.ticker.outcome }).toEqual({
        label,
        status: 502,
        calls: ENDPOINTS,
        outcome: 'invalid_structure',
      });
      expect(body.ticker.validFigures ?? 0).toBe(0);
    }
  });
});

describe('discovery preflight has no storage path', () => {
  const dir = path.resolve(__dirname, '../../supabase/functions/discovery-preflight');
  const source = (file: string) => readFileSync(path.join(dir, file), 'utf8');

  it('imports nothing but its own handler and holds no database client or key', () => {
    const handler = source('handler.ts');
    const index = source('index.ts');
    expect(handler).not.toMatch(/^import /m);
    expect([...index.matchAll(/^import .* from '(.+)';$/gm)].map((m) => m[1])).toEqual([
      './handler.ts',
    ]);
    for (const text of [handler, index]) {
      expect(text).not.toMatch(
        /supabase-js|createClient|_shared\/feed|SERVICE_ROLE|\.from\(|\.rpc\(/,
      );
    }
  });

  it('sends only GETs to the two fixed Binance URLs', async () => {
    const methods: string[] = [];
    const urls: string[] = [];
    const clock = testClock(at(0, 31));
    const binance = binanceFake(syntheticMarket(), clock);
    await handleDiscoveryPreflight(
      new Request(URL_, { method: 'POST', headers: { apikey: SECRET } }),
      {
        env: (name) => ENV[name],
        fetch: ((input: string, init?: RequestInit) => {
          urls.push(input);
          methods.push(init?.method ?? 'GET');
          return binance.fetch(input);
        }) as typeof fetch,
        now: clock.now,
        log: () => undefined,
      },
    );
    expect(urls).toEqual(ENDPOINTS);
    expect(methods).toEqual(['GET', 'GET']);
  });
});
