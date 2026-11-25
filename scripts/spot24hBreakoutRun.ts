/**
 * Local entry point of the channel-breakout study (docs/SPOT_24H_CHANNEL_BREAKOUT.md). Offline. It
 * verifies protocol v1's recorded result, the universe evidence and every saved candle file against
 * their recorded SHA-256, runs the specification once and writes one git-ignored result. It never
 * writes the protocol, the v1 result, the earlier studies or the data. No network, account, order,
 * alert, experiment record or production store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import { PROTOCOL, protocolSha256 } from './spot24h';
import { verifyFile } from './spot24hBreadthRun';
import { channelBreakoutStudy, SPEC, specSha256, type StudyResults } from './spot24hBreakout';
import { DATA_DIR, readCandleFiles, type Git } from './spot24hDiagnosticRun';

/** Code of this study whose git blob the output records. */
export const BREAKOUT_FILES = [
  'docs/spot-24h-channel-breakout.json',
  'scripts/spot24hBreakout.ts',
  'scripts/spot24hBreakoutRun.ts',
  'scripts/spot24h.ts',
  'scripts/spot24hDiagnosticRun.ts',
  'scripts/spot24hBreadthRun.ts',
  'scripts/scannerResearch.ts',
  'docs/spot-24h-probability.v1.json',
  'src/lib/indicators.ts',
  'src/lib/candleValidation.ts',
  'src/lib/stableSerialize.ts',
] as const;

const execFileAsync = promisify(execFile);
const git: Git = async (...args) =>
  (await execFileAsync('git', args, { encoding: 'utf8' })).stdout.trim();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** As v1: the commit names the code only if no tracked file differs from it. */
export async function breakoutIdentity(run: Git = git) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed)
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  const blobs = await Promise.all(BREAKOUT_FILES.map((file) => run('hash-object', file)));
  return {
    codeCommit: await run('rev-parse', 'HEAD'),
    codeBlobs: Object.fromEntries(BREAKOUT_FILES.map((file, i) => [file, blobs[i] ?? ''])),
  };
}

interface RecordedManifest {
  repositoryCommit: string;
  protocol: { id: string; sha256: string };
  universe: { path: string; sha256: string };
  candleFiles: Record<string, { sha256: string; candles: number; retrievedAt: string }>;
}

/** data.verification: every recorded identity must hold before anything is computed. */
export async function verifiedInputs(
  dataDir = DATA_DIR,
  recorded: { path: string; sha256: string; runCommit: string } = SPEC.basis.recordedResult,
) {
  if (protocolSha256() !== SPEC.basis.protocol.sha256) throw new Error('Protocol v1 differs');
  const bytes = await verifyFile(recorded.path, recorded.sha256);
  const { manifest } = JSON.parse(bytes.toString('utf8')) as { manifest: RecordedManifest };
  if (manifest.repositoryCommit !== recorded.runCommit) {
    throw new Error(`The v1 result names ${manifest.repositoryCommit}, not ${recorded.runCommit}`);
  }
  if (manifest.protocol.sha256 !== SPEC.basis.protocol.sha256) throw new Error('Protocol differs');
  await verifyFile(join(dataDir, 'universe.json'), manifest.universe.sha256);
  const { members } = PROTOCOL.universe;
  const candles = await readCandleFiles(dataDir, members, manifest.candleFiles);
  return { manifest, members, candles };
}

export async function runChannelBreakout(
  dataDir = DATA_DIR,
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: () => ReturnType<typeof breakoutIdentity> = breakoutIdentity,
  recorded: { path: string; sha256: string; runCommit: string } = SPEC.basis.recordedResult,
) {
  const code = await identity();
  const { manifest, members, candles } = await verifiedInputs(dataDir, recorded);
  const results = channelBreakoutStudy(candles, members);
  const specification = {
    path: BREAKOUT_FILES[0],
    id: SPEC.specificationId,
    sha256: specSha256(),
  };
  const content = `${JSON.stringify(
    {
      manifest: {
        ...code,
        specification,
        recordedResult: { path: recorded.path, sha256: recorded.sha256 },
        protocol: manifest.protocol,
        universe: manifest.universe,
        candleFiles: manifest.candleFiles,
      },
      results,
    },
    null,
    2,
  )}\n`;
  const path = join(
    outputDir,
    `spot-24h-channel-breakout-${specification.sha256.slice(0, 12)}.json`,
  );
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), summary: resultsSummary(results) };
}

/** The headline figures; trades and monthly rows stay in the git-ignored file. */
export function resultsSummary(results: StudyResults) {
  const wallets = Object.entries(results.wallets).map(([id, w]) => {
    const p = w.strategy.performance;
    return {
      id,
      status: w.strategy.status,
      signals: w.strategy.signals,
      executedTrades: w.strategy.executedTrades,
      skipped: w.strategy.skipped,
      endingEquity: p?.endingEquity ?? null,
      netReturn: p?.netReturn ?? null,
      grossReturn: p?.grossReturn ?? null,
      maxDrawdown: p?.maxDrawdown.fraction ?? null,
      profitFactor: p?.profitFactor ?? null,
      references: w.references.buyAndHold.map((r) => ({
        symbol: r.symbol,
        netReturn: r.performance?.netReturn ?? null,
      })),
    };
  });
  return {
    specification: results.specification,
    execution: results.execution,
    events: results.events.all.complete,
    wallets,
    conclusion: results.conclusion,
  };
}
