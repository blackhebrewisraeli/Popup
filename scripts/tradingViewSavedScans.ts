import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CANONICAL_MODEL_VERSION } from '@/lib/canonicalModel';
import { SCANNER_VERSION } from '@/lib/marketScanner';
import { latestSession } from '@/lib/scanChanges';
import {
  parseTradingViewDevScan,
  SCAN_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type SavedScanEntry,
  type SavedScanList,
  type SavedScanRead,
  type TradingViewDevScan,
  type TradingViewSavedScan,
} from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import { snapshotMismatchReason, type ScanSnapshot } from './marketScanStore';

/**
 * Saved TradingView scans read back for local Research (served by
 * scripts/tradingViewDevRoute.ts under `vite dev` only). Read-only: listing or
 * reading never writes, publishes, copies or re-derives a file. A scan is shown
 * only after it reproduces offline, and only with what was recorded for it: its
 * snapshot, plus the source and comparison of a published or preserved view of
 * exactly that scan. Nothing missing is filled in from today's instrument map.
 */

const SNAPSHOT_FILE = /^(\d{8}T\d{6}Z-[0-9a-f]{8})\.json$/;
/** `preserveOtherUniverseView`'s copies: `tradingview-dev-scan.<scanId>.<sha256 prefix>.json`. */
const PRESERVED_VIEW = /^tradingview-dev-scan\.(\d{8}T\d{6}Z-[0-9a-f]{8})\.[0-9a-f]{12}\.json$/;
/**
 * O_NOFOLLOW: a symbolic link in the store reads as absent, wherever it points. O_NONBLOCK: a
 * FIFO named like a snapshot cannot stall the dev server; it is then refused as not a file.
 */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** One regular file directly in the store, by a name a pattern above matched; null otherwise. */
async function readStoreFile(
  store: string,
  name: string,
): Promise<{ text: string; sha256: string; modified: number } | null> {
  let handle;
  try {
    handle = await open(join(resolve(store), name), READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    // Hashed and parsed from the same read, so the hash names exactly the bytes that were checked.
    const bytes = await handle.readFile();
    return {
      text: bytes.toString('utf8'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      modified: stats.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

type RawSnapshot = Partial<ScanSnapshot> & { scan?: Partial<ScanSnapshot['scan']> };

/** Parsed JSON that says it is a TradingView development import; null for anything else. */
function asTradingView(value: unknown): RawSnapshot | null {
  const raw = value as RawSnapshot | null;
  return raw?.scan?.universe?.source === TRADINGVIEW_DEV_UNIVERSE_SOURCE ? raw : null;
}

const isLegacy = (raw: RawSnapshot) =>
  !(Array.isArray(raw.inputs) && raw.inputs.some((input) => input?.providerSymbol));

function entry(scanId: string, raw: RawSnapshot): SavedScanEntry {
  const count = (value: unknown) => (Number.isInteger(value) ? (value as number) : null);
  const { scan } = raw;
  let session: string | null = null;
  try {
    session = latestSession(scan as ScanSnapshot['scan']);
  } catch {
    // Malformed cohorts: listed without a session; reading it names the problem.
  }
  const classes = Array.isArray(scan?.cohorts)
    ? scan.cohorts.flatMap((cohort) =>
        typeof cohort?.assetClass === 'string' ? [cohort.assetClass] : [],
      )
    : [];
  return {
    scanId,
    session,
    members: Array.isArray(scan?.universe?.members) ? scan.universe.members.length : null,
    evaluated: count(scan?.coverage?.evaluated),
    supported: count(scan?.coverage?.supported),
    legacy: isLegacy(raw),
    ...(classes.length > 0 && { assetClasses: [...new Set(classes)] }),
  };
}

/**
 * Every TradingView snapshot directly in the store, newest first. Other snapshots
 * (the crypto Market scan) are left out; a snapshot-named file that is not JSON is
 * only counted, since what it holds is unknown. Views and links are never listed.
 */
export async function listSavedScans(store: string): Promise<SavedScanList> {
  let names: string[];
  try {
    const entries = await readdir(resolve(store), { withFileTypes: true });
    names = entries.filter((item) => item.isFile()).map((item) => item.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scans: [], unreadable: 0 };
    throw error;
  }
  // ponytail: parses every snapshot on each list; keep an index once the store holds hundreds.
  const read = await Promise.all(
    names.flatMap((name) => {
      const scanId = SNAPSHOT_FILE.exec(name)?.[1];
      return scanId ? [readStoreFile(store, name).then((file) => ({ scanId, file }))] : [];
    }),
  );
  const scans: SavedScanEntry[] = [];
  let unreadable = 0;
  for (const { scanId, file } of read) {
    if (!file) continue; // Replaced by a link or removed since the directory was read.
    let raw: RawSnapshot | null;
    try {
      raw = asTradingView(JSON.parse(file.text));
    } catch {
      unreadable += 1;
      continue;
    }
    if (raw) scans.push(entry(scanId, raw));
  }
  scans.sort((a, b) => (a.scanId < b.scanId ? 1 : -1));
  return { scans, unreadable };
}

type Refused = Exclude<SavedScanRead, { state: 'VERIFIED' }>;
type Checked =
  { state: 'VERIFIED'; snapshot: ScanSnapshot; legacy: boolean; sha256: string } | Refused;

/** Reads one TradingView snapshot and reproduces it offline; null when absent, a link, or not one. */
async function checkSnapshot(store: string, scanId: string): Promise<Checked | null> {
  if (!SCAN_ID.test(scanId)) return null;
  const file = await readStoreFile(store, `${scanId}.json`);
  if (!file) return null;
  const refuse = (state: Refused['state'], reason: string): Refused => ({ state, scanId, reason });
  let raw: RawSnapshot | null;
  try {
    raw = asTradingView(JSON.parse(file.text));
  } catch {
    return refuse('MALFORMED', 'the file is not valid JSON');
  }
  if (!raw) return null;
  if (raw.schemaVersion !== '1') {
    return refuse('INCOMPATIBLE', `snapshot schema ${String(raw.schemaVersion)}, not 1`);
  }
  if (raw.evidenceType !== 'market-scan' || raw.scanId !== scanId) {
    return refuse('MALFORMED', 'the file does not record this scan as a market-scan snapshot');
  }
  const snapshot = raw as ScanSnapshot;
  let reason: ReturnType<typeof snapshotMismatchReason>;
  try {
    reason = snapshotMismatchReason(snapshot);
  } catch (error) {
    return refuse('MALFORMED', `its inputs cannot be scored (${(error as Error).message})`);
  }
  if (reason === null) {
    return { state: 'VERIFIED', snapshot, legacy: isLegacy(raw), sha256: file.sha256 };
  }
  if (reason === 'SNAPSHOT_METADATA_MISMATCH') {
    return refuse('MALFORMED', 'required snapshot fields are missing or invalid');
  }
  if (reason === 'UNSUPPORTED_VERSION') {
    return refuse(
      'INCOMPATIBLE',
      `recorded with scanner ${String(snapshot.scan.scannerVersion)} and model ${String(snapshot.scan.modelVersion)}; this checkout runs ${SCANNER_VERSION} and ${CANONICAL_MODEL_VERSION}`,
    );
  }
  return refuse('NOT_REPRODUCED', reason);
}

/**
 * The published view, else the newest preserved copy, that shows exactly this snapshot's
 * scan. A view of another scan, or of an edited one, is never borrowed from.
 */
async function recordedView(
  store: string,
  snapshot: ScanSnapshot,
): Promise<{ view: TradingViewDevScan; kind: 'published' | 'preserved' } | null> {
  const names = await readdir(resolve(store));
  const preserved = await Promise.all(
    names
      .filter((name) => PRESERVED_VIEW.exec(name)?.[1] === snapshot.scanId)
      .map((name) => readStoreFile(store, name)),
  );
  const published = await readStoreFile(store, TRADINGVIEW_DEV_SCAN_FILE);
  const files = [
    ...(published ? [{ kind: 'published' as const, ...published }] : []),
    ...preserved
      .flatMap((file) => (file ? [{ kind: 'preserved' as const, ...file }] : []))
      .sort((a, b) => b.modified - a.modified),
  ];
  const scan = stableSerialize(snapshot.scan);
  for (const { kind, text } of files) {
    try {
      const view = parseTradingViewDevScan(JSON.parse(text));
      if (view.scanId === snapshot.scanId && stableSerialize(view.scan) === scan) {
        return { view, kind };
      }
    } catch {
      // Not a readable view: it records nothing for this scan.
    }
  }
  return null;
}

/** The view's recorded baseline, kept only while it is still the stored snapshot and reproduces. */
async function checkedComparison(
  store: string,
  view: TradingViewDevScan,
): Promise<Pick<TradingViewDevScan, 'baseline' | 'baselineSearch'>> {
  const { baseline, baselineSearch } = view;
  if (!baseline) return baselineSearch ? { baselineSearch } : {};
  const checked = await checkSnapshot(store, baseline.scanId);
  if (
    checked?.state === 'VERIFIED' &&
    stableSerialize(checked.snapshot.scan) === stableSerialize(baseline.scan)
  ) {
    return { baseline, ...(baselineSearch ? { baselineSearch } : {}) };
  }
  let why = 'is no longer a TradingView snapshot in the scan store';
  if (checked?.state === 'VERIFIED') why = 'no longer matches its stored snapshot';
  else if (checked) why = `does not reproduce (${checked.reason})`;
  return {
    baselineSearch: {
      reason: `the baseline recorded with this scan, ${baseline.scanId}, ${why}`,
      skipped: [...(baselineSearch?.skipped ?? [])],
    },
  };
}

/**
 * One saved scan for Research: its snapshot reproduced offline, then shown with its
 * recorded view's source and comparison, or with only what the snapshot records.
 * Null when the store holds no TradingView snapshot by that ID.
 */
export async function readSavedScan(store: string, scanId: string): Promise<SavedScanRead | null> {
  const checked = await checkSnapshot(store, scanId);
  if (checked?.state !== 'VERIFIED') return checked;
  const { snapshot, legacy, sha256 } = checked;
  const recorded = await recordedView(store, snapshot);
  const saved: TradingViewSavedScan = {
    repositoryCommit: snapshot.repositoryCommit,
    legacy,
    view: recorded?.kind ?? null,
    snapshotSha256: sha256,
  };
  const view: TradingViewDevScan = {
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: snapshot.scanId,
    importedAt: snapshot.completedAt,
    source: recorded?.view.source ?? {
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: null,
      // What this scan's inputs recorded as requested; a legacy scan recorded none.
      symbols: Object.fromEntries(
        snapshot.inputs.flatMap(({ ticker, providerSymbol }) =>
          providerSymbol ? [[ticker, providerSymbol.requested]] : [],
        ),
      ),
      notice: null,
      selectionRule: null,
      pineAlerts: null,
      snapshotOnly: true,
    },
    scan: snapshot.scan,
    ...(recorded ? await checkedComparison(store, recorded.view) : {}),
    saved,
  };
  return { state: 'VERIFIED', view: parseTradingViewDevScan(view) };
}
