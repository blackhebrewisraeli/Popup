// @vitest-environment node
/**
 * The unattended collector against SYNTHETIC Binance responses and in-process storage. It runs
 * in Node with no DOM, no browser Supabase client (importing it fails this file) and no owner
 * session: the scheduled job needs nothing a browser provides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseClient', () => {
  throw new Error('The collector must not load the browser Supabase client');
});
const supabaseJs = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => supabaseJs);

import { DISCOVERY_POLICY_ID, verifyDiscoveryBatch } from '@/lib/dailyDiscovery';
import {
  binanceFake,
  json,
  at,
  memoryDiscoveryStore,
  syntheticMarket,
  testClock,
  timeoutError,
  zct,
} from '../src/test/dailyDiscoveryFixtures';
import {
  main,
  runDailyDiscovery,
  summaryLines,
  supabaseDiscoveryStore,
  SUCCESSFUL_RUNS,
} from './dailyDiscovery';

function setup(
  start = at(0, 33, 5),
  script: Parameters<typeof binanceFake>[2] = {},
  market = syntheticMarket(),
) {
  const clock = testClock(start);
  const binance = binanceFake(market, clock, script);
  const storage = memoryDiscoveryStore();
  const run = (attemptId = 'gh-1-1', store = storage.store) =>
    runDailyDiscovery({
      store,
      attemptId,
      deps: { fetch: binance.fetch, now: clock.now, sleep: clock.sleep },
    });
  return { clock, binance, storage, run };
}

const statusOf =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    json(code, { code: -1, msg: 'synthetic' }, headers);

describe('a scheduled run', () => {
  it('runs without a browser', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('collects the due slot once, stores one verifiable batch and one attempt', async () => {
    const { binance, storage, run } = setup();
    const summary = await run();
    expect(summary).toMatchObject({
      status: 'complete',
      failureCode: null,
      slot: { date: '2026-11-20', scheduledFor: '2026-11-20T00:30:00.000Z' },
    });
    expect(binance.calls).toEqual([
      'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT',
      'https://api.binance.com/api/v3/ticker/24hr?type=MINI',
    ]);
    const [batch] = storage.batchRows();
    expect(storage.batchRows()).toHaveLength(1);
    expect(batch).toMatchObject({
      policy_id: DISCOVERY_POLICY_ID,
      slot_date: '2026-11-20',
      scheduled_for: '2026-11-20T00:30:00.000Z',
      status: 'complete',
      member_count: 50,
    });
    const verified = await verifyDiscoveryBatch(batch!);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    const { result, collection } = verified.evidence;
    expect(result.members.slice(0, 17).map((m) => m.symbol)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => `${zct(i + 1)}USDT`),
      'BTCUSDT',
      'ZCT016USDT',
    ]);
    expect(result.members.find((m) => m.symbol === 'XAUTUSDT')).toMatchObject({
      rank: 32,
      category: 'tokenized-commodity',
    });
    expect(result.members.some((m) => m.symbol === 'USDCUSDT')).toBe(false);
    expect(result.members.some((m) => m.symbol === 'ZCTNOSPOTUSDT')).toBe(false);
    expect(result.coverage).toMatchObject({
      listed: 66,
      usdtQuoted: 65,
      eligible: 62,
      ranked: 62,
      selected: 50,
      stablecoin: 1,
      notTrading: 1,
      spotTradingNotAllowed: 1,
    });
    expect(collection.cutoff).toBe(new Date(at(0, 33, 5)).toISOString());
    expect(storage.attemptRows()).toEqual([
      expect.objectContaining({
        attempt_id: 'gh-1-1',
        slot_date: '2026-11-20',
        started_at: '2026-11-20T00:33:05.000Z',
        status: 'complete',
        failure_code: null,
        evidence_sha256: batch!.evidence_sha256,
      }),
    ]);
  });

  it('prints counts, times and status only: no pair, volume or evidence', async () => {
    const { run } = setup();
    const text = summaryLines(await run()).join('\n');
    expect(text).toContain('Status: complete');
    expect(text).toContain('3 min after the scheduled slot');
    expect(text).toContain('50 selected of 62 eligible');
    expect(text).not.toMatch(/USDT[A-Z]|ZCT|BTC|\d{6,}/);
  });
});

describe('retries and concurrency', () => {
  it('never fetches a slot again once it has a batch', async () => {
    const { binance, storage, run, clock } = setup();
    await run('gh-1-1');
    const stored = [...storage.batches.values()];
    clock.set(at(2, 3));
    const retry = await run('gh-2-1');
    expect(retry.status).toBe('already_collected');
    expect(binance.calls).toHaveLength(2);
    expect([...storage.batches.values()]).toEqual(stored);
    expect(storage.attemptRows().map((a) => a.status)).toEqual(['already_collected', 'complete']);
  });

  it('two concurrent identical runs store one batch; the second records an unchanged retry', async () => {
    const { storage, run } = setup();
    const [first, second] = await Promise.all([run('gh-1-1'), run('gh-1-2')]);
    expect([first.status, second.status].sort()).toEqual(['complete', 'unchanged']);
    expect(storage.batches.size).toBe(1);
    expect(first.evidenceSha256).toBe(second.evidenceSha256);
  });

  it('a concurrent run with different figures is a conflict and never overwrites', async () => {
    const clock = testClock(at(0, 33, 5));
    const storage = memoryDiscoveryStore();
    const runWith = (market: ReturnType<typeof syntheticMarket>, attemptId: string) =>
      runDailyDiscovery({
        store: storage.store,
        attemptId,
        deps: { fetch: binanceFake(market, clock).fetch, now: clock.now, sleep: clock.sleep },
      });
    const changed = syntheticMarket({
      volumeOf: (symbol, fallback) => (symbol === 'ZCT050USDT' ? '99000000.0' : fallback),
    });
    // Both read the slot as empty, both collect, and the database's key decides.
    const runs = await Promise.all([
      runWith(syntheticMarket(), 'gh-1-1'),
      runWith(changed, 'gh-1-2'),
    ]);
    const winner = runs.find((run) => run.status === 'complete');
    const loser = runs.find((run) => run.status === 'conflict');
    expect(winner).toBeDefined();
    expect(loser?.evidenceSha256).not.toBe(winner?.evidenceSha256);
    expect(storage.batchRows().map((row) => row.evidence_sha256)).toEqual([winner?.evidenceSha256]);
    expect(storage.attemptRows().find((a) => a.status === 'conflict')).toMatchObject({
      evidence_sha256: loser?.evidenceSha256,
      detail: 'Another run stored different evidence for this slot.',
    });
    expect(SUCCESSFUL_RUNS.has('conflict')).toBe(false);
  });

  it('keeps every earlier day exactly as stored', async () => {
    const { storage, run, clock } = setup();
    await run('gh-1-1');
    const dayOne = storage.batches.get(`${DISCOVERY_POLICY_ID}|2026-11-20`);
    clock.set(at(24, 33));
    expect((await run('gh-2-1')).slot.date).toBe('2026-11-21');
    expect(storage.batches.size).toBe(2);
    expect(storage.batches.get(`${DISCOVERY_POLICY_ID}|2026-11-20`)).toBe(dayOne);
  });
});

describe('provider failures store no batch and substitute nothing', () => {
  it.each([
    [
      '5xx on every try',
      { ticker: [statusOf(503), statusOf(502), statusOf(500)] },
      'HTTP_ERROR',
      3,
    ],
    ['a 4xx', { ticker: [statusOf(400)] }, 'HTTP_ERROR', 1],
    ['HTTP 451', { exchangeInfo: [statusOf(451)] }, 'REGION_BLOCKED', 1],
    ['HTTP 418 (banned)', { exchangeInfo: [statusOf(418)] }, 'IP_BANNED', 1],
    ['429 without Retry-After', { ticker: [statusOf(429)] }, 'RATE_LIMITED', 1],
    [
      '429 with too long a Retry-After',
      { ticker: [statusOf(429, { 'Retry-After': '120' })] },
      'RATE_LIMITED',
      1,
    ],
    [
      'timeouts',
      {
        ticker: [
          () => Promise.reject(timeoutError()),
          () => Promise.reject(timeoutError()),
          () => Promise.reject(timeoutError()),
        ],
      },
      'TIMEOUT',
      3,
    ],
    [
      'network errors',
      {
        exchangeInfo: [
          () => Promise.reject(new TypeError('fetch failed')),
          () => Promise.reject(new TypeError('fetch failed')),
          () => Promise.reject(new TypeError('fetch failed')),
        ],
      },
      'NETWORK_ERROR',
      3,
    ],
    [
      'malformed JSON',
      { ticker: [() => new Response('<html>', { status: 200 })] },
      'RESPONSE_INVALID',
      1,
    ],
    [
      'a ticker that is not a list',
      { ticker: [() => json(200, { code: -1121 })] },
      'RESPONSE_INVALID',
      1,
    ],
    [
      'exchangeInfo without symbols',
      { exchangeInfo: [() => json(200, { serverTime: 1 })] },
      'RESPONSE_INVALID',
      1,
    ],
  ] as const)('%s', async (_, script, code, tries) => {
    const { storage, run, binance, clock } = setup(at(0, 33, 5), script);
    const summary = await run();
    expect(summary).toMatchObject({ status: 'failed', failureCode: code, coverage: null });
    expect(storage.batches.size).toBe(0);
    const endpoint = 'ticker' in script ? 'ticker/24hr' : 'exchangeInfo';
    expect(binance.calls.filter((url) => url.includes(endpoint))).toHaveLength(tries);
    // Bounded: at most the configured backoffs, never an unbounded wait.
    expect(clock.sleeps.every((ms) => ms <= 60_000)).toBe(true);
    expect(clock.sleeps.length).toBeLessThanOrEqual(2);
    expect(storage.attemptRows()).toEqual([
      expect.objectContaining({ status: 'failed', failure_code: code, evidence_sha256: null }),
    ]);
    // A banned or blocked runner never goes on to the second request.
    if (code === 'IP_BANNED' || code === 'REGION_BLOCKED') {
      expect(binance.calls.some((url) => url.includes('ticker'))).toBe(false);
    }
  });

  it('waits out a short Retry-After once, then collects', async () => {
    const { storage, run, clock } = setup(at(0, 33, 5), {
      ticker: [statusOf(429, { 'Retry-After': '3' })],
    });
    expect((await run()).status).toBe('complete');
    expect(clock.sleeps).toEqual([3_000]);
    expect(storage.batches.size).toBe(1);
  });

  it('backs off 2 s then 8 s after server errors', async () => {
    const { run, clock } = setup(at(0, 33, 5), {
      exchangeInfo: [statusOf(500), () => Promise.reject(timeoutError())],
    });
    expect((await run()).status).toBe('complete');
    expect(clock.sleeps).toEqual([2_000, 8_000]);
  });

  it('stores a PARTIAL batch when eligible pairs lack valid figures, without filling them in', async () => {
    const market = syntheticMarket({
      volumeOf: (symbol, fallback) => (symbol === 'ZCT001USDT' ? 'NaN' : fallback),
    });
    const base = market.tickers;
    market.tickers = (now) =>
      base(now).filter((t) => (t as { symbol: string }).symbol !== 'ZCT002USDT');
    const { storage, run } = setup(at(0, 33, 5), {}, market);
    expect((await run()).status).toBe('partial');
    const [batch] = storage.batchRows();
    const verified = await verifyDiscoveryBatch(batch!);
    if (!verified.ok) throw new Error(verified.reason);
    const { members, exclusions, coverage } = verified.evidence.result;
    expect(members[0]?.symbol).toBe('ZCT003USDT');
    expect(members.some((m) => ['ZCT001USDT', 'ZCT002USDT'].includes(m.symbol))).toBe(false);
    expect(exclusions).toEqual(
      expect.arrayContaining([
        { symbol: 'ZCT001USDT', reason: 'QUOTE_VOLUME_INVALID' },
        { symbol: 'ZCT002USDT', reason: 'TICKER_MISSING' },
      ]),
    );
    expect(coverage).toMatchObject({ eligible: 62, invalid: 2, ranked: 60, selected: 50 });
  });

  it('stores an EMPTY batch, distinct from a failure, when nothing is eligible', async () => {
    const market = { instruments: [], tickers: () => [] };
    const { storage, run } = setup(at(0, 33, 5), {}, market);
    const summary = await run();
    expect(summary.status).toBe('empty');
    expect(storage.batchRows()).toEqual([
      expect.objectContaining({ status: 'empty', member_count: 0 }),
    ]);
  });

  it('records a store failure as a failed attempt', async () => {
    const clock = testClock(at(0, 33, 5));
    const storage = memoryDiscoveryStore({ failBatchInsert: '42501' });
    const summary = await runDailyDiscovery({
      store: storage.store,
      attemptId: 'gh-1-1',
      deps: {
        fetch: binanceFake(syntheticMarket(), clock).fetch,
        now: clock.now,
        sleep: clock.sleep,
      },
    });
    expect(summary).toMatchObject({ status: 'failed', failureCode: 'STORE_ERROR' });
    expect(storage.attemptRows()[0]?.detail).toBe('Recording the batch failed (42501)');
  });
});

describe('the collection window', () => {
  it('collects a run that starts 1 ms before 06:00 UTC and finishes in time', async () => {
    const { run } = setup(at(5, 59, 59, 999));
    // Every clock read in the fake is the same instant, so it finishes before the deadline.
    expect((await run()).status).toBe('complete');
  });

  it('records a run starting at 06:00 UTC as missed and fetches nothing', async () => {
    const { run, binance, storage } = setup(at(6));
    const summary = await run();
    expect(summary.status).toBe('missed');
    expect(binance.calls).toEqual([]);
    expect(storage.batches.size).toBe(0);
    expect(storage.attemptRows()[0]).toMatchObject({ status: 'missed', evidence_sha256: null });
  });

  it('before 00:30 UTC the due slot is yesterday’s, long past its deadline', async () => {
    const { run, binance } = setup(at(0, 10));
    const summary = await run();
    expect(summary).toMatchObject({ status: 'missed', slot: { date: '2026-11-19' } });
    expect(binance.calls).toEqual([]);
  });

  it('a collection finishing after the deadline is kept out, not backdated', async () => {
    const { run, storage } = setup(at(5, 59, 50), {
      ticker: [statusOf(503), statusOf(503)],
    });
    // 2 s and 8 s of backoff carry the clock past 06:00.
    const summary = await run();
    expect(summary).toMatchObject({ status: 'failed', failureCode: 'DEADLINE_PASSED' });
    expect(storage.batches.size).toBe(0);
  });

  it('records the actual start, not the scheduled time', async () => {
    const { run, storage } = setup(at(4, 41, 7));
    await run();
    expect(storage.attemptRows()[0]).toMatchObject({
      scheduled_for: '2026-11-20T00:30:00.000Z',
      started_at: '2026-11-20T04:41:07.000Z',
    });
  });
});

describe('Supabase storage', () => {
  function client(errors: Record<string, { code: string } | null>) {
    const inserted: { table: string; row: unknown }[] = [];
    const from = (table: string) => ({
      insert: async (row: unknown) => {
        inserted.push({ table, row });
        return { error: errors[table] ?? null };
      },
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({
            data: errors['read'] ? null : { evidence_sha256: 'a'.repeat(64) },
            error: errors['read'] ?? null,
          }),
        };
        return chain;
      },
    });
    return {
      inserted,
      client: { from } as unknown as Parameters<typeof supabaseDiscoveryStore>[0],
    };
  }

  it('reports a duplicate key as a duplicate and anything else by its code only', async () => {
    const duplicate = supabaseDiscoveryStore(
      client({ discovery_batches: { code: '23505' }, discovery_attempts: { code: '23505' } })
        .client,
    );
    await expect(duplicate.insertBatch({} as never)).resolves.toBe('duplicate');
    await expect(duplicate.insertAttempt({} as never)).resolves.toBe('duplicate');
    const refused = supabaseDiscoveryStore(
      client({ discovery_batches: { code: '42501' }, read: { code: 'PGRST301' } }).client,
    );
    await expect(refused.insertBatch({} as never)).rejects.toThrow(
      'Recording the batch failed (42501)',
    );
    await expect(refused.findBatch(DISCOVERY_POLICY_ID, '2026-11-20')).rejects.toThrow(
      '(PGRST301)',
    );
    const ok = supabaseDiscoveryStore(client({}).client);
    await expect(ok.findBatch(DISCOVERY_POLICY_ID, '2026-11-20')).resolves.toEqual({
      evidence_sha256: 'a'.repeat(64),
    });
  });
});

describe('the command', () => {
  const env = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      SUPABASE_URL: 'https://synthetic.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable',
      SUPABASE_DISCOVERY_EMAIL: 'automation@synthetic.invalid',
      SUPABASE_DISCOVERY_PASSWORD: 'synthetic',
    });
  });
  afterEach(() => {
    process.env = { ...env };
    supabaseJs.createClient.mockReset();
  });

  it('stops before any market request unless the sign-in has the discovery_automation role', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    supabaseJs.createClient.mockReturnValue({
      auth: {
        signInWithPassword: async () => ({
          data: { user: { id: 'u', app_metadata: { role: 'campaign_automation' } } },
          error: null,
        }),
      },
    });
    await expect(main()).rejects.toThrow('lacks the discovery_automation role');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('needs its configuration', async () => {
    delete process.env['SUPABASE_DISCOVERY_PASSWORD'];
    supabaseJs.createClient.mockReturnValue({ auth: {} });
    await expect(main()).rejects.toThrow('Set SUPABASE_DISCOVERY_PASSWORD');
  });
});
