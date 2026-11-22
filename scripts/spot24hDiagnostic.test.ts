import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as spot24h from './spot24h';
import {
  CATEGORIES,
  DAY_MS,
  HOUR_MS,
  PROTOCOL,
  evaluateFit,
  fitFrequencies,
  netReturn,
  type Category,
  type HourCandle,
  type Observation,
  type Protocol,
} from './spot24h';
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
import {
  diagnose,
  diagnosticIdentity,
  maxDifference,
  readCandleFiles,
  rebuildRows,
  reconcile,
  reconcileEvaluation,
  verifyOriginal,
  type Git,
} from './spot24hDiagnosticRun';

/** mulberry32: exact 32-bit arithmetic, so successive draws are independent. */
function random32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TEST_START = Date.parse(PROTOCOL.splits.boundaries[1]!);
const ZERO_COST: Protocol = {
  ...PROTOCOL,
  costs: { ...PROTOCOL.costs, feePerFill: 0, slippagePerMarketFill: 0 },
};

/** A row whose every scenario has the same fill; net is v1's own formula. */
function row(
  category: Category,
  exit: number,
  options: Partial<Pick<DiagnosticRow, 'symbol' | 'time' | 'cell' | 'v' | 'holdClose'>> = {},
): DiagnosticRow {
  const time = options.time ?? TEST_START;
  const outcome = { category, exit, net: netReturn(100, exit, category) };
  return {
    symbol: options.symbol ?? 'AAAUSDT',
    time,
    day: Math.floor(time / DAY_MS),
    cell: options.cell ?? 'mid/positive',
    v: options.v ?? 0.01,
    entry: 100,
    holdClose: options.holdClose ?? exit,
    outcomes: PROTOCOL.scenarios.map(() => outcome),
  };
}

/**
 * Synthetic observations over a split: each cell has its own TARGET probability, and every
 * outcome's fill and net return are consistent with v1's accounting (entry 1).
 */
function synthetic(split: 'train' | 'test', seed: number, perDay = 12) {
  const random = random32(seed);
  const rates: Record<string, number> = {
    'low/positive': 0.2,
    'low/nonPositive': 0.25,
    'mid/positive': 0.3,
    'mid/nonPositive': 0.35,
    'high/positive': 0.4,
    // Rare: below the 300-observation floor in a train fit of 60 days.
    'high/nonPositive': 0.5,
  };
  const cells = Object.keys(rates);
  const [firstDay, days] =
    split === 'train' ? [Date.parse(PROTOCOL.decisions.firstDecision), 60] : [TEST_START, 40];
  const observations: Observation[] = [];
  const rows: DiagnosticRow[] = [];
  for (let d = 0; d < days; d += 1) {
    for (let k = 0; k < perDay; k += 1) {
      const time = firstDay + d * DAY_MS + (k % 6) * 4 * HOUR_MS;
      const cell = k === 0 && d % 3 === 0 ? 'high/nonPositive' : cells[k % 5]!;
      const v = 0.005 + random() * 0.02;
      const outcomes = PROTOCOL.scenarios.map(({ targetV, stopV }) => {
        const u = random();
        let category: Category = 'TIMEOUT';
        if (u < rates[cell]!) category = 'TARGET';
        else if (u < rates[cell]! + 0.3) category = 'STOP';
        else if (u > 0.995) category = 'AMBIGUOUS';
        const exit =
          category === 'TARGET'
            ? 1 + targetV * v
            : category === 'TIMEOUT'
              ? 1 + (random() - 0.5) * 0.02
              : 1 - stopV * v;
        return { category, exit, net: netReturn(1, exit, category) };
      });
      observations.push({
        symbol: `P${k % 3}USDT`,
        time,
        day: Math.floor(time / DAY_MS),
        cell,
        v,
        outcomes: outcomes.map(({ category, net }) => ({ category, net })),
      });
      rows.push({
        symbol: `P${k % 3}USDT`,
        time,
        day: Math.floor(time / DAY_MS),
        cell,
        v,
        entry: 1,
        holdClose: 1 + (random() - 0.5) * 0.02,
        outcomes,
      });
    }
  }
  return { observations, rows };
}

describe('gross-to-net decomposition', () => {
  it('splits a target fill in trade order, by hand', () => {
    const d = decompose(100, 103, 'TARGET');
    expect(d.gross).toBeCloseTo(0.03, 15);
    expect(d.entrySlippage).toBeCloseTo(1.03 / 1.0005 - 1.03, 15);
    expect(d.entryFee).toBeCloseTo((-0.001 * 1.03) / 1.0005, 15);
    // A target is a resting limit: no exit slippage.
    expect(d.exitSlippage).toBe(0);
    expect(d.exitFee).toBeCloseTo((-0.001 * 0.999 * 1.03) / 1.0005, 15);
    expect(d.net).toBeCloseTo((0.999 ** 2 * 1.03) / 1.0005 - 1, 15);
  });

  it('telescopes to the protocol net return for any fill and category', () => {
    const random = random32(11);
    for (let i = 0; i < 10_000; i += 1) {
      const entry = 0.0001 + random() * 50_000;
      const exit = entry * (0.7 + random() * 0.6);
      const category = CATEGORIES[Math.floor(random() * 4)]!;
      const d = decompose(entry, exit, category);
      const rebuilt = d.gross + d.entrySlippage + d.entryFee + d.exitSlippage + d.exitFee;
      expect(Math.abs(rebuilt - netReturn(entry, exit, category))).toBeLessThan(1e-14);
      expect(d.net).toBeCloseTo(netReturn(entry, exit, category), 14);
      expect(d.entryFee).toBeLessThan(0);
      expect(d.exitSlippage < 0).toBe(category !== 'TARGET');
    }
  });

  it('has no cost at zero fees and slippage: the counterfactual is the gross return', () => {
    const d = decompose(100, 97, 'STOP', ZERO_COST);
    expect(d.net).toBe(d.gross);
    expect([d.entrySlippage, d.entryFee, d.exitSlippage, d.exitFee]).toEqual([0, 0, 0, 0]);
  });

  it('reconciles the means with the recorded net, and exposes a recorded net that differs', () => {
    const rows = [row('TARGET', 103), row('STOP', 97), row('TIMEOUT', 100.4), row('AMBIGUOUS', 97)];
    const r = returnDecomposition(rows, 0);
    expect(r.observations).toBe(4);
    expect(r.gross).toBeCloseTo((0.03 - 0.03 + 0.004 - 0.03) / 4, 15);
    expect(r.fees! + r.slippage!).toBeCloseTo(r.net! - r.gross!, 15);
    expect(r.fees).toBeCloseTo(r.entryFee! + r.exitFee!, 15);
    expect(r.slippage).toBeCloseTo(r.entrySlippage! + r.exitSlippage!, 15);
    expect(Math.abs(r.residual!)).toBeLessThan(1e-15);
    expect(r.maxRowResidual).toBeLessThan(1e-15);

    const tampered = rows.map((x, i) =>
      i === 1 ? { ...x, outcomes: x.outcomes.map((o) => ({ ...o, net: o.net + 0.01 })) } : x,
    );
    const t = returnDecomposition(tampered, 0);
    expect(t.residual).toBeCloseTo(0.01 / 4, 12);
    expect(t.maxRowResidual).toBeCloseTo(0.01, 12);
    expect(returnDecomposition([], 0).residual).toBeNull();
  });
});

const byCategory = (a: ReturnType<typeof outcomeAttribution>) =>
  Object.fromEntries(a.categories.map((c) => [c.category, c])) as Record<
    Category,
    (typeof a.categories)[number]
  >;

describe('outcome attribution', () => {
  const rows = [
    row('TARGET', 103, { holdClose: 105 }),
    row('TARGET', 103, { holdClose: 102 }),
    row('STOP', 97, { holdClose: 99 }),
    row('TIMEOUT', 100.5),
    row('STOP', 96, { holdClose: 96 }),
  ];

  it('counts, shares and weighted contributions add up to the scenario mean', () => {
    const a = outcomeAttribution(rows, 0);
    const by = byCategory(a);
    expect(a.categories.map((c) => c.category)).toEqual(['TARGET', 'STOP', 'TIMEOUT', 'AMBIGUOUS']);
    expect(by.TARGET).toMatchObject({ count: 2, share: 0.4 });
    expect(by.STOP).toMatchObject({ count: 2, share: 0.4 });
    expect(by.TIMEOUT).toMatchObject({ count: 1, share: 0.2 });
    expect(by.TARGET.meanGross).toBeCloseTo(0.03, 15);
    expect(by.STOP.meanGross).toBeCloseTo(-0.035, 15);
    expect(by.STOP.meanNet).toBeCloseTo(
      (netReturn(100, 97, 'STOP') + netReturn(100, 96, 'STOP')) / 2,
      15,
    );
    // An absent outcome weighs nothing and has no mean.
    expect(by.AMBIGUOUS).toMatchObject({
      count: 0,
      share: 0,
      meanGross: null,
      meanNet: null,
      contributionGross: 0,
      contributionNet: 0,
    });
    const sum = (key: 'contributionGross' | 'contributionNet' | 'contributionAfterExit') =>
      a.categories.reduce((s, c) => s + c[key]!, 0);
    expect(sum('contributionGross')).toBeCloseTo(a.meanGross!, 15);
    expect(sum('contributionNet')).toBeCloseTo(a.meanNet!, 15);
    expect(by.TARGET.contributionNet).toBeCloseTo(0.4 * by.TARGET.meanNet!, 15);
    expect(a.meanGross).toBeCloseTo((0.03 + 0.03 - 0.03 + 0.005 - 0.04) / 5, 15);
  });

  it('attributes the gap to holding until the 24th close to the moves after each exit', () => {
    const a = outcomeAttribution(rows, 0);
    const by = byCategory(a);
    expect(by.TARGET.meanAfterExit).toBeCloseTo((0.02 - 0.01) / 2, 15);
    expect(by.STOP.meanAfterExit).toBeCloseTo(0.01, 15);
    // A timeout exits at the 24th close.
    expect(by.TIMEOUT.meanAfterExit).toBe(0);
    const after = a.categories.reduce((s, c) => s + c.contributionAfterExit!, 0);
    expect(a.meanHoldGross).toBeCloseTo(a.meanGross! + after, 15);
  });

  it('keeps each scenario separate', () => {
    const mixed = { ...row('TARGET', 103) };
    mixed.outcomes = [
      { category: 'STOP', exit: 97, net: netReturn(100, 97, 'STOP') },
      ...mixed.outcomes.slice(1),
    ];
    expect(outcomeAttribution([mixed], 0).categories[1]!.count).toBe(1);
    expect(outcomeAttribution([mixed], 1).categories[0]!.count).toBe(1);
  });
});

describe('level distances against costs', () => {
  it('describes the original levels, cost shares and break-even shares', () => {
    const rows = [
      row('TARGET', 103, { v: 0.01 }),
      row('STOP', 97, { v: 0.01 }),
      row('AMBIGUOUS', 97, { v: 0.01 }),
      row('TIMEOUT', 100, { v: 0.01 }),
    ];
    const d = levelDistances(rows, 0); // T3S3
    expect(d.targetDistance!.every((x) => Math.abs(x - 0.03) < 1e-15)).toBe(true);
    expect(d.stopDistance!.every((x) => Math.abs(x - 0.03) < 1e-15)).toBe(true);
    const target = netReturn(1, 1.03, 'TARGET');
    const stop = netReturn(1, 0.97, 'STOP');
    expect(d.targetCostShare![2]).toBeCloseTo((0.03 - target) / 0.03, 12);
    // The stop fill loses more than its distance: costs add to the loss.
    expect(d.stopCostShare![2]).toBeCloseTo((-0.03 - stop) / 0.03, 12);
    expect(d.breakEvenGross).toBe(0.5);
    expect(d.breakEvenNet![2]).toBeCloseTo(-stop / (target - stop), 12);
    expect(d.breakEvenNet![2]).toBeGreaterThan(0.5);
    // AMBIGUOUS is decided at a level but never a success.
    expect(d.decidedTargetShare).toBeCloseTo(1 / 3, 15);
    const wide = levelDistances(rows, 5); // T8S5
    expect(wide.targetDistance![0]).toBeCloseTo(0.08, 15);
    expect(wide.breakEvenGross).toBeCloseTo(5 / 13, 15);
    expect(levelDistances([], 0).targetDistance).toBeNull();
  });
});

describe('indicator cells against the base rate', () => {
  const train = synthetic('train', 3);
  const test = synthetic('test', 4);
  const fits = fitFrequencies(train.observations);

  it('reproduces the protocol evaluation of the same fit and observations', () => {
    expect(fits[0]!.cells['high/nonPositive']!.p).toBeNull();
    const recorded = evaluateFit(fits, test.observations, 'test');
    for (const [s, r] of recorded.entries()) {
      const q = cellQuality(fits[s]!, test.rows, s);
      expect(q.evaluated).toBe(r.evaluated);
      expect(q.evaluated).toBeLessThan(test.rows.length);
      expect(q.brierMethod).toBeCloseTo(r.brier.method!, 14);
      expect(q.brierBase).toBeCloseTo(r.brier.base!, 14);
      expect(q.deltaBrier).toBeCloseTo(r.brier.delta!, 14);
      expect(q.skillScore).toBeCloseTo(r.brier.skillScore!, 12);
      expect(q.inTheLarge).toBeCloseTo(r.calibration.inTheLarge!, 14);
      expect(q.weightedCellError).toBeCloseTo(r.calibration.weightedCellError!, 14);
      expect(q.cells.map((c) => c.predicted)).toEqual(r.calibration.cells.map((c) => c.predicted));
      const reconciled = reconcileEvaluation(r, fits[s]!, test.rows, s);
      expect(reconciled).toMatchObject({ countsMatch: true, pass: true });
    }
  });

  it('splits ΔBrier into cell contributions that add up, matching the closed form', () => {
    const q = cellQuality(fits[0]!, test.rows, 0);
    const scored = q.cells.filter((c) => c.predicted !== null);
    const total = scored.reduce((s, c) => s + c.deltaBrierContribution!, 0);
    expect(total).toBeCloseTo(q.deltaBrier!, 15);
    const p0 = q.baseRate!;
    for (const c of scored) {
      const closed = c.observations * (c.predicted! - p0) * (c.predicted! + p0 - 2 * c.observed!);
      expect(c.deltaBrierContribution! * q.evaluated).toBeCloseTo(closed, 10);
      expect(c.observedMinusBase).toBeCloseTo(c.observed! - p0, 15);
    }
    const rare = q.cells.find((c) => c.cell === 'high/nonPositive')!;
    expect(rare).toMatchObject({ predicted: null, absError: null, deltaBrier: null });
    expect(rare.observations).toBeGreaterThan(0);
    expect(q.cells.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1, 15);
  });

  it('flags a recorded figure that differs from the diagnosis', () => {
    const recorded = evaluateFit(fits, test.observations, 'test');
    const off = { ...recorded[0]!, meanNetReturn: recorded[0]!.meanNetReturn! + 1e-9 };
    expect(reconcileEvaluation(off, fits[0]!, test.rows, 0).pass).toBe(false);
    const counts = { ...recorded[0]!, counts: { ...recorded[0]!.counts, STOP: -1 } };
    expect(reconcileEvaluation(counts, fits[0]!, test.rows, 0)).toMatchObject({
      countsMatch: false,
      pass: false,
    });
  });
});

describe('breakdowns by pair and month', () => {
  const train = synthetic('train', 5);
  const test = synthetic('test', 6);
  const fit = fitFrequencies(train.observations)[1]!;

  it('group contributions add up to the totals', () => {
    for (const keyOf of [pairOf, monthOf]) {
      const g = groupQuality(fit, test.rows, 1, keyOf);
      const delta = g.groups.reduce((s, x) => s + x.deltaBrierContribution!, 0);
      expect(delta).toBeCloseTo(g.totals.deltaBrier!, 15);
      expect(g.groups.reduce((s, x) => s + x.observations, 0)).toBe(test.rows.length);
      const net = g.groups.reduce((s, x) => s + x.meanNet * x.observations, 0) / test.rows.length;
      expect(net).toBeCloseTo(outcomeAttribution(test.rows, 1).meanNet!, 15);
      expect(g.groups.map((x) => x.key)).toEqual([...g.groups.map((x) => x.key)].sort());
    }
  });

  it('measures the variance a grouping describes against no structure', () => {
    const a = [row('TARGET', 103, { symbol: 'A' }), row('TARGET', 103, { symbol: 'A' })];
    const b = [row('STOP', 97, { symbol: 'B' }), row('STOP', 97, { symbol: 'B' })];
    const separated = groupQuality(fit, [...a, ...b], 0, pairOf).varianceShare;
    expect(separated.target).toBeCloseTo(1, 15);
    expect(separated.gross).toBeCloseTo(1, 15);
    expect(separated.noStructure).toBeCloseTo(1 / 3, 15);
    const mixed = groupQuality(
      fit,
      [a[0]!, b[0]!, { ...a[1]!, symbol: 'B' }, { ...b[1]!, symbol: 'A' }],
      0,
      pairOf,
    );
    expect(mixed.varianceShare.target).toBeCloseTo(0, 15);
    expect(groupQuality(fit, a, 0, pairOf).varianceShare.target).toBeNull();
  });

  it('groups by UTC calendar month', () => {
    const at = (iso: string) => row('TIMEOUT', 100, { time: Date.parse(iso) });
    expect(monthOf(at('2026-05-31T23:00:00Z'))).toBe('2026-05');
    expect(monthOf(at('2026-06-01T00:00:00Z'))).toBe('2026-06');
  });
});

describe('rebuilding observations with the run code', () => {
  const start = Date.parse(PROTOCOL.data.historyStart);
  const random = random32(21);
  let price = 100;
  const candles: HourCandle[] = Array.from({ length: 700 }, (_, k) => {
    const open = price;
    const close = open * (1 + (random() - 0.5) * 0.03);
    price = close;
    return {
      timestamp: start + k * HOUR_MS,
      closeTime: start + (k + 1) * HOUR_MS - 1,
      open,
      high: Math.max(open, close) * (1 + random() * 0.006),
      low: Math.min(open, close) * (1 - random() * 0.006),
      close,
    };
  });
  const symbol = PROTOCOL.universe.members[0]!;

  it('gives v1 outcomes their fills, entries and 24th closes', () => {
    const { rows, observations } = rebuildRows(spot24h, { [symbol]: candles });
    const index = spot24h.indexHourly(candles, Date.parse(PROTOCOL.data.collectionCutoff));
    expect(observations).toEqual(spot24h.pairObservations(symbol, index).observations);
    expect(rows.length).toBeGreaterThan(100);
    for (const [i, r] of rows.entries()) {
      const k = (r.time - start) / HOUR_MS;
      expect(r.entry).toBe(candles[k]!.open);
      expect(r.holdClose).toBe(candles[k + 23]!.close);
      expect(r.outcomes.map(({ category, net }) => ({ category, net }))).toEqual(
        observations[i]!.outcomes,
      );
      expect(r.split).toBe('train');
    }
    const d = diagnose(
      rows,
      { development: fitFrequencies(observations), confirmatory: fitFrequencies(observations) },
      PROTOCOL.scenarios,
    );
    expect(d.decomposition['train']).toHaveLength(6);
    expect(d.decomposition['train']![0]!.observations).toBe(rows.length);
    expect(d.decomposition['test']![0]!.observations).toBe(0);
    expect(Math.abs(d.decomposition['train']![3]!.residual!)).toBeLessThan(1e-15);
  });

  it('stops when a rebuilt fill differs from the outcome v1 recorded', () => {
    const changed = { ...spot24h, netReturn: () => 0 };
    expect(() => rebuildRows(changed, { [symbol]: candles })).toThrow(/differ from v1/);
  });
});

describe('reconciling with a recorded evaluation', () => {
  it('passes against the protocol run on the same candles, and names what differs', () => {
    const start = Date.parse(PROTOCOL.data.historyStart);
    const hours = (Date.parse(PROTOCOL.data.collectionCutoff) - start) / HOUR_MS;
    const random = random32(31);
    let price = 50;
    const candles: HourCandle[] = Array.from({ length: hours }, (_, k) => {
      const open = price;
      const close = open * (1 + (random() - 0.5) * 0.03);
      price = close;
      return {
        timestamp: start + k * HOUR_MS,
        closeTime: start + (k + 1) * HOUR_MS - 1,
        open,
        high: Math.max(open, close) * (1 + random() * 0.006),
        low: Math.min(open, close) * (1 - random() * 0.006),
        close,
      };
    });
    const bySymbol = { [PROTOCOL.universe.members[0]!]: candles };
    const recorded = spot24h.evaluateProtocol(bySymbol);
    const { rows, observations } = rebuildRows(spot24h, bySymbol);
    const { fits, reconciliation } = reconcile(spot24h, recorded, rows, observations);
    expect(rows.filter((r) => r.split === 'test').length).toBeGreaterThan(1000);
    expect(reconciliation).toMatchObject({
      splitCounts: true,
      currentFitMatches: true,
      pass: true,
    });
    expect(reconciliation.evaluations.test).toHaveLength(6);
    expect(fits.confirmatory[0]!.base.n).toBe(
      recorded.splits.train.observations + recorded.splits.validation.observations,
    );

    const resized = {
      ...recorded,
      splits: { ...recorded.splits, test: { ...recorded.splits.test, observations: 1 } },
    };
    expect(reconcile(spot24h, resized, rows, observations).reconciliation).toMatchObject({
      splitCounts: false,
      pass: false,
    });
    const refit = { ...recorded, currentFit: fitFrequencies(observations.slice(1)) };
    expect(reconcile(spot24h, refit, rows, observations).reconciliation).toMatchObject({
      currentFitMatches: false,
      pass: false,
    });
  }, 30_000);

  it('reads candle files only when each matches its recorded SHA-256', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot24h-diagnostic-klines-'));
    await mkdir(join(dir, 'klines'));
    const candle = { timestamp: 0, closeTime: 3_599_999, open: 1, high: 1, low: 1, close: 1 };
    const bytes = JSON.stringify({ symbol: 'AAAUSDT', candles: [candle] });
    await writeFile(join(dir, 'klines', 'AAAUSDT-1h.json'), bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await expect(
      readCandleFiles(dir, ['AAAUSDT'], { AAAUSDT: { sha256: digest } }),
    ).resolves.toEqual({
      AAAUSDT: [candle],
    });
    await expect(
      readCandleFiles(dir, ['AAAUSDT'], { AAAUSDT: { sha256: 'f'.repeat(64) } }),
    ).rejects.toThrow(/differs from the manifest/);
    await expect(readCandleFiles(dir, ['AAAUSDT'], {})).rejects.toThrow(
      /differs from the manifest/,
    );
  });
});

describe('provenance checks', () => {
  it('compares figures with null-aware differences', () => {
    expect(
      maxDifference([
        [1, 1],
        [null, null],
        [0.5, 0.25],
      ]),
    ).toBe(0.25);
    expect(maxDifference([[null, 0]])).toBe(Infinity);
  });

  it('refuses to name code that differs from the commit', async () => {
    const dirty: Git = async (...args) => (args[0] === 'status' ? ' M scripts/x.ts' : 'abc');
    await expect(diagnosticIdentity(dirty)).rejects.toThrow(/commit before running/);
    const clean: Git = async (...args) => (args[0] === 'status' ? '' : `blob:${args.at(-1)}`);
    const identity = await diagnosticIdentity(clean);
    expect(identity.diagnosticCommit).toBe('blob:HEAD');
    expect(identity.diagnosticBlobs['scripts/spot24hDiagnostic.ts']).toBe(
      'blob:scripts/spot24hDiagnostic.ts',
    );
  });

  it('accepts only the recorded result, run commit, blobs and src', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot24h-diagnostic-'));
    const content = JSON.stringify({
      manifest: { repositoryCommit: 'c0ffee', sourceBlobs: { 'scripts/spot24h.ts': 'b1' } },
      results: {},
    });
    const path = join(dir, 'result.json');
    await writeFile(path, content);
    const expected = {
      path,
      sha256: createHash('sha256').update(content).digest('hex'),
      repositoryCommit: 'c0ffee',
    };
    const git =
      (blob: string, drift = ''): Git =>
      async (...args) =>
        args[0] === 'rev-parse' ? blob : drift;
    await expect(verifyOriginal(git('b1'), expected)).resolves.toMatchObject({
      manifest: { repositoryCommit: 'c0ffee' },
    });
    await expect(
      verifyOriginal(git('b1'), { ...expected, sha256: '0'.repeat(64) }),
    ).rejects.toThrow(/not the recorded result/);
    await expect(
      verifyOriginal(git('b1'), { ...expected, repositoryCommit: 'other' }),
    ).rejects.toThrow(/names c0ffee/);
    await expect(verifyOriginal(git('b2'), expected)).rejects.toThrow(/blobs differ/);
    await expect(verifyOriginal(git('b1', 'src/lib/indicators.ts'), expected)).rejects.toThrow(
      /src differs/,
    );
  });
});
