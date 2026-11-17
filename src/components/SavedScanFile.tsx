import { FileUp, X } from 'lucide-react';
import { useId, useRef, type RefObject } from 'react';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { Button } from '@/components/ui/button';
import type { OpenedFile } from '@/hooks/useSavedScanFile';
import {
  megabytes,
  SAVED_SCAN_FILE_LIMIT_LABEL,
  type SavedScanFileCheck,
  type SavedScanFileRefusal,
} from '@/lib/savedScanFile';
import { compareScans } from '@/lib/scanChanges';
import { UTC_TIME } from '@/lib/scanReview';

/**
 * The entry point: one button, and the limit stated before anything is chosen. Research's is the
 * product tour's target; Account's experiment review names its own purpose.
 */
export function OpenSavedScanFile({
  onOpen,
  buttonRef,
  label = 'Open saved crypto scan',
  tour = false,
}: Readonly<{
  onOpen: (file: File) => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  label?: string;
  tour?: boolean;
}>) {
  const noteId = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="saved-file-open" data-tour={tour ? 'open-saved-scan' : undefined}>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        aria-describedby={noteId}
        onClick={() => input.current?.click()}
      >
        <FileUp aria-hidden="true" /> {label}
      </Button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        // Cleared after each choice, so choosing the same file again checks it again.
        onChange={(event) => {
          const chosen = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (chosen) onOpen(chosen);
        }}
      />
      <p id={noteId} className="saved-file-limit">
        One TradingView crypto snapshot (<code>&lt;scan ID&gt;.json</code>, up to{' '}
        {SAVED_SCAN_FILE_LIMIT_LABEL}), checked in this browser. Nothing is uploaded or fetched.
      </p>
    </div>
  );
}

const REFUSED: Record<SavedScanFileRefusal, string> = {
  TOO_LARGE: 'is too large to open',
  MALFORMED: 'is not a readable market-scan snapshot',
  UNSUPPORTED: 'is not a TradingView crypto snapshot this can open',
  INCOMPATIBLE: 'cannot be checked by this version of Popup',
  NOT_REPRODUCED: 'does not reproduce from its own inputs',
};

/** Why nothing from the file is shown. */
function Refused({ file, check }: Readonly<{ file: OpenedFile; check: SavedScanFileCheck }>) {
  if (check.state === 'VERIFIED') return null;
  return (
    <p className="devscan-reload-failed" role="alert">
      <code>{file.name}</code> {REFUSED[check.state]}
      {check.scanId && (
        <>
          {' '}
          (scan <code>{check.scanId}</code>)
        </>
      )}
      : {check.reason}. Nothing from it is shown, and nothing can be recorded from it.
    </p>
  );
}

/** How far the check of an opened file has got, or why nothing from it is shown. */
export function SavedScanFileCheckState({ file }: Readonly<{ file: OpenedFile }>) {
  const check = file.phase === 'checked' ? file.check : null;
  return (
    <>
      {file.phase === 'checking' && (
        <output className="saved-file-state" aria-busy="true">
          Checking in this browser: hashing the file&rsquo;s bytes and reproducing the scan from its
          own inputs. Nothing is uploaded, fetched or saved.
        </output>
      )}
      {file.phase === 'failed' && (
        <p className="devscan-reload-failed" role="alert">
          <code>{file.name}</code> could not be checked ({file.message}). Nothing from it is shown.
        </p>
      )}
      {check && <Refused file={file} check={check} />}
    </>
  );
}

/**
 * The opened file in place of the Research scan: its check, then, only once it reproduced, the
 * existing scan review with what the snapshot alone records. Close returns to the scan.
 */
export function SavedScanFileView({
  file,
  onClose,
}: Readonly<{ file: OpenedFile; onClose: () => void }>) {
  const check = file.phase === 'checked' ? file.check : null;
  const view = check?.state === 'VERIFIED' ? check.view : null;
  return (
    <section className="saved-file" aria-label="Saved crypto scan file">
      <div className="saved-file-head">
        <p>
          <strong>Historical file you opened</strong>, not a live scan: <code>{file.name}</code> ·{' '}
          {megabytes(file.size)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          <X aria-hidden="true" /> Close file
        </Button>
      </div>
      <SavedScanFileCheckState file={file} />
      {view?.saved && (
        <>
          <output className="devscan-saved saved-file-note">
            Scan <code>{view.scanId}</code>, recorded at commit{' '}
            <code>{view.saved.repositoryCommit.slice(0, 7)}</code>. It reproduced in this browser
            from its own inputs: evaluation time, universe and input hashes, and every result match.
            That shows the file is internally consistent, not that it is authentic: nothing signs
            it. File SHA-256{' '}
            <code title={view.saved.snapshotSha256}>{view.saved.snapshotSha256.slice(0, 12)}…</code>{' '}
            names these bytes only. Opening it fetched no market data and ran no new scan: it
            describes the scan&rsquo;s cutoff, {UTC_TIME.format(view.scan.evaluationTime)} UTC, not
            the market now. Only its snapshot is kept: no retrieval window, notice, selection rule,
            alert check or comparison was recorded with it, and none is filled in.
          </output>
          <MarketScanSummary
            // A new opening, even of the same bytes, starts the review over.
            key={`file|${file.token}|${view.saved.snapshotSha256}`}
            scan={view.scan}
            completedAt={Date.parse(view.importedAt)}
            scanning={false}
            failed={false}
            source={view.source}
            scanId={view.scanId}
            changes={compareScans(view, view.baseline)}
            choice={view}
          />
        </>
      )}
    </section>
  );
}
