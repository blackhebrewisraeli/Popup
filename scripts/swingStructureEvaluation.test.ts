import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/candleValidation';
import { stableSerialize } from './evaluationStore';
import { evaluateSwingStructure, type SwingStructureObservation } from './swingStructure';
import {
  aggregateTerms,
  assertNoLookAhead,
  baselineEligible,
  blockStarts,
  bootstrapInterval,
  bootstrapOrders,
  cellTerms,
  checkTimingInvariants,
  classifyPrimaryCell,
  evaluateSwingStructureStudy,
  forwardScan,
  indexBars,
  leaveOneMemberOut,
  loadSwingStructureEvaluationSpecification,
  medianOfPhases,
  observationWindow,
  observe,
  outcomeAt,
  preObservationCategory,
  prepareCell,
  replicateM,
  replicateOrder,
  serializeSwingStructureResults,
  SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID,
  SWING_STRUCTURE_EVALUATION_SPECIFICATION_PATH,
  SwingStructureEvaluationRefusal,
  utcDay,
  type CellTable,
  type Configuration,
  type Interval,
  type MappedCandle,
  type PrimaryClassificationInput,
  type Stat,
  type SwingStructureEvaluationResults,
  type SwingStructureEvaluationSpecification,
} from './swingStructureEvaluation';

// Every candle, outcome and statistic below is synthetic. Nothing reads an export, a scan, a
// market outcome or an experiment record.
const DAY = DAY_MS;
const T0 = Date.UTC(2025, 0, 1);
const open = (i: number) => T0 + i * DAY;
const close = (i: number) => open(i + 1) - 1;
const L1R1: Configuration = { id: 'L1R1', leftBars: 1, rightBars: 1, role: 'exploratory' };
const L5R5: Configuration = { id: 'L5R5', leftBars: 5, rightBars: 5, role: 'primary' };

function bar(timestamp: number, high: number, low: number, closePrice: number, openPrice?: number) {
  return {
    timestamp,
    closeTime: timestamp + DAY - 1,
    open: openPrice ?? (high + low) / 2,
    high,
    low,
    close: closePrice,
  } satisfies MappedCandle;
}

type Bar = [high: number, low: number, close: number];
const series = (bars: Bar[]) => bars.map(([h, l, c], i) => bar(open(i), h, l, c));

/** A deterministic synthetic random walk; open is the previous close. */
function walk(seed: string, first: number, count: number): MappedCandle[] {
  const u = (i: number, n: number) =>
    createHash('sha256').update(`${seed}|${i}|${n}`).digest().readUInt32BE(0) / 2 ** 32;
  let price = 100;
  return Array.from({ length: count }, (_, i) => {
    const o = price;
    price = o * Math.exp((u(i, 0) - 0.5) * 0.1);
    return bar(
      first + i * DAY,
      Math.max(o, price) * (1 + 0.02 * u(i, 1)),
      Math.min(o, price) * (1 - 0.02 * u(i, 2)),
      price,
      o,
    );
  });
}

function refusal(run: () => unknown): string | null {
  try {
    run();
  } catch (error) {
    if (error instanceof SwingStructureEvaluationRefusal) return error.code;
    throw error;
  }
  return null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const ok = (value: number): Stat => ({ status: 'AVAILABLE', value });
const valueOf = (s: Stat) => (s.status === 'AVAILABLE' ? s.value : Number.NaN);

// The documented walkthrough of the candidate contract (scripts/swingStructure.test.ts).
const WALKTHROUGH: Bar[] = [
  [10, 8, 9],
  [12, 10, 11],
  [11, 9, 10],
  [14, 11, 12.5],
  [13, 10, 11.5],
  [15, 12, 13.5],
  [12, 10.5, 11],
  [11, 9.5, 10.2],
  [10.4, 9, 9.4],
  [10, 9.2, 9.6],
];

describe('identity and preservation', () => {
  it('loads only the frozen specification this module implements', async () => {
    const spec = await loadSwingStructureEvaluationSpecification();
    expect(spec.specificationId).toBe(SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID);
    expect(SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID).toBe(
      '99fff59080a3b2f94ee5fdb1310cce7624912d7eafdad3fe8b82c4c3203dece2',
    );

    const dir = await mkdtemp(join(tmpdir(), 'swing-structure-spec-'));
    const edited = join(dir, 'edited.json');
    await writeFile(
      edited,
      JSON.stringify({ ...spec, horizons: { ...spec.horizons, primary: 5 } }),
    );
    await expect(loadSwingStructureEvaluationSpecification(edited)).rejects.toMatchObject({
      code: 'SPECIFICATION',
    });
    // A consistent self-hash is not enough: it must be the identity this module implements.
    const { specificationId: _id, ...content } = { ...spec, studyId: 'another-study' };
    const rehashed = join(dir, 'rehashed.json');
    await writeFile(
      rehashed,
      JSON.stringify({ ...content, specificationId: sha256(stableSerialize(content)) }),
    );
    await expect(loadSwingStructureEvaluationSpecification(rehashed)).rejects.toMatchObject({
      code: 'SPECIFICATION',
    });
  });

  it('calls the candidate and its validation dependency at their pinned blob ids', async () => {
    const spec = JSON.parse(await readFile(SWING_STRUCTURE_EVALUATION_SPECIFICATION_PATH, 'utf8'));
    const blobs = (spec as { candidate: { sourceBlobs: Record<string, string> } }).candidate
      .sourceBlobs;
    expect(Object.keys(blobs).sort()).toEqual([
      'scripts/swingStructure.ts',
      'src/lib/candleValidation.ts',
    ]);
    for (const [path, blob] of Object.entries(blobs)) {
      const content = await readFile(path);
      const id = createHash('sha1')
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex');
      expect(id, path).toBe(blob);
    }
  });
});

describe('1. window and outcome boundaries, and timing violations', () => {
  const candles = walk('boundaries', open(0), 260);
  const D = open(200);

  it('passes the candidate exactly the candles opening on D-179 through D, in export order', () => {
    const window = observationWindow(candles, D, 180);
    expect(window).toHaveLength(180);
    expect(window[0]?.timestamp).toBe(D - 179 * DAY);
    expect(window.at(-1)?.timestamp).toBe(D);

    const observation = observe(candles, 'X', D, L5R5, 180);
    expect(observation.tau).toBe(D + DAY - 1);
    expect(observation.candidate).toMatchObject({
      cutoff: D + DAY - 1,
      closedCandles: 180,
      latestCloseTime: D + DAY - 1,
    });
    // Export order is kept, never sorted: a swap inside the window is the candidate's defect.
    const swapped = [...candles];
    [swapped[100], swapped[101]] = [swapped[101]!, swapped[100]!];
    expect(observe(swapped, 'X', D, L5R5, 180).state).toBe('INVALID_INPUT');
  });

  it('marks an absent first or last window day WINDOW_INCOMPLETE and a gap INVALID_INPUT', () => {
    const without = (day: number) => candles.filter((c) => c.timestamp !== day);
    for (const day of [D - 179 * DAY, D]) {
      const observation = observe(without(day), 'X', D, L5R5, 180);
      expect(observation).toMatchObject({ state: 'WINDOW_INCOMPLETE', sign: 0, reference: null });
    }
    // D-180 is outside the window, so its absence changes nothing.
    expect(observe(without(D - 180 * DAY), 'X', D, L5R5, 180)).toEqual(
      observe(candles, 'X', D, L5R5, 180),
    );
    const gap = observe(without(D - 50 * DAY), 'X', D, L5R5, 180);
    expect(gap.state).toBe('INVALID_INPUT');
    expect(gap.candidate.status === 'INVALID_INPUT' && gap.candidate.issues[0]?.code).toBe(
      'MISSING_INTERVAL',
    );
  });

  it('measures r from the open of D+1 to the open of D+1+h, and nothing else', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(open(i), 500, 1, 100 + i, 100 + 2 * i));
    for (const h of [5, 20]) {
      const outcome = outcomeAt(indexBars(bars), open(10), h, close(39));
      expect(outcome).toEqual({
        status: 'AVAILABLE',
        referenceOpen: 100 + 2 * 11,
        endpointOpen: 100 + 2 * (11 + h),
        r: Math.log(100 + 2 * (11 + h)) - Math.log(100 + 2 * 11),
      });
    }
    // D's own close, D+h and D+2+h never enter.
    const altered = bars.map((b, i) =>
      [10, 30, 32].includes(i) ? { ...b, close: 7, open: 9 } : b,
    );
    expect(outcomeAt(indexBars(altered), open(10), 20, close(39))).toEqual(
      outcomeAt(indexBars(bars), open(10), 20, close(39)),
    );
  });

  it('reports MISSING and INVALID outcomes and refuses one whose endpoint has not closed', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(open(i), 500, 1, 100, 100 + i));
    const at = (list: MappedCandle[], cutoff = close(39)) =>
      outcomeAt(indexBars(list), open(10), 20, cutoff);
    expect(at(bars.filter((b) => b.timestamp !== open(11))).status).toBe('MISSING');
    expect(at(bars.filter((b) => b.timestamp !== open(31))).status).toBe('MISSING');
    expect(at([...bars, bars[31]!])).toMatchObject({
      status: 'INVALID',
      endpoint: { status: 'INVALID', issues: ['DUPLICATE_TIMESTAMP'] },
    });
    const broken = bars.map((b, i) => (i === 11 ? { ...b, high: 0.5 } : b));
    expect(at(broken)).toMatchObject({
      status: 'INVALID',
      reference: { status: 'INVALID', issues: expect.arrayContaining(['HIGH_BELOW_LOW']) },
    });
    expect(at(broken.filter((b) => b.timestamp !== open(31))).status).toBe('MISSING');
    // The endpoint bar must have closed by the export cutoff: one ms short refuses.
    expect(refusal(() => at(bars, close(31)))).toBeNull();
    expect(refusal(() => at(bars, close(31) - 1))).toBe('OUTCOME_PENDING');
  });

  it('refuses every violation of the timing invariants', () => {
    const output = evaluateSwingStructure({
      candles: series(WALKTHROUGH),
      timeframe: { label: '1D', intervalMs: DAY },
      config: { leftBars: 1, rightBars: 1 },
      cutoff: close(7),
    });
    if (output.status !== 'EVALUATED' || !output.reference || !output.breach?.firstExtreme) {
      throw new Error('fixture must be an Up state with a reported breach');
    }
    expect(refusal(() => checkTimingInvariants(output, close(7), 'fixture'))).toBeNull();
    // Each tampered output names the invariant it must trip.
    const tampered: [string, SwingStructureObservation, number][] = [
      [
        'pivot.availableAt = pivot.candleOpenTime',
        {
          ...output,
          supportingHighs: output.supportingHighs.map((p, i) =>
            i === 0 ? { ...p, availableAt: p.availableAt + 1 } : p,
          ),
        },
        close(7),
      ],
      ['<= establishedAt <= tau_D', output, (output.establishedAt ?? 0) - 1],
      [
        'latest availableAt of the supporting pivots',
        { ...output, establishedAt: close(7) },
        close(7),
      ],
      [
        'reference.availableAt <= establishedAt',
        {
          ...output,
          reference: { ...output.reference, candleOpenTime: open(6), availableAt: close(7) },
          breach: { firstClose: null, firstExtreme: null },
        },
        close(7),
      ],
      [
        'reference.availableAt < knowableAt',
        {
          ...output,
          breach: {
            firstClose: null,
            firstExtreme: {
              ...output.breach.firstExtreme,
              knowableAt: output.reference.availableAt,
            },
          },
        },
        close(7),
      ],
      [
        'knowableAt <= tau_D',
        {
          ...output,
          breach: {
            firstClose: null,
            firstExtreme: { ...output.breach.firstExtreme, knowableAt: close(8) },
          },
        },
        close(7),
      ],
    ];
    for (const [rule, candidate, tau] of tampered) {
      expect(
        refusal(() => checkTimingInvariants(candidate, tau, 'fixture')),
        rule,
      ).toBe('TIMING_INVARIANT');
      expect(() => checkTimingInvariants(candidate, tau, 'fixture'), rule).toThrow(rule);
    }
  });
});

describe('2. later candles never change an earlier observation', () => {
  const candles = walk('look-ahead', open(0), 300);
  const D = open(220);

  it('gives the same observation whatever follows D', () => {
    const base = observe(candles, 'X', D, L5R5, 180);
    const future = candles.filter((c) => c.timestamp > D);
    const variants = [
      candles.filter((c) => c.timestamp <= D),
      [
        ...candles.filter((c) => c.timestamp <= D),
        ...future.map((c) => ({ ...c, high: 1e6, low: 1e-6, open: 1, close: 1 })),
      ],
      [...candles, ...future.reverse(), bar(D + DAY, Number.NaN, 0, -1, 0)],
    ];
    for (const variant of variants) {
      expect(stableSerialize(observe(variant, 'X', D, L5R5, 180))).toBe(stableSerialize(base));
    }
    // What the run checks on the primary grid: the window with every later candle appended.
    const appended = evaluateSwingStructure({
      candles: [...observationWindow(candles, D, 180), ...future],
      timeframe: { label: '1D', intervalMs: DAY },
      config: { leftBars: 5, rightBars: 5 },
      cutoff: D + DAY - 1,
    });
    expect(refusal(() => assertNoLookAhead(base.candidate, appended, 'X'))).toBeNull();
  });

  it('refuses the run when the two outputs differ', () => {
    const base = observe(candles, 'X', D, L5R5, 180).candidate;
    const later = observe(candles, 'X', D + DAY, L5R5, 180).candidate;
    expect(refusal(() => assertNoLookAhead(base, later, 'X'))).toBe('LOOK_AHEAD');
  });
});

describe('3. baseline eligibility', () => {
  it.each([5, 20, 60])(
    'admits D, later dates, and earlier dates only from D-h-180 at h = %i',
    (h) => {
      const D = utcDay('2025-08-08');
      expect(baselineEligible(D, D, h, 180)).toBe(true);
      expect(baselineEligible(D, D + DAY, h, 180)).toBe(true);
      expect(baselineEligible(D, D - DAY, h, 180)).toBe(false);
      expect(baselineEligible(D, D - (h + 179) * DAY, h, 180)).toBe(false);
      expect(baselineEligible(D, D - (h + 180) * DAY, h, 180)).toBe(true);
      // The latest eligible earlier path ends at the open of D'+1+h: the window's first open.
      expect(D - (h + 180) * DAY + (1 + h) * DAY).toBe(D - 179 * DAY);
    },
  );

  it('leaves out exactly the stated preceding steps of the frozen grid', async () => {
    const spec = await loadSwingStructureEvaluationSpecification();
    const g0 = spec.observations.primaryGrid.dates.map(utcDay);
    const stated = { 5: 9, 20: 9, 60: 11 } as Record<number, number>;
    for (const h of spec.horizons.utcDays) {
      const D = g0[19]!;
      const excluded = g0.filter((d) => d < D && !baselineEligible(D, d, h, 180));
      expect(excluded, `h=${h}`).toHaveLength(stated[h]!);
      expect(g0.filter((d) => d >= D).every((d) => baselineEligible(D, d, h, 180))).toBe(true);
    }
  });

  it('takes every available outcome on eligible dates, whatever the state, and never a missing one as zero', () => {
    // Twelve dates, 20 days apart. Only the last date is directional. Date 1 has no outcome.
    const r = [0.05, null, 0.03, 0.04, -0.01, 0.02, 0.06, -0.03, 0.01, 0.02, 0.07, -0.02];
    const table: CellTable = {
      members: ['X'],
      dates: r.map((_, k) => utcDay('2025-01-01') + 20 * k * DAY),
      sign: [r.map((_, k) => (k === 11 ? 1 : 0))],
      r: [r],
      closeCategory: [r.map(() => null)],
    };
    const expected = { 5: (0.05 + -0.02) / 2, 20: (0.05 + -0.02) / 2, 60: -0.02 } as Record<
      number,
      number
    >;
    for (const h of [5, 20, 60]) {
      const [term] = cellTerms(prepareCell(table, h, 180)).flat();
      expect(term?.b, `h=${h}`).toBeCloseTo(expected[h]!, 15);
      expect(term?.baselineDates).toBe(h === 60 ? 1 : 2);
    }
  });
});

/**
 * Three dates, three members, horizon 20, so only D and later dates are eligible. Y has a tie
 * (r = 0) on d0 and an Up state without an outcome on d2. Expected values are worked by hand.
 */
const FIXTURE: CellTable = {
  members: ['X', 'Y', 'Z'],
  dates: [0, 1, 2].map((k) => utcDay('2025-03-01') + 20 * k * DAY),
  sign: [
    [1, 0, -1],
    [-1, 1, 1],
    [0, -1, 0],
  ],
  r: [
    [0.1, -0.2, 0.3],
    [0, 0.4, null],
    [-0.1, 0.2, 0.1],
  ],
  closeCategory: [
    ['NONE', null, 'AFTER_ESTABLISHMENT'],
    ['BEFORE_ESTABLISHMENT', 'NONE', 'NONE'],
    [null, 'NONE', null],
  ],
};

describe('4. weighting, components and ties against a hand-worked fixture', () => {
  // Computed inside each test, so a refusal fails that test rather than the whole file.
  const positions = () => cellTerms(prepareCell(FIXTURE, 20, 180));
  const bX0 = (0.1 - 0.2 + 0.3) / 3;
  const eX0 = 0.1 - bX0; // Up
  const eY0 = -(0 - (0 + 0.4) / 2); // Down, tie r = 0
  const eY1 = 0.4 - 0.4; // Up
  const eZ1 = -(0.2 - (0.2 + 0.1) / 2); // Down
  const eX2 = -(0.3 - 0.3); // Down
  const E = [(eX0 + eY0) / 2, (eY1 + eZ1) / 2, eX2];

  it('computes base rates, rate base rates and signed excess per observation', () => {
    const terms = positions().flat();
    expect(terms.map((t) => [FIXTURE.members[t.member], t.original, t.sign])).toEqual([
      ['X', 0, 1],
      ['Y', 0, -1],
      ['Y', 1, 1],
      ['Z', 1, -1],
      ['X', 2, -1],
    ]);
    const [x0, y0, y1, z1, x2] = terms;
    expect(x0).toMatchObject({ baselineDates: 3, piPlus: 2 / 3, piMinus: 1 / 3 });
    expect(x0?.b).toBeCloseTo(bX0, 15);
    expect(x0?.e).toBeCloseTo(eX0, 15);
    expect(x0?.a).toBeCloseTo(1 - 2 / 3, 15);
    // The tie counts as neither a rise nor a fall but stays in the denominator.
    expect(y0).toMatchObject({ baselineDates: 2, b: 0.2, piPlus: 0.5, piMinus: 0, a: 0 });
    expect(y0?.e).toBeCloseTo(eY0, 15);
    expect(y1).toMatchObject({ baselineDates: 1, b: 0.4, e: 0, a: 0 });
    expect(z1?.e).toBeCloseTo(eZ1, 15);
    expect(z1).toMatchObject({ piPlus: 1, piMinus: 0, a: 0 });
    expect(x2).toMatchObject({ b: 0.3, piPlus: 1, piMinus: 0, a: 0 });
  });

  it('weights members equally within a date and each date once', () => {
    const a = aggregateTerms(positions());
    expect(a.E[0]).toBeCloseTo(E[0]!, 15);
    expect(a.E[1]).toBeCloseTo(E[1]!, 15);
    expect(a.E[2]).toBe(0);
    expect(valueOf(a.M)).toBeCloseTo((E[0]! + E[1]! + E[2]!) / 3, 15);
    expect(valueOf(a.U)).toBeCloseTo((eX0 + eY1) / 2, 15);
    expect(valueOf(a.Dn)).toBeCloseTo((eY0 + eZ1 + eX2) / 3, 15);
    expect(valueOf(a.hitExcess)).toBeCloseTo((1 / 3 / 2 + 0 + 0) / 3, 15);
    expect(a).toMatchObject({
      dates: 3,
      observations: 5,
      upDates: 2,
      upObservations: 2,
      downDates: 3,
      downObservations: 3,
    });
  });

  it('leaves one member out at a time, dropping dates it leaves empty', () => {
    const lomo = leaveOneMemberOut(FIXTURE.members, positions());
    expect(valueOf(lomo['X']!.M)).toBeCloseTo((eY0 + (eY1 + eZ1) / 2) / 2, 15);
    expect(lomo['X']).toMatchObject({ dates: 2, observations: 3 });
    expect(valueOf(lomo['Y']!.M)).toBeCloseTo((eX0 + eZ1 + eX2) / 3, 15);
    expect(valueOf(lomo['Z']!.M)).toBeCloseTo(((eX0 + eY0) / 2 + eY1 + eX2) / 3, 15);
  });

  it('breaks down by member and by pre-observation close category with the same base rates', () => {
    const byMember = aggregateTerms(positions(), (t) => t.member === 0);
    expect(valueOf(byMember.M)).toBeCloseTo((eX0 + eX2) / 2, 15);
    const before = aggregateTerms(
      positions(),
      (t) => FIXTURE.closeCategory[t.member]?.[t.original] === 'BEFORE_ESTABLISHMENT',
    );
    expect(valueOf(before.M)).toBeCloseTo(eY0, 15);
    expect(before.dates).toBe(1);
  });
});

describe('5. moving block bootstrap', () => {
  let spec: SwingStructureEvaluationSpecification;
  beforeAll(async () => {
    spec = await loadSwingStructureEvaluationSpecification();
  });

  it('reproduces the pinned draw vectors', () => {
    const { random, replicates } = spec.uncertainty;
    const vectors = JSON.parse(
      JSON.stringify((spec.uncertainty.random as unknown as { testVectors: unknown }).testVectors),
    ) as Record<string, number[]>;
    expect(blockStarts(random, 'G0', 4, 1, 38)).toEqual(vectors['G0-L4-r1']);
    expect(blockStarts(random, 'G0', 4, replicates, 38)).toEqual(vectors['G0-L4-r10000']);
    expect(blockStarts(random, 'G0', 8, 1, 38)).toEqual(vectors['G0-L8-r1']);
  });

  it('concatenates whole blocks in draw order, keeps 38 positions and never wraps', () => {
    const order = replicateOrder([5, 10, 22, 20, 24, 16, 5, 21, 26, 26], 4, 38);
    expect(order).toHaveLength(38);
    expect(order.slice(0, 8)).toEqual([5, 6, 7, 8, 10, 11, 12, 13]);
    expect(order.slice(-2)).toEqual([26, 27]);
    for (const ell of [4, 8]) {
      const orders = bootstrapOrders(spec.uncertainty.random, 'G0', ell, 300, 38);
      expect(orders[0]).toEqual(
        replicateOrder(blockStarts(spec.uncertainty.random, 'G0', ell, 1, 38), ell, 38),
      );
      for (const o of orders) {
        expect(o).toHaveLength(38);
        expect(Math.max(...o)).toBeLessThanOrEqual(37);
        for (let j = 0; j < 38; j += ell) {
          const block = o.slice(j, j + ell);
          expect(block.every((k, i) => k === block[0]! + i)).toBe(true);
        }
      }
    }
  });

  it('resamples whole dates with their multiplicity and recomputes base rates', () => {
    const cell = prepareCell(FIXTURE, 20, 180);
    const order = [0, 0, 2];
    const terms = cellTerms(cell, order);
    // Each position carries every directional member of its original date, together.
    expect(terms.map((p) => p.map((t) => [t.original, FIXTURE.members[t.member]]))).toEqual([
      [
        [0, 'X'],
        [0, 'Y'],
      ],
      [
        [0, 'X'],
        [0, 'Y'],
      ],
      [[2, 'X']],
    ]);
    // X on d0: the replicate holds d0 twice and d2 once, all eligible.
    const bX0 = (0.1 + 0.1 + 0.3) / 3;
    expect(terms[0]?.[0]?.b).toBeCloseTo(bX0, 15);
    expect(terms[0]?.[0]?.baselineDates).toBe(3);
    const E0 = (0.1 - bX0 + 0) / 2;
    expect(valueOf(replicateM(cell, order))).toBeCloseTo((E0 + E0 + 0) / 3, 15);
    // The observed M differs: base rates are not carried over from the observed grid.
    expect(valueOf(replicateM(cell, [0, 1, 2]))).not.toBeCloseTo(
      valueOf(replicateM(cell, order)),
      6,
    );
  });

  it('keeps positions without a directional observation in the base rates', () => {
    const table: CellTable = {
      members: ['X'],
      dates: [0, 1, 2].map((k) => utcDay('2025-03-01') + 20 * k * DAY),
      sign: [[1, 0, 0]],
      r: [[0.1, 0.5, -0.3]],
      closeCategory: [[null, null, null]],
    };
    const cell = prepareCell(table, 20, 180);
    expect(valueOf(replicateM(cell, [1, 0, 1]))).toBeCloseTo(0.1 - (0.5 + 0.1 + 0.5) / 3, 15);
    expect(replicateM(cell, [1, 2, 1])).toEqual({
      status: 'UNAVAILABLE',
      reason: 'NO_DIRECTIONAL_DATES',
    });
  });

  it('judges eligibility by original calendar dates, not by replicate adjacency', () => {
    const r = [0.05, 0.08, 0.03, 0.04, -0.01, 0.02, 0.06, -0.03, 0.01, 0.02, 0.07, -0.02];
    const table: CellTable = {
      members: ['X'],
      dates: r.map((_, k) => utcDay('2025-01-01') + 20 * k * DAY),
      sign: [r.map((_, k) => (k === 11 ? 1 : 0))],
      r: [r],
      closeCategory: [r.map(() => null)],
    };
    const cell = prepareCell(table, 20, 180);
    const [term] = cellTerms(cell, [11, 0, 5, 1, 10, 11]).flat();
    expect(term?.b).toBeCloseTo((-0.02 + 0.05 + 0.08 + -0.02) / 4, 15);
  });

  it('centres the interval on the observed M and states every unavailable case', () => {
    const cell = prepareCell(FIXTURE, 20, 180);
    const observed = aggregateTerms(cellTerms(cell));
    const options = { blockLength: 4, z: 1.96, minimumDates: 1 };
    const Ms = [
      valueOf(replicateM(cell, [0, 0, 2])),
      valueOf(observed.M),
      valueOf(replicateM(cell, [2, 2, 1])),
    ];
    const mean = (Ms[0]! + Ms[1]! + Ms[2]!) / 3;
    const se = Math.sqrt(Ms.reduce((s, m) => s + (m - mean) ** 2, 0) / 2);
    const interval = bootstrapInterval(
      cell,
      observed,
      [
        [0, 0, 2],
        [0, 1, 2],
        [2, 2, 1],
      ],
      options,
    );
    expect(interval).toMatchObject({ status: 'AVAILABLE', definedReplicates: 3 });
    if (interval.status !== 'AVAILABLE') throw new Error('expected an interval');
    expect(interval.se).toBeCloseTo(se, 15);
    expect(interval.replicateMean).toBeCloseTo(mean, 15);
    expect(interval.lower).toBeCloseTo(valueOf(observed.M) - 1.96 * se, 15);
    expect(interval.upper).toBeCloseTo(valueOf(observed.M) + 1.96 * se, 15);

    const identity = Array.from({ length: 5 }, () => [0, 1, 2]);
    expect(bootstrapInterval(cell, observed, identity, options)).toMatchObject({
      status: 'UNAVAILABLE',
      reason: 'ZERO_VARIANCE',
      definedReplicates: 5,
    });
    expect(bootstrapInterval(cell, observed, [[0, 1, 2]], options)).toMatchObject({
      reason: 'ZERO_VARIANCE',
      definedReplicates: 1,
    });
    expect(bootstrapInterval(cell, observed, identity, { ...options, minimumDates: 4 })).toEqual({
      blockLength: 4,
      status: 'UNAVAILABLE',
      reason: 'TOO_FEW_DATES',
      definedReplicates: null,
      replicateMean: null,
    });
    const none = { M: { status: 'UNAVAILABLE', reason: 'NO_DIRECTIONAL_DATES' } as Stat, dates: 0 };
    expect(bootstrapInterval(cell, none, identity, options)).toMatchObject({
      reason: 'NO_DIRECTIONAL_DATES',
      definedReplicates: null,
    });

    // More than 100 replicates without M* (no directional date drawn): no interval.
    const empty = {
      ...FIXTURE,
      sign: [
        [1, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ] as CellTable['sign'],
    };
    const emptyCell = prepareCell(empty, 20, 180);
    const emptyObserved = aggregateTerms(cellTerms(emptyCell));
    const varied = [
      [0, 1, 2],
      [0, 0, 2],
      [0, 2, 2],
      [0, 1, 1],
    ];
    const undefinedOrders = (count: number) => Array.from({ length: count }, () => [1, 2, 2]);
    expect(
      bootstrapInterval(emptyCell, emptyObserved, [...varied, ...undefinedOrders(101)], options),
    ).toMatchObject({ reason: 'TOO_MANY_UNDEFINED_REPLICATES', definedReplicates: 4 });
    expect(
      bootstrapInterval(emptyCell, emptyObserved, [...varied, ...undefinedOrders(100)], options),
    ).toMatchObject({ status: 'AVAILABLE', definedReplicates: 4 });
  });
});

describe('6. frozen reference, breach timing and incomplete follow-up', () => {
  it('classifies breaches before and after establishment, separately for close and extreme', () => {
    // L1R1: Up on lows 9 (day 2) and 10 (day 4); the high 14 on day 7 confirms on day 8.
    const bars: Bar[] = [
      [10, 8, 9],
      [12, 10, 11],
      [11, 9, 10],
      [11.5, 10.5, 11],
      [11, 10, 10.5],
      [11, 10.2, 10.6],
      [11, 9.8, 10.5], // trades below 10 before the state is knowable
      [14, 9.7, 13],
      [13, 9.6, 10.1], // establishedAt is this bar's close
      [12, 9.5, 9.55], // first close below 10, after establishment
    ];
    const candles = series(bars);
    const atEstablishment = observe(candles, 'X', open(8), L1R1, 9);
    expect(atEstablishment).toMatchObject({
      state: 'Up',
      establishedAt: close(8),
      reference: { kind: 'low', price: 10, candleOpenTime: open(4), availableAt: close(5) },
      preObservation: { close: 'NONE', extreme: 'BEFORE_ESTABLISHMENT' },
    });
    const later = observe(candles, 'X', open(9), L1R1, 10);
    expect(later).toMatchObject({
      state: 'Up',
      establishedAt: close(8),
      preObservation: { close: 'AFTER_ESTABLISHMENT', extreme: 'BEFORE_ESTABLISHMENT' },
    });
    // At exactly establishedAt, a breach counts as before establishment.
    const breach = { field: 'close' as const, price: 1, candleOpenTime: open(8) };
    expect(preObservationCategory({ ...breach, knowableAt: close(8) }, close(8))).toBe(
      'BEFORE_ESTABLISHMENT',
    );
    expect(preObservationCategory({ ...breach, knowableAt: close(8) + 1 }, close(8))).toBe(
      'AFTER_ESTABLISHMENT',
    );
    expect(preObservationCategory(null, close(8))).toBe('NONE');
  });

  it('measures forward breaches against the frozen price, close apart from extreme', () => {
    const candles = series(WALKTHROUGH);
    const observation = observe(candles, 'X', open(6), L1R1, 7);
    expect(observation).toMatchObject({
      state: 'Up',
      preObservation: { close: 'NONE', extreme: 'NONE' },
    });
    const scan = forwardScan(indexBars(candles), open(6), observation.reference!, 3, close(9));
    expect(scan).toEqual({
      status: 'COMPLETE',
      extreme: { breached: true, days: 1 },
      close: { breached: true, days: 2 },
    });
  });

  it('keeps the reference fixed at the observation despite later pivots', () => {
    const bars: Bar[] = [
      [10, 8, 9],
      [12, 10, 11],
      [11, 9, 10],
      [14, 11, 12.5],
      [13, 10, 11.5],
      [15, 12, 13.5], // D: Up on the higher low 10 (day 4)
      [16, 13, 15],
      [15, 12.5, 13], // a new higher low, 12.5
      [17, 13, 16],
      [16, 11, 11.5], // below 12.5, above 10
      [13, 10, 12], // touches 10 exactly: equal is not beyond
    ];
    const candles = series(bars);
    const atD = observe(candles, 'X', open(5), L1R1, 6);
    expect(atD.reference).toMatchObject({ price: 10, candleOpenTime: open(4) });
    // A later observation has its own reference.
    const afterward = observe(candles, 'X', open(9), L1R1, 10);
    expect(afterward).toMatchObject({
      state: 'Up',
      reference: { price: 12.5, candleOpenTime: open(7) },
    });
    const index = indexBars(candles);
    expect(forwardScan(index, open(5), atD.reference!, 5, close(10))).toEqual({
      status: 'COMPLETE',
      close: { breached: false, days: null },
      extreme: { breached: false, days: null },
    });
    // The later reference would have read a breach on day 9 (4 days after D).
    expect(forwardScan(index, open(5), afterward.reference!, 5, close(10))).toMatchObject({
      extreme: { breached: true, days: 4 },
    });
  });

  it('reports a horizon with a missing or duplicated bar as INCOMPLETE, never as no breach', () => {
    const candles = series(WALKTHROUGH);
    const reference = observe(candles, 'X', open(6), L1R1, 7).reference!;
    const missing = candles.filter((c) => c.timestamp !== open(9));
    expect(forwardScan(indexBars(missing), open(6), reference, 3, close(9))).toEqual({
      status: 'INCOMPLETE',
      bars: [{ date: '2025-01-10', status: 'MISSING' }],
    });
    expect(
      forwardScan(indexBars([...candles, candles[8]!]), open(6), reference, 3, close(9)),
    ).toEqual({
      status: 'INCOMPLETE',
      bars: [{ date: '2025-01-09', status: 'INVALID' }],
    });
    // A shorter horizon that ends before the gap is complete.
    expect(forwardScan(indexBars(missing), open(6), reference, 2, close(9)).status).toBe(
      'COMPLETE',
    );
  });
});

describe('7. classifications, unavailable states and strict zero', () => {
  const members = ['A', 'B', 'C', 'D', 'E'];
  const interval = (lower: number, upper: number, blockLength = 4): Interval => ({
    blockLength,
    status: 'AVAILABLE',
    lower,
    upper,
    se: (upper - lower) / 3.92,
    definedReplicates: 10000,
    replicateMean: (lower + upper) / 2,
  });
  const missing = (blockLength: number, reason: 'TOO_FEW_DATES' | 'ZERO_VARIANCE'): Interval => ({
    blockLength,
    status: 'UNAVAILABLE',
    reason,
    definedReplicates: null,
    replicateMean: null,
  });
  const each = (value: number) => Object.fromEntries(members.map((m) => [m, value]));
  let thresholds: SwingStructureEvaluationSpecification['interpretability'];
  beforeAll(async () => {
    thresholds = (await loadSwingStructureEvaluationSpecification()).interpretability;
  });
  const base = (): PrimaryClassificationInput => ({
    // Every interpretability condition exactly at its boundary.
    aggregate: {
      dates: 25,
      upObservations: 30,
      upDates: 10,
      downObservations: 30,
      downDates: 10,
      U: ok(0.01),
      Dn: ok(0.01),
      hitExcess: ok(0.01),
    },
    intervals: { primary: interval(0.001, 0.02), longer: interval(0.001, 0.02, 8) },
    leaveOneMemberOut: Object.fromEntries(members.map((m) => [m, ok(0.01)])),
    phaseMedian: ok(0.01),
    invalidOrIncompleteByMember: each(3),
    unavailableOutcomesByMember: each(3),
    thresholds,
  });
  const classify = (change: (input: PrimaryClassificationInput) => void) => {
    const input = base();
    change(input);
    return classifyPrimaryCell(input);
  };

  it('is INFORMATIVE only when interpretable and all seven gates are TRUE', () => {
    const result = classify(() => {});
    expect(result.classification).toBe('INFORMATIVE');
    expect(result.gates.map((g) => g.value)).toEqual(Array(7).fill('TRUE'));
    expect(result.interpretability.every((c) => c.satisfied)).toBe(true);
  });

  const zeroed: [number, (input: PrimaryClassificationInput) => void][] = [
    [1, (i) => (i.intervals.primary = interval(0, 0.02))],
    [2, (i) => (i.intervals.longer = interval(0, 0.02, 8))],
    [3, (i) => (i.aggregate.U = ok(0))],
    [4, (i) => (i.aggregate.Dn = ok(0))],
    [5, (i) => (i.leaveOneMemberOut['C'] = ok(0))],
    [6, (i) => (i.aggregate.hitExcess = ok(0))],
    [7, (i) => (i.phaseMedian = medianOfPhases([-2, -1, 1, 2].map(ok)))],
  ];
  it.each(zeroed)(
    'reads exactly zero as FALSE for gate %i, which makes it INCONCLUSIVE',
    (gate, change) => {
      const result = classify(change);
      expect(result.classification).toBe('INCONCLUSIVE');
      expect(result.reasons).toEqual([`gate ${gate} FALSE`]);
    },
  );

  const unavailableGates: [number, string, (input: PrimaryClassificationInput) => void][] = [
    [2, 'ZERO_VARIANCE', (i) => (i.intervals.longer = missing(8, 'ZERO_VARIANCE'))],
    [3, 'NO_UP', (i) => (i.aggregate.U = { status: 'UNAVAILABLE', reason: 'NO_UP' })],
    [4, 'NO_DOWN', (i) => (i.aggregate.Dn = { status: 'UNAVAILABLE', reason: 'NO_DOWN' })],
    [
      5,
      'NO_DATES_WITHOUT_MEMBER',
      (i) =>
        (i.leaveOneMemberOut['E'] = { status: 'UNAVAILABLE', reason: 'NO_DATES_WITHOUT_MEMBER' }),
    ],
    [
      6,
      'NO_DIRECTIONAL_DATES',
      (i) => (i.aggregate.hitExcess = { status: 'UNAVAILABLE', reason: 'NO_DIRECTIONAL_DATES' }),
    ],
    [
      7,
      'PHASE_UNAVAILABLE',
      (i) =>
        (i.phaseMedian = medianOfPhases([
          ok(1),
          { status: 'UNAVAILABLE', reason: 'NO_DIRECTIONAL_DATES' },
        ])),
    ],
  ];
  it.each(unavailableGates)(
    'never passes gate %i when it is UNAVAILABLE (%s)',
    (gate, reason, change) => {
      const result = classify(change);
      expect(result.classification).toBe('INCONCLUSIVE');
      expect(result.gates[gate - 1]).toMatchObject({ value: 'UNAVAILABLE', reason });
      expect(result.reasons).toEqual([`gate ${gate} UNAVAILABLE`]);
    },
  );

  it('is ADVERSE only when both upper bounds are strictly below zero', () => {
    const adverse = (primaryUpper: number, longer: Interval) =>
      classify((i) => {
        i.intervals = { primary: interval(-0.03, primaryUpper), longer };
      }).classification;
    expect(adverse(-0.001, interval(-0.03, -0.001, 8))).toBe('ADVERSE');
    expect(adverse(0, interval(-0.03, -0.001, 8))).toBe('INCONCLUSIVE');
    expect(adverse(-0.001, interval(-0.03, 0, 8))).toBe('INCONCLUSIVE');
    expect(adverse(-0.001, missing(8, 'ZERO_VARIANCE'))).toBe('INCONCLUSIVE');
  });

  const conditions: [string, (input: PrimaryClassificationInput) => void][] = [
    ['minimumDates', (i) => (i.aggregate.dates = 24)],
    ['minimumUpObservations', (i) => (i.aggregate.upObservations = 29)],
    ['minimumUpDates', (i) => (i.aggregate.upDates = 9)],
    ['minimumDownObservations', (i) => (i.aggregate.downObservations = 29)],
    ['minimumDownDates', (i) => (i.aggregate.downDates = 9)],
    [
      'maximumInvalidOrIncompleteObservationsPerMember',
      (i) => (i.invalidOrIncompleteByMember['B'] = 4),
    ],
    ['maximumUnavailableOutcomesPerMember', (i) => (i.unavailableOutcomesByMember['D'] = 4)],
    ['primaryIntervalAvailable', (i) => (i.intervals.primary = missing(4, 'TOO_FEW_DATES'))],
  ];
  it.each(conditions)('is NOT_INTERPRETABLE when %s fails, whatever the gates', (id, change) => {
    for (const intervals of [
      { primary: interval(0.001, 0.02), longer: interval(0.001, 0.02, 8) },
      { primary: interval(-0.02, -0.001), longer: interval(-0.02, -0.001, 8) },
    ]) {
      const result = classify((i) => {
        i.intervals = intervals;
        change(i);
      });
      expect(result.classification).toBe('NOT_INTERPRETABLE');
      expect(result.reasons).toEqual([id]);
    }
  });

  it('states NO_DIRECTIONAL_DATES, NO_UP, NO_DOWN and NO_DATES_WITHOUT_MEMBER from the data', () => {
    const none = aggregateTerms(
      cellTerms(
        prepareCell(
          { ...FIXTURE, sign: FIXTURE.sign.map((row) => row.map(() => 0 as const)) },
          20,
          180,
        ),
      ),
    );
    expect(none).toMatchObject({
      dates: 0,
      M: { status: 'UNAVAILABLE', reason: 'NO_DIRECTIONAL_DATES' },
      hitExcess: { status: 'UNAVAILABLE', reason: 'NO_DIRECTIONAL_DATES' },
      U: { status: 'UNAVAILABLE', reason: 'NO_UP' },
      Dn: { status: 'UNAVAILABLE', reason: 'NO_DOWN' },
    });
    const downOnly = aggregateTerms(
      cellTerms(
        prepareCell(
          {
            ...FIXTURE,
            sign: [
              [-1, 0, -1],
              [-1, 0, 0],
              [0, -1, 0],
            ],
          },
          20,
          180,
        ),
      ),
    );
    expect(downOnly.U).toEqual({ status: 'UNAVAILABLE', reason: 'NO_UP' });
    expect(downOnly.Dn.status).toBe('AVAILABLE');
    const upOnly = aggregateTerms(
      cellTerms(
        prepareCell(
          {
            ...FIXTURE,
            sign: [
              [1, 0, 1],
              [0, 0, 0],
              [0, 0, 0],
            ],
          },
          20,
          180,
        ),
      ),
    );
    expect(upOnly.Dn).toEqual({ status: 'UNAVAILABLE', reason: 'NO_DOWN' });
    const onlyX = cellTerms(
      prepareCell(
        {
          ...FIXTURE,
          sign: [
            [1, 0, -1],
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
        20,
        180,
      ),
    );
    expect(leaveOneMemberOut(FIXTURE.members, onlyX)['X']).toEqual({
      M: { status: 'UNAVAILABLE', reason: 'NO_DATES_WITHOUT_MEMBER' },
      dates: 0,
      observations: 0,
    });
  });

  it('takes the phase median only when all phases are available', () => {
    const twenty = Array.from({ length: 20 }, (_, p) => ok(p + 1));
    expect(medianOfPhases(twenty)).toEqual(ok(10.5));
    expect(
      medianOfPhases([
        ...twenty.slice(1),
        { status: 'UNAVAILABLE', reason: 'NO_DIRECTIONAL_DATES' },
      ]),
    ).toEqual({
      status: 'UNAVAILABLE',
      reason: 'PHASE_UNAVAILABLE',
    });
    expect(medianOfPhases([])).toEqual({ status: 'UNAVAILABLE', reason: 'PHASE_UNAVAILABLE' });
  });
});

describe('8-9. synthetic integration with the candidate and the frozen schedule', () => {
  let spec: SwingStructureEvaluationSpecification;
  let members: Record<string, MappedCandle[]>;
  let results: SwingStructureEvaluationResults;
  let text: string;
  type Row = SwingStructureEvaluationResults['observations'][number];
  const BTC_MISSING = '2024-02-20';
  const ETH_DUPLICATE = '2026-10-01';

  beforeAll(async () => {
    spec = await loadSwingStructureEvaluationSpecification();
    const first = utcDay(spec.data.bars.firstBar);
    // 1000 synthetic bars per member, 2024-02-16 through the forming bar of 2026-11-11.
    members = Object.fromEntries(
      Object.keys(spec.universe.members).map((ticker) => [
        ticker,
        walk(`synthetic|${ticker}`, first, 1000),
      ]),
    );
    members['BTC-USDT'] = members['BTC-USDT']!.filter((c) => c.timestamp !== utcDay(BTC_MISSING));
    const eth = members['ETH-USDT']!;
    const duplicated = eth.find((c) => c.timestamp === utcDay(ETH_DUPLICATE))!;
    members['ETH-USDT'] = [...eth, { ...duplicated }];
    results = evaluateSwingStructureStudy(spec, members);
    text = serializeSwingStructureResults(results);
  }, 300_000);

  it('follows the frozen schedule, members and configurations', () => {
    expect(results.specificationId).toBe(SWING_STRUCTURE_EVALUATION_SPECIFICATION_ID);
    expect(results.schedule).toEqual({
      daily: { first: '2024-08-13', last: '2026-09-10', count: 759 },
      primaryGrid: spec.observations.primaryGrid.dates,
      phaseGridSizes: [...Array(19).fill(38), 37],
    });
    expect(Object.keys(results.members)).toEqual([
      'BNB-USDT',
      'BTC-USDT',
      'ETH-USDT',
      'SOL-USDT',
      'XRP-USDT',
    ]);
    expect(results.observations).toHaveLength(759 * 5 * 4);
    expect(results.A.map((a) => a.configuration)).toEqual(['L5R5', 'L3R3', 'L10R10', 'L5R2']);
  });

  it('attributes every row and records the candidate output it was given', () => {
    const row = results.observations.find(
      (r) => r.configuration === 'L10R10' && r.date === '2025-06-09' && r.member === 'SOL-USDT',
    )!;
    expect(row).toMatchObject({
      studyId: spec.studyId,
      specificationId: spec.specificationId,
      candidateId: 'swing-structure-direction',
      candidateVersion: '0.1.0',
      leftBars: 10,
      rightBars: 10,
      timeframe: '1D',
      symbol: 'BINANCE:SOLUSDT',
      tau: utcDay('2025-06-09') + DAY - 1,
      primaryGrid: true,
      phase: 0,
    });
    const D = utcDay(row.date);
    const window = members['SOL-USDT']!.filter(
      (c) => c.timestamp >= D - 179 * DAY && c.timestamp <= D,
    );
    expect(row.candidate).toEqual(
      evaluateSwingStructure({
        candles: window,
        timeframe: { label: '1D', intervalMs: DAY },
        config: { leftBars: 10, rightBars: 10 },
        cutoff: row.tau,
      }),
    );
    for (const r of results.observations) {
      if (r.candidate.status === 'INVALID_INPUT') continue;
      expect(r.candidate.cutoff).toBe(r.tau);
      expect(r.candidate.latestCloseTime ?? 0).toBeLessThanOrEqual(r.tau);
    }
  });

  it('lists every defect and keeps it out of K_D, without stopping the study', () => {
    const invalid = results.exclusions.observations.filter((e) => e.member === 'BTC-USDT');
    expect(invalid).toHaveLength(5 * 4);
    expect(invalid.filter((e) => e.state === 'WINDOW_INCOMPLETE').map((e) => e.date)).toEqual(
      Array(4).fill('2024-08-17'),
    );
    expect(
      invalid
        .filter((e) => e.state === 'INVALID_INPUT')
        .every((e) => e.issues.includes('MISSING_INTERVAL')),
    ).toBe(true);
    expect(results.exclusions.observations.every((e) => e.member === 'BTC-USDT')).toBe(true);
    expect(results.exclusions.outcomes).toEqual([
      expect.objectContaining({
        member: 'ETH-USDT',
        horizon: 20,
        date: '2026-09-10',
        status: 'INVALID',
      }),
      expect.objectContaining({
        member: 'ETH-USDT',
        horizon: 60,
        date: '2026-08-01',
        status: 'INVALID',
      }),
    ]);
    expect(results.completeness['BTC-USDT']).toMatchObject({
      required: 999,
      found: 998,
      missing: [BTC_MISSING],
    });
    expect(results.completeness['ETH-USDT']).toMatchObject({
      found: 998,
      duplicate: [ETH_DUPLICATE],
      invalid: [{ date: ETH_DUPLICATE, issues: ['DUPLICATE_TIMESTAMP'] }],
    });
    expect(results.completeness['BNB-USDT']).toMatchObject({
      found: 999,
      missing: [],
      notOnRequiredDays: [],
    });
    // The forming bar of 2026-11-11 closes after the cutoff and is never used.
    expect(text).not.toContain('2026-11-11');
    const btcFirst = results.observations.find(
      (r) => r.member === 'BTC-USDT' && r.date === '2024-08-13' && r.configuration === 'L5R5',
    )!;
    expect(btcFirst.state).toBe('INVALID_INPUT');
    const primaryTerms = results.B.cells.find((c) => c.role === 'primary')!.terms;
    expect(primaryTerms.some((t) => t.member === 'BTC-USDT' && t.date === '2024-08-13')).toBe(
      false,
    );
  });

  it('reproduces the primary M from the rows by an independent calculation', () => {
    const rows = results.observations.filter((r) => r.configuration === 'L5R5' && r.primaryGrid);
    const at = new Map(rows.map((r) => [`${r.member}|${r.date}`, r]));
    const tickers = Object.keys(results.members);
    const dates = spec.observations.primaryGrid.dates;
    const r = (ticker: string, date: string) => {
      const outcome = at.get(`${ticker}|${date}`)!.outcomes['20']!;
      return outcome.status === 'AVAILABLE' ? outcome.r : null;
    };
    const E: number[] = [];
    for (const date of dates) {
      const e: number[] = [];
      for (const ticker of tickers) {
        const row = at.get(`${ticker}|${date}`)!;
        const s = row.state === 'Up' ? 1 : row.state === 'Down' ? -1 : 0;
        const own = r(ticker, date);
        if (s === 0 || own === null) continue;
        const D = utcDay(date);
        const base = dates
          .filter((d) => utcDay(d) >= D || utcDay(d) <= D - 200 * DAY)
          .flatMap((d) => (r(ticker, d) === null ? [] : [r(ticker, d)!]));
        e.push(s * (own - base.reduce((a, b) => a + b, 0) / base.length));
      }
      if (e.length > 0) E.push(e.reduce((a, b) => a + b, 0) / e.length);
    }
    const primary = results.B.cells.find((c) => c.role === 'primary')!;
    expect(primary).toMatchObject({ configuration: 'L5R5', horizon: 20, dates: E.length });
    expect(valueOf(primary.M)).toBeCloseTo(E.reduce((a, b) => a + b, 0) / E.length, 12);
  });

  it('gives intervals only on 5- and 20-day cells and classifies only the primary cell', () => {
    expect(results.B.cells).toHaveLength(12);
    for (const cell of results.B.cells) {
      if (cell.horizon === 60) {
        expect(cell).not.toHaveProperty('intervals');
        expect(cell).toHaveProperty('quartilesOfE');
      } else {
        expect(cell).not.toHaveProperty('quartilesOfE');
        expect(
          'intervals' in cell && [
            cell.intervals.primary.blockLength,
            cell.intervals.longer.blockLength,
          ],
        ).toEqual([4, 8]);
      }
    }
    expect(results.B.cells.filter((c) => c.role === 'primary')).toHaveLength(1);
    const { primary } = results.B;
    expect(primary).toMatchObject({ configuration: 'L5R5', horizon: 20, grid: 'G0' });
    expect(['INFORMATIVE', 'INCONCLUSIVE', 'ADVERSE', 'NOT_INTERPRETABLE']).toContain(
      primary.classification,
    );
    expect(primary.phases.map((p) => p.gridDates)).toEqual(results.schedule.phaseGridSizes);
    expect(Object.keys(primary.leaveOneMemberOut)).toEqual(Object.keys(results.members));
    expect(primary.gates.map((g) => g.gate)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // One BTC grid date is INVALID_INPUT: within the maximum of 3.
    expect(
      primary.interpretability.find(
        (c) => c.id === 'maximumInvalidOrIncompleteObservationsPerMember',
      ),
    ).toMatchObject({
      byMember: { 'BNB-USDT': 0, 'BTC-USDT': 1, 'ETH-USDT': 0, 'SOL-USDT': 0, 'XRP-USDT': 0 },
      satisfied: true,
    });
    const interval = results.B.cells.find((c) => c.role === 'primary')!;
    expect('intervals' in interval && interval.intervals.primary.status).toBe('AVAILABLE');
  });

  it('measures every forward breach against the reference frozen at the observation', () => {
    let checked = 0;
    for (const row of results.observations) {
      if (!row.primaryGrid || (row.state !== 'Up' && row.state !== 'Down')) continue;
      if (row.candidate.status !== 'EVALUATED' || !row.candidate.reference || !('forward' in row)) {
        throw new Error('a directional grid row must carry its reference and forward scan');
      }
      const reference = row.candidate.reference;
      const D = utcDay(row.date);
      const candles = members[row.member]!;
      for (const h of [5, 20, 60]) {
        const days = Array.from({ length: h }, (_, i) =>
          candles.filter((c) => c.timestamp === D + (i + 1) * DAY),
        );
        const expected = days.some((list) => list.length !== 1)
          ? 'INCOMPLETE'
          : (['close', 'extreme'] as const).map((kind) => {
              const at = days.findIndex(([c]) => {
                const price = kind === 'close' ? c!.close : c![reference.kind];
                return reference.kind === 'low' ? price < reference.price : price > reference.price;
              });
              return at < 0 ? null : at + 1;
            });
        const scan = row.forward[h]!;
        expect(
          scan.status === 'INCOMPLETE' ? 'INCOMPLETE' : [scan.close.days, scan.extreme.days],
        ).toEqual(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(
      results.exclusions.forward.every((f) => f.member === 'ETH-USDT' && f.horizon === 60),
    ).toBe(true);
  });

  it('serializes deterministically, whatever the order members are supplied in', () => {
    const reversed = Object.fromEntries(Object.entries(members).reverse());
    expect(serializeSwingStructureResults(evaluateSwingStructureStudy(spec, reversed))).toBe(text);
    expect(JSON.stringify(JSON.parse(text))).toBe(text.trimEnd());
    expect(Object.keys(results)).toEqual([
      'studyId',
      'specificationId',
      'candidate',
      'members',
      'timeframe',
      'exportCutoff',
      'quantileMethod',
      'schedule',
      'completeness',
      'A',
      'B',
      'C',
      'exclusions',
      'observations',
    ]);
  }, 300_000);

  it('refuses rather than shrinking the universe or reading malformed bars', () => {
    const { ['XRP-USDT']: _xrp, ...four } = members;
    expect(refusal(() => evaluateSwingStructureStudy(spec, four))).toBe('DATA_UNAVAILABLE');
    expect(refusal(() => evaluateSwingStructureStudy(spec, { ...members, 'TRX-USDT': [] }))).toBe(
      'DATA_UNAVAILABLE',
    );
    const nonNumeric = {
      ...members,
      'SOL-USDT': members['SOL-USDT']!.map((c, i) => (i === 3 ? { ...c, close: Number.NaN } : c)),
    };
    expect(refusal(() => evaluateSwingStructureStudy(spec, nonNumeric))).toBe('DATA_UNAVAILABLE');
    expect(
      refusal(() =>
        evaluateSwingStructureStudy({ ...spec, specificationId: '0'.repeat(64) }, members),
      ),
    ).toBe('SPECIFICATION');
  });
});
