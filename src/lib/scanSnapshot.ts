/**
 * A saved market-scan snapshot and its offline reproduction, shared by the scan store
 * (scripts/marketScanStore.ts, node:crypto) and the browser's saved-file check
 * (src/lib/savedScanFile.ts, Web Crypto in the finance worker). One implementation: only the
 * SHA-256 function is injected, and both hash the UTF-8 bytes of the same stable text.
 */
import { CANONICAL_MODEL_VERSION } from '@/lib/canonicalModel';
import {
  evaluateScan,
  SCANNER_VERSION,
  type MarketScan,
  type ScanInput,
} from '@/lib/marketScanner';
import { stableSerialize } from '@/lib/stableSerialize';
import type { TradingViewDevSource } from '@/lib/tradingViewDevScan';

/**
 * Scan-level evidence: everything needed to re-derive a scan offline. A
 * separate evidence type from scheduled-score campaigns (.zerochart-campaigns)
 * and received TradingView alerts (trading_signals); it never writes to either.
 */
export interface ScanSnapshot {
  schemaVersion: '1';
  evidenceType: 'market-scan';
  scanId: string;
  repositoryCommit: string;
  startedAt: string;
  completedAt: string;
  /** sha256 of the universe source and its sorted members. */
  universeVersion: string;
  /** sha256 of each member's collected input (candles or recorded failure). */
  inputHashes: Record<string, string>;
  inputs: readonly ScanInput[];
  scan: MarketScan;
}

export type ScanMismatchReason =
  | 'UNSUPPORTED_VERSION'
  | 'UNIVERSE_HASH_MISMATCH'
  | 'INPUT_HASH_MISMATCH'
  | 'OUTPUT_MISMATCH'
  | 'EVALUATION_TIME_MISMATCH'
  | 'SNAPSHOT_METADATA_MISMATCH';

/** Hex SHA-256 of a string's UTF-8 bytes. */
export type Sha256 = (text: string) => string | Promise<string>;

/** The text a universe version hashes: its source and members. */
export const universeHashText = (source: string, members: readonly string[]) =>
  stableSerialize({ source, members });

/** The text one member's input hash covers. */
export const inputHashText = (input: ScanInput) => stableSerialize(input);

export function scanIdFor(startedAt: number, version: string): string {
  return `${new Date(startedAt).toISOString().replace(/[-:]|\.\d{3}/g, '')}-${version.slice(0, 8)}`;
}

/** The cheap checks, before anything is hashed or scored: required fields, then versions. */
export function snapshotShapeReason(
  snapshot: ScanSnapshot,
): 'SNAPSHOT_METADATA_MISMATCH' | 'UNSUPPORTED_VERSION' | null {
  if (
    !snapshot ||
    typeof snapshot.repositoryCommit !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.completedAt)) ||
    !Array.isArray(snapshot.inputs) ||
    !snapshot.inputHashes ||
    typeof snapshot.inputHashes !== 'object' ||
    !snapshot.scan ||
    !Array.isArray(snapshot.scan.cohorts) ||
    !Array.isArray(snapshot.scan.results) ||
    !snapshot.scan.universe ||
    typeof snapshot.scan.universe.source !== 'string' ||
    !Array.isArray(snapshot.scan.universe.members)
  ) {
    return 'SNAPSHOT_METADATA_MISMATCH';
  }
  if (
    snapshot.scan.scannerVersion !== SCANNER_VERSION ||
    snapshot.scan.modelVersion !== CANONICAL_MODEL_VERSION
  ) {
    return 'UNSUPPORTED_VERSION';
  }
  return null;
}

/**
 * Why a parsed snapshot does not reproduce offline, or null when it does: its scan ID and
 * start agree with its evaluation time, its universe and input hashes match, and scoring its
 * inputs again gives exactly its scan. Reads no file. Throws on inputs that cannot be scored.
 */
export async function snapshotMismatchReason(
  snapshot: ScanSnapshot,
  sha256: Sha256,
): Promise<ScanMismatchReason | null> {
  const shape = snapshotShapeReason(snapshot);
  if (shape) return shape;
  const evaluationTime = snapshot.scan.evaluationTime;
  const evaluationDate = new Date(evaluationTime);
  if (
    !Number.isFinite(evaluationTime) ||
    !Number.isFinite(evaluationDate.getTime()) ||
    snapshot.startedAt !== evaluationDate.toISOString() ||
    snapshot.scanId !== scanIdFor(evaluationTime, snapshot.universeVersion)
  ) {
    return 'EVALUATION_TIME_MISMATCH';
  }
  const { source, members } = snapshot.scan.universe;
  if ((await sha256(universeHashText(source, members))) !== snapshot.universeVersion) {
    return 'UNIVERSE_HASH_MISMATCH';
  }
  const hashes = await Promise.all(
    snapshot.inputs.map(async (input) => [input.ticker, await sha256(inputHashText(input))]),
  );
  if (stableSerialize(Object.fromEntries(hashes)) !== stableSerialize(snapshot.inputHashes)) {
    return 'INPUT_HASH_MISMATCH';
  }
  const provider = (assetClass: string) =>
    snapshot.scan.cohorts.find((cohort) => cohort.assetClass === assetClass)?.provider ?? null;
  const recomputed = evaluateScan(snapshot.inputs, {
    evaluationTime,
    universeSource: source,
    equityProvider: provider('equity'),
    cryptoProvider: provider('crypto'),
  });
  return stableSerialize(recomputed) === stableSerialize(snapshot.scan) ? null : 'OUTPUT_MISMATCH';
}

/** Why a snapshot is not shown, as the saved-scan reader names it. */
export interface SnapshotRefusal {
  state: 'MALFORMED' | 'INCOMPATIBLE' | 'NOT_REPRODUCED';
  reason: string;
}

/**
 * The schema and evidence-type gate, then the offline reproduction, as one verdict: null when
 * the snapshot reproduces. `scanId`, when given, is the ID the file was asked for by. `runner`
 * names what is checking, in the incompatible-version message.
 */
export async function checkScanSnapshot(
  raw: Partial<ScanSnapshot>,
  sha256: Sha256,
  { scanId, runner = 'this checkout' }: { scanId?: string; runner?: string } = {},
): Promise<SnapshotRefusal | null> {
  if (raw.schemaVersion !== '1') {
    return { state: 'INCOMPATIBLE', reason: `snapshot schema ${String(raw.schemaVersion)}, not 1` };
  }
  if (raw.evidenceType !== 'market-scan' || (scanId !== undefined && raw.scanId !== scanId)) {
    return {
      state: 'MALFORMED',
      reason: 'the file does not record this scan as a market-scan snapshot',
    };
  }
  const snapshot = raw as ScanSnapshot;
  let reason: ScanMismatchReason | null;
  try {
    reason = await snapshotMismatchReason(snapshot, sha256);
  } catch (error) {
    return {
      state: 'MALFORMED',
      reason: `its inputs cannot be scored (${(error as Error).message})`,
    };
  }
  if (reason === null) return null;
  if (reason === 'SNAPSHOT_METADATA_MISMATCH') {
    return { state: 'MALFORMED', reason: 'required snapshot fields are missing or invalid' };
  }
  if (reason === 'UNSUPPORTED_VERSION') {
    return {
      state: 'INCOMPATIBLE',
      reason: `recorded with scanner ${String(snapshot.scan.scannerVersion)} and model ${String(snapshot.scan.modelVersion)}; ${runner} runs ${SCANNER_VERSION} and ${CANONICAL_MODEL_VERSION}`,
    };
  }
  return { state: 'NOT_REPRODUCED', reason };
}

/** Recorded before inputs kept exact provider symbols. */
export const isLegacySnapshot = (raw: Partial<ScanSnapshot>) =>
  !(Array.isArray(raw.inputs) && raw.inputs.some((input) => input?.providerSymbol));

/**
 * A snapshot's source as it alone records it: no retrieval window, notice, selection rule or
 * alert check (null, never filled in from today), and the symbols its inputs requested.
 */
export function snapshotOnlySource(snapshot: ScanSnapshot): TradingViewDevSource {
  return {
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
  };
}
