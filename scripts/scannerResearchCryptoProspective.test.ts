import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evaluateScan, scanInstrument, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import {
  CRYPTO_RESEARCH_SPECIFICATION,
  CRYPTO_RESEARCH_SPECIFICATION_ID,
} from './scannerResearchCrypto';
import {
  classifyRecordedScan,
  CRYPTO_PROSPECTIVE_SPECIFICATION,
  CRYPTO_PROSPECTIVE_SPECIFICATION_ID,
  PHASE_SERIES,
  phaseSeries,
  prospectiveTiming,
} from './scannerResearchCryptoProspective';
import { CRYPTO_UNIVERSE, universeTickers } from './tradingViewImport';

const SPEC = CRYPTO_PROSPECTIVE_SPECIFICATION;
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);
const utc = (time: number) => new Date(time).toISOString();

describe('prospective crypto specification', () => {
  it('keeps the frozen machine-readable specification aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/scanner-research-crypto-prospective.v1.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(SPEC));
    // Any change to the model, scanner, policy, thresholds or universe constants moves this ID.
    expect(CRYPTO_PROSPECTIVE_SPECIFICATION_ID).toBe(
      '45a43d5c6390f4ce6437c24cdfdc3adc817617e3634f1c24b3e8454951a268fa',
    );
  });

  it('rests on the retrospective study and leaves its model, policy and universe unchanged', () => {
    expect(SPEC.basedOn.specificationId).toBe(CRYPTO_RESEARCH_SPECIFICATION_ID);
    expect(SPEC.unchanged.universe.members).toEqual(CRYPTO_RESEARCH_SPECIFICATION.universe.members);
    const retrospective = CRYPTO_RESEARCH_SPECIFICATION.scanner;
    expect(SPEC.unchanged).toMatchObject({
      scannerVersion: retrospective.scannerVersion,
      modelVersion: retrospective.modelVersion,
      candlePolicyVersion: retrospective.candlePolicyVersion,
      provider: retrospective.provider,
      historyWindowCandles: retrospective.historyWindowCandles,
      longSetupMinScore: 78,
      riskSetupMaxScore: 28,
    });
    expect(SPEC.hypothesisOrigin).toMatch(/^Selected after seeing the retrospective results/);
    expect(SPEC.primaryComparison.horizonUtcDays).toBe(20);
  });

  it('starts after every inspected outcome and after the freeze, and states its maturity', () => {
    const { period } = SPEC;
    const first = at(`${period.firstScoredDay}T00:00:00.000Z`);
    const last = at(`${period.lastScoredDay}T00:00:00.000Z`);
    expect(period.firstScoredDay > CRYPTO_RESEARCH_SPECIFICATION.evaluationDates.last).toBe(true);
    // The export the retrospective study read held the forming 2026-11-11 bar.
    expect(period.firstScoredDay > '2026-11-11').toBe(true);
    // The first scored day had not begun when the specification was frozen.
    expect(first).toBeGreaterThan(at(SPEC.frozenAt));
    expect((last - first) / DAY + 1).toBe(period.scoredDays);
    const lastTiming = prospectiveTiming(last + DAY + 12 * 3_600_000);
    expect(utc(lastTiming.endpointOpen).slice(0, 10)).toBe(period.lastEndpointBar);
    expect(at(period.analysisNotBefore)).toBe(lastTiming.endpointOpen + DAY);
  });
});

describe('prospective timing, in UTC', () => {
  it('scores the day before the retrieval and references the first bar opening after it', () => {
    for (const start of [
      '2026-11-13T00:00:00.000Z',
      '2026-11-13T18:40:00.000Z',
      '2026-11-13T23:59:59.999Z',
    ]) {
      const timing = prospectiveTiming(at(start));
      expect(timing.scoredDay).toBe('2026-11-12');
      expect(utc(timing.referenceOpen)).toBe('2026-11-14T00:00:00.000Z');
      expect(utc(timing.endpointOpen)).toBe('2026-12-04T00:00:00.000Z');
      expect(timing.referenceOpen).toBeGreaterThan(at(start));
      // The scored day closed at or before the cutoff.
      expect(at('2026-11-12T23:59:59.999Z')).toBeLessThanOrEqual(at(start));
    }
  });

  it('never shares a bar between windows of one phase series', () => {
    expect(PHASE_SERIES).toBe(21);
    expect(phaseSeries(SPEC.period.firstScoredDay)).toBe(0);
    expect(phaseSeries('2026-12-02')).toBe(20);
    expect(phaseSeries('2026-12-03')).toBe(0);
    const window = (scoredDay: string) =>
      prospectiveTiming(at(`${scoredDay}T00:00:00.000Z`) + DAY + 3_600_000);
    expect(window('2026-11-12').endpointOpen).toBeLessThan(window('2026-12-03').referenceOpen);
    expect(window('2026-11-12').endpointOpen).toBe(window('2026-12-02').referenceOpen);
  });
});

describe('prospective versus not prospective', () => {
  /** A real scanner output, every pair failed: only the scan's identity fields matter here. */
  function snapshot(start: string, completed: string, members = universeTickers(CRYPTO_UNIVERSE)) {
    const inputs: ScanInput[] = members.map((ticker) => ({
      ticker,
      instrument: scanInstrument(ticker),
      error: { code: 'FETCH_FAILED', detail: 'labeled fixture' },
    }));
    const scan = evaluateScan(inputs, {
      evaluationTime: at(start),
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: null,
      cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    });
    return { startedAt: start, completedAt: completed, scan };
  }

  it('counts a scan saved before its reference bar opened, and only then', () => {
    const start = '2026-11-13T18:40:00.000Z';
    expect(classifyRecordedScan(snapshot(start, '2026-11-13T18:42:00.000Z'), true)).toEqual({
      category: 'PROSPECTIVE',
      scoredDay: '2026-11-12',
      reasons: [],
    });
    expect(classifyRecordedScan(snapshot(start, '2026-11-13T23:59:59.999Z'), true).category).toBe(
      'PROSPECTIVE',
    );
    // Saved at midnight or later, or rebuilt afterwards: never PROSPECTIVE.
    for (const late of ['2026-11-14T00:00:00.000Z', '2027-12-05T09:00:00.000Z'])
      expect(classifyRecordedScan(snapshot(start, late), true)).toMatchObject({
        category: 'NOT_PROSPECTIVE',
        reasons: ['saved at or after its reference bar opened'],
      });
  });

  it('keeps every day before the period, including the first live scan, out', () => {
    // The first live scan (2026-11-11 18:38Z) scored 2026-11-10.
    expect(
      classifyRecordedScan(snapshot('2026-11-11T18:38:25.830Z', '2026-11-11T18:40:23.390Z'), true),
    ).toMatchObject({ category: 'OUTSIDE_PERIOD', scoredDay: '2026-11-10' });
    expect(
      classifyRecordedScan(snapshot('2026-11-12T18:00:00.000Z', '2026-11-12T18:05:00.000Z'), true)
        .category,
    ).toBe('OUTSIDE_PERIOD');
    expect(
      classifyRecordedScan(snapshot('2027-11-13T18:00:00.000Z', '2027-11-13T18:05:00.000Z'), true)
        .category,
    ).toBe('OUTSIDE_PERIOD');
    expect(
      classifyRecordedScan(snapshot('2027-11-12T18:00:00.000Z', '2027-11-12T18:05:00.000Z'), true)
        .scoredDay,
    ).toBe(SPEC.period.lastScoredDay);
  });

  it('refuses another model, membership, provider or a scan that does not reproduce', () => {
    const start = '2026-11-20T08:00:00.000Z';
    const done = '2026-11-20T08:03:00.000Z';
    const base = snapshot(start, done);
    const reasons = (value: ReturnType<typeof snapshot>, reproduces = true) =>
      classifyRecordedScan(value, reproduces).reasons;
    expect(
      reasons({
        ...base,
        scan: { ...base.scan, modelVersion: '1.0.1' as typeof base.scan.modelVersion },
      }),
    ).toEqual(['another model version']);
    expect(reasons(snapshot(start, done, universeTickers(CRYPTO_UNIVERSE).slice(1)))).toEqual([
      'another membership',
    ]);
    const equity = evaluateScan([], {
      evaluationTime: at(start),
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    });
    expect(reasons({ ...base, scan: { ...base.scan, cohorts: equity.cohorts } })).toEqual([
      'another asset class, provider or candle policy',
    ]);
    expect(reasons({ ...base, scan: { ...base.scan, evaluationTime: at(start) - 1 } })).toEqual([
      'evaluation time is not the retrieval start',
    ]);
    expect(reasons(base, false)).toEqual(['does not reproduce offline']);
  });
});
