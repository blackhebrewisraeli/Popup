import { useCallback, useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import {
  readSpotExecutions,
  type SpotExecution,
  type SpotExecutionFailure,
  type SpotExecutionRead,
  type SpotExecutionSelection,
  type SpotFailure,
} from '@/lib/binanceSpotAccount';

/** Mirrors the explicit server allowlist, sourced from the app's known crypto set. */
export const SPOT_EXECUTION_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'LTCUSDT',
] as const;

const RANGE_OPTIONS = [
  { hours: 1, label: 'Last hour' },
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
] as const;
const DEFAULT_BACKOFF_SECONDS = 60;

interface ExecutionSnapshot {
  executions: SpotExecution[];
  symbols: string[];
  startTime: number;
  endTime: number;
  retrievedAt: string;
  lastPageReturned: number;
  continuation: string | null;
  partialFailures: SpotExecutionFailure[];
}

function failureText(failure: SpotFailure): string {
  switch (failure.error) {
    case 'invalid_request':
      return 'The pair, time range or continuation was not accepted.';
    case 'binance_auth':
      return 'Binance rejected the API key or signature.';
    case 'permissions_refused':
      return 'The API key can do more than read, so execution history was refused.';
    case 'permissions_unverified':
      return 'Binance did not confirm that the API key is read-only.';
    case 'rate_limited':
      return `Binance rate-limited this read. Loading is paused for about ${failure.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS} seconds.`;
    case 'timeout':
      return 'Binance did not answer in time.';
    case 'network':
      return 'Could not reach the server or Binance.';
    case 'malformed_response':
      return 'Binance sent execution records that could not be read safely.';
    default:
      return 'Binance reported an error.';
  }
}

function deduplicate(executions: SpotExecution[]): SpotExecution[] {
  const seen = new Set<string>();
  return executions.filter((execution) => {
    const identity = `${execution.symbol}:${execution.tradeId}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** What a button says instead of its own label while no read can start. */
function busyLabel(loading: boolean, paused: boolean): string | null {
  if (loading) return 'Loading…';
  if (paused) return 'Rate limited';
  return null;
}

/** Seconds to hold off after a rate limit, whole-read or for one pair; null when there was none. */
function backoffSeconds(result: SpotExecutionRead): number | null {
  if (result.state === 'error') {
    if (result.error !== 'rate_limited') return null;
    return result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS;
  }
  if (result.state !== 'executions') return null;
  const limited = result.coverage.failures.find((item) => item.error === 'rate_limited');
  return limited ? (limited.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS) : null;
}

/** The records to show after an answer: a failed refresh keeps them unless access was lost. */
function nextSnapshot(
  current: ExecutionSnapshot | null,
  result: SpotExecutionRead,
  more: boolean,
): ExecutionSnapshot | null {
  if (result.state === 'error') {
    return result.error === 'unauthenticated' || result.error === 'forbidden' ? null : current;
  }
  if (result.state !== 'executions') return null;
  return {
    executions: deduplicate([...(more && current ? current.executions : []), ...result.executions]),
    symbols: result.coverage.symbols,
    startTime: result.coverage.startTime,
    endTime: result.coverage.endTime,
    retrievedAt: result.coverage.retrievedAt,
    lastPageReturned: result.coverage.returned,
    continuation: result.continuation ?? null,
    partialFailures: result.coverage.failures,
  };
}

function ExecutionResults({
  snapshot,
  busy,
  onNextPage,
}: Readonly<{
  snapshot: ExecutionSnapshot;
  busy: string | null;
  onNextPage: (continuation: string) => void;
}>) {
  const next = snapshot.continuation;
  return (
    <>
      <dl className="spot-coverage" aria-label="Execution history coverage">
        <div>
          <dt>Pairs</dt>
          <dd>{snapshot.symbols.join(', ')}</dd>
        </div>
        <div>
          <dt>Requested range</dt>
          <dd>
            <time dateTime={new Date(snapshot.startTime).toISOString()}>
              {new Date(snapshot.startTime).toLocaleString()}
            </time>{' '}
            –{' '}
            <time dateTime={new Date(snapshot.endTime).toISOString()}>
              {new Date(snapshot.endTime).toLocaleString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>Records shown</dt>
          <dd>{snapshot.executions.length}</dd>
        </div>
        <div>
          <dt>Retrieved</dt>
          <dd>
            <time dateTime={snapshot.retrievedAt}>
              {new Date(snapshot.retrievedAt).toLocaleString()}
            </time>
          </dd>
        </div>
        <div>
          <dt>More results</dt>
          <dd>{next ? 'Yes' : 'No'}</dd>
        </div>
      </dl>

      {snapshot.partialFailures.length > 0 && (
        <p className="spot-failed" role="alert">
          Partial retrieval. Failed pairs/pages:{' '}
          {snapshot.partialFailures
            .map((item) => `${item.symbol} (${item.error.replaceAll('_', ' ')})`)
            .join(', ')}
          . Records shown are retained.
        </p>
      )}

      {snapshot.executions.length === 0 ? (
        <p className="spot-note">
          Binance returned no executions for the selected pair in this requested range.
        </p>
      ) : (
        <div className="spot-execution-scroll">
          <table className="spot-table spot-execution-table">
            <caption className="sr-only">Binance Spot execution history</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Pair</th>
                <th scope="col">Side</th>
                <th scope="col">Trade ID</th>
                <th scope="col">Order ID</th>
                <th scope="col">Quantity</th>
                <th scope="col">Price</th>
                <th scope="col">Quote quantity</th>
                <th scope="col">Commission</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.executions.map((execution) => (
                <tr key={`${execution.symbol}:${execution.tradeId}`}>
                  <td>
                    <time dateTime={new Date(execution.time).toISOString()}>
                      {new Date(execution.time).toLocaleString()}
                    </time>
                  </td>
                  <th scope="row">{execution.symbol}</th>
                  <td>{execution.side}</td>
                  <td>{execution.tradeId}</td>
                  <td>{execution.orderId}</td>
                  <td>{execution.quantity}</td>
                  <td>{execution.price}</td>
                  <td>{execution.quoteQuantity}</td>
                  <td>
                    {execution.commission} {execution.commissionAsset}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="spot-note">
        Commissions stay in the asset Binance recorded; Popup does not convert BNB or another fee
        asset into USDT or USD. Execution history alone cannot reconstruct all balances.
      </p>
      <button
        type="button"
        className="portfolio-cash-btn"
        aria-disabled={busy !== null || !next}
        onClick={next ? () => onNextPage(next) : undefined}
      >
        {busy ?? (next ? 'Load next page' : 'No more results')}
      </button>
    </>
  );
}

export function BinanceSpotExecutions({
  read = readSpotExecutions,
}: Readonly<{
  read?: (request: SpotExecutionSelection | { continuation: string }) => Promise<SpotExecutionRead>;
}>) {
  const [symbol, setSymbol] = useState<(typeof SPOT_EXECUTION_SYMBOLS)[number]>('BTCUSDT');
  const [hours, setHours] = useState(24);
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [failure, setFailure] = useState<SpotFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [pausedUntil, setPausedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const selectionRef = useRef(`${symbol}:${hours}`);

  useEffect(() => {
    mountedRef.current = true;
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      clearInterval(tick);
    };
  }, []);

  const changeSelection = (nextSymbol: typeof symbol, nextHours: number) => {
    selectionRef.current = `${nextSymbol}:${nextHours}`;
    seqRef.current += 1;
    setSymbol(nextSymbol);
    setHours(nextHours);
    setSnapshot(null);
    setFailure(null);
    setLoading(false);
  };

  const paused = now < pausedUntil;
  const busy = busyLabel(loading, paused);

  /** A null continuation starts over from the selected pair and range. */
  const load = useCallback(
    (continuation: string | null) => {
      if (busy !== null) return;
      const selectionKey = selectionRef.current;
      const seq = ++seqRef.current;
      setLoading(true);
      setFailure(null);
      const endTime = Date.now();
      const request: SpotExecutionSelection | { continuation: string } = continuation
        ? { continuation }
        : { symbols: [symbol], startTime: endTime - hours * 60 * 60 * 1000, endTime };
      void read(request)
        .catch((): SpotExecutionRead => ({ state: 'error', error: 'network' }))
        .then((result) => {
          const current =
            mountedRef.current && seq === seqRef.current && selectionKey === selectionRef.current;
          if (!current) return;
          setLoading(false);
          setFailure(result.state === 'error' ? result : null);
          setSnapshot((shown) => nextSnapshot(shown, result, continuation !== null));
          const backoff = backoffSeconds(result);
          if (backoff !== null) setPausedUntil(Date.now() + backoff * 1000);
        });
    },
    [busy, hours, read, symbol],
  );

  return (
    <section className="spot-executions" aria-labelledby="spot-executions-title">
      <div className="spot-executions-head">
        <div>
          <h4 id="spot-executions-title">Binance Spot executions — read-only</h4>
          <p className="spot-note">
            Executed fills for selected pairs and a finite window. This is not complete account
            history, and it does not include deposits, withdrawals, transfers or conversions.
          </p>
        </div>
        <div className="spot-execution-controls">
          <label>
            <span>Pair</span>
            <select
              name="binance-execution-symbol"
              value={symbol}
              onChange={(event) => changeSelection(event.target.value as typeof symbol, hours)}
            >
              {SPOT_EXECUTION_SYMBOLS.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Range</span>
            <select
              name="binance-execution-range"
              value={hours}
              onChange={(event) => changeSelection(symbol, Number(event.target.value))}
            >
              {RANGE_OPTIONS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={busy !== null}
            onClick={() => load(null)}
          >
            <History size={13} aria-hidden="true" /> {busy ?? 'Load executions'}
          </button>
        </div>
      </div>

      {failure && (
        <p className="spot-failed" role="alert">
          {snapshot && 'Refresh failed. Retaining the records shown below. '}
          {failureText(failure)}
        </p>
      )}

      {snapshot && <ExecutionResults snapshot={snapshot} busy={busy} onNextPage={load} />}
    </section>
  );
}
