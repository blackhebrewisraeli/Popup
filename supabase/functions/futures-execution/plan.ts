// Pure parts of the Futures flow (docs/FUTURES_EXECUTION.md): exact decimals, the owner's risk
// limits, Binance symbol rules, the immutable proposal plan, its hash and its Telegram text.
// No Deno global, network or clock: vitest covers it from src/test.
//
// Fixed in code, not configuration: Binance USDⓈ-M Futures, USDT perpetuals, Long only, isolated
// margin, 5× leverage, and the owner's 44 USDT total experiment budget.

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
  const value = dec(text.replace(/^-/, ''));
  return value === null ? null : text.startsWith('-') ? -value : value;
}

/** Plain decimal text without exponent or trailing zeros: what Binance accepts as a parameter. */
export function fmt(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(18, '0').replace(/0+$/, '');
  return `${sign}${abs / SCALE}${fraction ? `.${fraction}` : ''}`;
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
  const r = Object.fromEntries(
    Object.entries(rules).map(([k, v]) => [k, dec(v) as bigint]),
  ) as Record<keyof SymbolRules, bigint>;
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
  const lossOf = (qty: bigint) => mul(qty, lossPerUnit);
  const collateralOf = (qty: bigint) => mul(qty, entryLimit) / BigInt(LEVERAGE);

  const maxQty = least(r.maxQty, r.marketMaxQty);
  const smallest = ceilGrid(
    r.minQty > div(r.minNotional, entryLimit) ? r.minQty : div(r.minNotional, entryLimit),
    r.minQty,
    r.stepSize,
  );
  if (smallest > maxQty) return 'The smallest valid order is above the maximum quantity';
  if (lossOf(smallest) > lossRoom || collateralOf(smallest) > collateralRoom) {
    return (
      `Skipped: the smallest valid order (${fmt(smallest)}, ${fmt(mul(smallest, entryLimit))} USDT ` +
      `notional, ${fmt(collateralOf(smallest))} USDT collateral, ${fmt(lossOf(smallest))} USDT ` +
      `estimated loss) exceeds the limits (${fmt(lossRoom)} USDT loss, ${fmt(collateralRoom)} USDT ` +
      'collateral left)'
    );
  }
  const byLoss = div(lossRoom, lossPerUnit);
  const byCollateral = div(collateralRoom * BigInt(LEVERAGE), entryLimit);
  const quantity = floorGrid(least(least(byLoss, byCollateral), maxQty), r.minQty, r.stepSize);

  const distance = ask - stopTrigger;
  const targets: Target[] = [];
  for (const multiple of limits.takeProfitR) {
    const price = floorGrid(ask + mul(distance, multiple), r.minPrice, r.tickSize);
    if (r.maxPrice > 0n && price > r.maxPrice) return 'A take-profit target is above maxPrice';
    if (price <= entryLimit) return 'A take-profit target is not above the entry limit';
    targets.push({ r: fmt(multiple), price: fmt(price) });
  }
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
    collateral: fmt(collateralOf(quantity)),
    stopTrigger: fmt(stopTrigger),
    takerFeeRate: fmt(fee),
    estimatedLossAtStop: fmt(lossOf(quantity)),
    targets,
    budgetUsdt: fmt(EXPERIMENT_BUDGET_USDT),
    cumulativeLossBefore: fmt(cumulativeLoss),
    maxPriceMoveBps: limits.maxPriceMoveBps.toString(),
    riskLimitsSha256: input.limitsSha256,
    rules,
  };
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
    `Targets (reduce-only): ${plan.targets.map((t) => `${t.price} (${t.r}R)`).join(', ')}`,
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
