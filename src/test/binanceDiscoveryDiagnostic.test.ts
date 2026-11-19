import { describe, expect, it } from 'vitest';
import {
  ENDPOINTS,
  handleDiagnostic,
} from '../../supabase/functions/binance-discovery-diagnostic/handler';

const SECRET = 'fake-project-secret-key';
const ENV: Record<string, string> = {
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  SB_REGION: 'eu-west-1',
};

const exchangeInfo = {
  serverTime: 1_800_000_000_000,
  symbols: [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      isSpotTradingAllowed: true,
    },
    {
      symbol: 'ETHBTC',
      baseAsset: 'ETH',
      quoteAsset: 'BTC',
      status: 'TRADING',
      isSpotTradingAllowed: true,
    },
  ],
};

const tickers = [
  {
    symbol: 'BTCUSDT',
    quoteVolume: '1200000000.12340000',
    openTime: 1_799_913_600_000,
    closeTime: 1_800_000_000_000,
  },
];

type Reply = Response | Error;

async function call(
  options: {
    method?: string;
    apikey?: string | null;
    env?: Record<string, string | undefined>;
    exchangeInfo?: Reply;
    tickers?: Reply;
    body?: unknown;
    clock?: number[];
  } = {},
) {
  const env = { ...ENV, ...options.env };
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const replies: Record<string, Reply> = {
    [ENDPOINTS.exchangeInfo]:
      options.exchangeInfo ?? new Response(JSON.stringify(exchangeInfo), { status: 200 }),
    [ENDPOINTS.ticker24hr]:
      options.tickers ?? new Response(JSON.stringify(tickers), { status: 200 }),
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const reply = replies[`${url.pathname}${url.search}`];
    if (reply === undefined) throw new Error(`Unexpected URL: ${url}`);
    if (reply instanceof Error) throw reply;
    return reply;
  }) as typeof fetch;
  const clock = [...(options.clock ?? [0, 0, 8, 13])];
  let last = 0;
  const apikey = options.apikey === undefined ? SECRET : options.apikey;
  const req = new Request(
    'https://project.supabase.test/functions/v1/binance-discovery-diagnostic',
    {
      method: options.method ?? 'POST',
      headers: {
        ...(apikey === null ? {} : { apikey }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
  );
  const response = await handleDiagnostic(req, {
    env: (name) => env[name],
    fetch: fakeFetch,
    now: () => (last = clock.shift() ?? last),
  });
  return {
    response,
    body: (await response.json()) as Record<string, unknown>,
    requests,
  };
}

describe('Binance discovery diagnostic authorization', () => {
  it.each([
    ['a missing key', null, undefined],
    ['a wrong key', 'wrong', undefined],
    ['malformed configured keys', SECRET, '{'],
  ])('refuses %s before any outbound request', async (_, apikey, configuredKeys) => {
    const result = await call({
      apikey,
      ...(configuredKeys === undefined ? {} : { env: { SUPABASE_SECRET_KEYS: configuredKeys } }),
    });
    expect(result.response.status).toBe(401);
    expect(result.body).toEqual({ error: 'Unauthorized' });
    expect(result.requests).toEqual([]);
  });

  it('refuses non-POST methods before any outbound request', async () => {
    const result = await call({ method: 'GET' });
    expect(result.response.status).toBe(405);
    expect(result.requests).toEqual([]);
  });
});

describe('Binance discovery diagnostic probes', () => {
  it('checks only the two fixed policy endpoints and returns aggregate results', async () => {
    const result = await call({
      body: { url: 'https://example.com/not-allowed' },
      clock: [100, 200, 108, 213],
    });

    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({
      ok: true,
      region: 'eu-west-1',
      probes: [
        {
          endpoint: 'exchangeInfo',
          ok: true,
          status: 200,
          durationMs: 8,
          counts: { listedSymbols: 2, usdtSymbols: 1 },
        },
        {
          endpoint: 'ticker24hr',
          ok: true,
          status: 200,
          durationMs: 13,
          counts: { entries: 1 },
        },
      ],
    });
    expect(result.requests.map(({ url }) => url.toString())).toEqual([
      `https://api.binance.com${ENDPOINTS.exchangeInfo}`,
      `https://api.binance.com${ENDPOINTS.ticker24hr}`,
    ]);
    for (const request of result.requests) {
      expect(request.init?.method).toBe('GET');
      expect(new Headers(request.init?.headers).get('User-Agent')).toBe('Mozilla/5.0');
      expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('reports both probes when one endpoint returns an upstream error', async () => {
    const result = await call({
      exchangeInfo: new Response('restricted body must not be returned', { status: 451 }),
    });
    expect(result.response.status).toBe(502);
    expect(result.requests).toHaveLength(2);
    expect(result.body).toMatchObject({
      ok: false,
      probes: [
        { endpoint: 'exchangeInfo', ok: false, status: 451, error: 'UPSTREAM_HTTP' },
        { endpoint: 'ticker24hr', ok: true, status: 200 },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain('restricted body');
  });

  it.each([
    ['exchangeInfo without symbols', { serverTime: 1_800_000_000_000 }],
    ['exchangeInfo with a malformed symbol', { ...exchangeInfo, symbols: [{}] }],
  ])('rejects malformed %s responses', async (_, body) => {
    const result = await call({
      exchangeInfo: new Response(JSON.stringify(body), { status: 200 }),
    });
    expect(result.response.status).toBe(502);
    expect(result.body).toMatchObject({
      ok: false,
      probes: [
        { endpoint: 'exchangeInfo', error: 'MALFORMED_RESPONSE' },
        { endpoint: 'ticker24hr', ok: true },
      ],
    });
  });

  it.each([
    ['a non-array ticker response', { code: 0, msg: 'not a ticker list' }],
    ['a malformed ticker entry', [{ symbol: 'BTCUSDT', quoteVolume: 'not-decimal' }]],
  ])('rejects %s', async (_, body) => {
    const result = await call({
      tickers: new Response(JSON.stringify(body), { status: 200 }),
    });
    expect(result.response.status).toBe(502);
    expect(result.body).toMatchObject({
      ok: false,
      probes: [
        { endpoint: 'exchangeInfo', ok: true },
        { endpoint: 'ticker24hr', error: 'MALFORMED_RESPONSE' },
      ],
    });
  });

  it('distinguishes timeouts from other network errors', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const timedOut = await call({ exchangeInfo: timeout });
    expect(timedOut.response.status).toBe(504);
    expect(timedOut.body).toMatchObject({
      probes: [
        { endpoint: 'exchangeInfo', status: null, error: 'TIMEOUT' },
        { endpoint: 'ticker24hr', ok: true },
      ],
    });

    const failed = await call({ tickers: new TypeError('fetch failed') });
    expect(failed.response.status).toBe(502);
    expect(failed.body).toMatchObject({
      probes: [
        { endpoint: 'exchangeInfo', ok: true },
        { endpoint: 'ticker24hr', status: null, error: 'NETWORK_ERROR' },
      ],
    });
  });
});
