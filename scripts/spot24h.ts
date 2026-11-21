/**
 * Offline prototype of Popup's 24-hour Spot target-before-stop evaluation, protocol v1
 * (docs/spot-24h-probability.v1.json, docs/SPOT_24H_PROBABILITY.md). Pure functions over
 * candles passed in memory: no network, no account, no order. The JSON is the only source of
 * the protocol's constants, and its SHA-256 is the protocol identity.
 */
import { createHash } from 'node:crypto';
import protocolJson from '../docs/spot-24h-probability.v1.json';
import { atr, macd, rsi } from '@/lib/indicators';
import { validatePrices, type CandleIssueCode } from '@/lib/candleValidation';
import { stableSerialize } from '@/lib/stableSerialize';
import type { DiscoveryEvidence } from '../supabase/functions/_shared/dailyDiscovery';
import { bootstrapOrders } from './swingStructureEvaluation';

export const PROTOCOL = protocolJson;
export type Protocol = typeof protocolJson;
export const protocolSha256 = (protocol: unknown = PROTOCOL) =>
  createHash('sha256').update(stableSerialize(protocol)).digest('hex');

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const HORIZON_BARS = 24;
const ms = (iso: string) => Date.parse(iso);

// ---------------------------------------------------------------------------------------------
// Universe

export type UniverseSkip =
  'EXCLUDED_BASE' | 'LEVERAGED_PRODUCT' | 'LABELLED_BY_DISCOVERY' | 'INSUFFICIENT_HISTORY';

export interface UniverseSelection {
  members: { rank: number; symbol: string; firstOpenTime: number }[];
  skipped: { rank: number; symbol: string; reason: UniverseSkip }[];
}

const LEVERAGED_SUFFIX = /(UP|DOWN|BULL|BEAR)$/;

/** Base assets that look like a leveraged product of another listed base asset. */
export function isLeveragedProduct(baseAsset: string, bases: ReadonlySet<string>): boolean {
  const match = LEVERAGED_SUFFIX.exec(baseAsset);
  return match !== null && bases.has(baseAsset.slice(0, match.index));
}

/** Members needing a first-candle check: the discovery members not excluded by label or product. */
export function universeCandidates(evidence: DiscoveryEvidence, protocol: Protocol = PROTOCOL) {
  const bases = new Set(evidence.inputs.usdtInstruments.map((i) => i.baseAsset));
  const labelled: readonly string[] = protocol.universe.exclude.labelledByDiscovery;
  const excluded = new Set(Object.values(protocol.universe.exclude.additionalBases).flat());
  return evidence.result.members.map((member) => {
    let reason: UniverseSkip | null = null;
    if (excluded.has(member.baseAsset)) reason = 'EXCLUDED_BASE';
    else if (isLeveragedProduct(member.baseAsset, bases)) reason = 'LEVERAGED_PRODUCT';
    else if (labelled.includes(member.category)) reason = 'LABELLED_BY_DISCOVERY';
    return { rank: member.rank, symbol: member.symbol, reason };
  });
}

/** The protocol's universe walk, given each candidate's first 1h candle open time. */
export function selectUniverse(
  evidence: DiscoveryEvidence,
  firstOpenTimes: Readonly<Record<string, number>>,
  protocol: Protocol = PROTOCOL,
): UniverseSelection {
  const historyStart = ms(protocol.data.historyStart);
  const selection: UniverseSelection = { members: [], skipped: [] };
  for (const { rank, symbol, reason } of universeCandidates(evidence, protocol)) {
    if (selection.members.length === protocol.universe.size) break;
    const firstOpenTime = firstOpenTimes[symbol];
    if (reason) selection.skipped.push({ rank, symbol, reason });
    else if (firstOpenTime === undefined || firstOpenTime > historyStart)
      selection.skipped.push({ rank, symbol, reason: 'INSUFFICIENT_HISTORY' });
    else selection.members.push({ rank, symbol, firstOpenTime });
  }
  return selection;
}
