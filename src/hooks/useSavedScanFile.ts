import { useRef, useState } from 'react';
import { checkSavedScanFileAsync } from '@/lib/financeClient';
import { SAVED_SCAN_FILE_MAX_BYTES, tooLarge, type SavedScanFileCheck } from '@/lib/savedScanFile';

/**
 * The file the owner opened in Research, as far as its check has got. `token` names this one
 * opening: a check that answers after the file was replaced or closed has a stale token and is
 * dropped, and every opening starts a fresh review (no selection, scenario or draft carries).
 */
export type OpenedFile = { token: number; name: string; size: number } & (
  | { phase: 'checking' }
  | { phase: 'checked'; check: SavedScanFileCheck }
  | { phase: 'failed'; message: string }
);

/**
 * One opened file at a time, held in this component's memory only: never uploaded, cached or
 * written to browser storage. Opening another replaces it at once, so a refused replacement
 * never leaves the earlier file on screen; closing drops it.
 */
export function useSavedScanFile() {
  const current = useRef(0);
  const [file, setFile] = useState<OpenedFile | null>(null);
  const open = (chosen: File) => {
    current.current += 1;
    const token = current.current;
    const opened = { token, name: chosen.name, size: chosen.size };
    // Refused from its size alone: nothing is read.
    if (chosen.size > SAVED_SCAN_FILE_MAX_BYTES) {
      setFile({ ...opened, phase: 'checked', check: tooLarge(chosen.size) });
      return;
    }
    setFile({ ...opened, phase: 'checking' });
    const settle = (next: OpenedFile) => {
      if (current.current === token) setFile(next);
    };
    chosen
      .arrayBuffer()
      .then(checkSavedScanFileAsync)
      .then(
        (check) => settle({ ...opened, phase: 'checked', check }),
        (error: unknown) =>
          settle({
            ...opened,
            phase: 'failed',
            message: error instanceof Error ? error.message : String(error),
          }),
      );
  };
  const close = () => {
    current.current += 1;
    setFile(null);
  };
  return { file, open, close };
}
