/**
 * Local entry points for protocol v1 (docs/SPOT_24H_PROBABILITY.md). Reads only Binance public
 * market data and writes only git-ignored files. No account, order, alert or production store.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchSymbolCandles } from '@/lib/binance';
import { slotForDate, type DiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscovery';
import { collectDiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscoveryRun';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import {
  evaluateProtocol,
  HOUR_MS,
  PROTOCOL,
  protocolSha256,
  selectUniverse,
  universeCandidates,
  type HourCandle,
  type ProtocolResults,
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

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const candleFile = (dir: string, symbol: string) => join(dir, 'klines', `${symbol}-1h.json`);

interface CandleFile {
  symbol: string;
  interval: '1h';
  request: { startTime: string; endTime: string; limit: number };
  retrievedAt: string;
  candles: HourCandle[];
}

/** The universe file must be the recorded one, and its selection the protocol's members. */
export async function verifyUniverse(dir = DATA_DIR): Promise<UniverseFile> {
  const bytes = await readFile(join(dir, UNIVERSE_FILE));
  const expected = PROTOCOL.universe.evidenceFile.sha256;
  if (sha256(bytes) !== expected) {
    throw new Error(`universe.json sha256 ${sha256(bytes)} is not the recorded ${expected}`);
  }
  const file = JSON.parse(bytes.toString('utf8')) as UniverseFile;
  const members = selectUniverse(file.evidence, file.firstOpenTimes).members.map((m) => m.symbol);
  if (JSON.stringify(members) !== JSON.stringify(PROTOCOL.universe.members)) {
    throw new Error(`Recomputed members ${members.join(',')} differ from the protocol's`);
  }
  return file;
}

/** Pages of 1h candles opening in [start, cutoff − 1], as the provider returns them. */
export async function fetchHistory(
  symbol: string,
  fetchCandles: (
    symbol: string,
    options: { interval: string; limit: number; startTime?: number; endTime?: number },
  ) => Promise<HourCandle[]>,
  start: number,
  cutoff: number,
  limit: number,
  pauseMs: number,
): Promise<HourCandle[]> {
  const candles: HourCandle[] = [];
  let from = start;
  while (from < cutoff) {
    const page = await fetchCandles(symbol, {
      interval: '1h',
      limit,
      startTime: from,
      endTime: cutoff - 1,
    });
    candles.push(...page);
    const last = page.at(-1);
    if (!last || page.length < limit) break;
    from = last.timestamp + HOUR_MS;
    await new Promise((done) => setTimeout(done, pauseMs));
  }
  return candles;
}

/** 1h history for each member, from the history start to the cutoff. Never refetches a saved pair. */
export async function collectHistory(
  dir = DATA_DIR,
  now = Date.now,
  fetchCandles: typeof fetchSymbolCandles = fetchSymbolCandles,
  pauseMs = 100,
) {
  const cutoff = Date.parse(PROTOCOL.data.collectionCutoff);
  if (now() < cutoff) throw new Error('History is collected only after the collection cutoff.');
  await verifyUniverse(dir);
  const limit = PROTOCOL.data.requestLimit;
  const start = Date.parse(PROTOCOL.data.historyStart);
  const report: { symbol: string; status: 'CREATED' | 'KEPT'; candles: number }[] = [];
  for (const symbol of PROTOCOL.universe.members) {
    const path = candleFile(dir, symbol);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8')) as CandleFile;
      report.push({ symbol, status: 'KEPT', candles: saved.candles.length });
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const candles = await fetchHistory(symbol, fetchCandles, start, cutoff, limit, pauseMs);
    const file: CandleFile = {
      symbol,
      interval: '1h',
      request: {
        startTime: new Date(start).toISOString(),
        endTime: new Date(cutoff - 1).toISOString(),
        limit,
      },
      retrievedAt: new Date(now()).toISOString(),
      candles,
    };
    await writeOnce(path, `${JSON.stringify(file)}\n`);
    report.push({ symbol, status: 'CREATED', candles: candles.length });
  }
  return report;
}

/** Offline: verifies the inputs, runs the protocol and writes its results once. */
export async function runEvaluation(dir = DATA_DIR, outputDir = RESEARCH_OUTPUT_DIR) {
  await verifyUniverse(dir);
  const files: Record<string, { sha256: string; candles: number; retrievedAt: string }> = {};
  const candles: Record<string, HourCandle[]> = {};
  for (const symbol of PROTOCOL.universe.members) {
    const bytes = await readFile(candleFile(dir, symbol));
    const file = JSON.parse(bytes.toString('utf8')) as CandleFile;
    if (file.symbol !== symbol) throw new Error(`${candleFile(dir, symbol)} holds ${file.symbol}`);
    files[symbol] = {
      sha256: sha256(bytes),
      candles: file.candles.length,
      retrievedAt: file.retrievedAt,
    };
    candles[symbol] = file.candles;
  }
  const results = evaluateProtocol(candles);
  const manifest = { universe: PROTOCOL.universe.evidenceFile, candleFiles: files };
  const content = `${JSON.stringify({ manifest, results }, null, 2)}\n`;
  const path = join(outputDir, `spot-24h-probability-${results.protocol.sha256.slice(0, 12)}.json`);
  const status = await saveResearchResults(path, content);
  return {
    status,
    path,
    contentSha256: sha256(content),
    savedSha256: sha256(await readFile(path)),
    summary: resultsSummary(results),
  };
}

const round = (value: number | null, digits = 4) =>
  value === null ? null : Number(value.toFixed(digits));

/** Aggregates and the shortlist only; per-observation rows stay in the git-ignored file. */
export function resultsSummary(results: ProtocolResults) {
  const coverage = Object.values(results.coverage);
  const total = (key: 'decisions' | 'featuresUnavailable' | 'outcomeMissing' | 'observations') =>
    coverage.reduce((sum, c) => sum + c[key], 0);
  return {
    protocol: results.protocol,
    evaluationTime: results.evaluationTime,
    coverage: {
      decisions: total('decisions'),
      featuresUnavailable: total('featuresUnavailable'),
      outcomeMissing: total('outcomeMissing'),
      observations: total('observations'),
      candleIssues: coverage.reduce(
        (sum, c) => sum + Object.values(c.issues).reduce((a, b) => a + b, 0),
        0,
      ),
    },
    splits: results.splits,
    scenarios: results.confirmatory.map((test, s) => {
      const validation = results.development[s]!;
      return {
        scenario: test.scenario,
        testCounts: test.counts,
        testEvaluated: test.evaluated,
        testDays: test.days,
        validationDeltaBrier: round(validation.brier.delta, 5),
        testDeltaBrier: round(test.brier.delta, 5),
        testDeltaBrier95: test.brier.interval95 && [
          round(test.brier.interval95.low, 5),
          round(test.brier.interval95.high, 5),
        ],
        testSkillScore: round(test.brier.skillScore),
        calibrationInTheLarge: round(test.calibration.inTheLarge),
        weightedCellError: round(test.calibration.weightedCellError),
        testMeanNetReturn: round(test.meanNetReturn, 5),
        support: test.support,
        selectedTest: {
          observations: test.selected.observations,
          days: test.selected.days,
          meanNet: round(test.selected.meanNet, 5),
          interval95: test.selected.interval95 && [
            round(test.selected.interval95.low, 5),
            round(test.selected.interval95.high, 5),
          ],
        },
        expectancy: test.expectancy,
      };
    }),
    current: {
      verdict: results.current.verdict,
      shortlist: results.current.shortlist.map((c) => ({
        rank: c.rank,
        symbol: c.symbol,
        scenario: c.scenario,
        probability: round(c.probability),
        score: round(c.score),
      })),
    },
  };
}
