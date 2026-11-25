/**
 * Local steps of stage D (docs/spot-24h-expected-net-t3s3-dev-v1.json). Offline.
 *
 * export: verifies protocol v1, its recorded result, the universe evidence and every saved candle
 * file against their recorded SHA-256, checks v1 parity, and writes the joined observations once.
 * evaluate: verifies the dataset and the classifier probabilities written at the same commit,
 * fits U and V1, computes every metric, gate and the verdict, and writes the result once.
 * Neither writes the protocol, the v1 result, an earlier study or the data. No network, account,
 * order, alert, experiment record or store.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  COLUMNS,
  differences,
  evaluateStudy,
  exportRows,
  fromColumns,
  SPEC,
  specSha256,
  toColumns,
  v1Parity,
  type ColumnValue,
  type PredictionSet,
  type RecordedV1,
  type StudyResults,
} from './expectedNet';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import { protocolSha256 } from './spot24h';
import { verifiedInputs } from './spot24hBreakoutRun';
import { DATA_DIR, type Git } from './spot24hDiagnosticRun';

/** Code of this study whose git blob every output records, the Python step included. */
export const STUDY_FILES = [
  'docs/spot-24h-expected-net-t3s3-dev-v1.json',
  'scripts/expectedNet.ts',
  'scripts/expectedNetRun.ts',
  'scripts/expected_net_classifier.py',
  'scripts/quantile_forecast.py',
  'scripts/quantile-forecast-requirements.txt',
  'scripts/quantileForecast.ts',
  'scripts/spot24h.ts',
  'scripts/spot24hDiagnostic.ts',
  'scripts/spot24hBreakoutRun.ts',
  'scripts/spot24hDiagnosticRun.ts',
  'scripts/swingStructureEvaluation.ts',
  'scripts/scannerResearch.ts',
  'docs/spot-24h-probability.v1.json',
  'docs/quantile-forecast-24h-dev-v1.json',
  'src/lib/indicators.ts',
  'src/lib/candleValidation.ts',
  'src/lib/stableSerialize.ts',
] as const;
const SPEC_FILE = STUDY_FILES[0];
const PREFIX = 'spot-24h-expected-net-t3s3-dev-v1';

const execFileAsync = promisify(execFile);
const git: Git = async (...args) =>
  (await execFileAsync('git', args, { encoding: 'utf8' })).stdout.trim();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** pipeline.identity: the commit names the code only if no tracked file differs from it. */
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
type Identity = () => ReturnType<typeof studyIdentity>;
type Recorded = { path: string; sha256: string; runCommit: string };

async function specification() {
  return {
    id: SPEC.specificationId,
    sha256: specSha256(),
    path: SPEC_FILE,
    fileSha256: sha256(await readFile(SPEC_FILE)),
  };
}

/** verdict.order INTEGRITY_FAILURE: the step stops, writes nothing and names the cause. */
const integrityFailure = (cause: string) => new Error(`INTEGRITY_FAILURE: ${cause}`);

export async function runExpectedNetExport(
  dataDir = DATA_DIR,
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: Identity = studyIdentity,
  recorded: Recorded = SPEC.basis.recordedResult,
) {
  const code = await identity();
  if (protocolSha256() !== SPEC.basis.protocol.sha256)
    throw integrityFailure('protocol v1 differs');
  const { manifest, members, candles } = await verifiedInputs(dataDir, recorded);
  // verifiedInputs checked these bytes' SHA-256; read again for the recorded evaluations.
  const recordedBytes = await readFile(recorded.path);
  if (sha256(recordedBytes) !== recorded.sha256) throw integrityFailure('recorded result changed');
  const { results } = JSON.parse(recordedBytes.toString('utf8')) as { results: RecordedV1 };
  const { rows, coverage } = exportRows(candles, members);
  const parity = v1Parity(candles, members, rows, results);
  if (!parity.pass) throw integrityFailure(`v1 parity: ${parity.differences.join(', ')}`);
  const spec = await specification();
  const content = `${JSON.stringify({
    manifest: {
      ...code,
      specification: spec,
      recordedResult: { path: recorded.path, sha256: recorded.sha256 },
      protocol: manifest.protocol,
      universe: manifest.universe,
      candleFiles: manifest.candleFiles,
    },
    parity,
    coverage,
    columns: COLUMNS,
    rows: rows.map(toColumns),
  })}\n`;
  const name = `${PREFIX}-dataset-${spec.sha256.slice(0, 12)}-${code.codeCommit.slice(0, 12)}.json`;
  const path = join(outputDir, name);
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), coverage: coverage.total, parity };
}

/** The one file of `kind` written at `commit`, or a refusal. */
async function stepFile(outputDir: string, kind: 'dataset' | 'predictions', commit: string) {
  const names = (await readdir(outputDir)).filter(
    (name) =>
      name.startsWith(`${PREFIX}-${kind}-`) && name.endsWith(`-${commit.slice(0, 12)}.json`),
  );
  if (names.length !== 1) {
    throw integrityFailure(
      `expected one ${kind} file at ${commit.slice(0, 12)}, found ${names.length}`,
    );
  }
  const path = join(outputDir, names[0]!);
  const bytes = await readFile(path);
  return { path, bytes, sha256: sha256(bytes) };
}

interface DatasetFile {
  manifest: { codeCommit: string; specification: { id: string; fileSha256: string } };
  columns: string[];
  rows: ColumnValue[][];
  coverage: { pairs: Record<string, unknown> };
  parity: unknown;
}

interface PredictionsFile {
  manifest: {
    codeCommit: string;
    specification: { id: string; fileSha256: string };
    dataset: { path: string; sha256: string };
  };
  environment: unknown;
  evaluations: Record<string, PredictionSet>;
}

/** pipeline.identity and forecasters.C.verifiedParams, before any figure. */
export function verifySteps(
  dataset: DatasetFile,
  predictions: PredictionsFile,
  commit: string,
  specFileSha256: string,
  datasetSha256: string,
) {
  for (const [kind, m] of [
    ['dataset', dataset.manifest],
    ['predictions', predictions.manifest],
  ] as const) {
    if (m.codeCommit !== commit) throw integrityFailure(`${kind} written at ${m.codeCommit}`);
    if (
      m.specification.id !== SPEC.specificationId ||
      m.specification.fileSha256 !== specFileSha256
    )
      throw integrityFailure(`${kind} names another specification`);
  }
  if (predictions.manifest.dataset.sha256 !== datasetSha256)
    throw integrityFailure('the probabilities were fitted on another dataset');
  if (JSON.stringify(dataset.columns) !== JSON.stringify(COLUMNS))
    throw integrityFailure('dataset columns differ');
  const { note: _note, ...params } = SPEC.forecasters.C.verifiedParams;
  for (const [id, set] of Object.entries(predictions.evaluations)) {
    if (set.status === 'FITTED' && differences(set.fit['params'], params).length)
      throw integrityFailure(`${id} estimator parameters differ`);
  }
}

export async function runExpectedNetEvaluate(
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: Identity = studyIdentity,
) {
  const code = await identity();
  const spec = await specification();
  const datasetFile = await stepFile(outputDir, 'dataset', code.codeCommit);
  const predictionsFile = await stepFile(outputDir, 'predictions', code.codeCommit);
  const dataset = JSON.parse(datasetFile.bytes.toString('utf8')) as DatasetFile;
  const predictions = JSON.parse(predictionsFile.bytes.toString('utf8')) as PredictionsFile;
  verifySteps(dataset, predictions, code.codeCommit, spec.fileSha256, datasetFile.sha256);
  const rows = dataset.rows.map(fromColumns);
  // scoring.eligible: every grid decision of every exported member, observation or not.
  const pairs = Object.keys(dataset.coverage.pairs).length;
  const results = evaluateStudy(rows, predictions.evaluations, pairs);
  const content = `${JSON.stringify(
    {
      manifest: {
        ...code,
        specification: spec,
        dataset: { path: datasetFile.path, sha256: datasetFile.sha256, manifest: dataset.manifest },
        predictions: {
          path: predictionsFile.path,
          sha256: predictionsFile.sha256,
          manifest: predictions.manifest,
        },
        environment: predictions.environment,
      },
      coverage: dataset.coverage,
      parity: dataset.parity,
      results,
    },
    null,
    2,
  )}\n`;
  const path = join(outputDir, `${PREFIX}-${spec.sha256.slice(0, 12)}.json`);
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), summary: resultsSummary(results) };
}

const point = (e: { mean: number | null; interval95: { low: number; high: number } | null }) => ({
  mean: e.mean,
  low: e.interval95?.low ?? null,
  high: e.interval95?.high ?? null,
});

/** The headline figures (simulated research); everything else stays in the git-ignored file. */
export function resultsSummary(results: StudyResults) {
  const evaluations = Object.fromEntries(
    Object.entries(results.evaluations).map(([id, e]) => [
      id,
      {
        coverage: e.coverage.coverage,
        scored: e.coverage.scored,
        brier: {
          ...e.brier.threeClass,
          CminusU: point(e.brier.CminusU),
          CminusV1: point(e.brier.CminusV1),
        },
        enterCalibration: {
          label: e.expectedNetCalibration.C.ENTER.label,
          observations: e.expectedNetCalibration.C.ENTER.observations,
          difference: e.expectedNetCalibration.C.ENTER.difference,
        },
        economics: Object.fromEntries(
          Object.entries(e.economics).map(([name, x]) => [
            name,
            {
              entries: x.entries,
              perOpportunity: point(x.perOpportunity),
              perTrade: point(x.perTrade),
            },
          ]),
        ),
      },
    ]),
  );
  return { conclusion: { ...results.conclusion, checks: undefined }, evaluations };
}
