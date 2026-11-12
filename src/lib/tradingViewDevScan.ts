/**
 * The TradingView development scan as the Markets page shows it: one local,
 * owner-initiated scan whose daily bars the owner's agent session retrieved
 * through TradingView's MCP server (`get_ohlcv`), scored here by the canonical
 * engine (`npm run evaluate -- tradingview-import`, scripts/tradingViewImport.ts).
 *
 * The app never calls TradingView. The Vite dev server alone serves this file
 * from the git-ignored scan store to the local machine
 * (scripts/tradingViewDevRoute.ts, loaded by vite.config.ts); a
 * production build has neither the route nor the file.
 */
import type { MarketScan } from '@/lib/marketScanner';

export const TRADINGVIEW_DEV_SCAN_KIND = 'tradingview-dev-scan' as const;
export const TRADINGVIEW_DEV_PROVIDER_ID = 'tradingview-mcp-get_ohlcv';
export const TRADINGVIEW_DEV_UNIVERSE_SOURCE = 'tradingview-dev-scan';
/** The dev-server route, and the file it serves from `.zerochart-scans/`. */
export const TRADINGVIEW_DEV_SCAN_ROUTE = '/__zerochart/tradingview-dev-scan';
export const TRADINGVIEW_DEV_SCAN_FILE = 'tradingview-dev-scan.json';
/**
 * The dev-server route listing the TradingView snapshots saved in the same store, and
 * `/<scanId>` under it reading one back. Read-only: it never writes, publishes or copies.
 */
export const TRADINGVIEW_SAVED_SCANS_ROUTE = '/__zerochart/tradingview-saved-scans';
/** A snapshot's scan ID, and so its file name: the only thing the saved-scan route accepts. */
export const SCAN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/**
 * A short digest of a view as read (FNV-1a over its JSON). The review is keyed by it, so a
 * re-read whose content changed starts over, Manual Spot inputs included, even under the same
 * scan ID; an identical re-read keeps the key and the review. Not a security hash.
 */
// ponytail: 32-bit, so two different reads of one view collide about 1 in 4 billion; widen if that matters.
export function contentKey(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Where the bars came from, as the agent recorded it. Times are ISO strings. */
export interface TradingViewDevSource {
  tool: 'get_ohlcv';
  interval: '1D';
  /** Null only with `snapshotOnly`, as are `notice` and `selectionRule`: never recorded there. */
  retrieval: { startedAt: string; completedAt: string } | null;
  /**
   * Ticker → exact exchange-qualified TradingView symbol requested, as the scan's inputs
   * recorded it. Views written before inputs recorded it hold the instrument map at import
   * time: unverified, and never the evidence (each result's `providerSymbol` is).
   */
  symbols: Readonly<Record<string, string>>;
  /** TradingView's own market-data notice, verbatim (adjustment, session, delay). */
  notice: string | null;
  /** How the members were chosen, before any score was seen. */
  selectionRule: string | null;
  /** Symbols holding any TradingView alert when the agent checked; null when not checked. */
  pineAlerts: { checkedAt: string; symbols: readonly string[] } | null;
  /**
   * A saved snapshot shown without a view of it: the snapshot records no retrieval window,
   * notice, selection rule or alert check, so those are null, never filled in from today.
   */
  snapshotOnly?: true;
}

export type BaselineChooser = 'tradingview-finish' | 'tradingview-baseline';

/**
 * The earlier snapshot "Changes since previous scan" compares with: a
 * TradingView development import from the same scan store. `tradingview-finish`
 * chooses one; the owner can name another (`npm run evaluate --
 * tradingview-baseline SCAN_ID`). Importing a scan replaces the view and drops it.
 */
export interface TradingViewDevBaseline {
  scanId: string;
  importedAt: string;
  scan: MarketScan;
  /** Absent in files written before `tradingview-finish` chose baselines: the owner named those. */
  chosenBy?: BaselineChooser;
}

/** How `tradingview-finish` looked for a baseline. */
export interface TradingViewDevBaselineSearch {
  /** Why nothing is compared; null when a baseline was chosen. */
  reason: string | null;
  /** Imports passed over before the choice, most recent first, and why. */
  skipped: ReadonlyArray<{ scanId: string; reason: string }>;
}

/** How a saved scan was read back; set only by the saved-scan route, never in a published file. */
export interface TradingViewSavedScan {
  /** The checkout that recorded the snapshot. */
  repositoryCommit: string;
  /** Recorded before inputs kept exact symbols: it reproduces and displays, never a baseline. */
  legacy: boolean;
  /** The recorded view that supplied source and comparison, or null when only the snapshot exists. */
  view: 'published' | 'preserved' | null;
}

export interface TradingViewDevScan {
  kind: typeof TRADINGVIEW_DEV_SCAN_KIND;
  scanId: string;
  importedAt: string;
  source: TradingViewDevSource;
  scan: MarketScan;
  baseline?: TradingViewDevBaseline;
  baselineSearch?: TradingViewDevBaselineSearch;
  /** A saved scan read back offline after it reproduced; absent for the published view. */
  saved?: TradingViewSavedScan;
}

/** One saved TradingView snapshot as the selector lists it; null where the file does not say. */
export interface SavedScanEntry {
  scanId: string;
  /** The latest New York session it evaluated. */
  session: string | null;
  members: number | null;
  evaluated: number | null;
  supported: number | null;
  legacy: boolean;
  /** The asset classes its cohorts scanned; absent where the file does not say. */
  assetClasses?: readonly string[];
}

export interface SavedScanList {
  /** Newest first. */
  scans: SavedScanEntry[];
  /** Snapshot-named files that could not be read, so whether they are TradingView imports is unknown. */
  unreadable: number;
}

/**
 * One saved scan read back. Only `VERIFIED` (reproduced offline) carries results; every
 * other state names the scan and why nothing from it is shown.
 */
export type SavedScanRead =
  | { state: 'VERIFIED'; view: TradingViewDevScan }
  | { state: 'MALFORMED' | 'INCOMPATIBLE' | 'NOT_REPRODUCED'; scanId: string; reason: string };

function isScan(scan: Partial<MarketScan> | undefined): boolean {
  return Array.isArray(scan?.results) && Array.isArray(scan.cohorts);
}

function isBaseline(baseline: Partial<TradingViewDevBaseline> | undefined): boolean {
  return (
    baseline === undefined ||
    (typeof baseline?.scanId === 'string' &&
      typeof baseline.importedAt === 'string' &&
      isScan(baseline.scan) &&
      [undefined, 'tradingview-finish', 'tradingview-baseline'].includes(baseline.chosenBy))
  );
}

function isSearch(search: Partial<TradingViewDevBaselineSearch> | undefined): boolean {
  return (
    search === undefined ||
    ((search?.reason === null || typeof search?.reason === 'string') &&
      Array.isArray(search.skipped) &&
      search.skipped.every(
        (item) => typeof item?.scanId === 'string' && typeof item.reason === 'string',
      ))
  );
}

/** A string, or null when the source says it is a snapshot that never recorded one. */
function isRecorded(source: Partial<TradingViewDevSource>, value: unknown): boolean {
  return typeof value === 'string' || (source.snapshotOnly === true && value === null);
}

function isSaved(saved: Partial<TradingViewSavedScan> | undefined): boolean {
  return (
    saved === undefined ||
    (typeof saved?.repositoryCommit === 'string' &&
      typeof saved.legacy === 'boolean' &&
      (saved.view === null || saved.view === 'published' || saved.view === 'preserved'))
  );
}

/** Shape check at the dev-server boundary: a malformed file is an error, never a partial panel. */
export function parseTradingViewDevScan(raw: unknown): TradingViewDevScan {
  const value = raw as Partial<TradingViewDevScan> | null;
  const source = value?.source;
  if (
    value?.kind !== TRADINGVIEW_DEV_SCAN_KIND ||
    typeof value.scanId !== 'string' ||
    typeof value.importedAt !== 'string' ||
    !source ||
    !isRecorded(source, source.notice) ||
    !isRecorded(source, source.selectionRule) ||
    !(source.snapshotOnly === true ? source.retrieval === null : source.retrieval) ||
    typeof source.symbols !== 'object' ||
    !isScan(value.scan) ||
    !isBaseline(value.baseline) ||
    !isSearch(value.baselineSearch) ||
    !isSaved(value.saved)
  ) {
    throw new Error('Not a TradingView development scan file.');
  }
  return value as TradingViewDevScan;
}

const isCount = (value: unknown) => value === null || Number.isInteger(value);

/** The saved-scan list at the dev-server boundary. */
export function parseSavedScanList(raw: unknown): SavedScanList {
  const value = raw as Partial<SavedScanList> | null;
  const valid =
    Array.isArray(value?.scans) &&
    Number.isInteger(value.unreadable) &&
    value.scans.every(
      (entry: Partial<SavedScanEntry> | null) =>
        typeof entry?.scanId === 'string' &&
        SCAN_ID.test(entry.scanId) &&
        (entry.session === null || typeof entry.session === 'string') &&
        isCount(entry.members) &&
        isCount(entry.evaluated) &&
        isCount(entry.supported) &&
        typeof entry.legacy === 'boolean' &&
        (entry.assetClasses === undefined ||
          (Array.isArray(entry.assetClasses) &&
            entry.assetClasses.every((item) => typeof item === 'string'))),
    );
  if (!valid) throw new Error('Not a saved TradingView scan list.');
  return value as SavedScanList;
}

/** One saved scan at the dev-server boundary; a verified one must carry its read-back record. */
export function parseSavedScanRead(raw: unknown): SavedScanRead {
  const value = raw as { state?: unknown; view?: unknown; scanId?: unknown; reason?: unknown };
  if (value?.state === 'VERIFIED') {
    const view = parseTradingViewDevScan(value.view);
    if (view.saved) return { state: 'VERIFIED', view };
  } else if (
    (value?.state === 'MALFORMED' ||
      value?.state === 'INCOMPATIBLE' ||
      value?.state === 'NOT_REPRODUCED') &&
    typeof value.scanId === 'string' &&
    typeof value.reason === 'string'
  ) {
    return { state: value.state, scanId: value.scanId, reason: value.reason };
  }
  throw new Error('Not a saved TradingView scan.');
}
