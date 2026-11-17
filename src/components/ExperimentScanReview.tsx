import { X } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { OpenSavedScanFile, SavedScanFileCheckState } from '@/components/SavedScanFile';
import { Button } from '@/components/ui/button';
import { useSavedScanFile } from '@/hooks/useSavedScanFile';
import { compareWithEntry, selectedPair, type SelectedPair } from '@/lib/experimentScanReview';
import { megabytes } from '@/lib/savedScanFile';
import {
  parseEvidence,
  type CandidateEvidence,
  type SpotExperimentRecord,
} from '@/lib/spotExperiments';
import type { TradingViewDevScan } from '@/lib/tradingViewDevScan';
import { utcText } from '@/lib/utils';

const NOT_STORED = 'Not stored in this copy';

/** Both sides list these, in this order, under the names a copy stores them by. */
const ROWS = [
  'Instrument',
  'Scan',
  'Model · timeframe',
  'Evaluated',
  'Scan evaluated',
  'ZC LONG',
  'ZC RISK',
  'Score',
  'Technical rank',
  'Freshness',
  'Freshness judged',
  'Data quality',
] as const;

function Facts({
  values,
  className = 'scan-facts',
}: Readonly<{ values: Record<string, ReactNode>; className?: string }>) {
  return (
    <dl className={className}>
      {Object.entries(values).map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The stored copy as stored: the extra rows say what it does not keep, never a value for it. */
function entryValues(evidence: CandidateEvidence, recordedAt: string): Record<string, string> {
  const stored = new Map(evidence.facts);
  const extra: Record<string, string> = {
    'Scan evaluated': NOT_STORED,
    Score: NOT_STORED,
    'Freshness judged': `When the evidence was copied, before this record was stored at ${utcText(recordedAt)}; the copy keeps no exact time`,
  };
  return Object.fromEntries(
    ROWS.map((name) => [name, extra[name] ?? stored.get(name) ?? 'Unknown: not in this copy']),
  );
}

function selectedValues(
  pair: Extract<SelectedPair, { state: 'EVALUATED' }>,
  judgedAt: number,
): Record<string, string> {
  const facts = new Map(pair.evidence.facts);
  const extra: Record<string, string> = {
    'Scan evaluated': `${utcText(pair.evaluationTime)}, the scan’s cutoff`,
    Score: String(pair.score),
    'Freshness judged': `${utcText(judgedAt)}, this browser’s clock, when the file was checked`,
  };
  return Object.fromEntries(
    ROWS.map((name) => [name, extra[name] ?? facts.get(name) ?? 'Unknown: not in this scan']),
  );
}

function Side({
  title,
  note,
  children,
}: Readonly<{ title: string; note: string; children: ReactNode }>) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="experiment-compare-side">
      <h6 id={id} className="scan-effects-title">
        {title}
      </h6>
      <p className="market-scan-fit">{note}</p>
      {children}
    </section>
  );
}

/**
 * One verified file beside the stored copy. Keyed by experiment and opening, so its freshness
 * reference time is the moment this file's check came back, and nothing carries to another file.
 */
function Comparison({
  experiment,
  view,
}: Readonly<{ experiment: SpotExperimentRecord; view: TradingViewDevScan }>) {
  const [judgedAt] = useState(Date.now);
  const entry = parseEvidence(experiment.source_evidence);
  const pair = selectedPair(view, experiment.symbol, judgedAt);
  const comparison = compareWithEntry(experiment, entry, view, pair);
  const sha = view.saved?.snapshotSha256 ?? '';
  return (
    <>
      <output className="devscan-saved saved-file-note">
        Scan <code>{view.scanId}</code>. It reproduced in this browser from its own inputs, which
        shows it is internally consistent, not that it is authentic: nothing signs it. File SHA-256{' '}
        <code title={sha}>{sha.slice(0, 12)}…</code> names these bytes only. A historical file you
        chose by hand, not a live or automatically refreshed assessment: it describes its cutoff,{' '}
        {utcText(view.scan.evaluationTime)}, not the market now.
      </output>
      <Facts
        className="scan-facts experiment-compare-facts"
        values={{
          'This file': comparison.identity,
          'Candle order': comparison.chronologyText,
          'Model and timeframe': comparison.modelText,
          'Reading the two':
            'Two observations of one pair. Nothing is inferred between them: no onset, recovery or alert. ZC LONG and ZC RISK are separate facts, and both can hold. Each rank is relative to its own scan’s universe, so the two ranks are not compared. Neither is a recommendation.',
        }}
      />
      <div className="experiment-compare">
        <Side
          title="Entry evidence, as recorded"
          note="Copied when you recorded this experiment and shown as stored: never recalculated or replaced."
        >
          {entry ? (
            <Facts values={entryValues(entry, experiment.recorded_at)} />
          ) : (
            <p className="market-scan-fit">
              Unknown: the copied evidence is not in a form this view can read, so none of it is
              shown.
            </p>
          )}
        </Side>
        <Side
          title="Selected scan evidence"
          note={`What the file you chose records for ${experiment.symbol}, matched by its exact Binance Spot symbol only.`}
        >
          {pair.state === 'EVALUATED' ? (
            <Facts values={selectedValues(pair, judgedAt)} />
          ) : (
            <p className="market-scan-fit">{pair.reason}</p>
          )}
        </Side>
      </div>
    </>
  );
}

/**
 * Review another saved scan, inside one experiment: the owner picks a saved crypto scan file,
 * Research's own check (useSavedScanFile, the finance worker) verifies it, and only then is this
 * experiment's exact pair shown beside the stored entry evidence. In component memory only:
 * nothing is fetched, stored or sent. Replacing the file drops the comparison at once; closing it,
 * or this disclosure, clears it, and a late check never brings it back.
 */
export function ExperimentScanReview({
  experiment,
}: Readonly<{ experiment: SpotExperimentRecord }>) {
  const { file, open, close } = useSavedScanFile();
  const choose = useRef<HTMLButtonElement>(null);
  const check = file?.phase === 'checked' ? file.check : null;
  const view = check?.state === 'VERIFIED' ? check.view : null;
  return (
    <details
      className="experiment-history experiment-scan-review"
      onToggle={(event) => {
        if (!event.currentTarget.open) close();
      }}
    >
      <summary>Review another saved scan</summary>
      <p className="market-scan-fit">
        Optional. Choose one saved TradingView crypto scan file to see what it records for{' '}
        {experiment.symbol}, this experiment&rsquo;s pair, beside the entry evidence as recorded. It
        is a historical file you select by hand, not a live or automatically refreshed assessment.
        Nothing is fetched, saved or sent, and this record does not change.
      </p>
      <OpenSavedScanFile onOpen={open} buttonRef={choose} label="Choose a saved scan file" />
      {file && (
        <section aria-label="Selected scan comparison" className="experiment-scan-compare">
          <div className="saved-file-head">
            <p>
              <strong>Historical file you chose</strong>: <code>{file.name}</code> ·{' '}
              {megabytes(file.size)}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                close();
                choose.current?.focus();
              }}
            >
              <X aria-hidden="true" /> Close comparison
            </Button>
          </div>
          <SavedScanFileCheckState file={file} />
          {view && (
            <Comparison
              key={`${experiment.id}|${file.token}`}
              experiment={experiment}
              view={view}
            />
          )}
        </section>
      )}
    </details>
  );
}
