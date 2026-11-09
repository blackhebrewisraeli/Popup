import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkKeyPermissions,
  ENDPOINTS,
  handleSpotAccount,
  hmacSha256Hex,
  parseBalances,
  RECV_WINDOW_MS,
} from '../../supabase/functions/binance-spot-account/handler';

// Everything below is synthetic: fake users, fake credentials, invented balances.
const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const API_KEY = 'fake-api-key-for-tests';
const API_SECRET = 'fake-api-secret-for-tests';
const OWNER_TOKEN = 'fake-owner-session-token';
const SERVER_TIME = 1_800_000_000_000;

const ENV: Record<string, string> = {
  SUPABASE_URL: 'https://project.supabase.test',
  SUPABASE_ANON_KEY: 'fake-anon-key',
  BINANCE_SPOT_READONLY_ENABLED: 'true',
  BINANCE_SPOT_OWNER_USER_ID: OWNER,
  BINANCE_SPOT_API_KEY: API_KEY,
  BINANCE_SPOT_API_SECRET: API_SECRET,
};

const READ_ONLY_KEY = {
  ipRestrict: false,
  createTime: 1_623_840_271_000,
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  enableMargin: false,
  enableFutures: false,
  permitsUniversalTransfer: false,
  enableVanillaOptions: false,
  enableFixApiTrade: false,
  enableFixReadOnly: true,
  enableSpotAndMarginTrading: false,
  enablePortfolioMarginTrading: false,
};

const ACCOUNT = {
  canTrade: true,
  canWithdraw: true,
  accountType: 'SPOT',
  balances: [
    { asset: 'USDT', free: '120.50000000', locked: '30.00000000' },
    { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
    { asset: 'SHIB', free: '4723846.89208129', locked: '0.00000000' },
    { asset: 'ETH', free: '0.00000000', locked: '0.25000000' },
    { asset: 'DUST', free: '0.00000000', locked: '0.00000000' },
  ],
};

type Reply = Response | Error | (() => Response);
interface Scenario {
  env?: Record<string, string | undefined>;
  /** Authorization header; null sends none. */
  authorization?: string | null;
  user?: Reply;
  time?: Reply;
  permissions?: Reply;
  account?: Reply;
  /** Successive values of the function's clock. */
  clock?: number[];
  method?: string;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const timeoutError = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

async function call(scenario: Scenario = {}) {
  const env = { ...ENV, ...scenario.env };
  const calls: { url: URL; method: string; headers: Headers }[] = [];
  const lines: string[] = [];
  const replies: Record<string, Reply> = {
    '/auth/v1/user': scenario.user ?? ok({ id: OWNER }),
    [ENDPOINTS.time]: scenario.time ?? ok({ serverTime: SERVER_TIME }),
    [ENDPOINTS.keyPermissions]: scenario.permissions ?? ok(READ_ONLY_KEY),
    [ENDPOINTS.account]: scenario.account ?? ok(ACCOUNT),
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const reply = replies[url.pathname];
    if (reply === undefined) throw new Error(`unexpected request to ${url.pathname}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  }) as typeof fetch;
  const clock = [...(scenario.clock ?? [])];
  let last = 1_000;
  const authorization =
    scenario.authorization === undefined ? `Bearer ${OWNER_TOKEN}` : scenario.authorization;
  const req = new Request('https://project.supabase.test/functions/v1/binance-spot-account', {
    method: scenario.method ?? 'POST',
    headers: authorization === null ? {} : { Authorization: authorization },
  });
  const res = await handleSpotAccount(req, {
    env: (name) => env[name],
    fetch: fakeFetch,
    log: (line) => lines.push(line),
    now: () => (last = clock.shift() ?? last),
  });
  const text = await res.text();
  return {
    res,
    text,
    body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
    calls,
    binance: calls.filter((c) => c.url.hostname !== 'project.supabase.test'),
    lines,
  };
}

describe('binance-spot-account: authorization comes before Binance', () => {
  it('serves the configured owner', async () => {
    const { res, body, calls } = await call();
    expect(res.status).toBe(200);
    expect(body?.['state']).toBe('connected');
    expect(calls.map((c) => c.url.pathname)).toEqual([
      '/auth/v1/user',
      ENDPOINTS.time,
      ENDPOINTS.keyPermissions,
      ENDPOINTS.account,
    ]);
    // The caller's identity comes from Supabase Auth, asked with the caller's own token.
    expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${OWNER_TOKEN}`);
  });

  it.each([
    ['no Authorization header', { authorization: null }, 401, 'unauthenticated', 0],
    ['a malformed Authorization header', { authorization: 'Basic abc' }, 401, 'unauthenticated', 0],
    [
      'a token Supabase Auth rejects',
      { user: new Response('{"msg":"invalid JWT"}', { status: 401 }) },
      401,
      'unauthenticated',
      1,
    ],
    [
      'Supabase Auth being unreachable',
      { user: new TypeError('fetch failed') },
      401,
      'unauthenticated',
      1,
    ],
    ['another signed-in user', { user: ok({ id: STRANGER }) }, 403, 'forbidden', 1],
    [
      'everyone when no owner is configured',
      { env: { BINANCE_SPOT_OWNER_USER_ID: undefined } },
      403,
      'forbidden',
      1,
    ],
    [
      'a user with an empty id when no owner is configured',
      { env: { BINANCE_SPOT_OWNER_USER_ID: '' }, user: ok({ id: '' }) },
      401,
      'unauthenticated',
      1,
    ],
  ] as const)(
    'refuses %s without contacting Binance',
    async (_, scenario, status, error, authCalls) => {
      const { res, body, calls, binance } = await call(scenario);
      expect(res.status).toBe(status);
      expect(body).toEqual({ state: 'error', error });
      expect(binance).toEqual([]);
      expect(calls).toHaveLength(authCalls);
    },
  );

  it.each([
    ['the feature flag is absent', { BINANCE_SPOT_READONLY_ENABLED: undefined }],
    ['the feature flag is not exactly "true"', { BINANCE_SPOT_READONLY_ENABLED: '1' }],
    ['the API key is missing', { BINANCE_SPOT_API_KEY: undefined }],
    ['the API secret is missing', { BINANCE_SPOT_API_SECRET: '' }],
  ])('reports not configured to the owner when %s', async (_, env) => {
    const { res, body, binance } = await call({ env });
    expect(res.status).toBe(200);
    expect(body).toEqual({ state: 'not_configured' });
    expect(binance).toEqual([]);
  });

  it('answers the CORS preflight and refuses other methods without any outbound call', async () => {
    const preflight = await call({ method: 'OPTIONS' });
    expect(preflight.res.status).toBe(204);
    expect(preflight.calls).toEqual([]);
    const get = await call({ method: 'GET' });
    expect(get.res.status).toBe(405);
    expect(get.calls).toEqual([]);
  });
});

describe('binance-spot-account: signing and time', () => {
  it('matches the signature example in the Binance documentation', async () => {
    expect(
      await hmacSha256Hex(
        'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
        'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559',
      ),
    ).toBe('c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
  });

  it('signs the exact query it sends, with the key in the header only', async () => {
    const { binance } = await call();
    const [time, permissions, account] = binance;
    expect(time?.url.search).toBe('');
    expect(time?.headers.get('X-MBX-APIKEY')).toBeNull();
    for (const signed of [permissions, account]) {
      const query = signed?.url.search.slice(1) ?? '';
      const [payload, signature] = query.split('&signature=');
      expect(signature).toBe(
        createHmac('sha256', API_SECRET)
          .update(payload ?? '')
          .digest('hex'),
      );
      expect(signed?.headers.get('X-MBX-APIKEY')).toBe(API_KEY);
      expect(signed?.url.searchParams.get('recvWindow')).toBe(String(RECV_WINDOW_MS));
      expect(query).not.toContain(API_KEY);
      expect(query).not.toContain(API_SECRET);
    }
    expect(account?.url.searchParams.get('omitZeroBalances')).toBe('true');
    expect(RECV_WINDOW_MS).toBe(5000);
  });

  it("stamps requests with Binance's clock plus elapsed time, whatever the local clock says", async () => {
    // The local clock is decades off; only the differences between its readings matter.
    // Readings: request start, time answer received, permissions stamp, account stamp, finish.
    const { binance, body } = await call({ clock: [5_000, 5_300, 5_340, 5_900, 6_000] });
    expect(body?.['state']).toBe('connected');
    expect(binance[1]?.url.searchParams.get('timestamp')).toBe(String(SERVER_TIME + 40));
    expect(binance[2]?.url.searchParams.get('timestamp')).toBe(String(SERVER_TIME + 600));
  });

  it('never stamps a request ahead of the last known Binance time if the local clock steps back', async () => {
    const { binance } = await call({ clock: [5_000, 5_300, 4_000, 4_000, 4_000] });
    expect(binance[1]?.url.searchParams.get('timestamp')).toBe(String(SERVER_TIME));
  });

  it.each([
    ['a string', { serverTime: String(SERVER_TIME) }],
    ['a fraction', { serverTime: 1.5 }],
    ['missing', {}],
    ['negative', { serverTime: -1 }],
  ])('refuses a server time that is %s', async (_, time) => {
    const { body, binance } = await call({ time: ok(time) });
    expect(body).toEqual({ state: 'error', error: 'malformed_response' });
    expect(binance).toHaveLength(1);
  });
});

describe('binance-spot-account: read-only key boundary', () => {
  it.each([
    [
      'spot and margin trading',
      { enableSpotAndMarginTrading: true },
      ['enableSpotAndMarginTrading'],
    ],
    ['withdrawals', { enableWithdrawals: true }, ['enableWithdrawals']],
    [
      'internal and universal transfer',
      { enableInternalTransfer: true, permitsUniversalTransfer: true },
      ['enableInternalTransfer', 'permitsUniversalTransfer'],
    ],
    ['futures', { enableFutures: true }, ['enableFutures']],
    ['FIX trading', { enableFixApiTrade: true }, ['enableFixApiTrade']],
    ['a capability Binance adds later', { enableSomethingNew: true }, ['enableSomethingNew']],
  ])('refuses a key with %s enabled and never reads the account', async (_, flags, enabled) => {
    const { res, body, binance } = await call({ permissions: ok({ ...READ_ONLY_KEY, ...flags }) });
    expect(res.status).toBe(502);
    expect(body).toEqual({ state: 'error', error: 'permissions_refused', enabled });
    expect(binance.map((c) => c.url.pathname)).toEqual([ENDPOINTS.time, ENDPOINTS.keyPermissions]);
  });

  it.each([
    [
      'a documented capability is not reported',
      ok({ ...READ_ONLY_KEY, enableWithdrawals: undefined }),
    ],
    ['a capability is not a boolean', ok({ ...READ_ONLY_KEY, enableFutures: 'false' })],
    ['reading is not reported as enabled', ok({ ...READ_ONLY_KEY, enableReading: false })],
    ['the answer is not an object', ok([])],
    ['the answer is not JSON', new Response('<html>', { status: 200 })],
    ['Binance answers 500', new Response('{"code":-1000,"msg":"x"}', { status: 500 })],
    ['Binance answers 404', new Response('', { status: 404 })],
  ])('reports unverified, not read-only, when %s', async (_, permissions) => {
    const { body, binance } = await call({ permissions });
    expect(body).toEqual({ state: 'error', error: 'permissions_unverified' });
    expect(binance.map((c) => c.url.pathname)).not.toContain(ENDPOINTS.account);
  });

  it('does not take the account-level canTrade flag as a key permission', async () => {
    // canTrade false on the account does not make a trading key acceptable...
    const refused = await call({
      permissions: ok({ ...READ_ONLY_KEY, enableSpotAndMarginTrading: true }),
      account: ok({ ...ACCOUNT, canTrade: false }),
    });
    expect(refused.body?.['error']).toBe('permissions_refused');
    // ...and canTrade true on the account does not make a read-only key suspect.
    expect((await call()).body?.['state']).toBe('connected');
    expect(checkKeyPermissions({ canTrade: false })).toEqual({ verdict: 'unverified' });
  });

  it.each([
    [
      '-2015 (invalid key, IP or permissions)',
      new Response('{"code":-2015,"msg":"x"}', { status: 401 }),
    ],
    ['-2014 (bad key format)', new Response('{"code":-2014,"msg":"x"}', { status: 400 })],
    ['-1022 (bad signature)', new Response('{"code":-1022,"msg":"x"}', { status: 400 })],
  ])('reports an authentication failure on %s', async (_, permissions) => {
    const { res, body } = await call({ permissions });
    expect(res.status).toBe(502);
    expect(body).toEqual({ state: 'error', error: 'binance_auth' });
  });

  it('can only send GET requests to three fixed Binance paths', async () => {
    expect(Object.values(ENDPOINTS)).toEqual([
      '/api/v3/time',
      '/sapi/v1/account/apiRestrictions',
      '/api/v3/account',
    ]);
    const { calls, binance } = await call();
    for (const c of binance) {
      expect(c.method).toBe('GET');
      expect(c.url.origin).toBe('https://api.binance.com');
    }
    // Reading balances writes nothing to Popup either: the only Supabase call is the identity check.
    const supabaseCalls = calls.filter((c) => c.url.hostname === 'project.supabase.test');
    expect(supabaseCalls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /auth/v1/user',
    ]);
  });
});

describe('binance-spot-account: balances', () => {
  it('returns available and locked quantities as the exact strings Binance sent', async () => {
    const { res, body } = await call({ clock: [0, 0, 0, 0, 1_800_000_000_500] });
    expect(body).toEqual({
      state: 'connected',
      readAt: '2027-01-15T08:00:00.500Z',
      balances: [
        { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
        { asset: 'ETH', free: '0.00000000', locked: '0.25000000' },
        { asset: 'SHIB', free: '4723846.89208129', locked: '0.00000000' },
        { asset: 'USDT', free: '120.50000000', locked: '30.00000000' },
      ],
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('keeps precision a float would lose', () => {
    const free = '123456789012345678.123456789012345678';
    expect(parseBalances({ balances: [{ asset: 'X', free, locked: '0' }] })).toEqual([
      { asset: 'X', free, locked: '0' },
    ]);
  });

  it('reports a connected account with no balances as connected and empty', async () => {
    for (const balances of [[], [{ asset: 'BTC', free: '0.00000000', locked: '0.00' }]]) {
      const { res, body } = await call({ account: ok({ balances }) });
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ state: 'connected', balances: [] });
    }
  });

  it.each([
    ['no balances list', {}],
    ['a balances object', { balances: {} }],
    ['a numeric quantity', { balances: [{ asset: 'BTC', free: 1, locked: '0' }] }],
    ['exponent notation', { balances: [{ asset: 'BTC', free: '1e-8', locked: '0' }] }],
    ['a negative quantity', { balances: [{ asset: 'BTC', free: '-1', locked: '0' }] }],
    ['a missing locked quantity', { balances: [{ asset: 'BTC', free: '1' }] }],
    ['an empty asset', { balances: [{ asset: '', free: '1', locked: '0' }] }],
    [
      'a repeated asset',
      {
        balances: [
          { asset: 'A', free: '1', locked: '0' },
          { asset: 'A', free: '2', locked: '0' },
        ],
      },
    ],
    ['a null row', { balances: [null] }],
  ])('refuses an account answer with %s', async (_, account) => {
    const { res, body } = await call({ account: ok(account) });
    expect(res.status).toBe(502);
    expect(body).toEqual({ state: 'error', error: 'malformed_response' });
  });

  it('refuses a 200 that is not JSON', async () => {
    const { body } = await call({ account: new Response('not json', { status: 200 }) });
    expect(body).toEqual({ state: 'error', error: 'malformed_response' });
  });
});

describe('binance-spot-account: provider failures', () => {
  it.each([
    [429, '37', { retryAfterSeconds: 37 }],
    [418, '120', { retryAfterSeconds: 120 }],
    [429, null, {}],
    [429, 'soon', {}],
    [429, '999999999', {}],
  ])(
    'reports a %i as rate limited and stops (Retry-After %s)',
    async (status, retryAfter, extra) => {
      const limited = new Response('{"code":-1003,"msg":"x"}', {
        status,
        headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
      });
      for (const scenario of [
        { time: limited.clone() },
        { permissions: limited.clone() },
        { account: limited.clone() },
      ]) {
        const { res, body, binance } = await call(scenario);
        expect(res.status).toBe(429);
        expect(body).toEqual({ state: 'error', error: 'rate_limited', ...extra });
        expect(res.headers.get('Retry-After')).toBe(
          'retryAfterSeconds' in extra ? String(extra.retryAfterSeconds) : null,
        );
        // No retry: the failing request is the last one sent.
        expect(new Set(binance.map((c) => c.url.pathname)).size).toBe(binance.length);
      }
    },
  );

  it('reports a timeout at any step', async () => {
    for (const scenario of [
      { time: timeoutError() },
      { permissions: timeoutError() },
      { account: timeoutError() },
    ]) {
      const { res, body } = await call(scenario);
      expect(res.status).toBe(504);
      expect(body).toEqual({ state: 'error', error: 'timeout' });
    }
  });

  it('reports a network failure at any step', async () => {
    for (const scenario of [
      { time: new TypeError('fetch failed') },
      { permissions: new TypeError('fetch failed') },
      { account: new TypeError('fetch failed') },
    ]) {
      const { res, body } = await call(scenario);
      expect(res.status).toBe(502);
      expect(body).toEqual({ state: 'error', error: 'network' });
    }
  });

  it('reports other Binance errors without echoing their text', async () => {
    const { body, lines } = await call({
      account: new Response(
        '{"code":-1021,"msg":"Timestamp for this request is outside of the recvWindow."}',
        { status: 400 },
      ),
    });
    expect(body).toEqual({ state: 'error', error: 'provider_error' });
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      outcome: 'provider_error',
      providerCode: -1021,
    });
  });
});

describe('binance-spot-account: nothing secret leaves the function', () => {
  it('keeps credentials, tokens, signatures and balances out of every response and log line', async () => {
    const scenarios: Scenario[] = [
      {},
      { user: ok({ id: STRANGER }) },
      { authorization: null },
      { env: { BINANCE_SPOT_READONLY_ENABLED: 'false' } },
      { permissions: ok({ ...READ_ONLY_KEY, enableWithdrawals: true }) },
      {
        permissions: new Response(`{"code":-2015,"msg":"Invalid API-key ${API_KEY}"}`, {
          status: 401,
        }),
      },
      { account: new Response(`{"code":-1000,"msg":"${API_SECRET}"}`, { status: 500 }) },
      { account: new TypeError(`fetch failed for key ${API_KEY}`) },
    ];
    for (const scenario of scenarios) {
      const { text, res, lines, binance } = await call(scenario);
      const signatures = binance.map((c) => c.url.searchParams.get('signature')).filter(Boolean);
      const headers = JSON.stringify([...res.headers]);
      for (const secret of [
        API_KEY,
        API_SECRET,
        OWNER_TOKEN,
        ENV['SUPABASE_ANON_KEY'],
        ...signatures,
      ]) {
        expect(text).not.toContain(secret);
        expect(headers).not.toContain(secret);
        expect(lines.join('\n')).not.toContain(secret);
      }
      expect(lines).toHaveLength(1);
      // The log says how many assets, never which or how much.
      expect(lines[0]).not.toContain('120.50000000');
      expect(lines[0]).not.toContain(OWNER);
    }
  });
});
