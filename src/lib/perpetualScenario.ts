/**
 * An offline scenario for one isolated, USDT-margined, linear perpetual LONG
 * (docs/LEVERAGE_SIMULATION.md). Pure arithmetic on owner-typed numbers: no market data,
 * no defaults, no account settings, no Binance request, and nothing here is an order or a
 * Binance-verified liquidation price.
 *
 * Amounts and prices are exact counts of 1e-8 (BigInt), rates are counts of 1e-6 (a percent
 * typed to 4 decimals), so every USDT figure is exact at 1e-22. No floating point.
 */

import { MAX_AMOUNT, parseDecimal } from '@/lib/spotScenario';

export type PerpetualField =
  | 'collateral'
  | 'size'
  | 'entry'
  | 'exit'
  | 'stopTrigger'
  | 'entryFeePercent'
  | 'exitFeePercent'
  | 'carryingCost'
  | 'maintenanceRatePercent'
  | 'maintenanceAmount'
  | 'bracketFloor'
  | 'bracketCap';

export type PerpetualInputs = Readonly<Record<PerpetualField, string>> & {
  /** Which number `size` is: a target notional in USDT, or a leverage multiple of collateral. */
  readonly sizing: 'notional' | 'leverage';
};

export const EMPTY_PERPETUAL: PerpetualInputs = {
  collateral: '',
  sizing: 'notional',
  size: '',
  entry: '',
  exit: '',
  stopTrigger: '',
  entryFeePercent: '',
  exitFeePercent: '',
  carryingCost: '',
  maintenanceRatePercent: '',
  maintenanceAmount: '',
  bracketFloor: '',
  bracketCap: '',
};

/** Disclosed with every stop or exit comparison against a liquidation reference. */
export const SHARED_PRICE_NOTE =
  'Compared on one shared price. Binance triggers liquidation on the mark price; a stop may ' +
  'trigger on the last (contract) price or the mark price, and a fill can be far from either.';

type Side = 'above_reference' | 'at_or_below_reference';

export type LiquidationReference =
  | {
      status: 'reference';
      /** C′: the collateral this reference starts from, before the price move. */
      collateralBeforeMove: string;
      /** P*, rounded up to 1e-8: for a long, up is reached sooner. */
      price: string;
      /** P* exactly, as a reduced fraction. */
      exact: { numerator: string; denominator: string };
      /** Q × P*, rounded up to 1e-8. The bracket check uses the exact value. */
      notionalAtReference: string;
      exitFill: Side;
      stopTrigger: Side | null;
      note: string;
    }
  | {
      status: 'collateral_exhausted' | 'no_positive_solution' | 'not_below_entry';
      collateralBeforeMove: string;
    }
  | { status: 'bracket_mismatch'; collateralBeforeMove: string; notionalAtReference: string };

export interface PerpetualScenario {
  /** Base units, floored to 1e-8. */
  quantity: string;
  /** As entered, or collateral × leverage. */
  targetNotional: string;
  /** Quantity × entry: at most the target, because quantity is floored. */
  entryNotional: string;
  exitNotional: string;
  fees: { entry: string; exit: string; total: string };
  /** Signed as entered: positive was paid, negative was received. */
  carryingCost: string;
  /** Quantity × (exit fill − entry), signed. */
  priceMove: string;
  /** Collateral + price move − fees − carrying cost. Not clamped: can be zero or negative. */
  equityAtExit: string;
  /** Equity at exit − collateral, signed. Can exceed the collateral. */
  netResult: string;
  /** Net result ÷ collateral × 100, half away from zero to 4 decimals. */
  collateralChangePercent: string;
  /** Equity at exit is zero or below. The model says nothing about what Binance would do. */
  collateralExhausted: boolean;
  /** The result uses the fill price; a stop trigger is only reported beside it. */
  exitFill: { price: string; stopTrigger: string | null; priceMinusTrigger: string | null };
  liquidation: { zeroCost: LiquidationReference; afterCosts: LiquidationReference };
}

export type PerpetualErrors = Partial<Record<PerpetualField | 'form', string>>;

export type PerpetualCheck =
  | { ok: true; scenario: PerpetualScenario }
  | { ok: false; missing: PerpetualField[]; errors: PerpetualErrors };

const DECIMALS = 8;
const RATE_DECIMALS = 4;
/** 100% as a count of 1e-6 (a percent with 4 decimals). */
const RATE_ONE = 10n ** 6n;
const E6 = 10n ** 6n;
const E8 = 10n ** 8n;
const E14 = 10n ** 14n;
/** Every USDT figure is exact here: quantity (1e-8) × price (1e-8) × rate (1e-6). */
const USDT_DIGITS = 22;
const MAX_UNITS = BigInt(MAX_AMOUNT) * E8;

const SIGNED_FORMAT_ERROR =
  'Enter a plain decimal such as 0.5 or -0.5: digits, one decimal point and an optional leading minus.';

/** n / 10^digits exactly, trailing zeros trimmed, no grouping: "-2.154", "0". */
function formatScaled(n: bigint, digits: number): string {
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const unit = 10n ** BigInt(digits);
  const padded = (abs % unit).toString().padStart(digits, '0');
  let end = padded.length;
  while (end > 0 && padded[end - 1] === '0') end -= 1;
  const whole = `${sign}${abs / unit}`;
  return end === 0 ? whole : `${whole}.${padded.slice(0, end)}`;
}

const usdt = (scaled: bigint) => formatScaled(scaled, USDT_DIGITS);
const units = (scaled: bigint) => formatScaled(scaled, DECIMALS);

/** ⌈n / d⌉ for n ≥ 0, d > 0. */
const ceilDiv = (n: bigint, d: bigint) => (n + d - 1n) / d;

/** n / d rounded half away from zero, d > 0. */
function roundHalfAway(n: bigint, d: bigint): bigint {
  const abs = n < 0n ? -n : n;
  const q = (abs + d / 2n) / d;
  return n < 0n ? -q : q;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Parses every input; on any problem, returns the problems and no number. */
function parse(inputs: PerpetualInputs) {
  const missing: PerpetualField[] = [];
  const errors: PerpetualErrors = {};
  const reject = (field: PerpetualField, message: string) => {
    errors[field] = message;
    return undefined;
  };

  const amount = (field: PerpetualField, positive: boolean, optional = false) => {
    const parsed = parseDecimal(inputs[field], DECIMALS);
    if (parsed === null) {
      if (!optional) missing.push(field);
      return undefined;
    }
    if (typeof parsed === 'string') return reject(field, parsed);
    if (positive && parsed === 0n) return reject(field, 'Must be greater than 0.');
    if (parsed > MAX_UNITS) {
      return reject(
        field,
        `Above ${MAX_AMOUNT.toLocaleString('en-US')} is outside this model's range.`,
      );
    }
    return parsed;
  };

  const rate = (field: PerpetualField) => {
    const parsed = parseDecimal(inputs[field], RATE_DECIMALS);
    if (parsed === null) {
      missing.push(field);
      return undefined;
    }
    if (typeof parsed === 'string') return reject(field, parsed);
    if (parsed >= RATE_ONE) return reject(field, 'Must be below 100%.');
    return parsed;
  };

  const signed = (field: PerpetualField) => {
    const text = inputs[field].trim();
    const negative = text.startsWith('-');
    const body = negative ? text.slice(1) : text;
    if (negative && (body.startsWith('-') || body.startsWith('+'))) {
      return reject(field, SIGNED_FORMAT_ERROR);
    }
    const parsed = parseDecimal(body, DECIMALS);
    if (parsed === null && !negative) {
      missing.push(field);
      return undefined;
    }
    if (parsed === null || typeof parsed === 'string') return reject(field, SIGNED_FORMAT_ERROR);
    if (parsed > MAX_UNITS) {
      return reject(
        field,
        `Beyond ±${MAX_AMOUNT.toLocaleString('en-US')} is outside this model's range.`,
      );
    }
    return negative ? -parsed : parsed;
  };

  const values = {
    collateral: amount('collateral', true),
    size: amount('size', true),
    entry: amount('entry', true),
    exit: amount('exit', true),
    stopTrigger: amount('stopTrigger', true, true),
    entryFee: rate('entryFeePercent'),
    exitFee: rate('exitFeePercent'),
    carry: signed('carryingCost'),
    maintenanceRate: rate('maintenanceRatePercent'),
    maintenanceAmount: amount('maintenanceAmount', false),
    bracketFloor: amount('bracketFloor', false),
    // Positive follows from cap > floor ≥ 0, checked below with a clearer message.
    bracketCap: amount('bracketCap', false),
  };

  const { entry, stopTrigger, bracketFloor, bracketCap } = values;
  if (entry !== undefined && stopTrigger !== undefined && stopTrigger >= entry) {
    reject(
      'stopTrigger',
      'Must be below the entry price: a protective stop for a long triggers below entry.',
    );
  }
  if (bracketFloor !== undefined && bracketCap !== undefined && bracketCap <= bracketFloor) {
    reject('bracketCap', 'Must be above the bracket floor.');
  }
  return { missing, errors, values };
}

interface Position {
  quantity: bigint; // 1e-8
  entry: bigint; // 1e-8
  exit: bigint; // 1e-8
  stopTrigger: bigint | undefined; // 1e-8
  maintenanceRate: bigint; // 1e-6
  maintenanceAmount: bigint; // 1e-8
  bracketFloor: bigint; // 1e-8
  bracketCap: bigint; // 1e-8
}

/**
 * Solves C′ + Q(P − E) = Q·P·m − A for P (docs/LEVERAGE_SIMULATION.md), and gives P only when
 * the assumptions hold together: C′ > 0, a positive solution, P below entry, and the notional
 * at P inside the bracket the owner entered.
 */
function liquidationReference(
  position: Position,
  collateralBeforeMove22: bigint,
): LiquidationReference {
  const collateralBeforeMove = usdt(collateralBeforeMove22);
  if (collateralBeforeMove22 <= 0n) return { status: 'collateral_exhausted', collateralBeforeMove };

  const { quantity, entry, maintenanceRate, maintenanceAmount } = position;
  const oneMinusRate = RATE_ONE - maintenanceRate;
  // Q·E − C′ − A at 1e-22 USDT.
  const numerator = quantity * entry * E6 - collateralBeforeMove22 - maintenanceAmount * E14;
  if (numerator <= 0n) return { status: 'no_positive_solution', collateralBeforeMove };

  // P* in 1e-8 price units is numerator / perUnit; compare prices by cross-multiplying.
  const perUnit = quantity * oneMinusRate;
  if (numerator >= entry * perUnit) return { status: 'not_below_entry', collateralBeforeMove };

  // Notional at P* = (Q·E − C′ − A) / (1 − m); in 1e-8 units it is numerator / notionalDivisor.
  const notionalDivisor = oneMinusRate * E8;
  const notionalAtReference = units(ceilDiv(numerator, notionalDivisor));
  const below = numerator < position.bracketFloor * notionalDivisor;
  const above = numerator > position.bracketCap * notionalDivisor;
  if (below || above)
    return { status: 'bracket_mismatch', collateralBeforeMove, notionalAtReference };

  const denominator = perUnit * E8;
  const divisor = gcd(numerator, denominator);
  const side = (price: bigint): Side =>
    price * perUnit > numerator ? 'above_reference' : 'at_or_below_reference';
  return {
    status: 'reference',
    collateralBeforeMove,
    price: units(ceilDiv(numerator, perUnit)),
    exact: {
      numerator: (numerator / divisor).toString(),
      denominator: (denominator / divisor).toString(),
    },
    notionalAtReference,
    exitFill: side(position.exit),
    stopTrigger: position.stopTrigger === undefined ? null : side(position.stopTrigger),
    note: SHARED_PRICE_NOTE,
  };
}

/**
 * Works out one isolated perpetual long from the owner's inputs, or says which inputs are
 * missing or invalid. See docs/LEVERAGE_SIMULATION.md for the derivations and limits.
 */
export function simulatePerpetualLong(inputs: PerpetualInputs): PerpetualCheck {
  const { missing, errors, values } = parse(inputs);
  const v = values;
  if (
    missing.length > 0 ||
    Object.keys(errors).length > 0 ||
    v.collateral === undefined ||
    v.size === undefined ||
    v.entry === undefined ||
    v.exit === undefined ||
    v.entryFee === undefined ||
    v.exitFee === undefined ||
    v.carry === undefined ||
    v.maintenanceRate === undefined ||
    v.maintenanceAmount === undefined ||
    v.bracketFloor === undefined ||
    v.bracketCap === undefined
  ) {
    return { ok: false, missing, errors };
  }

  // Target notional at 1e-16: notional (1e-8) × 1e8, or collateral (1e-8) × leverage (1e-8).
  const target16 = inputs.sizing === 'notional' ? v.size * E8 : v.collateral * v.size;
  const quantity = target16 / v.entry;
  if (quantity === 0n) {
    return {
      ok: false,
      missing,
      errors: {
        form: 'At this entry, the size is less than 0.00000001 of the base asset.',
      },
    };
  }

  const collateral22 = v.collateral * E14;
  const carry22 = v.carry * E14;
  const entryNotional22 = quantity * v.entry * E6;
  const exitNotional22 = quantity * v.exit * E6;
  const entryFee22 = quantity * v.entry * v.entryFee;
  const exitFee22 = quantity * v.exit * v.exitFee;
  const move22 = exitNotional22 - entryNotional22;
  const equity22 = collateral22 + move22 - entryFee22 - exitFee22 - carry22;
  const net22 = equity22 - collateral22;

  const position: Position = {
    quantity,
    entry: v.entry,
    exit: v.exit,
    stopTrigger: v.stopTrigger,
    maintenanceRate: v.maintenanceRate,
    maintenanceAmount: v.maintenanceAmount,
    bracketFloor: v.bracketFloor,
    bracketCap: v.bracketCap,
  };

  return {
    ok: true,
    scenario: {
      quantity: units(quantity),
      targetNotional: formatScaled(target16, 16),
      entryNotional: usdt(entryNotional22),
      exitNotional: usdt(exitNotional22),
      fees: { entry: usdt(entryFee22), exit: usdt(exitFee22), total: usdt(entryFee22 + exitFee22) },
      carryingCost: usdt(carry22),
      priceMove: usdt(move22),
      equityAtExit: usdt(equity22),
      netResult: usdt(net22),
      // net / collateral × 100, at 1e-4 of a percent.
      collateralChangePercent: formatScaled(roundHalfAway(net22 * E6, collateral22), RATE_DECIMALS),
      collateralExhausted: equity22 <= 0n,
      exitFill: {
        price: units(v.exit),
        stopTrigger: v.stopTrigger === undefined ? null : units(v.stopTrigger),
        priceMinusTrigger: v.stopTrigger === undefined ? null : units(v.exit - v.stopTrigger),
      },
      liquidation: {
        zeroCost: liquidationReference(position, collateral22),
        afterCosts: liquidationReference(position, collateral22 - entryFee22 - carry22),
      },
    },
  };
}
