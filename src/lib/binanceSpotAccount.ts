// Browser side of the owner-only Binance Spot balance view
// (docs/BINANCE_SPOT_ACCOUNT.md). It holds one account snapshot in component
// state: no query cache, no storage, and nothing here touches a portfolio,
// ledger, paper cash or simulation.
import { supabase } from '@/lib/supabaseClient';
import type {
  SpotAccountResponse,
  SpotBalance,
  SpotExecution,
  SpotExecutionCoverage,
} from '../../supabase/functions/binance-spot-account/handler';

export type {
  SpotBalance,
  SpotExecution,
  SpotExecutionCoverage,
  SpotExecutionFailure,
} from '../../supabase/functions/binance-spot-account/handler';

/** The function's answer, or `unavailable` when it gave none we recognize (not deployed, signed out). */
export type SpotRead =
  Exclude<SpotAccountResponse, { state: 'executions' }> | { state: 'unavailable' };
export type SpotFailure = Extract<SpotAccountResponse, { state: 'error' }>;

/** A balance read older than this is labeled stale. */
export const SPOT_STALE_AFTER_MS = 5 * 60 * 1000;
/** Longer than the function's own worst case (four 4 s requests). */
const READ_TIMEOUT_MS = 20_000;
const ERROR_CODES = new Set([
  'unauthenticated',
  'forbidden',
  'invalid_request',
  'binance_auth',
  'permissions_refused',
  'permissions_unverified',
  'rate_limited',
  'timeout',
  'network',
  'malformed_response',
  'provider_error',
]);

export interface SpotExecutionSelection {
  symbols: string[];
  startTime: number;
  endTime: number;
}

export type SpotExecutionRead =
  | Extract<SpotAccountResponse, { state: 'executions' }>
  | Extract<SpotAccountResponse, { state: 'error' }>
  | { state: 'not_configured' }
  | { state: 'unavailable' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBalance = (row: unknown): row is SpotBalance =>
  isRecord(row) &&
  typeof row['asset'] === 'string' &&
  typeof row['free'] === 'string' &&
  typeof row['locked'] === 'string';

const isExecution = (row: unknown): row is SpotExecution =>
  isRecord(row) &&
  typeof row['symbol'] === 'string' &&
  typeof row['tradeId'] === 'string' &&
  typeof row['orderId'] === 'string' &&
  typeof row['time'] === 'number' &&
  (row['side'] === 'buy' || row['side'] === 'sell') &&
  typeof row['quantity'] === 'string' &&
  typeof row['price'] === 'string' &&
  typeof row['quoteQuantity'] === 'string' &&
  typeof row['commission'] === 'string' &&
  typeof row['commissionAsset'] === 'string';

function parseFailure(body: Record<string, unknown>): SpotFailure | null {
  if (body['state'] !== 'error' || typeof body['error'] !== 'string') return null;
  if (!ERROR_CODES.has(body['error'])) return null;
  const retry = body['retryAfterSeconds'];
  const enabled = body['enabled'];
  return {
    state: 'error',
    error: body['error'] as SpotFailure['error'],
    ...(typeof retry === 'number' && retry > 0 ? { retryAfterSeconds: retry } : {}),
    ...(Array.isArray(enabled) ? { enabled: enabled.filter((x) => typeof x === 'string') } : {}),
  };
}

export function parseSpotRead(body: unknown): SpotRead {
  if (!isRecord(body)) return { state: 'unavailable' };
  if (body['state'] === 'not_configured') return { state: 'not_configured' };
  if (
    body['state'] === 'connected' &&
    typeof body['readAt'] === 'string' &&
    Number.isFinite(Date.parse(body['readAt'])) &&
    Array.isArray(body['balances']) &&
    body['balances'].every(isBalance)
  ) {
    return {
      state: 'connected',
      readAt: body['readAt'],
      balances: body['balances'].map(({ asset, free, locked }) => ({ asset, free, locked })),
    };
  }
  const failure = parseFailure(body);
  if (failure) return failure;
  return { state: 'unavailable' };
}

export function parseSpotExecutionRead(body: unknown): SpotExecutionRead {
  if (!isRecord(body)) return { state: 'unavailable' };
  if (body['state'] === 'not_configured') return { state: 'not_configured' };
  const failure = parseFailure(body);
  if (failure) return failure;
  const coverage = body['coverage'];
  if (
    body['state'] !== 'executions' ||
    !Array.isArray(body['executions']) ||
    !body['executions'].every(isExecution) ||
    !isRecord(coverage) ||
    !Array.isArray(coverage['symbols']) ||
    !coverage['symbols'].every((symbol) => typeof symbol === 'string') ||
    typeof coverage['startTime'] !== 'number' ||
    typeof coverage['endTime'] !== 'number' ||
    typeof coverage['returned'] !== 'number' ||
    typeof coverage['retrievedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(coverage['retrievedAt'])) ||
    typeof coverage['hasMore'] !== 'boolean' ||
    typeof coverage['partial'] !== 'boolean' ||
    !Array.isArray(coverage['failures']) ||
    coverage['limitation'] !== 'selected_pairs_and_24h_window'
  ) {
    return { state: 'unavailable' };
  }
  const failures = coverage['failures'];
  if (
    !failures.every(
      (failure) =>
        isRecord(failure) &&
        typeof failure['symbol'] === 'string' &&
        typeof failure['error'] === 'string' &&
        ERROR_CODES.has(failure['error']),
    )
  ) {
    return { state: 'unavailable' };
  }
  const executions = body['executions'].map((execution) => ({ ...execution })) as SpotExecution[];
  if (coverage['returned'] !== executions.length) return { state: 'unavailable' };
  return {
    state: 'executions',
    executions,
    coverage: {
      symbols: [...coverage['symbols']] as string[],
      startTime: coverage['startTime'],
      endTime: coverage['endTime'],
      returned: coverage['returned'],
      retrievedAt: coverage['retrievedAt'],
      hasMore: coverage['hasMore'],
      partial: coverage['partial'],
      failures: failures.map((failure) => ({
        symbol: failure['symbol'] as string,
        error: failure['error'] as SpotExecutionCoverage['failures'][number]['error'],
        ...(typeof failure['retryAfterSeconds'] === 'number'
          ? { retryAfterSeconds: failure['retryAfterSeconds'] }
          : {}),
      })),
      limitation: 'selected_pairs_and_24h_window',
    },
    ...(typeof body['continuation'] === 'string' ? { continuation: body['continuation'] } : {}),
  };
}

/**
 * One POST to the edge function, read with `parse`. Never throws: a non-2xx
 * answer carries its reason in the JSON body, and anything else is a timeout
 * or a network failure.
 */
async function invokeSpot<T>(
  body: Record<string, unknown> | undefined,
  parse: (body: unknown) => T,
): Promise<T | SpotFailure> {
  try {
    const { data, error } = await supabase.functions.invoke('binance-spot-account', {
      method: 'POST',
      ...(body ? { body } : {}),
      timeout: READ_TIMEOUT_MS,
    });
    if (!error) return parse(data);
    const context: unknown = (error as { context?: unknown }).context;
    if (context instanceof Response) return parse(await context.json().catch(() => null));
    const aborted = context instanceof Error && context.name === 'AbortError';
    return { state: 'error', error: aborted ? 'timeout' : 'network' };
  } catch {
    return { state: 'error', error: 'network' };
  }
}

/** One read of the owner's Spot balances through the edge function. Never throws. */
export function readSpotAccount(): Promise<SpotRead> {
  return invokeSpot(undefined, parseSpotRead);
}

/** Manual-only read of one execution page. The browser never creates a Binance query. */
export function readSpotExecutions(
  request: SpotExecutionSelection | { continuation: string },
): Promise<SpotExecutionRead> {
  return invokeSpot({ action: 'executions', ...request }, parseSpotExecutionRead);
}

export interface SpotView {
  /** The newest request whose answer has been applied. */
  seq: number;
  /** `hidden`: this user is not the owner, or the server has no such function. */
  access: 'unknown' | 'hidden' | 'not_configured' | 'granted';
  /** The last successful read. Kept, and labeled, when a later read fails. */
  snapshot: { readAt: string; balances: SpotBalance[] } | null;
  failure: SpotFailure | null;
}

export const INITIAL_SPOT_VIEW: SpotView = {
  seq: 0,
  access: 'unknown',
  snapshot: null,
  failure: null,
};

/**
 * Folds the answer to request `seq` into the view. An answer to a request
 * older than one already applied is dropped, and a successful read never
 * replaces a snapshot Binance produced later, so overlapping refreshes cannot
 * move the view backwards.
 */
export function applySpotRead(view: SpotView, seq: number, read: SpotRead): SpotView {
  if (seq <= view.seq) return view;
  if (read.state === 'not_configured') {
    return { seq, access: 'not_configured', snapshot: null, failure: null };
  }
  if (read.state === 'unavailable') return { seq, access: 'hidden', snapshot: null, failure: null };
  if (read.state === 'error') {
    if (read.error === 'unauthenticated' || read.error === 'forbidden') {
      return { seq, access: 'hidden', snapshot: null, failure: null };
    }
    return { seq, access: 'granted', snapshot: view.snapshot, failure: read };
  }
  const kept =
    view.snapshot !== null && Date.parse(view.snapshot.readAt) > Date.parse(read.readAt)
      ? view.snapshot
      : { readAt: read.readAt, balances: read.balances };
  return { seq, access: 'granted', snapshot: kept, failure: null };
}

export function isSpotSnapshotStale(readAt: string, now: number): boolean {
  return now - Date.parse(readAt) > SPOT_STALE_AFTER_MS;
}
