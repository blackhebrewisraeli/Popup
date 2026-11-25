/**
 * Local export step of the 24-hour quantile forecast study (docs/QUANTILE_FORECAST_24H_DEV_V1.md).
 * Offline. It verifies protocol v1's recorded result, the universe evidence and every saved candle
 * file against their recorded SHA-256, builds the dataset once and writes one git-ignored file for
 * scripts/quantile_forecast.py. No fit and no metric. It never writes the protocol, the v1 result,
 * an earlier study or the data. No network, account, order, alert, experiment record or store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { exportDataset, SPEC, specSha256 } from './quantileForecast';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import { protocolSha256 } from './spot24h';
import { verifiedInputs } from './spot24hBreakoutRun';
import { DATA_DIR, type Git } from './spot24hDiagnosticRun';

/** Code of this study whose git blob the dataset records, the Python half included. */
export const STUDY_FILES = [
  'docs/quantile-forecast-24h-dev-v1.json',
  'scripts/quantileForecast.ts',
  'scripts/quantileForecastRun.ts',
  'scripts/quantile_forecast.py',
  'scripts/quantile-forecast-requirements.txt',
  'scripts/spot24h.ts',
  'scripts/spot24hBreakoutRun.ts',
  'scripts/spot24hBreadthRun.ts',
  'scripts/spot24hDiagnosticRun.ts',
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
export async function exportIdentity(run: Git = git) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed)
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  const blobs = await Promise.all(STUDY_FILES.map((file) => run('hash-object', file)));
  return {
    codeCommit: await run('rev-parse', 'HEAD'),
    codeBlobs: Object.fromEntries(STUDY_FILES.map((file, i) => [file, blobs[i] ?? ''])),
  };
}

export async function runQuantileForecastExport(
  dataDir = DATA_DIR,
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: () => ReturnType<typeof exportIdentity> = exportIdentity,
  recorded: { path: string; sha256: string; runCommit: string } = SPEC.basis.recordedResult,
) {
  const code = await identity();
  if (protocolSha256() !== SPEC.basis.protocol.sha256) throw new Error('Protocol v1 differs');
  const { manifest, members, candles } = await verifiedInputs(dataDir, recorded);
  const { specification, ...dataset } = exportDataset(candles, members);
  const content = `${JSON.stringify({
    manifest: {
      ...code,
      specification: {
        ...specification,
        path: STUDY_FILES[0],
        fileSha256: sha256(await readFile(STUDY_FILES[0])),
      },
      recordedResult: { path: recorded.path, sha256: recorded.sha256 },
      protocol: manifest.protocol,
      universe: manifest.universe,
      candleFiles: manifest.candleFiles,
    },
    ...dataset,
  })}\n`;
  const name = `quantile-forecast-24h-dev-v1-dataset-${specSha256().slice(0, 12)}-${code.codeCommit.slice(0, 12)}.json`;
  const path = join(outputDir, name);
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), coverage: dataset.coverage.total };
}
