// The synthetic quantity-reconciliation pipeline, end to end
// (docs/BINANCE_SPOT_RECONCILIATION.md, section 9 acceptance record):
// supabase-js in the browser → the committed edge-function handler, with its injected env, fetch
// and clock → a synthetic Binance → the handler's JSON → readSpotAccount / readSpotExecutions
// (parseSpotRead / parseSpotExecutionRead) → nextExecutionEvidence → reconcileSpotQuantity.
// Only Binance, Supabase Auth and the clock are synthetic. Every user, key, time, ID and amount is
// invented, and every expected figure is worked by hand in the comments, not by the code under
// test. Nothing here waits, touches the network or reads a credential.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const edge = vi.hoisted(() => ({
  serve: (_req: Request): Promise<Response> => Promise.reject(new Error('no edge function')),
  sessionToken: 'synthetic-owner-session',
}));

vi.mock('@/lib/supabaseClient', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://project.supabase.test', 'synthetic-anon-key', {
      accessToken: async () => edge.sessionToken,
      global: {
        // The network between the browser and the function. The client's abort signal is not
        // forwarded: nothing here can time out, and jsdom's AbortSignal is not one Node's
        // Request accepts.
        fetch: (input: RequestInfo | URL, init?: RequestInit) =>
          edge.serve(
            new Request(input, {
              method: init?.method ?? 'GET',
              headers: init?.headers ?? {},
              body: init?.body ?? null,
            }),
          ),
      },
    }),
  };
});

import {
  readSpotAccount,
  readSpotExecutions,
  type SpotExecutionRead,
} from '@/lib/binanceSpotAccount';
import {
  nextExecutionEvidence,
  requestedCoverageComplete,
  type SpotExecutionEvidence,
} from '@/lib/binanceSpotEvidence';
import {
  QUANTITY_LIMITS,
  RECONCILIATION_GUARD_MS,
  reconcileSpotQuantity,
  type QuantityReconciliation,
  type SpotBalanceObservation,
} from '@/lib/binanceSpotReconciliation';
import {
  ENDPOINTS,
  handleSpotAccount,
  type SpotBalance,
} from '../../supabase/functions/binance-spot-account/handler';

const OWNER = 'synthetic-owner-0001';
const OTHER_OWNER = 'synthetic-owner-0002';
const SESSIONS: Record<string, string> = {
  'synthetic-owner-session': OWNER,
  'synthetic-other-owner-session': OTHER_OWNER,
};
const API_KEY = 'synthetic-binance-key';

const MIN = 60_000;
const HOUR = 60 * MIN;
const G = RECONCILIATION_GUARD_MS;
/** Opening and closing balance reads (O and C), twelve hours apart. */
const O = Date.parse('2026-11-10T08:00:00.000Z');
const C = O + 12 * HOUR;
const WINDOW = { startTime: O - G, endTime: C + G };
/** First and second execution pages, both after C + g. */
const T1 = C + G + 5_000;
const T2 = T1 + 30_000;
const iso = (time: number) => new Date(time).toISOString();

const READ_ONLY_KEY = {
  ipRestrict: false,
  enableReading: true,
  enableWithdrawals: false,
  enableInternalTransfer: false,
  enableMargin: false,
  enableFutures: false,
  permitsUniversalTransfer: false,
  enableVanillaOptions: false,
  enableFixApiTrade: false,
  enableFixReadOnly: false,
  enableSpotAndMarginTrading: false,
  enablePortfolioMarginTrading: false,
};

/** One row of GET /api/v3/myTrades as Binance documents it. */
interface BinanceTrade {
  symbol: string;
  id: number;
  orderId: number;
  orderListId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
  isBestMatch: boolean;
}

function trade(
  symbol: string,
  id: number,
  time: number,
  side: 'buy' | 'sell',
  qty: string,
  [commission, commissionAsset]: [string, string],
): BinanceTrade {
  return {
    symbol,
    id,
    orderId: 900_000 + id,
    orderListId: -1,
    price: '100.00000000',
    qty,
    quoteQty: '1.00000000',
    commission,
    commissionAsset,
    time,
    isBuyer: side === 'buy',
    isMaker: false,
    isBestMatch: true,
  };
}

/** BTCUSDT fills by trade ID mod 3. */
const BTC_ROTATION: [side: 'buy' | 'sell', qty: string, fee: [string, string]][] = [
  ['sell', '0.01500000', ['0.02250000', 'USDT']],
  ['buy', '0.01000000', ['0.00001000', 'BTC']], // a fee in the subject
  ['buy', '0.02000000', ['0.00150000', 'BNB']], // a fee in a third asset
];

/** BTCUSDT fills `first`..`last`, one a minute from O + 1 h, in BTC_ROTATION. */
function btcFills(first: number, last: number): BinanceTrade[] {
  return Array.from({ length: last - first + 1 }, (_, index) => {
    const id = first + index;
    const [side, qty, fee] = BTC_ROTATION[id % 3] as (typeof BTC_ROTATION)[number];
    return trade('BTCUSDT', id, O + HOUR + (id - 1000) * MIN, side, qty, fee);
  });
}

/** ETHUSDT fills `first`..`last`, each a buy of 0.1 ETH paying 0.0001 BNB. */
function ethFills(first: number, last: number): BinanceTrade[] {
  const fills: BinanceTrade[] = [];
  for (let id = first; id <= last; id++) {
    const time = O + HOUR + (id - 7000) * MIN + 30_000;
    fills.push(trade('ETHUSDT', id, time, 'buy', '0.10000000', ['0.00010000', 'BNB']));
  }
  return fills;
}

type Fault = (path: string, params: URLSearchParams) => Response | Error | null;

/** A synthetic api.binance.com that answers the four documented GETs from in-memory records. */
const provider = {
  balances: [] as SpotBalance[],
  trades: [] as BinanceTrade[],
  /** Rewrites one myTrades page before it is sent (overlaps, repeats, conflicting rows). */
  page: (rows: BinanceTrade[], _params: URLSearchParams): BinanceTrade[] => rows,
  fault: null as Fault | null,
  requests: [] as { path: string; params: URLSearchParams; apiKey: string | null }[],
};

let clock = 0;
let env: Record<string, string> = {};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** GET /api/v3/myTrades: one symbol, oldest first, [startTime, endTime] or id ≥ fromId, at most `limit`. */
function myTrades(params: URLSearchParams): BinanceTrade[] {
  const rows = provider.trades
    .filter((row) => row.symbol === params.get('symbol'))
    .sort((left, right) => left.id - right.id);
  const fromId = params.get('fromId');
  const selected =
    fromId === null
      ? rows.filter(
          (row) =>
            row.time >= Number(params.get('startTime')) &&
            row.time <= Number(params.get('endTime')),
        )
      : rows.filter((row) => row.id >= Number(fromId));
  return selected.slice(0, Number(params.get('limit') ?? 500));
}

async function providerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.href === `${env['SUPABASE_URL']}/auth/v1/user`) {
    const user = SESSIONS[(headers.get('Authorization') ?? '').replace(/^Bearer /, '')];
    return user ? json({ id: user }) : json({ msg: 'invalid JWT' }, 401);
  }
  if (url.origin !== 'https://api.binance.com' || init?.method !== 'GET') {
    throw new Error(`unexpected request: ${init?.method} ${url.origin}${url.pathname}`);
  }
  const { pathname: path, searchParams: params } = url;
  provider.requests.push({ path, params, apiKey: headers.get('X-MBX-APIKEY') });
  const fault = provider.fault?.(path, params) ?? null;
  if (fault instanceof Error) throw fault;
  if (fault) return fault;
  if (path === ENDPOINTS.time) return json({ serverTime: clock });
  if (path === ENDPOINTS.keyPermissions) return json(READ_ONLY_KEY);
  if (path === ENDPOINTS.account) return json({ accountType: 'SPOT', balances: provider.balances });
  if (path === ENDPOINTS.trades) return json(provider.page(myTrades(params), params));
  throw new Error(`unexpected path ${path}`);
}

/** The next request that matches gets `reply` instead of the documented answer. */
function failNext(
  matches: (path: string, params: URLSearchParams) => boolean,
  reply: () => Response | Error,
) {
  let pending = true;
  provider.fault = (path, params) => {
    if (!pending || !matches(path, params)) return null;
    pending = false;
    return reply();
  };
}

beforeEach(() => {
  clock = 0;
  env = {
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_ANON_KEY: 'synthetic-anon-key',
    BINANCE_SPOT_READONLY_ENABLED: 'true',
    BINANCE_SPOT_OWNER_USER_ID: OWNER,
    BINANCE_SPOT_API_KEY: API_KEY,
    BINANCE_SPOT_API_SECRET: 'synthetic-binance-secret',
  };
  edge.sessionToken = 'synthetic-owner-session';
  edge.serve = (req) =>
    handleSpotAccount(req, {
      env: (name) => env[name],
      fetch: providerFetch as typeof fetch,
      log: () => undefined,
      now: () => clock,
    });
  Object.assign(provider, {
    balances: [],
    trades: [],
    page: (rows: BinanceTrade[]) => rows,
    fault: null,
    requests: [],
  });
});

/** One balance read through the browser client at `at`, labeled with the caller's account context. */
async function balanceRead(
  at: number,
  balances: SpotBalance[],
  accountContext = OWNER,
): Promise<SpotBalanceObservation> {
  clock = at;
  provider.balances = balances;
  return { accountContext, read: await readSpotAccount() };
}

async function executionPage(
  at: number,
  request: Parameters<typeof readSpotExecutions>[0],
): Promise<SpotExecutionRead> {
  clock = at;
  return readSpotExecutions(request);
}

function continuationOf(read: SpotExecutionRead): string {
  if (read.state !== 'executions' || read.continuation === undefined) {
    throw new Error(`expected a continuation, got ${JSON.stringify(read)}`);
  }
  return read.continuation;
}

/** Folds a retrieval's answers as the execution view does: the first starts it, the rest continue it. */
function fold(...answers: SpotExecutionRead[]): SpotExecutionEvidence {
  let evidence: SpotExecutionEvidence | null = null;
  for (const [index, answer] of answers.entries()) {
    evidence = nextExecutionEvidence(evidence, answer, index > 0);
  }
  if (evidence === null) throw new Error('the retrieval produced no evidence');
  return evidence;
}

function reconcile(
  opening: SpotBalanceObservation,
  closing: SpotBalanceObservation,
  evidence: SpotExecutionEvidence,
  subject = 'BTC',
  accountContext = OWNER,
): QuantityReconciliation {
  return reconcileSpotQuantity({
    subject,
    opening,
    closing,
    executions: { accountContext, evidence },
  });
}

const reasons = (result: QuantityReconciliation) =>
  result.status === 'INDETERMINATE' ? result.reasons : [];

/** The myTrades requests Binance saw, without the signing parameters. */
const tradeRequests = () =>
  provider.requests
    .filter((request) => request.path === ENDPOINTS.trades)
    .map(({ params }) =>
      Object.fromEntries(
        [...params].filter(([name]) => !['recvWindow', 'timestamp', 'signature'].includes(name)),
      ),
    );

const OPENING_BTC: SpotBalance[] = [
  { asset: 'BTC', free: '0.25000000', locked: '0.05000000' },
  { asset: 'USDT', free: '500.00000000', locked: '0.00000000' },
];

/**
 * Fills 1001..1150: 50 of each rotation.
 * buys 50 × 0.01 + 50 × 0.02 = 1.5; sells 50 × 0.015 = 0.75; BTC fees 50 × 0.00001 = 0.0005.
 * movement = 1.5 − 0.75 − 0.0005 = 0.7495; opening 0.25 + 0.05 = 0.3; expected 1.0495.
 */
const CLOSING_BTC_1150: SpotBalance[] = [
  { asset: 'BTC', free: '1.00000000', locked: '0.04950000' },
  { asset: 'USDT', free: '501.12500000', locked: '0.00000000' },
];

/**
 * BTCUSDT 1001..1150 and ETHUSDT 7001..7003 over WINDOW, in two pages. Binance repeats fill
 * 1050 identically within page 1, sends two spellings of ETH fill 7002 within page 1, and opens
 * page 2 by repeating the last fill of page 1 identically.
 */
async function overlappingRetrieval() {
  provider.trades = [...btcFills(1001, 1150), ...ethFills(7001, 7003)];
  provider.page = (rows, params) => {
    if (params.get('symbol') === 'ETHUSDT') {
      const [first, second, third] = rows as [BinanceTrade, BinanceTrade, BinanceTrade];
      return [first, second, { ...second, commission: '0.0001' }, third];
    }
    const fromId = params.get('fromId');
    if (fromId === null)
      return [...rows.slice(0, 50), rows[49] as BinanceTrade, ...rows.slice(50)].slice(0, 100);
    const previous = provider.trades.find((row) => row.id === Number(fromId) - 1) as BinanceTrade;
    return [previous, ...rows];
  };
  const first = await executionPage(T1, { symbols: ['BTCUSDT', 'ETHUSDT'], ...WINDOW });
  const second = await executionPage(T2, { continuation: continuationOf(first) });
  return { first, second, evidence: fold(first, second) };
}

describe('handler → client parsers → evidence fold → reconcileSpotQuantity (synthetic)', () => {
  it('two balance reads and a paginated retrieval with overlaps and fees in three assets reconcile exactly', async () => {
    const opening = await balanceRead(O, OPENING_BTC);
    const closing = await balanceRead(C, CLOSING_BTC_1150);
    const { first, second, evidence } = await overlappingRetrieval();

    // The function's own clock and Binance's exact strings survive the client parser.
    expect(opening.read).toEqual({ state: 'connected', readAt: iso(O), balances: OPENING_BTC });
    expect(closing.read).toEqual({
      state: 'connected',
      readAt: iso(C),
      balances: CLOSING_BTC_1150,
    });

    // Page 1: BTC 1001..1099 once each (1050 collapsed), ETH 7001 and 7003 plus one conflict.
    // ETH's page was short, so it alone ended; BTC's full page left a cursor at 1100.
    expect(first).toMatchObject({
      state: 'executions',
      coverage: {
        symbols: ['BTCUSDT', 'ETHUSDT'],
        ...WINDOW,
        returned: 101,
        retrievedAt: iso(T1),
        hasMore: true,
        partial: false,
        completedSymbols: ['ETHUSDT'],
      },
    });
    // Page 2 asked for BTC only, from 1100: 1099 (the repeat) and 1100..1150, then BTC ended.
    expect(second).toMatchObject({
      state: 'executions',
      coverage: {
        returned: 52,
        retrievedAt: iso(T2),
        hasMore: false,
        completedSymbols: ['BTCUSDT'],
      },
    });
    expect(second).not.toHaveProperty('continuation');
    expect(tradeRequests()).toEqual([
      { symbol: 'BTCUSDT', startTime: String(O - G), endTime: String(C + G), limit: '100' },
      { symbol: 'ETHUSDT', startTime: String(O - G), endTime: String(C + G), limit: '100' },
      { symbol: 'BTCUSDT', fromId: '1100', limit: '100' },
    ]);

    // Accumulated: both repeats collapsed, the conflict kept with both spellings, terminal
    // success named per pair, and the first page's time kept beside the latest.
    expect(evidence.executions).toHaveLength(152);
    expect(evidence.conflicts).toEqual([
      {
        symbol: 'ETHUSDT',
        tradeId: '7002',
        variants: [
          expect.objectContaining({ commission: '0.00010000' }),
          expect.objectContaining({ commission: '0.0001' }),
        ],
      },
    ]);
    expect(evidence).toMatchObject({
      firstRetrievedAt: iso(T1),
      retrievedAt: iso(T2),
      continuation: null,
      partialFailures: [],
      continuationFailures: [],
      completedSymbols: ['ETHUSDT', 'BTCUSDT'],
    });
    // The ETH conflict leaves the retrieval incomplete but does not touch BTC (E4).
    expect(requestedCoverageComplete(evidence)).toBe(false);

    const result = reconcile(opening, closing, evidence);
    expect(result).toMatchObject({
      status: 'CONSISTENT',
      opening: '0.30000000',
      buys: '1.50000000',
      sells: '0.75000000',
      subjectFees: '0.00050000',
      movement: '0.74950000',
      expected: '1.04950000',
      closing: '1.04950000',
      difference: '0.00000000',
      // BNB 50 × 0.0015 = 0.075; USDT 50 × 0.0225 = 1.125. Kept in their own assets.
      feesInOtherAssets: [
        { asset: 'BNB', amount: '0.07500000' },
        { asset: 'USDT', amount: '1.12500000' },
      ],
    });
    expect(result.status === 'CONSISTENT' && result.countedTradeIds).toEqual(
      Array.from({ length: 150 }, (_, index) => String(1001 + index)),
    );
  });

  it('a closing quantity one satoshi short is an exact, signed, unattributed DISCREPANCY', async () => {
    const opening = await balanceRead(O, OPENING_BTC);
    // 0.99999999 + 0.0495 = 1.04949999; difference = 1.04949999 − 1.0495 = −0.00000001.
    const closing = await balanceRead(C, [
      { asset: 'BTC', free: '0.99999999', locked: '0.04950000' },
    ]);
    const { evidence } = await overlappingRetrieval();
    expect(reconcile(opening, closing, evidence)).toMatchObject({
      status: 'DISCREPANCY',
      expected: '1.04950000',
      closing: '1.04949999',
      difference: '-0.00000001',
    });
  });

  it('a failed subject page stays failed after the other pair continues and ends successfully', async () => {
    provider.trades = [...btcFills(1001, 1010), ...ethFills(7001, 7120)];
    failNext(
      (path, params) => path === ENDPOINTS.trades && params.get('symbol') === 'BTCUSDT',
      () => json({ code: -1000, msg: 'synthetic' }, 500),
    );
    const opening = await balanceRead(O, OPENING_BTC);
    // ETH: 120 buys × 0.1 = 12, fees in BNB only; opening holds no ETH.
    const closing = await balanceRead(C, [
      { asset: 'BTC', free: '0.25000000', locked: '0.05000000' },
      { asset: 'ETH', free: '12.00000000', locked: '0.00000000' },
    ]);
    const first = await executionPage(T1, { symbols: ['BTCUSDT', 'ETHUSDT'], ...WINDOW });
    const second = await executionPage(T2, { continuation: continuationOf(first) });

    expect(first).toMatchObject({
      coverage: {
        partial: true,
        failures: [{ symbol: 'BTCUSDT', error: 'provider_error' }],
        completedSymbols: [],
        hasMore: true,
      },
    });
    // The continuation only carries ETH; its successful terminal page reports no failure.
    expect(second).toMatchObject({
      coverage: { partial: false, failures: [], completedSymbols: ['ETHUSDT'], hasMore: false },
    });
    expect(
      tradeRequests().map((request) => `${request['symbol']}:${request['fromId'] ?? 'start'}`),
    ).toEqual(['BTCUSDT:start', 'ETHUSDT:start', 'ETHUSDT:7101']);

    const evidence = fold(first, second);
    expect(evidence).toMatchObject({
      continuation: null,
      partialFailures: [{ symbol: 'BTCUSDT', error: 'provider_error' }],
      completedSymbols: ['ETHUSDT'],
      firstRetrievedAt: iso(T1),
    });
    expect(requestedCoverageComplete(evidence)).toBe(false);
    // No continuation is not completion for BTC...
    expect(reasons(reconcile(opening, closing, evidence))).toEqual([
      { code: 'pair_failed', items: ['provider_error'] },
    ]);
    // ...and BTC's failure does not reach ETH: 0 + 12 = 12.
    expect(reconcile(opening, closing, evidence, 'ETH')).toMatchObject({
      status: 'CONSISTENT',
      expected: '12.00000000',
      feesInOtherAssets: [{ asset: 'BNB', amount: '0.01200000' }],
    });
  });

  it('a top-level continuation failure stays evidence after an explicit retry of the same cursor', async () => {
    provider.trades = btcFills(1001, 1150);
    const opening = await balanceRead(O, OPENING_BTC);
    const closing = await balanceRead(C, CLOSING_BTC_1150);
    const first = await executionPage(T1, { symbols: ['BTCUSDT'], ...WINDOW });
    const cursor = continuationOf(first);

    // Binance's clock does not answer, so the function fails before reading any page.
    failNext(
      (path) => path === ENDPOINTS.time,
      () => Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' }),
    );
    const failed = await executionPage(T2, { continuation: cursor });
    expect(failed).toEqual({ state: 'error', error: 'timeout' });
    const afterFailure = fold(first, failed);
    expect(afterFailure).toMatchObject({
      continuation: cursor,
      continuationFailures: [{ state: 'error', error: 'timeout' }],
      retrievedAt: iso(T1),
    });

    const retried = await executionPage(T2 + 60_000, { continuation: cursor });
    const evidence = nextExecutionEvidence(afterFailure, retried, true) as SpotExecutionEvidence;
    expect(tradeRequests().map((request) => request['fromId'] ?? 'start')).toEqual([
      'start',
      '1101',
    ]);
    expect(evidence).toMatchObject({
      firstRetrievedAt: iso(T1),
      retrievedAt: iso(T2 + 60_000),
      continuation: null,
      completedSymbols: ['BTCUSDT'],
      continuationFailures: [{ state: 'error', error: 'timeout' }],
    });
    expect(evidence.executions).toHaveLength(150);
    expect(requestedCoverageComplete(evidence)).toBe(false);
    expect(reasons(reconcile(opening, closing, evidence))).toEqual([
      { code: 'continuation_failed', items: ['timeout'] },
    ]);
  });

  it('an exactly full page is incomplete until the empty terminal page arrives', async () => {
    provider.trades = btcFills(1001, 1100);
    const opening = await balanceRead(O, OPENING_BTC);
    // 1001..1100: rotation 2 ×34, 0 ×33, 1 ×33. buys 0.33 + 0.68 = 1.01; sells 0.495;
    // BTC fees 0.00033; movement 0.51467; expected 0.3 + 0.51467 = 0.81467.
    const closing = await balanceRead(C, [
      { asset: 'BTC', free: '0.76467000', locked: '0.05000000' },
    ]);
    const first = await executionPage(T1, { symbols: ['BTCUSDT'], ...WINDOW });
    expect(first).toMatchObject({
      coverage: { returned: 100, hasMore: true, completedSymbols: [] },
    });
    expect(reasons(reconcile(opening, closing, fold(first)))).toEqual([
      { code: 'pair_incomplete' },
    ]);

    const second = await executionPage(T2, { continuation: continuationOf(first) });
    expect(second).toMatchObject({
      executions: [],
      coverage: { returned: 0, hasMore: false, completedSymbols: ['BTCUSDT'] },
    });
    const evidence = fold(first, second);
    expect(requestedCoverageComplete(evidence)).toBe(true);
    expect(reconcile(opening, closing, evidence)).toMatchObject({
      status: 'CONSISTENT',
      movement: '0.51467000',
      expected: '0.81467000',
      difference: '0.00000000',
    });
  });

  it('a fill on the guard edge blocks the conclusion and is never summed', async () => {
    provider.trades = [
      trade('BTCUSDT', 2001, O + G, 'buy', '0.01000000', ['0.00001000', 'BTC']),
      trade('BTCUSDT', 2002, O + 6 * HOUR, 'buy', '0.01000000', ['0.00001000', 'BTC']),
    ];
    const opening = await balanceRead(O, OPENING_BTC);
    const closing = await balanceRead(C, [{ asset: 'BTC', free: '0.31998000', locked: '0' }]);
    const evidence = fold(await executionPage(T1, { symbols: ['BTCUSDT'], ...WINDOW }));
    expect(evidence.executions.map((fill) => fill.time)).toEqual([O + G, O + 6 * HOUR]);
    expect(reasons(reconcile(opening, closing, evidence))).toEqual([
      { code: 'fill_near_boundary', items: ['2001'] },
    ]);
  });

  it('a retrieval that began before C + g stays too early after a later page', async () => {
    provider.trades = btcFills(1001, 1150);
    const opening = await balanceRead(O, OPENING_BTC);
    const closing = await balanceRead(C, CLOSING_BTC_1150);
    const first = await executionPage(C + G - 1_000, { symbols: ['BTCUSDT'], ...WINDOW });
    const second = await executionPage(C + G + MIN, { continuation: continuationOf(first) });
    const evidence = fold(first, second);
    expect(evidence).toMatchObject({
      firstRetrievedAt: iso(C + G - 1_000),
      retrievedAt: iso(C + G + MIN),
      completedSymbols: ['BTCUSDT'],
    });
    // Judged by the latest page alone, this would be CONSISTENT.
    expect(reasons(reconcile(opening, closing, evidence))).toEqual([
      { code: 'executions_read_too_early' },
    ]);
  });

  it('a failed closing read reaches reconciliation as its parsed error', async () => {
    provider.trades = btcFills(1001, 1010);
    const opening = await balanceRead(O, OPENING_BTC);
    failNext(
      (path) => path === ENDPOINTS.account,
      () => json({ code: -1003, msg: 'synthetic' }, 418, { 'Retry-After': '120' }),
    );
    const closing = await balanceRead(C, CLOSING_BTC_1150);
    expect(closing.read).toEqual({ state: 'error', error: 'rate_limited', retryAfterSeconds: 120 });
    const evidence = fold(await executionPage(T1, { symbols: ['BTCUSDT'], ...WINDOW }));
    expect(reasons(reconcile(opening, closing, evidence))).toEqual([
      { code: 'closing_unavailable', items: ['rate_limited'] },
    ]);
  });

  it('reads served to different owners do not reconcile, though one Binance key answered both', async () => {
    provider.trades = btcFills(1001, 1010);
    const opening = await balanceRead(O, OPENING_BTC);
    const evidence = fold(await executionPage(T1, { symbols: ['BTCUSDT'], ...WINDOW }));
    // The deployment's owner changes; the function now serves only the other user.
    env['BINANCE_SPOT_OWNER_USER_ID'] = OTHER_OWNER;
    edge.sessionToken = 'synthetic-other-owner-session';
    const closing = await balanceRead(C, OPENING_BTC, OTHER_OWNER);
    expect(closing.read.state).toBe('connected');
    // The function reports no Binance account identity: the context is the caller's label, so a
    // match would not prove one Binance account either.
    expect(
      provider.requests
        .filter((request) => request.path === ENDPOINTS.account)
        .map((r) => r.apiKey),
    ).toEqual([API_KEY, API_KEY]);
    expect(reasons(reconcile(opening, closing, evidence))).toEqual([
      { code: 'account_context_mismatch' },
    ]);
  });
});

describe('retrieval isolation: a continued answer must belong to the retrieval it continues', () => {
  /**
   * Retrieval Y reads BTC from O + 30 min; retrieval X reads the reconciliation window, which also
   * holds fills 901..910 (buys of 0.01 BTC paying USDT) before O + 30 min. So X's first page ends
   * at 1090 and its continuation answer starts at 1091, while Y's cursor is 1101.
   */
  async function twoRetrievals() {
    provider.trades = [
      ...Array.from({ length: 10 }, (_, index) =>
        trade('BTCUSDT', 901 + index, O + (10 + index) * MIN, 'buy', '0.01000000', [
          '0.01000000',
          'USDT',
        ]),
      ),
      ...btcFills(1001, 1150),
    ];
    const y = await executionPage(T1, {
      symbols: ['BTCUSDT'],
      startTime: O + 30 * MIN,
      endTime: C + G,
    });
    const x = await executionPage(T1 + 1_000, { symbols: ['BTCUSDT'], ...WINDOW });
    const xContinued = await executionPage(T2, { continuation: continuationOf(x) });
    expect(tradeRequests().map((request) => request['fromId'] ?? request['startTime'])).toEqual([
      String(O + 30 * MIN),
      String(O - G),
      '1091',
    ]);
    return { y, x, xContinued };
  }

  /** Every fill counted: CLOSING_BTC_1150 plus 10 × 0.01 = 1.1495. */
  const CLOSING_ALL: SpotBalance[] = [{ asset: 'BTC', free: '1.10000000', locked: '0.04950000' }];

  it("does not merge another selection's continuation into the current evidence", async () => {
    const opening = await balanceRead(O, OPENING_BTC);
    const closing = await balanceRead(C, CLOSING_ALL);
    const { y, xContinued } = await twoRetrievals();
    const current = fold(y);
    const evidence = nextExecutionEvidence(current, xContinued, true) as SpotExecutionEvidence;

    // Merged, Y's page and X's later page would claim X's window while missing 901..910, and
    // reconcile to a confident DISCREPANCY of +0.1. Instead nothing of X is taken and the
    // retrieval stays unresolved.
    expect(evidence).toMatchObject({
      startTime: O + 30 * MIN,
      endTime: C + G,
      executions: current.executions,
      continuation: current.continuation,
      retrievedAt: iso(T1),
      completedSymbols: [],
      continuationFailures: [{ state: 'error', error: 'invalid_request' }],
    });
    expect(reasons(reconcile(opening, closing, evidence)).map((reason) => reason.code)).toEqual([
      'pair_incomplete',
      'continuation_failed',
      'execution_window_not_covering',
    ]);
  });

  it('does not start evidence from a continued answer with no retrieval to continue', async () => {
    const { xContinued } = await twoRetrievals();
    expect(nextExecutionEvidence(null, xContinued, true)).toBeNull();
  });

  it('still continues its own retrieval and then reconciles every fill', async () => {
    const opening = await balanceRead(O, OPENING_BTC);
    const closing = await balanceRead(C, CLOSING_ALL);
    const { x, xContinued } = await twoRetrievals();
    // buys 1.5 + 0.1 = 1.6; movement 1.6 − 0.75 − 0.0005 = 0.8495; expected 0.3 + 0.8495 = 1.1495.
    expect(reconcile(opening, closing, fold(x, xContinued))).toMatchObject({
      status: 'CONSISTENT',
      buys: '1.60000000',
      expected: '1.14950000',
      difference: '0.00000000',
    });
  });
});

describe('TRXUSDT through handler → client parser → evidence fold (synthetic)', () => {
  /** An invented TRXUSDT fill: `trade` with its own price and quote quantity. */
  const trx = (
    id: number,
    time: number,
    side: 'buy' | 'sell',
    [qty, price, quoteQty]: [string, string, string],
    fee: [string, string],
  ): BinanceTrade => ({ ...trade('TRXUSDT', id, time, side, qty, fee), price, quoteQty });

  /**
   * Three invented fills between O and C, one per commission asset:
   * buy 40 TRX at 0.28 paying 0.04 TRX (the received asset), sell 15 TRX at 0.29 paying
   * 0.00435 USDT, buy 25 TRX at 0.27 paying 0.00002 BNB.
   */
  const TRX_FILLS = [
    trx(
      8001,
      O + 2 * HOUR,
      'buy',
      ['40.00000000', '0.28000000', '11.20000000'],
      ['0.04000000', 'TRX'],
    ),
    trx(
      8002,
      O + 3 * HOUR,
      'sell',
      ['15.00000000', '0.29000000', '4.35000000'],
      ['0.00435000', 'USDT'],
    ),
    trx(
      8003,
      O + 4 * HOUR,
      'buy',
      ['25.00000000', '0.27000000', '6.75000000'],
      ['0.00002000', 'BNB'],
    ),
  ];

  it('requests only TRXUSDT and keeps each commission with its own asset, exactly as Binance wrote it', async () => {
    provider.trades = [...TRX_FILLS, ...btcFills(1001, 1003)];
    const answer = await executionPage(T1, { symbols: ['TRXUSDT'], ...WINDOW });

    // One signed myTrades request for the pair, with the window unchanged and the key attached.
    expect(tradeRequests()).toEqual([
      { symbol: 'TRXUSDT', startTime: String(O - G), endTime: String(C + G), limit: '100' },
    ]);
    expect(
      provider.requests
        .filter((request) => request.path === ENDPOINTS.trades)
        .every((request) => request.apiKey === API_KEY && request.params.has('signature')),
    ).toBe(true);
    expect(answer).toMatchObject({
      state: 'executions',
      conflicts: [],
      coverage: {
        symbols: ['TRXUSDT'],
        ...WINDOW,
        returned: 3,
        retrievedAt: iso(T1),
        hasMore: false,
        partial: false,
        failures: [],
        completedSymbols: ['TRXUSDT'],
      },
    });
    expect(answer).not.toHaveProperty('continuation');

    const evidence = fold(answer);
    // The BTC fills Binance also holds were never asked for.
    expect(evidence.executions).toEqual([
      {
        symbol: 'TRXUSDT',
        tradeId: '8001',
        orderId: '908001',
        time: O + 2 * HOUR,
        side: 'buy',
        quantity: '40.00000000',
        price: '0.28000000',
        quoteQuantity: '11.20000000',
        commission: '0.04000000',
        commissionAsset: 'TRX',
      },
      {
        symbol: 'TRXUSDT',
        tradeId: '8002',
        orderId: '908002',
        time: O + 3 * HOUR,
        side: 'sell',
        quantity: '15.00000000',
        price: '0.29000000',
        quoteQuantity: '4.35000000',
        commission: '0.00435000',
        commissionAsset: 'USDT',
      },
      {
        symbol: 'TRXUSDT',
        tradeId: '8003',
        orderId: '908003',
        time: O + 4 * HOUR,
        side: 'buy',
        quantity: '25.00000000',
        price: '0.27000000',
        quoteQuantity: '6.75000000',
        commission: '0.00002000',
        commissionAsset: 'BNB',
      },
    ]);
    expect(evidence).toMatchObject({ conflicts: [], completedSymbols: ['TRXUSDT'] });
    expect(requestedCoverageComplete(evidence)).toBe(true);
  });

  it('a repeated TRX fill collapses, and a respelled TRX commission becomes a conflict', async () => {
    provider.trades = TRX_FILLS;
    provider.page = (rows) => {
      const [first, second, third] = rows as [BinanceTrade, BinanceTrade, BinanceTrade];
      return [first, { ...first, commission: '0.04' }, second, second, third];
    };
    const evidence = fold(await executionPage(T1, { symbols: ['TRXUSDT'], ...WINDOW }));
    expect(evidence.executions.map((item) => item.tradeId)).toEqual(['8002', '8003']);
    expect(evidence.conflicts).toEqual([
      {
        symbol: 'TRXUSDT',
        tradeId: '8001',
        variants: [
          expect.objectContaining({ commission: '0.04000000', commissionAsset: 'TRX' }),
          expect.objectContaining({ commission: '0.04', commissionAsset: 'TRX' }),
        ],
      },
    ]);
    expect(requestedCoverageComplete(evidence)).toBe(false);
  });

  it('reconciles TRX as a subject, counting the TRX commission, while the commission gate stays unverified', async () => {
    provider.trades = TRX_FILLS;
    // opening 10; movement 40 + 25 − 15 − 0.04 (the TRX commission) = 49.96; expected 59.96.
    const opening = await balanceRead(O, [
      { asset: 'TRX', free: '10.00000000', locked: '0.00000000' },
    ]);
    const closing = await balanceRead(C, [
      { asset: 'TRX', free: '59.96000000', locked: '0.00000000' },
    ]);
    const evidence = fold(await executionPage(T1, { symbols: ['TRXUSDT'], ...WINDOW }));
    expect(reconcile(opening, closing, evidence, 'TRX')).toMatchObject({
      status: 'CONSISTENT',
      subject: 'TRX',
      symbol: 'TRXUSDT',
      opening: '10.00000000',
      buys: '65.00000000',
      sells: '15.00000000',
      subjectFees: '0.04000000',
      movement: '49.96000000',
      expected: '59.96000000',
      closing: '59.96000000',
      difference: '0.00000000',
      feesInOtherAssets: [
        { asset: 'BNB', amount: '0.00002000' },
        { asset: 'USDT', amount: '0.00435000' },
      ],
    });
    // This arithmetic is the documented hypothesis only. Adding a pair settles nothing about what
    // `commission` covers, so the view keeps every result Indeterminate (D3).
    expect(QUANTITY_LIMITS.commissionCoverage).toBe('unverified');
  });
});
