// @vitest-environment node
/**
 * The daily-discovery Edge Function's handler against SYNTHETIC Binance responses, a synthetic
 * supabase-js client and a test clock. No request leaves a test, and no production value is used.
 * The client's tables keep the database's primary keys, so supabaseDiscoveryStore runs as in
 * production: duplicates come back as 23505, never as overwrites.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  boundedFetch,
  DISCOVERY_EDGE_REGION,
  handleDailyDiscovery,
  INVOCATION_BUDGET_MS,
  PERSISTENCE_RESERVE_MS,
  type DailyDiscoveryDeps,
} from '../../supabase/functions/daily-discovery/handler';
import { REQUEST_BOUNDS, runDailyDiscovery } from '../../scripts/dailyDiscovery';
import { DISCOVERY_POLICY, verifyDiscoveryBatch } from '@/lib/dailyDiscovery';
import {
  at,
  binanceFake,
  json,
  memoryDiscoveryStore,
  syntheticMarket,
  testClock,
  timeoutError,
  type Scripted,
  type SyntheticMarket,
} from './dailyDiscoveryFixtures';

/** The Node collector's pinned hash for the same synthetic market and start time. */
const SYNTHETIC_BATCH_SHA256 = '229586a388419e5bcbbe6f5a0a9827d11bc11577c6fe6e4b42b3633a99bf2c0b';
const SECRET = 'sb_secret_synthetic_for_tests';
const PUBLISHABLE = 'sb_publishable_synthetic_for_tests';
const ENV: Record<string, string> = {
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: PUBLISHABLE }),
  SUPABASE_URL: 'https://synthetic.invalid',
  SB_REGION: 'eu-west-1',
  DISCOVERY_EDGE_ENABLED: 'true',
  DISCOVERY_AUTOMATION_EMAIL: 'automation@synthetic.invalid',
  DISCOVERY_AUTOMATION_PASSWORD: 'synthetic-password',
};
const ENDPOINTS = [DISCOVERY_POLICY.source.exchangeInfo, DISCOVERY_POLICY.source.ticker];
const URL_ = 'https://synthetic.invalid/functions/v1/daily-discovery';
const post = (headers: Record<string, string> = { apikey: SECRET }) =>
  new Request(URL_, { method: 'POST', headers });

type Row = Record<string, unknown>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Discovery tables with the database's keys, shared by every client made from them. */
function syntheticTables() {
  const batches = new Map<string, string>();
  const attempts = new Map<string, string>();
  return {
    batches,
    attempts,
    batchRows: () => [...batches.values()].map((row) => JSON.parse(row) as Row),
    attemptRows: () => [...attempts.values()].map((row) => JSON.parse(row) as Row),
  };
}

/** A supabase-js stand-in: sign-in, sign-out and the three discovery queries. */
function syntheticClient(
  tables: ReturnType<typeof syntheticTables>,
  options: { role?: string; signIn?: 'error' | 'throws'; fail?: Record<string, string> } = {},
) {
  const calls: string[] = [];
  const client = {
    auth: {
      signInWithPassword: async (credentials: { email: string; password: string }) => {
        calls.push(`signIn:${credentials.email}`);
        if (options.signIn === 'throws') throw new Error('synthetic network failure');
        if (options.signIn === 'error') return { data: { user: null }, error: { status: 400 } };
        const role = options.role ?? 'discovery_automation';
        return { data: { user: { id: 'synthetic', app_metadata: { role } } }, error: null };
      },
      signOut: async ({ scope }: { scope: string }) => {
        calls.push(`signOut:${scope}`);
        return { error: null };
      },
    },
    from: (table: 'discovery_batches' | 'discovery_attempts') => ({
      insert: async (row: Row) => {
        await tick();
        calls.push(`insert:${table}`);
        const failure = options.fail?.[table];
        if (failure) return { error: { code: failure } };
        const [map, key] =
          table === 'discovery_batches'
            ? [tables.batches, `${String(row['policy_id'])}|${String(row['slot_date'])}`]
            : [tables.attempts, String(row['attempt_id'])];
        if (map.has(key)) return { error: { code: '23505' } };
        map.set(key, JSON.stringify(row));
        return { error: null };
      },
      select: () => {
        const filter: Row = {};
        const chain = {
          eq: (column: string, value: unknown) => {
            filter[column] = value;
            return chain;
          },
          maybeSingle: async () => {
            await tick();
            calls.push(`read:${table}`);
            const row = tables.batches.get(
              `${String(filter['policy_id'])}|${String(filter['slot_date'])}`,
            );
            const parsed = row ? (JSON.parse(row) as Row) : null;
            return {
              data: parsed ? { evidence_sha256: parsed['evidence_sha256'] } : null,
              error: null,
            };
          },
        };
        return chain;
      },
    }),
  };
  return { client, calls };
}

let uuid = 0;
function edge(
  options: {
    start?: number;
    market?: SyntheticMarket;
    script?: { exchangeInfo?: readonly Scripted[]; ticker?: readonly Scripted[] };
    env?: Record<string, string | undefined>;
    tables?: ReturnType<typeof syntheticTables>;
    client?: Parameters<typeof syntheticClient>[1];
    clock?: ReturnType<typeof testClock>;
  } = {},
) {
  const clock = options.clock ?? testClock(options.start ?? at(0, 33, 5));
  const binance = binanceFake(options.market ?? syntheticMarket(), clock, options.script);
  const tables = options.tables ?? syntheticTables();
  const supabase = syntheticClient(tables, options.client);
  const createClient = vi.fn(
    () => supabase.client as unknown as ReturnType<DailyDiscoveryDeps['createClient']>,
  );
  const logs: string[] = [];
  const env = { ...ENV, ...options.env };
  const deps: DailyDiscoveryDeps = {
    env: (name) => env[name],
    fetch: binance.fetch,
    now: clock.now,
    sleep: clock.sleep,
    createClient,
    randomUUID: () => `00000000-0000-4000-8000-${String((uuid += 1)).padStart(12, '0')}`,
    log: (line) => logs.push(line),
  };
  const invoke = async (request: Request = post()) => {
    const response = await handleDailyDiscovery(request, deps);
    return { status: response.status, body: (await response.json()) as Row };
  };
  return { clock, binance, tables, supabase, createClient, logs, invoke };
}

describe('daily-discovery refusals', () => {
  const refusals: [string, Request, Record<string, string | undefined>, number][] = [
    ['GET', new Request(URL_, { headers: { apikey: SECRET } }), {}, 405],
    ['no key', post({}), {}, 401],
    ['a publishable key', post({ apikey: PUBLISHABLE }), {}, 401],
    ['unreadable secret keys', post(), { SUPABASE_SECRET_KEYS: 'not json' }, 401],
    ['no secret keys', post(), { SUPABASE_SECRET_KEYS: undefined }, 401],
    ['no region', post(), { SB_REGION: undefined }, 421],
    ['another region', post(), { SB_REGION: 'eu-central-2' }, 421],
    ['the flag unset', post(), { DISCOVERY_EDGE_ENABLED: undefined }, 503],
    ['the flag not exactly true', post(), { DISCOVERY_EDGE_ENABLED: 'TRUE' }, 503],
    ['no email', post(), { DISCOVERY_AUTOMATION_EMAIL: undefined }, 500],
    ['no password', post(), { DISCOVERY_AUTOMATION_PASSWORD: '' }, 500],
    ['no project URL', post(), { SUPABASE_URL: undefined }, 500],
    ['no publishable key', post(), { SUPABASE_PUBLISHABLE_KEYS: '{}' }, 500],
  ];

  it.each(refusals)(
    'refuses %s before Binance, sign-in or storage',
    async (_label, request, env, code) => {
      const run = edge({ env });
      const { status } = await run.invoke(request);
      expect(status).toBe(code);
      expect(run.binance.calls).toEqual([]);
      expect(run.createClient).not.toHaveBeenCalled();
      expect(run.supabase.calls).toEqual([]);
      expect(run.tables.batches.size + run.tables.attempts.size).toBe(0);
      expect(run.logs).toEqual([]);
    },
  );

  it('names what is missing, never its value', async () => {
    const { body } = await edge({ env: { DISCOVERY_AUTOMATION_PASSWORD: undefined } }).invoke();
    expect(body).toEqual({ error: 'Not configured', missing: ['DISCOVERY_AUTOMATION_PASSWORD'] });
    const wrongRegion = await edge({ env: { SB_REGION: 'us-east-1' } }).invoke();
    expect(wrongRegion.body).toEqual({
      error: 'Wrong region',
      region: 'us-east-1',
      expected: DISCOVERY_EDGE_REGION,
    });
  });

  it('stops before Binance or storage when the sign-in fails or lacks the role', async () => {
    for (const [client, code] of [
      [{ signIn: 'error' as const }, 502],
      [{ signIn: 'throws' as const }, 502],
      [{ role: 'campaign_automation' }, 500],
    ] as const) {
      const run = edge({ client });
      const { status, body } = await run.invoke();
      expect(status).toBe(code);
      expect(body['status']).toBe('stopped');
      expect(run.binance.calls).toEqual([]);
      expect(run.supabase.calls.filter((c) => /^(read|insert)/.test(c))).toEqual([]);
    }
  });
});

describe('daily-discovery collection', () => {
  it('stores the same bytes the Node collector stores, signed in with no stored session', async () => {
    const run = edge();
    const { status, body } = await run.invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      slot: '2026-11-20',
      status: 'complete',
      failureCode: null,
      startedAt: '2026-11-20T00:33:05.000Z',
      evidenceSha256: SYNTHETIC_BATCH_SHA256,
      coverage: { selected: 50, eligible: 62 },
    });
    expect(run.binance.calls).toEqual(ENDPOINTS);
    const [batch] = run.tables.batchRows();
    expect(batch?.['evidence_sha256']).toBe(SYNTHETIC_BATCH_SHA256);
    expect((await verifyDiscoveryBatch(batch as never)).ok).toBe(true);
    const [attempt] = run.tables.attemptRows();
    expect(attempt).toMatchObject({ status: 'complete', evidence_sha256: SYNTHETIC_BATCH_SHA256 });
    // The database's attempt_id check.
    expect(String(attempt?.['attempt_id'])).toMatch(/^edge-[0-9a-f-]{36}$/);
    expect(String(attempt?.['attempt_id'])).toMatch(/^[a-z0-9][a-z0-9-]{0,79}$/);

    // The publishable key and the automation user: never a secret key for storage.
    expect(run.createClient).toHaveBeenCalledTimes(1);
    const [url, key, options] = run.createClient.mock.calls[0] as unknown as [string, string, Row];
    expect([url, key]).toEqual(['https://synthetic.invalid', PUBLISHABLE]);
    expect(options['auth']).toEqual({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
    expect(run.supabase.calls).toEqual([
      'signIn:automation@synthetic.invalid',
      'read:discovery_batches',
      'insert:discovery_batches',
      'insert:discovery_attempts',
      'signOut:local',
    ]);
  });

  it('answers and logs counts, times and status only', async () => {
    const run = edge();
    const { body } = await run.invoke();
    for (const text of [JSON.stringify(body), ...run.logs]) {
      expect(text).not.toMatch(/ZCT|USDC|XAUT|BTCUSDT|quoteVolume|000000\.5|synthetic-password/);
    }
  });

  it('ignores anything the caller sends: slot, clock, endpoint and policy come from the function', async () => {
    const run = edge();
    const { body } = await run.invoke(
      new Request(`${URL_}?slot=2020-01-01&now=0&endpoint=https://example.com`, {
        method: 'POST',
        headers: { apikey: SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({
          slot: '2020-01-01',
          policy: 'other',
          endpoint: 'https://example.com',
        }),
      }),
    );
    expect(body).toMatchObject({ slot: '2026-11-20', status: 'complete' });
    expect(run.binance.calls).toEqual(ENDPOINTS);
  });

  it('never fetches Binance again for a slot that already has its batch', async () => {
    const tables = syntheticTables();
    const clock = testClock(at(0, 33, 5));
    const first = edge({ tables, clock });
    expect((await first.invoke()).body['status']).toBe('complete');
    clock.set(at(2, 3, 9));
    const retry = edge({ tables, clock });
    const { status, body } = await retry.invoke();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'already_collected',
      evidenceSha256: SYNTHETIC_BATCH_SHA256,
    });
    expect(retry.binance.calls).toEqual([]);
    expect(tables.batches.size).toBe(1);
    expect(
      tables
        .attemptRows()
        .map((row) => row['status'])
        .sort(),
    ).toEqual(['already_collected', 'complete']);
  });

  it('lets the primary key decide concurrent invocations: one batch, unchanged or conflict', async () => {
    const same = syntheticTables();
    const [a, b] = await Promise.all([
      edge({ tables: same }).invoke(),
      edge({ tables: same }).invoke(),
    ]);
    expect([a.body['status'], b.body['status']].sort()).toEqual(['complete', 'unchanged']);
    expect(same.batches.size).toBe(1);
    expect(new Set(same.attemptRows().map((row) => row['attempt_id'])).size).toBe(2);

    const other = syntheticTables();
    const different = syntheticMarket({ volumeOf: (s, f) => (s === 'ZCT050USDT' ? '1.5' : f) });
    const [c, d] = await Promise.all([
      edge({ tables: other }).invoke(),
      edge({ tables: other, market: different }).invoke(),
    ]);
    const conflict = [c, d].find((r) => r.body['status'] === 'conflict');
    expect(conflict?.status).toBe(502);
    expect(other.batches.size).toBe(1);
    const stored = other.batchRows()[0]?.['evidence_sha256'];
    expect([c.body['evidenceSha256'], d.body['evidenceSha256']]).toContain(stored);
  });
});

describe('daily-discovery failures', () => {
  const status =
    (code: number, headers: Record<string, string> = {}) =>
    () =>
      json(code, { code: -1, msg: 'synthetic' }, headers);

  it('records an upstream refusal as a failed attempt and stores no batch', async () => {
    const run = edge({ script: { exchangeInfo: [status(451)] } });
    const { status: code, body } = await run.invoke();
    expect(code).toBe(502);
    expect(body).toMatchObject({ status: 'failed', failureCode: 'REGION_BLOCKED' });
    expect(run.tables.batches.size).toBe(0);
    expect(run.tables.attemptRows()).toEqual([
      expect.objectContaining({
        status: 'failed',
        failure_code: 'REGION_BLOCKED',
        evidence_sha256: null,
      }),
    ]);
  });

  it('keeps the slot deadline: missed at 06:00, failed when collection ends after it', async () => {
    const missed = edge({ start: at(6, 0, 1) });
    expect((await missed.invoke()).body).toMatchObject({ status: 'missed' });
    expect(missed.binance.calls).toEqual([]);

    const late = edge({
      start: at(5, 59, 55),
      script: { exchangeInfo: [status(503), status(503)] },
    });
    expect((await late.invoke()).body).toMatchObject({
      status: 'failed',
      failureCode: 'DEADLINE_PASSED',
    });
    expect(late.tables.batches.size).toBe(0);
  });

  it('stops with BUDGET_EXHAUSTED when the next full try would pass the collection budget', async () => {
    const clock = testClock(at(0, 33, 5));
    // Two 30 s timeouts (+30, +62 s), the 2 s and 8 s waits, then exchangeInfo answers after
    // 10 s at +80 s. A full 30 s ticker try would end at +110 s, past the +105 s collection budget.
    const slow: Scripted = () => {
      clock.advance(REQUEST_BOUNDS.timeoutMs);
      return Promise.reject(timeoutError());
    };
    const market = syntheticMarket();
    const late: Scripted = () => {
      clock.advance(10_000);
      return json(200, { timezone: 'UTC', serverTime: clock.now(), symbols: market.instruments });
    };
    const run = edge({ clock, market, script: { exchangeInfo: [slow, slow, late] } });
    const { status: code, body } = await run.invoke();
    expect(code).toBe(502);
    expect(body).toMatchObject({ status: 'failed', failureCode: 'BUDGET_EXHAUSTED' });
    expect(String(body['detail'])).toMatch(/ticker\/24hr try 1 would end after/);
    expect(run.binance.calls).toEqual([ENDPOINTS[0], ENDPOINTS[0], ENDPOINTS[0]]);
    expect(run.tables.batches.size).toBe(0);
    expect(run.tables.attemptRows()).toEqual([
      expect.objectContaining({ status: 'failed', failure_code: 'BUDGET_EXHAUSTED' }),
    ]);
    // Collection stopped inside its budget, leaving the reserve for the attempt row.
    expect(clock.now() - at(0, 33, 5)).toBeLessThanOrEqual(
      INVOCATION_BUDGET_MS - PERSISTENCE_RESERVE_MS,
    );
  });

  it('never cuts a Retry-After short: it stops instead, where Node would wait', async () => {
    const clock = testClock(at(0, 33, 5));
    const stall: Scripted = () => {
      clock.advance(50_000);
      return json(429, { code: -1003, msg: 'synthetic' }, { 'Retry-After': '60' });
    };
    const run = edge({ clock, script: { exchangeInfo: [stall] } });
    const { body } = await run.invoke();
    expect(body).toMatchObject({ status: 'failed', failureCode: 'BUDGET_EXHAUSTED' });
    expect(String(body['detail'])).toMatch(/after HTTP 429, the 60 s wait and try 2/);
    expect(clock.sleeps).toEqual([]);

    // The Node collector, with no invocation budget, waits the full 60 s and collects.
    const nodeClock = testClock(at(0, 33, 5));
    const nodeStall: Scripted = () => {
      nodeClock.advance(50_000);
      return json(429, { code: -1003, msg: 'synthetic' }, { 'Retry-After': '60' });
    };
    const storage = memoryDiscoveryStore();
    const binance = binanceFake(syntheticMarket(), nodeClock, { exchangeInfo: [nodeStall] });
    const summary = await runDailyDiscovery({
      store: storage.store,
      attemptId: 'gh-1-1',
      deps: { fetch: binance.fetch, now: nodeClock.now, sleep: nodeClock.sleep },
    });
    expect(summary.status).toBe('complete');
    expect(nodeClock.sleeps).toEqual([60_000]);
  });

  it('records a failed batch write as STORE_ERROR, and reports when even the attempt row fails', async () => {
    const batchFails = edge({ client: { fail: { discovery_batches: '42501' } } });
    const first = await batchFails.invoke();
    expect(first).toMatchObject({
      status: 502,
      body: { status: 'failed', failureCode: 'STORE_ERROR' },
    });
    expect(batchFails.tables.attemptRows()).toEqual([
      expect.objectContaining({
        status: 'failed',
        failure_code: 'STORE_ERROR',
        detail: 'Recording the batch failed (42501)',
      }),
    ]);

    const attemptFails = edge({ client: { fail: { discovery_attempts: '42501' } } });
    const second = await attemptFails.invoke();
    expect(second).toEqual({
      status: 500,
      body: { status: 'stopped', reason: 'Recording the attempt failed (42501)' },
    });
    expect(attemptFails.supabase.calls.at(-1)).toBe('signOut:local');
  });
});

describe('bounded Supabase requests', () => {
  it('ends each request by its own timeout and the invocation deadline', async () => {
    let now = 1_000;
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('{}');
    });
    const bounded = boundedFetch(
      { fetch: fetchSpy as unknown as typeof fetch, now: () => now },
      5_000,
    );
    await bounded('https://synthetic.invalid/auth/v1/token');
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    now = 5_000;
    await expect(
      bounded('https://synthetic.invalid/rest/v1/discovery_attempts'),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('no service-role path', () => {
  const read = (file: string) => readFileSync(path.resolve(__dirname, '../..', file), 'utf8');

  it('reads secret keys only to authenticate the caller, and never a service-role key', () => {
    const files = [
      'supabase/functions/daily-discovery/handler.ts',
      'supabase/functions/daily-discovery/index.ts',
      'supabase/functions/_shared/dailyDiscoveryRun.ts',
      'supabase/functions/_shared/dailyDiscovery.ts',
    ].map(read);
    for (const text of files) {
      expect(text).not.toMatch(/SERVICE_ROLE|service_role|_shared\/feed/);
    }
    const handler = files[0] ?? '';
    expect(handler.match(/SUPABASE_SECRET_KEYS/g)).toHaveLength(1);
    expect(handler).toMatch(/\.includes\(apikey\)/);
  });
});
