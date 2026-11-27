import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { ScenarioSnapshotFacts } from '@/components/ScenarioFacts';
import { isDevAuthUser, useAuth } from '@/lib/authStore';
import {
  checkDraft,
  EMPTY_DRAFT,
  experimentRow,
  isSpotExperimentOwner,
  recordSpotExperiment,
  type CandidateEvidence,
  type DraftErrors,
  type ExperimentDraft,
  type RecordOutcome,
  type SpotExperimentInsert,
} from '@/lib/spotExperiments';
import type { ScenarioField, ScenarioInputs } from '@/lib/spotScenario';
import { scenarioSnapshot, type ScenarioSnapshot } from '@/lib/spotScenarioSnapshot';
import type { TradingViewSavedScan } from '@/lib/tradingViewDevScan';
import { utcText } from '@/lib/utils';

/** The draft's fields in form order, which is also the order errors take focus in. */
const FIELDS = ['decision', 'accountLabel', 'statedAt', 'includeScenario'] as const;
type FormErrors = DraftErrors & { includeScenario?: string; form?: string };

/** What a review captured: the row it will send, and what the row was built from. */
interface Reviewed {
  row: SpotExperimentInsert;
  evidence: CandidateEvidence;
  /** The included snapshot, the same frozen object as `row.scenario_snapshot`; null when left out. */
  snapshot: ScenarioSnapshot | null;
  /** The scenario inputs it was taken from, to tell a later edit apart. */
  scenario: ScenarioInputs | null;
  /** The scan, snapshot file and pair it was reviewed under. */
  context: string;
}

const sameInputs = (a: ScenarioInputs, b: ScenarioInputs) =>
  (Object.keys(a) as ScenarioField[]).every((field) => a[field] === b[field]);

const EXPERIMENTS_PLACE = 'Journal → Manual Spot experiments';

function Field({
  id,
  label,
  note,
  error,
  children,
}: Readonly<{
  id: string;
  label: string;
  note: string;
  error: string | undefined;
  children: (describedBy: string, invalid: boolean) => ReactNode;
}>) {
  const describedBy = [`${id}-note`, error && `${id}-error`].filter(Boolean).join(' ');
  return (
    <div className="spot-field">
      <label htmlFor={id}>{label}</label>
      {children(describedBy, error !== undefined)}
      <span id={`${id}-note`} className="market-scan-fit">
        {note}
      </span>
      {error && (
        <span id={`${id}-error`} className="spot-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

function Fact({ name, value }: Readonly<{ name: string; value: ReactNode }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Where a save stands: not sent, in flight, or answered. */
type Outcome = RecordOutcome | 'saving' | null;

function OutcomeText({ outcome }: Readonly<{ outcome: Outcome }>) {
  if (outcome === 'saving') {
    return (
      <output className="spot-record-status">
        Recording… waiting for the database to confirm.
      </output>
    );
  }
  if (outcome?.state === 'recorded') {
    return (
      <output className="spot-record-status">
        Recorded. The database stored experiment <code>{outcome.id}</code> at{' '}
        <time dateTime={outcome.recordedAt}>{utcText(outcome.recordedAt)}</time>, by its own clock.
        It is under {EXPERIMENTS_PLACE}.
      </output>
    );
  }
  if (outcome?.state === 'refused') {
    return (
      <p role="alert" className="spot-field-error">
        Not recorded. {outcome.message} Nothing was stored.
      </p>
    );
  }
  if (outcome?.state === 'unknown') {
    return (
      <p role="alert" className="spot-field-error">
        No confirmation from the database ({outcome.message}). The experiment may or may not be
        stored: check {EXPERIMENTS_PLACE} before recording it again.
      </p>
    );
  }
  return null;
}

/** What will be stored, exactly, and the one control that stores it. */
function Review({
  reviewed: { row, evidence, snapshot },
  stale,
  outcome,
  headingRef,
  onConfirm,
  onEdit,
  onReset,
}: Readonly<{
  reviewed: Reviewed;
  /** The scenario or its scan or pair changed since this review: it may no longer be sent. */
  stale: boolean;
  outcome: Outcome;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onConfirm: () => void;
  onEdit: () => void;
  onReset: () => void;
}>) {
  const id = useId();
  const saving = outcome === 'saving';
  const recorded = outcome !== null && outcome !== 'saving' && outcome.state === 'recorded';
  const unknown = outcome !== null && outcome !== 'saving' && outcome.state === 'unknown';
  // Only a review that could still be confirmed goes out of date.
  const outdated = stale && !saving && !recorded && !unknown;
  // A recorded row is never sent twice; an unanswered one only after the owner edits and reviews
  // it again; an outdated one only after a new review.
  const locked = saving || recorded || unknown || outdated;
  let confirmText = 'Confirm and record';
  if (saving) confirmText = 'Recording…';
  else if (recorded) confirmText = 'Recorded';
  return (
    <section aria-labelledby={`${id}-title`} className="spot-record-review">
      <h5 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="scan-effects-title">
        Check before recording
      </h5>
      {row.decision_stated_at && (
        <p className="spot-standing">
          <span className="market-scan-tag">Retrospective record</span>
          <span>
            Decided at {utcText(row.decision_stated_at)}, by your statement; the database adds the
            time it stores this.
          </span>
        </p>
      )}
      {evidence.stale && (
        <p className="spot-standing">
          <span className="market-scan-tag scan-stale">Historical scan</span>
          <span>
            Recorded retrospectively from evidence that describes an earlier day, not the market
            now.
          </span>
        </p>
      )}
      <dl className="scan-facts">
        <Fact name="Pair" value={row.symbol} />
        <Fact name="Account label" value={row.account_label} />
        <Fact name="Decision" value={row.decision} />
        <Fact
          name="Stated decision time"
          value={row.decision_stated_at ? utcText(row.decision_stated_at) : 'Not stated'}
        />
        <Fact name="Recorded time" value="Set by the database when it stores the record" />
        <Fact name="Source scan" value={<code>{row.source_scan_id}</code>} />
        <Fact name="Snapshot SHA-256" value={<code>{row.source_snapshot_sha256}</code>} />
        <Fact
          name="Reproduction"
          value="Match: this snapshot reproduced offline from its own inputs before it was shown"
        />
        <Fact name="Authenticity" value="Not established: local snapshots are unsigned" />
      </dl>
      <h5 className="scan-effects-title">Candidate evidence, copied as shown</h5>
      <dl className="scan-facts">
        {evidence.facts.map(([name, value]) => (
          <Fact key={name} name={name} value={value} />
        ))}
      </dl>
      {snapshot ? (
        <section aria-labelledby={`${id}-scenario`}>
          <h5 id={`${id}-scenario`} className="scan-effects-title">
            Scenario, included as a hypothetical planning record
          </h5>
          <ScenarioSnapshotFacts
            snapshot={snapshot}
            base={row.symbol.replace(/USDT$/, '')}
            symbol={row.symbol}
            modelBacked={evidence.long}
          />
        </section>
      ) : null}
      <ul className="market-scan-notes">
        <li>
          {snapshot
            ? 'Recorded with the scenario above, exactly as shown.'
            : 'Not recorded: your scenario inputs and figures.'}{' '}
          No rule is set, so allocation, stop, horizon, target and exit stay Not decided until you
          add them.
        </li>
        <li>Append-only: once stored, it cannot be edited or deleted.</li>
      </ul>
      {outdated && (
        <p role="alert" className="spot-field-error">
          The scenario, or the scan or pair it belongs to, changed after this review. Nothing was
          sent. Edit and review again to record what is shown now.
        </p>
      )}
      <div className="spot-record-actions">
        <button
          type="button"
          className="portfolio-cash-btn"
          // aria-disabled, not disabled: a disabled button drops keyboard focus mid-save.
          aria-disabled={locked || undefined}
          onClick={locked ? undefined : onConfirm}
        >
          {confirmText}
        </button>
        {recorded ? (
          <button type="button" className="portfolio-cash-btn" onClick={onReset}>
            Record another
          </button>
        ) : (
          <button
            type="button"
            className="portfolio-cash-btn"
            aria-disabled={saving || undefined}
            onClick={saving ? undefined : onEdit}
          >
            Edit
          </button>
        )}
      </div>
      <OutcomeText outcome={outcome} />
    </section>
  );
}

function ExperimentForm({
  evidence,
  scanId,
  saved,
  userId,
  scenario,
  context,
}: Readonly<{
  evidence: () => CandidateEvidence;
  scanId: string;
  saved: TradingViewSavedScan;
  userId: string;
  scenario: ScenarioInputs;
  context: string;
}>) {
  const id = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ExperimentDraft>(EMPTY_DRAFT);
  // Off by default: a scenario is part of the record only when the owner turns this on.
  const [include, setInclude] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [review, setReview] = useState<Reviewed | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  // Set before the request leaves, so a second click in the same frame sends nothing.
  const savingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (review) headingRef.current?.focus();
  }, [review]);

  const stale =
    review !== null &&
    (review.context !== context ||
      (review.scenario !== null && !sameInputs(review.scenario, scenario)));

  const onReview = (event: SubmitEvent) => {
    event.preventDefault();
    const check = checkDraft(draft, Date.now());
    // Taken once, here: the review shows this copy and Confirm sends the same object.
    const snapshot = include ? scenarioSnapshot(scenario) : null;
    if (!check.ok || typeof snapshot === 'string') {
      const found: FormErrors = {
        ...(check.ok ? {} : check.errors),
        ...(typeof snapshot === 'string' && { includeScenario: snapshot }),
      };
      setErrors(found);
      const first = FIELDS.find((name) => found[name]);
      if (first) document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    const copy = evidence();
    const row = experimentRow(check, copy, scanId, saved, snapshot);
    if (!row) {
      setErrors({
        form: `${copy.instrument} is not a Binance Spot USDT pair the database accepts.`,
      });
      return;
    }
    setErrors({});
    setOutcome(null);
    setReview({ row, evidence: copy, snapshot, scenario: snapshot ? scenario : null, context });
  };

  const confirm = () => {
    if (!review || savingRef.current || stale) return;
    savingRef.current = true;
    setOutcome('saving');
    void recordSpotExperiment(review.row).then((result) => {
      if (result.state === 'refused') savingRef.current = false;
      setOutcome(result);
      if (result.state === 'recorded') {
        void queryClient.invalidateQueries({ queryKey: ['spot-experiments', userId] });
      }
    });
  };

  const edit = () => {
    savingRef.current = false;
    setOutcome(null);
    setReview(null);
  };

  const reset = () => {
    edit();
    setDraft(EMPTY_DRAFT);
    setInclude(false);
  };

  if (review) {
    return (
      <Review
        reviewed={review}
        stale={stale}
        outcome={outcome}
        headingRef={headingRef}
        onConfirm={confirm}
        onEdit={edit}
        onReset={reset}
      />
    );
  }

  const set = (name: keyof ExperimentDraft) => (value: string) =>
    setDraft((current) => ({ ...current, [name]: value }));
  return (
    <form noValidate onSubmit={onReview} className="spot-inputs">
      <Field
        id={`${id}-decision`}
        label="Your decision"
        note="In your own words, as you made it: what you did or chose not to do. Stored as you write it."
        error={errors.decision}
      >
        {(describedBy, invalid) => (
          <textarea
            id={`${id}-decision`}
            name="experiment-decision"
            className="portfolio-cash-input spot-textarea"
            rows={3}
            value={draft.decision}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => set('decision')(event.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${id}-accountLabel`}
        label="Account label"
        note="Your own name for the Binance account, such as main. It does not identify the account to Binance or Popup."
        error={errors.accountLabel}
      >
        {(describedBy, invalid) => (
          <input
            id={`${id}-accountLabel`}
            name="experiment-account-label"
            className="portfolio-cash-input"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={draft.accountLabel}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => set('accountLabel')(event.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${id}-statedAt`}
        label="Stated decision time (UTC, optional)"
        note="When you made the decision. Empty means not stated. A stated time marks the record as retrospective."
        error={errors.statedAt}
      >
        {(describedBy, invalid) => (
          <input
            id={`${id}-statedAt`}
            name="experiment-stated-at"
            className="portfolio-cash-input"
            type="datetime-local"
            value={draft.statedAt}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => set('statedAt')(event.target.value)}
          />
        )}
      </Field>
      <div className="spot-field spot-include">
        <label htmlFor={`${id}-includeScenario`}>
          <input
            id={`${id}-includeScenario`}
            name="experiment-include-scenario"
            type="checkbox"
            checked={include}
            aria-invalid={errors.includeScenario ? true : undefined}
            aria-describedby={[
              `${id}-includeScenario-note`,
              errors.includeScenario && `${id}-includeScenario-error`,
            ]
              .filter(Boolean)
              .join(' ')}
            onChange={(event) => setInclude(event.target.checked)}
          />
          <span>Include this scenario in the record</span>
        </label>
        <span id={`${id}-includeScenario-note`} className="market-scan-fit">
          Off unless you turn it on. Adds the inputs and figures from Plan a hypothetical scenario,
          as they are when you review, as a hypothetical planning record. It sets no rule and places
          no order.
        </span>
        {errors.includeScenario && (
          <span id={`${id}-includeScenario-error`} className="spot-field-error">
            {errors.includeScenario}
          </span>
        )}
      </div>
      {errors.form && (
        <p role="alert" className="spot-field-error">
          {errors.form}
        </p>
      )}
      <button type="submit" className="portfolio-cash-btn">
        Review record
      </button>
    </form>
  );
}

/** The database answers for the signed-in user only; it never says who the owner is. */
export function SpotExperimentOwnerGate({
  userId,
  children,
}: Readonly<{ userId: string; children: ReactNode }>) {
  const owner = useQuery({
    queryKey: ['binance-spot-owner', userId],
    queryFn: isSpotExperimentOwner,
    retry: false,
  });
  if (owner.isPending) {
    return (
      <output className="market-scan-fit spot-record-status">
        Checking whether the database accepts experiments from this sign-in…
      </output>
    );
  }
  if (owner.isError) {
    return (
      <div role="alert" className="spot-field-error">
        <p>
          Couldn&rsquo;t check whether this sign-in may record experiments ({owner.error.message}
          ). Nothing can be recorded until the database answers.
        </p>
        <button type="button" className="portfolio-cash-btn" onClick={() => void owner.refetch()}>
          Check again
        </button>
      </div>
    );
  }
  if (!owner.data) {
    return (
      <p className="market-scan-fit">
        Recording unavailable: the database names no Binance owner, or names another account, so it
        accepts no experiment from this sign-in. A database administrator sets the owner. Nothing
        was sent.
      </p>
    );
  }
  return <>{children}</>;
}

/**
 * Records the owner's decision about one pair, with the candidate's evidence and the saved
 * snapshot's identity, after an explicit review. Mounted only while its disclosure is open, so
 * nothing is asked of the database until the owner opens it.
 */
export function RecordSpotExperiment({
  evidence,
  scanId,
  saved,
  scenario,
  context,
}: Readonly<{
  evidence: () => CandidateEvidence;
  scanId: string | undefined;
  saved: TradingViewSavedScan | undefined;
  /** The scenario's current inputs; included only when the owner opts in. */
  scenario: ScenarioInputs;
  /** Names the scan, snapshot file and pair; a change makes an open review out of date. */
  context: string;
}>) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  let body: ReactNode;
  if (!saved || !scanId) {
    body = (
      <p className="market-scan-fit">
        Recording needs a saved scan: choose {scanId ? <code>{scanId}</code> : 'this scan'} under
        Scan shown. That read reproduces the snapshot offline and reports its SHA-256, which the
        record names.
      </p>
    );
  } else if (userId === null) {
    body = <p className="market-scan-fit">Sign in to record an experiment.</p>;
  } else if (isDevAuthUser(userId)) {
    body = (
      <p className="market-scan-fit">
        The ?devAuth preview has no session, so it cannot record an experiment. Nothing is sent.
      </p>
    );
  } else {
    body = (
      <SpotExperimentOwnerGate userId={userId}>
        <ExperimentForm
          evidence={evidence}
          scanId={scanId}
          saved={saved}
          userId={userId}
          scenario={scenario}
          context={context}
        />
      </SpotExperimentOwnerGate>
    );
  }
  return (
    <div className="spot-record">
      <p className="market-scan-fit">
        Saves a record to Journal only when you press Confirm and record after Review record: your
        decision text, this candidate&rsquo;s evidence and the scan&rsquo;s identity, and the
        scenario only if you include it, for the configured Binance owner. Opening this section
        saves nothing. It places no order and links no fill.
      </p>
      {body}
    </div>
  );
}
