import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isDevAuthUser } from '@/lib/authStore';
import type { SpotExecution } from '@/lib/binanceSpotAccount';
import {
  executionIdentity,
  requestedCoverageComplete,
  sameExecution,
  type SpotExecutionEvidence,
} from '@/lib/binanceSpotEvidence';
import {
  fillDifferences,
  fillRow,
  linkSpotFill,
  loadOwnerExperiments,
  matchingExperiments,
  storedLink,
  type FillRead,
  type LinkOutcome,
  type SpotExperimentRecord,
  type SpotFillInsert,
} from '@/lib/spotExperiments';
import { utcText } from '@/lib/utils';

const EXPERIMENTS_PLACE = 'Account → Binance Spot → Manual Spot experiments';

function Fact({ name, value }: Readonly<{ name: string; value: ReactNode }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const closed = (experiment: SpotExperimentRecord) =>
  experiment.spot_experiment_entries.some((entry) => entry.kind === 'close');

/** How an experiment is named wherever a fill may join it. */
function experimentName(experiment: SpotExperimentRecord): string {
  return `${experiment.symbol} · ${experiment.account_label} · recorded ${utcText(experiment.recorded_at)}${closed(experiment) ? ' · closed' : ''}`;
}

/** What the database's refusal of a second link means for this one. */
function alreadyText(
  stored: Extract<LinkOutcome, { state: 'already' }>['fill'],
  row: SpotFillInsert,
  experiments: readonly SpotExperimentRecord[],
): string {
  const trade = `trade ${row.trade_id} under the label ${row.account_label}`;
  if (stored === null) {
    return `Not linked again. The database already holds a link for ${trade} and stored nothing new, but that link could not be read back here: check ${EXPERIMENTS_PLACE}.`;
  }
  const parts = [
    `Not linked again. The database already holds a link for ${trade}, stored ${utcText(stored.recorded_at)}.`,
  ];
  if (stored.experiment_id !== row.experiment_id) {
    const other = experiments.find((experiment) => experiment.id === stored.experiment_id);
    parts.push(
      `It belongs to another experiment (${other ? experimentName(other) : 'not among those shown'}); a trade belongs to one experiment.`,
    );
  }
  const differences = fillDifferences(stored, row);
  parts.push(
    differences.length === 0
      ? 'Its fill values are the same as this read.'
      : `Its stored copy differs from this read in: ${differences.join(', ')}. Nothing was changed: links are append-only, with no correction path yet.`,
  );
  return parts.join(' ');
}

/** Where a link stands: not sent, in flight, or answered. */
type Outcome = LinkOutcome | 'saving' | null;

function OutcomeText({
  outcome,
  row,
  experiments,
}: Readonly<{
  outcome: Outcome;
  row: SpotFillInsert | null;
  experiments: readonly SpotExperimentRecord[];
}>) {
  if (outcome === 'saving') {
    return (
      <output className="spot-record-status">Linking… waiting for the database to confirm.</output>
    );
  }
  if (outcome?.state === 'linked') {
    return (
      <output className="spot-record-status">
        Linked. The database stored link <code>{outcome.fill.id}</code> at{' '}
        <time dateTime={outcome.fill.recorded_at}>{utcText(outcome.fill.recorded_at)}</time>, by its
        own clock. It is under {EXPERIMENTS_PLACE}.
      </output>
    );
  }
  if (outcome?.state === 'already' && row) {
    return (
      <p role="alert" className="spot-field-error">
        {alreadyText(outcome.fill, row, experiments)}
      </p>
    );
  }
  if (outcome?.state === 'refused') {
    return (
      <p role="alert" className="spot-field-error">
        Not linked. {outcome.message} Nothing was stored.
      </p>
    );
  }
  if (outcome?.state === 'unknown') {
    return (
      <p role="alert" className="spot-field-error">
        No confirmation from the database ({outcome.message}). The link may or may not be stored.
        Trying again is safe: the database keeps one link per trade, and reports a stored one as
        already linked instead of storing it twice.
      </p>
    );
  }
  return null;
}

/** The fill, the read it comes from and the experiment it would join, then the one control that links it. */
function LinkPanel({
  execution,
  snapshot,
  read,
  experiments,
  userId,
  onClose,
}: Readonly<{
  execution: SpotExecution;
  snapshot: SpotExecutionEvidence;
  read: FillRead;
  experiments: readonly SpotExperimentRecord[];
  userId: string;
  onClose: () => void;
}>) {
  const { accountLabel } = read;
  const id = useId();
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Set before the request leaves, so a second press in the same frame sends nothing.
  const savingRef = useRef(false);
  const matches = matchingExperiments(experiments, execution.symbol, accountLabel);
  const [experimentId, setExperimentId] = useState(matches.length === 1 ? matches[0]!.id : '');
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [sent, setSent] = useState<SpotFillInsert | null>(null);

  useEffect(() => headingRef.current?.focus(), []);

  // The fill as the retrieval holds it now: a later page can turn it into a conflict.
  const current = snapshot.executions.some((item) => sameExecution(item, execution));
  const chosen = matches.find((experiment) => experiment.id === experimentId) ?? null;
  const row = chosen ? fillRow(chosen.id, execution, read) : null;
  const saving = outcome === 'saving';
  const settled = outcome !== null && outcome !== 'saving';
  const done = settled && (outcome.state === 'linked' || outcome.state === 'already');
  const locked = !current || !row || saving || done;

  const confirm = () => {
    if (locked || savingRef.current) return;
    savingRef.current = true;
    setSent(row);
    setOutcome('saving');
    void linkSpotFill(row).then((result) => {
      // A refusal stored nothing, and an unanswered link can be retried: the database stores it once.
      if (result.state === 'refused' || result.state === 'unknown') savingRef.current = false;
      setOutcome(result);
      if (result.state !== 'refused') {
        void queryClient.invalidateQueries({ queryKey: ['spot-experiments', userId] });
      }
    });
  };

  let confirmText = 'Confirm and link';
  if (saving) confirmText = 'Linking…';
  else if (settled && outcome.state === 'linked') confirmText = 'Linked';
  else if (settled && outcome.state === 'already') confirmText = 'Not linked again';
  else if (settled && outcome.state === 'unknown') confirmText = 'Try again';

  return (
    <section aria-labelledby={`${id}-title`} className="spot-record-review spot-link-panel">
      <h5 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="scan-effects-title">
        Link {execution.symbol} trade {execution.tradeId} to an experiment
      </h5>
      {!current && (
        <p role="alert" className="spot-field-error">
          This fill is no longer a consistent record in this retrieval: a later page returned a
          conflicting row for the same trade, or the result changed. It can&rsquo;t be linked.
        </p>
      )}
      <div className="spot-field">
        <label htmlFor={`${id}-experiment`}>Experiment</label>
        <select
          id={`${id}-experiment`}
          name="link-experiment"
          className="portfolio-cash-input"
          value={experimentId}
          aria-describedby={`${id}-experiment-note`}
          disabled={saving || done}
          onChange={(event) => {
            setExperimentId(event.target.value);
            setOutcome(null);
          }}
        >
          {matches.length !== 1 && <option value="">Choose an experiment</option>}
          {matches.map((experiment) => (
            <option key={experiment.id} value={experiment.id}>
              {experimentName(experiment)}
            </option>
          ))}
        </select>
        <span id={`${id}-experiment-note`} className="market-scan-fit">
          Only your experiments for {execution.symbol} under the label {accountLabel}: the database
          accepts a fill only into an experiment with the same pair and account label.
        </span>
      </div>
      <dl className="scan-facts">
        <Fact
          name="Experiment"
          value={chosen ? `${experimentName(chosen)}: ${chosen.decision}` : 'Not chosen'}
        />
        <Fact name="Account label" value={`${accountLabel} (the label you gave this retrieval)`} />
        <Fact name="Pair" value={execution.symbol} />
        <Fact name="Side" value={execution.side === 'buy' ? 'Buy' : 'Sell'} />
        <Fact name="Trade ID" value={<code>{execution.tradeId}</code>} />
        <Fact name="Order ID" value={<code>{execution.orderId}</code>} />
        <Fact
          name="Trade time"
          value={
            <time dateTime={new Date(execution.time).toISOString()}>{utcText(execution.time)}</time>
          }
        />
        <Fact name="Quantity" value={<code>{execution.quantity}</code>} />
        <Fact name="Price" value={<code>{execution.price}</code>} />
        <Fact name="Quote quantity" value={<code>{execution.quoteQuantity}</code>} />
        <Fact
          name="Commission"
          value={
            <code>
              {execution.commission} {execution.commissionAsset}
            </code>
          }
        />
        <Fact
          name="Retrieved"
          value={`${utcText(read.retrievedAt)}, the function’s clock for this retrieval’s latest page`}
        />
        <Fact
          name="Requested window"
          value={`${utcText(read.startTime)} – ${utcText(read.endTime)}`}
        />
        <Fact
          name="Coverage"
          value={
            read.complete
              ? 'Complete for the requested pair and window'
              : 'Incomplete: not every page of this pair and window was read consistently'
          }
        />
        <Fact name="Recorded time" value="Set by the database when it stores the link" />
      </dl>
      <ul className="market-scan-notes">
        <li>
          Client-submitted: Popup copies these values from this read. The server does not re-read
          Binance to verify them.
        </li>
        <li>Linking never closes the experiment, a sell included: only a close you add ends it.</li>
        <li>Append-only: once stored, the link cannot be edited or removed.</li>
        {chosen && closed(chosen) && (
          <li>
            This experiment is closed. A fill linked now stays visible as linked after the close.
          </li>
        )}
      </ul>
      <div className="spot-record-actions">
        <button
          type="button"
          className="portfolio-cash-btn"
          // aria-disabled, not disabled: a disabled button drops keyboard focus mid-save.
          aria-disabled={locked || undefined}
          onClick={locked ? undefined : confirm}
        >
          {confirmText}
        </button>
        <button
          type="button"
          className="portfolio-cash-btn"
          aria-disabled={saving || undefined}
          onClick={saving ? undefined : onClose}
        >
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
      <OutcomeText outcome={outcome} row={sent} experiments={experiments} />
    </section>
  );
}

export interface FillLinkingView {
  /** The Experiment cell for one consistent execution row; absent when rows can't be linked. */
  linkCell?: (execution: SpotExecution) => ReactNode;
  /** Why fills can't be linked, or the open link panel. */
  linkArea: ReactNode;
}

/**
 * Lets the owner link a consistent execution row to one of their experiments with the same pair
 * and the account label given for this retrieval. It reads the same experiment list as Account,
 * so it asks the database nothing new, and stores a link only after an explicit review.
 */
export function FillLinking({
  userId,
  accountLabel,
  snapshot,
  children,
}: Readonly<{
  userId: string;
  accountLabel: string;
  snapshot: SpotExecutionEvidence;
  children: (view: FillLinkingView) => ReactNode;
}>) {
  const id = useId();
  const devAuth = isDevAuthUser(userId);
  const query = useQuery({
    queryKey: ['spot-experiments', userId],
    queryFn: () => loadOwnerExperiments(userId),
    enabled: !devAuth && accountLabel !== '',
    retry: false,
  });
  const [open, setOpen] = useState<SpotExecution | null>(null);

  const cellId = (execution: SpotExecution) => `${id}-${executionIdentity(execution)}`;
  const close = () => {
    const shown = open;
    setOpen(null);
    if (!shown) return;
    // Back to the row's control, or to its status once the link made the control go away.
    requestAnimationFrame(() => {
      const cell = document.getElementById(cellId(shown));
      (cell?.querySelector<HTMLElement>('button') ?? cell)?.focus();
    });
  };

  const note = (text: string, alert = false) =>
    children({
      linkArea: (
        <p className={alert ? 'spot-failed' : 'spot-note'} role={alert ? 'alert' : undefined}>
          {text}
        </p>
      ),
    });

  if (devAuth) return note('The ?devAuth preview has no session, so no fill can be linked.');
  if (accountLabel === '') {
    return note(
      'To link a fill to an experiment, enter the account label you use in your experiments and load again.',
    );
  }
  if (query.isPending) return note('Checking your experiments for fills to link…');
  if (query.isError) {
    return note(
      `Couldn't load your experiments (${query.error.message}), so no fill can be linked.`,
      true,
    );
  }
  if (!query.data.owner) {
    return note(
      'Linking unavailable: the database names no Binance owner, or names another account, so it accepts no link from this sign-in.',
    );
  }
  const { experiments } = query.data;
  const read: FillRead = {
    accountLabel,
    retrievedAt: snapshot.retrievedAt,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    complete: requestedCoverageComplete(snapshot),
  };

  const linkCell = (execution: SpotExecution) => {
    const stored = storedLink(experiments, accountLabel, execution.symbol, execution.tradeId);
    let content: ReactNode;
    if (stored) {
      const differs =
        fillDifferences(stored.fill, fillRow(stored.experiment.id, execution, read)).length > 0;
      content = (
        <>
          Linked: {stored.experiment.symbol} recorded {utcText(stored.experiment.recorded_at)}
          {differs && (
            <span className="spot-field-error"> · stored copy differs from this read</span>
          )}
        </>
      );
    } else if (matchingExperiments(experiments, execution.symbol, accountLabel).length === 0) {
      content = `No ${execution.symbol} experiment under ${accountLabel}`;
    } else {
      content = (
        <button
          type="button"
          className="spot-link-btn"
          aria-label={`Link ${execution.side} ${execution.symbol} trade ${execution.tradeId} to an experiment`}
          aria-expanded={open !== null && sameExecution(open, execution)}
          onClick={() => setOpen(execution)}
        >
          Link to experiment
        </button>
      );
    }
    return (
      <span id={cellId(execution)} tabIndex={-1}>
        {content}
      </span>
    );
  };

  return children({
    linkCell,
    linkArea: open && (
      <LinkPanel
        key={executionIdentity(open)}
        execution={open}
        snapshot={snapshot}
        read={read}
        experiments={experiments}
        userId={userId}
        onClose={close}
      />
    ),
  });
}
