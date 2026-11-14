import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { BinanceSpotExecutions } from '@/components/BinanceSpotExecutions';
import { BinanceSpotReconciliation } from '@/components/BinanceSpotReconciliation';
import {
  applySpotRead,
  INITIAL_SPOT_VIEW,
  isSpotSnapshotStale,
  readSpotAccount,
  type SpotFailure,
  type SpotRead,
} from '@/lib/binanceSpotAccount';

/** Wait this long after a rate limit when Binance names no delay. */
const DEFAULT_BACKOFF_SECONDS = 60;

function failureText(failure: SpotFailure): string {
  switch (failure.error) {
    case 'binance_auth':
      return 'Binance rejected the API key or its signature. Check the key, its IP restriction and that reading is enabled.';
    case 'permissions_refused':
      return `Refused: this API key can do more than read (${(failure.enabled ?? []).join(', ') || 'unnamed capability'}). Only a read-only key is accepted, so no balances were read.`;
    case 'permissions_unverified':
      return 'Unverified: Binance did not confirm what this API key may do, so no balances were read.';
    case 'rate_limited':
      return `Binance rate limit reached. Refresh is paused for about ${failure.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS} seconds.`;
    case 'timeout':
      return 'Binance did not answer in time.';
    case 'network':
      return 'Could not reach the server or Binance.';
    case 'malformed_response':
      return 'Binance sent a response that could not be read as balances.';
    default:
      return 'Binance reported an error.';
  }
}

/**
 * The owner's Binance Spot balances, read-only. Renders nothing until the
 * server has answered, and nothing at all for anyone but the configured owner.
 * This snapshot is display-only: it never becomes a deposit, position or
 * transaction in any Popup ledger.
 */
export function BinanceSpotBalances({
  accountContext,
  read = readSpotAccount,
  children,
}: Readonly<{
  /** The signed-in owner, so a reconciliation never mixes reads made for different owners. */
  accountContext: string;
  read?: () => Promise<SpotRead>;
  /** More owner-only sections, shown inside this card only when the card itself is shown. */
  children?: ReactNode;
}>) {
  const [view, setView] = useState(INITIAL_SPOT_VIEW);
  const [reading, setReading] = useState(false);
  const [pausedUntil, setPausedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const initialReadRef = useRef(false);

  const refresh = useCallback(() => {
    const seq = ++seqRef.current;
    setReading(true);
    void read()
      .catch((): SpotRead => ({ state: 'error', error: 'network' }))
      .then((result) => {
        if (!mountedRef.current) return;
        setView((current) => applySpotRead(current, seq, result));
        setNow(Date.now());
        if (result.state === 'error' && result.error === 'rate_limited') {
          const seconds = result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS;
          setPausedUntil(Date.now() + seconds * 1000);
        }
        if (seq === seqRef.current) setReading(false);
      });
  }, [read]);

  useEffect(() => {
    mountedRef.current = true;
    // React StrictMode runs this effect, its cleanup and the effect again on
    // one instance. The first run's read is still in flight and its answer is
    // still wanted, so the second run must not send another.
    if (!initialReadRef.current) {
      initialReadRef.current = true;
      refresh();
    }
    // Re-evaluates "stale" and the rate-limit pause as time passes.
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mountedRef.current = false;
      clearInterval(tick);
    };
  }, [refresh]);

  if (view.access === 'unknown' || view.access === 'hidden') return null;

  const { snapshot, failure } = view;
  const paused = now < pausedUntil;
  const stale = snapshot !== null && isSpotSnapshotStale(snapshot.readAt, now);

  return (
    <section className="portfolio-workspace-card spot-card" aria-labelledby="spot-title">
      <div className="spot-head">
        <div>
          <h3 id="spot-title" className="portfolio-section-title">
            Binance Spot <span className="spot-chip">Read-only</span>
          </h3>
          <p className="spot-note">
            Balances as reported by Binance. Popup cannot place orders, withdraw or transfer, and
            these balances are separate from paper cash, tracked holdings and simulations.
          </p>
        </div>
        <button
          type="button"
          className="portfolio-cash-btn"
          // aria-disabled, not disabled: a disabled button drops keyboard focus mid-refresh.
          aria-disabled={reading || paused}
          onClick={reading || paused ? undefined : refresh}
        >
          <RefreshCw size={13} aria-hidden="true" /> {reading ? 'Reading…' : 'Refresh balances'}
        </button>
      </div>

      <p className="spot-status" role="status">
        {reading && 'Reading balances from Binance… '}
        {view.access === 'not_configured' &&
          'Not configured. The server has no enabled read-only Binance connection.'}
        {snapshot !== null && (
          <>
            {failure
              ? 'Not current. Showing the last successful read, from '
              : 'Connected. Key verified read-only. Last successful read '}
            <time dateTime={snapshot.readAt}>{new Date(snapshot.readAt).toLocaleString()}</time>
            {'. '}
            {stale && (
              <>
                <span className="freshness-badge freshness-stale">Stale</span> Read more than 5
                minutes ago.
              </>
            )}
          </>
        )}
      </p>

      {failure && (
        <p className="spot-failed" role="alert">
          {snapshot !== null && 'Refresh failed. '}
          {failureText(failure)}
        </p>
      )}

      {snapshot !== null &&
        (snapshot.balances.length === 0 ? (
          <p className="spot-note">Binance reports no non-zero Spot balances.</p>
        ) : (
          <table className="spot-table">
            <caption className="sr-only">Binance Spot balances</caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Available</th>
                <th scope="col">Locked</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.balances.map((balance) => (
                <tr key={balance.asset}>
                  <th scope="row">{balance.asset}</th>
                  <td>{balance.free}</td>
                  <td>{balance.locked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

      <BinanceSpotExecutions />
      <BinanceSpotReconciliation key={accountContext} accountContext={accountContext} />
      {children}
    </section>
  );
}
