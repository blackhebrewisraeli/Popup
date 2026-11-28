import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { RefreshBalancesButton, SpotBalanceReadout } from '@/components/BinanceSpotBalances';
import { readSpotAccount, type SpotRead } from '@/lib/binanceSpotAccount';
import {
  fetchReceivedAlerts,
  RECEIVED_ALERT_LIMIT,
  receivedAlertsKey,
  watchReceivedAlerts,
  type LiveStatus,
} from '@/lib/receivedAlerts';
import { useSpotBalances } from '@/lib/spotBalanceSession';

const LIVE_TEXT: Record<LiveStatus, string> = {
  connecting: 'Connecting to live updates…',
  live: 'Live. New alerts appear as they are received.',
  unavailable: 'Live updates unavailable. Use Refresh alerts to check for new ones.',
};

function SpotBalanceSummary({
  owner,
  read,
}: Readonly<{ owner: string; read: () => Promise<SpotRead> }>) {
  const balances = useSpotBalances(owner, read);
  return (
    <section className="portfolio-workspace-card spot-card" aria-labelledby="summary-spot-title">
      <div className="spot-head">
        <h2 id="summary-spot-title" className="portfolio-section-title">
          Binance Spot balances <span className="spot-chip">Read-only</span>
        </h2>
        <RefreshBalancesButton balances={balances} />
      </div>
      <SpotBalanceReadout balances={balances} />
    </section>
  );
}

function ReceivedAlerts({ userId }: Readonly<{ userId: string }>) {
  const queryClient = useQueryClient();
  const alerts = useQuery({
    queryKey: receivedAlertsKey(userId),
    queryFn: () => fetchReceivedAlerts(userId),
    retry: 1,
  });
  const [live, setLive] = useState<LiveStatus>('connecting');

  useEffect(() => {
    let active = true;
    const stop = watchReceivedAlerts(
      userId,
      () => void queryClient.invalidateQueries({ queryKey: receivedAlertsKey(userId) }),
      (status) => {
        if (active) setLive(status);
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [queryClient, userId]);

  const rows = alerts.data;
  return (
    <section className="portfolio-workspace-card spot-card" aria-labelledby="summary-alerts-title">
      <div className="spot-head">
        <div>
          <h2 id="summary-alerts-title" className="portfolio-section-title">
            Received TradingView alerts
          </h2>
          <p className="spot-note">
            The {RECEIVED_ALERT_LIMIT} most recent alerts your TradingView webhook delivered, as
            recorded. This list places no orders.
          </p>
        </div>
        <button
          type="button"
          className="portfolio-cash-btn"
          aria-disabled={alerts.isFetching}
          onClick={alerts.isFetching ? undefined : () => void alerts.refetch()}
        >
          <RefreshCw size={13} aria-hidden="true" />{' '}
          {alerts.isFetching ? 'Reading…' : 'Refresh alerts'}
        </button>
      </div>

      <p className="spot-status" role="status">
        {alerts.isPending && 'Reading received alerts… '}
        {LIVE_TEXT[live]}
      </p>

      {alerts.isError && (
        <p className="spot-failed" role="alert">
          {rows
            ? 'Refresh failed. Showing the alerts read earlier.'
            : 'Could not read received alerts.'}
        </p>
      )}

      {rows &&
        (rows.length === 0 ? (
          <p className="spot-note">No TradingView alerts have been received for this account.</p>
        ) : (
          <table className="spot-table">
            <caption className="sr-only">Received TradingView alerts</caption>
            <thead>
              <tr>
                <th scope="col">Symbol</th>
                <th scope="col">Action</th>
                <th scope="col">Received</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((alert) => (
                <tr key={alert.id}>
                  <th scope="row">{alert.ticker}</th>
                  <td>{alert.action}</td>
                  <td>
                    <time dateTime={alert.created_at}>
                      {new Date(alert.created_at).toLocaleString()}
                    </time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}

/**
 * The owner's account and alerts at a glance on the home screen: current
 * Binance Spot balances and the latest received TradingView alerts. Each half
 * loads and fails on its own. Read-only; rendered only after the owner check.
 */
export function OwnerSummary({
  userId,
  readBalances = readSpotAccount,
}: Readonly<{ userId: string; readBalances?: () => Promise<SpotRead> }>) {
  return (
    <section className="owner-summary" aria-label="Account and alerts">
      <SpotBalanceSummary owner={userId} read={readBalances} />
      <ReceivedAlerts userId={userId} />
    </section>
  );
}
