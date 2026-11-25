/**
 * Descriptive decomposition of stage D's expected-net error
 * (docs/spot-24h-expected-net-error-decomposition-dev-v1.json). It reads #222's recorded dataset,
 * classifier probabilities and result, checks their identities, reproduces #222's result, and
 * splits each observation's realized-minus-forecast net into a probability component and a
 * payoff component with #222's own forecasts, payoffs and ENTER decisions held fixed. No fit, no
 * revised forecast, no new selection, no network. #222's files are only read. Every return
 * figure is simulated research.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import specJson from '../docs/spot-24h-expected-net-error-decomposition-dev-v1.json';
import { stableSerialize } from '@/lib/stableSerialize';
import {
  CLASSES,
  evaluateStudy,
  expectedNet,
  fitBaseline,
  fitV1,
  fromColumns,
  SPEC as STAGE_D,
  specSha256 as stageDSha256,
  STUDY,
  type ColumnValue,
  type EvaluationId,
  type EvaluationSpec,
  type Klass,
  type PredictionSet,
  type Probabilities,
  type Row,
  type StudyResults,
} from './expectedNet';
import { STUDY_FILES, verifySteps } from './expectedNetRun';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import {
  dayOf,
  dayOrders,
  netReturn,
  ratioInterval,
  splitDays,
  type Category,
  type Interval,
  type Protocol,
  type Split,
} from './spot24h';
import type { Git } from './spot24hDiagnosticRun';

export const SPEC = specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');
const SPEC_FILE = 'docs/spot-24h-expected-net-error-decomposition-dev-v1.json';
const PREFIX = 'spot-24h-expected-net-error-decomposition-dev-v1';
/** decomposition.tolerance: #222's parity tolerance. */
export const TOLERANCE = 1e-12;
const LEVELS: [number, number] = [STAGE_D.uncertainty.levels[0]!, STAGE_D.uncertainty.levels[1]!];
const TARGET_V = STAGE_D.outcome.scenario.targetV;

const sumOf = (values: readonly number[]) => values.reduce((s, x) => s + x, 0);
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const integrityFailure = (cause: string) => new Error(`INTEGRITY_FAILURE: ${cause}`);

// ---------------------------------------------------------------------------------------------
// The identity for one observation

/** decomposition.payoffs: the plug-in's own terms, exactly as #222's expectedNet builds them. */
export const payoffsOf = (v: number, gStop: number, gTimeout: number): Probabilities => [
  netReturn(1, 1 + TARGET_V * v, 'TARGET'),
  netReturn(1, 1 + gStop * v, 'STOP'),
  netReturn(1, 1 + gTimeout * v, 'TIMEOUT'),
];

export interface Terms {
  /** r − E */
  total: number;
  /** probability component A and its per-class terms A_k = (I_k − p̂_k) n̂_k */
  A: number;
  Ak: Probabilities;
  /** payoff component B and its per-class terms B_k = I_k (r − n̂_k) */
  B: number;
  Bk: Probabilities;
}

/**
 * decomposition.identity: r − E = Σ_k (I_k − p̂_k) n̂_k + Σ_k I_k (r − n̂_k). E is the forecast
 * #222 used; a breach of the tolerance is an implementation fault and stops the run.
 */
export function decompose(
  p: Probabilities,
  nHat: Probabilities,
  klass: Klass,
  r: number,
  E: number,
): Terms {
  const I = CLASSES.map((k) => (k === klass ? 1 : 0));
  const Ak = CLASSES.map((_, j) => (I[j]! - p[j]!) * nHat[j]!) as Probabilities;
  const Bk = CLASSES.map((_, j) => I[j]! * (r - nHat[j]!)) as Probabilities;
  const terms = { total: r - E, A: sumOf(Ak), Ak, B: sumOf(Bk), Bk };
  const residuals = [
    E - (p[0] * nHat[0] + p[1] * nHat[1] + p[2] * nHat[2]),
    terms.A + terms.B - terms.total,
  ];
  if (residuals.some((x) => !(Math.abs(x) <= TOLERANCE))) {
    throw new Error(`Identity breached: residuals ${residuals.join(', ')}`);
  }
  return terms;
}

// ---------------------------------------------------------------------------------------------
// One evaluation, its subsets and intervals (#222's day-block bootstrap, unchanged)

export interface Item {
  index: number;
  row: Row;
  p: Probabilities;
  E: number;
  enter: boolean;
  terms: Terms;
}

interface Axis {
  firstDay: number;
  positions: number;
  orders: number[][];
}

/** #222's axisOf and estimate (private there; that file is not edited): one axis per evaluation. */
function axisOf(split: Split, config: Protocol): Axis {
  const [firstDay, lastDay] = splitDays(split, config);
  const positions = lastDay - firstDay + 1;
  return { firstDay, positions, orders: dayOrders(split, positions, config) };
}

export interface Estimate {
  mean: number | null;
  interval95: Interval | null;
}

function estimate(axis: Axis, items: readonly Item[], value: (item: Item) => number): Estimate {
  const numerator = new Float64Array(axis.positions);
  const denominator = new Float64Array(axis.positions);
  let sum = 0;
  for (const item of items) {
    const x = value(item);
    const at = dayOf(item.row.time) - axis.firstDay;
    numerator[at]! += x;
    denominator[at]! += 1;
    sum += x;
  }
  return {
    mean: items.length ? sum / items.length : null,
    interval95: items.length ? ratioInterval(axis.orders, numerator, denominator, LEVELS) : null,
  };
}

const perClass = <T>(f: (k: Klass, j: number) => T) =>
  Object.fromEntries(CLASSES.map((k, j) => [k, f(k, j)])) as Record<Klass, T>;

function subset(axis: Axis, items: readonly Item[]) {
  const n = items.length;
  const mean = (f: (item: Item) => number) => (n ? sumOf(items.map(f)) / n : null);
  const figures = {
    observations: n,
    days: new Set(items.map((i) => dayOf(i.row.time))).size,
    classes: perClass((k, j) => {
      const count = items.filter((i) => i.row.class === k).length;
      return { count, share: n ? count / n : null, meanPredicted: mean((i) => i.p[j]!) };
    }),
    ambiguous: items.filter((i) => i.row.outcome.category === 'AMBIGUOUS').length,
    meanExpected: mean((i) => i.E),
    meanNet: mean((i) => i.row.outcome.net),
    total: estimate(axis, items, (i) => i.terms.total),
    probability: estimate(axis, items, (i) => i.terms.A),
    payoff: estimate(axis, items, (i) => i.terms.B),
    probabilityByClass: perClass((_, j) => estimate(axis, items, (i) => i.terms.Ak[j]!)),
    payoffByClass: perClass((_, j) => estimate(axis, items, (i) => i.terms.Bk[j]!)),
  };
  if (n) {
    const m = (e: Estimate) => e.mean!;
    const residuals = [
      m(figures.probability) + m(figures.payoff) - m(figures.total),
      sumOf(CLASSES.map((k) => m(figures.probabilityByClass[k]))) - m(figures.probability),
      sumOf(CLASSES.map((k) => m(figures.payoffByClass[k]))) - m(figures.payoff),
    ];
    if (residuals.some((x) => !(Math.abs(x) <= TOLERANCE))) {
      throw new Error(`Aggregate identity breached: residuals ${residuals.join(', ')}`);
    }
  }
  return figures;
}
export type Subset = ReturnType<typeof subset>;

/** #222's evaluatePeriod, for C only: the same fit rows, scored rows, forecasts and decisions. */
export function itemsOf(
  rows: readonly Row[],
  evaluation: EvaluationSpec,
  predictions: PredictionSet,
) {
  const fitRows = rows.filter((r) => r.split !== null && evaluation.fit.includes(r.split));
  const baseline = fitBaseline(fitRows);
  const v1 = fitV1(fitRows);
  const { gStop, gTimeout } = baseline;
  if (!baseline.probabilities || predictions.status !== 'FITTED') {
    return { payoffs: { gStop, gTimeout }, items: [] as Item[] };
  }
  const c = new Map(predictions.rows.map(([i, ...p]) => [i, p as Probabilities]));
  const items: Item[] = [];
  rows.forEach((row, index) => {
    const p = c.get(index);
    // scoring.scored: U, V1 and C all forecast. U always does here; V1 needs a supported cell.
    if (row.split !== evaluation.evaluate || !p || !v1.cells[row.cell]?.probabilities) return;
    const E = expectedNet(p, row.v, gStop!, gTimeout!);
    const nHat = payoffsOf(row.v, gStop!, gTimeout!);
    items.push({
      index,
      row,
      p,
      E,
      enter: E > 0,
      terms: decompose(p, nHat, row.class, row.outcome.net, E),
    });
  });
  return { payoffs: { gStop, gTimeout }, items };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation and reading

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** reconciliation: every figure #222 recorded for these subsets, compared exactly. */
function reconcile(
  id: EvaluationId,
  figures: Record<'ALL' | 'ENTER', Subset>,
  enteredOutcomes: Record<Category, number>,
  payoffs: unknown,
  recorded: StudyResults['evaluations'][EvaluationId],
): string[] {
  const found: string[] = [];
  const compare = (path: string, actual: unknown, expected: unknown) => {
    if (!same(actual, expected)) found.push(`${id}.${path}`);
  };
  for (const name of ['ALL', 'ENTER'] as const) {
    const mine = figures[name];
    const theirs = recorded.expectedNetCalibration.C[name];
    compare(`${name}.observations`, mine.observations, theirs.observations);
    compare(`${name}.days`, mine.days, theirs.days);
    compare(`${name}.meanExpected`, mine.meanExpected, theirs.meanExpected);
    compare(`${name}.meanNet`, mine.meanNet, theirs.meanNet);
    compare(`${name}.difference`, mine.total.mean, theirs.difference);
    compare(`${name}.interval95`, mine.total.interval95, theirs.interval95);
  }
  compare('entries', figures.ENTER.observations, recorded.economics.C.entries);
  compare('enteredOutcomes', enteredOutcomes, recorded.economics.C.enteredOutcomes);
  compare('payoffs', payoffs, recorded.fit.payoffs);
  return found;
}

export type Sign = 'NEGATIVE' | 'POSITIVE' | 'UNRESOLVED';
/** reading.sign */
export const signOf = ({ interval95: i }: Estimate): Sign =>
  i && i.high < 0 ? 'NEGATIVE' : i && i.low > 0 ? 'POSITIVE' : 'UNRESOLVED';

const COMPONENTS = ['probability', 'payoff'] as const;
type Component = (typeof COMPONENTS)[number];

/** reading.sign for every component, and reading.accountsFor for the ENTER subset. */
function readingOf(figures: Record<'ALL' | 'ENTER', Subset>) {
  const signs = (s: Subset) => ({
    total: signOf(s.total),
    probability: signOf(s.probability),
    payoff: signOf(s.payoff),
    probabilityByClass: perClass((k) => signOf(s.probabilityByClass[k])),
    payoffByClass: perClass((k) => signOf(s.payoffByClass[k])),
  });
  const enter = figures.ENTER;
  const named = COMPONENTS.filter((c) => signOf(enter[c]) === 'NEGATIVE');
  const share = (c: Component) => (enter.total.mean ? enter[c].mean! / enter.total.mean : null);
  return {
    signs: { ALL: signs(figures.ALL), ENTER: signs(enter) },
    accountsFor: named.length ? named : ('NOT_RESOLVED' as const),
    pointShares: { probability: share('probability'), payoff: share('payoff') },
  };
}
type Reading = ReturnType<typeof readingOf>;

/**
 * reading.consistency. NOT_RESOLVED names no component, so a period that is not resolved cannot
 * agree with the other: CONSISTENT needs both readings resolved and naming the same components.
 */
export function consistency(readings: readonly Reading['accountsFor'][]) {
  const resolved = readings.every((r) => r !== 'NOT_RESOLVED');
  const first = JSON.stringify(readings[0]);
  return resolved && readings.every((r) => JSON.stringify(r) === first)
    ? 'CONSISTENT'
    : 'NOT_CONSISTENT';
}

/** Every evaluation's figures, reconciled with #222's recorded result before any reading. */
export function decomposeStudy(
  rows: readonly Row[],
  predictions: Readonly<Partial<Record<EvaluationId, PredictionSet>>>,
  recorded: StudyResults,
  config: Protocol = STUDY,
) {
  const differences: string[] = [];
  const evaluations = (STAGE_D.periods.evaluations as EvaluationSpec[]).map((evaluation) => {
    const set = predictions[evaluation.id];
    if (!set) throw new Error(`No classifier probabilities for ${evaluation.id}`);
    const { payoffs, items } = itemsOf(rows, evaluation, set);
    const axis = axisOf(evaluation.evaluate, config);
    const entered = items.filter((i) => i.enter);
    const figures = { ALL: subset(axis, items), ENTER: subset(axis, entered) };
    const enteredOutcomes: Record<Category, number> = {
      TARGET: 0,
      STOP: 0,
      TIMEOUT: 0,
      AMBIGUOUS: 0,
    };
    for (const i of entered) enteredOutcomes[i.row.outcome.category] += 1;
    const recordedEvaluation = recorded.evaluations[evaluation.id];
    differences.push(
      ...reconcile(evaluation.id, figures, enteredOutcomes, payoffs, recordedEvaluation),
    );
    return { id: evaluation.id, payoffs, enteredOutcomes, figures };
  });
  const reconciled = differences.length === 0;
  const readings = reconciled
    ? Object.fromEntries(evaluations.map((e) => [e.id, readingOf(e.figures)]))
    : null;
  return {
    status: reconciled ? ('RECONCILED' as const) : ('NOT_RECONCILED' as const),
    reconciliation: { differences },
    evaluations: Object.fromEntries(evaluations.map((e) => [e.id, e])),
    reading: readings && {
      evaluations: readings,
      consistency: consistency(Object.values(readings).map((r) => r.accountsFor)),
    },
  };
}
export type Decomposition = ReturnType<typeof decomposeStudy>;

// ---------------------------------------------------------------------------------------------
// The run: inputs verified, #222 reproduced, output written once

/** #222's study files plus this diagnostic's own; each blob is recorded with the output. */
export const FILES = [SPEC_FILE, 'scripts/expectedNetDecomposition.ts', ...STUDY_FILES] as const;

const execFileAsync = promisify(execFile);
const defaultGit: Git = async (...args) =>
  (await execFileAsync('git', args, { encoding: 'utf8', maxBuffer: 1 << 20 })).stdout.trim();

/** output.identity: the commit names the code only if no tracked file differs from it. */
export async function decompositionIdentity(run: Git = defaultGit) {
  const changed = await run('status', '--porcelain', '--untracked-files=no');
  if (changed)
    throw new Error(`Tracked files differ from HEAD; commit before running:\n${changed}`);
  const blobs = await Promise.all(FILES.map((file) => run('hash-object', file)));
  return {
    codeCommit: await run('rev-parse', 'HEAD'),
    codeBlobs: Object.fromEntries(FILES.map((file, i) => [file, blobs[i] ?? ''])),
  };
}

type Inputs = typeof SPEC.inputs;

async function inputFile(name: string, path: string, expected: string) {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw integrityFailure(`${name} is missing: ${path}`);
  }
  const actual = sha256(bytes);
  if (actual !== expected) throw integrityFailure(`${name} SHA-256 is ${actual}, not ${expected}`);
  return bytes;
}

interface RecordedResultFile {
  manifest: {
    codeCommit: string;
    codeBlobs: Record<string, string>;
    specification: { id: string; sha256: string; fileSha256: string };
    dataset: { sha256: string };
    predictions: { sha256: string };
  };
  results: StudyResults;
}

/** inputs.verification and inputs.reproduction, in that order; returns what the figures read. */
export async function verifiedInputs(inputs: Inputs = SPEC.inputs, git: Git = defaultGit) {
  const spec = inputs.specification;
  await inputFile('stage D specification', spec.path, spec.fileSha256);
  if (stageDSha256() !== spec.sha256) throw integrityFailure('stage D specification differs');
  const datasetBytes = await inputFile('dataset', inputs.dataset.path, inputs.dataset.sha256);
  const predictionsBytes = await inputFile(
    'predictions',
    inputs.predictions.path,
    inputs.predictions.sha256,
  );
  const resultBytes = await inputFile('result', inputs.result.path, inputs.result.sha256);
  const result = JSON.parse(resultBytes.toString('utf8')) as RecordedResultFile;
  const m = result.manifest;
  if (m.codeCommit !== inputs.runCommit)
    throw integrityFailure(`result written at ${m.codeCommit}`);
  if (m.specification.sha256 !== spec.sha256 || m.specification.fileSha256 !== spec.fileSha256)
    throw integrityFailure('result names another specification');
  if (m.dataset.sha256 !== inputs.dataset.sha256)
    throw integrityFailure('result names another dataset');
  if (m.predictions.sha256 !== inputs.predictions.sha256)
    throw integrityFailure('result names other predictions');
  const dataset = JSON.parse(datasetBytes.toString('utf8')) as Parameters<typeof verifySteps>[0] & {
    rows: ColumnValue[][];
    coverage: { pairs: Record<string, unknown> };
  };
  const predictions = JSON.parse(predictionsBytes.toString('utf8')) as Parameters<
    typeof verifySteps
  >[1];
  verifySteps(dataset, predictions, inputs.runCommit, spec.fileSha256, inputs.dataset.sha256);
  const blobs = Object.entries(m.codeBlobs);
  if (blobs.length === 0) throw integrityFailure('result records no code blobs');
  for (const [file, blob] of blobs) {
    const atRun = await git('rev-parse', `${inputs.runCommit}:${file}`).catch(() => '');
    if (atRun !== blob) throw integrityFailure(`${file} at the run commit is not blob ${blob}`);
  }
  const rows = dataset.rows.map(fromColumns);
  const pairs = Object.keys(dataset.coverage.pairs).length;
  const reproduced = evaluateStudy(rows, predictions.evaluations, pairs);
  if (JSON.stringify(reproduced) !== JSON.stringify(result.results))
    throw integrityFailure("#222's evaluateStudy at this commit does not reproduce the result");
  return {
    rows,
    predictions: predictions.evaluations,
    recorded: result.results,
    recordedBlobs: m.codeBlobs,
  };
}

export async function runExpectedNetDecomposition(
  outputDir = RESEARCH_OUTPUT_DIR,
  identity: () => ReturnType<typeof decompositionIdentity> = decompositionIdentity,
  inputs: Inputs = SPEC.inputs,
  git: Git = defaultGit,
) {
  const code = await identity();
  const { rows, predictions, recorded, recordedBlobs } = await verifiedInputs(inputs, git);
  const results = decomposeStudy(rows, predictions, recorded);
  const specification = {
    id: SPEC.specificationId,
    sha256: specSha256(),
    path: SPEC_FILE,
    fileSha256: sha256(await readFile(SPEC_FILE)),
  };
  const content = `${JSON.stringify(
    {
      manifest: {
        ...code,
        specification,
        inputs,
        stageD: {
          runCommit: inputs.runCommit,
          recordedBlobs,
          reproduction: 'BYTE_IDENTICAL',
          verdict: recorded.conclusion.verdict,
        },
        tolerance: TOLERANCE,
        figures: 'Simulated research on historical candles with assumed costs',
      },
      results,
    },
    null,
    2,
  )}\n`;
  const path = join(outputDir, `${PREFIX}-${specification.sha256.slice(0, 12)}.json`);
  const status = await saveResearchResults(path, content);
  return { status, path, contentSha256: sha256(content), summary: summaryOf(results) };
}

const point = (e: Estimate) => ({
  mean: e.mean,
  low: e.interval95?.low ?? null,
  high: e.interval95?.high ?? null,
});

/** Headline figures for the terminal (simulated research); the rest stays in the output file. */
export function summaryOf(results: Decomposition) {
  return {
    status: results.status,
    differences: results.reconciliation.differences,
    reading: results.reading && {
      consistency: results.reading.consistency,
      accountsFor: Object.fromEntries(
        Object.entries(results.reading.evaluations).map(([id, r]) => [id, r.accountsFor]),
      ),
    },
    evaluations: Object.fromEntries(
      Object.entries(results.evaluations).map(([id, e]) => [
        id,
        Object.fromEntries(
          (['ALL', 'ENTER'] as const).map((name) => {
            const s = e.figures[name];
            return [
              name,
              {
                observations: s.observations,
                total: point(s.total),
                probability: point(s.probability),
                payoff: point(s.payoff),
              },
            ];
          }),
        ),
      ]),
    ),
  };
}
