// One in-memory Binance Spot balance read shared by the home summary and the
// Journal for the signed-in owner (docs/BINANCE_SPOT_ACCOUNT.md). Nothing here
// is stored, cached elsewhere or written to any Popup ledger, and
// clearSpotBalanceSession drops it on logout or an owner change.
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  applySpotRead,
  INITIAL_SPOT_VIEW,
  readSpotAccount,
  type SpotRead,
  type SpotView,
} from '@/lib/binanceSpotAccount';

/** While a balance view is on screen in a visible tab, read this often. */
export const SPOT_REFRESH_MS = 60_000;
/** Wait this long after a rate limit when Binance names no delay. */
export const DEFAULT_BACKOFF_SECONDS = 60;
/** How often a mounted view checks whether a read is due and re-labels staleness. */
const TICK_MS = 5_000;

export interface SpotBalanceSession {
  owner: string;
  view: SpotView;
  /** A read is in flight. Only one is ever sent at a time. */
  reading: boolean;
  /** When the latest read was sent; the next automatic one is due SPOT_REFRESH_MS later. */
  sentAt: number;
  /** No read, automatic or manual, before this time (Binance's Retry-After). */
  pausedUntil: number;
}

let session: SpotBalanceSession | null = null;
const listeners = new Set<() => void>();

function set(next: SpotBalanceSession | null): void {
  session = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSession = () => session;

/** Drops the shared read unless it belongs to `keep`. An answer still in flight is then ignored. */
export function clearSpotBalanceSession(keep: string | null = null): void {
  if (session !== null && session.owner !== keep) set(null);
}

function isDue(owner: string, now: number): boolean {
  if (session?.owner !== owner) return true;
  return !session.reading && now >= session.pausedUntil && now - session.sentAt >= SPOT_REFRESH_MS;
}

/** Sends one read for `owner`, unless one is already in flight or Binance asked to wait. */
export function readSpotBalances(
  owner: string,
  read: () => Promise<SpotRead> = readSpotAccount,
): void {
  const now = Date.now();
  const current = session?.owner === owner ? session : null;
  if (current && (current.reading || now < current.pausedUntil)) return;
  const sent: SpotBalanceSession = {
    owner,
    view: current?.view ?? INITIAL_SPOT_VIEW,
    reading: true,
    sentAt: now,
    pausedUntil: 0,
  };
  set(sent);
  void read()
    .catch((): SpotRead => ({ state: 'error', error: 'network' }))
    .then((result) => {
      // Cleared (logout, owner change) or replaced since sending: not this session's answer.
      if (session !== sent) return;
      const backoff =
        result.state === 'error' && result.error === 'rate_limited'
          ? (result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS)
          : 0;
      set({
        ...sent,
        view: applySpotRead(sent.view, sent.view.seq + 1, result),
        reading: false,
        pausedUntil: backoff > 0 ? Date.now() + backoff * 1000 : 0,
      });
    });
}

export interface SpotBalances {
  view: SpotView;
  reading: boolean;
  /** Refresh is unavailable until Binance's Retry-After has passed. */
  paused: boolean;
  now: number;
  refresh: () => void;
}

/**
 * The owner's shared balance read for a view on screen. Reads on entry when
 * no read is fresh, then every SPOT_REFRESH_MS while the tab is visible, and
 * on return to the tab once a read is due.
 */
export function useSpotBalances(
  owner: string,
  read: () => Promise<SpotRead> = readSpotAccount,
): SpotBalances {
  const shared = useSyncExternalStore(subscribe, getSession, getSession);
  const mine = shared?.owner === owner ? shared : null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Under StrictMode this runs twice; the first read is then in flight, so isDue stops a second.
    const check = () => {
      const at = Date.now();
      setNow(at);
      if (document.visibilityState !== 'hidden' && isDue(owner, at)) readSpotBalances(owner, read);
    };
    check();
    const tick = setInterval(check, TICK_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', check);
    };
  }, [owner, read]);

  return {
    view: mine?.view ?? INITIAL_SPOT_VIEW,
    reading: mine?.reading ?? false,
    paused: mine !== null && now < mine.pausedUntil,
    now,
    refresh: () => readSpotBalances(owner, read),
  };
}
