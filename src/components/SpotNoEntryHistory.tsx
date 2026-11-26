import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { parseEvidence } from '@/lib/spotExperiments';
import { loadNoEntryDecisions, NO_ENTRY_LIMIT, noEntryQueryKey } from '@/lib/spotNoEntry';
import { utcText } from '@/lib/utils';

export function SpotNoEntryHistory({ userId }: Readonly<{ userId: string }>) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: noEntryQueryKey(userId),
    queryFn: () => loadNoEntryDecisions(userId),
    enabled: open,
    retry: false,
  });

  return (
    <details className="scan-guide-details" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>No-entry decisions</summary>
      {open && query.isPending && <output className="spot-status">Loading decisions…</output>}
      {open && query.isError && (
        <div className="spot-failed" role="alert">
          <p>Couldn&rsquo;t load no-entry decisions.</p>
          <button type="button" className="portfolio-cash-btn" onClick={() => void query.refetch()}>
            Retry
          </button>
        </div>
      )}
      {open &&
        query.isSuccess &&
        (query.data.length === 0 ? (
          <p className="spot-note">No no-entry decisions recorded yet.</p>
        ) : (
          <>
            {query.data.length === NO_ENTRY_LIMIT && (
              <p className="spot-note">Showing the newest {NO_ENTRY_LIMIT} decisions.</p>
            )}
            <ul className="experiment-list" aria-label="Recorded no-entry decisions">
              {query.data.map((decision) => {
                const evidence = parseEvidence(decision.source_evidence);
                return (
                  <li key={decision.id}>
                    <details className="experiment-item">
                      <summary>
                        <strong>{decision.symbol}</strong>
                        <time dateTime={decision.recorded_at}>{utcText(decision.recorded_at)}</time>
                      </summary>
                      <div className="experiment-detail">
                        <div>
                          <strong>Reason</strong>
                          <p className="spot-note wrap-anywhere whitespace-pre-wrap" dir="auto">
                            {decision.reason}
                          </p>
                        </div>
                        <dl className="scan-facts">
                          <div>
                            <dt>Saved scan</dt>
                            <dd>
                              <code>{decision.source_scan_id}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Snapshot SHA-256</dt>
                            <dd>
                              <code>{decision.source_snapshot_sha256}</code>
                            </dd>
                          </div>
                          {evidence?.facts
                            .filter(([name]) => name !== 'Scan')
                            .map(([name, value], index) => (
                              <div key={index}>
                                <dt>{name}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                        </dl>
                        {!evidence && (
                          <p className="spot-note">The saved evidence could not be read.</p>
                        )}
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </>
        ))}
    </details>
  );
}
