import { useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import {
  afterClose,
  checkCloseDraft,
  checkObservationDraft,
  checkRuleDraft,
  NAMED_RULES,
  recordExperimentEntry,
  RULE_NAME,
  ruleVersions,
  type CloseDraft,
  type EntryDraftErrors,
  type EntryOutcome,
  type ExperimentEntry,
  type ExperimentEntryInsert,
  type NamedRule,
  type ObservationDraft,
  type RuleDraft,
  type RuleName,
  type SpotExperimentRecord,
} from '@/lib/spotExperiments';
import { utcText } from '@/lib/utils';

const STATUS_NAME = { proposed: 'Proposal', approved: 'Approved', withdrawn: 'Withdrawn' } as const;
const PLACE_NAME = { binance_interface: 'Binance interface', elsewhere: 'Elsewhere' } as const;

function Fact({ name, value }: Readonly<{ name: string; value: ReactNode }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Time({ value }: Readonly<{ value: string }>) {
  return <time dateTime={value}>{utcText(value)}</time>;
}

function AfterCloseTag() {
  return <span className="market-scan-tag scan-stale">Recorded after the close</span>;
}

function Statement({
  entry,
  closedAt = null,
}: Readonly<{ entry: ExperimentEntry; closedAt?: string | null }>) {
  return (
    <>
      {entry.statement}{' '}
      <span className="market-scan-rule">
        (stated {entry.stated_at ? <Time value={entry.stated_at} /> : 'not stated'}; recorded{' '}
        <Time value={entry.recorded_at} />)
      </span>
      {afterClose(entry.recorded_at, closedAt) && (
        <>
          {' '}
          <AfterCloseTag />
        </>
      )}
    </>
  );
}

function RuleValue({
  entry,
  closedAt = null,
}: Readonly<{ entry: ExperimentEntry | null; closedAt?: string | null }>) {
  if (!entry) return <>Not decided</>;
  const status = STATUS_NAME[entry.rule_status as keyof typeof STATUS_NAME];
  return (
    <>
      <strong>{status}</strong> — <Statement entry={entry} closedAt={closedAt} />
      {entry.rule_status !== 'approved' && <> · Not decided</>}
    </>
  );
}

function Rules({
  entries,
  closedAt,
}: Readonly<{ entries: ExperimentEntry[]; closedAt: string | null }>) {
  const rules = ruleVersions(entries);
  return (
    <>
      <h5 className="scan-effects-title">Rules</h5>
      <dl className="scan-facts">
        {NAMED_RULES.map((rule) => (
          <Fact
            key={rule}
            name={RULE_NAME[rule]}
            value={<RuleValue entry={rules.named[rule]} closedAt={closedAt} />}
          />
        ))}
        {rules.other.map((entry) => (
          <Fact
            key={entry.id}
            name="Other"
            value={<RuleValue entry={entry} closedAt={closedAt} />}
          />
        ))}
      </dl>
      {rules.history.length > 0 && (
        <details className="experiment-history">
          <summary>Rule history ({rules.history.length})</summary>
          <ol aria-label="Rule history">
            {rules.history.map((entry) => (
              <li key={entry.id}>
                <strong>
                  {RULE_NAME[entry.rule as RuleName]} ·{' '}
                  {STATUS_NAME[entry.rule_status as keyof typeof STATUS_NAME]}
                </strong>{' '}
                — <Statement entry={entry} closedAt={closedAt} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

function Observations({
  entries,
  closedAt,
}: Readonly<{ entries: ExperimentEntry[]; closedAt: string | null }>) {
  const observations = entries
    .filter((entry) => entry.kind === 'observation')
    .sort(
      (a, b) => Date.parse(a.stated_at!) - Date.parse(b.stated_at!) || a.id.localeCompare(b.id),
    );
  return (
    <>
      <h5 className="scan-effects-title">Dated observations</h5>
      {observations.length === 0 ? (
        <p className="market-scan-fit">None recorded</p>
      ) : (
        <ol className="experiment-observations" aria-label="Dated observations">
          {observations.map((entry) => (
            <li key={entry.id}>
              <p className="spot-standing">
                <strong>{PLACE_NAME[entry.observed_in as keyof typeof PLACE_NAME]}</strong>
                {Date.parse(entry.stated_at!) < Date.parse(entry.recorded_at) && (
                  <span className="market-scan-tag">Retrospective</span>
                )}
                {afterClose(entry.recorded_at, closedAt) && <AfterCloseTag />}
              </p>
              <p>{entry.statement}</p>
              <p className="market-scan-rule">
                Stated <Time value={entry.stated_at!} /> · Recorded{' '}
                <Time value={entry.recorded_at} />
              </p>
              <p className="market-scan-fit">
                This records what was observed then; it does not state what is true now.
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

type SaveState = EntryOutcome | 'saving' | null;
type RefreshState = 'idle' | 'pending' | 'succeeded' | 'failed';

function SaveOutcome({
  state,
  noun,
  refreshState,
}: Readonly<{ state: SaveState; noun: string; refreshState: RefreshState }>) {
  if (state === 'saving')
    return (
      <output className="spot-record-status">Saving… waiting for the database to confirm.</output>
    );
  if (state?.state === 'recorded') {
    return (
      <output className="spot-record-status">
        Saved. The database recorded this {noun} at <Time value={state.entry.recorded_at} />, by its
        own clock.
      </output>
    );
  }
  if (state?.state === 'refused')
    return (
      <p role="alert" className="spot-field-error">
        Not saved. {state.message} Nothing was stored.
      </p>
    );
  if (state?.state === 'conflict')
    return (
      <p role="alert" className="spot-field-error">
        Not saved. {state.message}
      </p>
    );
  if (state?.state === 'unknown') {
    return (
      <p role="alert" className="spot-field-error">
        No confirmation from the database ({state.message}). This {noun} may or may not be stored.
        {refreshState === 'pending' &&
          ' History refresh pending. Saving remains locked while you inspect the visible history.'}
        {refreshState === 'succeeded' &&
          ' History refreshed. Inspect it before deciding what happened; saving remains locked.'}
        {refreshState === 'failed' &&
          ' History refresh failed. The history shown may be stale; saving remains locked.'}
      </p>
    );
  }
  return null;
}

function Actions({
  noun,
  state,
  onConfirm,
  onEdit,
  onAddAnother,
  refreshState,
}: Readonly<{
  noun: string;
  state: SaveState;
  onConfirm: () => void;
  onEdit: () => void;
  /** Omitted when only one such entry may exist. */
  onAddAnother?: () => void;
  refreshState: RefreshState;
}>) {
  if (state !== null && state !== 'saving' && state.state === 'recorded') {
    return (
      <>
        {onAddAnother && (
          <button type="button" className="portfolio-cash-btn" onClick={onAddAnother}>
            Add another {noun}
          </button>
        )}
        <SaveOutcome state={state} noun={noun} refreshState={refreshState} />
      </>
    );
  }
  const locked = state === 'saving' || (state !== null && state.state !== 'refused');
  const editLocked = state === 'saving' || (state !== null && state.state === 'unknown');
  return (
    <>
      <div className="spot-record-actions">
        <button type="button" className="portfolio-cash-btn" disabled={locked} onClick={onConfirm}>
          {state === 'saving' ? 'Saving…' : `Confirm and save ${noun}`}
        </button>
        <button type="button" className="portfolio-cash-btn" disabled={editLocked} onClick={onEdit}>
          Edit
        </button>
      </div>
      <SaveOutcome state={state} noun={noun} refreshState={refreshState} />
    </>
  );
}

/**
 * One append-only save: it locks before the request leaves, claims success only from the returned
 * row, and after an unanswered request refreshes the history but stays locked.
 */
function useEntrySave(
  onRefresh: () => Promise<boolean>,
  onRecorded?: (entry: ExperimentEntry) => void,
) {
  const [state, setState] = useState<SaveState>(null);
  const [refreshState, setRefreshState] = useState<RefreshState>('idle');
  const saving = useRef(false);
  const confirm = (row: ExperimentEntryInsert) => {
    if (saving.current) return;
    saving.current = true;
    setState('saving');
    void (async () => {
      const outcome = await recordExperimentEntry(row);
      if (outcome.state === 'refused') saving.current = false;
      if (outcome.state === 'unknown') setRefreshState('pending');
      if (outcome.state === 'recorded') onRecorded?.(outcome.entry);
      setState(outcome);
      if (outcome.state === 'unknown') {
        try {
          setRefreshState((await onRefresh()) ? 'succeeded' : 'failed');
        } catch {
          setRefreshState('failed');
        }
      } else if (outcome.state !== 'refused') {
        void onRefresh();
      }
    })();
  };
  const reset = () => {
    saving.current = false;
    setState(null);
    setRefreshState('idle');
  };
  return { state, refreshState, confirm, reset };
}

function RuleComposer({
  experiment,
  onRefresh,
}: Readonly<{ experiment: SpotExperimentRecord; onRefresh: () => Promise<boolean> }>) {
  const id = useId();
  const [draft, setDraft] = useState<RuleDraft>({
    rule: 'stop',
    status: 'proposed',
    statement: '',
    statedAt: '',
  });
  const [otherLine, setOtherLine] = useState('new');
  const [errors, setErrors] = useState<EntryDraftErrors & { form?: string }>({});
  const [review, setReview] = useState<ExperimentEntryInsert | null>(null);
  const [knownEntry, setKnownEntry] = useState<ExperimentEntry | null>(null);
  const save = useEntrySave(onRefresh, setKnownEntry);
  const heading = useRef<HTMLHeadingElement>(null);
  const knownEntries =
    knownEntry && !experiment.spot_experiment_entries.some((entry) => entry.id === knownEntry.id)
      ? [...experiment.spot_experiment_entries, knownEntry]
      : experiment.spot_experiment_entries;
  const versions = ruleVersions(knownEntries);
  const current =
    draft.rule === 'other'
      ? (versions.other.find((entry) => entry.id === otherLine) ?? null)
      : versions.named[draft.rule as NamedRule];

  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const check = checkRuleDraft(draft, Date.now());
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    if (check.status === 'withdrawn' && !current) {
      setErrors({ form: 'A withdrawal must replace the current version of this rule.' });
      return;
    }
    setErrors({});
    save.reset();
    setReview({
      experiment_id: experiment.id,
      kind: 'rule',
      rule: check.rule,
      rule_status: check.status,
      supersedes: current?.id ?? null,
      observed_in: null,
      statement: check.statement,
      stated_at: check.statedAt,
    });
  };

  if (review) {
    const replaced = knownEntries.find((entry) => entry.id === review.supersedes) ?? null;
    return (
      <section className="spot-record-review" aria-label="Check rule before saving">
        <h5 ref={heading} tabIndex={-1} className="scan-effects-title">
          Check rule before saving
        </h5>
        {review.stated_at && (
          <p className="spot-standing">
            <span className="market-scan-tag">Retrospective record</span>
          </p>
        )}
        <dl className="scan-facts">
          <Fact name="Rule" value={RULE_NAME[review.rule as RuleName]} />
          <Fact name="Status" value={STATUS_NAME[review.rule_status as keyof typeof STATUS_NAME]} />
          <Fact name="Statement" value={review.statement} />
          <Fact
            name="Stated time"
            value={review.stated_at ? utcText(review.stated_at) : 'Not stated'}
          />
          <Fact
            name="Replaces"
            value={
              replaced ? <RuleValue entry={replaced} /> : 'No earlier entry: starts a new rule line'
            }
          />
          <Fact name="Recorded time" value="Set by the database when it stores the entry" />
        </dl>
        <p className="market-scan-fit">
          This stores only your stated rule. Nothing is inferred from scenario inputs, fills or
          previous conversations.
        </p>
        <Actions
          noun="rule"
          state={save.state}
          onConfirm={() => save.confirm(review)}
          onEdit={() => {
            save.reset();
            setReview(null);
          }}
          onAddAnother={() => {
            save.reset();
            setDraft({ rule: 'stop', status: 'proposed', statement: '', statedAt: '' });
            setOtherLine('new');
            setErrors({});
            setReview(null);
          }}
          refreshState={save.refreshState}
        />
      </section>
    );
  }

  return (
    <form className="spot-inputs" noValidate onSubmit={submit}>
      <label className="spot-field" htmlFor={`${id}-rule`}>
        <span>Rule</span>
        <select
          id={`${id}-rule`}
          className="portfolio-cash-input"
          value={draft.rule}
          onChange={(event) => {
            setDraft((value) => ({ ...value, rule: event.target.value as RuleName }));
            setOtherLine('new');
          }}
        >
          {([...NAMED_RULES, 'other'] as RuleName[]).map((rule) => (
            <option key={rule} value={rule}>
              {RULE_NAME[rule]}
            </option>
          ))}
        </select>
      </label>
      {draft.rule === 'other' && versions.other.length > 0 && (
        <label className="spot-field" htmlFor={`${id}-line`}>
          <span>Rule line</span>
          <select
            id={`${id}-line`}
            className="portfolio-cash-input"
            value={otherLine}
            onChange={(event) => setOtherLine(event.target.value)}
          >
            <option value="new">New other rule</option>
            {versions.other.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.statement}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="spot-field" htmlFor={`${id}-status`}>
        <span>Status</span>
        <select
          id={`${id}-status`}
          className="portfolio-cash-input"
          value={draft.status}
          onChange={(event) =>
            setDraft((value) => ({ ...value, status: event.target.value as RuleDraft['status'] }))
          }
        >
          <option value="proposed">Proposed</option>
          <option value="approved">Approved</option>
          <option value="withdrawn">Withdrawn</option>
        </select>
      </label>
      <label className="spot-field" htmlFor={`${id}-statement`}>
        <span>Rule statement</span>
        <textarea
          id={`${id}-statement`}
          aria-label="Rule statement"
          className="portfolio-cash-input spot-textarea"
          rows={3}
          value={draft.statement}
          aria-invalid={errors.statement ? true : undefined}
          onChange={(event) => setDraft((value) => ({ ...value, statement: event.target.value }))}
        />
        {errors.statement && <span className="spot-field-error">{errors.statement}</span>}
      </label>
      <label className="spot-field" htmlFor={`${id}-time`}>
        <span>Rule stated time (UTC, optional)</span>
        <input
          id={`${id}-time`}
          aria-label="Rule stated time (UTC, optional)"
          className="portfolio-cash-input"
          type="datetime-local"
          value={draft.statedAt}
          aria-invalid={errors.statedAt ? true : undefined}
          onChange={(event) => setDraft((value) => ({ ...value, statedAt: event.target.value }))}
        />
        {errors.statedAt && <span className="spot-field-error">{errors.statedAt}</span>}
      </label>
      {errors.form && (
        <p role="alert" className="spot-field-error">
          {errors.form}
        </p>
      )}
      <button type="submit" className="portfolio-cash-btn">
        Review rule
      </button>
    </form>
  );
}

function ObservationComposer({
  experiment,
  onRefresh,
}: Readonly<{ experiment: SpotExperimentRecord; onRefresh: () => Promise<boolean> }>) {
  const id = useId();
  const [draft, setDraft] = useState<ObservationDraft>({
    observedIn: 'binance_interface',
    statement: '',
    statedAt: '',
  });
  const [errors, setErrors] = useState<EntryDraftErrors>({});
  const [review, setReview] = useState<ExperimentEntryInsert | null>(null);
  const save = useEntrySave(onRefresh);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const check = checkObservationDraft(draft, Date.now());
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    save.reset();
    setReview({
      experiment_id: experiment.id,
      kind: 'observation',
      rule: null,
      rule_status: null,
      supersedes: null,
      observed_in: check.observedIn,
      statement: check.statement,
      stated_at: check.statedAt,
    });
  };
  if (review) {
    return (
      <section className="spot-record-review" aria-label="Check observation before saving">
        <h5 ref={heading} tabIndex={-1} className="scan-effects-title">
          Check observation before saving
        </h5>
        <p className="spot-standing">
          <span className="market-scan-tag">Retrospective record</span>
        </p>
        <dl className="scan-facts">
          <Fact
            name="Observed in"
            value={PLACE_NAME[review.observed_in as keyof typeof PLACE_NAME]}
          />
          <Fact name="Observation" value={review.statement} />
          <Fact name="Stated time" value={utcText(review.stated_at!)} />
          <Fact name="Recorded time" value="Set by the database when it stores the entry" />
        </dl>
        <p className="market-scan-fit">
          This records what you observed at that stated time. It never claims the stop or anything
          else has that status now.
        </p>
        <Actions
          noun="observation"
          state={save.state}
          onConfirm={() => save.confirm(review)}
          onEdit={() => {
            save.reset();
            setReview(null);
          }}
          onAddAnother={() => {
            save.reset();
            setDraft({ observedIn: 'binance_interface', statement: '', statedAt: '' });
            setErrors({});
            setReview(null);
          }}
          refreshState={save.refreshState}
        />
      </section>
    );
  }
  return (
    <form className="spot-inputs" noValidate onSubmit={submit}>
      <label className="spot-field" htmlFor={`${id}-place`}>
        <span>Observed in</span>
        <select
          id={`${id}-place`}
          className="portfolio-cash-input"
          value={draft.observedIn}
          onChange={(event) =>
            setDraft((value) => ({
              ...value,
              observedIn: event.target.value as ObservationDraft['observedIn'],
            }))
          }
        >
          <option value="binance_interface">Binance interface</option>
          <option value="elsewhere">Elsewhere</option>
        </select>
      </label>
      <label className="spot-field" htmlFor={`${id}-statement`}>
        <span>Observation</span>
        <textarea
          id={`${id}-statement`}
          aria-label="Observation"
          className="portfolio-cash-input spot-textarea"
          rows={3}
          value={draft.statement}
          aria-invalid={errors.statement ? true : undefined}
          onChange={(event) => setDraft((value) => ({ ...value, statement: event.target.value }))}
        />
        {errors.statement && <span className="spot-field-error">{errors.statement}</span>}
      </label>
      <label className="spot-field" htmlFor={`${id}-time`}>
        <span>Observed at (UTC)</span>
        <input
          id={`${id}-time`}
          aria-label="Observed at (UTC)"
          className="portfolio-cash-input"
          type="datetime-local"
          value={draft.statedAt}
          aria-invalid={errors.statedAt ? true : undefined}
          onChange={(event) => setDraft((value) => ({ ...value, statedAt: event.target.value }))}
        />
        {errors.statedAt && <span className="spot-field-error">{errors.statedAt}</span>}
      </label>
      <button type="submit" className="portfolio-cash-btn">
        Review observation
      </button>
    </form>
  );
}

/**
 * The owner's explicit close: one append-only entry with a reason and an optional stated time.
 * It places no order and proves nothing about the Binance position; later evidence stays visible.
 */
export function CloseComposer({
  experiment,
  onRefresh,
  summary,
}: Readonly<{
  experiment: SpotExperimentRecord;
  onRefresh: () => Promise<boolean>;
  /** What the record holds now, shown in the review. */
  summary: ReactNode;
}>) {
  const id = useId();
  const [draft, setDraft] = useState<CloseDraft>({ statement: '', statedAt: '' });
  const [errors, setErrors] = useState<EntryDraftErrors>({});
  const [review, setReview] = useState<ExperimentEntryInsert | null>(null);
  const save = useEntrySave(onRefresh);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);
  const closed = experiment.spot_experiment_entries.some((entry) => entry.kind === 'close');

  if (closed && !review) {
    return (
      <p className="spot-note">
        Closing doesn&rsquo;t lock this record: rules, observations and fills added later still
        appear, each marked as recorded after the close.
      </p>
    );
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const check = checkCloseDraft(draft, Date.now());
    if (!check.ok) {
      setErrors(check.errors);
      return;
    }
    setErrors({});
    save.reset();
    setReview({
      experiment_id: experiment.id,
      kind: 'close',
      rule: null,
      rule_status: null,
      supersedes: null,
      observed_in: null,
      statement: check.statement,
      stated_at: check.statedAt,
    });
  };

  return (
    <details className="experiment-close">
      <summary>Close experiment record</summary>
      {review ? (
        <section className="spot-record-review" aria-label="Check close before saving">
          <h5 ref={heading} tabIndex={-1} className="scan-effects-title">
            Check close before saving
          </h5>
          {review.stated_at && (
            <p className="spot-standing">
              <span className="market-scan-tag">Retrospective record</span>
            </p>
          )}
          <dl className="scan-facts">
            <Fact name="Experiment" value={`${experiment.symbol} · ${experiment.account_label}`} />
            <Fact name="Reason" value={review.statement} />
            <Fact
              name="Stated time"
              value={review.stated_at ? utcText(review.stated_at) : 'Not stated'}
            />
            <Fact name="Recorded time" value="Set by the database when it stores the entry" />
          </dl>
          <p className="market-scan-fit">
            Closing this record places no order and sends nothing to Binance. It does not show that
            the Binance position is closed: Popup reads no orders or positions, and linked fills are
            copies the server did not verify.
          </p>
          <p className="market-scan-fit">
            Only one close can be stored, and it cannot be edited or removed. The record stays open
            to later rules, observations and fills, each marked as recorded after the close.
          </p>
          <section aria-label="What the record holds now">
            <h5 className="scan-effects-title">What the record holds now</h5>
            {summary}
          </section>
          <Actions
            noun="close entry"
            state={save.state}
            onConfirm={() => save.confirm(review)}
            onEdit={() => {
              save.reset();
              setReview(null);
            }}
            refreshState={save.refreshState}
          />
        </section>
      ) : (
        <form className="spot-inputs" noValidate onSubmit={submit}>
          <label className="spot-field" htmlFor={`${id}-reason`}>
            <span>Reason for closing</span>
            <textarea
              id={`${id}-reason`}
              aria-label="Reason for closing"
              className="portfolio-cash-input spot-textarea"
              rows={3}
              value={draft.statement}
              aria-invalid={errors.statement ? true : undefined}
              onChange={(event) =>
                setDraft((value) => ({ ...value, statement: event.target.value }))
              }
            />
            {errors.statement && <span className="spot-field-error">{errors.statement}</span>}
          </label>
          <label className="spot-field" htmlFor={`${id}-time`}>
            <span>Close stated time (UTC, optional)</span>
            <input
              id={`${id}-time`}
              aria-label="Close stated time (UTC, optional)"
              className="portfolio-cash-input"
              type="datetime-local"
              value={draft.statedAt}
              aria-invalid={errors.statedAt ? true : undefined}
              onChange={(event) =>
                setDraft((value) => ({ ...value, statedAt: event.target.value }))
              }
            />
            {errors.statedAt && <span className="spot-field-error">{errors.statedAt}</span>}
          </label>
          <p className="market-scan-fit">
            Closing places no order and does not show that the Binance position is closed.
          </p>
          <button type="submit" className="portfolio-cash-btn">
            Review close
          </button>
        </form>
      )}
    </details>
  );
}

export function ExperimentEntries({
  experiment,
  onRefresh,
}: Readonly<{ experiment: SpotExperimentRecord; onRefresh: () => Promise<boolean> }>) {
  const closedAt =
    experiment.spot_experiment_entries.find((entry) => entry.kind === 'close')?.recorded_at ?? null;
  return (
    <>
      <Rules entries={experiment.spot_experiment_entries} closedAt={closedAt} />
      <div className="experiment-entry-actions">
        <details>
          <summary>Add a rule</summary>
          <RuleComposer experiment={experiment} onRefresh={onRefresh} />
        </details>
        <details>
          <summary>Add an observation</summary>
          <ObservationComposer experiment={experiment} onRefresh={onRefresh} />
        </details>
      </div>
      <Observations entries={experiment.spot_experiment_entries} closedAt={closedAt} />
    </>
  );
}
