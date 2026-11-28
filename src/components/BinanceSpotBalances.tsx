import { RefreshCw } from 'lucide-react';
import { BinanceSpotExecutions } from '@/components/BinanceSpotExecutions';
import { BinanceSpotReconciliation } from '@/components/BinanceSpotReconciliation';
import {
  isSpotSnapshotStale,
  readSpotAccount,
  type SpotFailure,
  type SpotRead,
} from '@/lib/binanceSpotAccount';
import {
  DEFAULT_BACKOFF_SECONDS,
  useSpotBalances,
  type SpotBalances,
} from '@/lib/spotBalanceSession';

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

/** Manual refresh of the shared read. Waits while a read is in flight or Binance asked to wait. */
export function RefreshBalancesButton({ balances }: Readonly<{ balances: SpotBalances }>) {
  const { reading, paused, refresh } = balances;
  return (
    <button
      type="button"
      className="portfolio-cash-btn"
      // aria-disabled, not disabled: a disabled button drops keyboard focus mid-refresh.
      aria-disabled={reading || paused}
      onClick={reading || paused ? undefined : refresh}
    >
      <RefreshCw size={13} aria-hidden="true" /> {reading ? 'Reading…' : 'Refresh balances'}
    </button>
  );
}

/**
 * Status, failure and balances of the shared read: asset, available and
 * locked exactly as Binance reported them, and when they were read.
 */
export function SpotBalanceReadout({ balances }: Readonly<{ balances: SpotBalances }>) {
  const { view, reading, now } = balances;
  const { snapshot, failure } = view;
  const stale = snapshot !== null && isSpotSnapshotStale(snapshot.readAt, now);

  return (
    <>
      <p className="spot-status" role="status">
        {reading && 'Reading balances from Binance… '}
        {view.access === 'hidden' &&
          'Unavailable. The server returned no Binance Spot balances for this sign-in.'}
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
    </>
  );
}

/**
 * The owner's Binance Spot balances, read-only. Renders nothing until the
 * server has answered, and nothing at all for anyone but the configured owner.
 * The read is shared with the home summary (lib/spotBalanceSession) and is
 * display-only: it never becomes a deposit, position or transaction in any
 * Popup ledger.
 */
export function BinanceSpotBalances({
  accountContext,
  read = readSpotAccount,
}: Readonly<{
  /** The signed-in owner, so a reconciliation never mixes reads made for different owners. */
  accountContext: string;
  read?: () => Promise<SpotRead>;
}>) {
  const balances = useSpotBalances(accountContext, read);
  const { access } = balances.view;
  if (access === 'unknown' || access === 'hidden') return null;

  return (
    <section className="portfolio-workspace-card spot-card" aria-labelledby="spot-title">
      <div className="spot-head">
        <div>
          <h2 id="spot-title" className="portfolio-section-title">
            Binance Spot <span className="spot-chip">Read-only</span>
          </h2>
          <p className="spot-note">
            Read balances and executions reported by Binance, then link fills to your recorded
            decisions.
          </p>
        </div>
        <RefreshBalancesButton balances={balances} />
      </div>

      <SpotBalanceReadout balances={balances} />

      <BinanceSpotExecutions linkFor={accountContext} />
      <BinanceSpotReconciliation key={accountContext} accountContext={accountContext} />
    </section>
  );
}
