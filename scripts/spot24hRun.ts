/**
 * Local entry points for protocol v1 (docs/SPOT_24H_PROBABILITY.md). Reads only Binance public
 * market data and writes only git-ignored files. No account, order, alert or production store.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchSymbolCandles } from '@/lib/binance';
import { slotForDate, type DiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscovery';
import { collectDiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscoveryRun';
import {
  PROTOCOL,
  protocolSha256,
  selectUniverse,
  universeCandidates,
  type UniverseSelection,
} from './spot24h';

export const DATA_DIR = '.zerochart-market-data/spot-24h-v1';
const UNIVERSE_FILE = 'universe.json';

/** Writes once; an existing file is never replaced. */
async function writeOnce(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, { flag: 'wx' });
}

/**
 * The universe step: discovery evidence collected now (before the cutoff), the first 1h candle
 * of every candidate, and the selection. Reads no candle inside the evaluation period.
 */
export async function collectUniverse(dir = DATA_DIR, now = Date.now) {
  if (now() >= Date.parse(PROTOCOL.data.collectionCutoff)) {
    throw new Error('The universe must be collected before the collection cutoff.');
  }
  const evidence = await collectDiscoveryEvidence(
    slotForDate(new Date(now()).toISOString().slice(0, 10)),
    { fetch, now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) },
  );
  const firstOpenTimes: Record<string, number> = {};
  for (const { symbol, reason } of universeCandidates(evidence)) {
    if (reason) continue;
    const [first] = await fetchSymbolCandles(symbol, { interval: '1h', limit: 1, startTime: 0 });
    if (first) firstOpenTimes[symbol] = first.timestamp;
  }
  const file: UniverseFile = { protocolId: PROTOCOL.protocolId, evidence, firstOpenTimes };
  await writeOnce(join(dir, UNIVERSE_FILE), `${JSON.stringify(file, null, 2)}\n`);
  return universeSummary(file);
}

/** Only evidence is stored; the selection is always recomputed from it under the protocol. */
export interface UniverseFile {
  protocolId: string;
  evidence: DiscoveryEvidence;
  firstOpenTimes: Record<string, number>;
}

export async function readUniverse(dir = DATA_DIR): Promise<UniverseFile> {
  return JSON.parse(await readFile(join(dir, UNIVERSE_FILE), 'utf8')) as UniverseFile;
}

export function universeSummary(file: UniverseFile) {
  const selection: UniverseSelection = selectUniverse(file.evidence, file.firstOpenTimes);
  return {
    protocolSha256: protocolSha256(),
    discoveryCutoff: file.evidence.collection.cutoff,
    discoveryStatus: file.evidence.result.status,
    members: selection.members.map((m) => m.symbol),
    skipped: selection.skipped,
  };
}
