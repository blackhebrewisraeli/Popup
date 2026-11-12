import { useCallback, useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import {
  readSpotExecutions,
  type SpotExecution,
  type SpotExecutionConflict,
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
  conflicts: SpotExecutionConflict[];
  symbols: string[];
  startTime: number;
  endTime: number;
  retrievedAt: string;
  lastPageReturned: number;
  continuation: string | null;
  partialFailures: SpotExecutionFailure[];
  completedSymbols: string[];
  continuationFailures: SpotFailure[];
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

function executionIdentity(execution: SpotExecution): string {
  return `${execution.symbol}:${execution.tradeId}`;
}

function sameExecution(left: SpotExecution, right: SpotExecution): boolean {
  return (
    left.symbol === right.symbol &&
    left.tradeId === right.tradeId &&
    left.orderId === right.orderId &&
    left.time === right.time &&
    left.side === right.side &&
    left.quantity === right.quantity &&
    left.price === right.price &&
    left.quoteQuantity === right.quoteQuantity &&
    left.commission === right.commission &&
    left.commissionAsset === right.commissionAsset
  );
}

function mergeEvidence(
  current: Pick<ExecutionSnapshot, 'executions' | 'conflicts'> | null,
  executions: SpotExecution[],
  conflicts: SpotExecutionConflict[],
): Pick<ExecutionSnapshot, 'executions' | 'conflicts'> {
  const variantsByIdentity = new Map<string, SpotExecution[]>();
  const add = (execution: SpotExecution) => {
    const identity = executionIdentity(execution);
    const variants = variantsByIdentity.get(identity);
    if (variants === undefined) variantsByIdentity.set(identity, [execution]);
    else if (!variants.some((variant) => sameExecution(variant, execution))) {
      variants.push(execution);
    }
  };
  current?.executions.forEach(add);
  current?.conflicts.forEach((conflict) => conflict.variants.forEach(add));
  executions.forEach(add);
  conflicts.forEach((conflict) => conflict.variants.forEach(add));

  const consistent: SpotExecution[] = [];
  const inconsistent: SpotExecutionConflict[] = [];
  for (const variants of variantsByIdentity.values()) {
    const first = variants[0] as SpotExecution;
    if (variants.length === 1) consistent.push(first);
    else inconsistent.push({ symbol: first.symbol, tradeId: first.tradeId, variants });
  }
  return { executions: consistent, conflicts: inconsistent };
}

function uniqueFailures(failures: SpotExecutionFailure[]): SpotExecutionFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.symbol}:${failure.error}:${failure.retryAfterSeconds ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
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
    if (result.error === 'unauthenticated' || result.error === 'forbidden') return null;
    return more && current
      ? { ...current, continuationFailures: [...current.continuationFailures, result] }
      : current;
  }
  if (result.state !== 'executions') return null;
  const accumulated = more ? current : null;
  const evidence = mergeEvidence(accumulated, result.executions, result.conflicts);
  return {
    ...evidence,
    symbols: result.coverage.symbols,
    startTime: result.coverage.startTime,
    endTime: result.coverage.endTime,
    retrievedAt: result.coverage.retrievedAt,
    lastPageReturned: result.coverage.returned,
    continuation: result.continuation ?? null,
    partialFailures: uniqueFailures([
      ...(accumulated?.partialFailures ?? []),
      ...result.coverage.failures,
    ]),
    completedSymbols: [
      ...new Set([...(accumulated?.completedSymbols ?? []), ...result.coverage.completedSymbols]),
    ],
    continuationFailures: accumulated?.continuationFailures ?? [],
  };
}

function requestedCoverageComplete(snapshot: ExecutionSnapshot): boolean {
  return (
    snapshot.continuation === null &&
    snapshot.partialFailures.length === 0 &&
    snapshot.continuationFailures.length === 0 &&
    snapshot.conflicts.length === 0 &&
    snapshot.symbols.every((symbol) => snapshot.completedSymbols.includes(symbol))
  );
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
  const complete = requestedCoverageComplete(snapshot);
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
          <dt>Conflicting identities</dt>
          <dd>{snapshot.conflicts.length}</dd>
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
          <dt>Continuation</dt>
          <dd>{next ? 'Available' : 'None'}</dd>
        </div>
        <div>
          <dt>Requested coverage</dt>
          <dd>{complete ? 'Complete for requested pairs and window' : 'Incomplete'}</dd>
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

      {snapshot.continuationFailures.length > 0 && (
        <p className="spot-failed" role="alert">
          Continuation failed earlier. This retrieval remains unresolved even if a later request
          succeeded: {snapshot.continuationFailures.map((item) => failureText(item)).join(' ')}
        </p>
      )}

      {snapshot.conflicts.length > 0 && (
        <p className="spot-failed" role="alert">
          Inconsistent execution evidence. Conflicting rows share one pair and trade ID; no variant
          is authoritative:{' '}
          {snapshot.conflicts
            .map(
              (conflict) =>
                `${conflict.symbol} trade ${conflict.tradeId} (${conflict.variants.length} variants)`,
            )
            .join(', ')}
          .
        </p>
      )}

      {snapshot.executions.length === 0 ? (
        <p className="spot-note">
          {snapshot.conflicts.length > 0 || snapshot.partialFailures.length > 0
            ? 'No consistent executions are available for this requested range.'
            : 'Binance returned no executions for the selected pair in this requested range.'}
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

      {snapshot.conflicts.length > 0 && (
        <div className="spot-execution-scroll">
          <table className="spot-table spot-execution-table">
            <caption className="sr-only">Conflicting Binance Spot execution evidence</caption>
            <thead>
              <tr>
                <th scope="col">Variant</th>
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
              {snapshot.conflicts.flatMap((conflict) =>
                conflict.variants.map((variant, index) => (
                  <tr key={`${executionIdentity(variant)}:${index}`}>
                    <th scope="row">{index + 1}</th>
                    <td>
                      <time dateTime={new Date(variant.time).toISOString()}>
                        {new Date(variant.time).toLocaleString()}
                      </time>
                    </td>
                    <td>{variant.symbol}</td>
                    <td>{variant.side}</td>
                    <td>{variant.tradeId}</td>
                    <td>{variant.orderId}</td>
                    <td>{variant.quantity}</td>
                    <td>{variant.price}</td>
                    <td>{variant.quoteQuantity}</td>
                    <td>
                      {variant.commission} {variant.commissionAsset}
                    </td>
                  </tr>
                )),
              )}
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
        {busy ?? (next ? 'Load next page' : 'No continuation')}
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
  const [failureContext, setFailureContext] = useState<'refresh' | 'continuation' | null>(null);
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
    setFailureContext(null);
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
      setFailureContext(null);
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
          setFailureContext(
            result.state === 'error' ? (continuation ? 'continuation' : 'refresh') : null,
          );
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
          {snapshot &&
            failureContext === 'continuation' &&
            'Continuation failed. Retaining the accumulated evidence below. '}
          {snapshot &&
            failureContext === 'refresh' &&
            'Refresh failed. Retaining the previous result below unchanged. '}
          {failureText(failure)}
        </p>
      )}

      {snapshot && <ExecutionResults snapshot={snapshot} busy={busy} onNextPage={load} />}
    </section>
  );
}
