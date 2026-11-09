// Browser side of the owner-only Binance Spot balance view
// (docs/BINANCE_SPOT_ACCOUNT.md). It holds one account snapshot in component
// state: no query cache, no storage, and nothing here touches a portfolio,
// ledger, paper cash or simulation.
import { supabase } from '@/lib/supabaseClient';
import type {
  SpotAccountResponse,
  SpotBalance,
} from '../../supabase/functions/binance-spot-account/handler';

export type { SpotBalance };

/** The function's answer, or `unavailable` when it gave none we recognize (not deployed, signed out). */
export type SpotRead = SpotAccountResponse | { state: 'unavailable' };
export type SpotFailure = Extract<SpotAccountResponse, { state: 'error' }>;

/** A balance read older than this is labeled stale. */
export const SPOT_STALE_AFTER_MS = 5 * 60 * 1000;
/** Longer than the function's own worst case (four 4 s requests). */
const READ_TIMEOUT_MS = 20_000;
const ERROR_CODES = new Set([
  'unauthenticated',
  'forbidden',
  'binance_auth',
  'permissions_refused',
  'permissions_unverified',
  'rate_limited',
  'timeout',
  'network',
  'malformed_response',
  'provider_error',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBalance = (row: unknown): row is SpotBalance =>
  isRecord(row) &&
  typeof row['asset'] === 'string' &&
  typeof row['free'] === 'string' &&
  typeof row['locked'] === 'string';

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
  if (body['state'] === 'error' && typeof body['error'] === 'string') {
    if (!ERROR_CODES.has(body['error'])) return { state: 'unavailable' };
    const retry = body['retryAfterSeconds'];
    const enabled = body['enabled'];
    return {
      state: 'error',
      error: body['error'] as SpotFailure['error'],
      ...(typeof retry === 'number' && retry > 0 ? { retryAfterSeconds: retry } : {}),
      ...(Array.isArray(enabled) ? { enabled: enabled.filter((x) => typeof x === 'string') } : {}),
    };
  }
  return { state: 'unavailable' };
}

/** One read of the owner's Spot balances through the edge function. Never throws. */
export async function readSpotAccount(): Promise<SpotRead> {
  try {
    const { data, error } = await supabase.functions.invoke('binance-spot-account', {
      method: 'POST',
      timeout: READ_TIMEOUT_MS,
    });
    if (!error) return parseSpotRead(data);
    const context: unknown = (error as { context?: unknown }).context;
    // The function answered with a non-2xx status; its JSON body says why.
    if (context instanceof Response) return parseSpotRead(await context.json().catch(() => null));
    const aborted = context instanceof Error && context.name === 'AbortError';
    return { state: 'error', error: aborted ? 'timeout' : 'network' };
  } catch {
    return { state: 'error', error: 'network' };
  }
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
