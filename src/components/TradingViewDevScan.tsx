import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Radar, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { Segmented } from '@/components/Segmented';
import { Button } from '@/components/ui/button';
import { compareScans } from '@/lib/scanChanges';
import { UTC_TIME } from '@/lib/scanReview';
import {
  parseSavedScanList,
  parseSavedScanRead,
  parseTradingViewDevScan,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_SAVED_SCANS_ROUTE,
  type SavedScanEntry,
  type SavedScanList,
  type SavedScanRead,
  type TradingViewDevScan as DevScan,
  type TradingViewSavedScan,
} from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

type DevScanQuery = UseQueryResult<DevScan | null>;
type SavedScanQuery = UseQueryResult<SavedScanRead | null>;

const READ_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The section's frame while there is no scan to show, so it is never mistaken for the Market scan. */
function DevScanState({
  busy = false,
  alert = false,
  children,
}: Readonly<{ busy?: boolean; alert?: boolean; children: ReactNode }>) {
  return (
    <section
      className="market-scan market-scan-devscan"
      aria-label="TradingView development scan"
      aria-busy={busy}
    >
      <div className="market-scan-head">
        <span className="market-scan-title">
          <Radar size={14} /> TradingView development scan
        </span>
      </div>
      <p role={alert ? 'alert' : undefined} className="market-scan-empty">
        {children}
      </p>
    </section>
  );
}

/** One local read: 404 is "none", anything else that is not JSON the parser accepts is an error. */
async function readLocal<T>(url: string, parse: (raw: unknown) => T): Promise<T | null> {
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const raw: unknown = await response.json().catch(() => {
    throw new Error('The file is not valid JSON.');
  });
  return parse(raw);
}

/** Local files only change on request: read once, then only when Reload asks. */
const LOCAL_FILE = {
  enabled: import.meta.env.DEV,
  // Not Infinity: a failed reload marks the kept snapshot invalidated, and an invalidated
  // query re-reads on focus, reconnect or remount. 'static' never re-reads by itself.
  staleTime: 'static',
  retryOnMount: false,
  retry: false,
} as const;

/**
 * The local import, shared by the picker and the review: entering the review never
 * re-reads it, so both always show the same state. Only "Reload local scan" (or a page
 * reload) re-reads the file; nothing here fetches bars or polls.
 */
function useTradingViewDevScan() {
  return useQuery({
    queryKey: ['tradingview-dev-scan'],
    queryFn: () => readLocal(TRADINGVIEW_DEV_SCAN_ROUTE, parseTradingViewDevScan),
    ...LOCAL_FILE,
  });
}

function useSavedScanList() {
  return useQuery({
    queryKey: ['tradingview-saved-scans'],
    queryFn: () => readLocal(TRADINGVIEW_SAVED_SCANS_ROUTE, parseSavedScanList),
    ...LOCAL_FILE,
  });
}

/**
 * One saved scan, keyed by its ID: an answer for another selection is never shown for this
 * one. Not cancelled when the selection moves on, so choosing it again joins the same read.
 */
function useSavedScan(scanId: string | null) {
  return useQuery({
    queryKey: ['tradingview-saved-scan', scanId],
    queryFn: () =>
      readLocal(
        `${TRADINGVIEW_SAVED_SCANS_ROUTE}/${encodeURIComponent(scanId ?? '')}`,
        parseSavedScanRead,
      ),
    ...LOCAL_FILE,
    enabled: import.meta.env.DEV && scanId !== null,
  });
}

/**
 * Re-reads what is on screen, on request only: the published file, or the selected saved
 * scan (checked again), never TradingView, an agent or a scan, and never the other one. A
 * click during a read joins it. After a failed read the earlier state stays on screen, named.
 */
function ReloadLocalScan({
  query,
  shown,
  saved,
  onReload,
}: Readonly<{
  query: UseQueryResult<unknown>;
  shown: { scanId: string; importedAt?: string } | undefined;
  saved: boolean;
  onReload: () => void;
}>) {
  const reading = query.isFetching;
  let status: ReactNode = null;
  // The first read has its own message in the panel below.
  if (reading) status = query.isPending ? null : 'Reading the local file…';
  else if (shown && !query.isError) {
    status = (
      <>
        {saved ? 'Saved scan' : 'Scan'} <code>{shown.scanId}</code> · local file read{' '}
        {READ_TIME.format(query.dataUpdatedAt)} UTC
      </>
    );
  }
  const imported = shown?.importedAt
    ? `, imported ${UTC_TIME.format(Date.parse(shown.importedAt))} UTC`
    : '';
  return (
    <>
      <Button type="button" variant="outline" size="sm" aria-disabled={reading} onClick={onReload}>
        <RefreshCw className={cn(reading && 'animate-spin')} aria-hidden="true" />
        {saved ? 'Reload saved scan' : 'Reload local scan'}
      </Button>
      <p className="devscan-reload-status" role="status">
        {status}
      </p>
      {!reading && query.isError && shown && (
        <p className="devscan-reload-failed" role="alert">
          Reload failed ({(query.error as Error).message}). Still showing{' '}
          {saved ? 'saved scan' : 'scan'} <code>{shown.scanId}</code>
          {imported};{' '}
          {saved ? 'the stored file may have changed since.' : 'it may not be the published scan.'}
        </p>
      )}
    </>
  );
}

function savedLabel(entry: SavedScanEntry, published: boolean): string {
  const count = (value: number | null) => value ?? '?';
  const crypto = entry.assetClasses?.length === 1 && entry.assetClasses[0] === 'crypto';
  const day = crypto ? 'UTC day' : 'session';
  return [
    entry.scanId,
    entry.session ? `${entry.session} ${day}` : 'no evaluated session',
    `${count(entry.members)} ${crypto ? 'crypto pairs' : 'members'}`,
    `${count(entry.evaluated)} of ${count(entry.supported)} evaluated`,
    entry.legacy && 'legacy',
    published && 'published',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Which scan the review shows: the latest published one, or a saved snapshot from the
 * scan store. Choosing one reads it; nothing is copied, published or replaced.
 */
function ScanShown({
  list,
  selected,
  published,
  onSelect,
}: Readonly<{
  list: UseQueryResult<SavedScanList | null>;
  selected: string | null;
  published: string | undefined;
  onSelect: (scanId: string | null) => void;
}>) {
  const scans = list.data?.scans ?? [];
  // A selection that left the store stays selected, and says so, until the owner changes it.
  const gone = scans.some((entry) => entry.scanId === selected) ? null : selected;
  return (
    <label className="devscan-shown">
      <span>Scan shown</span>
      <select
        className="portfolio-cash-input"
        name="scan-shown"
        value={selected ?? ''}
        onChange={(event) => onSelect(event.target.value || null)}
      >
        <option value="">Latest published scan</option>
        {(scans.length > 0 || gone !== null) && (
          <optgroup label="Saved scans">
            {gone && <option value={gone}>{gone} · not in the scan store</option>}
            {scans.map((entry) => (
              <option key={entry.scanId} value={entry.scanId}>
                {savedLabel(entry, entry.scanId === published)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/** What the list could not include, on a line of its own under the controls. */
function SavedListNotes({ list }: Readonly<{ list: UseQueryResult<SavedScanList | null> }>) {
  const unreadable = list.data?.unreadable ?? 0;
  return (
    <>
      {list.isError && (
        <p className="devscan-reload-failed" role="alert">
          Saved scans could not be listed ({list.error.message}).
        </p>
      )}
      {unreadable > 0 && (
        <p className="devscan-list-note">
          {unreadable === 1
            ? '1 snapshot file could not be read and is not listed.'
            : `${unreadable} snapshot files could not be read and are not listed.`}
        </p>
      )}
    </>
  );
}

function DevScanContent({ query }: Readonly<{ query: DevScanQuery }>) {
  if (query.isPending) {
    return <DevScanState busy>Reading the local TradingView import…</DevScanState>;
  }
  const view = query.data;
  if (view) {
    const { scanId, importedAt, scan, source, baseline } = view;
    // A different snapshot starts the review over: no selection, comparison or open
    // evidence carries across. An identical reload keeps the same key and the review.
    return (
      <MarketScanSummary
        key={`${scanId}|${importedAt}|${baseline?.scanId ?? ''}`}
        scan={scan}
        completedAt={Date.parse(importedAt)}
        scanning={false}
        failed={false}
        source={source}
        scanId={scanId}
        changes={compareScans(view, baseline)}
        choice={view}
      />
    );
  }
  if (query.isError) {
    return (
      <DevScanState alert>
        The TradingView development scan could not be read ({query.error.message}). Re-run{' '}
        <code>npm run evaluate -- tradingview-import</code>.
      </DevScanState>
    );
  }
  return (
    <DevScanState>
      No TradingView scan is published on this machine (the local view file is missing), and the
      Market scan does not include one. The owner&rsquo;s agent session retrieves the bars; then{' '}
      <code>npm run evaluate -- tradingview-import</code> scores them (owner runbook in
      docs/MARKET_SCANNER.md).
    </DevScanState>
  );
}

const REFUSED: Record<Exclude<SavedScanRead, { state: 'VERIFIED' }>['state'], string> = {
  MALFORMED: 'is malformed',
  INCOMPATIBLE: 'cannot be checked by this checkout',
  NOT_REPRODUCED: 'does not reproduce offline from its own inputs',
};

const RECORDED: Record<string, string> = {
  published: 'Source and comparison as recorded in the published view of this scan.',
  preserved: 'Source and comparison as recorded in the preserved view of this scan.',
  none: 'Only its snapshot is kept: no retrieval window, notice, selection rule, alert check or comparison was recorded with it, and none is filled in.',
};

function SavedNote({ scanId, saved }: Readonly<{ scanId: string; saved: TradingViewSavedScan }>) {
  return (
    <p className="devscan-saved">
      Saved scan <code>{scanId}</code>, not the published view. It reproduced offline from its own
      inputs, recorded at commit <code>{saved.repositoryCommit.slice(0, 7)}</code>.{' '}
      {RECORDED[saved.view ?? 'none']}
      {saved.legacy &&
        ' Legacy evidence: recorded before exact TradingView symbols were kept, so it names none and is never a baseline.'}
    </p>
  );
}

/** A selected saved scan: shown only once it reproduces; every other state says why not. */
function SavedScanContent({ scanId, query }: Readonly<{ scanId: string; query: SavedScanQuery }>) {
  if (query.isPending) {
    return (
      <DevScanState busy>
        Reading saved scan <code>{scanId}</code> and reproducing it offline…
      </DevScanState>
    );
  }
  const read = query.data;
  if (read?.state === 'VERIFIED') {
    const { view } = read;
    return (
      <>
        {view.saved && <SavedNote scanId={view.scanId} saved={view.saved} />}
        <MarketScanSummary
          key={`saved|${view.scanId}|${view.importedAt}|${view.baseline?.scanId ?? ''}`}
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
    );
  }
  if (read) {
    return (
      <DevScanState alert>
        Saved scan <code>{scanId}</code> {REFUSED[read.state]} ({read.reason}). Nothing from it is
        shown.
      </DevScanState>
    );
  }
  if (query.isError) {
    return (
      <DevScanState alert>
        Saved scan <code>{scanId}</code> could not be read ({query.error.message}).
      </DevScanState>
    );
  }
  return (
    <DevScanState alert>
      Saved scan <code>{scanId}</code> is no longer a TradingView snapshot in the scan store.
      Nothing from it is shown.
    </DevScanState>
  );
}

function shownScan(read: SavedScanRead | null | undefined) {
  if (!read) return undefined;
  return read.state === 'VERIFIED' ? read.view : { scanId: read.scanId };
}

/**
 * The local TradingView development scan, under `vite dev` only: the latest
 * published view, or a saved scan the owner selects. Loading, nothing published
 * and an unreadable file each say so; a partial scan is never shown from a
 * malformed file, and a saved one only after it reproduces.
 */
export function TradingViewDevScan() {
  const published = useTradingViewDevScan();
  const list = useSavedScanList();
  const [selected, setSelected] = useState<string | null>(null);
  const saved = useSavedScan(selected);
  const reload = () => {
    void list.refetch({ cancelRefetch: false });
    void (selected === null ? published : saved).refetch({ cancelRefetch: false });
  };
  return (
    <>
      <div className="devscan-reload">
        <ScanShown
          list={list}
          selected={selected}
          published={published.data?.scanId}
          onSelect={setSelected}
        />
        <ReloadLocalScan
          query={selected === null ? published : saved}
          shown={selected === null ? (published.data ?? undefined) : shownScan(saved.data)}
          saved={selected !== null}
          onReload={reload}
        />
        <SavedListNotes list={list} />
      </div>
      {selected === null ? (
        <DevScanContent query={published} />
      ) : (
        <SavedScanContent scanId={selected} query={saved} />
      )}
    </>
  );
}

export type MarketsSource = 'market-data' | 'tradingview';

/**
 * Which source the scan reviews, under `vite dev` only. Research renders one
 * source's review at a time; switching unmounts the other, so no selection,
 * explanation or comparison carries across.
 */
export function MarketsSourcePicker({
  source,
  onSource,
}: Readonly<{ source: MarketsSource; onSource: (source: MarketsSource) => void }>) {
  const query = useTradingViewDevScan();
  let state = 'None';
  if (query.isPending) state = 'Loading';
  else if (query.isFetching) state = 'Reloading';
  // Short enough for the picker at phone width; the alert above the review names the failure.
  else if (query.isError) state = query.data ? 'Failed' : 'Unreadable';
  else if (query.data) state = String(query.data.scan.coverage.evaluated);
  return (
    <Segmented
      value={source}
      ariaLabel="Markets source"
      className="scan-views markets-source"
      onChange={onSource}
      options={[
        { value: 'market-data', label: 'Market data' },
        {
          value: 'tradingview',
          label: (
            <>
              TradingView import <span className="segment-tag">{state}</span>
            </>
          ),
        },
      ]}
    />
  );
}
