// Manual quantity reconciliation of one subject asset in the owner's Binance Spot card
// (docs/BINANCE_SPOT_RECONCILIATION.md, section 10). Every read is an explicit button press.
// The session lives in this component's memory only; nothing here stores, orders or touches a
// Popup ledger, and the arithmetic and evidence rules are the pure modules' own.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  readSpotAccount,
  readSpotExecutions,
  type SpotExecutionRead,
  type SpotExecutionSelection,
  type SpotFailure,
  type SpotRead,
} from '@/lib/binanceSpotAccount';
import {
  nextExecutionEvidence,
  requestedCoverageComplete,
  SPOT_EXECUTION_SYMBOLS,
  type SpotExecutionEvidence,
} from '@/lib/binanceSpotEvidence';
import {
  EXCLUDED_SUBJECTS,
  MAX_BALANCE_INTERVAL_MS,
  QUANTITY_LIMITS,
  RECONCILIATION_GUARD_MS,
  reconcileSpotQuantity,
  type IndeterminateReason,
  type QuantityReconciliation,
} from '@/lib/binanceSpotReconciliation';

const DEFAULT_BACKOFF_SECONDS = 60;
const QUOTE = 'USDT';
const GUARD_SECONDS = RECONCILIATION_GUARD_MS / 1000;
/** Base assets of the supported pairs that may be a subject: never USDT or BNB. */
const SUBJECTS = SPOT_EXECUTION_SYMBOLS.map((symbol) => symbol.slice(0, -QUOTE.length)).filter(
  (asset) => !EXCLUDED_SUBJECTS.has(asset),
);

type Step = 'opening' | 'closing' | 'executions';
type ExecutionRequest = SpotExecutionSelection | { continuation: string };
/** A balance read is captured only when it succeeded; its server time and owner stay with it. */
interface CapturedRead {
  accountContext: string;
  read: Extract<SpotRead, { state: 'connected' }>;
}
interface Session {
  subject: string;
  opening: CapturedRead | null;
  closing: CapturedRead | null;
  evidence: SpotExecutionEvidence | null;
}

const emptySession = (subject: string): Session => ({
  subject,
  opening: null,
  closing: null,
  evidence: null,
});

const BUSY_TEXT: Record<Step, string> = {
  opening: 'Capturing the opening balance read…',
  closing: 'Capturing the closing balance read…',
  executions: 'Retrieving executions…',
};

const COMMISSION_UNVERIFIED =
  "Commission coverage is unverified (D3). Binance records each fill's commission amount and asset, but does not say whether that amount is the whole fee debited for the fill (standard, tax and special commission). Until a live check on a real fill settles it, no quantity figure or consistency result is shown.";

function failureText(failure: SpotFailure): string {
  switch (failure.error) {
    case 'invalid_request':
      return 'The server did not accept the request.';
    case 'binance_auth':
      return 'Binance rejected the API key or its signature.';
    case 'permissions_refused':
      return 'The API key can do more than read, so nothing was read.';
    case 'permissions_unverified':
      return 'Binance did not confirm that the API key is read-only, so nothing was read.';
    case 'rate_limited':
      return `Binance rate limit reached. Requests here are paused for about ${failure.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS} seconds.`;
    case 'timeout':
      return 'Binance did not answer in time.';
    case 'network':
      return 'Could not reach the server or Binance.';
    case 'malformed_response':
      return 'Binance sent a response that could not be read safely.';
    default:
      return 'Binance reported an error.';
  }
}

function accessLost(result: SpotRead | SpotExecutionRead): boolean {
  return (
    result.state === 'not_configured' ||
    result.state === 'unavailable' ||
    (result.state === 'error' &&
      (result.error === 'unauthenticated' || result.error === 'forbidden'))
  );
}

/** Seconds to hold off after a rate limit, whole-read or for one pair; null when there was none. */
function backoffSeconds(result: SpotRead | SpotExecutionRead): number | null {
  if (result.state === 'error') {
    return result.error === 'rate_limited'
      ? (result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS)
      : null;
  }
  if (result.state !== 'executions') return null;
  const limited = result.coverage.failures.find((item) => item.error === 'rate_limited');
  return limited ? (limited.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS) : null;
}

/** [O − g, C + g] once both reads are captured. */
function guardedWindow(session: Session): SpotExecutionSelection | null {
  if (!session.opening || !session.closing) return null;
  return {
    symbols: [`${session.subject}${QUOTE}`],
    startTime: Date.parse(session.opening.read.readAt) - RECONCILIATION_GUARD_MS,
    endTime: Date.parse(session.closing.read.readAt) + RECONCILIATION_GUARD_MS,
  };
}

/** Why the guarded execution read cannot be requested yet, or null when it can. */
function notYetEligible(session: Session, now: number): string | null {
  const guarded = guardedWindow(session);
  if (!session.opening) return 'Capture an opening balance read.';
  if (!session.closing || !guarded) {
    return 'Capture a closing balance read. The fills between the two reads are what get checked.';
  }
  const interval = guarded.endTime - guarded.startTime - 2 * RECONCILIATION_GUARD_MS;
  if (interval <= 0) {
    return "The closing read is not after the opening read by the server's clock. Reset and capture both again.";
  }
  if (interval > MAX_BALANCE_INTERVAL_MS) {
    return `The reads are more than 24 hours less ${2 * GUARD_SECONDS} seconds apart, so the guarded window would exceed Binance's 24-hour limit. Reset and capture both reads closer together.`;
  }
  if (now < guarded.endTime) {
    const seconds = Math.ceil((guarded.endTime - now) / 1000);
    return `Executions can be requested from ${new Date(guarded.endTime).toLocaleTimeString()}, ${GUARD_SECONDS} s after the closing read (in ${seconds} s). Nothing is requested automatically.`;
  }
  return null;
}

function reasonText(reason: IndeterminateReason, subject: string, symbol: string): string {
  const items = (reason.items ?? []).map((item) => item.replaceAll('_', ' ')).join(', ');
  const texts: Record<IndeterminateReason['code'], string> = {
    unsupported_subject: `${subject} cannot be a subject; USDT and BNB are excluded. Reset and choose another asset.`,
    opening_unavailable: `The opening balance read did not succeed (${items}). Reset and capture it again.`,
    closing_unavailable: `The closing balance read did not succeed (${items}). Reset and capture it again.`,
    opening_invalid: 'The opening balance read is not well formed. Reset and capture it again.',
    closing_invalid: 'The closing balance read is not well formed. Reset and capture it again.',
    account_context_mismatch: 'The reads were made for different owners. Reset and start again.',
    balance_order_invalid:
      'The closing read is not after the opening read. Reset and capture both again.',
    balance_interval_too_long: `The reads are more than 24 hours less ${2 * GUARD_SECONDS} seconds apart. Reset and capture both reads closer together.`,
    execution_window_not_covering:
      'The retrieved executions do not cover the guarded window. Retrieve again from the start.',
    executions_read_too_early: `By the server's clock, the first execution page was read less than ${GUARD_SECONDS} s after the closing read, so a late fill could be missing. Retrieve again from the start.`,
    execution_evidence_invalid: `The execution evidence is malformed (${items}). Retrieve again from the start.`,
    pair_not_selected: `The retrieval does not include ${symbol}. Retrieve again from the start.`,
    pair_failed: `Part of the ${symbol} retrieval failed (${items}). That retrieval stays incomplete; retrieve again from the start.`,
    pair_incomplete: `${symbol} has not reached its last page. Load the next page.`,
    continuation_failed: `A continuation failed (${items}). This retrieval stays unresolved even after a successful retry; retrieve again from the start for a usable result.`,
    conflicting_fills: `Binance returned conflicting rows for ${symbol} trade ${items}, and no variant is authoritative. Retrieve again from the start; a repeated conflict cannot be reconciled.`,
    subject_fee_on_other_pair: `A fill on another selected pair paid its fee in ${subject} (${items}). Retrieve ${symbol} alone.`,
    fill_near_boundary: `${symbol} fills within ${GUARD_SECONDS} s of a balance read (trade ${items}): whether that read includes them is unknown. Reset and capture both reads away from trading activity.`,
  };
  return texts[reason.code];
}

const signed = (difference: string) =>
  difference.startsWith('-') || /^0+(\.0+)?$/.test(difference) ? difference : `+${difference}`;

function resultTitle(result: QuantityReconciliation | null, gated: boolean): string {
  if (gated) return 'Indeterminate — commission coverage unverified';
  if (result?.status === 'CONSISTENT') return 'Consistent within this scope';
  if (result?.status === 'DISCREPANCY') return 'Discrepancy';
  return 'Indeterminate';
}

function ResultView({
  result,
  gated,
  pendingStep,
  subject,
  symbol,
}: Readonly<{
  result: QuantityReconciliation | null;
  gated: boolean;
  pendingStep: string;
  subject: string;
  symbol: string;
}>) {
  const reasons = gated ? [COMMISSION_UNVERIFIED] : [];
  if (result === null) reasons.push(pendingStep);
  else if (result.status === 'INDETERMINATE') {
    reasons.push(...result.reasons.map((reason) => reasonText(reason, subject, symbol)));
  } else if (gated) {
    reasons.push(
      'No other reason blocks this evidence. Only the unverified commission coverage holds the result back.',
    );
  }
  const figures = !gated && result !== null && result.status !== 'INDETERMINATE' ? result : null;

  return (
    <div className="spot-reconcile-result">
      <h5 id="spot-reconcile-result">Result: {resultTitle(result, gated)}</h5>
      {figures?.status === 'CONSISTENT' && (
        <p className="spot-note">
          The {symbol} fills counted change {subject} by exactly the difference between the two
          reads. This is numerical consistency within this scope only: offsetting unseen events
          cannot be ruled out, and it says nothing about cost.
        </p>
      )}
      {figures?.status === 'DISCREPANCY' && (
        <p className="spot-note">
          {subject} differs from what the {symbol} fills explain by {signed(figures.difference)}{' '}
          (closing − expected). The difference is unattributed: a deposit, withdrawal, transfer,
          conversion, a fill on another pair or a distribution could each explain it, and none is
          chosen.
        </p>
      )}
      {reasons.length > 0 && (
        <ul className="spot-reasons" aria-labelledby="spot-reconcile-result">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      {figures && (
        <dl className="spot-coverage" aria-label="Quantity figures">
          {(
            [
              [`Opening ${subject} (available + locked)`, figures.opening],
              ['Bought', figures.buys],
              ['Sold', figures.sells],
              [`Fees paid in ${subject}`, figures.subjectFees],
              ['Expected closing', figures.expected],
              [`Closing ${subject} (available + locked)`, figures.closing],
              ['Difference (closing − expected)', signed(figures.difference)],
              ['Fills counted', String(figures.countedTradeIds.length)],
              [
                'Fees in other assets (not converted)',
                figures.feesInOtherAssets.map((fee) => `${fee.amount} ${fee.asset}`).join(', ') ||
                  'None',
              ],
            ] as const
          ).map(([term, detail]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{detail}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

const ReadTime = ({ at }: Readonly<{ at: string | number }>) => (
  <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>
);

const ACCESS_LOST =
  'Access to the Binance connection ended, so this reconciliation session was cleared.';

/** A click handler only while the action is available (aria-disabled keeps the focus). */
const when = (enabled: boolean, action: () => void) => (enabled ? action : undefined);

/** The session with a successful read captured; any other answer leaves it unchanged. */
function withCapture(
  session: Session,
  which: 'opening' | 'closing',
  accountContext: string,
  read: SpotRead,
): Session {
  return read.state === 'connected' ? { ...session, [which]: { accountContext, read } } : session;
}

function captureNotice(which: 'opening' | 'closing', read: SpotRead): string | null {
  if (read.state === 'connected') return null;
  const reason = read.state === 'error' ? ` ${failureText(read)}` : '';
  return `The ${which} balance was not captured.${reason}`;
}

function retrievalNotice(
  answer: SpotExecutionRead,
  continued: boolean,
  hadEvidence: boolean,
): string | null {
  if (answer.state !== 'error') return null;
  if (continued) {
    return `The next page was not retrieved. The evidence so far and its cursor are kept, and this failure stays recorded. ${failureText(answer)}`;
  }
  const kept = hadEvidence ? ' The earlier evidence is unchanged.' : '';
  return `The retrieval failed.${kept} ${failureText(answer)}`;
}

/** The guarded window once it is eligible, or the evidence's own cursor; null when neither. */
function executionRequest(
  session: Session,
  now: number,
  kind: 'fresh' | 'next',
): ExecutionRequest | null {
  if (kind === 'next') {
    const continuation = session.evidence?.continuation ?? null;
    return continuation === null ? null : { continuation };
  }
  return notYetEligible(session, now) === null ? guardedWindow(session) : null;
}

function reconcile(session: Session, accountContext: string): QuantityReconciliation | null {
  const { subject, opening, closing, evidence } = session;
  if (!opening || !closing || !evidence) return null;
  return reconcileSpotQuantity({
    subject,
    opening,
    closing,
    executions: { accountContext, evidence },
  });
}

/** When requests may resume: later after a rate limit, otherwise unchanged. */
function resumeAt(answer: SpotRead | SpotExecutionRead, pausedUntil: number): number {
  const backoff = backoffSeconds(answer);
  return backoff === null ? pausedUntil : Date.now() + backoff * 1000;
}

/**
 * One explicit request at a time. A rate limit pauses every request here, and an answer is
 * dropped if `cancel` ran or the component unmounted after it was sent.
 */
function useExplicitRequests(onAccessLost: () => void) {
  const [busy, setBusy] = useState<Step | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pausedUntil, setPausedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const seqRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    // Moves the countdown and the rate-limit pause along. It never sends a request.
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
      clearInterval(tick);
    };
  }, []);

  const cancel = () => {
    seqRef.current += 1;
    busyRef.current = false;
    setBusy(null);
    setNotice(null);
  };

  /** `apply` folds the answer in and returns the failure notice to show, or null. */
  function send<T extends SpotRead | SpotExecutionRead>(
    step: Step,
    call: () => Promise<T>,
    apply: (answer: T | SpotFailure) => string | null,
  ) {
    if (busyRef.current || Date.now() < pausedUntil) return;
    const seq = ++seqRef.current;
    busyRef.current = true;
    setBusy(step);
    setNotice(null);
    void call()
      .catch((): SpotFailure => ({ state: 'error', error: 'network' }))
      .then((answer) => {
        if (!mountedRef.current || seq !== seqRef.current) return;
        busyRef.current = false;
        setBusy(null);
        setNow(Date.now());
        setPausedUntil((until) => resumeAt(answer, until));
        if (accessLost(answer)) {
          onAccessLost();
          setNotice(ACCESS_LOST);
        } else {
          setNotice(apply(answer));
        }
      });
  }

  return { busy, notice, now, pausedUntil, paused: now < pausedUntil, send, cancel };
}

function RequestStatus({
  busy,
  pausedUntil,
}: Readonly<{ busy: Step | null; pausedUntil: number | null }>) {
  return (
    <p className="spot-status" aria-live="polite">
      {busy && BUSY_TEXT[busy]}
      {pausedUntil !== null && (
        <>
          Binance rate limit: requests here are paused until <ReadTime at={pausedUntil} />.
        </>
      )}
    </p>
  );
}

function SessionSummary({ session }: Readonly<{ session: Session }>) {
  const { subject, opening, closing, evidence } = session;
  const guarded = guardedWindow(session);
  return (
    <dl className="spot-coverage" aria-label="Reconciliation session">
      <div>
        <dt>Subject</dt>
        <dd>
          {subject} on {`${subject}${QUOTE}`}
        </dd>
      </div>
      <div>
        <dt>Opening read</dt>
        <dd>{opening ? <ReadTime at={opening.read.readAt} /> : 'Not captured'}</dd>
      </div>
      <div>
        <dt>Closing read</dt>
        <dd>{closing ? <ReadTime at={closing.read.readAt} /> : 'Not captured'}</dd>
      </div>
      <div>
        <dt>Guarded execution window</dt>
        <dd>
          {guarded ? (
            <>
              <ReadTime at={guarded.startTime} /> – <ReadTime at={guarded.endTime} />
            </>
          ) : (
            'Set by both reads'
          )}
        </dd>
      </div>
      {evidence && (
        <>
          <div>
            <dt>Fills retrieved</dt>
            <dd>{evidence.executions.length}</dd>
          </div>
          <div>
            <dt>Conflicting identities</dt>
            <dd>{evidence.conflicts.length}</dd>
          </div>
          <div>
            <dt>Continuation</dt>
            <dd>{evidence.continuation ? 'Available' : 'None'}</dd>
          </div>
          <div>
            <dt>Requested coverage</dt>
            <dd>
              {requestedCoverageComplete(evidence)
                ? 'Complete for the requested pair and window'
                : 'Incomplete'}
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}

export function BinanceSpotReconciliation({
  accountContext,
  readBalances = readSpotAccount,
  readExecutions = readSpotExecutions,
  commissionCoverage = QUANTITY_LIMITS.commissionCoverage,
}: Readonly<{
  /** Whose reads these are: the signed-in owner. Not a Binance account identity. */
  accountContext: string;
  readBalances?: () => Promise<SpotRead>;
  readExecutions?: (request: ExecutionRequest) => Promise<SpotExecutionRead>;
  /**
   * D3. Only a contract change that settles what `commission` covers may pass `verified`; no
   * owner control sets it. While unverified, no figure or consistency result is shown.
   */
  commissionCoverage?: 'unverified' | 'verified';
}>) {
  const [session, setSession] = useState<Session>(() => emptySession('BTC'));
  const requests = useExplicitRequests(() =>
    setSession((current) => emptySession(current.subject)),
  );
  const { busy, now, paused } = requests;
  const { subject, opening, closing, evidence } = session;
  const symbol = `${subject}${QUOTE}`;
  const waiting = notYetEligible(session, now);
  const result = useMemo(() => reconcile(session, accountContext), [accountContext, session]);

  /** Clears the session; an answer still in flight is dropped when it arrives. */
  const reset = (nextSubject: string) => {
    requests.cancel();
    setSession(emptySession(nextSubject));
  };

  const capture = (which: 'opening' | 'closing') =>
    requests.send(which, readBalances, (read) => {
      setSession((current) => withCapture(current, which, accountContext, read));
      return captureNotice(which, read);
    });

  /** `fresh` starts a new retrieval of the guarded window; `next` continues this one. */
  const retrieve = (kind: 'fresh' | 'next') => {
    const request = executionRequest(session, now, kind);
    if (request === null) return;
    const hadEvidence = evidence !== null;
    requests.send(
      'executions',
      () => readExecutions(request),
      (answer) => {
        setSession((current) => ({
          ...current,
          evidence: nextExecutionEvidence(current.evidence, answer, kind === 'next'),
        }));
        return retrievalNotice(answer, kind === 'next', hadEvidence);
      },
    );
  };

  const idle = busy === null && !paused;
  const enabled = {
    opening: idle && opening === null,
    closing: idle && opening !== null && closing === null,
    fresh: idle && executionRequest(session, now, 'fresh') !== null,
    next: idle && executionRequest(session, now, 'next') !== null,
  };

  return (
    <section className="spot-executions" aria-labelledby="spot-reconcile-title">
      <div className="spot-executions-head">
        <div>
          <h4 id="spot-reconcile-title">Quantity reconciliation — manual, read-only</h4>
          <p className="spot-note">
            Checks whether one asset&apos;s Spot quantity (available + locked) changed between two
            balance reads by exactly what its USDT pair&apos;s fills explain. Every read happens
            only when you press a button. Nothing is saved, and refreshing the balances above never
            replaces a captured read.
          </p>
        </div>
        <div className="spot-execution-controls">
          <label>
            <span>Asset</span>
            <select
              name="binance-reconcile-asset"
              value={subject}
              disabled={opening !== null || busy !== null}
              onChange={(event) => reset(event.target.value)}
            >
              {SUBJECTS.map((asset) => (
                <option key={asset} value={asset}>
                  {asset}
                </option>
              ))}
            </select>
          </label>
          {/* aria-disabled, not disabled: a disabled button drops keyboard focus mid-read. */}
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={!enabled.opening}
            onClick={when(enabled.opening, () => capture('opening'))}
          >
            Capture opening balance
          </button>
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={!enabled.closing}
            onClick={when(enabled.closing, () => capture('closing'))}
          >
            Capture closing balance
          </button>
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={!enabled.fresh}
            onClick={when(enabled.fresh, () => retrieve('fresh'))}
          >
            {evidence ? 'Retrieve again from the start' : 'Retrieve executions'}
          </button>
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={!enabled.next}
            onClick={when(enabled.next, () => retrieve('next'))}
          >
            Load next page
          </button>
          <button type="button" className="portfolio-cash-btn" onClick={() => reset(subject)}>
            Reset
          </button>
        </div>
      </div>

      <RequestStatus busy={busy} pausedUntil={paused ? requests.pausedUntil : null} />

      {requests.notice && (
        <p className="spot-failed" role="alert">
          {requests.notice}
        </p>
      )}

      <SessionSummary session={session} />

      <ResultView
        result={result}
        gated={commissionCoverage !== 'verified'}
        pendingStep={waiting ?? `Retrieve the ${symbol} executions for the guarded window.`}
        subject={subject}
        symbol={symbol}
      />

      <p className="spot-note">
        Scope and limits: one asset, its USDT pair and one window. Account history is not
        established; deposits, withdrawals, transfers, conversions and fills on other pairs are not
        seen. The {GUARD_SECONDS}-second guard is provisional policy, and neither read is an atomic
        account snapshot. Commission coverage is unverified. No acquisition cost, valuation, profit
        or loss is computed, and nothing here places an order or changes a Popup ledger.
      </p>
    </section>
  );
}
