import { readFile } from 'node:fs/promises';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_MODEL_VERSION,
  modelSetups,
  scoreFactors,
  type CanonicalScore,
  type FactorInputs,
} from '@/lib/canonicalModel';
import { atr, macd } from '@/lib/indicators';
import { evaluateScan, type ScanAssetResult } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import {
  cells,
  diagnosticRow,
  diagnosticSummary,
  histogramAtrBound,
  loadStudyFacts,
  LONG_SHORTFALL_BUDGET,
  MODEL_DIAGNOSTIC_DEFINITION,
  MODEL_DIAGNOSTIC_ID,
  modelDiagnostic,
  quantiles,
  riskClauses,
  runModelDiagnosticCrypto,
} from './modelDiagnostic';
import { RECORDED_SCAN, runCryptoStudy } from './scannerResearchCrypto';
import {
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  importInputs,
  universeTickers,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

const STUDY_TIMEOUT = 60_000;

/** A scanner result around hand-chosen readings, as evaluateScan would record it. */
function resultOf(inputs: FactorInputs, overrides: Partial<CanonicalScore> = {}): ScanAssetResult {
  const model: CanonicalScore = {
    status: 'OK',
    version: CANONICAL_MODEL_VERSION,
    close: 100,
    atr: inputs.volatilityPercent * 100,
    inputs,
    ...scoreFactors(inputs),
    ...overrides,
  };
  return {
    ticker: 'SYNTH-USDT',
    assetClass: 'crypto',
    instrument: null,
    status: 'EVALUATED',
    detail: null,
    dataAsOf: null,
    closedCandles: 199,
    fetchedAt: null,
    cached: false,
    rank: 1,
    model,
    setups: modelSetups(model),
    riskProfiles: null,
  };
}

const row = (inputs: FactorInputs) => diagnosticRow('2026-01-01', resultOf(inputs));

describe('diagnostic definition', () => {
  it('keeps the committed machine-readable definition aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/model-diagnostic-crypto.v1.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(MODEL_DIAGNOSTIC_DEFINITION));
    expect(MODEL_DIAGNOSTIC_ID).toBe(
      '8dc1d6fdbc62455da6bf03d27b0f02e47f2beda6e75954e76acb1ef3c7a117df',
    );
  });

  it('never names an outcome among what it reads', () => {
    expect(MODEL_DIAGNOSTIC_DEFINITION.reads.study.fieldsRead).not.toContain('horizons');
    expect(MODEL_DIAGNOSTIC_DEFINITION.reads.study.neverRead).toEqual(['horizons', 'composition']);
  });
});

describe('taking a score apart', () => {
  it('reproduces hand-calculated contributions and shortfalls', () => {
    // TRENDING: RSI 40 → 75, momentum +0.7% → 85, volatility 2% → 70; weights 0.3/0.5/0.2.
    const r = row({ rsi: 40, momentumPercent: 0.007, volatilityPercent: 0.02 });
    expect(r.regime).toBe('TRENDING');
    expect(r.contributions.rsi).toBeCloseTo(22.5, 10);
    expect(r.contributions.momentum).toBeCloseTo(42.5, 10);
    expect(r.contributions.volatility).toBeCloseTo(14, 10);
    expect(r.raw).toBeCloseTo(79, 10);
    expect(r.shortfalls).toEqual({
      rsi: expect.closeTo(7.5, 10),
      momentum: expect.closeTo(7.5, 10),
      volatility: expect.closeTo(6, 10),
    });
    expect([r.score, r.long, r.risk]).toEqual([79, true, false]);
  });

  it('refuses a recorded score or setup the decomposition does not reproduce', () => {
    const inputs = { rsi: 40, momentumPercent: 0.007, volatilityPercent: 0.02 };
    expect(() => diagnosticRow('d', resultOf(inputs, { signal_score: 80 }))).toThrow(/reproduce/);
    const tampered = { ...resultOf(inputs), setups: { long: false, risk: false } };
    expect(() => diagnosticRow('d', tampered)).toThrow(/reproduce/);
    expect(() => diagnosticRow('d', { ...resultOf(inputs), status: 'STALE_DATA' })).toThrow();
  });

  it('flags a volatility veto exactly when the volatility shortfall exceeds 22.5', () => {
    // HIGH_VOLATILITY weight 0.3: the shortfall passes 22.5 above 4.25% ATR/close.
    const at = (v: number) => row({ rsi: 0, momentumPercent: 0.01, volatilityPercent: v });
    expect(LONG_SHORTFALL_BUDGET).toBe(22.5);
    expect(cells([at(0.0424)]).scoreGateVetoes.volatility).toBe(0);
    expect(cells([at(0.0424)]).longGates.both).toBe(1);
    expect(cells([at(0.0426)]).scoreGateVetoes.volatility).toBe(1);
  });
});

describe('gate cells', () => {
  const rows = [
    row({ rsi: 40, momentumPercent: 0.007, volatilityPercent: 0.02 }), // Long, no Risk
    row({ rsi: 14, momentumPercent: -0.0001, volatilityPercent: 0.007 }), // score gate only
    row({ rsi: 55, momentumPercent: 0.002, volatilityPercent: 0.03 }), // momentum gate only
    row({ rsi: 60, momentumPercent: -0.002, volatilityPercent: 0.03 }), // neither, no Risk
    row({ rsi: 60, momentumPercent: 0.003, volatilityPercent: 0.07 }), // Risk: volatility only
    row({ rsi: 80, momentumPercent: -0.02, volatilityPercent: 0.08 }), // Risk: both
    row({ rsi: 60, momentumPercent: -0.00602, volatilityPercent: 0.035 }), // Risk: low score only
    row({ rsi: 0, momentumPercent: 0.01, volatilityPercent: 0.0424 }), // Long and Risk
  ];

  it('counts each Long and Risk cell and their overlap', () => {
    expect(rows.map((r) => riskClauses(r.gates))).toEqual([
      'neither',
      'neither',
      'neither',
      'neither',
      'highVolatilityOnly',
      'both',
      'lowScoreOnly',
      'highVolatilityOnly',
    ]);
    const c = cells(rows);
    expect(c.longGates).toEqual({ both: 2, scoreOnly: 1, momentumOnly: 2, neither: 3 });
    expect(c.riskClauses).toEqual({ both: 1, lowScoreOnly: 1, highVolatilityOnly: 2, neither: 4 });
    expect(c.longAndRisk).toBe(1);
    expect(c.regimes).toEqual({
      HIGH_VOLATILITY: 3,
      TRENDING: 2,
      MEAN_REVERTING: 1,
      NEUTRAL: 2,
    });
  });

  it('splits every row into score gate met, vetoed by a factor, or short only jointly', () => {
    const c = cells(rows);
    const met = c.longGates.both + c.longGates.scoreOnly;
    expect(met + c.scoreGateVetoes.anyFactor + c.scoreGateVetoes.noSingleFactor).toBe(rows.length);
  });

  it('counts a gate decided only by rounding', () => {
    const tie = row({ rsi: 50, momentumPercent: 0.01, volatilityPercent: 0.02749 });
    expect([tie.raw < 78, tie.score]).toEqual([true, 78]);
    expect(cells([tie]).roundingDecided.scoreGate).toBe(1);
  });
});

describe('statistics', () => {
  it('interpolates quantiles between order statistics', () => {
    expect(quantiles([5, 1, 4, 2, 3])).toEqual({
      p0: 1,
      p5: 1.2,
      p25: 2,
      p50: 3,
      p75: 4,
      p95: 4.8,
      p100: 5,
    });
    expect(quantiles([])).toBeNull();
  });
});

describe('MACD histogram versus ATR', () => {
  const K = histogramAtrBound();

  it('bounds |momentum| by K × volatility on any candles with low <= close <= high', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
    for (let trial = 0; trial < 200; trial += 1) {
      const closes: number[] = [];
      const highs: number[] = [];
      const lows: number[] = [];
      let close = 100;
      for (let i = 0; i < 199; i += 1) {
        close *= 1 + (random() - 0.5) * 0.2 * random();
        highs.push(close * (1 + random() * 0.05));
        lows.push(close * (1 - random() * 0.05));
        closes.push(close);
      }
      const hist = macd(closes).histogram[198] ?? Number.NaN;
      const range = atr(highs, lows, closes, 14)[198] ?? Number.NaN;
      expect(Math.abs(hist)).toBeLessThanOrEqual(K * range * (1 + 1e-9));
    }
  });

  it('is attained by one jump on otherwise rangeless candles', () => {
    expect(K).toBeCloseTo(5.0319, 4);
    // The maximising step sits 56 candles before the last.
    const at = 198 - 56;
    const closes = Array.from({ length: 199 }, (_, i) => (i >= at ? 101 : 100));
    const highs = closes.map((c, i) => (i === at ? 101 : c));
    const lows = closes.map((c, i) => (i === at ? 100 : c));
    const ratio =
      Math.abs(macd(closes).histogram[198] ?? Number.NaN) /
      (atr(highs, lows, closes, 14)[198] ?? Number.NaN);
    expect(ratio).toBeCloseTo(K, 9);
  });
});

/**
 * Labeled fixtures, not market data: synthetic daily bars shaped like a `get_ohlcv` 1D export
 * of crypto-usdt-v1, 230 closed days ending 10 Nov 2026 plus the forming 11 Nov bar.
 */
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 11, 18, 40);
const LAST_CLOSED = Date.UTC(2026, 10, 10);
const iso = (time: number) => new Date(time).toISOString();

function exportOf(): TradingViewOhlcvExport {
  const first = LAST_CLOSED - 229 * DAY;
  return {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    universe: CRYPTO_UNIVERSE,
    retrieval: { startedAt: iso(START), completedAt: iso(START + 60_000) },
    instruments: universeTickers(CRYPTO_UNIVERSE).map((ticker, k) => {
      const symbol = CRYPTO_TRADINGVIEW_SYMBOLS[ticker] ?? ticker;
      const bars = Array.from({ length: 231 }, (_, i) => {
        const close =
          100 *
          (1 + (0.02 + 0.01 * (k % 5)) * Math.sin((i + 7 * k) / (4 + (k % 6)))) *
          (1 + 0.001 * ((k % 3) - 1) * i);
        const open = close * 0.996;
        return {
          t: (first + i * DAY) / 1000,
          o: open,
          h: Math.max(open, close) * (1.005 + 0.004 * (k % 4)),
          l: Math.min(open, close) * (0.995 - 0.004 * (k % 4)),
          c: close,
          v: 1_000,
        };
      });
      return {
        ticker,
        symbol,
        receivedAt: iso(START + 30_000),
        response: {
          success: true,
          symbol,
          interval: '1D',
          currency: 'USDT',
          notice: 'Market data notice: the last bar is still forming and may change.',
          bars,
        },
      };
    }),
  };
}

const scanOptions = {
  evaluationTime: START,
  universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  equityProvider: null,
  cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
};

describe('the diagnostic on a synthetic export', () => {
  const file = exportOf();
  const recorded = {
    scanId: RECORDED_SCAN.scanId,
    scan: evaluateScan(importInputs(file, START), scanOptions),
  };
  const study = runCryptoStudy(file, 'fixture', recorded);
  const run = (facts = study) => modelDiagnostic(file, 'fixture', recorded, facts, 'fixture-sha');
  let clean: ReturnType<typeof run> | undefined;
  const result = () => (clean ??= run());

  it(
    'reconciles every replayed date and every count with the study',
    () => {
      const r = result();
      expect(r.reconciliation).toMatchObject({ status: 'MATCH', differences: [] });
      expect(r.reconciliation.datesCompared).toBe(study.replay.length);
      // Not vacuous: several regimes, Risk onsets and standing Risk occur in the fixture.
      expect(Object.values(r.all.regimes).every((n) => n > 0)).toBe(true);
      expect(r.signals.long.transitions).toBeGreaterThan(0);
      expect(r.signals.risk.transitionsByClauses.lowScoreOnly).toBeGreaterThan(0);
      expect(r.signals.risk.transitionsByClauses.highVolatilityOnly).toBeGreaterThan(0);
      expect(r.coverage.byStatus).toEqual(study.coverage.byStatus);
      expect(r.all.rows).toBe(study.coverage.byStatus.EVALUATED);
      expect(r.signals.long).toEqual(study.coverage.signals.long);
      const { transitionsByClauses, clauseChangesWhileStanding, ...risk } = r.signals.risk;
      expect(risk).toEqual(study.coverage.signals.risk);
      const t = transitionsByClauses;
      expect(t.both + t.lowScoreOnly + t.highVolatilityOnly).toBe(risk.transitions);
      // Every row lands in exactly one cell of each table.
      const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
      expect(sum(r.all.longGates)).toBe(r.all.rows);
      expect(sum(r.all.riskClauses)).toBe(r.all.rows);
      expect(sum(r.all.regimes)).toBe(r.all.rows);
      expect(r.all.riskClauses.neither).toBe(r.all.rows - risk.observations);
      expect(sum(r.distributions.scoreBands)).toBe(r.all.rows);
    },
    STUDY_TIMEOUT,
  );

  it(
    'reports a changed replay entry or count instead of matching',
    () => {
      const replay = study.replay.map((date, k) =>
        k === 3
          ? {
              ...date,
              results: date.results.map((x, i) =>
                i === 0 ? { ...x, score: (x.score ?? 0) + 1 } : x,
              ),
            }
          : date,
      );
      const changed = run({ ...study, replay });
      expect(changed.reconciliation.status).toBe('MISMATCH');
      expect(changed.reconciliation.differences).toEqual([`replay ${study.replay[3]?.session}`]);
      const counted = run({
        ...study,
        coverage: {
          ...study.coverage,
          signals: {
            ...study.coverage.signals,
            risk: { ...study.coverage.signals.risk, transitions: -1 },
          },
        },
      });
      expect(counted.reconciliation.differences.join()).toMatch(/coverage\.signals\.risk/);
    },
    STUDY_TIMEOUT,
  );

  it(
    'never reads an outcome and gives the same results every time',
    () => {
      const guarded = Object.defineProperties(
        { ...study },
        {
          horizons: {
            get: () => {
              throw new Error('read horizons');
            },
          },
          composition: {
            get: () => {
              throw new Error('read composition');
            },
          },
        },
      );
      expect(JSON.stringify(run(guarded))).toBe(JSON.stringify(result()));
    },
    STUDY_TIMEOUT,
  );

  it(
    'prints aggregates only: no pair, row or date of a Long observation',
    () => {
      const summary = JSON.stringify(diagnosticSummary(result()));
      for (const ticker of universeTickers(CRYPTO_UNIVERSE)) expect(summary).not.toContain(ticker);
      expect(summary).not.toContain('"rows":[');
      expect(summary).not.toContain('byPair');
    },
    STUDY_TIMEOUT,
  );
});

describe('the private run', () => {
  it('refuses study results that are not the frozen file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-diagnostic-'));
    await writeFile(join(dir, 'scanner-research-6d005fee9ffd.json'), '{}\n');
    await expect(loadStudyFacts(dir)).rejects.toThrow(/frozen as sha256 a14c0d19/);
  });

  it('refuses an export that is not the frozen one before reading anything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'model-diagnostic-'));
    const path = join(dir, 'export.json');
    await writeFile(path, JSON.stringify(exportOf()));
    await expect(
      runModelDiagnosticCrypto({
        file: path,
        scanStore: dir,
        outputDir: dir,
        repositoryCommit: 'test',
      }),
    ).rejects.toThrow(/frozen on export/);
  });
});
