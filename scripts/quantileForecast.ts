/**
 * Feature and label export of the 24-hour quantile forecast study
 * (docs/quantile-forecast-24h-dev-v1.json, docs/QUANTILE_FORECAST_24H_DEV_V1.md). Pure: from
 * protocol v1's validated hourly candles, one row per v1 decision with the eleven causal features,
 * computed by Popup's own indicator functions on v1's 200-candle window, and the three raw 24-hour
 * labels. Fitting and metrics live in scripts/quantile_forecast.py. No network, account, order or
 * production store.
 */
import { createHash } from 'node:crypto';
import specJson from '../docs/quantile-forecast-24h-dev-v1.json';
import { atr, macd, rsi, sma } from '@/lib/indicators';
import { stableSerialize } from '@/lib/stableSerialize';
import {
  consecutive,
  DAY_MS,
  HORIZON_BARS,
  HOUR_MS,
  indexHourly,
  PROTOCOL,
  type HourCandle,
  type HourlyIndex,
} from './spot24h';

export const SPEC = specJson;
export const specSha256 = (spec: unknown = SPEC) =>
  createHash('sha256').update(stableSerialize(spec)).digest('hex');

/** features.order, labels and exclusions.order as types; a test checks them against the JSON. */
export const FEATURES = [
  'ret1h',
  'ret4h',
  'ret24h',
  'ret72h',
  'atr14OverClose',
  'logReturnStd24h',
  'rsi14Over100',
  'macdHistogramOverClose',
  'closeOverSma24Minus1',
  'high24OverCloseMinus1',
  'closeOverLow24Minus1',
] as const;
export const LABELS = ['terminalReturn', 'upExcursion', 'downExcursion'] as const;
export const EXCLUSIONS = [
  'FEATURE_WINDOW_UNAVAILABLE',
  'FEATURES_NOT_FINITE',
  'VOLATILITY_NOT_POSITIVE',
  'LABEL_WINDOW_UNAVAILABLE',
] as const;
export const COLUMNS = ['symbol', 'time', ...FEATURES, ...LABELS] as const;

export type Feature = (typeof FEATURES)[number];
export type Label = (typeof LABELS)[number];
export type Exclusion = (typeof EXCLUSIONS)[number];
export type Row = [string, number, ...number[]];

const WINDOW = SPEC.features.windowCandles;
const RECENT = 24;

/** features.definitions over w[0..199], the candles closed by T; the open at T is never read. */
export function featuresOf(window: readonly HourCandle[]): Record<Feature, number> {
  const last = window.length - 1;
  const closes = window.map((candle) => candle.close);
  const c = closes[last]!;
  const ret = (hours: number) => c / closes[last - hours]! - 1;
  const recent = window.slice(-RECENT);
  const logs = recent.map((candle, j) => Math.log(candle.close / closes[last - RECENT + j]!));
  const mean = logs.reduce((sum, x) => sum + x, 0) / RECENT;
  const spread = logs.reduce((sum, x) => sum + (x - mean) ** 2, 0) / RECENT;
  const highs = window.map((candle) => candle.high);
  const lows = window.map((candle) => candle.low);
  return {
    ret1h: ret(1),
    ret4h: ret(4),
    ret24h: ret(24),
    ret72h: ret(72),
    atr14OverClose: atr(highs, lows, closes, 14)[last]! / c,
    logReturnStd24h: Math.sqrt(spread),
    rsi14Over100: rsi(closes, 14)[last]! / 100,
    macdHistogramOverClose: macd(closes, 12, 26, 9).histogram[last]! / c,
    closeOverSma24Minus1: c / sma(closes, RECENT)[last]! - 1,
    high24OverCloseMinus1: Math.max(...recent.map((candle) => candle.high)) / c - 1,
    closeOverLow24Minus1: c / Math.min(...recent.map((candle) => candle.low)) - 1,
  };
}

/** labels over f[0..23], the candles opening T ... T + 23h; O = open of f[0]. */
export function labelsOf(bars: readonly HourCandle[]): Record<Label, number> {
  const o = bars[0]!.open;
  return {
    terminalReturn: bars.at(-1)!.close / o - 1,
    upExcursion: Math.max(0, Math.max(...bars.map((bar) => bar.high)) / o - 1),
    downExcursion: Math.max(0, 1 - Math.min(...bars.map((bar) => bar.low)) / o),
  };
}

export type Decision =
  { features: Record<Feature, number>; labels: Record<Label, number> } | { exclusion: Exclusion };

/** exclusions.rule: the first reason that applies, else an observation. */
export function decisionAt(index: HourlyIndex, time: number): Decision {
  const window = consecutive(index, time - WINDOW * HOUR_MS, WINDOW);
  if (!window) return { exclusion: 'FEATURE_WINDOW_UNAVAILABLE' };
  const features = featuresOf(window);
  if (!Object.values(features).every(Number.isFinite)) return { exclusion: 'FEATURES_NOT_FINITE' };
  if (features.atr14OverClose <= 0) return { exclusion: 'VOLATILITY_NOT_POSITIVE' };
  const bars = consecutive(index, time, HORIZON_BARS);
  if (!bars) return { exclusion: 'LABEL_WINDOW_UNAVAILABLE' };
  return { features, labels: labelsOf(bars) };
}

/** decisions.grid: v1's decision times whose 24-hour label ends by the cutoff. */
export function decisionTimes(protocol = PROTOCOL): number[] {
  const cutoff = Date.parse(protocol.data.collectionCutoff);
  const hours: readonly number[] = protocol.decisions.gridUtcHours;
  const times: number[] = [];
  for (let t = Date.parse(protocol.decisions.firstDecision); t + DAY_MS <= cutoff; t += HOUR_MS) {
    if (hours.includes(new Date(t).getUTCHours())) times.push(t);
  }
  return times;
}

export interface PairCoverage {
  candlesIncluded: number;
  candleIssues: Record<string, number>;
  decisions: number;
  observations: number;
  exclusions: Record<Exclusion, number>;
}

const noExclusions = () =>
  Object.fromEntries(EXCLUSIONS.map((reason) => [reason, 0])) as Record<Exclusion, number>;

export function pairRows(symbol: string, candles: readonly HourCandle[], times = decisionTimes()) {
  const index = indexHourly(candles, Date.parse(PROTOCOL.data.collectionCutoff));
  const candleIssues: Record<string, number> = {};
  for (const { code } of index.issues) candleIssues[code] = (candleIssues[code] ?? 0) + 1;
  const coverage: PairCoverage = {
    candlesIncluded: index.included,
    candleIssues,
    decisions: times.length,
    observations: 0,
    exclusions: noExclusions(),
  };
  const rows: Row[] = [];
  for (const time of times) {
    const decision = decisionAt(index, time);
    if ('exclusion' in decision) {
      coverage.exclusions[decision.exclusion] += 1;
      continue;
    }
    rows.push([
      symbol,
      time,
      ...FEATURES.map((f) => decision.features[f]),
      ...LABELS.map((l) => decision.labels[l]),
    ]);
  }
  coverage.observations = rows.length;
  return { rows, coverage };
}

/** Every pair's rows, ordered by T and then by v1's member order (output.dataset). */
export function exportDataset(
  candles: Readonly<Record<string, readonly HourCandle[]>>,
  members: readonly string[],
) {
  const pairs = members.map((symbol) => ({ symbol, ...pairRows(symbol, candles[symbol] ?? []) }));
  const rank = new Map(members.map((symbol, i) => [symbol, i]));
  const rows = pairs
    .flatMap((pair) => pair.rows)
    .sort((a, b) => a[1] - b[1] || rank.get(a[0])! - rank.get(b[0])!);
  const total = { decisions: 0, observations: 0, exclusions: noExclusions() };
  for (const { coverage } of pairs) {
    total.decisions += coverage.decisions;
    total.observations += coverage.observations;
    for (const reason of EXCLUSIONS) total.exclusions[reason] += coverage.exclusions[reason];
  }
  return {
    specification: { id: SPEC.specificationId, sha256: specSha256() },
    coverage: { pairs: Object.fromEntries(pairs.map((p) => [p.symbol, p.coverage])), total },
    columns: COLUMNS,
    rows,
  };
}

export type Dataset = ReturnType<typeof exportDataset>;
