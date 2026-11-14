import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { CloseComposer, ExperimentEntries } from '@/components/ExperimentEntries';
import { isDevAuthUser } from '@/lib/authStore';
import {
  afterClose,
  EXPERIMENT_LIMIT,
  ExperimentReadError,
  loadOwnerExperiments,
  NAMED_RULES,
  parseEvidence,
  RULE_NAME,
  ruleVersions,
  type ExperimentEntry,
  type LinkedFill,
  type SpotExperimentRecord,
} from '@/lib/spotExperiments';
import { utcText } from '@/lib/utils';

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const REPRODUCTION: Record<string, string> = {
  match: 'Match: reproduced offline when recorded, as the browser reported it',
  not_checked: 'Not checked when recorded',
};

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

/** An owner's statement with its stated and recorded times. */
function Statement({ entry }: Readonly<{ entry: ExperimentEntry }>) {
  return (
    <>
      {entry.statement}{' '}
      <span className="market-scan-rule">
        (stated {entry.stated_at ? <Time value={entry.stated_at} /> : 'not stated'}; recorded{' '}
        <Time value={entry.recorded_at} />)
      </span>
    </>
  );
}

/** One linked fill: the copied values, the read it came from, and when the database stored the link. */
function Fill({ fill, closedAt }: Readonly<{ fill: LinkedFill; closedAt: string | null }>) {
  const late = afterClose(fill.recorded_at, closedAt);
  return (
    <li className="experiment-fill">
      <p className="spot-standing">
        <span className="market-scan-ticker">{fill.side === 'buy' ? 'Buy' : 'Sell'}</span>{' '}
        <span>
          trade <code>{fill.trade_id}</code> · order <code>{fill.order_id}</code>
        </span>{' '}
        {late && <span className="market-scan-tag scan-stale">Linked after the close</span>}
      </p>
      <dl className="scan-facts">
        <Fact
          name="Trade time"
          value={
            <time dateTime={new Date(fill.trade_time_ms).toISOString()}>
              {utcText(fill.trade_time_ms)}
            </time>
          }
        />
        <Fact name="Quantity" value={<code>{fill.quantity}</code>} />
        <Fact name="Price" value={<code>{fill.price}</code>} />
        <Fact name="Quote quantity" value={<code>{fill.quote_quantity}</code>} />
        <Fact
          name="Commission"
          value={
            <code>
              {fill.commission} {fill.commission_asset}
            </code>
          }
        />
        <Fact
          name="Copied from"
          value={
            <>
              A read retrieved <Time value={fill.retrieved_at} /> (the function&rsquo;s clock) for{' '}
              {utcText(fill.window_start_ms)} – {utcText(fill.window_end_ms)};{' '}
              {fill.coverage_complete
                ? 'coverage complete for that pair and window'
                : 'coverage incomplete'}
            </>
          }
        />
        <Fact
          name="Linked"
          value={
            <>
              <Time value={fill.recorded_at} />, the database&rsquo;s clock
            </>
          }
        />
      </dl>
    </li>
  );
}

function Fills({ fills, closedAt }: Readonly<{ fills: LinkedFill[]; closedAt: string | null }>) {
  if (fills.length === 0) return <p className="market-scan-fit">No linked fills</p>;
  const ordered = [...fills].sort(
    (a, b) => a.trade_time_ms - b.trade_time_ms || a.trade_id.localeCompare(b.trade_id),
  );
  return (
    <>
      <p className="market-scan-fit">
        Client-submitted copies of Popup Binance reads, in trade time order. The server did not
        verify them against Binance. Nothing is derived from them: no position, total or P&amp;L.
      </p>
      <ol className="experiment-fills" aria-label="Linked fills, in trade time order">
        {ordered.map((fill) => (
          <Fill key={fill.id} fill={fill} closedAt={closedAt} />
        ))}
      </ol>
    </>
  );
}

/**
 * What the record holds, stated as counts and the owner's words only: no sale is inferred and
 * nothing is totalled, valued or rated.
 */
function RecordSummary({ experiment }: Readonly<{ experiment: SpotExperimentRecord }>) {
  const entries = experiment.spot_experiment_entries;
  const fills = experiment.spot_experiment_fills;
  const close = entries.find((entry) => entry.kind === 'close');
  const closedAt = close?.recorded_at ?? null;
  const observations = entries.filter((entry) => entry.kind === 'observation');
  const rules = ruleVersions(entries);
  const approved = NAMED_RULES.filter((rule) => rules.named[rule]?.rule_status === 'approved');
  const undecided = NAMED_RULES.filter((rule) => !approved.includes(rule));
  const otherApproved = rules.other.filter((entry) => entry.rule_status === 'approved').length;
  const ruleParts = [
    approved.length > 0 && `Approved: ${approved.map((rule) => RULE_NAME[rule]).join(', ')}`,
    undecided.length > 0 && `Not decided: ${undecided.map((rule) => RULE_NAME[rule]).join(', ')}`,
    otherApproved > 0 && `Other approved: ${otherApproved}`,
    `History: ${count(rules.history.length, 'entry', 'entries')}`,
  ].filter(Boolean);
  const buys = fills.filter((fill) => fill.side === 'buy').length;
  const late = (items: { recorded_at: string }[]) =>
    items.filter((item) => afterClose(item.recorded_at, closedAt)).length;
  return (
    <dl className="scan-facts">
      <Fact
        name="Decision"
        value={
          <>
            {experiment.decision}{' '}
            <span className="market-scan-rule">
              (stated{' '}
              {experiment.decision_stated_at ? (
                <Time value={experiment.decision_stated_at} />
              ) : (
                'not stated'
              )}
              ; recorded <Time value={experiment.recorded_at} />)
            </span>
          </>
        }
      />
      <Fact
        name="Source scan"
        value={`${experiment.source_scan_id} · reproduction: ${experiment.source_reproduction.replace('_', ' ')} · authenticity not established`}
      />
      <Fact name="Rules" value={ruleParts.join(' · ')} />
      <Fact
        name="Linked fills"
        value={
          fills.length === 0
            ? 'None linked'
            : `${fills.length} linked: ${buys} buy, ${fills.length - buys} sell. Only fills linked here; nothing is derived from them.`
        }
      />
      <Fact
        name="Observations"
        value={observations.length === 0 ? 'None recorded' : `${observations.length} recorded`}
      />
      <Fact
        name="Close"
        value={close ? <Statement entry={close} /> : 'Not closed: no close recorded'}
      />
      {close && (
        <Fact
          name="Recorded after the close"
          value={[
            count(late(fills), 'linked fill', 'linked fills'),
            count(
              late(entries.filter((entry) => entry.kind === 'rule')),
              'rule entry',
              'rule entries',
            ),
            count(late(observations), 'observation', 'observations'),
          ].join(', ')}
        />
      )}
    </dl>
  );
}

function Detail({
  experiment,
  onRefresh,
}: Readonly<{ experiment: SpotExperimentRecord; onRefresh: () => Promise<boolean> }>) {
  const evidence = parseEvidence(experiment.source_evidence);
  const entries = experiment.spot_experiment_entries;
  const close = entries.find((entry) => entry.kind === 'close');
  return (
    <div className="experiment-detail">
      <dl className="scan-facts">
        <Fact name="Decision" value={experiment.decision} />
        <Fact
          name="Stated decision time"
          value={
            experiment.decision_stated_at ? (
              <>
                <Time value={experiment.decision_stated_at} />, your statement
              </>
            ) : (
              'Not stated'
            )
          }
        />
        <Fact
          name="Recorded"
          value={
            <>
              <Time value={experiment.recorded_at} />, the database&rsquo;s clock
            </>
          }
        />
        <Fact
          name="Account label"
          value={`${experiment.account_label} (your label; it does not identify a Binance account)`}
        />
      </dl>

      <h5 className="scan-effects-title">Source</h5>
      <dl className="scan-facts">
        <Fact name="Scan" value={<code>{experiment.source_scan_id}</code>} />
        <Fact name="Snapshot SHA-256" value={<code>{experiment.source_snapshot_sha256}</code>} />
        <Fact
          name="Reproduction"
          value={REPRODUCTION[experiment.source_reproduction] ?? experiment.source_reproduction}
        />
        <Fact name="Authenticity" value="Not established: local snapshots are unsigned" />
      </dl>

      <h5 className="scan-effects-title">Candidate evidence, as copied when recorded</h5>
      {evidence ? (
        <dl className="scan-facts">
          {evidence.facts.map(([name, value]) => (
            <Fact key={name} name={name} value={value} />
          ))}
        </dl>
      ) : (
        <p className="market-scan-fit">
          This copy is not in a form this view can read, so none of it is shown.
        </p>
      )}

      <ExperimentEntries experiment={experiment} onRefresh={onRefresh} />

      <h5 className="scan-effects-title">Linked fills</h5>
      <Fills fills={experiment.spot_experiment_fills} closedAt={close?.recorded_at ?? null} />

      <h5 className="scan-effects-title">Record summary</h5>
      <RecordSummary experiment={experiment} />
      <div className="experiment-entry-actions">
        <CloseComposer
          experiment={experiment}
          onRefresh={onRefresh}
          summary={<RecordSummary experiment={experiment} />}
        />
      </div>
    </div>
  );
}

function ExperimentList({
  experiments,
  onRefresh,
}: Readonly<{ experiments: SpotExperimentRecord[]; onRefresh: () => Promise<boolean> }>) {
  if (experiments.length === 0) {
    return (
      <p className="spot-note">
        No experiments recorded yet. Record one from a saved scan&rsquo;s Manual Spot scenario in
        Research.
      </p>
    );
  }
  return (
    <>
      <ol className="experiment-list" aria-label="Experiments, newest recorded first">
        {experiments.map((experiment) => {
          const stale = parseEvidence(experiment.source_evidence)?.stale === true;
          return (
            <li key={experiment.id}>
              <details className="experiment-item">
                <summary>
                  <span className="market-scan-ticker">{experiment.symbol}</span>{' '}
                  <span className="market-scan-rule">
                    {experiment.account_label} · recorded <Time value={experiment.recorded_at} />
                  </span>
                  {(experiment.decision_stated_at || stale) && (
                    <span className="market-scan-tag">Retrospective</span>
                  )}
                  {stale && <span className="market-scan-tag scan-stale">Historical scan</span>}
                </summary>
                <Detail experiment={experiment} onRefresh={onRefresh} />
              </details>
            </li>
          );
        })}
      </ol>
      {experiments.length === EXPERIMENT_LIMIT && (
        <p className="spot-note">
          Showing the {EXPERIMENT_LIMIT} most recently recorded. Older ones are stored but not shown
          here.
        </p>
      )}
    </>
  );
}

function failureText(error: Error): string {
  if (error instanceof ExperimentReadError && error.code === '42501') {
    return `The database refused the read: permission denied (${error.message}). Nothing is shown.`;
  }
  return `Couldn't load experiments (${error.message}). Nothing is shown, so none is assumed.`;
}

/**
 * The owner's Manual Spot experiments, read-only, inside the Binance Spot card. The database
 * decides access; a sign-in it does not name as the owner sees why, never an empty list.
 */
export function SpotExperiments({ userId }: Readonly<{ userId: string }>) {
  const devAuth = isDevAuthUser(userId);
  const query = useQuery({
    queryKey: ['spot-experiments', userId],
    queryFn: () => loadOwnerExperiments(userId),
    // The dev stub has no session to read with.
    enabled: !devAuth,
    retry: false,
  });

  let body: ReactNode;
  if (devAuth) {
    body = <p className="spot-note">The ?devAuth preview has no session to read them with.</p>;
  } else if (query.isPending) {
    body = <output className="spot-status">Loading experiments…</output>;
  } else if (query.isError && query.data === undefined) {
    body = (
      <div className="spot-failed" role="alert">
        <p>{failureText(query.error)}</p>
        <button type="button" className="portfolio-cash-btn" onClick={() => void query.refetch()}>
          Retry
        </button>
      </div>
    );
  } else if (query.data === undefined) {
    body = <output className="spot-status">Loading experiments…</output>;
  } else if (!query.data.owner) {
    body = (
      <p className="spot-note">
        Unavailable: the database names no Binance owner, or names another account, so it shows and
        accepts no experiment for this sign-in. A database administrator sets the owner.
      </p>
    );
  } else {
    body = (
      <ExperimentList
        experiments={query.data.experiments}
        onRefresh={async () => (await query.refetch()).isSuccess}
      />
    );
  }

  return (
    <section aria-labelledby="spot-experiments-title" className="spot-experiments">
      <h4 id="spot-experiments-title" className="portfolio-section-title">
        Manual Spot experiments
      </h4>
      <p className="spot-note">
        Your recorded decisions and the scans they came from. Separate from the paper Signal Journal
        and every Popup ledger: nothing here is a position, total or order status.
      </p>
      {body}
    </section>
  );
}
