import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { SpotExperimentOwnerGate } from '@/components/RecordSpotExperiment';
import { isDevAuthUser, useAuth } from '@/lib/authStore';
import {
  MAX_STATEMENT,
  spotSymbol,
  type CandidateEvidence,
  type RecordOutcome,
} from '@/lib/spotExperiments';
import { noEntryQueryKey, recordNoEntry, type NoEntrySubmission } from '@/lib/spotNoEntry';

type Source = Readonly<{
  scanId: string;
  snapshotSha256: string;
  evidence: () => CandidateEvidence;
}>;

function NoEntryForm({
  scanId,
  snapshotSha256,
  evidence,
  userId,
}: Source & Readonly<{ userId: string }>) {
  const id = useId();
  const client = useQueryClient();
  const request = useRef<NoEntrySubmission | null>(null);
  const saving = useRef(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<RecordOutcome | 'saving'>();
  const recorded = typeof outcome === 'object' && outcome.state === 'recorded';
  const uncertain = typeof outcome === 'object' && outcome.state === 'unknown';

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || recorded) return;
    if (!request.current) {
      const note = reason.trim();
      if (!note || [...note].length > MAX_STATEMENT) {
        setError(`Enter a reason of 1 to ${MAX_STATEMENT} characters.`);
        return;
      }
      const sourceEvidence = evidence();
      const symbol = spotSymbol(sourceEvidence.instrument);
      if (!symbol) {
        setError('The saved scan did not identify a Binance Spot USDT pair.');
        return;
      }
      request.current = {
        id: crypto.randomUUID(),
        symbol,
        source_scan_id: scanId,
        source_snapshot_sha256: snapshotSha256,
        source_evidence: sourceEvidence,
        reason: note,
      };
    }

    saving.current = true;
    setError(undefined);
    setOutcome('saving');
    const reply = await recordNoEntry(request.current, userId);
    const result =
      uncertain && reply.state === 'refused' ? { ...reply, state: 'unknown' as const } : reply;
    if (result.state === 'refused') request.current = null;
    if (result.state === 'recorded') {
      void client.invalidateQueries({ queryKey: noEntryQueryKey(userId) });
    }
    setOutcome(result);
    saving.current = result.state === 'recorded';
  }

  return (
    <form className="spot-record" onSubmit={(event) => void submit(event)}>
      <div className="spot-field">
        <label htmlFor={id}>Why did you choose to stay out?</label>
        <textarea
          id={id}
          className="portfolio-cash-input spot-textarea"
          dir="auto"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setError(undefined);
          }}
          readOnly={outcome === 'saving' || uncertain || recorded}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          required
        />
      </div>
      {error && (
        <p id={`${id}-error`} className="spot-field-error" role="alert">
          {error}
        </p>
      )}
      {typeof outcome === 'object' && outcome.state !== 'recorded' && (
        <p className="spot-field-error" role="alert">
          {outcome.state === 'unknown'
            ? 'Popup could not confirm the save. Retry to check or save the same decision.'
            : outcome.message}
        </p>
      )}
      {recorded && (
        <output className="spot-note">
          Saved to Journal → Manual Spot experiments → No-entry decisions.
        </output>
      )}
      {!recorded && (
        <div className="spot-record-actions">
          <button type="submit" className="portfolio-cash-btn" disabled={outcome === 'saving'}>
            {outcome === 'saving' ? 'Saving…' : uncertain ? 'Retry save' : 'Save no-entry decision'}
          </button>
        </div>
      )}
    </form>
  );
}

export function RecordSpotNoEntry(source: Source) {
  const { user } = useAuth();
  const [visited, setVisited] = useState(false);
  if (!user || isDevAuthUser(user.id)) return null;
  return (
    <details
      className="scan-guide-details"
      onToggle={(event) => {
        if (event.currentTarget.open) setVisited(true);
      }}
    >
      <summary>I reviewed this pair and chose to stay out</summary>
      {visited && (
        <SpotExperimentOwnerGate userId={user.id}>
          <NoEntryForm key={user.id} {...source} userId={user.id} />
        </SpotExperimentOwnerGate>
      )}
    </details>
  );
}
