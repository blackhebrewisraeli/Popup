/**
 * Local entry point of the breadth-filter feasibility study (docs/SPOT_24H_BREADTH_FILTER.md).
 * Offline. It verifies the recorded v1 result, the diagnostic output and the saved files, rebuilds
 * v1's observations with the run commit's own code (as the diagnosis does) and reconciles them,
 * then gives each observation the specification's state and writes one git-ignored result. It never
 * writes the protocol, the v1 result, the diagnostic output or the data. No network, account,
 * order, alert, experiment record or production store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import type { HourCandle, ProtocolResults } from './spot24h';
import { analyse, breadthAt, SPEC, specSha256, type StatedRow } from './spot24hBreadth';
import {
  DATA_DIR,
  ORIGINAL_RESULT,
  readCandleFiles,
  rebuildRows,
  reconcile,
  verifyOriginal,
  type Git,
} from './spot24hDiagnosticRun';

type V1 = typeof import('./spot24h');

/** Code of this study whose git blob the output records. */
export const FILTER_FILES = [
  'docs/spot-24h-breadth-filter.json',
  'scripts/spot24hBreadth.ts',
  'scripts/spot24hBreadthRun.ts',
  'scripts/spot24hDiagnostic.ts',
  'scripts/spot24hDiagnosticRun.ts',
  'scripts/spot24h.ts',
  'scripts/scannerResearch.ts',
  'scripts/swingStructureEvaluation.ts',
] as const;

const execFileAsync = promisify(execFile);
const git: Git = async (...args) =>
  (await execFileAsync('git', args, { encoding: 'utf8' })).stdout.trim();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** As v1: the commit names the code only if no tracked file differs from it. */
export async function filterIdentity(run: Git = git) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed)
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  const blobs = await Promise.all(FILTER_FILES.map((file) => run('hash-object', file)));
  return {
    filterCommit: await run('rev-parse', 'HEAD'),
    filterBlobs: Object.fromEntries(FILTER_FILES.map((file, i) => [file, blobs[i]!])),
  };
}

/** The saved file must be the one the specification names, byte for byte. */
export async function verifyFile(path: string, expected: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expected) throw new Error(`${path} is not ${expected}`);
  return bytes;
}

/** The diagnosis whose reconciled observations this study reuses must have passed. */
export async function verifyDiagnostic(basis = SPEC.basis.diagnostic) {
  const bytes = await verifyFile(basis.path, basis.sha256);
  const { reconciliation } = JSON.parse(bytes.toString('utf8')) as {
    reconciliation: { pass: boolean; observations: number };
  };
  if (!reconciliation.pass) throw new Error('The diagnostic reconciliation did not pass');
  return reconciliation.observations;
}

// ponytail: same loader as the diagnosis (not exported there; its file stays byte-for-byte).
async function loadRunCommit(tree: string, commit: string, run: Git): Promise<V1> {
  const tar = join(tree, 'source.tar');
  await run('archive', '--format=tar', '-o', tar, commit);
  await execFileAsync('tar', ['-xf', tar, '-C', tree]);
  return (await import(pathToFileURL(join(tree, 'scripts/spot24h.ts')).href)) as V1;
}

/**
 * Once every identity holds: v1's observations rebuilt by its own functions and reconciled with the
 * recorded result (as the diagnosis does), each given the state at its decision time from v1's own
 * candle validity, then every table of the specification.
 */
export function breadthStudy(
  v1: V1,
  candles: Readonly<Record<string, readonly HourCandle[]>>,
  recorded: ProtocolResults,
  diagnosedObservations: number,
) {
  const { members } = v1.PROTOCOL.universe;
  const { rows, observations } = rebuildRows(v1, candles);
  const { reconciliation } = reconcile(v1, recorded, rows, observations);
  if (!reconciliation.pass || rows.length !== diagnosedObservations) {
    throw new Error(`Reconciliation failed: ${JSON.stringify(reconciliation)}`);
  }
  const cutoff = Date.parse(v1.PROTOCOL.data.collectionCutoff);
  const valid = Object.fromEntries(
    members.map((symbol) => [symbol, v1.indexHourly(candles[symbol] ?? [], cutoff).valid]),
  );
  const states = new Map<number, ReturnType<typeof breadthAt>>();
  const stated: StatedRow[] = rows.map((row) => {
    const breadth = states.get(row.time) ?? breadthAt(members, valid, row.time);
    states.set(row.time, breadth);
    return { ...row, breadth };
  });
  return {
    reconciliation: { ...reconciliation, diagnosedObservations },
    results: analyse(stated, v1.PROTOCOL.scenarios, members.length),
  };
}

export async function runBreadthFilter(
  dataDir = DATA_DIR,
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: () => ReturnType<typeof filterIdentity> = filterIdentity,
  run: Git = git,
) {
  const code = await identity();
  const { basis } = SPEC;
  if (
    basis.recordedResult.path !== ORIGINAL_RESULT.path ||
    basis.recordedResult.sha256 !== ORIGINAL_RESULT.sha256 ||
    basis.recordedResult.runCommit !== ORIGINAL_RESULT.repositoryCommit
  ) {
    throw new Error('The specification names another v1 result than the diagnosis');
  }
  const { manifest, results: recorded } = await verifyOriginal(run);
  if (manifest.protocol.sha256 !== basis.protocol.sha256) throw new Error('Protocol differs');
  const diagnosedObservations = await verifyDiagnostic();
  await verifyFile(manifest.universe['path']!, manifest.universe['sha256']!);

  await mkdir(resolve(outputDir), { recursive: true });
  const tree = await mkdtemp(join(resolve(outputDir), '.spot-24h-v1-source-'));
  try {
    const v1 = await loadRunCommit(tree, manifest.repositoryCommit, run);
    if (v1.protocolSha256() !== basis.protocol.sha256) throw new Error('Protocol identity differs');
    const candles = await readCandleFiles(
      dataDir,
      v1.PROTOCOL.universe.members,
      manifest.candleFiles,
    );
    const { reconciliation, results } = breadthStudy(v1, candles, recorded, diagnosedObservations);

    const specification = { path: FILTER_FILES[0], id: SPEC.specificationId, sha256: specSha256() };
    const content = `${JSON.stringify(
      {
        manifest: {
          ...code,
          specification,
          original: {
            path: ORIGINAL_RESULT.path,
            sha256: ORIGINAL_RESULT.sha256,
            repositoryCommit: manifest.repositoryCommit,
            protocol: manifest.protocol,
            sourceBlobs: manifest.sourceBlobs,
          },
          diagnostic: basis.diagnostic,
          universe: manifest.universe,
          candleFiles: manifest.candleFiles,
          reconstruction:
            'scripts/spot24h.ts from a git archive of the run commit; rows rebuilt and reconciled with scripts/spot24hDiagnosticRun.ts',
        },
        reconciliation,
        results,
      },
      null,
      2,
    )}\n`;
    const path = join(
      outputDir,
      `spot-24h-breadth-filter-${specification.sha256.slice(0, 12)}.json`,
    );
    const status = await saveResearchResults(path, content);
    return {
      status,
      path,
      contentSha256: sha256(content),
      observations: reconciliation.observations,
    };
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}
