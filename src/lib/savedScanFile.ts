/**
 * A saved TradingView crypto scan opened from a file the owner chose, checked in the browser's
 * finance worker (src/lib/finance.worker.ts) the way the dev saved-scan route checks one from the
 * scan store: same snapshot format, same offline reproduction (src/lib/scanSnapshot.ts), same
 * snapshot-only view. Only the original `<scanId>.json` market-scan snapshot of a TradingView
 * crypto import is accepted. The bytes are hashed before anything decodes them, and those same
 * bytes are what is checked. Nothing is fetched, stored or sent: the file stays in memory.
 *
 * A file that reproduces is internally consistent, not authentic: nothing signs it.
 */
import { TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION } from '@/lib/marketScanner';
import {
  checkScanSnapshot,
  snapshotOnlySource,
  snapshotShapeReason,
  type ScanSnapshot,
  type Sha256,
} from '@/lib/scanSnapshot';
import {
  parseTradingViewDevScan,
  SCAN_ID,
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan,
} from '@/lib/tradingViewDevScan';
import { spotSymbol } from '@/lib/tradingViewSymbol';

/**
 * Larger than any crypto snapshot needs: a 25-pair `crypto-usdt-v1` scan is about 1 MB. Checked
 * against the file's size before it is read, and against the bytes before they are decoded.
 */
export const SAVED_SCAN_FILE_MAX_BYTES = 4 * 1024 * 1024;
/** At most this many pairs, checked before anything is hashed or scored (the frozen universe has 25). */
export const SAVED_SCAN_FILE_MAX_PAIRS = 100;
/** At most this many candles per pair (imports keep about 200: the model reads 199). */
export const SAVED_SCAN_FILE_MAX_CANDLES = 1000;

export type SavedScanFileRefusal =
  'TOO_LARGE' | 'MALFORMED' | 'UNSUPPORTED' | 'INCOMPATIBLE' | 'NOT_REPRODUCED';

/** What the check found. Only `VERIFIED` carries a view; nothing else is shown from the file. */
export type SavedScanFileCheck =
  | { state: 'VERIFIED'; view: TradingViewDevScan }
  /** `scanId` only when the file names a well-formed one. */
  | { state: SavedScanFileRefusal; reason: string; scanId: string | null };

const MEGABYTE = 1024 * 1024;
export const SAVED_SCAN_FILE_LIMIT_LABEL = `${SAVED_SCAN_FILE_MAX_BYTES / MEGABYTE} MB`;

export function tooLarge(size: number): SavedScanFileCheck {
  return {
    state: 'TOO_LARGE',
    reason: `${(size / MEGABYTE).toFixed(1)} MB, over the ${SAVED_SCAN_FILE_LIMIT_LABEL} limit for one crypto snapshot`,
    scanId: null,
  };
}

const hex = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

const digestBytes = async (bytes: Uint8Array<ArrayBuffer>) =>
  hex(await crypto.subtle.digest('SHA-256', bytes));

/** Web Crypto over the string's UTF-8 bytes, exactly what node:crypto hashes for the scan store. */
export const webSha256: Sha256 = (text) => digestBytes(new TextEncoder().encode(text));

/** A file-supplied string, shortened for a message. */
const quoted = (value: unknown) => JSON.stringify(String(value).slice(0, 60));

type Raw = Partial<ScanSnapshot> & { kind?: unknown };

/**
 * What makes this file something other than a TradingView crypto snapshot this entry point
 * opens, or null. Runs after the shape and version check, before anything is hashed or scored.
 */
function cryptoOnlyReason(snapshot: ScanSnapshot): string | null {
  const { scan, inputs } = snapshot;
  if (scan.universe.source !== TRADINGVIEW_DEV_UNIVERSE_SOURCE) {
    return `its universe source is ${quoted(scan.universe.source)}, not a TradingView import: only TradingView crypto scans open here`;
  }
  const classes = [...new Set(scan.cohorts.map((cohort) => String(cohort?.assetClass)))];
  if (classes.length !== 1 || classes[0] !== 'crypto') {
    return `it scans ${classes.join(' + ') || 'no asset class'}: only crypto-only scans open here, never equity or mixed ones`;
  }
  const [cohort] = scan.cohorts;
  if (
    cohort?.provider !== TRADINGVIEW_DEV_PROVIDER_ID ||
    cohort.candlePolicyVersion !== TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION
  ) {
    return `its crypto candles are recorded as ${quoted(cohort?.provider)} under policy ${quoted(cohort?.candlePolicyVersion)}, not TradingView's (${TRADINGVIEW_DEV_PROVIDER_ID}, ${TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION})`;
  }
  if (inputs.length === 0) return 'it records no pairs';
  if (inputs.length > SAVED_SCAN_FILE_MAX_PAIRS) {
    return `it records ${inputs.length} pairs, over the limit of ${SAVED_SCAN_FILE_MAX_PAIRS}`;
  }
  for (const input of inputs) {
    const ticker = quoted(input?.ticker);
    if (!input || typeof input !== 'object' || input.equity !== undefined) {
      return `pair ${ticker} is not a crypto input`;
    }
    if (typeof input.instrument !== 'string' || !spotSymbol(input.instrument)) {
      return `pair ${ticker} names ${quoted(input.instrument)}, not a Binance Spot USDT pair`;
    }
    const symbol = input.providerSymbol;
    if (!symbol) {
      return `pair ${ticker} records no exact TradingView symbol (a legacy snapshot, recorded before exact symbols were kept)`;
    }
    if (symbol.requested !== input.instrument || symbol.validated !== input.instrument) {
      return `pair ${ticker} requested ${quoted(symbol.requested)} and TradingView validated ${quoted(symbol.validated)}, which are not both its instrument ${quoted(input.instrument)}`;
    }
    if (input.candles !== undefined && !Array.isArray(input.candles)) {
      return `pair ${ticker} records candles that are not a list`;
    }
    if ((input.candles?.length ?? 0) > SAVED_SCAN_FILE_MAX_CANDLES) {
      return `pair ${ticker} records ${input.candles?.length} candles, over the limit of ${SAVED_SCAN_FILE_MAX_CANDLES}`;
    }
  }
  return null;
}

/**
 * Checks one file's original bytes: hashed first, then decoded as UTF-8, parsed, gated to the
 * TradingView crypto snapshot format and reproduced offline. `VERIFIED` only after reproduction;
 * the view it carries is the snapshot alone, with its file hash and nothing else from the file.
 */
export async function checkSavedScanFile(source: ArrayBuffer): Promise<SavedScanFileCheck> {
  const bytes = new Uint8Array(source);
  if (bytes.byteLength > SAVED_SCAN_FILE_MAX_BYTES) return tooLarge(bytes.byteLength);
  const snapshotSha256 = await digestBytes(bytes);
  const refuse = (state: SavedScanFileRefusal, reason: string, raw?: Raw): SavedScanFileCheck => ({
    state,
    reason,
    scanId: typeof raw?.scanId === 'string' && SCAN_ID.test(raw.scanId) ? raw.scanId : null,
  });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse('MALFORMED', 'the file is not UTF-8 text');
  }
  let raw: Raw;
  try {
    raw = JSON.parse(text) as Raw;
  } catch {
    return refuse('MALFORMED', 'the file is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return refuse('MALFORMED', 'the file is not a JSON object');
  }
  if (!('schemaVersion' in raw) && !('evidenceType' in raw) && raw.kind === undefined) {
    return refuse(
      'MALFORMED',
      'the file is not a market-scan snapshot: it records no schemaVersion or evidenceType',
    );
  }
  if (raw.kind === TRADINGVIEW_DEV_SCAN_KIND) {
    return refuse(
      'UNSUPPORTED',
      'this is a published Research view (tradingview-dev-scan.json), not the original snapshot: choose the scan’s <scan ID>.json file from the scan store',
      raw,
    );
  }
  if (raw.schemaVersion === '1' && raw.evidenceType === 'market-scan') {
    const snapshot = raw as ScanSnapshot;
    const shape = snapshotShapeReason(snapshot);
    // Named by the shared check below, with the same words the scan store uses.
    if (shape === null) {
      const notCrypto = cryptoOnlyReason(snapshot);
      if (notCrypto) return refuse('UNSUPPORTED', notCrypto, raw);
    }
  }
  const refused = await checkScanSnapshot(raw, webSha256, { runner: 'this version of Popup' });
  if (refused) return refuse(refused.state, refused.reason, raw);
  const snapshot = raw as ScanSnapshot;
  const view: TradingViewDevScan = {
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: snapshot.scanId,
    importedAt: snapshot.completedAt,
    source: snapshotOnlySource(snapshot),
    scan: snapshot.scan,
    saved: {
      repositoryCommit: snapshot.repositoryCommit,
      // Never: a snapshot without exact symbols was refused above.
      legacy: false,
      view: null,
      snapshotSha256,
      fromFile: true,
    },
  };
  return { state: 'VERIFIED', view: parseTradingViewDevScan(view) };
}
