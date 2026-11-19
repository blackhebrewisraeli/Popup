/**
 * Daily discovery (docs/MARKET_SCANNER.md#daily-discovery-binance-spot-unattended): a dated,
 * liquidity-based shortlist of Binance Spot USDT pairs, collected unattended once a day by
 * scripts/dailyDiscovery.ts. It names candidates for later investigation. It is not an
 * opportunity score, a BUY/SELL signal or evidence of profitability, and it never feeds the
 * canonical model, assets_status or a research campaign.
 *
 * Pure: the collector builds a batch and the Research board verifies it with these same
 * functions, so membership and order can be re-derived from the stored inputs.
 */
import { compareTickers } from '@/lib/marketScanner';
import { webSha256 } from '@/lib/savedScanFile';
import { stableSerialize } from '@/lib/stableSerialize';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY_MS = 24 * HOUR;
/** The slot starts at 00:30 UTC; a collection must finish before 06:00 UTC that day. */
const SLOT_OFFSET_MS = 30 * MINUTE;
const DEADLINE_OFFSET_MS = 6 * HOUR;

export const DISCOVERY_POLICY_ID = 'binance-spot-usdt-liquidity-v1';
export const DISCOVERY_SCHEMA_VERSION = 1;
export const DISCOVERY_MAX_MEMBERS = 50;

/**
 * Base assets classified as stablecoins in crypto-usdt-v1's frozen walk
 * (docs/TRADINGVIEW_CRYPTO_SCAN.md, TradingView categories on 2026-11-11), matched to
 * Binance's `baseAsset` by exact code only. Any other stablecoin stays in the shortlist,
 * labelled Not classified, until a new policy version adds it from a reliable record.
 */
const STABLECOIN_BASES = [
  'AETHUSDT',
  'DAI',
  'PYUSD',
  'RLUSD',
  'RWUSD',
  'USD1',
  'USDC',
  'USDE',
  'USDG',
  'USDS',
  'USDT',
  'USDT0',
  'USDY',
] as const;

/** Recorded in the same walk and shown as a label; the policy does not exclude them. */
const LABELLED_BASES: Readonly<Record<string, DiscoveryCategory>> = {
  CBBTC: 'duplicate-exposure',
  STETH: 'duplicate-exposure',
  WBETH: 'duplicate-exposure',
  WBTC: 'duplicate-exposure',
  WEETH: 'duplicate-exposure',
  WETH: 'duplicate-exposure',
  WSTETH: 'duplicate-exposure',
  XAUT: 'tokenized-commodity',
};

export type DiscoveryCategory = 'duplicate-exposure' | 'tokenized-commodity' | 'unclassified';

/**
 * Everything that decides membership and order. Its SHA-256 is the policy's identity: a batch
 * recorded under another identity is refused, and a change here needs a new policy ID.
 */
export const DISCOVERY_POLICY = {
  id: DISCOVERY_POLICY_ID,
  kind: 'Liquidity-based shortlist; not an opportunity score',
  source: {
    provider: 'binance-spot-public-rest',
    exchangeInfo: 'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT',
    ticker: 'https://api.binance.com/api/v3/ticker/24hr?type=MINI',
  },
  eligibility: {
    quoteAsset: 'USDT',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    excludedBaseAssets: { stablecoin: STABLECOIN_BASES, leveragedToken: [] },
    labelledBaseAssets: LABELLED_BASES,
    classificationSource:
      'crypto-usdt-v1 walk, docs/TRADINGVIEW_CRYPTO_SCAN.md (TradingView categories, 2026-11-11); exact baseAsset code only',
  },
  ranking: {
    by: 'rolling 24-hour quoteVolume (USDT), exact decimal, descending',
    tieBreak: 'symbol, code-unit ascending',
    maxMembers: DISCOVERY_MAX_MEMBERS,
  },
  window: { lengthMs: DAY_MS, maxLagBeforeCutoffMs: HOUR, maxAfterReceiptMs: MINUTE },
  schedule: { slotUtc: '00:30', retryDeadlineUtc: '06:00' },
} as const;

export const discoveryPolicySha256 = () => webSha256(stableSerialize(DISCOVERY_POLICY));

// ── Slots ────────────────────────────────────────────────────────────────────

export interface DiscoverySlot {
  date: string;
  scheduledFor: string;
  retryDeadline: string;
}

export function slotForDate(date: string): DiscoverySlot {
  const day = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day)) {
    throw new RangeError(`Not a UTC date: ${date}`);
  }
  return {
    date,
    scheduledFor: new Date(day + SLOT_OFFSET_MS).toISOString(),
    retryDeadline: new Date(day + DEADLINE_OFFSET_MS).toISOString(),
  };
}

/** The latest slot that has started at `now`: before 00:30 UTC it is yesterday's. */
export function dueSlot(now: number): DiscoverySlot {
  const day = Math.floor((now - SLOT_OFFSET_MS) / DAY_MS) * DAY_MS;
  return slotForDate(new Date(day).toISOString().slice(0, 10));
}

const nextDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface DiscoveryInstrument {
  symbol: string;
  baseAsset: string;
  status: string;
  spotTradingAllowed: boolean;
}

export interface DiscoveryTicker {
  symbol: string;
  /** Binance's decimal string, kept exactly as sent. */
  quoteVolume: string;
  openTime: number;
  closeTime: number;
}

export type TickerIssue =
  | 'TICKER_MISSING'
  | 'TICKER_DUPLICATE'
  | 'QUOTE_VOLUME_INVALID'
  | 'WINDOW_INVALID'
  | 'WINDOW_OUTDATED'
  | 'WINDOW_IN_FUTURE';

export interface DiscoveryInputs {
  /** Every symbol exchangeInfo listed, any quote. */
  listedSymbols: number;
  /** USDT-quoted entries (or entries whose quote could not be read) that were unusable. */
  malformedInstruments: number;
  usdtInstruments: DiscoveryInstrument[];
  /** Valid 24h figures for the eligible pairs. */
  tickers: DiscoveryTicker[];
  /** Eligible pairs without a valid figure: never ranked, never filled in. */
  invalidTickers: { symbol: string; issue: TickerIssue }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 1–40 characters, none a control, format or separator character (any space included). */
const SYMBOL_TEXT = /^[^\p{Cc}\p{Cf}\p{Z}]{1,40}$/u;
const isSymbolText = (value: unknown): value is string =>
  typeof value === 'string' && SYMBOL_TEXT.test(value);

/** One exchangeInfo entry: a USDT-quoted instrument, null for another quote, or unusable. */
function readInstrument(entry: unknown): DiscoveryInstrument | null | 'malformed' {
  if (!isRecord(entry)) return 'malformed';
  const { symbol, quoteAsset, baseAsset, status, isSpotTradingAllowed } = entry;
  if (!isSymbolText(symbol) || typeof quoteAsset !== 'string') return 'malformed';
  if (quoteAsset !== DISCOVERY_POLICY.eligibility.quoteAsset) return null;
  if (
    !isSymbolText(baseAsset) ||
    typeof status !== 'string' ||
    status === '' ||
    typeof isSpotTradingAllowed !== 'boolean'
  ) {
    return 'malformed';
  }
  return { symbol, baseAsset, status, spotTradingAllowed: isSpotTradingAllowed };
}

/** exchangeInfo reduced to its USDT-quoted instruments; null when the response is not one. */
export function parseExchangeInfo(body: unknown): {
  serverTime: number;
  listedSymbols: number;
  malformedInstruments: number;
  usdtInstruments: DiscoveryInstrument[];
} | null {
  if (!isRecord(body) || !Array.isArray(body['symbols'])) return null;
  const serverTime = body['serverTime'];
  if (typeof serverTime !== 'number' || !Number.isSafeInteger(serverTime) || serverTime <= 0) {
    return null;
  }
  let malformed = 0;
  const bySymbol = new Map<string, DiscoveryInstrument[]>();
  for (const entry of body['symbols']) {
    const instrument = readInstrument(entry);
    if (instrument === 'malformed') malformed += 1;
    else if (instrument) {
      bySymbol.set(instrument.symbol, [...(bySymbol.get(instrument.symbol) ?? []), instrument]);
    }
  }
  const usdtInstruments: DiscoveryInstrument[] = [];
  for (const list of bySymbol.values()) {
    // A symbol listed twice is unidentifiable: every copy counts as malformed.
    if (list.length === 1 && list[0]) usdtInstruments.push(list[0]);
    else malformed += list.length;
  }
  usdtInstruments.sort((a, b) => compareTickers(a.symbol, b.symbol));
  return {
    serverTime,
    listedSymbols: body['symbols'].length,
    malformedInstruments: malformed,
    usdtInstruments,
  };
}

type Exclusion = 'NOT_TRADING' | 'SPOT_TRADING_NOT_ALLOWED' | 'STABLECOIN_BASE';

const STABLECOINS: ReadonlySet<string> = new Set(STABLECOIN_BASES);

function exclusionOf(instrument: DiscoveryInstrument): Exclusion | null {
  if (instrument.status !== DISCOVERY_POLICY.eligibility.status) return 'NOT_TRADING';
  if (!instrument.spotTradingAllowed) return 'SPOT_TRADING_NOT_ALLOWED';
  if (STABLECOINS.has(instrument.baseAsset)) return 'STABLECOIN_BASE';
  return null;
}

/** The pairs whose 24h figures the collector requests and validates. */
export const eligibleSymbols = (instruments: readonly DiscoveryInstrument[]) =>
  instruments.filter((instrument) => exclusionOf(instrument) === null).map((i) => i.symbol);

const DECIMAL = /^\d{1,30}(\.\d{1,30})?$/;

function tickerIssue(
  raw: Record<string, unknown>,
  timing: { requestedAt: number; receivedAt: number },
): TickerIssue | null {
  const { quoteVolume, openTime, closeTime } = raw;
  const { window } = DISCOVERY_POLICY;
  if (typeof quoteVolume !== 'string' || !DECIMAL.test(quoteVolume)) return 'QUOTE_VOLUME_INVALID';
  if (
    typeof openTime !== 'number' ||
    typeof closeTime !== 'number' ||
    !Number.isSafeInteger(openTime) ||
    !Number.isSafeInteger(closeTime) ||
    openTime <= 0 ||
    closeTime - openTime !== window.lengthMs
  ) {
    return 'WINDOW_INVALID';
  }
  if (closeTime > timing.receivedAt + window.maxAfterReceiptMs) return 'WINDOW_IN_FUTURE';
  if (closeTime < timing.requestedAt - window.maxLagBeforeCutoffMs) return 'WINDOW_OUTDATED';
  return null;
}

/** Each eligible pair's rolling 24h figure, or why it has none; null when the body is not a list. */
export function parseTickers(
  body: unknown,
  symbols: readonly string[],
  timing: { requestedAt: number; receivedAt: number },
): Pick<DiscoveryInputs, 'tickers' | 'invalidTickers'> | null {
  if (!Array.isArray(body)) return null;
  const wanted = new Set(symbols);
  const found = new Map<string, Record<string, unknown>[]>();
  for (const entry of body) {
    if (!isRecord(entry) || typeof entry['symbol'] !== 'string') continue;
    if (!wanted.has(entry['symbol'])) continue;
    found.set(entry['symbol'], [...(found.get(entry['symbol']) ?? []), entry]);
  }
  const tickers: DiscoveryTicker[] = [];
  const invalidTickers: DiscoveryInputs['invalidTickers'] = [];
  for (const symbol of [...wanted].sort(compareTickers)) {
    const entries = found.get(symbol) ?? [];
    const raw = entries[0];
    let issue: TickerIssue | null;
    if (!raw) issue = 'TICKER_MISSING';
    else if (entries.length > 1) issue = 'TICKER_DUPLICATE';
    else issue = tickerIssue(raw, timing);
    if (issue !== null || !raw) {
      invalidTickers.push({ symbol, issue: issue ?? 'TICKER_MISSING' });
      continue;
    }
    tickers.push({
      symbol,
      quoteVolume: raw['quoteVolume'] as string,
      openTime: raw['openTime'] as number,
      closeTime: raw['closeTime'] as number,
    });
  }
  return { tickers, invalidTickers };
}

// ── Selection ────────────────────────────────────────────────────────────────

/** Exact comparison of two unsigned decimal strings. */
export function compareDecimals(a: string, b: string): number {
  const [aInt = '', aFrac = ''] = a.split('.');
  const [bInt = '', bFrac = ''] = b.split('.');
  const ai = aInt.replace(/^0+(?=\d)/, '');
  const bi = bInt.replace(/^0+(?=\d)/, '');
  if (ai.length !== bi.length) return ai.length - bi.length;
  const width = Math.max(aFrac.length, bFrac.length);
  return compareTickers(ai + aFrac.padEnd(width, '0'), bi + bFrac.padEnd(width, '0'));
}

export type DiscoveryBatchStatus = 'COMPLETE' | 'PARTIAL' | 'EMPTY';

export interface DiscoveryMember {
  rank: number;
  symbol: string;
  baseAsset: string;
  quoteVolume: string;
  windowOpenTime: number;
  windowCloseTime: number;
  category: DiscoveryCategory;
}

export interface DiscoveryResult {
  status: DiscoveryBatchStatus;
  coverage: {
    listed: number;
    usdtQuoted: number;
    malformed: number;
    notTrading: number;
    spotTradingNotAllowed: number;
    stablecoin: number;
    eligible: number;
    invalid: number;
    ranked: number;
    selected: number;
  };
  members: DiscoveryMember[];
  exclusions: { symbol: string; reason: Exclusion | TickerIssue }[];
}

/**
 * The shortlist: eligible pairs with a valid figure, by quote volume descending, then exact
 * symbol; the first 50. A pair without a valid figure is listed as excluded, never ranked or
 * replaced. PARTIAL means some eligible pair, or some instrument, could not be judged.
 */
export function selectCandidates(inputs: DiscoveryInputs): DiscoveryResult {
  const exclusions: DiscoveryResult['exclusions'] = [];
  const counts = { NOT_TRADING: 0, SPOT_TRADING_NOT_ALLOWED: 0, STABLECOIN_BASE: 0 };
  const eligible = new Map<string, DiscoveryInstrument>();
  for (const instrument of inputs.usdtInstruments) {
    const reason = exclusionOf(instrument);
    if (reason === null) eligible.set(instrument.symbol, instrument);
    else {
      counts[reason] += 1;
      exclusions.push({ symbol: instrument.symbol, reason });
    }
  }
  for (const { symbol, issue } of inputs.invalidTickers) exclusions.push({ symbol, reason: issue });
  const ranked = inputs.tickers
    .filter((ticker) => eligible.has(ticker.symbol))
    .sort(
      (a, b) => compareDecimals(b.quoteVolume, a.quoteVolume) || compareTickers(a.symbol, b.symbol),
    );
  const members = ranked.slice(0, DISCOVERY_MAX_MEMBERS).map((ticker, index) => {
    const baseAsset = eligible.get(ticker.symbol)?.baseAsset ?? '';
    return {
      rank: index + 1,
      symbol: ticker.symbol,
      baseAsset,
      quoteVolume: ticker.quoteVolume,
      windowOpenTime: ticker.openTime,
      windowCloseTime: ticker.closeTime,
      category: LABELLED_BASES[baseAsset] ?? 'unclassified',
    };
  });
  let status: DiscoveryBatchStatus = 'COMPLETE';
  if (inputs.invalidTickers.length > 0 || inputs.malformedInstruments > 0) status = 'PARTIAL';
  else if (eligible.size === 0) status = 'EMPTY';
  exclusions.sort((a, b) => compareTickers(a.symbol, b.symbol));
  return {
    status,
    coverage: {
      listed: inputs.listedSymbols,
      usdtQuoted: inputs.usdtInstruments.length,
      malformed: inputs.malformedInstruments,
      notTrading: counts.NOT_TRADING,
      spotTradingNotAllowed: counts.SPOT_TRADING_NOT_ALLOWED,
      stablecoin: counts.STABLECOIN_BASE,
      eligible: eligible.size,
      invalid: inputs.invalidTickers.length,
      ranked: ranked.length,
      selected: members.length,
    },
    members,
    exclusions,
  };
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export interface DiscoveryEvidence {
  schemaVersion: typeof DISCOVERY_SCHEMA_VERSION;
  policy: { id: string; sha256: string };
  slot: DiscoverySlot;
  collection: {
    exchangeInfo: { endpoint: string; requestedAt: string; receivedAt: string; serverTime: number };
    ticker: { endpoint: string; requestedAt: string; receivedAt: string };
    /** The ticker request: every window is judged against it. */
    cutoff: string;
  };
  inputs: DiscoveryInputs;
  result: DiscoveryResult;
}

export const evidenceSha256 = (evidence: unknown) => webSha256(stableSerialize(evidence));

/** A stored batch as the board reads it. */
export interface DiscoveryBatchRecord {
  policy_id: string;
  slot_date: string;
  collected_at: string;
  status: string;
  member_count: number;
  evidence: unknown;
  evidence_sha256: string;
}

export type DiscoveryVerification =
  { ok: true; evidence: DiscoveryEvidence } | { ok: false; reason: string };

/** Whether the inputs account for every eligible pair exactly once, and for nothing else. */
function inputsConsistent(inputs: DiscoveryInputs): boolean {
  const eligible = eligibleSymbols(inputs.usdtInstruments);
  const accounted = [
    ...inputs.tickers.map((ticker) => ticker.symbol),
    ...inputs.invalidTickers.map((entry) => entry.symbol),
  ].sort(compareTickers);
  return stableSerialize(accounted) === stableSerialize([...eligible].sort(compareTickers));
}

/**
 * A batch is shown only when its bytes match the recorded hash, it was recorded under this
 * policy's identity for its own slot, and its members, order and exclusions re-derive exactly
 * from its stored inputs. Anything else is refused with the reason, never repaired.
 */
export async function verifyDiscoveryBatch(
  record: DiscoveryBatchRecord,
): Promise<DiscoveryVerification> {
  const evidence = record.evidence as DiscoveryEvidence;
  if (!isRecord(evidence) || evidence.schemaVersion !== DISCOVERY_SCHEMA_VERSION) {
    return { ok: false, reason: 'Unknown evidence format' };
  }
  if ((await evidenceSha256(evidence)) !== record.evidence_sha256) {
    return { ok: false, reason: 'Stored evidence does not match its recorded SHA-256' };
  }
  if (
    record.policy_id !== DISCOVERY_POLICY_ID ||
    evidence.policy?.id !== DISCOVERY_POLICY_ID ||
    evidence.policy.sha256 !== (await discoveryPolicySha256())
  ) {
    return {
      ok: false,
      reason: `Recorded under another policy identity than ${DISCOVERY_POLICY_ID}`,
    };
  }
  try {
    if (stableSerialize(slotForDate(record.slot_date)) !== stableSerialize(evidence.slot)) {
      return { ok: false, reason: 'The slot in the evidence is not the batch date’s slot' };
    }
    if (!inputsConsistent(evidence.inputs)) {
      return { ok: false, reason: 'Inputs do not account for every eligible pair exactly once' };
    }
    const result = selectCandidates(evidence.inputs);
    if (stableSerialize(result) !== stableSerialize(evidence.result)) {
      return { ok: false, reason: 'Members do not re-derive from the stored inputs' };
    }
  } catch {
    return { ok: false, reason: 'Unreadable evidence' };
  }
  if (
    record.status !== evidence.result.status.toLowerCase() ||
    record.member_count !== evidence.result.members.length ||
    record.collected_at === '' ||
    Date.parse(record.collected_at) !== Date.parse(evidence.collection.ticker.receivedAt)
  ) {
    return { ok: false, reason: 'Batch columns disagree with its evidence' };
  }
  return { ok: true, evidence };
}

// ── Attempts and freshness ───────────────────────────────────────────────────

export type DiscoveryAttemptStatus =
  | 'complete'
  | 'partial'
  | 'empty'
  | 'already_collected'
  | 'unchanged'
  | 'conflict'
  | 'failed'
  | 'missed';

export type DiscoveryFailureCode =
  | 'RATE_LIMITED'
  | 'IP_BANNED'
  | 'REGION_BLOCKED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'RESPONSE_INVALID'
  | 'DEADLINE_PASSED'
  | 'STORE_ERROR';

/** Outcomes that leave the slot without a batch from this attempt. */
export const UNSUCCESSFUL_ATTEMPTS: ReadonlySet<DiscoveryAttemptStatus> = new Set([
  'conflict',
  'failed',
  'missed',
]);

/**
 * A batch is current from its slot until the next slot starts, 24 hours later. While the next
 * slot's collection window is open it is shown as yesterday's, awaiting today's or after a
 * failed attempt at it. From the next slot's retry deadline (29h30m after its own slot) it is
 * Stale. This is the daily feed's own bound, separate from candle freshness.
 */
export const DISCOVERY_STALE_AFTER_MS = DAY_MS + DEADLINE_OFFSET_MS - SLOT_OFFSET_MS;

export type DiscoveryFeedState = 'missing' | 'current' | 'awaiting' | 'attempt-failed' | 'stale';

export function discoveryFeedState(
  batchDate: string | null,
  latestAttempt: { slot_date: string; status: string } | null,
  now: number,
): DiscoveryFeedState {
  if (batchDate === null) return 'missing';
  const slot = Date.parse(slotForDate(batchDate).scheduledFor);
  if (now >= slot + DISCOVERY_STALE_AFTER_MS) return 'stale';
  if (now < slot + DAY_MS) return 'current';
  const failedNext =
    latestAttempt?.slot_date === nextDate(batchDate) &&
    UNSUCCESSFUL_ATTEMPTS.has(latestAttempt.status as DiscoveryAttemptStatus);
  return failedNext ? 'attempt-failed' : 'awaiting';
}
