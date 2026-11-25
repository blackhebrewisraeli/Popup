import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classOf,
  COLUMNS,
  evaluateStudy,
  fitBaseline,
  SPEC as STAGE_D,
  specSha256 as stageDSha256,
  STUDY,
  toColumns,
  type EvaluationId,
  type EvaluationSpec,
  type Klass,
  type PredictionSet,
  type Probabilities,
  type Row,
} from './expectedNet';
import {
  consistency,
  decompose,
  decomposeStudy,
  itemsOf,
  payoffsOf,
  runExpectedNetDecomposition,
  SPEC,
  signOf,
  TOLERANCE,
} from './expectedNetDecomposition';
import { mulberry32 } from './opportunityAnalysis';
import { decisionTimes, FEATURES } from './quantileForecast';
import { CELLS, netReturn, splitOf, type Category, type Protocol } from './spot24h';
import type { Git } from './spot24hDiagnosticRun';

const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const FAST: Protocol = { ...STUDY, uncertainty: { ...STUDY.uncertainty, replicates: 200 } };
const [DEVELOPMENT, FINAL] = STAGE_D.periods.evaluations as [EvaluationSpec, EvaluationSpec];

// ---------------------------------------------------------------------------------------------
// Synthetic rows on v1's grid: classes from known probabilities, stops that sometimes gap and
// timeouts spread around zero. Never market data.

const V = 0.01;
const HIGH: Probabilities = [0.6, 0.2, 0.2];
const LOW: Probabilities = [0.2, 0.5, 0.3];

function syntheticRows(pairs: number, seed: number): Row[] {
  const random = mulberry32(seed);
  const rows: Row[] = [];
  for (const time of decisionTimes()) {
    for (let k = 0; k < pairs; k += 1) {
      const features = FEATURES.map(() => 0);
      features[0] = random() < 0.5 ? 1 : -1;
      const p = features[0] > 0 ? HIGH : LOW;
      const u = random();
      const klass: Klass = u < p[0] ? 'TARGET' : u < p[0] + p[1] ? 'STOP' : 'TIMEOUT';
      const category: Category = klass === 'STOP' && random() < 0.05 ? 'AMBIGUOUS' : klass;
      const gross = {
        TARGET: 3 * V,
        STOP: -3 * V - (random() < 0.1 ? 0.002 : 0),
        TIMEOUT: (random() - 0.6) * 2 * V,
      }[klass];
      const outcome = { category, bar: 24, gross, net: netReturn(1, 1 + gross, category) };
      rows.push({
        symbol: `P${k}USDT`,
        time,
        split: splitOf(time),
        features,
        cell: CELLS[Math.floor(random() * CELLS.length)]!,
        v: V,
        outcome,
        class: classOf(category),
        overshoot: outcome,
        orderingNet: outcome.net,
      });
    }
  }
  return rows;
}

/** An overconfident C: the true probabilities pushed toward TARGET where it is likelier. */
const overconfident = (r: Row): Probabilities =>
  r.features[0]! > 0 ? [0.7, 0.12, 0.18] : [0.2, 0.5, 0.3];

function predictionsFor(rows: readonly Row[], p: (r: Row) => Probabilities) {
  return Object.fromEntries(
    STAGE_D.periods.evaluations.map((e) => {
      const fit = fitBaseline(rows.filter((r) => r.split !== null && e.fit.includes(r.split)));
      const out: [number, number, number, number][] = [];
      rows.forEach((r, i) => {
        if (r.split === e.evaluate) out.push([i, ...p(r)]);
      });
      const set: PredictionSet = {
        status: 'FITTED',
        fit: { observations: fit.observations, classes: fit.classes },
        rows: out,
      };
      return [e.id, set];
    }),
  ) as Record<EvaluationId, PredictionSet>;
}

const ROWS = syntheticRows(2, 7);
const PREDICTIONS = predictionsFor(ROWS, overconfident);
const RECORDED = evaluateStudy(ROWS, PREDICTIONS, 2, FAST);
const STUDY_RESULT = decomposeStudy(ROWS, PREDICTIONS, RECORDED, FAST);

// ---------------------------------------------------------------------------------------------

describe('the identity for one observation', () => {
  const nHat = payoffsOf(0.012, -3.1, -0.05);
  const E = (p: Probabilities, n: Probabilities) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];

  it('adds the probability and payoff components to realized minus forecast', () => {
    const random = mulberry32(3);
    for (let t = 0; t < 1000; t += 1) {
      const a = random();
      const b = random() * (1 - a);
      const p: Probabilities = [a, b, 1 - a - b];
      const klass = (['TARGET', 'STOP', 'TIMEOUT'] as const)[t % 3]!;
      const r = (random() - 0.5) * 0.1;
      const x = decompose(p, nHat, klass, r, E(p, nHat));
      expect(Math.abs(x.A + x.B - x.total)).toBeLessThanOrEqual(TOLERANCE);
      expect(x.Ak.reduce((s, y) => s + y, 0)).toBe(x.A);
      expect(x.Bk.reduce((s, y) => s + y, 0)).toBe(x.B);
      // B lives only in the row's own class.
      expect(
        x.Bk.filter((y, j) => y !== 0 && j !== ['TARGET', 'STOP', 'TIMEOUT'].indexOf(klass)),
      ).toEqual([]);
    }
  });

  it('is all probability error when exits land on the assumed payoffs', () => {
    const p: Probabilities = [0.5, 0.3, 0.2];
    for (const [j, klass] of (['TARGET', 'STOP', 'TIMEOUT'] as const).entries()) {
      const x = decompose(p, nHat, klass, nHat[j]!, E(p, nHat));
      expect(x.B).toBe(0);
      expect(Math.abs(x.A - x.total)).toBeLessThanOrEqual(TOLERANCE);
      expect(x.A).not.toBe(0);
    }
  });

  it('is all payoff error when the probabilities are certain and right', () => {
    const x = decompose([0, 0, 1], nHat, 'TIMEOUT', -0.02, nHat[2]);
    expect(x.A).toBe(0);
    expect(x.B).toBe(-0.02 - nHat[2]);
    expect(x.B).toBe(x.total);
  });

  it('lets the two components cancel', () => {
    const p: Probabilities = [0.5, 0, 0.5];
    const e = E(p, nHat);
    // Half TARGET for a TIMEOUT (A < 0) whose exit beat the assumed timeout payoff by as much.
    const x = decompose(p, nHat, 'TIMEOUT', e, e);
    expect(x.total).toBe(0);
    expect(x.A).toBeLessThan(-0.01);
    expect(x.B).toBeGreaterThan(0.01);
    expect(Math.abs(x.A + x.B)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('refuses a forecast that is not the plug-in of these terms', () => {
    const p: Probabilities = [0.5, 0.3, 0.2];
    expect(() => decompose(p, nHat, 'STOP', 0, E(p, nHat) + 1e-9)).toThrow('Identity breached');
  });

  it("builds the payoffs exactly as #222's plug-in does", () => {
    expect(payoffsOf(0.012, -3.1, -0.05)).toEqual([
      netReturn(1, 1 + 3 * 0.012, 'TARGET'),
      netReturn(1, 1 + -3.1 * 0.012, 'STOP'),
      netReturn(1, 1 + -0.05 * 0.012, 'TIMEOUT'),
    ]);
  });
});

describe('the decomposition of a study', { timeout: 60_000 }, () => {
  it("reconciles exactly with #222's recorded expected-net calibration and selection", () => {
    expect(STUDY_RESULT.status).toBe('RECONCILED');
    expect(STUDY_RESULT.reconciliation.differences).toEqual([]);
    for (const id of ['development', 'final'] as const) {
      const mine = STUDY_RESULT.evaluations[id]!.figures;
      const theirs = RECORDED.evaluations[id];
      expect(mine.ENTER.observations).toBe(theirs.economics.C.entries);
      expect(mine.ENTER.observations).toBeGreaterThan(300);
      expect(mine.ENTER.total.mean).toBe(theirs.expectedNetCalibration.C.ENTER.difference);
      expect(mine.ALL.total.interval95).toEqual(theirs.expectedNetCalibration.C.ALL.interval95);
    }
  });

  it('adds up in aggregate, class by class', () => {
    const enter = STUDY_RESULT.evaluations['development']!.figures.ENTER;
    const sum = enter.probability.mean! + enter.payoff.mean!;
    expect(Math.abs(sum - enter.total.mean!)).toBeLessThanOrEqual(TOLERANCE);
    // Synthetic targets exit exactly at the assumed level; C entered only its 0.7 forecasts.
    expect(enter.payoffByClass.TARGET.mean).toBe(0);
    expect(enter.classes.TARGET.meanPredicted).toBeCloseTo(0.7, 12);
    expect(enter.classes.TARGET.share!).toBeLessThan(0.65);
    expect(enter.probability.mean!).toBeLessThan(0);
  });

  it('holds selection and fit inputs fixed when evaluation outcomes change', () => {
    const before = itemsOf(ROWS, DEVELOPMENT, PREDICTIONS.development);
    const changed = ROWS.map((r) =>
      r.split === 'validation' || r.split === 'test'
        ? {
            ...r,
            class: 'TIMEOUT' as const,
            outcome: { ...r.outcome, category: 'TIMEOUT' as const, net: -0.5 },
          }
        : r,
    );
    const after = itemsOf(changed, DEVELOPMENT, PREDICTIONS.development);
    expect(after.payoffs).toEqual(before.payoffs);
    expect(after.items.map((i) => [i.index, i.p, i.E, i.enter])).toEqual(
      before.items.map((i) => [i.index, i.p, i.E, i.enter]),
    );
    expect(after.items[0]!.terms.total).not.toBe(before.items[0]!.terms.total);
    // The final fit reads train and validation only: test outcomes never reach it.
    const testOnly = ROWS.map((r, i) => (r.split === 'test' ? changed[i]! : r));
    expect(itemsOf(testOnly, FINAL, PREDICTIONS.final).payoffs).toEqual(
      itemsOf(ROWS, FINAL, PREDICTIONS.final).payoffs,
    );
  });

  it('lists every recorded figure it cannot reproduce and then gives no reading', () => {
    const tampered = clone(RECORDED);
    tampered.evaluations.final.expectedNetCalibration.C.ENTER.difference! += 1e-15;
    tampered.evaluations.development.economics.C.entries += 1;
    tampered.evaluations.development.fit.payoffs.gTimeout! += 1e-15;
    const result = decomposeStudy(ROWS, PREDICTIONS, tampered, FAST);
    expect(result.status).toBe('NOT_RECONCILED');
    expect(result.reconciliation.differences).toEqual([
      'development.entries',
      'development.payoffs',
      'final.ENTER.difference',
    ]);
    expect(result.reading).toBeNull();
  });
});

describe('the reading', () => {
  const at = (low: number, high: number) => ({
    mean: (low + high) / 2,
    interval95: { low, high, defined: 1, replicates: 1 },
  });

  it('labels a component only when its interval excludes zero', () => {
    expect(signOf(at(-2, -1))).toBe('NEGATIVE');
    expect(signOf(at(1, 2))).toBe('POSITIVE');
    expect(signOf(at(-1, 0))).toBe('UNRESOLVED');
    expect(signOf({ mean: null, interval95: null })).toBe('UNRESOLVED');
  });

  it('calls periods consistent only when both name the same components', () => {
    expect(consistency([['probability'], ['probability']])).toBe('CONSISTENT');
    expect(consistency([['probability'], ['probability', 'payoff']])).toBe('NOT_CONSISTENT');
    expect(consistency([['probability'], 'NOT_RESOLVED'])).toBe('NOT_CONSISTENT');
    expect(consistency(['NOT_RESOLVED', 'NOT_RESOLVED'])).toBe('NOT_CONSISTENT');
  });

  it('reports point shares that add to one', () => {
    const reading = STUDY_RESULT.reading!;
    for (const id of ['development', 'final']) {
      const r = reading.evaluations[id]!;
      expect(r.signs.ENTER.payoffByClass.TARGET).toBe('UNRESOLVED');
      const shares = r.pointShares.probability! + r.pointShares.payoff!;
      expect(Math.abs(shares - 1)).toBeLessThan(1e-9);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe('the run', () => {
  const commit = 'c'.repeat(40);
  const run = 'r'.repeat(40);
  const blobs = { 'scripts/expectedNet.ts': 'b1', 'scripts/spot24h.ts': 'b2' };
  const git: Git = async (...args) =>
    args[0] === 'rev-parse'
      ? ((blobs as Record<string, string>)[args[1]!.split(':')[1]!] ?? '')
      : '';
  const identity = async () => ({ codeCommit: commit, codeBlobs: { x: 'y' } });

  async function fixture() {
    const out = await mkdtemp(join(tmpdir(), 'expected-net-decomposition-'));
    const rows = syntheticRows(2, 21);
    const specPath = 'docs/spot-24h-expected-net-t3s3-dev-v1.json';
    const fileSha256 = sha256(await readFile(specPath));
    const specification = { id: STAGE_D.specificationId, sha256: stageDSha256(), fileSha256 };
    const datasetText = JSON.stringify({
      manifest: { codeCommit: run, specification },
      coverage: { pairs: { P0USDT: {}, P1USDT: {} } },
      parity: { pass: true },
      columns: COLUMNS,
      rows: rows.map(toColumns),
    });
    const { note: _note, ...params } = STAGE_D.forecasters.C.verifiedParams;
    const evaluations = predictionsFor(rows, overconfident);
    for (const set of Object.values(evaluations)) set.fit['params'] = params;
    const predictionsText = JSON.stringify({
      manifest: { codeCommit: run, specification, dataset: { sha256: sha256(datasetText) } },
      environment: {},
      evaluations,
    });
    const results = evaluateStudy(rows, evaluations, 2);
    const resultOf = (r: unknown, manifest = {}) =>
      JSON.stringify({
        manifest: {
          codeCommit: run,
          codeBlobs: blobs,
          specification,
          dataset: { sha256: sha256(datasetText) },
          predictions: { sha256: sha256(predictionsText) },
          ...manifest,
        },
        results: r,
      });
    const write = async (name: string, text: string) => {
      const path = join(out, name);
      await writeFile(path, text);
      return { path, sha256: sha256(text) };
    };
    const inputs = {
      ...SPEC.inputs,
      specification: { path: specPath, sha256: stageDSha256(), fileSha256 },
      dataset: await write('dataset.json', datasetText),
      predictions: await write('predictions.json', predictionsText),
      result: await write('result.json', resultOf(results)),
      runCommit: run,
    };
    return { out, inputs, results, resultOf, write };
  }

  it('verifies every input, reproduces the result and writes once', async () => {
    const { out, inputs } = await fixture();
    const first = await runExpectedNetDecomposition(out, identity, inputs, git);
    expect(first.status).toBe('CREATED');
    expect(first.summary.status).toBe('RECONCILED');
    const written = JSON.parse(await readFile(first.path, 'utf8'));
    expect(sha256(await readFile(first.path))).toBe(first.contentSha256);
    expect(written.manifest.codeCommit).toBe(commit);
    expect(written.manifest.inputs.result.sha256).toBe(inputs.result.sha256);
    expect(written.manifest.stageD.reproduction).toBe('BYTE_IDENTICAL');
    expect(written.manifest.specification.fileSha256).toBe(
      sha256(await readFile('docs/spot-24h-expected-net-error-decomposition-dev-v1.json')),
    );
    expect((await runExpectedNetDecomposition(out, identity, inputs, git)).status).toBe(
      'UNCHANGED',
    );
    await writeFile(first.path, 'other');
    expect((await runExpectedNetDecomposition(out, identity, inputs, git)).status).toBe('CONFLICT');
    expect(await readFile(first.path, 'utf8')).toBe('other');
  }, 120_000);

  it('stops on a missing or mismatched input and writes nothing', async () => {
    const { out, inputs, results, resultOf, write } = await fixture();
    const refuse = (i: typeof inputs, g: Git = git) =>
      runExpectedNetDecomposition(out, identity, i, g);
    await expect(
      refuse({ ...inputs, dataset: { ...inputs.dataset, path: join(out, 'no') } }),
    ).rejects.toThrow('INTEGRITY_FAILURE: dataset is missing');
    await expect(
      refuse({ ...inputs, predictions: { ...inputs.predictions, sha256: 'x' } }),
    ).rejects.toThrow('predictions SHA-256 is');
    await expect(refuse({ ...inputs, runCommit: commit })).rejects.toThrow('result written at');
    const otherBlob: Git = async () => 'not-the-blob';
    await expect(refuse(inputs, otherBlob)).rejects.toThrow('at the run commit is not blob');
    const otherData = await write('r2.json', resultOf(results, { dataset: { sha256: 'x' } }));
    await expect(refuse({ ...inputs, result: otherData })).rejects.toThrow('another dataset');
    const changed = clone(results);
    changed.evaluations.development.coverage.scored += 1;
    const unreproduced = await write('r3.json', resultOf(changed));
    await expect(refuse({ ...inputs, result: unreproduced })).rejects.toThrow(
      'does not reproduce the result',
    );
    const dirty = async () => {
      throw new Error('Tracked files differ from HEAD');
    };
    await expect(runExpectedNetDecomposition(out, dirty, inputs, git)).rejects.toThrow(
      'Tracked files differ',
    );
    expect((await readdir(out)).filter((f) => f.startsWith('spot-24h'))).toEqual([]);
  }, 120_000);
});
