import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { History } from 'lucide-react';
import {
  readSpotExecutions,
  type SpotExecutionRead,
  type SpotExecutionSelection,
  type SpotFailure,
} from '@/lib/binanceSpotAccount';
import {
  executionIdentity,
  nextExecutionEvidence,
  requestedCoverageComplete,
  SPOT_EXECUTION_SYMBOLS,
  type SpotExecutionEvidence,
} from '@/lib/binanceSpotEvidence';

const RANGE_OPTIONS = [
  { hours: 1, label: 'Last hour' },
  { hours: 6, label: 'Last 6 hours' },
  { hours: 24, label: 'Last 24 hours' },
] as const;
const CUSTOM_RANGE = 'custom';
const HOUR_MS = 60 * 60 * 1000;
/** The function refuses anything longer; exactly 24 hours is allowed. */
const MAX_RANGE_MS = 24 * HOUR_MS;
const DEFAULT_BACKOFF_SECONDS = 60;

interface Selection {
  symbol: (typeof SPOT_EXECUTION_SYMBOLS)[number];
  /** Hours of a rolling preset, or `custom`. */
  range: string;
  /** `datetime-local` values, read as UTC. */
  start: string;
  end: string;
}

/** An instant as UTC text, with milliseconds only when it has them. */
const utcText = (time: number | string) =>
  new Date(time).toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', ' UTC');

/**
 * A `datetime-local` value read as UTC. The input's value carries no time zone, so appending Z
 * keeps the browser's own zone out of it. The round trip refuses dates such as 30 February, which
 * some engines roll into March.
 */
function utcInputTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const time = Date.parse(`${value}Z`);
  return time > 0 && new Date(time).toISOString().startsWith(value) ? time : null;
}

/** The custom window to request, or why none may be requested. */
function customWindow(
  start: string,
  end: string,
  now: number,
): { startTime: number; endTime: number } | string {
  if (start === '' || end === '') return 'Enter a complete start and end, in UTC.';
  const startTime = utcInputTime(start);
  const endTime = utcInputTime(end);
  if (startTime === null || endTime === null) {
    return 'Enter the start and end as valid UTC dates and times.';
  }
  if (endTime === startTime) return 'The start and end are the same time.';
  if (endTime < startTime) return 'The end is before the start.';
  if (endTime - startTime > MAX_RANGE_MS) return 'The range is longer than 24 hours.';
  if (endTime > now) return 'The range ends in the future. Choose an end no later than now.';
  return { startTime, endTime };
}

function selectedWindow(
  selection: Selection,
  now: number,
): { startTime: number; endTime: number } | string {
  if (selection.range === CUSTOM_RANGE) return customWindow(selection.start, selection.end, now);
  return { startTime: now - Number(selection.range) * HOUR_MS, endTime: now };
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

function ExecutionResults({
  snapshot,
  busy,
  onNextPage,
}: Readonly<{
  snapshot: SpotExecutionEvidence;
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
              {utcText(snapshot.startTime)}
            </time>{' '}
            –{' '}
            <time dateTime={new Date(snapshot.endTime).toISOString()}>
              {utcText(snapshot.endTime)}
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
            <time dateTime={snapshot.retrievedAt}>{utcText(snapshot.retrievedAt)}</time>
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
            : 'Binance returned no executions for the selected pair in this requested range. That does not show the account had none: Binance does not state how long it keeps this history.'}
        </p>
      ) : (
        <div className="spot-execution-scroll">
          <table className="spot-table spot-execution-table">
            <caption className="sr-only">Binance Spot execution history</caption>
            <thead>
              <tr>
                <th scope="col">Local time</th>
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
                <th scope="col">Local time</th>
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
  const [selection, setSelection] = useState<Selection>({
    symbol: 'BTCUSDT',
    range: '24',
    start: '',
    end: '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SpotExecutionEvidence | null>(null);
  const [failure, setFailure] = useState<SpotFailure | null>(null);
  const [failureContext, setFailureContext] = useState<'refresh' | 'continuation' | null>(null);
  const [loading, setLoading] = useState(false);
  const [pausedUntil, setPausedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);
  // Every selection change and every read bumps this, so only the newest read's answer applies.
  const seqRef = useRef(0);
  const hintId = useId();

  useEffect(() => {
    mountedRef.current = true;
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      clearInterval(tick);
    };
  }, []);

  /** Evidence belongs to the selection it was read for, so any change discards it. */
  const changeSelection = (change: Partial<Selection>) => {
    seqRef.current += 1;
    setSelection((current) => ({ ...current, ...change }));
    setProblem(null);
    setSnapshot(null);
    setFailure(null);
    setFailureContext(null);
    setLoading(false);
  };

  const paused = now < pausedUntil;
  const busy = busyLabel(loading, paused);
  const custom = selection.range === CUSTOM_RANGE;

  /**
   * A null continuation starts a retrieval with the pair and window fixed now; a continuation
   * sends only that retrieval's cursor.
   */
  const load = useCallback(
    (continuation: string | null) => {
      if (busy !== null) return;
      let request: SpotExecutionSelection | { continuation: string };
      if (continuation === null) {
        const bounds = selectedWindow(selection, Date.now());
        if (typeof bounds === 'string') {
          setProblem(bounds);
          return;
        }
        request = { symbols: [selection.symbol], ...bounds };
      } else {
        request = { continuation };
      }
      const seq = ++seqRef.current;
      setProblem(null);
      setLoading(true);
      setFailure(null);
      setFailureContext(null);
      void read(request)
        .catch((): SpotExecutionRead => ({ state: 'error', error: 'network' }))
        .then((result) => {
          if (!mountedRef.current || seq !== seqRef.current) return;
          setLoading(false);
          setFailure(result.state === 'error' ? result : null);
          setFailureContext(
            result.state === 'error' ? (continuation ? 'continuation' : 'refresh') : null,
          );
          setSnapshot((shown) => nextExecutionEvidence(shown, result, continuation !== null));
          const backoff = backoffSeconds(result);
          if (backoff !== null) setPausedUntil(Date.now() + backoff * 1000);
        });
    },
    [busy, read, selection],
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
              value={selection.symbol}
              onChange={(event) =>
                changeSelection({ symbol: event.target.value as Selection['symbol'] })
              }
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
              value={selection.range}
              onChange={(event) => changeSelection({ range: event.target.value })}
            >
              {RANGE_OPTIONS.map((option) => (
                <option key={option.hours} value={option.hours}>
                  {option.label}
                </option>
              ))}
              <option value={CUSTOM_RANGE}>Custom range (UTC)</option>
            </select>
          </label>
          {custom && (
            <>
              <label>
                <span>Start (UTC)</span>
                <input
                  type="datetime-local"
                  name="binance-execution-start"
                  value={selection.start}
                  aria-describedby={hintId}
                  onChange={(event) => changeSelection({ start: event.target.value })}
                />
              </label>
              <label>
                <span>End (UTC)</span>
                <input
                  type="datetime-local"
                  name="binance-execution-end"
                  value={selection.end}
                  aria-describedby={hintId}
                  onChange={(event) => changeSelection({ end: event.target.value })}
                />
              </label>
            </>
          )}
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={busy !== null}
            onClick={() => load(null)}
          >
            <History size={13} aria-hidden="true" /> {busy ?? 'Load executions'}
          </button>
        </div>
        {custom && (
          <p id={hintId} className="spot-note">
            Enter both times in UTC, not your local time. The range may be at most 24 hours and must
            end no later than now. One page of up to 100 fills is read per request.
          </p>
        )}
      </div>

      {problem && (
        <p className="spot-failed" role="alert">
          {problem} Nothing was requested.
        </p>
      )}

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
