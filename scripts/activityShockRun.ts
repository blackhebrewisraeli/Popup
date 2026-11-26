/**
 * Local steps of the activityShock24h screen (docs/spot-24h-activity-shock-increment-dev-v1.json).
 *
 * retrieve: the one bounded public retrieval (380 unauthenticated GET /api/v3/klines requests on
 * api.binance.com, no credentials), written once to a new git-ignored directory with a manifest,
 * then validated offline (validation.json) with exact OHLC and presence parity against v1's saved
 * candles, which are opened read-only and hashed before and after.
 * export: verifies every input, reproduces #222's rows from v1's candles, computes
 * activityShock24h and writes the joined dataset once. No fit, no metric.
 * evaluate: verifies the dataset and both arms' probabilities written at the same commit, computes
 * every metric, interval, floor and the verdict, and writes the result once.
 * No account, order, alert, experiment record, store or production change.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ACTIVITY,
  COLUMNS,
  countStatuses,
  coverageOf,
  buildDataset,
  evaluateScreen,
  EVALUATIONS,
  fromColumns,
  pairParity,
  planRequests,
  priceExclusionAt,
  rawName,
  runRetrieval,
  SPEC,
  specSha256,
  stageDParity,
  toColumns,
  validatePair,
  windowHoursBySplit,
  type ActivityHour,
  type Predictions,
  type RequestLog,
  type RetrievalIo,
  type SavedCandle,
  type ScreenResults,
} from './activityShock';
import {
  COLUMNS as STAGE_D_COLUMNS,
  differences,
  exportRows,
  fromColumns as stageDFromColumns,
  type ColumnValue as StageDColumnValue,
} from './expectedNet';
import { decisionTimes } from './quantileForecast';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import { indexHourly, PROTOCOL, protocolSha256, type HourCandle } from './spot24h';
import { verifiedInputs } from './spot24hBreakoutRun';
import { DATA_DIR, type Git } from './spot24hDiagnosticRun';

/** Code of this study whose git blob every output records, the Python step included. */
export const STUDY_FILES = [
  'docs/spot-24h-activity-shock-increment-dev-v1.json',
  'scripts/activityShock.ts',
  'scripts/activityShockRun.ts',
  'scripts/activity_shock_classifier.py',
  'scripts/binanceActivityProbe.ts',
  'scripts/expectedNet.ts',
  'scripts/expectedNetRun.ts',
  'scripts/expected_net_classifier.py',
  'scripts/quantile_forecast.py',
  'scripts/quantile-forecast-requirements.txt',
  'scripts/quantileForecast.ts',
  'scripts/spot24h.ts',
  'scripts/spot24hDiagnostic.ts',
  'scripts/spot24hBreakoutRun.ts',
  'scripts/spot24hBreadthRun.ts',
  'scripts/spot24hDiagnosticRun.ts',
  'scripts/swingStructureEvaluation.ts',
  'scripts/scannerResearch.ts',
  'docs/spot-24h-probability.v1.json',
  'docs/quantile-forecast-24h-dev-v1.json',
  'docs/spot-24h-expected-net-t3s3-dev-v1.json',
  'src/lib/indicators.ts',
  'src/lib/candleValidation.ts',
  'src/lib/stableSerialize.ts',
] as const;
const SPEC_FILE = STUDY_FILES[0];
const PREFIX = 'spot-24h-activity-shock-increment-dev-v1';
/** retrieval.storage.directory */
export const RETRIEVAL_DIR = '.zerochart-market-data/spot-24h-activity-shock-increment-dev-v1';
const CUTOFF = Date.parse(PROTOCOL.data.collectionCutoff);

const execFileAsync = promisify(execFile);
const git: Git = async (...args) =>
  (await execFileAsync('git', args, { encoding: 'utf8' })).stdout.trim();
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const integrityFailure = (cause: string) => new Error(`INTEGRITY_FAILURE: ${cause}`);

/** pipeline.identity: the commit names the code only if no tracked file differs from it. */
export async function studyIdentity(run: Git = git) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed) {
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  }
  const blobs = await Promise.all(STUDY_FILES.map((file) => run('hash-object', file)));
  return {
    codeCommit: await run('rev-parse', 'HEAD'),
    codeBlobs: Object.fromEntries(STUDY_FILES.map((file, i) => [file, blobs[i] ?? ''])),
  };
}
type Identity = () => ReturnType<typeof studyIdentity>;

export async function specification(path: string = SPEC_FILE) {
  return {
    id: SPEC.specificationId,
    revision: SPEC.revision,
    sha256: specSha256(),
    path: SPEC_FILE as string,
    fileSha256: sha256(await readFile(path)),
  };
}
type Specification = Awaited<ReturnType<typeof specification>>;

/** pipeline.retrieve: nothing is fetched unless the frozen revision records resolved terms. */
export function assertTermsResolved(spec: { dataSource: { terms: { status: string } } } = SPEC) {
  if (spec.dataSource.terms.status !== 'RESOLVED') {
    throw new Error(`Refusing: dataSource.terms.status is ${spec.dataSource.terms.status}`);
  }
}

/** retrieval.storage.separation: SHA-256 of v1's universe and every member's candle file. */
export async function v1DirectoryHashes(
  dataDir = DATA_DIR,
  members: readonly string[] = PROTOCOL.universe.members,
) {
  const files = ['universe.json', ...members.map((m) => `klines/${m}-1h.json`)];
  const hashes = await Promise.all(
    files.map(async (f) => sha256(await readFile(join(dataDir, f)))),
  );
  return Object.fromEntries(files.map((f, i) => [f, hashes[i]!]));
}

// ---------------------------------------------------------------------------------------------
// retrieve

export interface RetrieveOptions {
  outDir?: string;
  dataDir?: string;
  identity?: Identity;
  io?: Omit<RetrievalIo, 'save'>;
  members?: readonly string[];
  specFile?: string;
}

const liveIo: Omit<RetrievalIo, 'save'> = {
  fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(15_000) }),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  now: Date.now,
};

export async function runActivityRetrieve(options: RetrieveOptions = {}) {
  const {
    outDir = RETRIEVAL_DIR,
    dataDir = DATA_DIR,
    identity = studyIdentity,
    io = liveIo,
    members = PROTOCOL.universe.members,
    specFile = SPEC_FILE,
  } = options;
  assertTermsResolved();
  const code = await identity();
  const spec = await specification(specFile);
  const before = await v1DirectoryHashes(dataDir, members);
  await mkdir(join(outDir, '..'), { recursive: true });
  await mkdir(outDir); // EEXIST: write-once, the retrieval already ran
  await mkdir(join(outDir, 'raw'));
  const requests = planRequests(members);
  const startedAt = new Date(io.now()).toISOString();
  const { log, stopped } = await runRetrieval(requests, {
    ...io,
    save: (name, bytes) => writeFile(join(outDir, name), bytes, { flag: 'wx' }),
  });
  const manifest = {
    specification: spec,
    ...code,
    host: 'api.binance.com',
    startedAt,
    finishedAt: new Date(io.now()).toISOString(),
    status: stopped ? 'RETRIEVAL_INCOMPLETE' : 'COMPLETE',
    stopped,
    requestsPlanned: requests.length,
    requestsCounted: log.filter((e) => e.attempt === 1).length,
    rateLimitRetries: log.filter((e) => e.attempt === 2).length,
    v1DirectoryBefore: before,
    log,
  };
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  if (stopped) return { status: 'RETRIEVAL_INCOMPLETE' as const, stopped, requests: log.length };
  const { content, validation } = await computeValidation(outDir, dataDir, members);
  await writeFile(join(outDir, 'validation.json'), content, { flag: 'wx' });
  return {
    status: 'COMPLETE' as const,
    requestsCounted: manifest.requestsCounted,
    rateLimitRetries: manifest.rateLimitRetries,
    maxUsedWeight1m: Math.max(0, ...log.map((e) => e.usedWeight1m ?? 0)),
    total: validation.total,
    pass: validation.pass,
  };
}

interface RetrievalManifest {
  specification: Specification;
  codeCommit: string;
  status: string;
  stopped: string | null;
  requestsPlanned: number;
  requestsCounted: number;
  v1DirectoryBefore: Record<string, string>;
  log: RequestLog[];
}

async function readV1(dataDir: string, symbol: string): Promise<Map<number, SavedCandle>> {
  const file = JSON.parse(
    await readFile(join(dataDir, 'klines', `${symbol}-1h.json`), 'utf8'), // NOSONAR(S9382)
  ) as { candles: SavedCandle[] };
  return new Map(file.candles.map((c) => [c.timestamp, c]));
}

/**
 * validation: every saved body checked against the manifest's hash, every hour classified, OHLC
 * and presence parity per pair, v1's directory hashed again. Deterministic, so the export
 * recomputes it and requires the saved file to equal it byte for byte.
 */
export async function computeValidation(
  outDir: string,
  dataDir = DATA_DIR,
  members: readonly string[] = PROTOCOL.universe.members,
) {
  const manifest = JSON.parse(
    await readFile(join(outDir, 'manifest.json'), 'utf8'),
  ) as RetrievalManifest;
  const plan = planRequests(members);
  const pairs: Record<string, unknown> = {};
  const hoursByPair: Record<string, ReturnType<typeof validatePair>['hours']> = {};
  const all: { status: ActivityHour['status'] }[] = [];
  let parityPass = true;
  let responseIssues = 0;
  for (const symbol of members) {
    const responses = [];
    for (const request of plan.filter((r) => r.symbol === symbol)) {
      const entry = [...manifest.log]
        .reverse()
        .find((e) => e.symbol === symbol && e.k === request.k && e.status === 200);
      if (!entry) throw integrityFailure(`no 200 response for ${symbol} k=${request.k}`);
      const bytes = await readFile(join(outDir, rawName(request))); // NOSONAR(S9382)
      if (sha256(bytes) !== entry.sha256) throw integrityFailure(`${rawName(request)} changed`);
      responses.push({
        request,
        body: JSON.parse(bytes.toString('utf8')) as unknown,
        sentAt: Date.parse(entry.sentAt),
      });
    }
    const { hours, responseIssues: issues } = validatePair(responses);
    const parity = pairParity(hours, await readV1(dataDir, symbol)); // NOSONAR(S9382)
    parityPass &&= parity.pass;
    responseIssues += issues.length;
    hoursByPair[symbol] = hours;
    all.push(...hours);
    const notValid = hours.filter((h) => h.status === 'MISSING' || h.status === 'INVALID');
    pairs[symbol] = {
      hours: hours.length,
      status: countStatuses(hours),
      requests: responses.map(({ request, body }) => ({
        k: request.k,
        rows: Array.isArray(body) ? body.length : null,
        expectedRows: request.expectedRows,
        status: countStatuses(
          hours.filter((h) => h.openTime >= request.startTime && h.openTime <= request.endTime),
        ),
      })),
      windowHoursBySplit: windowHoursBySplit(hours, decisionTimes()),
      responseIssues: issues,
      notValid: notValid.map(({ openTime, status, issues: why }) => ({
        openTime,
        status,
        issues: why,
      })),
      validZero: hours.filter((h) => h.status === 'VALID_ZERO').map((h) => h.openTime),
      issueCounts: hours.reduce<Record<string, number>>((acc, h) => {
        for (const issue of h.issues) acc[issue] = (acc[issue] ?? 0) + 1;
        return acc;
      }, {}),
      ignoreFieldValues: [...new Set(hours.map((h) => JSON.stringify(h.ignoreField ?? null)))].sort(
        (a, b) => a.localeCompare(b),
      ),
      ohlcParity: {
        compared: parity.compared,
        mismatches: parity.mismatches,
        retrievedOnly: parity.retrievedOnly,
        v1Only: parity.v1Only,
        pass: parity.pass,
      },
    };
  }
  const after = await v1DirectoryHashes(dataDir, members);
  const v1Unchanged = differences(after, manifest.v1DirectoryBefore).length === 0;
  const validation = {
    specification: manifest.specification,
    retrievalCommit: manifest.codeCommit,
    total: { hours: all.length, status: countStatuses(all), responseIssues },
    ohlcParityPass: parityPass,
    v1DirectoryAfter: after,
    v1DirectoryUnchanged: v1Unchanged,
    pass: parityPass && v1Unchanged,
    pairs,
  };
  return { content: `${JSON.stringify(validation, null, 2)}\n`, validation, hoursByPair, manifest };
}

// ---------------------------------------------------------------------------------------------
// export

export interface ExportOptions {
  retrievalDir?: string;
  dataDir?: string;
  outputDir?: string;
  identity?: Identity;
}

async function verifyFile(path: string, expected: string) {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expected)
    throw integrityFailure(`${path} differs from its recorded SHA-256`);
  return bytes;
}

export async function runActivityExport(options: ExportOptions = {}) {
  const {
    retrievalDir = RETRIEVAL_DIR,
    dataDir = DATA_DIR,
    outputDir = RESEARCH_OUTPUT_DIR,
    identity = studyIdentity,
  } = options;
  assertTermsResolved();
  const code = await identity();
  const spec = await specification();
  if (protocolSha256() !== SPEC.basis.protocol.sha256)
    throw integrityFailure('protocol v1 differs');
  // The retrieval: same specification and commit, complete, and its validation reproduced exactly.
  const manifestBytes = await readFile(join(retrievalDir, 'manifest.json'));
  const { content, validation, hoursByPair, manifest } = await computeValidation(
    retrievalDir,
    dataDir,
  );
  if (differences(manifest.specification, spec).length) {
    throw integrityFailure('the retrieval names another specification');
  }
  if (manifest.codeCommit !== code.codeCommit) {
    throw integrityFailure(`the retrieval was written at ${manifest.codeCommit}`);
  }
  const counted = manifest.log.filter((e) => e.attempt === 1).length;
  if (
    manifest.status !== 'COMPLETE' ||
    manifest.stopped !== null ||
    counted !== manifest.requestsPlanned
  ) {
    throw integrityFailure('the retrieval is incomplete');
  }
  const validationBytes = await readFile(join(retrievalDir, 'validation.json'));
  if (validationBytes.toString('utf8') !== content)
    throw integrityFailure('validation.json differs');
  if (!validation.v1DirectoryUnchanged) throw integrityFailure("v1's directory changed");
  if (!validation.ohlcParityPass) throw integrityFailure('OHLC parity with v1 failed');
  // v1's candles and #222's recorded dataset, hash-verified.
  const {
    manifest: v1,
    members,
    candles,
  } = await verifiedInputs(dataDir, SPEC.basis.recordedResult);
  const source = SPEC.basis.estimatorSource;
  await verifyFile(source.path, source.fileSha256);
  const stageDBytes = await verifyFile(source.dataset.path, source.dataset.sha256);
  await verifyFile(source.predictions.path, source.predictions.sha256);
  await verifyFile(source.result.path, source.result.sha256);
  const stageD = JSON.parse(stageDBytes.toString('utf8')) as {
    columns: string[];
    rows: StageDColumnValue[][];
  };
  if (differences(stageD.columns, [...STAGE_D_COLUMNS]).length) {
    throw integrityFailure("#222's dataset columns differ");
  }
  const recorded = stageD.rows.map(stageDFromColumns);
  const parity = stageDParity(exportRows(candles, members).rows, recorded);
  if (!parity.pass) throw integrityFailure(`#222 row parity: ${parity.first.join(', ')}`);
  const activityHours = Object.fromEntries(
    members.map((m) => [m, new Map(hoursByPair[m]!.map((h) => [h.openTime, h]))]),
  );
  const indexes = new Map(
    members.map((m) => [
      m,
      indexHourly((candles as Record<string, HourCandle[]>)[m] ?? [], CUTOFF),
    ]),
  );
  const rows = buildDataset(members, decisionTimes(), recorded, activityHours, (m, t) =>
    priceExclusionAt(indexes.get(m)!, t),
  );
  const coverage = coverageOf(rows);
  const body = `${JSON.stringify({
    manifest: {
      ...code,
      specification: spec,
      node: { version: process.version, platform: process.platform, arch: process.arch },
      inputs: {
        protocol: v1.protocol,
        recordedResult: {
          path: SPEC.basis.recordedResult.path,
          sha256: SPEC.basis.recordedResult.sha256,
        },
        universe: v1.universe,
        candleFiles: v1.candleFiles,
        stageD: {
          specification: {
            path: source.path,
            sha256: source.sha256,
            fileSha256: source.fileSha256,
          },
          dataset: source.dataset,
          predictions: source.predictions,
          result: source.result,
        },
        retrieval: {
          directory: retrievalDir,
          manifest: { sha256: sha256(manifestBytes), commit: manifest.codeCommit },
          validation: { sha256: sha256(validationBytes) },
        },
      },
    },
    coverage,
    hours: {
      total: validation.total,
      pairs: Object.fromEntries(
        Object.entries(validation.pairs).map(([m, p]) => {
          const { status, windowHoursBySplit } = p as {
            status: unknown;
            windowHoursBySplit: unknown;
          };
          return [m, { status, windowHoursBySplit }];
        }),
      ),
    },
    parity: { stageD: parity, ohlcParityPass: validation.ohlcParityPass },
    columns: COLUMNS,
    rows: rows.map(toColumns),
  })}\n`;
  const name = `${PREFIX}-dataset-${spec.sha256.slice(0, 12)}-${code.codeCommit.slice(0, 12)}.json`;
  const path = join(outputDir, name);
  const status = await saveResearchResults(path, body);
  return {
    status,
    path,
    contentSha256: sha256(body),
    rows: rows.length,
    coverage: coverage.pooled,
    stageDParity: parity.pass,
    activityColumn: ACTIVITY,
  };
}

// ---------------------------------------------------------------------------------------------
// evaluate

/** The one file of `kind` written at `commit`, or a refusal. */
async function stepFile(outputDir: string, kind: 'dataset' | 'predictions', commit: string) {
  const names = (await readdir(outputDir)).filter(
    (n) => n.startsWith(`${PREFIX}-${kind}-`) && n.endsWith(`-${commit.slice(0, 12)}.json`),
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
  manifest: { codeCommit: string; specification: Specification };
  columns: string[];
  rows: (string | number | null)[][];
  coverage: unknown;
  hours: unknown;
  parity: unknown;
}

interface PredictionsFile {
  manifest: {
    codeCommit: string;
    specification: Specification;
    dataset: { path: string; sha256: string };
  };
  environment: unknown;
  evaluations: Predictions;
  reproductionOfC: unknown;
}

/** Both steps were written at this commit, under this specification, the second on this dataset. */
function verifyManifests(
  dataset: DatasetFile,
  predictions: PredictionsFile,
  commit: string,
  spec: Specification,
  datasetSha256: string,
) {
  for (const [kind, m] of [
    ['dataset', dataset.manifest],
    ['predictions', predictions.manifest],
  ] as const) {
    if (m.codeCommit !== commit) throw integrityFailure(`${kind} written at ${m.codeCommit}`);
    if (m.specification.id !== spec.id || m.specification.fileSha256 !== spec.fileSha256) {
      throw integrityFailure(`${kind} names another specification`);
    }
  }
  if (predictions.manifest.dataset.sha256 !== datasetSha256) {
    throw integrityFailure('the probabilities were fitted on another dataset');
  }
}

/** Every evaluation has both arms, and every fitted estimator has the verified parameters. */
function verifyArms(predictions: PredictionsFile, verifiedParams: Record<string, unknown>) {
  for (const e of EVALUATIONS) {
    for (const arm of ['A', 'B'] as const) {
      const set = predictions.evaluations[e.id]?.[arm];
      if (!set) throw integrityFailure(`no probabilities for ${e.id} ${arm}`);
      if (set.status === 'FITTED' && differences(set.fit['params'], verifiedParams).length) {
        throw integrityFailure(`${e.id} ${arm} estimator parameters differ`);
      }
    }
  }
}

/** pipeline.identity and estimator.verifiedParams, before any figure. */
export function verifySteps(
  dataset: DatasetFile,
  predictions: PredictionsFile,
  commit: string,
  spec: Specification,
  datasetSha256: string,
  verifiedParams: Record<string, unknown>,
) {
  verifyManifests(dataset, predictions, commit, spec, datasetSha256);
  if (differences(dataset.columns, [...COLUMNS]).length) {
    throw integrityFailure('dataset columns differ');
  }
  verifyArms(predictions, verifiedParams);
}

export async function runActivityEvaluate(
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: Identity = studyIdentity,
) {
  const code = await identity();
  const spec = await specification();
  const datasetFile = await stepFile(outputDir, 'dataset', code.codeCommit);
  const predictionsFile = await stepFile(outputDir, 'predictions', code.codeCommit);
  const dataset = JSON.parse(datasetFile.bytes.toString('utf8')) as DatasetFile;
  const predictions = JSON.parse(predictionsFile.bytes.toString('utf8')) as PredictionsFile;
  const stageDSpec = JSON.parse(
    (
      await verifyFile(SPEC.basis.estimatorSource.path, SPEC.basis.estimatorSource.fileSha256)
    ).toString('utf8'),
  ) as { forecasters: { C: { verifiedParams: Record<string, unknown> } } };
  const { note: _note, ...params } = stageDSpec.forecasters.C.verifiedParams;
  verifySteps(dataset, predictions, code.codeCommit, spec, datasetFile.sha256, params);
  const results = evaluateScreen(dataset.rows.map(fromColumns), predictions.evaluations);
  const content = `${JSON.stringify(
    {
      manifest: {
        ...code,
        specification: spec,
        node: { version: process.version, platform: process.platform, arch: process.arch },
        dataset: { path: datasetFile.path, sha256: datasetFile.sha256, manifest: dataset.manifest },
        predictions: {
          path: predictionsFile.path,
          sha256: predictionsFile.sha256,
          manifest: predictions.manifest,
        },
        environment: predictions.environment,
      },
      datasetCoverage: dataset.coverage,
      hours: dataset.hours,
      parity: dataset.parity,
      reproductionOfC: predictions.reproductionOfC,
      results,
    },
    null,
    2,
  )}\n`;
  const path = join(outputDir, `${PREFIX}-${spec.sha256.slice(0, 12)}.json`);
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), summary: resultsSummary(results) };
}

const point = (e: {
  mean: number | null;
  interval95: { low: number; high: number; defined: number } | null;
}) => ({
  mean: e.mean,
  low: e.interval95?.low ?? null,
  high: e.interval95?.high ?? null,
  defined: e.interval95?.defined ?? null,
});

/** The headline figures; everything else stays in the git-ignored result file. */
export function resultsSummary(results: ScreenResults) {
  return {
    verdict: results.conclusion.verdict,
    failingFloors: results.conclusion.failingFloors,
    labels: results.conclusion.labels,
    conditions: results.conclusion.conditions,
    coverage: results.coverage,
    evaluations: Object.fromEntries(
      Object.entries(results.evaluations).map(([id, e]) => [
        id,
        {
          status: e.status,
          observations: e.observations,
          days: e.days,
          brierA: e.metrics?.brier.A ?? null,
          brierB: e.metrics?.brier.B ?? null,
          BminusA: e.metrics ? point(e.metrics.brier.primary) : null,
          relative: e.metrics?.brier.relative ?? null,
          leaveOneMonthOutMaximum: e.metrics?.monthly.leaveOneMonthOut.maximum ?? null,
          monthsNegative: e.metrics?.monthly.monthsNegative ?? null,
          months: e.metrics?.monthly.table.length ?? null,
        },
      ]),
    ),
  };
}
