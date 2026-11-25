import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from './opportunityAnalysis';
import {
  calibrationLabel,
  CLASSES,
  classOf,
  COLUMNS,
  conclude,
  concurrency,
  decileBins,
  differences,
  evaluateStudy,
  EXCLUSIONS,
  expectedNet,
  exportRows,
  fitBaseline,
  fitV1,
  fromColumns,
  outcomesOf,
  pairRows,
  RULES,
  SPEC,
  specSha256,
  STUDY,
  toColumns,
  toObservation,
  V1_T3S3,
  v1Parity,
  type EvaluationId,
  type PeriodResult,
  type PredictionSet,
  type Probabilities,
  type Row,
} from './expectedNet';
import {
  runExpectedNetEvaluate,
  runExpectedNetExport,
  studyIdentity,
  STUDY_FILES,
} from './expectedNetRun';
import {
  decisionTimes,
  FEATURES,
  SPEC as QUANTILE_SPEC,
  specSha256 as quantileSpecSha256,
} from './quantileForecast';
import {
  CELLS,
  dayOrders,
  evaluateFit,
  featuresAt,
  fitFrequencies,
  HOUR_MS,
  indexHourly,
  netReturn,
  pairObservations,
  PROTOCOL,
  protocolSha256,
  ratioInterval,
  splitDays,
  splitOf,
  type Category,
  type HourCandle,
  type Protocol,
} from './spot24h';
import type { Git } from './spot24hDiagnosticRun';

const H = HOUR_MS;
const HISTORY = Date.parse(PROTOCOL.data.historyStart);
const CUTOFF = Date.parse(PROTOCOL.data.collectionCutoff);
const [B1] = PROTOCOL.splits.boundaries.map((t) => Date.parse(t)) as [number, number];
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const FAST: Protocol = { ...STUDY, uncertainty: { ...STUDY.uncertainty, replicates: 200 } };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
/** Full-history tests: 1.4–6.5 s each on CI with coverage, above vitest's 5 s default. */
const HEAVY = 60_000;

const candle = (timestamp: number, open: number, high: number, low: number, close: number) =>
  ({ timestamp, closeTime: timestamp + H - 1, open, high, low, close }) as HourCandle;

function walk(seed: number, start = HISTORY, end = CUTOFF): HourCandle[] {
  const random = mulberry32(seed);
  const candles: HourCandle[] = [];
  let close = 100;
  for (let t = start; t < end; t += H) {
    const open = close;
    close = open * Math.exp(0.02 * (random() - 0.5));
    const high = Math.max(open, close) * (1 + 0.004 * random());
    const low = Math.min(open, close) * (1 - 0.004 * random());
    candles.push(candle(t, open, high, low, close));
  }
  return candles;
}

// ---------------------------------------------------------------------------------------------
// Synthetic rows on v1's grid: classes drawn from known probabilities, never market data.

const V = 0.01;
const HIGH: Probabilities = [0.6, 0.2, 0.2];
const LOW: Probabilities = [0.2, 0.5, 0.3];
const MID: Probabilities = [0.4, 0.35, 0.25];
const truth = (row: Row): Probabilities => (row.features[0]! > 0 ? HIGH : LOW);

function syntheticRows(pairs: number, seed: number, learnable: boolean): Row[] {
  const random = mulberry32(seed);
  const rows: Row[] = [];
  for (const time of decisionTimes()) {
    for (let k = 0; k < pairs; k += 1) {
      const features = FEATURES.map(() => (random() - 0.5) * 0.01);
      features[0] = random() < 0.5 ? 0.01 : -0.01;
      const p = learnable ? (features[0] > 0 ? HIGH : LOW) : MID;
      const u = random();
      const klass = u < p[0] ? 'TARGET' : u < p[0] + p[1] ? 'STOP' : 'TIMEOUT';
      const category: Category = klass === 'STOP' && random() < 0.05 ? 'AMBIGUOUS' : klass;
      const gross = { TARGET: 3 * V, STOP: -3 * V, TIMEOUT: 0 }[klass];
      const outcome = {
        category,
        bar: klass === 'TIMEOUT' ? 24 : 1 + Math.floor(random() * 24),
        gross,
        net: netReturn(1, 1 + gross, category),
      };
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
        orderingNet: category === 'AMBIGUOUS' ? netReturn(1, 1 + 3 * V, 'TARGET') : outcome.net,
      });
    }
  }
  return rows;
}

function predictionsFor(
  rows: readonly Row[],
  probabilities: (row: Row, i: number) => Probabilities,
): Record<EvaluationId, PredictionSet> {
  return Object.fromEntries(
    SPEC.periods.evaluations.map((e) => {
      const fit = fitBaseline(rows.filter((r) => r.split !== null && e.fit.includes(r.split)));
      const out: [number, number, number, number][] = [];
      rows.forEach((r, i) => {
        if (r.split === e.evaluate) out.push([i, ...probabilities(r, i)]);
      });
      return [
        e.id,
        {
          status: fit.missingClass ? 'MISSING_CLASS' : 'FITTED',
          fit: { observations: fit.observations, classes: fit.classes },
          rows: fit.missingClass ? [] : out,
        } satisfies PredictionSet,
      ];
    }),
  ) as Record<EvaluationId, PredictionSet>;
}

const LEARNABLE = syntheticRows(6, 11, true);
const learnable = evaluateStudy(LEARNABLE, predictionsFor(LEARNABLE, truth), 6, FAST);
const check = (r: ReturnType<typeof conclude>, id: string, evaluation: string | null) =>
  r.checks.find((c) => c.id === id && c.evaluation === evaluation)?.holds;

// ---------------------------------------------------------------------------------------------

describe('the specification', () => {
  it('mirrors its lists, v1, #220 and the recorded inputs', () => {
    expect(CLASSES).toEqual(SPEC.outcome.classes.order);
    expect(EXCLUSIONS).toEqual(SPEC.exclusions.order);
    expect(FEATURES).toEqual(SPEC.features.candidate.order);
    expect(SPEC.features.candidate.order).toEqual(QUANTILE_SPEC.features.order);
    expect(SPEC.basis.protocol.sha256).toBe(protocolSha256());
    expect(SPEC.basis.featureSource.sha256).toBe(quantileSpecSha256());
    const { use: _use, ...recorded } = QUANTILE_SPEC.basis.recordedResult;
    expect(SPEC.basis.recordedResult).toMatchObject(recorded);
    expect(SPEC.outcome.scenario).toEqual(PROTOCOL.scenarios[0]);
    const { note: _note, ...params } = SPEC.forecasters.C.verifiedParams;
    expect(params).toMatchObject(SPEC.forecasters.C.settings);
    expect(SPEC.periods.evaluations).toEqual(
      QUANTILE_SPEC.evaluations.map((e) => ({
        ...e,
        evaluate: e.evaluate === 'final' ? 'test' : e.evaluate,
      })),
    );
    expect(specSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('states every prose number the code uses', () => {
    const text = JSON.stringify(SPEC);
    expect(SPEC.metrics.sensitivities.targetOvershoot).toContain(`x ${RULES.overshoot} (v1's`);
    expect(RULES.overshoot).toBe(1 + PROTOCOL.costs.slippagePerMarketFill);
    expect(SPEC.scoring.coverage).toContain(`Below ${RULES.minCoverage}`);
    expect(SPEC.metrics.expectedNetCalibration.labels.INSUFFICIENT_SELECTED).toContain(
      `Fewer than ${RULES.minSelected} observations or fewer than ${RULES.minSelectedDays} distinct days`,
    );
    expect(SPEC.metrics.probabilityCalibration.limits).toContain(
      `inTheLarge <= ${RULES.maxInTheLarge} and weightedDecileError <= ${RULES.maxDecileError}`,
    );
    expect(text).toContain(
      `at least ${RULES.floor.entries} scored observations, on at least ${RULES.floor.days} distinct UTC days, in at least ${RULES.floor.months} distinct calendar months`,
    );
    expect(SPEC.metrics.probabilityCalibration.deciles).toContain('at 0.1, 0.2, ..., 0.9');
    expect(RULES.deciles.map((q) => Math.round(q * 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(SPEC.parity.tolerance).toContain(String(RULES.parityTolerance));
  });

  it("changes only the bootstrap's replicates and seed from protocol v1", () => {
    const back = {
      ...STUDY,
      scenarios: PROTOCOL.scenarios,
      uncertainty: { ...STUDY.uncertainty, replicates: 2000, random: PROTOCOL.uncertainty.random },
    };
    expect(back).toEqual(PROTOCOL);
    expect(STUDY.uncertainty.replicates).toBe(SPEC.uncertainty.replicates);
    expect(STUDY.uncertainty.random.seed).toBe(SPEC.uncertainty.random.seed);
    expect(STUDY.uncertainty.random.drawMessage).toBe(SPEC.uncertainty.random.drawMessage);
    expect(V1_T3S3.scenarios).toEqual([PROTOCOL.scenarios[0]]);
    expect(V1_T3S3.uncertainty).toEqual(PROTOCOL.uncertainty);
  });

  it('exports the columns the classifier reads, and never the entry open', () => {
    expect(COLUMNS).toEqual(expect.arrayContaining(['split', 'class', ...FEATURES]));
    expect(COLUMNS.some((c) => /open|entry/i.test(c))).toBe(false);
    for (const name of COLUMNS.filter((c) => !FEATURES.includes(c as never)))
      expect(SPEC.output.dataset).toContain(name === 'symbol' || name === 'time' ? 'T' : name);
  });
});

describe('outcomes', () => {
  // entry 100, v = 0.01: target 103, stop 97, overshoot detection 103.0515
  const bar = (high: number, low: number, close = 100, open = 100) => ({ open, high, low, close });
  const bars = (...b: { open: number; high: number; low: number; close: number }[]) => {
    const all = [...b];
    while (all.length < 24) all.push(bar(101, 99, 100.5));
    return all.map((x, i) => candle(i * H, x.open, x.high, x.low, x.close));
  };

  it('keep v1 categories and bars, map AMBIGUOUS to STOP and book gross and net', () => {
    const target = outcomesOf(bars(bar(101, 99), bar(103.5, 99.5)), V);
    expect(target.outcome).toMatchObject({ category: 'TARGET', bar: 2 });
    expect(target.outcome.gross).toBeCloseTo(0.03, 14);
    expect(target.outcome.net).toBe(netReturn(100, 100 * (1 + 3 * V), 'TARGET'));
    const gap = outcomesOf(bars(bar(101, 99), bar(96, 95, 95.5, 96)), V);
    expect(gap.outcome).toMatchObject({
      category: 'STOP',
      bar: 2,
      net: netReturn(100, 96, 'STOP'),
    });
    const ambiguous = outcomesOf(bars(bar(104, 96)), V);
    expect(ambiguous.outcome.category).toBe('AMBIGUOUS');
    expect(classOf(ambiguous.outcome.category)).toBe('STOP');
    expect(ambiguous.orderingNet).toBe(netReturn(100, 100 * (1 + 3 * V), 'TARGET'));
    const timeout = outcomesOf(bars(), V);
    expect(timeout.outcome).toMatchObject({ category: 'TIMEOUT', bar: 24 });
    expect(timeout.outcome.gross).toBeCloseTo(0.005, 14);
    expect(timeout.orderingNet).toBe(timeout.outcome.net);
  });

  it('book the overshoot sensitivity at the target, detected 0.05% beyond it', () => {
    const touch = outcomesOf(bars(bar(103.01, 99)), V);
    expect(touch.outcome.category).toBe('TARGET');
    expect(touch.overshoot.category).toBe('TIMEOUT');
    const through = outcomesOf(bars(bar(103.2, 99)), V);
    expect(through.overshoot).toEqual(through.outcome);
    const gapUp = outcomesOf(bars(bar(101, 99), bar(110, 99, 109, 110)), V);
    expect(gapUp.overshoot).toEqual({ ...gapUp.outcome });
    expect(gapUp.overshoot.net).toBe(netReturn(100, 100 * (1 + 3 * V), 'TARGET'));
  });
});

describe('joined rows', { timeout: HEAVY }, () => {
  const candles = walk(3);
  const { rows } = pairRows('BTCUSDT', candles);
  const at = (rs: readonly Row[], time: number) => rs.find((r) => r.time === time)!;
  const T = Date.parse('2025-06-01T08:00:00.000Z');

  it("equal v1's own observations, outcome by outcome, with #220's features and v1's cell", () => {
    const v1 = pairObservations('BTCUSDT', indexHourly(candles, CUTOFF), V1_T3S3).observations;
    expect(rows).toHaveLength(v1.length);
    rows.forEach((r, i) => {
      expect([r.time, r.cell, r.v]).toEqual([v1[i]!.time, v1[i]!.cell, v1[i]!.v]);
      expect(r.outcome).toMatchObject(v1[i]!.outcomes[0]!);
      expect(toObservation(r)).toEqual(v1[i]);
    });
    expect(r0Features(rows, T)).toBe(featuresAt(indexHourly(candles, CUTOFF), T)!.v);
  });

  it('read no candle from T on for features, and none after T + 23h at all', () => {
    const from = (time: number, factor: number) =>
      candles.map((c) =>
        c.timestamp >= time
          ? candle(c.timestamp, c.open * factor, c.high * factor, c.low * factor, c.close * factor)
          : c,
      );
    const later = at(pairRows('BTCUSDT', from(T + 24 * H, 1.3)).rows, T);
    expect(later).toEqual(at(rows, T));
    const sooner = at(pairRows('BTCUSDT', from(T, 1.3)).rows, T);
    expect([sooner.features, sooner.cell, sooner.v]).toEqual([
      at(rows, T).features,
      at(rows, T).cell,
      at(rows, T).v,
    ]);
    expect(sooner.outcome).not.toEqual(at(rows, T).outcome);
  });

  it("purge a label that crosses a boundary with v1's splitOf", () => {
    expect(at(rows, B1 - 24 * H).split).toBe('train');
    expect(at(rows, B1 - 20 * H).split).toBeNull();
    expect(at(rows, B1).split).toBe('validation');
  });

  it('count exclusions and order rows by T, then member order', () => {
    const gap = candles.filter((c) => c.timestamp !== T - 3 * H);
    const pair = pairRows('BTCUSDT', gap);
    expect(pair.coverage.exclusions.FEATURE_WINDOW_UNAVAILABLE).toBe(50);
    expect(pair.coverage.exclusions.LABEL_WINDOW_UNAVAILABLE).toBe(6);
    expect(pair.rows).toHaveLength(rows.length - 56);
    const short = {
      A: walk(1, HISTORY, HISTORY + 230 * H),
      B: walk(2, HISTORY, HISTORY + 230 * H),
    };
    const out = exportRows(short, ['B', 'A']);
    expect(out.rows.map((r) => `${r.symbol}${(r.time - HISTORY) / H}`)).toEqual([
      'B200',
      'A200',
      'B204',
      'A204',
    ]);
    expect(out.coverage.total.observations).toBe(4);
    expect(fromColumns(toColumns(out.rows[0]!))).toEqual(out.rows[0]);
  });
});

function r0Features(rows: readonly Row[], time: number) {
  return rows.find((r) => r.time === time)!.features[FEATURES.indexOf('atr14OverClose')];
}

/** What v1's recorded result would hold for these candles: v1's own functions. */
function recordedFor(candles: Record<string, HourCandle[]>, members: readonly string[]) {
  const all = members.flatMap(
    (s) => pairObservations(s, indexHourly(candles[s]!, CUTOFF), V1_T3S3).observations,
  );
  const of = (split: string) => all.filter((o) => splitOf(o.time) === split);
  const n = (split: string) => ({ observations: of(split).length });
  return {
    splits: {
      train: n('train'),
      validation: n('validation'),
      test: n('test'),
      purged: all.length - of('train').length - of('validation').length - of('test').length,
    },
    development: evaluateFit(
      fitFrequencies(of('train'), V1_T3S3),
      of('validation'),
      'validation',
      V1_T3S3,
    ),
    confirmatory: evaluateFit(
      fitFrequencies([...of('train'), ...of('validation')], V1_T3S3),
      of('test'),
      'test',
      V1_T3S3,
    ).map((e) => ({ ...e, support: { status: 'NOT_SUPPORTED' }, expectancy: { status: 'x' } })),
  };
}

describe('v1 parity', { timeout: HEAVY }, () => {
  const members = ['BTCUSDT', 'ETHUSDT'];
  const candles = { BTCUSDT: walk(5), ETHUSDT: walk(6) };
  const { rows } = exportRows(candles, members);
  const recorded = recordedFor(candles, members) as never;

  it('passes on v1-consistent figures and names every differing path', () => {
    const parity = v1Parity(candles, members, rows, recorded);
    expect(parity).toMatchObject({ pass: true, v1Observations: rows.length, v1NotExported: 0 });
    const bad = clone(recorded) as ReturnType<typeof recordedFor>;
    bad.development[0]!.brier.method! += 1e-9;
    bad.splits.purged += 1;
    bad.confirmatory[0]!.counts.AMBIGUOUS += 1;
    expect(v1Parity(candles, members, rows, bad as never).differences).toEqual([
      '$.splits.purged',
      '$.development.brier.method',
      '$.confirmatory.counts.AMBIGUOUS',
    ]);
    const changed = rows.map((r, i) => (i === 7 ? { ...r, outcome: { ...r.outcome, net: 0 } } : r));
    expect(v1Parity(candles, members, changed, recorded).pass).toBe(false);
  });

  it('compares integers exactly and other numbers within 1e-12', () => {
    expect(differences({ a: 1, b: [0.1, null] }, { a: 1, b: [0.1 + 5e-13, null] })).toEqual([]);
    expect(differences({ a: 1, b: [0.1, 'x'] }, { a: 2, b: [0.1 + 2e-12, 'y'], c: 0 })).toEqual([
      '$.a',
      '$.b.0',
      '$.b.1',
      '$.c',
    ]);
  });
});

describe('forecasters', () => {
  const row = (split: Row['split'], category: Category, gross: number, cell = CELLS[0]!) =>
    ({
      ...LEARNABLE[0]!,
      split,
      class: classOf(category),
      outcome: { category, bar: 1, gross, net: netReturn(1, 1 + gross, category) },
    }) as Row;

  it('estimate U and the pooled payoffs from the fit set, AMBIGUOUS inside STOP', () => {
    const fit = fitBaseline([
      row('train', 'TARGET', 0.03),
      row('train', 'STOP', -0.032),
      row('train', 'AMBIGUOUS', -0.03),
      row('train', 'TIMEOUT', 0.004),
    ]);
    expect(fit.classes).toEqual({ TARGET: 1, STOP: 2, TIMEOUT: 1 });
    expect(fit.outcomes.AMBIGUOUS).toBe(1);
    expect(fit.probabilities).toEqual([0.25, 0.5, 0.25]);
    expect(fit.gStop).toBeCloseTo(-3.1, 12);
    expect(fit.gTimeout).toBeCloseTo(0.4, 12);
    const missing = fitBaseline([row('train', 'TARGET', 0.03), row('train', 'STOP', -0.03)]);
    expect([missing.missingClass, missing.probabilities, missing.gTimeout]).toEqual([
      true,
      null,
      null,
    ]);
  });

  it("compute the contract's restricted plug-in", () => {
    const p: Probabilities = [0.35, 0.25, 0.4];
    const e = expectedNet(p, 0.01057, -3, 0);
    expect(e).toBe(
      0.35 * netReturn(1, 1 + 3 * 0.01057, 'TARGET') +
        0.25 * netReturn(1, 1 - 3 * 0.01057, 'STOP') +
        0.4 * netReturn(1, 1, 'TIMEOUT'),
    );
    // The contract's first illustration: +0.03%.
    expect(e).toBeCloseTo(0.0003, 4);
  });

  it("keep v1's TARGET frequencies, meanNet and support, adding STOP and TIMEOUT", () => {
    const train = LEARNABLE.filter((r) => r.split === 'train');
    const v1 = fitV1(train);
    expect(v1.fit).toEqual(fitFrequencies(train.map(toObservation), V1_T3S3)[0]);
    for (const cell of CELLS) {
      const c = v1.cells[cell]!;
      expect(c.probabilities![0]).toBe(c.p);
      expect(c.probabilities!.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 12);
    }
    const sparse = fitV1(train.slice(0, 600));
    expect(Object.values(sparse.cells).some((c) => c.p === null && c.probabilities === null)).toBe(
      true,
    );
  });
});

describe('the fixed comparison', { timeout: HEAVY }, () => {
  const dev = learnable.evaluations.development!;
  const fin = learnable.evaluations.final!;

  it('fits on preceding periods only: later outcomes never change a fit', () => {
    const flipped = LEARNABLE.map((r) =>
      r.split === 'test' || r.split === null
        ? {
            ...r,
            class: 'TARGET' as const,
            outcome: { ...r.outcome, category: 'TARGET' as const, gross: 0.5 },
          }
        : r,
    );
    const again = evaluateStudy(flipped, predictionsFor(flipped, truth), 6, FAST);
    for (const id of ['development', 'final'] as const) {
      expect(again.evaluations[id]!.fit).toEqual(learnable.evaluations[id]!.fit);
    }
    const validation = LEARNABLE.map((r) =>
      r.split === 'validation'
        ? {
            ...r,
            class: 'TIMEOUT' as const,
            outcome: { ...r.outcome, category: 'TIMEOUT' as const, gross: 0 },
          }
        : r,
    );
    const third = evaluateStudy(validation, predictionsFor(validation, truth), 6, FAST);
    expect(third.evaluations.development!.fit).toEqual(dev.fit);
    expect(third.evaluations.final!.fit).not.toEqual(fin.fit);
  });

  it('scores every eligible observation once, and abstentions count as zero', () => {
    const decisions = (split: string) =>
      6 * decisionTimes().filter((t) => splitOf(t) === split).length;
    expect(decisions('validation')).toBe(6 * 1081);
    expect(dev.coverage).toMatchObject({
      eligible: decisions('validation'),
      scored: decisions('validation'),
      coverage: 1,
    });
    expect(fin.coverage).toMatchObject({ eligible: decisions('test'), scored: decisions('test') });
    const evaluated = LEARNABLE.filter((r) => r.split === 'validation');
    const entered = evaluated.filter((r) => r.features[0]! > 0);
    const c = dev.economics.C;
    expect(c.entries).toBe(entered.length);
    expect(c.perOpportunity.mean).toBeCloseTo(
      entered.reduce((s, r) => s + r.outcome.net, 0) / evaluated.length,
      14,
    );
    expect(c.perTrade.mean! * c.entryRate!).toBeCloseTo(c.perOpportunity.mean!, 14);
    expect(dev.economics.U.entries).toBe(0);
    expect(dev.economics.U.perOpportunity.mean).toBe(0);
    expect(dev.paired.CminusU.mean).toBeCloseTo(c.perOpportunity.mean!, 14);
    expect(dev.economics.V1.entries).toBe(dev.brier.binaryTarget.v1.selected.observations);
  });

  it('passes the learnable example and fails the null control (no financial evidence)', () => {
    expect(learnable.conclusion.verdict).toBe('GATE_PASSED');
    expect(learnable.conclusion.failing).toEqual([]);
    for (const e of [dev, fin]) {
      expect(e.expectedNetCalibration.C.ENTER.label).toBe('WITHIN_TOLERANCE');
      expect(e.brier.CminusU.interval95!.high).toBeLessThan(0);
    }
    const nullRows = syntheticRows(6, 12, false);
    const noise = mulberry32(99);
    const nullResult = evaluateStudy(
      nullRows,
      predictionsFor(nullRows, () => {
        const raw = MID.map((p) => p + 0.1 * (noise() - 0.5));
        const total = raw.reduce((s, x) => s + x, 0);
        return raw.map((x) => x / total) as Probabilities;
      }),
      6,
      FAST,
    );
    expect(nullResult.conclusion.verdict).not.toBe('GATE_PASSED');
    for (const id of ['development', 'final'] as const) {
      expect(check(nullResult.conclusion, 'brierVsU', id)).toBe(false);
      expect(nullResult.evaluations[id]!.brier.CminusU.mean).toBeGreaterThan(0);
    }
  });

  it('pairs every interval of an evaluation on the same day orders', () => {
    const same = evaluateStudy(
      LEARNABLE,
      predictionsFor(LEARNABLE, (r) => MID),
      6,
      FAST,
    );
    const fitU = same.evaluations.development!.fit.U!;
    const asU = evaluateStudy(
      LEARNABLE,
      predictionsFor(LEARNABLE, () => fitU),
      6,
      FAST,
    );
    const e = asU.evaluations.development!;
    expect(e.brier.CminusU.interval95).toMatchObject({ low: 0, high: 0 });
    expect(e.paired.CminusU.interval95).toMatchObject({ low: 0, high: 0 });
    const [first, last] = splitDays('validation', FAST);
    const positions = last - first + 1;
    const net = new Float64Array(positions);
    const n = new Float64Array(positions);
    for (const r of LEARNABLE.filter((x) => x.split === 'validation')) {
      net[Math.floor(r.time / 86_400_000) - first]! += r.features[0]! > 0 ? r.outcome.net : 0;
      n[Math.floor(r.time / 86_400_000) - first]! += 1;
    }
    const orders = dayOrders('validation', positions, FAST);
    const interval = ratioInterval(orders, net, n, [0.025, 0.975])!;
    expect(dev.economics.C.perOpportunity.interval95!.low).toBeCloseTo(interval.low, 14);
    expect(dev.economics.C.perOpportunity.interval95!.high).toBeCloseTo(interval.high, 14);
  });

  it('holds forecasts and decisions fixed under the sensitivities', () => {
    const worse = LEARNABLE.map((r) => ({
      ...r,
      overshoot: { ...r.outcome, category: 'TIMEOUT' as const, net: -0.01 },
    }));
    const fill = evaluateStudy(worse, predictionsFor(worse, truth), 6, FAST);
    for (const id of ['development', 'final'] as const) {
      const a = fill.evaluations[id]!.economics.C;
      const b = learnable.evaluations[id]!.economics.C;
      expect([a.entries, a.perOpportunity, a.perTrade]).toEqual([
        b.entries,
        b.perOpportunity,
        b.perTrade,
      ]);
      expect(a.overshoot.perOpportunity.mean).toBeLessThan(0);
    }
    expect(fill.conclusion.verdict).toBe('STOP');
    expect(fill.conclusion.failing).toEqual([
      'development.targetOvershoot',
      'final.targetOvershoot',
    ]);
    expect(fill.conclusion.labels).toEqual([{ label: 'FILL_SENSITIVE', evaluation: null }]);
  });

  it('gives no forecast for a missing class or an unsupported cell, and refuses mismatches', () => {
    const noTimeout = LEARNABLE.map((r) =>
      r.split === 'train' && r.class === 'TIMEOUT'
        ? { ...r, class: 'STOP' as const, outcome: { ...r.outcome, category: 'STOP' as const } }
        : r,
    );
    const missing = evaluateStudy(noTimeout, predictionsFor(noTimeout, truth), 6, FAST);
    const e = missing.evaluations.development!;
    expect(e.fit.missingClass).toBe(true);
    expect(e.coverage).toMatchObject({ scored: 0, coverage: 0, forecasts: { U: 0, C: 0 } });
    expect(missing.conclusion.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(missing.conclusion.failing).toContain('development.coverage');
    expect(missing.evaluations.final!.fit.missingClass).toBe(false);

    const wrong = predictionsFor(noTimeout, truth);
    wrong.development = { ...wrong.development!, status: 'FITTED' };
    expect(() => evaluateStudy(noTimeout, wrong, 6, FAST)).toThrow('missing class');
    const short = predictionsFor(LEARNABLE, truth);
    short.final = { ...short.final!, rows: short.final!.rows.slice(1) };
    expect(() => evaluateStudy(LEARNABLE, short, 6, FAST)).toThrow('exactly the evaluated');
    const count = predictionsFor(LEARNABLE, truth);
    count.final = { ...count.final!, fit: { ...count.final!.fit, observations: 1 } };
    expect(() => evaluateStudy(LEARNABLE, count, 6, FAST)).toThrow('fit set differs');

    const rare = LEARNABLE.map((r) =>
      r.cell === CELLS[5] && r.split === 'train' && r.time % (7 * 24 * H) !== 0
        ? { ...r, cell: CELLS[0]! }
        : r,
    );
    const sparse = evaluateStudy(rare, predictionsFor(rare, truth), 6, FAST).evaluations
      .development!;
    expect(sparse.fit.V1.cells[CELLS[5]!]!.p).toBeNull();
    expect(sparse.coverage.coverage).toBeLessThan(1);
    expect(sparse.coverage.scored).toBe(sparse.coverage.forecasts.V1);
  });

  it('keeps an excluded decision in the coverage denominator', () => {
    const fewer = LEARNABLE.filter((r, i) => r.split !== 'validation' || i % 10 !== 0);
    const e = evaluateStudy(fewer, predictionsFor(fewer, truth), 6, FAST).evaluations.development;
    expect(e.coverage.eligible).toBe(dev.coverage.eligible);
    expect(e.coverage.scored).toBe(e.coverage.observations);
    expect(e.coverage.coverage).toBeCloseTo(e.coverage.scored / dev.coverage.eligible, 15);
    expect(e.coverage.coverage).toBeLessThan(0.95);
  });

  it('reports zero entries as NO_ENTRIES and insufficient evidence', () => {
    const none = evaluateStudy(
      LEARNABLE,
      predictionsFor(LEARNABLE, () => LOW),
      6,
      FAST,
    );
    const c = none.evaluations.final!.economics.C;
    expect([c.entries, c.perOpportunity.mean, c.perTrade.mean]).toEqual([0, 0, null]);
    expect(none.evaluations.final!.expectedNetCalibration.C.ENTER).toMatchObject({
      label: 'NO_ENTRIES',
      observations: 0,
      difference: null,
    });
    expect(none.conclusion.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(none.conclusion.failing).toEqual(
      expect.arrayContaining(['final.enterSubset', 'entryFloor', 'final.perTrade']),
    );
  });
});

describe('calibration bins and labels', () => {
  it('keep ties together, send a boundary value to the lower bin and never merge bins', () => {
    const equal = decileBins([0.3, 0.3, 0.3, 0.3], [1, 0, 0, 0]);
    expect(equal.bins[0]).toEqual({ bin: 0, n: 4, meanPredicted: 0.3, meanActual: 0.25 });
    expect(equal.bins.slice(1).every((b) => b.n === 0 && b.meanPredicted === null)).toBe(true);
    expect(equal.weightedError).toBeCloseTo(0.05, 15);
    const values = Array.from({ length: 11 }, (_, i) => i / 10);
    const spread = decileBins(
      values,
      values.map(() => 0),
    );
    expect(spread.boundaries.map((b) => Math.round(b * 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(spread.bins.map((b) => b.n)).toEqual([2, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(spread.weightedError).toBeCloseTo(0.5, 14);
    expect(decileBins([], [])).toEqual({
      boundaries: [],
      bins: expect.any(Array),
      weightedError: null,
    });
  });

  it('label expected-net calibration on the point difference', () => {
    expect(calibrationLabel(0, 0, null)).toBe('NO_ENTRIES');
    expect(calibrationLabel(299, 40, 0)).toBe('INSUFFICIENT_SELECTED');
    expect(calibrationLabel(300, 29, 0)).toBe('INSUFFICIENT_SELECTED');
    expect(calibrationLabel(300, 30, 0.001)).toBe('WITHIN_TOLERANCE');
    expect(calibrationLabel(300, 30, -0.001)).toBe('WITHIN_TOLERANCE');
    expect(calibrationLabel(300, 30, -0.0011)).toBe('OVERPREDICTED');
    expect(calibrationLabel(300, 30, 0.0011)).toBe('UNDERPREDICTED');
  });
});

describe('the verdict', () => {
  const base = learnable.evaluations;
  const tweak = (f: (e: Record<EvaluationId, PeriodResult>) => void) => {
    const copy = clone(base);
    f(copy);
    return conclude(copy);
  };

  it('names each failing condition and keeps the order of the verdicts', () => {
    expect(conclude(base).verdict).toBe('GATE_PASSED');
    const brier = tweak((e) => (e.final.brier.CminusV1.interval95!.high = 0));
    expect([brier.verdict, brier.failing]).toEqual(['STOP', ['final.brierVsV1']]);
    const calibration = tweak(
      (e) => (e.development.probabilityCalibration.C.STOP.inTheLarge = 0.031),
    );
    expect(calibration.failing).toEqual(['development.probabilityCalibration.STOP']);
    const over = tweak((e) => (e.final.expectedNetCalibration.C.ENTER.label = 'OVERPREDICTED'));
    expect(over.failing).toEqual(['final.expectedNetCalibration']);
    const month = tweak(
      (e) => (e.final.economics.C.leaveOneMonthOut.months[2]!.perOpportunity = 0),
    );
    expect(month.failing).toEqual(['final.leaveOneMonthOut']);
    const both = tweak((e) => {
      e.final.coverage.coverage = 0.94;
      e.final.economics.C.perTrade.mean = -0.001;
    });
    expect([both.verdict, both.failing]).toEqual([
      'INSUFFICIENT_EVIDENCE',
      ['final.coverage', 'final.perTrade'],
    ]);
    const thin = tweak((e) => {
      e.development.economics.C.entryMonths = [];
      e.final.economics.C.entryMonths = ['2026-06'];
    });
    expect(thin.failing).toEqual(['entryFloor']);
    expect(check(thin, 'entryFloor', null)).toBe(false);
  });

  it('labels FILL_SENSITIVE only when the overshoot is the sole failure', () => {
    const r = tweak((e) => {
      e.final.economics.C.overshoot.perOpportunity.mean = -0.0001;
      e.final.economics.C.perTrade.mean = -0.0001;
    });
    expect(r.failing).toEqual(['final.perTrade', 'final.targetOvershoot']);
    expect(r.labels).toEqual([]);
  });

  it('labels a result that only ordering would rescue', () => {
    const r = tweak((e) => {
      e.development.economics.C.perOpportunity.mean = -0.0001;
      e.development.economics.C.ordering.perOpportunity.mean = 0.0002;
    });
    expect(r.verdict).toBe('STOP');
    expect(r.failing).toEqual(['development.perOpportunity']);
    expect(r.labels).toEqual([{ label: 'ORDERING_SENSITIVE', evaluation: 'development' }]);
  });
});

describe('concurrency', () => {
  it('counts open hours by deciding bar and ENTER pairs per decision time', () => {
    const start = Date.parse('2025-11-22T00:00:00.000Z');
    const at = (hours: number, bar: number) => ({
      row: {
        ...LEARNABLE[0]!,
        time: start + hours * H,
        outcome: { ...LEARNABLE[0]!.outcome, bar },
      },
    });
    const times = [start, start + 4 * H, start + 8 * H];
    const c = concurrency([at(0, 2), at(0, 5), at(4, 24)], start, start + 48 * H, times);
    expect(c).toEqual({
      hours: 48,
      maxOpen: 2,
      medianOpen: 1,
      decisionTimes: 3,
      timesWithEntry: 2,
      maxPairsPerTime: 2,
      medianPairsPerTime: 1,
      meanPairsPerTime: 1,
    });
  });
});

describe('the runners', () => {
  const identity = async () => ({ codeCommit: 'c'.repeat(40), codeBlobs: {} });

  it('refuse to run while a tracked file differs from the commit', async () => {
    const dirty: Git = async (...args) => (args[0] === 'status' ? ' M scripts/x.ts' : 'abc');
    await expect(studyIdentity(dirty)).rejects.toThrow('commit before running');
    const clean: Git = async (...args) => (args[0] === 'status' ? '' : 'abc');
    expect((await studyIdentity(clean)).codeBlobs).toEqual(
      Object.fromEntries(STUDY_FILES.map((f) => [f, 'abc'])),
    );
  });

  it('export verifies inputs and v1 parity, writes once and never overwrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'expected-net-'));
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'klines'), { recursive: true });
    const candleFiles: Record<string, { sha256: string; candles: number; retrievedAt: string }> =
      {};
    const candles: Record<string, HourCandle[]> = {};
    for (const [i, symbol] of PROTOCOL.universe.members.entries()) {
      candles[symbol] = walk(i + 1, HISTORY, HISTORY + 230 * H);
      const text = JSON.stringify({ symbol, candles: candles[symbol] });
      await writeFile(join(dataDir, 'klines', `${symbol}-1h.json`), text);
      candleFiles[symbol] = { sha256: sha256(text), candles: 230, retrievedAt: 'r' };
    }
    await writeFile(join(dataDir, 'universe.json'), 'universe');
    const manifest = {
      repositoryCommit: 'run',
      protocol: { id: PROTOCOL.protocolId, sha256: SPEC.basis.protocol.sha256 },
      universe: { path: 'universe.json', sha256: sha256('universe') },
      candleFiles,
    };
    const results = recordedFor(candles, PROTOCOL.universe.members);
    const write = async (name: string, body: unknown) => {
      const path = join(root, name);
      await writeFile(path, JSON.stringify(body));
      return { path, sha256: sha256(await readFile(path)), runCommit: 'run' };
    };
    const recorded = await write('recorded.json', { manifest, results });
    const out = join(root, 'out');

    const first = await runExpectedNetExport(dataDir, out, identity, recorded);
    expect(first.status).toBe('CREATED');
    expect(first.coverage.observations).toBe(40);
    expect(first.parity.pass).toBe(true);
    const written = JSON.parse(await readFile(first.path, 'utf8'));
    expect(sha256(await readFile(first.path))).toBe(first.contentSha256);
    expect(written.columns).toEqual(COLUMNS);
    expect(written.manifest.specification.fileSha256).toBe(
      sha256(await readFile('docs/spot-24h-expected-net-t3s3-dev-v1.json')),
    );
    expect((await runExpectedNetExport(dataDir, out, identity, recorded)).status).toBe('UNCHANGED');

    const bad = clone(results);
    bad.splits.train.observations += 1;
    const mismatch = await write('bad.json', { manifest, results: bad });
    await expect(runExpectedNetExport(dataDir, out, identity, mismatch)).rejects.toThrow(
      'INTEGRITY_FAILURE: v1 parity: $.splits.train',
    );
    await expect(
      runExpectedNetExport(dataDir, out, identity, { ...recorded, sha256: 'x' }),
    ).rejects.toThrow('is not x');
    await writeFile(join(dataDir, 'klines', 'BTCUSDT-1h.json'), '{"candles":[]}');
    await expect(runExpectedNetExport(dataDir, out, identity, recorded)).rejects.toThrow(
      'differs from the manifest',
    );
  }, 60_000);

  it('evaluate reads only this commit and specification, and writes once', async () => {
    const out = await mkdtemp(join(tmpdir(), 'expected-net-eval-'));
    const rows = syntheticRows(2, 21, true);
    const fileSha256 = sha256(await readFile('docs/spot-24h-expected-net-t3s3-dev-v1.json'));
    const specification = { id: SPEC.specificationId, sha256: specSha256(), fileSha256 };
    const commit = 'c'.repeat(40);
    const datasetText = JSON.stringify({
      manifest: { codeCommit: commit, specification },
      coverage: { pairs: { P0USDT: {}, P1USDT: {} } },
      parity: { pass: true },
      columns: COLUMNS,
      rows: rows.map(toColumns),
    });
    const datasetName = `spot-24h-expected-net-t3s3-dev-v1-dataset-${'a'.repeat(12)}-${commit.slice(0, 12)}.json`;
    await writeFile(join(out, datasetName), datasetText);
    const { note: _note, ...params } = SPEC.forecasters.C.verifiedParams;
    const evaluations = predictionsFor(rows, truth);
    for (const set of Object.values(evaluations)) set.fit['params'] = params;
    const predictions = (datasetSha256: string, extra = {}) =>
      JSON.stringify({
        manifest: {
          codeCommit: commit,
          specification,
          dataset: { path: datasetName, sha256: datasetSha256 },
        },
        environment: { python: 'test' },
        evaluations,
        ...extra,
      });
    const predictionsPath = join(
      out,
      `spot-24h-expected-net-t3s3-dev-v1-predictions-${'a'.repeat(12)}-${commit.slice(0, 12)}.json`,
    );
    await writeFile(predictionsPath, predictions('other'));
    await expect(runExpectedNetEvaluate(out, identity)).rejects.toThrow('another dataset');
    await writeFile(predictionsPath, predictions(sha256(datasetText)));
    const other = async () => ({ codeCommit: 'd'.repeat(40), codeBlobs: {} });
    await expect(runExpectedNetEvaluate(out, other)).rejects.toThrow('expected one dataset');

    const first = await runExpectedNetEvaluate(out, identity);
    expect(first.status).toBe('CREATED');
    expect(first.summary.conclusion.verdict).toBeDefined();
    const written = JSON.parse(await readFile(first.path, 'utf8'));
    expect(written.manifest.predictions.sha256).toBe(sha256(await readFile(predictionsPath)));
    expect(written.manifest.dataset.sha256).toBe(sha256(datasetText));
    expect(written.results.specification.sha256).toBe(specSha256());
    expect((await runExpectedNetEvaluate(out, identity)).status).toBe('UNCHANGED');
    await writeFile(first.path, 'other');
    expect((await runExpectedNetEvaluate(out, identity)).status).toBe('CONFLICT');
    expect(await readFile(first.path, 'utf8')).toBe('other');

    evaluations.final.fit['params'] = { ...params, max_iter: 101 };
    await writeFile(predictionsPath, predictions(sha256(datasetText)));
    await expect(runExpectedNetEvaluate(out, identity)).rejects.toThrow('parameters differ');
  }, 120_000);
});
