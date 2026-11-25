/**
 * Local entry point of the structure-entry development experiment
 * (docs/STRUCTURE_ENTRY_1H_DEV_V1.md). Offline. It verifies protocol v1's recorded result, the
 * universe evidence and every saved candle file against their recorded SHA-256, runs the
 * specification once and writes one git-ignored result. It never writes the protocol, the v1
 * result, the earlier studies, the swing-structure candidate or the data. No network, account,
 * order, alert, experiment record or production store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import { protocolSha256 } from './spot24h';
import { verifiedInputs } from './spot24hBreakoutRun';
import { DATA_DIR, type Git } from './spot24hDiagnosticRun';
import { SPEC, specSha256, structureEntryStudy, type StudyResults } from './structureEntry';

/** Code of this study whose git blob the output records. */
export const STUDY_FILES = [
  'docs/structure-entry-1h-dev-v1.json',
  'scripts/structureEntry.ts',
  'scripts/structureEntryRun.ts',
  'scripts/swingStructure.ts',
  'scripts/swingStructureEvaluation.ts',
  'scripts/spot24h.ts',
  'scripts/spot24hBreakout.ts',
  'scripts/spot24hBreakoutRun.ts',
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
export async function studyIdentity(run: Git = git) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed)
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  const blobs = await Promise.all(STUDY_FILES.map((file) => run('hash-object', file)));
  return {
    codeCommit: await run('rev-parse', 'HEAD'),
    codeBlobs: Object.fromEntries(STUDY_FILES.map((file, i) => [file, blobs[i] ?? ''])),
  };
}

export async function runStructureEntry(
  dataDir = DATA_DIR,
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: () => ReturnType<typeof studyIdentity> = studyIdentity,
  recorded: { path: string; sha256: string; runCommit: string } = SPEC.basis.recordedResult,
) {
  const code = await identity();
  if (protocolSha256() !== SPEC.basis.protocol.sha256) throw new Error('Protocol v1 differs');
  const { manifest, members, candles } = await verifiedInputs(dataDir, recorded);
  const results = structureEntryStudy(candles, members);
  const specification = { path: STUDY_FILES[0], id: SPEC.specificationId, sha256: specSha256() };
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
    `structure-entry-1h-dev-v1-${specification.sha256.slice(0, 12)}.json`,
  );
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), summary: resultsSummary(results) };
}

/** The headline figures; rows, months and pairs stay in the git-ignored file. */
export function resultsSummary(results: StudyResults) {
  const s = results.statistics;
  const arm = (a: NonNullable<typeof s>['all']['a']) => ({
    entries: a.entries,
    fillRate: a.fillRate,
    meanNetPerSource: a.meanNetPerSource,
    meanNetPerTrade: a.meanNetPerTrade,
  });
  return {
    specification: results.specification,
    screening: { hours: results.screening.hours, counts: results.screening.counts },
    admitted: results.screening.admitted,
    integrityFailures: results.integrityFailures.length,
    periods: s
      ? Object.fromEntries(
          Object.entries({ all: s.all, ...s.periods }).map(([id, g]) => [
            id,
            {
              sources: g.sources,
              days: g.days,
              meanNetDifference: g.paired.meanNetDifference,
              a: arm(g.a),
              b: arm(g.b),
            },
          ]),
        )
      : null,
    uncertainty: s?.uncertainty.map((u) => ({
      window: u.window,
      difference: u.difference,
      bNet: u.bNet,
    })),
    conclusion: results.conclusion,
  };
}
