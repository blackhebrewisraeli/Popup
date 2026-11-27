// Pure parts of the Futures flow (docs/FUTURES_EXECUTION.md): exact decimals, the owner's risk
// limits, Binance symbol rules, the immutable proposal plan, its hash and its Telegram text.
// No Deno global, network or clock: vitest covers it from src/test.
//
// Fixed in code, not configuration: Binance USDⓈ-M Futures, USDT perpetuals, isolated margin, 5×
// leverage, and the owner's 44 USDT total experiment budget. The live flow proposes Long only
// (planLong); planOrder plans a caller's Long or Short as a local dry run that nothing sends.

import { stableSerialize } from '../_shared/stableSerialize.ts';
import { webSha256 } from '../_shared/webSha256.ts';

export const ENVIRONMENT = 'binance_usdm_futures';
export const LEVERAGE = 5;
export const RISK_ENV = 'FUTURES_RISK_LIMITS';

// Exact decimals as BigInt counts of 1e-18. Binance sends prices and quantities as decimal strings.
const SCALE = 10n ** 18n;
const DECIMAL = /^\d{1,20}(\.\d{1,18})?$/;

export function dec(text: unknown): bigint | null {
  if (typeof text !== 'string' || !DECIMAL.test(text)) return null;
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
}

/** dec() that also accepts a leading minus, as Binance income and position amounts carry. */
export function signedDec(text: unknown): bigint | null {
  if (typeof text !== 'string') return null;
  const negative = text.startsWith('-');
  const value = dec(negative ? text.slice(1) : text);
  if (value === null) return null;
  return negative ? -value : value;
}

/** Plain decimal text without exponent or trailing zeros: what Binance accepts as a parameter. */
export function fmt(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const digits = (abs % SCALE).toString().padStart(18, '0');
  let end = digits.length;
  while (end > 0 && digits[end - 1] === '0') end--;
  const whole = `${sign}${abs / SCALE}`;
  return end === 0 ? whole : `${whole}.${digits.slice(0, end)}`;
}

/** The owner's total experiment budget: collateral never exceeds what is left of it. */
export const EXPERIMENT_BUDGET_USDT = dec('44') as bigint;

const mul = (a: bigint, b: bigint) => (a * b) / SCALE;
const div = (a: bigint, b: bigint) => (a * SCALE) / b;
const bps = (n: bigint) => (n * SCALE) / 10_000n;
/** Down onto the filter grid `min + k·step` (Binance: (value − min) % step == 0). */
const floorGrid = (value: bigint, min: bigint, step: bigint) =>
  value < min ? min - step : min + ((value - min) / step) * step;
const ceilGrid = (value: bigint, min: bigint, step: bigint) =>
  value <= min ? min : min + ((value - min + step - 1n) / step) * step;
const least = (a: bigint, b: bigint) => (a < b ? a : b);
/** Initial margin at 5×: the collateral an order commits. */
const collateralOf = (qty: bigint, entry: bigint) => mul(qty, entry) / BigInt(LEVERAGE);

export interface RiskLimits {
  /** Contracts the owner allows, e.g. ["BTCUSDT"]. */
  symbols: string[];
  /** Cap on one trade's estimated loss at the stop, taker fees included. */
  maxLossPerTradeUsdt: bigint;
  /** Cap on the experiment's cumulative realized losses, within the 44 USDT budget. */
  maxCumulativeLossUsdt: bigint;
  /** Stop trigger distance below the reference ask, in percent. */
  stopDistancePercent: bigint;
  /** Take-profit targets as multiples of the stop distance, ascending. */
  takeProfitR: bigint[];
  /** The entry limit's allowance above the reference ask. */
  entrySlippageBps: bigint;
  /** On approval, how far the ask may have moved from the reference before the proposal is stale. */
  maxPriceMoveBps: bigint;
  proposalTtlSeconds: number;
}

const RISK_KEYS = [
  'symbols',
  'maxLossPerTradeUsdt',
  'maxCumulativeLossUsdt',
  'stopDistancePercent',
  'takeProfitR',
  'entrySlippageBps',
  'maxPriceMoveBps',
  'proposalTtlSeconds',
];
const SYMBOL = /^[A-Z0-9]{1,20}USDT$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const intIn = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * The owner's limits from one JSON secret. There are no defaults: unset, unknown keys or any value
 * out of bounds refuse every proposal and approval. `sha256` identifies the exact limits a
 * proposal was planned under, so a change between proposal and approval is detected.
 */
export async function parseRiskLimits(
  raw: string | undefined,
): Promise<{ limits: RiskLimits; sha256: string } | { error: string }> {
  if (!raw) return { error: `${RISK_ENV} is not set` };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: `${RISK_ENV} is not JSON` };
  }
  if (!isRecord(value)) return { error: `${RISK_ENV} must be an object` };
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const expected = [...RISK_KEYS].sort((a, b) => a.localeCompare(b));
  if (stableSerialize(keys) !== stableSerialize(expected)) {
    return { error: `${RISK_ENV} must have exactly: ${expected.join(', ')}` };
  }
  const { symbols, takeProfitR, entrySlippageBps, maxPriceMoveBps, proposalTtlSeconds } = value;
  const perTrade = dec(value['maxLossPerTradeUsdt']);
  const cumulative = dec(value['maxCumulativeLossUsdt']);
  const stopDistancePercent = dec(value['stopDistancePercent']);
  const targets = Array.isArray(takeProfitR) ? takeProfitR.map(dec) : [];
  const invalid = [
    !Array.isArray(symbols) ||
    symbols.length === 0 ||
    symbols.length > 5 ||
    !symbols.every((s) => typeof s === 'string' && SYMBOL.test(s))
      ? 'symbols'
      : '',
    !perTrade || perTrade <= 0n || (cumulative !== null && perTrade > cumulative)
      ? 'maxLossPerTradeUsdt'
      : '',
    !cumulative || cumulative <= 0n || cumulative > EXPERIMENT_BUDGET_USDT
      ? 'maxCumulativeLossUsdt'
      : '',
    !stopDistancePercent || stopDistancePercent < SCALE / 10n || stopDistancePercent > 20n * SCALE
      ? 'stopDistancePercent'
      : '',
    targets.length === 0 ||
    targets.length > 3 ||
    targets.some((r, i) => !r || r <= 0n || (i > 0 && r <= (targets[i - 1] as bigint)))
      ? 'takeProfitR'
      : '',
    intIn(entrySlippageBps, 0, 100) ? '' : 'entrySlippageBps',
    intIn(maxPriceMoveBps, 1, 500) ? '' : 'maxPriceMoveBps',
    intIn(proposalTtlSeconds, 60, 1800) ? '' : 'proposalTtlSeconds',
  ].filter(Boolean);
  if (invalid.length > 0) return { error: `${RISK_ENV} has invalid ${invalid.join(', ')}` };
  return {
    limits: {
      symbols: symbols as string[],
      maxLossPerTradeUsdt: perTrade as bigint,
      maxCumulativeLossUsdt: cumulative as bigint,
      stopDistancePercent: stopDistancePercent as bigint,
      takeProfitR: targets as bigint[],
      entrySlippageBps: BigInt(entrySlippageBps as number),
      maxPriceMoveBps: BigInt(maxPriceMoveBps as number),
      proposalTtlSeconds: proposalTtlSeconds as number,
    },
    sha256: await webSha256(stableSerialize(value)),
  };
}

/** The exchangeInfo filters a plan needs, as decimal strings so they can be stored and re-read. */
export interface SymbolRules {
  tickSize: string;
  minPrice: string;
  maxPrice: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  marketMaxQty: string;
  minNotional: string;
  percentUp: string;
}

/** One TRADING USDT-margined perpetual's filters from GET /fapi/v1/exchangeInfo, or why not. */
export function parseSymbolRules(body: unknown, symbol: string): SymbolRules | string {
  const symbols = isRecord(body) && Array.isArray(body['symbols']) ? body['symbols'] : [];
  const entry = symbols.find((s: unknown) => isRecord(s) && s['symbol'] === symbol) as
    Record<string, unknown> | undefined;
  if (!entry) return `${symbol} is not listed on Binance USDⓈ-M Futures`;
  if (entry['status'] !== 'TRADING') return `${symbol} is not TRADING`;
  if (entry['contractType'] !== 'PERPETUAL') return `${symbol} is not a perpetual`;
  if (entry['quoteAsset'] !== 'USDT' || entry['marginAsset'] !== 'USDT') {
    return `${symbol} is not USDT-margined`;
  }
  const filters = Array.isArray(entry['filters']) ? (entry['filters'] as unknown[]) : [];
  const filter = (type: string) =>
    (filters.find((f) => isRecord(f) && f['filterType'] === type) ?? {}) as Record<string, unknown>;
  const price = filter('PRICE_FILTER');
  const lot = filter('LOT_SIZE');
  const rules = {
    tickSize: price['tickSize'],
    minPrice: price['minPrice'],
    maxPrice: price['maxPrice'],
    stepSize: lot['stepSize'],
    minQty: lot['minQty'],
    maxQty: lot['maxQty'],
    marketMaxQty: filter('MARKET_LOT_SIZE')['maxQty'],
    minNotional: filter('MIN_NOTIONAL')['notional'],
    percentUp: filter('PERCENT_PRICE')['multiplierUp'],
  };
  const bad = Object.entries(rules)
    .filter(([, v]) => dec(v) === null)
    .map(([k]) => k);
  if (bad.length > 0) return `${symbol} filters unreadable: ${bad.join(', ')}`;
  if ((dec(rules.tickSize) as bigint) <= 0n || (dec(rules.stepSize) as bigint) <= 0n) {
    return `${symbol} has a zero tick or step size`;
  }
  return rules as SymbolRules;
}

export interface Target {
  r: string;
  price: string;
}

/** Everything the owner approves. Stored as JSON and hashed; never changed after the proposal. */
export interface Plan {
  environment: typeof ENVIRONMENT;
  symbol: string;
  side: 'LONG';
  leverage: typeof LEVERAGE;
  marginType: 'ISOLATED';
  rule: string;
  signalReason: string;
  expiresAt: string;
  referenceAsk: string;
  markPrice: string;
  entryLimit: string;
  quantity: string;
  notional: string;
  /** Initial margin at 5×: the collateral this trade commits. */
  collateral: string;
  stopTrigger: string;
  takerFeeRate: string;
  /** If the stop fills at its trigger: price loss plus taker fees on entry and exit. */
  estimatedLossAtStop: string;
  targets: Target[];
  budgetUsdt: string;
  cumulativeLossBefore: string;
  maxPriceMoveBps: string;
  riskLimitsSha256: string;
  rules: SymbolRules;
}

export interface Candidate {
  symbol: string;
  rule: string;
  signalReason: string;
}

/** The symbol's filters as exact decimals (parseSymbolRules guarantees each is readable). */
type Grid = Record<keyof SymbolRules, bigint>;
function grid(rules: SymbolRules): Grid {
  return Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, dec(v) as bigint])) as Grid;
}

/**
 * The largest quantity on the lot grid, at most the market lot maximum (the stop closes at market),
 * whose loss at the stop stays within `lossRoom` and whose collateral (initial margin, plus the
 * `entryFee` rate on the notional when the caller reserves it) stays within `collateralRoom`.
 * A null `lossRoom` leaves the loss out of the sizing; the caller checks it afterwards.
 * If even the smallest order Binance accepts (minQty, MIN_NOTIONAL, step) breaks a room: skipped.
 */
function sizeWithin(o: {
  entry: bigint;
  lossPerUnit: bigint;
  lossRoom: bigint | null;
  collateralRoom: bigint;
  r: Grid;
  entryFee?: bigint;
}): bigint | string {
  const { entry, lossPerUnit, lossRoom, collateralRoom, r, entryFee = 0n } = o;
  const lossOf = (qty: bigint) => mul(qty, lossPerUnit);
  const committed = (qty: bigint) => collateralOf(qty, entry) + mul(mul(qty, entry), entryFee);
  const maxQty = least(r.maxQty, r.marketMaxQty);
  const smallest = ceilGrid(
    r.minQty > div(r.minNotional, entry) ? r.minQty : div(r.minNotional, entry),
    r.minQty,
    r.stepSize,
  );
  if (smallest > maxQty) return 'The smallest valid order is above the maximum quantity';
  if ((lossRoom !== null && lossOf(smallest) > lossRoom) || committed(smallest) > collateralRoom) {
    const room = lossRoom === null ? '' : `${fmt(lossRoom)} USDT loss, `;
    return (
      `Skipped: the smallest valid order (${fmt(smallest)}, ${fmt(mul(smallest, entry))} USDT ` +
      `notional, ${fmt(collateralOf(smallest, entry))} USDT collateral, ${fmt(lossOf(smallest))} USDT ` +
      `estimated loss) exceeds the limits (${room}${fmt(collateralRoom)} USDT collateral left)`
    );
  }
  const byCollateral = div(
    collateralRoom * BigInt(LEVERAGE),
    entry + mul(entry, entryFee) * BigInt(LEVERAGE),
  );
  const cap = lossRoom === null ? byCollateral : least(div(lossRoom, lossPerUnit), byCollateral);
  return floorGrid(least(cap, maxQty), r.minQty, r.stepSize);
}

/**
 * Size one Long from the reference ask: a limit-IOC entry at most `entrySlippageBps` above it, a
 * stop `stopDistancePercent` below it, and the largest quantity on the lot grid such that
 *   - the loss at the stop from the worst entry price, plus taker fees both ways, stays within the
 *     per-trade cap and within what is left of the cumulative cap, and
 *   - the collateral (notional ÷ 5) stays within what is left of the 44 USDT budget.
 * If even the smallest order Binance accepts breaks one of those, the trade is skipped.
 */
export function planLong(input: {
  candidate: Candidate;
  limits: RiskLimits;
  limitsSha256: string;
  rules: SymbolRules;
  ask: string;
  mark: string;
  takerFeeRate: string;
  cumulativeLoss: bigint;
  expiresAt: string;
}): Plan | string {
  const { candidate, limits, rules, cumulativeLoss } = input;
  if (!limits.symbols.includes(candidate.symbol)) {
    return `${candidate.symbol} is not in the owner's allowed symbols`;
  }
  const ask = dec(input.ask);
  const mark = dec(input.mark);
  const fee = dec(input.takerFeeRate);
  if (!ask || !mark || fee === null) return 'The ask, mark price or fee rate is unreadable';
  const r = grid(rules);
  const lossRoom = least(limits.maxLossPerTradeUsdt, limits.maxCumulativeLossUsdt - cumulativeLoss);
  const collateralRoom = EXPERIMENT_BUDGET_USDT - cumulativeLoss;
  if (lossRoom <= 0n) return `The cumulative loss limit is reached (${fmt(cumulativeLoss)} USDT)`;

  const entryLimit = floorGrid(
    mul(ask, SCALE + bps(limits.entrySlippageBps)),
    r.minPrice,
    r.tickSize,
  );
  if (entryLimit < ask) return 'The entry limit rounds below the ask';
  if (r.maxPrice > 0n && entryLimit > r.maxPrice) return 'The entry limit is above maxPrice';
  if (entryLimit > mul(mark, r.percentUp)) return 'The entry limit breaks PERCENT_PRICE';
  const stopTrigger = floorGrid(
    ask - mul(ask, limits.stopDistancePercent / 100n),
    r.minPrice,
    r.tickSize,
  );
  if (stopTrigger <= 0n || stopTrigger < r.minPrice) return 'The stop trigger is below minPrice';
  const lossPerUnit = entryLimit - stopTrigger + mul(entryLimit + stopTrigger, fee);
  const quantity = sizeWithin({ entry: entryLimit, lossPerUnit, lossRoom, collateralRoom, r });
  if (typeof quantity === 'string') return quantity;

  const targets = targetPrices(limits.takeProfitR, ask, stopTrigger, entryLimit, r);
  if (typeof targets === 'string') return targets;
  return {
    environment: ENVIRONMENT,
    symbol: candidate.symbol,
    side: 'LONG',
    leverage: LEVERAGE,
    marginType: 'ISOLATED',
    rule: candidate.rule,
    signalReason: candidate.signalReason,
    expiresAt: input.expiresAt,
    referenceAsk: fmt(ask),
    markPrice: fmt(mark),
    entryLimit: fmt(entryLimit),
    quantity: fmt(quantity),
    notional: fmt(mul(quantity, entryLimit)),
    collateral: fmt(collateralOf(quantity, entryLimit)),
    stopTrigger: fmt(stopTrigger),
    takerFeeRate: fmt(fee),
    estimatedLossAtStop: fmt(mul(quantity, lossPerUnit)),
    targets,
    budgetUsdt: fmt(EXPERIMENT_BUDGET_USDT),
    cumulativeLossBefore: fmt(cumulativeLoss),
    maxPriceMoveBps: limits.maxPriceMoveBps.toString(),
    riskLimitsSha256: input.limitsSha256,
    rules,
  };
}

/** Each R multiple of the stop distance above the ask, on the tick grid and above the entry limit. */
function targetPrices(
  multiples: bigint[],
  ask: bigint,
  stopTrigger: bigint,
  entryLimit: bigint,
  r: Grid,
): Target[] | string {
  const targets: Target[] = [];
  for (const multiple of multiples) {
    const price = floorGrid(ask + mul(ask - stopTrigger, multiple), r.minPrice, r.tickSize);
    if (r.maxPrice > 0n && price > r.maxPrice) return 'A take-profit target is above maxPrice';
    if (price <= entryLimit) return 'A take-profit target is not above the entry limit';
    targets.push({ r: fmt(multiple), price: fmt(price) });
  }
  return targets;
}

export type Side = 'LONG' | 'SHORT';
/** Binance workingType: the mark price, or the contract's last price. */
export type TriggerPriceType = 'MARK_PRICE' | 'CONTRACT_PRICE';
/** 'risk': the largest size within the loss limits. 'maxCollateral': all collateral available. */
export type Sizing = 'risk' | 'maxCollateral';

/**
 * A caller's setup with its own prices. The entry is a stop-limit: when the trigger price crosses
 * `entryTrigger` (≥ for a LONG, ≤ for a SHORT) a limit order at `entryLimit` is placed.
 * `stopLoss` and `takeProfit` are the protective exit triggers.
 */
export interface OrderCandidate {
  symbol: string;
  side: Side;
  entryTrigger: string;
  entryTriggerPriceType: TriggerPriceType;
  entryLimit: string;
  stopLoss: string;
  takeProfit: string;
}

/** A dry-run Long or Short plan for local review. Never stored, hashed, sent or placed. */
export interface OrderPlan {
  environment: typeof ENVIRONMENT;
  symbol: string;
  side: Side;
  leverage: typeof LEVERAGE;
  marginType: 'ISOLATED';
  sizing: Sizing;
  entryTrigger: string;
  entryTriggerPriceType: TriggerPriceType;
  /** The worst price the entry can fill at; size, notional and loss are computed from it. */
  entryLimit: string;
  takeProfit: string;
  stopLoss: string;
  quantity: string;
  notional: string;
  /** Initial margin at 5×, before fees. Sizing also reserves the entry fee beside it. */
  collateral: string;
  takerFeeRate: string;
  stopSlippageBps: string;
  /** Where the loss estimate assumes the stop fills: slipped, then onto the tick grid against us. */
  modeledStopFill: string;
  /** Taker fees on the entry and on the stop exit. */
  estimatedFeesAtStop: string;
  /** A planned estimate: gaps, wider slippage and funding can exceed it. */
  estimatedLossAtStop: string;
  /** The lesser of the per-trade cap and what is left of the cumulative cap. */
  maxLossUsdt: string;
  /** The lesser of the available collateral and what is left of the 44 USDT budget. */
  collateralRoom: string;
  cumulativeLossBefore: string;
  budgetUsdt: string;
  rules: SymbolRules;
}

const PRICE_NAMES = {
  entryTrigger: 'entry trigger',
  entryLimit: 'entry limit',
  stopLoss: 'stop loss',
  takeProfit: 'take profit',
} as const;

/**
 * Plan one Long or Short from a candidate's own prices, sized from the entry limit:
 *   - every price on the tick grid within the price filter, in side order:
 *     LONG  stop loss < entry trigger ≤ entry limit < take profit,
 *     SHORT take profit < entry limit ≤ entry trigger < stop loss;
 *   - loss per unit = the move from the entry limit to the modeled stop fill, plus the taker fee
 *     on both fills; the modeled fill is `stopSlippageBps` past the stop, rounded onto the tick
 *     grid away from the trader (fills only happen on the grid);
 *   - 'risk' sizing takes the largest lot-grid quantity whose loss fits the lesser of the per-trade
 *     cap and what is left of the cumulative cap, and whose initial margin plus entry fee fits
 *     the lesser of the available collateral and what is left of the 44 USDT budget;
 *   - 'maxCollateral' sizing fills that collateral room and is refused, with its size and loss,
 *     when that loss breaks the loss limits.
 * PERCENT_PRICE is not checked: it depends on the mark price when the trigger fires.
 */
export function planOrder(input: {
  candidate: OrderCandidate;
  limits: Pick<RiskLimits, 'symbols' | 'maxLossPerTradeUsdt' | 'maxCumulativeLossUsdt'>;
  rules: SymbolRules;
  takerFeeRate: string;
  stopSlippageBps: number;
  availableCollateral: string;
  cumulativeLoss: bigint;
  sizing?: Sizing;
}): OrderPlan | string {
  const { candidate: c, limits, rules, cumulativeLoss, sizing = 'risk' } = input;
  if (!limits.symbols.includes(c.symbol)) {
    return `${c.symbol} is not in the owner's allowed symbols`;
  }
  if (c.side !== 'LONG' && c.side !== 'SHORT') return 'The side must be LONG or SHORT';
  if (c.entryTriggerPriceType !== 'MARK_PRICE' && c.entryTriggerPriceType !== 'CONTRACT_PRICE') {
    return 'The entry trigger price type must be MARK_PRICE or CONTRACT_PRICE';
  }
  if (sizing !== 'risk' && sizing !== 'maxCollateral')
    return 'The sizing must be risk or maxCollateral';
  const fee = dec(input.takerFeeRate);
  const available = dec(input.availableCollateral);
  if (fee === null || available === null || !intIn(input.stopSlippageBps, 0, 500)) {
    return 'The fee rate, stop slippage or available collateral is unreadable';
  }
  const r = grid(rules);
  const price = {} as Record<keyof typeof PRICE_NAMES, bigint>;
  for (const [key, name] of Object.entries(PRICE_NAMES) as [keyof typeof PRICE_NAMES, string][]) {
    const value = dec(c[key]);
    if (
      !value ||
      value < r.minPrice ||
      (r.maxPrice > 0n && value > r.maxPrice) ||
      (value - r.minPrice) % r.tickSize !== 0n
    ) {
      return `The ${name} ${String(c[key])} is not a price on the ${fmt(r.tickSize)} tick grid within the price filter`;
    }
    price[key] = value;
  }
  const { entryTrigger: trigger, entryLimit: limit, stopLoss: stop, takeProfit: target } = price;
  const short = c.side === 'SHORT';
  if (short && !(target < limit && limit <= trigger && trigger < stop)) {
    return 'A SHORT needs take profit < entry limit ≤ entry trigger < stop loss';
  }
  if (!short && !(stop < trigger && trigger <= limit && limit < target)) {
    return 'A LONG needs stop loss < entry trigger ≤ entry limit < take profit';
  }
  const slip = bps(BigInt(input.stopSlippageBps));
  const stopFill = short
    ? ceilGrid(mul(stop, SCALE + slip), r.minPrice, r.tickSize)
    : floorGrid(mul(stop, SCALE - slip), r.minPrice, r.tickSize);
  if (stopFill < r.minPrice) return 'The modeled stop fill is below minPrice';
  const lossPerUnit = (short ? stopFill - limit : limit - stopFill) + mul(limit + stopFill, fee);

  const lossRoom = least(limits.maxLossPerTradeUsdt, limits.maxCumulativeLossUsdt - cumulativeLoss);
  if (lossRoom <= 0n) return `The cumulative loss limit is reached (${fmt(cumulativeLoss)} USDT)`;
  const collateralRoom = least(available, EXPERIMENT_BUDGET_USDT - cumulativeLoss);
  const quantity = sizeWithin({
    entry: limit,
    lossPerUnit,
    lossRoom: sizing === 'risk' ? lossRoom : null,
    collateralRoom,
    r,
    entryFee: fee,
  });
  if (typeof quantity === 'string') return quantity;
  const notional = mul(quantity, limit);
  const loss = mul(quantity, lossPerUnit);
  if (loss > lossRoom) {
    return (
      `Refused: maximum-collateral sizing gives ${fmt(quantity)} ${c.symbol.replace(/USDT$/, '')} ` +
      `(${fmt(notional)} USDT notional, ${fmt(collateralOf(quantity, limit))} USDT collateral) ` +
      `with ${fmt(loss)} USDT estimated loss at the stop, above the ${fmt(lossRoom)} USDT loss limit`
    );
  }
  return {
    environment: ENVIRONMENT,
    symbol: c.symbol,
    side: c.side,
    leverage: LEVERAGE,
    marginType: 'ISOLATED',
    sizing,
    entryTrigger: fmt(trigger),
    entryTriggerPriceType: c.entryTriggerPriceType,
    entryLimit: fmt(limit),
    takeProfit: fmt(target),
    stopLoss: fmt(stop),
    quantity: fmt(quantity),
    notional: fmt(notional),
    collateral: fmt(collateralOf(quantity, limit)),
    takerFeeRate: fmt(fee),
    stopSlippageBps: String(input.stopSlippageBps),
    modeledStopFill: fmt(stopFill),
    estimatedFeesAtStop: fmt(mul(quantity, mul(limit + stopFill, fee))),
    estimatedLossAtStop: fmt(loss),
    maxLossUsdt: fmt(lossRoom),
    collateralRoom: fmt(collateralRoom),
    cumulativeLossBefore: fmt(cumulativeLoss),
    budgetUsdt: fmt(EXPERIMENT_BUDGET_USDT),
    rules,
  };
}

const TRIGGER_LABEL: Record<TriggerPriceType, string> = {
  MARK_PRICE: 'Mark Price',
  CONTRACT_PRICE: 'Last Price',
};

/** The dry-run plan as plain text for the owner's review. Nothing is sent. */
export function orderPlanText(plan: OrderPlan): string {
  const short = plan.side === 'SHORT';
  return [
    'DRY RUN · Binance USDⓈ-M Futures order plan · not sent',
    '',
    `Contract: ${plan.symbol} perpetual · ${plan.side} · isolated · ${plan.leverage}× · ` +
      (plan.sizing === 'risk' ? 'risk-sized' : 'maximum collateral'),
    `Entry trigger: ${TRIGGER_LABEL[plan.entryTriggerPriceType]} ${short ? '<=' : '>='} ${plan.entryTrigger}`,
    `Entry limit: ${short ? 'sell' : 'buy'} at ${plan.entryLimit} (the worst entry price; sizing uses it)`,
    `Size: ${plan.quantity} ${plan.symbol.replace(/USDT$/, '')} · notional ${plan.notional} USDT`,
    `Collateral: ${plan.collateral} USDT initial margin (before fees)`,
    `Exits: take profit ${plan.takeProfit} · stop loss ${plan.stopLoss}`,
    `Planned loss at stop: ${plan.estimatedLossAtStop} USDT if the stop fills at ${plan.modeledStopFill} ` +
      `(${plan.stopSlippageBps} bps slippage, on the tick grid), taker fees ${plan.estimatedFeesAtStop} USDT ` +
      `(${plan.takerFeeRate} per fill) included`,
    `Limits: loss ${plan.maxLossUsdt} USDT · collateral ${plan.collateralRoom} USDT · ` +
      `cumulative loss ${plan.cumulativeLossBefore} USDT before this trade · budget ${plan.budgetUsdt} USDT`,
    'Actual execution can lose more: gaps past the stop, wider slippage and funding are not capped.',
  ].join('\n');
}

/** The proposal's identity: its id and every approved term. */
export const planSha256 = (id: string, plan: Plan) => webSha256(stableSerialize({ id, plan }));

/** Why the approval no longer matches the proposal's market, or null when it still does. */
export function priceDrift(plan: Plan, currentAsk: string): string | null {
  const ask = dec(currentAsk);
  const reference = dec(plan.referenceAsk) as bigint;
  const limit = dec(plan.entryLimit) as bigint;
  if (!ask) return 'The current ask is unreadable';
  if (ask > limit) return `The ask ${fmt(ask)} is above the approved limit ${plan.entryLimit}`;
  const moved = ((ask > reference ? ask - reference : reference - ask) * 10_000n) / reference;
  if (moved > BigInt(plan.maxPriceMoveBps)) {
    return `The ask moved ${moved} bps from ${plan.referenceAsk} (limit ${plan.maxPriceMoveBps} bps)`;
  }
  return null;
}

/** Why the risk limits no longer allow this plan given the cumulative loss now, or null. */
export function riskDrift(plan: Plan, limits: RiskLimits, cumulativeLoss: bigint): string | null {
  const lossRoom = least(limits.maxLossPerTradeUsdt, limits.maxCumulativeLossUsdt - cumulativeLoss);
  if ((dec(plan.estimatedLossAtStop) as bigint) > lossRoom) {
    return `The estimated loss ${plan.estimatedLossAtStop} USDT exceeds the ${fmt(lossRoom)} USDT left`;
  }
  if ((dec(plan.collateral) as bigint) > EXPERIMENT_BUDGET_USDT - cumulativeLoss) {
    return `The collateral ${plan.collateral} USDT exceeds what is left of the budget`;
  }
  return null;
}

/**
 * Take-profit quantities for what actually filled: equal slices on the lot grid, the last taking
 * the remainder. Targets whose slice would fall below minQty are dropped from the far end; the
 * stop always closes the whole position whatever the targets cover.
 */
export function targetQuantities(
  filled: string,
  plan: Plan,
): { price: string; quantity: string }[] {
  const qty = dec(filled) as bigint;
  const step = dec(plan.rules.stepSize) as bigint;
  const min = dec(plan.rules.minQty) as bigint;
  for (let count = plan.targets.length; count > 0; count--) {
    const slice = (qty / BigInt(count) / step) * step;
    if (slice < min) continue;
    return plan.targets.slice(0, count).map((target, i) => ({
      price: target.price,
      quantity: fmt(i === count - 1 ? qty - slice * BigInt(count - 1) : slice),
    }));
  }
  return [];
}

const targetLabel = (t: Target) => `${t.price} (${t.r}R)`;
const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** The private Telegram proposal: every term the owner approves, in plain text. */
export function proposalText(id: string, sha256: string, plan: Plan): string {
  const base = plan.symbol.replace(/USDT$/, '');
  return [
    `LIVE Binance USDⓈ-M Futures proposal · rule ${plan.rule}`,
    '',
    `Contract: ${plan.symbol} perpetual · LONG · isolated · ${plan.leverage}×`,
    `Signal: ${plan.signalReason}`,
    `Entry bound: limit buy, immediate-or-cancel, at most ${plan.entryLimit} (ask ${plan.referenceAsk})`,
    `Size: ${plan.quantity} ${base} · notional ≤ ${plan.notional} USDT`,
    `Collateral: ${plan.collateral} USDT (isolated margin)`,
    `Stop trigger: ${plan.stopTrigger} (mark price; closes the whole position)`,
    `Estimated loss at stop: ${plan.estimatedLossAtStop} USDT (taker fees included; funding and slippage excluded)`,
    `Targets (reduce-only): ${plan.targets.map(targetLabel).join(', ')}`,
    `Experiment: cumulative loss ${plan.cumulativeLossBefore} USDT before this trade · budget ${plan.budgetUsdt} USDT`,
    `On approval: refused if the ask moved more than ${plan.maxPriceMoveBps} bps or limits changed`,
    `Expires: ${utc(plan.expiresAt)}`,
    `Proposal ${id.slice(0, 8)} · ${sha256.slice(0, 8)}`,
  ].join('\n');
}

/** callback_data stays within Telegram's 64 bytes: action, proposal id, first 8 hash characters. */
export const callbackData = (action: 'a' | 'r', id: string, sha256: string) =>
  `${action}:${id}:${sha256.slice(0, 8)}`;

export function parseCallbackData(
  data: unknown,
): { action: 'approve' | 'reject'; id: string; sha8: string } | null {
  const match =
    typeof data === 'string' ? /^([ar]):([0-9a-f-]{36}):([0-9a-f]{8})$/.exec(data) : null;
  if (!match) return null;
  return {
    action: match[1] === 'a' ? 'approve' : 'reject',
    id: match[2] as string,
    sha8: match[3] as string,
  };
}
