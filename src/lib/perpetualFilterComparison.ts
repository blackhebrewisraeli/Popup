/**
 * Arithmetic checks of one offline perpetual scenario against the filters the TRXUSDT perpetual
 * reported in exchangeInfo (docs/LEVERAGE_SIMULATION.md#filter-comparison). It sends nothing and
 * changes nothing: it reads the simulation's own figures and the snapshot's own strings.
 *
 * Exact decimals only. Each value becomes an integer count at a shared scale, so no digit is
 * rounded and no quantity is resized. The rules are Binance's USDⓈ-M filter definitions
 * (Public Endpoints Info → Filters, last modified 2026-11-12):
 * - PRICE_FILTER: price ≥ minPrice, price ≤ maxPrice, (price − minPrice) % tickSize = 0, for the
 *   enabled rules; any of the three set to 0 disables its rule.
 * - LOT_SIZE (the symbol's quantity rule) and MARKET_LOT_SIZE (for MARKET orders): quantity ≥
 *   minQty, quantity ≤ maxQty, (quantity − minQty) % stepSize = 0. No field is documented as
 *   disabling a rule.
 * - MIN_NOTIONAL: an order's notional is price × quantity; a MARKET order uses the mark price.
 */

import { isDecimalText, type ContractFacts, type FilterState } from '@/lib/perpetualContractFacts';
import { formatScaled, type PerpetualScenario } from '@/lib/perpetualScenario';

/** Popup's policy, not a Binance rule: a contract snapshot older than this is stale. */
export const STALE_AFTER_MS = 60_000;

export function isStale(receivedAt: number, now: number): boolean {
  return now - receivedAt > STALE_AFTER_MS;
}

export type Outcome = 'within' | 'outside' | 'not_checked';

export interface FilterCheck {
  rule: 'Minimum' | 'Maximum' | 'Step' | 'Tick';
  /** The value under test with its unit, exactly as the simulation produced it. */
  compared: string;
  /** The reported constraint with its field name and unit, or why there is none. */
  constraint: string;
  outcome: Outcome;
  /** Why it was not checked, or the remainder that put it outside a step or tick. */
  detail?: string;
}

export interface CheckGroup {
  filter: 'LOT_SIZE' | 'MARKET_LOT_SIZE' | 'PRICE_FILTER' | 'MIN_NOTIONAL';
  subject: 'Quantity' | 'Entry fill' | 'Exit fill' | 'Simulated entry notional';
  checks: FilterCheck[];
}

/** Plain unsigned decimals as integer counts at their largest scale. */
function aligned(values: readonly string[]): { counts: bigint[]; scale: number } {
  const parts = values.map((text) => {
    if (!isDecimalText(text)) throw new RangeError(`Not a plain unsigned decimal: ${text}`);
    const [whole = '', fraction = ''] = text.split('.');
    return { whole, fraction };
  });
  const scale = Math.max(...parts.map(({ fraction }) => fraction.length));
  return {
    counts: parts.map(({ whole, fraction }) => BigInt(whole + fraction.padEnd(scale, '0'))),
    scale,
  };
}

const outcome = (within: boolean): Outcome => (within ? 'within' : 'outside');

function unavailable(
  state: Exclude<FilterState<string>, { state: 'reported' }>,
  filter: string,
): string {
  return state.state === 'missing'
    ? `Not reported: the snapshot has no ${filter} filter`
    : `Malformed: ${filter} ${state.field} is not a plain decimal`;
}

const RULES = ['Minimum', 'Maximum', 'Step'] as const;

/** Every check of a filter that cannot be used, with the same reason. */
function withheldAll(
  rules: readonly FilterCheck['rule'][],
  compared: string,
  constraint: string,
  detail: string,
): FilterCheck[] {
  return rules.map((rule) => ({ rule, compared, constraint, outcome: 'not_checked', detail }));
}

function quantityGroup(
  filter: 'LOT_SIZE' | 'MARKET_LOT_SIZE',
  state: ContractFacts['lotSize'],
  quantity: string,
  unit: string,
): CheckGroup {
  const compared = `${quantity} ${unit}`;
  const group = (checks: FilterCheck[]): CheckGroup => ({ filter, subject: 'Quantity', checks });
  if (state.state !== 'reported') {
    return group(
      withheldAll(RULES, compared, unavailable(state, filter), 'Nothing is concluded from it.'),
    );
  }
  const { minQty, maxQty, stepSize } = state.values;
  const {
    counts: [q = 0n, min = 0n, max = 0n, step = 0n],
    scale,
  } = aligned([quantity, minQty, maxQty, stepSize]);
  if (min > max) {
    return group(
      withheldAll(
        RULES,
        compared,
        `minQty ${minQty} ${unit} is above maxQty ${maxQty} ${unit}`,
        `Contradictory: ${filter} contradicts itself, so nothing is concluded from it.`,
      ),
    );
  }
  const stepConstraint = `(quantity − minQty ${minQty}) a whole multiple of stepSize ${stepSize} ${unit}`;
  let stepCheck: FilterCheck;
  if (step === 0n) {
    stepCheck = {
      rule: 'Step',
      compared,
      constraint: stepConstraint,
      outcome: 'not_checked',
      detail: `A stepSize of 0 has no documented meaning for ${filter}, and a remainder of division by 0 does not exist.`,
    };
  } else {
    const remainder = (q - min) % step;
    stepCheck = {
      rule: 'Step',
      compared,
      constraint: stepConstraint,
      outcome: outcome(remainder === 0n),
      ...(remainder !== 0n && {
        detail: `(quantity − minQty) leaves ${formatScaled(remainder, scale)} ${unit} over a whole number of steps.`,
      }),
    };
  }
  return group([
    {
      rule: 'Minimum',
      compared,
      constraint: `at least minQty ${minQty} ${unit}`,
      outcome: outcome(q >= min),
    },
    {
      rule: 'Maximum',
      compared,
      constraint: `at most maxQty ${maxQty} ${unit}`,
      outcome: outcome(q <= max),
    },
    stepCheck,
  ]);
}

const disabled = (field: string) =>
  `Disabled: Binance documents ${field} 0 as disabling this rule.`;

function priceGroup(
  subject: 'Entry fill' | 'Exit fill',
  state: ContractFacts['priceFilter'],
  price: string,
): CheckGroup {
  const compared = `${price} USDT per unit`;
  const group = (checks: FilterCheck[]): CheckGroup => ({
    filter: 'PRICE_FILTER',
    subject,
    checks,
  });
  const rules = ['Minimum', 'Maximum', 'Tick'] as const;
  if (state.state !== 'reported') {
    return group(
      withheldAll(
        rules,
        compared,
        unavailable(state, 'PRICE_FILTER'),
        'Nothing is concluded from it.',
      ),
    );
  }
  const { minPrice, maxPrice, tickSize } = state.values;
  const {
    counts: [p = 0n, min = 0n, max = 0n, tick = 0n],
    scale,
  } = aligned([price, minPrice, maxPrice, tickSize]);
  if (min > 0n && max > 0n && min > max) {
    return group(
      withheldAll(
        rules,
        compared,
        `minPrice ${minPrice} USDT is above maxPrice ${maxPrice} USDT`,
        'Contradictory: PRICE_FILTER contradicts itself, so nothing is concluded from it.',
      ),
    );
  }
  const minConstraint = `at least minPrice ${minPrice} USDT`;
  const maxConstraint = `at most maxPrice ${maxPrice} USDT`;
  const tickConstraint = `(price − minPrice ${minPrice}) a whole multiple of tickSize ${tickSize} USDT`;
  const remainder = tick === 0n ? 0n : (p - min) % tick;
  return group([
    min === 0n
      ? {
          rule: 'Minimum',
          compared,
          constraint: minConstraint,
          outcome: 'not_checked',
          detail: disabled('minPrice'),
        }
      : { rule: 'Minimum', compared, constraint: minConstraint, outcome: outcome(p >= min) },
    max === 0n
      ? {
          rule: 'Maximum',
          compared,
          constraint: maxConstraint,
          outcome: 'not_checked',
          detail: disabled('maxPrice'),
        }
      : { rule: 'Maximum', compared, constraint: maxConstraint, outcome: outcome(p <= max) },
    tick === 0n
      ? {
          rule: 'Tick',
          compared,
          constraint: tickConstraint,
          outcome: 'not_checked',
          detail: disabled('tickSize'),
        }
      : {
          rule: 'Tick',
          compared,
          constraint: tickConstraint,
          outcome: outcome(remainder === 0n),
          ...(remainder !== 0n && {
            detail: `(price − minPrice) leaves ${formatScaled(remainder, scale)} USDT over a whole number of ticks.`,
          }),
        },
  ]);
}

function notionalGroup(state: ContractFacts['minNotional'], entryNotional: string): CheckGroup {
  const compared = `${entryNotional} USDT (quantity × entry fill)`;
  const group = (check: FilterCheck): CheckGroup => ({
    filter: 'MIN_NOTIONAL',
    subject: 'Simulated entry notional',
    checks: [check],
  });
  if (state.state !== 'reported') {
    return group({
      rule: 'Minimum',
      compared,
      constraint: unavailable(state, 'MIN_NOTIONAL'),
      outcome: 'not_checked',
      detail: 'Nothing is concluded from it.',
    });
  }
  const { notional } = state.values;
  const {
    counts: [value = 0n, min = 0n],
  } = aligned([entryNotional, notional]);
  return group({
    rule: 'Minimum',
    compared,
    constraint: `at least notional ${notional} USDT`,
    outcome: outcome(value >= min),
  });
}

/**
 * Quantity against LOT_SIZE and MARKET_LOT_SIZE separately, the entry and exit fills against
 * PRICE_FILTER, and the simulated entry notional against MIN_NOTIONAL. Each check stands alone:
 * there is no overall verdict.
 */
export function compareWithFilters(
  scenario: PerpetualScenario,
  facts: ContractFacts,
): CheckGroup[] {
  return [
    quantityGroup('LOT_SIZE', facts.lotSize, scenario.quantity, facts.baseAsset),
    quantityGroup('MARKET_LOT_SIZE', facts.marketLotSize, scenario.quantity, facts.baseAsset),
    priceGroup('Entry fill', facts.priceFilter, scenario.entryFill),
    priceGroup('Exit fill', facts.priceFilter, scenario.exitFill.price),
    notionalGroup(facts.minNotional, scenario.entryNotional),
  ];
}
