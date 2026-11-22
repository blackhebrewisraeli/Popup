/**
 * Local entry point of the protocol v1 diagnosis (docs/SPOT_24H_V1_DIAGNOSTIC.md). Offline. It
 * verifies the recorded result and the saved files, then runs the run commit's own code from a
 * `git archive` of that commit: first the whole original evaluation, whose bytes must hash to the
 * recorded result, then the same functions once more to rebuild each observation's entry and exit.
 * It writes one git-ignored diagnostic file and never touches the original result, protocol or data.
 * No network, account, order, alert, experiment record or production store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import type { HourCandle, Observation, ProtocolResults, ScenarioFit, Split } from './spot24h';
import {
  cellQuality,
  decompose,
  groupQuality,
  levelDistances,
  monthOf,
  outcomeAttribution,
  pairOf,
  returnDecomposition,
  type DiagnosticRow,
} from './spot24hDiagnostic';

type V1 = typeof import('./spot24h');
type V1Run = typeof import('./spot24hRun');

export const DATA_DIR = '.zerochart-market-data/spot-24h-v1';
/** The one recorded run this diagnosis reads (docs/SPOT_24H_PROBABILITY.md, Recorded run). */
export const ORIGINAL_RESULT = {
  path: join(RESEARCH_OUTPUT_DIR, 'spot-24h-probability-b3aa90fb8912.json'),
  sha256: '662c5d7d2eec69ac62c736701a63e00b565e642fdcb813823aa00ab43fa6ec1e',
  repositoryCommit: '2d848fb1b5584d64f9892cd44627366246adf359',
};
export const OUTPUT_FILE = 'spot-24h-v1-diagnostic-b3aa90fb8912.json';
/** Code of this diagnosis whose git blob the output records. */
export const DIAGNOSTIC_FILES = [
  'scripts/spot24hDiagnostic.ts',
  'scripts/spot24hDiagnosticRun.ts',
  'scripts/spot24h.ts',
  'scripts/scannerResearch.ts',
] as const;
/** Largest difference from a recorded figure accepted as floating-point noise. */
export const TOLERANCE = 1e-12;

export type Git = (...args: string[]) => Promise<string>;
const execFileAsync = promisify(execFile);
const git: Git = async (...args) =>
  (await execFileAsync('git', args, { encoding: 'utf8' })).stdout.trim();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** As v1: the commit names the code only if no tracked file differs from it. */
export async function diagnosticIdentity(run: Git = git) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed)
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  const blobs = await Promise.all(DIAGNOSTIC_FILES.map((file) => run('hash-object', file)));
  return {
    diagnosticCommit: await run('rev-parse', 'HEAD'),
    diagnosticBlobs: Object.fromEntries(DIAGNOSTIC_FILES.map((file, i) => [file, blobs[i]!])),
  };
}

interface OriginalResult {
  manifest: {
    repositoryCommit: string;
    protocol: { id: string; sha256: string };
    sourceBlobs: Record<string, string>;
    universe: Record<string, string>;
    candleFiles: Record<string, { sha256: string; candles: number; retrievedAt: string }>;
  };
  results: ProtocolResults;
}

/** Every recorded identity must hold before any of the run commit's code is loaded. */
export async function verifyOriginal(
  run: Git = git,
  expected = ORIGINAL_RESULT,
): Promise<OriginalResult> {
  const bytes = await readFile(expected.path);
  if (sha256(bytes) !== expected.sha256) {
    throw new Error(`${expected.path} is not the recorded result ${expected.sha256}`);
  }
  const original = JSON.parse(bytes.toString('utf8')) as OriginalResult;
  const { repositoryCommit, sourceBlobs } = original.manifest;
  if (repositoryCommit !== expected.repositoryCommit) {
    throw new Error(`The result names ${repositoryCommit}, not ${expected.repositoryCommit}`);
  }
  const files = Object.keys(sourceBlobs);
  const atRun = await Promise.all(files.map((f) => run('rev-parse', `${repositoryCommit}:${f}`)));
  const differing = files.filter((file, i) => atRun[i] !== sourceBlobs[file]);
  if (differing.length) throw new Error(`Run commit blobs differ: ${differing.join(', ')}`);
  // The archived scripts import `@/…` from this checkout, so src must be the run commit's.
  const drift = await run('diff', '--name-only', repositoryCommit, 'HEAD', '--', 'src');
  if (drift) throw new Error(`src differs from the run commit:\n${drift}`);
  return original;
}

/** The archived run commit's modules: the original implementation, unchanged. */
async function loadRunCommit(tree: string, commit: string, run: Git) {
  const tar = join(tree, 'source.tar');
  await run('archive', '--format=tar', '-o', tar, commit);
  await execFileAsync('tar', ['-xf', tar, '-C', tree]);
  const load = (file: string) => import(pathToFileURL(join(tree, file)).href);
  return {
    v1: (await load('scripts/spot24h.ts')) as V1,
    v1Run: (await load('scripts/spot24hRun.ts')) as V1Run,
  };
}

export interface RebuiltRow extends DiagnosticRow {
  split: Split | null;
}

/**
 * Each v1 observation with its entry and exit fills, from the same v1 functions that produced it.
 * Any difference from v1's own category, net return, cell or v stops the diagnosis.
 */
export function rebuildRows(
  v1: V1,
  candlesBySymbol: Readonly<Record<string, readonly HourCandle[]>>,
): { rows: RebuiltRow[]; observations: Observation[] } {
  const { PROTOCOL } = v1;
  const cutoff = Date.parse(PROTOCOL.data.collectionCutoff);
  const rows: RebuiltRow[] = [];
  const observations: Observation[] = [];
  for (const symbol of PROTOCOL.universe.members) {
    const index = v1.indexHourly(candlesBySymbol[symbol] ?? [], cutoff);
    for (const o of v1.pairObservations(symbol, index).observations) {
      const features = v1.featuresAt(index, o.time);
      const bars = v1.consecutive(index, o.time, v1.HORIZON_BARS);
      if (!features || !bars) throw new Error(`${symbol} ${o.time}: no window for an observation`);
      const entry = bars[0]!.open;
      const outcomes = PROTOCOL.scenarios.map(({ targetV, stopV }) => {
        const { category, exit } = v1.resolveOutcome(
          bars,
          entry * (1 + targetV * features.v),
          entry * (1 - stopV * features.v),
        );
        return { category, exit, net: v1.netReturn(entry, exit, category) };
      });
      const same =
        features.cell === o.cell &&
        features.v === o.v &&
        outcomes.every(
          (x, s) => x.category === o.outcomes[s]!.category && x.net === o.outcomes[s]!.net,
        );
      if (!same) throw new Error(`${symbol} ${o.time}: rebuilt fills differ from v1's outcome`);
      rows.push({
        symbol,
        time: o.time,
        day: o.day,
        cell: o.cell,
        v: o.v,
        entry,
        holdClose: bars.at(-1)!.close,
        outcomes,
        split: v1.splitOf(o.time),
      });
      observations.push(o);
    }
  }
  return { rows, observations };
}

/** Largest absolute difference between paired figures; a pair with exactly one null is Infinity. */
export function maxDifference(pairs: readonly [number | null, number | null][]): number {
  return pairs.reduce<number>((worst, [a, b]) => {
    if (a === null || b === null) return a === b ? worst : Infinity;
    return Math.max(worst, Math.abs(a - b));
  }, 0);
}

/** The diagnosis's own aggregates against the recorded evaluation of the same split and fit. */
export function reconcileEvaluation(
  recorded: ProtocolResults['development'][number],
  fit: ScenarioFit,
  rows: readonly DiagnosticRow[],
  s: number,
) {
  const quality = cellQuality(fit, rows, s);
  const attribution = outcomeAttribution(rows, s);
  const decomposition = returnDecomposition(rows, s);
  const countsMatch =
    attribution.categories.every((c) => c.count === recorded.counts[c.category]) &&
    quality.evaluated === recorded.evaluated &&
    rows.length === recorded.observations &&
    quality.cells.every((c, i) => {
      const r = recorded.calibration.cells[i]!;
      return r.cell === c.cell && (c.predicted === null ? r.n === 0 : r.n === c.observations);
    });
  const difference = maxDifference([
    [attribution.meanNet, recorded.meanNetReturn],
    [decomposition.recordedNet, recorded.meanNetReturn],
    [quality.brierMethod, recorded.brier.method],
    [quality.brierBase, recorded.brier.base],
    [quality.deltaBrier, recorded.brier.delta],
    [quality.skillScore, recorded.brier.skillScore],
    [quality.inTheLarge, recorded.calibration.inTheLarge],
    [quality.weightedCellError, recorded.calibration.weightedCellError],
    ...quality.cells.flatMap((c, i): [number | null, number | null][] => [
      [c.predicted, recorded.calibration.cells[i]!.predicted],
      [c.predicted === null ? null : c.observed, recorded.calibration.cells[i]!.observed],
    ]),
  ]);
  return {
    scenario: recorded.scenario,
    countsMatch,
    maxDifference: difference,
    decompositionResidual: decomposition.residual,
    maxRowResidual: decomposition.maxRowResidual,
    pass:
      countsMatch &&
      difference <= TOLERANCE &&
      Math.abs(decomposition.residual ?? Infinity) <= TOLERANCE &&
      decomposition.maxRowResidual <= TOLERANCE,
  };
}

const SPLITS = ['train', 'validation', 'test'] as const;

/** Every diagnostic table, for the rows and fits of one protocol. */
export function diagnose(
  rows: readonly RebuiltRow[],
  fits: { development: ScenarioFit[]; confirmatory: ScenarioFit[] },
  scenarios: readonly { id: string }[],
) {
  const bySplit = Object.fromEntries(
    SPLITS.map((split) => [split, rows.filter((row) => row.split === split)]),
  ) as Record<Split, RebuiltRow[]>;
  const sets: Record<string, readonly RebuiltRow[]> = { ...bySplit, all: rows };
  const perScenario = <T>(f: (s: number) => T) =>
    scenarios.map(({ id }, s) => ({ scenario: id, ...f(s) }));
  const perSet = <T>(names: readonly string[], f: (set: readonly RebuiltRow[], s: number) => T) =>
    Object.fromEntries(names.map((name) => [name, perScenario((s) => f(sets[name]!, s))]));
  // Development: fit on train, scored on validation. Confirmatory: train + validation, on test.
  const scored = {
    validation: { fit: fits.development, fitRows: bySplit.train, rows: bySplit.validation },
    test: {
      fit: fits.confirmatory,
      fitRows: [...bySplit.train, ...bySplit.validation],
      rows: bySplit.test,
    },
  };
  const perScored = <T>(
    f: (
      fit: ScenarioFit,
      rows: readonly RebuiltRow[],
      fitRows: readonly RebuiltRow[],
      s: number,
    ) => T,
  ) =>
    Object.fromEntries(
      Object.entries(scored).map(([name, x]) => [
        name,
        perScenario((s) => f(x.fit[s]!, x.rows, x.fitRows, s)),
      ]),
    );
  const atZeroGross = (category: 'TARGET' | 'STOP') => -decompose(1, 1, category).net;
  return {
    costs: {
      roundTripAtZeroGross: { target: atZeroGross('TARGET'), stopOrTimeout: atZeroGross('STOP') },
    },
    decomposition: perSet([...SPLITS, 'all'], (set, s) => returnDecomposition(set, s)),
    attribution: perSet([...SPLITS, 'all'], (set, s) => outcomeAttribution(set, s)),
    distances: perSet(['validation', 'test', 'all'], (set, s) => levelDistances(set, s)),
    cells: perScored((fit, set, fitRows, s) => ({
      ...cellQuality(fit, set, s),
      /** In-sample returns of each cell over the fit set: what the expectancy selection read. */
      fitReturns: groupQuality(fit, fitRows, s, (row) => row.cell).groups.map((g) => ({
        cell: g.key,
        observations: g.observations,
        meanGross: g.meanGross,
        meanNet: g.meanNet,
      })),
    })),
    byPair: perScored((fit, set, _fitRows, s) => groupQuality(fit, set, s, pairOf)),
    byMonth: perScored((fit, set, _fitRows, s) => groupQuality(fit, set, s, monthOf)),
  };
}

/** The saved candle files, each checked against the SHA-256 the recorded result holds. */
export async function readCandleFiles(
  dataDir: string,
  members: readonly string[],
  recorded: Readonly<Record<string, { sha256: string }>>,
): Promise<Record<string, HourCandle[]>> {
  const files = await Promise.all(
    members.map((symbol) => readFile(join(dataDir, 'klines', `${symbol}-1h.json`))),
  );
  return Object.fromEntries(
    members.map((symbol, i) => {
      if (sha256(files[i]!) !== recorded[symbol]?.sha256) {
        throw new Error(`${symbol} candle file differs from the manifest`);
      }
      return [
        symbol,
        (JSON.parse(files[i]!.toString('utf8')) as { candles: HourCandle[] }).candles,
      ];
    }),
  );
}

/**
 * The run code's fits of the rebuilt observations, and the diagnosis's own aggregates against
 * the recorded ones: split sizes, the current fit, and every figure of both evaluations.
 */
export function reconcile(
  v1: V1,
  recorded: ProtocolResults,
  rows: readonly RebuiltRow[],
  observations: readonly Observation[],
) {
  const inSplit = (split: Split) => observations.filter((o) => v1.splitOf(o.time) === split);
  const fits = {
    development: v1.fitFrequencies(inSplit('train')),
    confirmatory: v1.fitFrequencies([...inSplit('train'), ...inSplit('validation')]),
  };
  const rowsOf = (split: Split) => rows.filter((row) => row.split === split);
  const splitCounts =
    rows.length === recorded.splits.currentFit.observations &&
    SPLITS.every((split) => rowsOf(split).length === recorded.splits[split].observations);
  const currentFitMatches =
    JSON.stringify(v1.fitFrequencies(observations)) === JSON.stringify(recorded.currentFit);
  const evaluations = {
    validation: recorded.development.map((r, s) =>
      reconcileEvaluation(r, fits.development[s]!, rowsOf('validation'), s),
    ),
    test: recorded.confirmatory.map((r, s) =>
      reconcileEvaluation(r, fits.confirmatory[s]!, rowsOf('test'), s),
    ),
  };
  return {
    fits,
    reconciliation: {
      observations: rows.length,
      rowsMatchV1Outcomes: true,
      splitCounts,
      currentFitMatches,
      tolerance: TOLERANCE,
      evaluations,
      pass:
        splitCounts &&
        currentFitMatches &&
        [...evaluations.validation, ...evaluations.test].every((e) => e.pass),
    },
  };
}

export async function runDiagnostic(
  dataDir = DATA_DIR,
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: () => ReturnType<typeof diagnosticIdentity> = diagnosticIdentity,
  run: Git = git,
) {
  const code = await identity();
  const original = await verifyOriginal(run);
  const { manifest, results: recorded } = original;
  await mkdir(resolve(outputDir), { recursive: true });
  const tree = await mkdtemp(join(resolve(outputDir), '.spot-24h-v1-source-'));
  try {
    const { v1, v1Run } = await loadRunCommit(tree, manifest.repositoryCommit, run);
    if (v1.protocolSha256() !== manifest.protocol.sha256)
      throw new Error('Protocol identity differs');

    // 1. The original evaluation, re-executed from the run commit's tree on the saved files. It
    //    checks the universe and records each candle file's SHA-256; its bytes must be the result's.
    const reproduced = await v1Run.runEvaluation(dataDir, join(tree, 'reproduced'), async () => ({
      repositoryCommit: manifest.repositoryCommit,
      sourceBlobs: manifest.sourceBlobs,
    }));
    if (reproduced.contentSha256 !== ORIGINAL_RESULT.sha256) {
      throw new Error(`Re-executed v1 gives ${reproduced.contentSha256}, not the recorded result`);
    }

    // 2. The same observations with their fills, reconciled with the recorded aggregates.
    const candles = await readCandleFiles(
      dataDir,
      v1.PROTOCOL.universe.members,
      manifest.candleFiles,
    );
    const { rows, observations } = rebuildRows(v1, candles);
    const { fits, reconciliation: checks } = reconcile(v1, recorded, rows, observations);
    const reconciliation = { reExecutedResultSha256: reproduced.contentSha256, ...checks };
    if (!reconciliation.pass) {
      throw new Error(`Reconciliation failed: ${JSON.stringify(reconciliation)}`);
    }

    const content = `${JSON.stringify(
      {
        manifest: {
          ...code,
          original: {
            path: ORIGINAL_RESULT.path,
            sha256: ORIGINAL_RESULT.sha256,
            repositoryCommit: manifest.repositoryCommit,
            protocol: manifest.protocol,
            sourceBlobs: manifest.sourceBlobs,
          },
          universe: manifest.universe,
          candleFiles: manifest.candleFiles,
          reconstruction:
            'scripts/spot24h.ts and scripts/spot24hRun.ts from a git archive of the run commit; src identical to it',
        },
        reconciliation,
        diagnostics: diagnose(rows, fits, v1.PROTOCOL.scenarios),
      },
      null,
      2,
    )}\n`;
    const path = join(outputDir, OUTPUT_FILE);
    const status = await saveResearchResults(path, content);
    return {
      status,
      path,
      contentSha256: sha256(content),
      reconciliation: { pass: reconciliation.pass, observations: rows.length },
    };
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}
