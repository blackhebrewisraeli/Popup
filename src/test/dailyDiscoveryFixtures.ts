/**
 * SYNTHETIC daily discovery fixtures: invented ZCT pairs, volumes, times and IDs. No request
 * leaves a test: Binance is a fake `fetch`, and storage is an in-process, insert-only store
 * with the database's uniqueness and immutability.
 */
import {
  DiscoveryStoreError,
  type DiscoveryAttemptInsert,
  type DiscoveryBatchInsert,
  type DiscoveryStore,
} from '../../scripts/dailyDiscovery';
import { DAY_MS } from '@/lib/dailyDiscovery';

/** 2026-11-20, the synthetic slot date. */
export const DAY = Date.parse('2026-11-20T00:00:00.000Z');
export const at = (hours: number, minutes = 0, seconds = 0, ms = 0) =>
  DAY + ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;

export const SYNTHETIC_PAIRS = 60;

/** ZCT001USDT … with strictly descending volumes; ZCT001 is the most traded. */
export function zct(index: number): string {
  return `ZCT${String(index).padStart(3, '0')}`;
}

export interface SyntheticMarket {
  serverTime?: number;
  instruments: unknown[];
  /** Built at request time, so windows end just before the fake response. */
  tickers: (now: number) => unknown[];
}

const instrument = (base: string, overrides: Record<string, unknown> = {}) => ({
  symbol: `${base}USDT`,
  status: 'TRADING',
  baseAsset: base,
  quoteAsset: 'USDT',
  isSpotTradingAllowed: true,
  // Binance sends much more per symbol; none of it is read.
  filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }],
  ...overrides,
});

const window = (symbol: string, quoteVolume: unknown, now: number, lag = 2_000) => ({
  symbol,
  openPrice: '1.00',
  lastPrice: '1.10',
  volume: '1000.00000000',
  quoteVolume,
  openTime: now - lag - DAY_MS,
  closeTime: now - lag,
  count: 10,
});

/**
 * 60 tradable ZCT pairs, a stablecoin base (USDC), a tokenized commodity (XAUT, kept and
 * labelled), BTCUSDT (for the exact-symbol detail route), a halted pair, a pair with spot
 * trading disallowed and a BTC-quoted pair that is never USDT-quoted.
 */
export function syntheticMarket(
  options: { volumeOf?: (symbol: string, fallback: string) => unknown } = {},
): SyntheticMarket {
  const volume = (symbol: string, fallback: string) =>
    options.volumeOf ? options.volumeOf(symbol, fallback) : fallback;
  const zctBases = Array.from({ length: SYNTHETIC_PAIRS }, (_, i) => zct(i + 1));
  return {
    instruments: [
      ...zctBases.map((base) => instrument(base)),
      instrument('USDC'),
      instrument('XAUT'),
      instrument('BTC'),
      instrument('ZCTHALT', { status: 'BREAK' }),
      instrument('ZCTNOSPOT', { isSpotTradingAllowed: false }),
      { ...instrument('ZCT001'), symbol: 'ZCT001BTC', quoteAsset: 'BTC' },
    ],
    tickers: (now) => [
      // ZCT001 trades 60,000,000.5 USDT, ZCT002 59,000,000.5 … ZCT060 1,000,000.5.
      ...zctBases.map((base, i) =>
        window(`${base}USDT`, volume(`${base}USDT`, `${(SYNTHETIC_PAIRS - i) * 1_000_000}.5`), now),
      ),
      window('USDCUSDT', volume('USDCUSDT', '999999999999.0'), now),
      window('XAUTUSDT', volume('XAUTUSDT', '30500000.25'), now),
      window('BTCUSDT', volume('BTCUSDT', '45000000.75'), now),
      window('ZCTHALTUSDT', '0.00000000', now, 12 * 3_600_000),
      window('ZCTNOSPOTUSDT', '88000000000.0', now),
      window('ZCT001BTC', '12.0', now),
    ],
  };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

/** One scripted answer per request to an endpoint; past the script, the market answers. */
export type Scripted = (now: number) => Response | Promise<Response>;

export function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

export function testClock(start: number) {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (value: number) => {
      current = value;
    },
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      current += ms;
    },
  };
}

export function binanceFake(
  market: SyntheticMarket,
  clock: { now: () => number },
  script: { exchangeInfo?: readonly Scripted[]; ticker?: readonly Scripted[] } = {},
) {
  const calls: string[] = [];
  const seen = { exchangeInfo: 0, ticker: 0 };
  const fake = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const endpoint = url.includes('/exchangeInfo') ? 'exchangeInfo' : 'ticker';
    if (!url.startsWith('https://api.binance.com/api/v3/')) {
      throw new Error(`Unexpected request: ${url}`);
    }
    const scripted = script[endpoint]?.[seen[endpoint]];
    seen[endpoint] += 1;
    if (scripted) return scripted(clock.now());
    return endpoint === 'exchangeInfo'
      ? json(200, {
          timezone: 'UTC',
          serverTime: market.serverTime ?? clock.now(),
          symbols: market.instruments,
        })
      : json(200, market.tickers(clock.now()));
  };
  return { fetch: fake as typeof fetch, calls };
}

/**
 * The database's contract in memory: one batch per (policy, slot), one attempt per ID,
 * inserts only, rows stored as text so nothing can change them afterwards.
 */
export function memoryDiscoveryStore(
  options: { failBatchInsert?: string; failAttemptInsert?: string } = {},
) {
  const batches = new Map<string, string>();
  const attempts = new Map<string, string>();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const store: DiscoveryStore = {
    async findBatch(policyId, slotDate) {
      await tick();
      const row = batches.get(`${policyId}|${slotDate}`);
      return row
        ? { evidence_sha256: (JSON.parse(row) as DiscoveryBatchInsert).evidence_sha256 }
        : null;
    },
    async insertBatch(row) {
      await tick();
      if (options.failBatchInsert) {
        throw new DiscoveryStoreError(`Recording the batch failed (${options.failBatchInsert})`);
      }
      const key = `${row.policy_id}|${row.slot_date}`;
      if (batches.has(key)) return 'duplicate';
      batches.set(key, JSON.stringify(row));
      return 'created';
    },
    async insertAttempt(row) {
      await tick();
      if (options.failAttemptInsert) throw new Error(options.failAttemptInsert);
      if (attempts.has(row.attempt_id)) return 'duplicate';
      attempts.set(row.attempt_id, JSON.stringify(row));
      return 'created';
    },
  };
  return {
    store,
    batches,
    attempts,
    /** The rows as PostgREST would return them: parsed again, newest first. */
    batchRows: () =>
      [...batches.values()]
        .map((row) => JSON.parse(row) as DiscoveryBatchInsert)
        .sort((a, b) => b.slot_date.localeCompare(a.slot_date)),
    attemptRows: () =>
      [...attempts.values()]
        .map((row) => JSON.parse(row) as DiscoveryAttemptInsert)
        .sort((a, b) => b.finished_at.localeCompare(a.finished_at)),
  };
}
