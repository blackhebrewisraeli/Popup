/**
 * A manual Spot scenario for one USDT pair: what the owner's own allocation, loss budget,
 * hypothetical entry and stop reference imply. Pure and offline: it reads no balance, quote
 * or exchange filter, and nothing here is an order.
 *
 * Every amount is the decimal the owner typed, held exactly as an integer count of 1e-8
 * (BigInt). Floating point cannot: a 1,000 USDT plan at a PEPE-sized price is a quantity with
 * 17 significant digits, past what a double holds.
 *
 * `recommendPositionSize` (risk.ts) has the same min(budget / price, risk / distance) shape but
 * not these semantics: it derives the stop from ATR, risks a percent of capital, rounds to 4
 * decimals and sizes invalid input to zero. None of that fits an owner-typed plan, so it is
 * not reused here.
 */

import type { ScanAssetResult } from '@/lib/marketScanner';
import type { TradingViewDevSource } from '@/lib/tradingViewDevScan';

export type ScenarioField = 'allocation' | 'maxLoss' | 'entry' | 'stop' | 'feePercent';
export type ScenarioInputs = Readonly<Record<ScenarioField, string>>;

export const EMPTY_SCENARIO: ScenarioInputs = {
  allocation: '',
  maxLoss: '',
  entry: '',
  stop: '',
  feePercent: '',
};

/** USDT amounts and prices are typed to 1e-8; the quantity is floored to 1e-8 of the base asset. */
const DECIMALS = 8;
/** The fee assumption is a percent to 4 decimals (0.0750%), so f = typed × 1e4 / 1e6. */
const FEE_DECIMALS = 4;
/** Above 1,000,000,000 USDT, or USDT per unit, a typed value is a slip, not a plan. */
export const MAX_AMOUNT = 1_000_000_000;
export const MAX_FEE_PERCENT = 1;

const E6 = 10n ** 6n;
const E14 = 10n ** 14n;
/** Every derived amount is exact at this scale: quantity (1e-8) × price (1e-8) × fee (1e-6). */
const SCALE_DIGITS = 22;

export type LimitedBy = 'allocation' | 'maxLoss' | 'both';

export interface Scenario {
  /** Base units, exact, floored to 1e-8. */
  quantity: string;
  limitedBy: LimitedBy;
  /** USDT, to the cent. */
  notional: string;
  unallocated: string;
  /** Entry minus stop, exact, in USDT per unit; and as a share of entry. */
  stopDistance: string;
  stopDistancePercent: string;
  /** The price move from entry to the stop reference alone. */
  lossAtStop: string;
  /** Null while the fee assumption is unspecified. */
  fees: { entry: string; exit: string; lossWithFees: string } | null;
}

export type ScenarioErrors = Partial<Record<ScenarioField | 'form', string>>;

export type ScenarioCheck =
  | { ok: true; scenario: Scenario }
  | { ok: false; missing: ScenarioField[]; errors: ScenarioErrors };

const FORMAT_ERROR =
  'Enter a plain decimal such as 1250.5: digits and one decimal point, no commas, signs or exponents.';

/** A typed decimal as a count of 10^-decimals, or why it is not one. Empty is null. */
function parseDecimal(text: string, decimals: number): bigint | string | null {
  const value = text.trim();
  if (value === '') return null;
  if (value.startsWith('-')) return 'Enter a positive number.';
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!match || value === '.') return FORMAT_ERROR;
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > decimals) return `Use at most ${decimals} decimal places.`;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

/** numerator / 10^digits ≥ 0, rounded half up to `places` and grouped: "1,234.50". */
function decimal(numerator: bigint, digits: number, places: number): string {
  const step = 10n ** BigInt(digits - places);
  const rounded = (numerator + step / 2n) / step;
  const unit = 10n ** BigInt(places);
  const whole = (rounded / unit).toLocaleString('en-US');
  return places === 0 ? whole : `${whole}.${(rounded % unit).toString().padStart(places, '0')}`;
}

/** An exact 1e-8 count with trailing zeros trimmed: "0.0123", "161,290,322.58064516". */
function exact(units: bigint): string {
  return decimal(units, DECIMALS, DECIMALS).replace(/\.?0+$/, '');
}

/** USDT to the cent; a positive amount below half a cent reads "<0.01", never 0. */
function usdt(scaled: bigint): string {
  const cents = decimal(scaled, SCALE_DIGITS, 2);
  return scaled > 0n && cents === '0.00' ? '<0.01' : cents;
}

/** A recorded price as an input value: at most 8 decimals, no exponent ("0.00000612"). */
export function decimalInput(value: number): string {
  return value.toFixed(DECIMALS).replace(/\.?0+$/, '');
}

/**
 * Checks the owner's inputs and, when all of them hold, works out the scenario:
 *
 *   quantity = floor₁ₑ₋₈ min( allocation / (entry × (1 + f)),
 *                             maxLoss / (entry − stop + f × (entry + stop)) )
 *
 * with f the assumed fee per fill (0 while unspecified), charged at entry and at the stop
 * reference. Flooring keeps the exact notional plus entry fee within the allocation, and the
 * exact loss at the stop within the budget. Missing or invalid input never yields a number.
 */
export function planSpotScenario(inputs: ScenarioInputs): ScenarioCheck {
  const missing: ScenarioField[] = [];
  const errors: ScenarioErrors = {};
  const amount = (field: Exclude<ScenarioField, 'feePercent'>): bigint | undefined => {
    const parsed = parseDecimal(inputs[field], DECIMALS);
    if (parsed === null) missing.push(field);
    else if (typeof parsed === 'string') errors[field] = parsed;
    else if (parsed === 0n) errors[field] = 'Must be greater than 0.';
    else if (parsed > BigInt(MAX_AMOUNT) * 10n ** BigInt(DECIMALS)) {
      errors[field] =
        `Above ${MAX_AMOUNT.toLocaleString('en-US')} is outside this planner's range.`;
    } else return parsed;
    return undefined;
  };
  const allocation = amount('allocation');
  const maxLoss = amount('maxLoss');
  const entry = amount('entry');
  const stop = amount('stop');

  let fee = 0n;
  const parsedFee = parseDecimal(inputs.feePercent, FEE_DECIMALS);
  if (typeof parsedFee === 'string') errors.feePercent = parsedFee;
  else if (
    parsedFee !== null &&
    parsedFee > BigInt(MAX_FEE_PERCENT) * 10n ** BigInt(FEE_DECIMALS)
  ) {
    errors.feePercent = `Enter at most ${MAX_FEE_PERCENT}% per fill.`;
  } else if (parsedFee !== null) fee = parsedFee;

  if (entry !== undefined && stop !== undefined && stop >= entry) {
    errors.stop =
      'Must be below the entry price: this planner covers a Spot buy, whose stop reference sits below entry.';
  }
  if (allocation !== undefined && maxLoss !== undefined && maxLoss > allocation) {
    errors.maxLoss = 'Cannot exceed the allocation: a Spot buy cannot lose more than it spends.';
  }
  if (
    allocation === undefined ||
    maxLoss === undefined ||
    entry === undefined ||
    stop === undefined ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, missing, errors };
  }

  // Quantity in 1e-8 base units. See the formula above, scaled through by 1e8 · 1e6.
  const byAllocation = (allocation * E14) / (entry * (E6 + fee));
  const byLoss = (maxLoss * E14) / ((entry - stop) * E6 + fee * (entry + stop));
  const quantity = byAllocation < byLoss ? byAllocation : byLoss;
  if (quantity === 0n) {
    return {
      ok: false,
      missing,
      errors: {
        form: 'At this entry, the allocation or the loss budget buys less than 0.00000001 of the base asset.',
      },
    };
  }

  // All at 1e-22 USDT: quantity (1e-8) × price (1e-8) × fee rate (1e-6).
  const notional = quantity * entry * E6;
  const entryFee = quantity * entry * fee;
  const exitFee = quantity * stop * fee;
  const move = quantity * (entry - stop) * E6;
  let limitedBy: LimitedBy = 'both';
  if (byAllocation < byLoss) limitedBy = 'allocation';
  else if (byLoss < byAllocation) limitedBy = 'maxLoss';
  const unspecified = inputs.feePercent.trim() === '';

  return {
    ok: true,
    scenario: {
      quantity: exact(quantity),
      limitedBy,
      notional: usdt(notional),
      unallocated: usdt(allocation * E14 - notional - entryFee),
      stopDistance: exact(entry - stop),
      stopDistancePercent: `${decimal(((entry - stop) * 100n * 10n ** 22n) / entry, SCALE_DIGITS, 2)}%`,
      lossAtStop: usdt(move),
      fees: unspecified
        ? null
        : {
            entry: usdt(entryFee),
            exit: usdt(exitFee),
            lossWithFees: usdt(move + entryFee + exitFee),
          },
    },
  };
}

/** Whether a selected result can carry a Spot scenario: a TradingView-scanned Binance USDT pair. */
export function plansSpot(
  result: ScanAssetResult,
  source: TradingViewDevSource | undefined,
): source is TradingViewDevSource {
  return (
    source !== undefined &&
    result.assetClass === 'crypto' &&
    result.status === 'EVALUATED' &&
    /^BINANCE:[A-Z0-9]+USDT$/.test(result.instrument ?? '')
  );
}
