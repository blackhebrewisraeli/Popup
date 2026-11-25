import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atr, macd, rsi } from '@/lib/indicators';
import { mulberry32 } from './opportunityAnalysis';
import {
  COLUMNS,
  decisionAt,
  decisionTimes,
  EXCLUSIONS,
  exportDataset,
  FEATURES,
  featuresOf,
  LABELS,
  labelsOf,
  pairRows,
  SPEC,
  specSha256,
} from './quantileForecast';
import { exportIdentity, runQuantileForecastExport } from './quantileForecastRun';
import {
  featuresAt,
  HOUR_MS,
  indexHourly,
  PROTOCOL,
  protocolSha256,
  type HourCandle,
} from './spot24h';
import type { Git } from './spot24hDiagnosticRun';

const H = HOUR_MS;
const HISTORY = Date.parse(PROTOCOL.data.historyStart);
const CUTOFF = Date.parse(PROTOCOL.data.collectionCutoff);
const T0 = Date.parse('2025-06-01T08:00:00.000Z');
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const candle = (timestamp: number, open: number, high: number, low: number, close: number) =>
  ({ timestamp, closeTime: timestamp + H - 1, open, high, low, close }) as HourCandle;

/** A valid random walk of hourly candles from `start`, one per hour up to the cutoff. */
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

const index = (candles: readonly HourCandle[]) => indexHourly(candles, CUTOFF);
const featuresAtT = (candles: readonly HourCandle[], time = T0) => {
  const decision = decisionAt(index(candles), time);
  if (!('features' in decision)) throw new Error(decision.exclusion);
  return decision;
};
const replace = (candles: readonly HourCandle[], time: number, close: number) =>
  candles.map((c) =>
    c.timestamp === time
      ? candle(time, c.open, Math.max(c.high, close), Math.min(c.low, close), close)
      : c,
  );

describe('the specification', () => {
  it('mirrors its feature, label and exclusion lists and v1 boundaries', () => {
    expect(FEATURES).toEqual(SPEC.features.order);
    expect(Object.keys(SPEC.features.definitions)).toEqual(SPEC.features.order);
    expect(LABELS).toEqual(SPEC.model.targets);
    expect(EXCLUSIONS).toEqual(SPEC.exclusions.order);
    expect(SPEC.periods.list.map((p) => p.end).slice(0, 2)).toEqual(PROTOCOL.splits.boundaries);
    expect(SPEC.periods.list[0]?.start).toBe(PROTOCOL.decisions.firstDecision);
    expect(SPEC.periods.list.at(-1)?.end).toBe(PROTOCOL.data.collectionCutoff);
    expect(SPEC.features.windowCandles).toBe(PROTOCOL.features.windowCandles);
    expect(SPEC.basis.protocol.sha256).toBe(protocolSha256());
    expect(specSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never exports the entry reference O', () => {
    expect(COLUMNS).toEqual(['symbol', 'time', ...FEATURES, ...LABELS]);
    expect(COLUMNS.some((column) => /open/i.test(column))).toBe(false);
  });
});

describe('the decision grid', () => {
  it("is v1's: every four hours, labels ending by the cutoff", () => {
    const times = decisionTimes();
    expect(times).toHaveLength(4_375);
    expect(new Date(times[0]!).toISOString()).toBe('2024-11-22T00:00:00.000Z');
    expect(new Date(times.at(-1)!).toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(times.every((t, i) => i === 0 || t - times[i - 1]! === 4 * H)).toBe(true);
  });
});

describe('features', () => {
  // closes 100 ... 299, high = close + 1, low = close - 1
  const ramp = Array.from({ length: 200 }, (_, i) =>
    candle(i * H, 99 + i, 101 + i, 99 + i, 100 + i),
  );

  it('follow their definitions on the 200 closed candles', () => {
    const f = featuresOf(ramp);
    expect(f.ret1h).toBe(299 / 298 - 1);
    expect(f.ret4h).toBe(299 / 295 - 1);
    expect(f.ret24h).toBe(299 / 275 - 1);
    expect(f.ret72h).toBe(299 / 227 - 1);
    expect(f.high24OverCloseMinus1).toBe(300 / 299 - 1);
    expect(f.closeOverLow24Minus1).toBe(299 / 275 - 1);
    expect(f.closeOverSma24Minus1).toBeCloseTo(299 / 287.5 - 1, 14);
    const logs = Array.from({ length: 24 }, (_, j) => Math.log((276 + j) / (275 + j)));
    const meanSquare = logs.reduce((s, x) => s + x * x, 0) / 24;
    const mean = logs.reduce((s, x) => s + x, 0) / 24;
    expect(f.logReturnStd24h).toBeCloseTo(Math.sqrt(meanSquare - mean * mean), 12);
    const closes = ramp.map((c) => c.close);
    expect(f.rsi14Over100).toBe(rsi(closes, 14)[199]! / 100);
    expect(f.macdHistogramOverClose).toBe(macd(closes, 12, 26, 9).histogram[199]! / 299);
    const a = atr(
      ramp.map((c) => c.high),
      ramp.map((c) => c.low),
      closes,
      14,
    )[199]!;
    expect(f.atr14OverClose).toBe(a / 299);
  });

  it("equal protocol v1's featuresAt on the same windows (Popup's indicators, v1's seeds)", () => {
    const candles = walk(7);
    const idx = index(candles);
    for (const time of decisionTimes().filter((_, i) => i % 97 === 0)) {
      const decision = decisionAt(idx, time);
      const v1 = featuresAt(idx, time);
      if (!('features' in decision) || !v1) throw new Error('window unavailable');
      expect(decision.features.rsi14Over100).toBe(v1.rsi / 100);
      expect(decision.features.macdHistogramOverClose).toBe(v1.macdHistogram / v1.close);
      expect(decision.features.atr14OverClose).toBe(v1.v);
    }
  });

  it('ignore every candle from T on and before the window, and see the last closed one', () => {
    const candles = walk(11);
    const before = featuresAtT(candles).features;
    let future = replace(candles, T0, 1);
    future = replace(future, T0 + 5 * H, 500);
    future = future.filter((c) => c.timestamp !== T0 + 30 * H);
    expect(decisionAt(index(future), T0)).toMatchObject({ features: before });
    expect(featuresAtT(replace(candles, T0 - 201 * H, 3)).features).toEqual(before);
    expect(featuresAtT(replace(candles, T0 - H, 1)).features).not.toEqual(before);
  });
});

describe('labels', () => {
  it('are the full-window terminal return and excursions from O', () => {
    const bars = Array.from({ length: 24 }, (_, i) => candle(i * H, 100, 101, 99, 100));
    bars[0] = candle(0, 100, 101, 99, 100);
    bars[10] = candle(10 * H, 100, 112, 99, 100);
    bars[23] = candle(23 * H, 100, 104, 95, 104);
    expect(labelsOf(bars)).toEqual({
      terminalReturn: 104 / 100 - 1,
      upExcursion: 112 / 100 - 1,
      downExcursion: 1 - 95 / 100,
    });
    const inside = bars.map((b) => candle(b.timestamp, 100, 99, 101, 100));
    expect(labelsOf(inside)).toMatchObject({ upExcursion: 0, downExcursion: 0 });
  });

  it('read exactly the 24 candles opening T ... T + 23h', () => {
    const candles = walk(13);
    const { labels } = featuresAtT(candles);
    const bars = candles.filter((c) => c.timestamp >= T0 && c.timestamp < T0 + 24 * H);
    expect(labels).toEqual(labelsOf(bars));
    expect(featuresAtT(replace(candles, T0 + 24 * H, 1)).labels).toEqual(labels);
    expect(featuresAtT(replace(candles, T0 - H, 1)).labels).toEqual(labels);
    expect(featuresAtT(replace(candles, T0 + 23 * H, 1)).labels.terminalReturn).not.toBe(
      labels.terminalReturn,
    );
  });
});

describe('exclusions', () => {
  it('count a missing hour in exactly the 50 windows and 6 labels that need it', () => {
    const candles = walk(17);
    const hole = Date.parse('2025-08-10T13:00:00.000Z');
    const { coverage, rows } = pairRows(
      'AAAUSDT',
      candles.filter((c) => c.timestamp !== hole),
    );
    expect(coverage.exclusions).toEqual({
      FEATURE_WINDOW_UNAVAILABLE: 50,
      FEATURES_NOT_FINITE: 0,
      VOLATILITY_NOT_POSITIVE: 0,
      LABEL_WINDOW_UNAVAILABLE: 6,
    });
    expect(coverage.observations).toBe(4_375 - 56);
    expect(rows).toHaveLength(coverage.observations);
  });

  it('refuse both copies of a duplicate, never repair them, and refuse zero volatility', () => {
    const candles = walk(19);
    const twin = candles.find((c) => c.timestamp === T0)!;
    const { coverage } = pairRows('AAAUSDT', [...candles, { ...twin }]);
    expect(coverage.candleIssues).toEqual({ DUPLICATE_TIMESTAMP: 2 });
    expect(coverage.observations).toBe(4_375 - 50 - 6);

    const flat = candles.map((c) =>
      c.timestamp >= T0 - 200 * H && c.timestamp < T0 ? candle(c.timestamp, 1, 1, 1, 1) : c,
    );
    expect(decisionAt(index(flat), T0)).toEqual({ exclusion: 'VOLATILITY_NOT_POSITIVE' });
  });
});

describe('the dataset', () => {
  it('orders rows by T, then member order, with features then raw labels', () => {
    const dataset = exportDataset({ BBBUSDT: walk(23), AAAUSDT: walk(29) }, ['BBBUSDT', 'AAAUSDT']);
    expect(dataset.specification).toEqual({ id: SPEC.specificationId, sha256: specSha256() });
    expect(dataset.coverage.total.observations).toBe(2 * 4_375);
    expect(dataset.rows.slice(0, 2).map((r) => r.slice(0, 2))).toEqual([
      ['BBBUSDT', Date.parse(PROTOCOL.decisions.firstDecision)],
      ['AAAUSDT', Date.parse(PROTOCOL.decisions.firstDecision)],
    ]);
    expect(dataset.rows.every((r) => r.length === COLUMNS.length)).toBe(true);
    const row = dataset.rows.find((r) => r[0] === 'AAAUSDT' && r[1] === T0)!;
    const { features, labels } = featuresAtT(walk(29));
    expect(row.slice(2)).toEqual([
      ...FEATURES.map((f) => features[f]),
      ...LABELS.map((l) => labels[l]),
    ]);
  });
});

describe('the export runner', () => {
  it('refuses to run while a tracked file differs from the commit', async () => {
    const dirty: Git = async (...args) => (args[0] === 'status' ? ' M scripts/x.ts' : 'abc');
    await expect(exportIdentity(dirty)).rejects.toThrow('commit before running');
  });

  it('verifies every input, writes once and never overwrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quantile-forecast-'));
    const dataDir = join(root, 'data');
    await mkdir(join(dataDir, 'klines'), { recursive: true });
    const candleFiles: Record<string, { sha256: string; candles: number; retrievedAt: string }> =
      {};
    for (const [i, symbol] of PROTOCOL.universe.members.entries()) {
      const text = JSON.stringify({ symbol, candles: walk(i + 1, HISTORY, HISTORY + 230 * H) });
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
    const recordedPath = join(root, 'recorded.json');
    await writeFile(recordedPath, JSON.stringify({ manifest }));
    const recorded = {
      path: recordedPath,
      sha256: sha256(await readFile(recordedPath)),
      runCommit: 'run',
    };
    const identity = async () => ({ codeCommit: 'c'.repeat(40), codeBlobs: {} });
    const out = join(root, 'out');

    const first = await runQuantileForecastExport(dataDir, out, identity, recorded);
    expect(first.status).toBe('CREATED');
    // 230 hours from the history start: only 00:00 and 04:00 on 22 Nov have both windows.
    expect(first.coverage.observations).toBe(20 * 2);
    const written = JSON.parse(await readFile(first.path, 'utf8'));
    expect(sha256(await readFile(first.path))).toBe(first.contentSha256);
    expect(written.manifest.specification.fileSha256).toBe(
      sha256(await readFile('docs/quantile-forecast-24h-dev-v1.json')),
    );
    expect(written.columns).toEqual(COLUMNS);
    expect((await runQuantileForecastExport(dataDir, out, identity, recorded)).status).toBe(
      'UNCHANGED',
    );
    const other = async () => ({ codeCommit: 'd'.repeat(40), codeBlobs: {} });
    const second = await runQuantileForecastExport(dataDir, out, other, recorded);
    expect(second.path).not.toBe(first.path);

    await writeFile(join(dataDir, 'klines', 'BTCUSDT-1h.json'), '{"candles":[]}');
    await expect(runQuantileForecastExport(dataDir, out, identity, recorded)).rejects.toThrow(
      'differs from the manifest',
    );
    await expect(
      runQuantileForecastExport(dataDir, out, identity, { ...recorded, sha256: 'x' }),
    ).rejects.toThrow('is not x');
  }, 60_000);
});
