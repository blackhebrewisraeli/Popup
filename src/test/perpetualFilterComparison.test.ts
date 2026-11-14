import { describe, expect, it } from 'vitest';
import { parseExchangeInfo, type ContractFacts } from '@/lib/perpetualContractFacts';
import {
  STALE_AFTER_MS,
  compareWithFilters,
  isStale,
  type CheckGroup,
  type FilterCheck,
} from '@/lib/perpetualFilterComparison';
import {
  EMPTY_PERPETUAL,
  simulatePerpetualLong,
  type PerpetualField,
} from '@/lib/perpetualScenario';
import { TRX_PERPETUAL, exchangeInfoBody } from './perpetualFactsFixtures';

/** Synthetic simulation inputs: with entry 1, the quantity equals the notional typed. */
const BASE: Partial<Record<PerpetualField, string>> = {
  collateral: '10',
  size: '100',
  entry: '1',
  exit: '1',
  entryFeePercent: '0',
  exitFeePercent: '0',
  carryingCost: '0',
  maintenanceRatePercent: '1',
  maintenanceAmount: '0',
  bracketFloor: '0',
  bracketCap: '1000000000',
};

function scenario(values: Partial<Record<PerpetualField, string>> = {}) {
  const check = simulatePerpetualLong({ ...EMPTY_PERPETUAL, ...BASE, ...values });
  if (!check.ok) throw new Error(JSON.stringify(check));
  return check.scenario;
}

type Filter = Record<string, unknown> & { filterType: string };

/** The fixture contract, parsed, with filters replaced (undefined removes one). */
function facts(replace: Record<string, Filter | undefined> = {}): ContractFacts {
  const filters = (TRX_PERPETUAL.filters as Filter[])
    .map((filter) => (filter.filterType in replace ? replace[filter.filterType] : filter))
    .filter((filter): filter is Filter => filter !== undefined);
  const parsed = parseExchangeInfo(exchangeInfoBody({ ...TRX_PERPETUAL, filters }));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  return parsed.data;
}

const lot = (minQty: string, maxQty: string, stepSize: string, type = 'LOT_SIZE'): Filter => ({
  filterType: type,
  minQty,
  maxQty,
  stepSize,
});
const priceFilter = (minPrice: string, maxPrice: string, tickSize: string): Filter => ({
  filterType: 'PRICE_FILTER',
  minPrice,
  maxPrice,
  tickSize,
});

function group(groups: CheckGroup[], filter: CheckGroup['filter'], subject?: string) {
  const found = groups.find((g) => g.filter === filter && (!subject || g.subject === subject));
  if (!found) throw new Error(`No ${filter} ${subject ?? ''} group`);
  return found;
}
const outcomes = (g: CheckGroup) => g.checks.map((check) => check.outcome);
const byRule = (g: CheckGroup, rule: FilterCheck['rule']) => {
  const found = g.checks.find((check) => check.rule === rule);
  if (!found) throw new Error(`No ${rule} check`);
  return found;
};

describe('compareWithFilters: shape', () => {
  it('compares quantity with both lot filters, both fills with PRICE_FILTER and the entry notional', () => {
    const groups = compareWithFilters(
      scenario({ entry: '0.3', exit: '0.33', size: '30' }),
      facts(),
    );
    expect(groups.map((g) => `${g.filter} · ${g.subject}`)).toEqual([
      'LOT_SIZE · Quantity',
      'MARKET_LOT_SIZE · Quantity',
      'PRICE_FILTER · Entry fill',
      'PRICE_FILTER · Exit fill',
      'MIN_NOTIONAL · Simulated entry notional',
    ]);
    expect(groups.flatMap(outcomes).every((o) => o === 'within')).toBe(true);
    expect(group(groups, 'LOT_SIZE').checks).toEqual([
      {
        rule: 'Minimum',
        compared: '100 TRX',
        constraint: 'at least minQty 1 TRX',
        outcome: 'within',
      },
      {
        rule: 'Maximum',
        compared: '100 TRX',
        constraint: 'at most maxQty 20000000 TRX',
        outcome: 'within',
      },
      {
        rule: 'Step',
        compared: '100 TRX',
        constraint: '(quantity − minQty 1) a whole multiple of stepSize 1 TRX',
        outcome: 'within',
      },
    ]);
    expect(byRule(group(groups, 'PRICE_FILTER', 'Exit fill'), 'Tick')).toMatchObject({
      compared: '0.33 USDT per unit',
      constraint: '(price − minPrice 0.00132) a whole multiple of tickSize 0.00001 USDT',
    });
    expect(group(groups, 'MIN_NOTIONAL').checks[0]).toEqual({
      rule: 'Minimum',
      compared: '30 USDT (quantity × entry fill)',
      constraint: 'at least notional 5 USDT',
      outcome: 'within',
    });
  });

  it('never changes the scenario it reads', () => {
    const s = scenario({ size: '100.5' });
    const copy = structuredClone(s);
    compareWithFilters(s, facts());
    expect(s).toEqual(copy);
  });
});

describe('compareWithFilters: quantity', () => {
  it('treats minQty and maxQty as inclusive, one 1e-8 past either is outside', () => {
    const at = (size: string, filter: CheckGroup['filter']) =>
      outcomes(group(compareWithFilters(scenario({ size }), facts()), filter));
    expect(at('1', 'LOT_SIZE')).toEqual(['within', 'within', 'within']);
    expect(at('0.99999999', 'LOT_SIZE')).toEqual(['outside', 'within', 'outside']);
    expect(at('20000000', 'LOT_SIZE')).toEqual(['within', 'within', 'within']);
    expect(at('20000000.00000001', 'LOT_SIZE')).toEqual(['within', 'outside', 'outside']);
  });

  it('keeps LOT_SIZE and MARKET_LOT_SIZE apart', () => {
    const groups = compareWithFilters(scenario({ size: '5000001' }), facts());
    expect(outcomes(group(groups, 'LOT_SIZE'))).toEqual(['within', 'within', 'within']);
    expect(outcomes(group(groups, 'MARKET_LOT_SIZE'))).toEqual(['within', 'outside', 'within']);
    expect(byRule(group(groups, 'MARKET_LOT_SIZE'), 'Maximum').constraint).toBe(
      'at most maxQty 5000000 TRX',
    );
  });

  it('reports the exact remainder off the step and never rounds the quantity', () => {
    const groups = compareWithFilters(scenario({ size: '100.5' }), facts());
    expect(byRule(group(groups, 'LOT_SIZE'), 'Step')).toMatchObject({
      compared: '100.5 TRX',
      outcome: 'outside',
      detail: '(quantity − minQty) leaves 0.5 TRX over a whole number of steps.',
    });
    const tiny = compareWithFilters(scenario({ size: '100.00000001' }), facts());
    expect(byRule(group(tiny, 'MARKET_LOT_SIZE'), 'Step')).toMatchObject({
      compared: '100.00000001 TRX',
      outcome: 'outside',
      detail: '(quantity − minQty) leaves 0.00000001 TRX over a whole number of steps.',
    });
  });

  it('counts steps from minQty, as documented, and compares across decimal scales exactly', () => {
    const filters = { LOT_SIZE: lot('0.50000000', '1000.00000000', '1.00000000') };
    const step = (size: string) =>
      byRule(group(compareWithFilters(scenario({ size }), facts(filters)), 'LOT_SIZE'), 'Step');
    expect(step('2.5').outcome).toBe('within');
    expect(step('2').outcome).toBe('outside');
    const fine = { LOT_SIZE: lot('0.001', '100', '0.001') };
    const fineStep = (size: string) =>
      byRule(group(compareWithFilters(scenario({ size }), facts(fine)), 'LOT_SIZE'), 'Step');
    expect(fineStep('0.003').outcome).toBe('within');
    expect(fineStep('0.0035')).toMatchObject({
      outcome: 'outside',
      detail: '(quantity − minQty) leaves 0.0005 TRX over a whole number of steps.',
    });
  });

  it('withholds the step check when stepSize is 0, which Binance gives no meaning', () => {
    const groups = compareWithFilters(scenario(), facts({ LOT_SIZE: lot('1', '1000', '0') }));
    const g = group(groups, 'LOT_SIZE');
    expect(outcomes(g)).toEqual(['within', 'within', 'not_checked']);
    expect(byRule(g, 'Step').detail).toMatch(/^A stepSize of 0 has no documented meaning/);
  });

  it('concludes nothing from a lot filter whose minimum is above its maximum', () => {
    const groups = compareWithFilters(
      scenario(),
      facts({ MARKET_LOT_SIZE: lot('500', '50', '1', 'MARKET_LOT_SIZE') }),
    );
    const g = group(groups, 'MARKET_LOT_SIZE');
    expect(outcomes(g)).toEqual(['not_checked', 'not_checked', 'not_checked']);
    expect(g.checks[0]).toMatchObject({
      constraint: 'minQty 500 TRX is above maxQty 50 TRX',
      detail: 'Contradictory: MARKET_LOT_SIZE contradicts itself, so nothing is concluded from it.',
    });
    expect(outcomes(group(groups, 'LOT_SIZE'))).toEqual(['within', 'within', 'within']);
  });

  it('says which filter is missing or malformed and concludes nothing from it', () => {
    const missing = group(
      compareWithFilters(scenario(), facts({ LOT_SIZE: undefined })),
      'LOT_SIZE',
    );
    expect(outcomes(missing)).toEqual(['not_checked', 'not_checked', 'not_checked']);
    expect(missing.checks[0]?.constraint).toBe('Not reported: the snapshot has no LOT_SIZE filter');
    const malformed = group(
      compareWithFilters(
        scenario(),
        facts({ MARKET_LOT_SIZE: lot('1', '1000', '1e-3', 'MARKET_LOT_SIZE') }),
      ),
      'MARKET_LOT_SIZE',
    );
    expect(outcomes(malformed)).toEqual(['not_checked', 'not_checked', 'not_checked']);
    expect(malformed.checks[2]?.constraint).toBe(
      'Malformed: MARKET_LOT_SIZE stepSize is not a plain decimal',
    );
  });
});

describe('compareWithFilters: prices', () => {
  const entryGroup = (entry: string, filters = {}) =>
    group(
      compareWithFilters(scenario({ entry, exit: entry, size: '30' }), facts(filters)),
      'PRICE_FILTER',
      'Entry fill',
    );

  it('checks ticks from minPrice to the exact digit', () => {
    expect(outcomes(entryGroup('0.30001'))).toEqual(['within', 'within', 'within']);
    expect(byRule(entryGroup('0.300015'), 'Tick')).toMatchObject({
      outcome: 'outside',
      detail: '(price − minPrice) leaves 0.000005 USDT over a whole number of ticks.',
    });
  });

  it('treats minPrice and maxPrice as inclusive', () => {
    expect(outcomes(entryGroup('0.00132'))).toEqual(['within', 'within', 'within']);
    expect(outcomes(entryGroup('0.00131'))[0]).toBe('outside');
    expect(outcomes(entryGroup('20000'))).toEqual(['within', 'within', 'within']);
    expect(outcomes(entryGroup('20000.00001'))[1]).toBe('outside');
  });

  it('compares the exit fill on its own', () => {
    const groups = compareWithFilters(
      scenario({ entry: '0.3', exit: '0.300015', size: '30' }),
      facts(),
    );
    expect(outcomes(group(groups, 'PRICE_FILTER', 'Entry fill'))).toEqual([
      'within',
      'within',
      'within',
    ]);
    expect(outcomes(group(groups, 'PRICE_FILTER', 'Exit fill'))).toEqual([
      'within',
      'within',
      'outside',
    ]);
  });

  it('marks each rule set to 0 as disabled, as documented, and still checks the others', () => {
    const g = entryGroup('0.3', { PRICE_FILTER: priceFilter('0', '20000', '0') });
    expect(outcomes(g)).toEqual(['not_checked', 'within', 'not_checked']);
    expect(byRule(g, 'Minimum').detail).toBe(
      'Disabled: Binance documents minPrice 0 as disabling this rule.',
    );
    expect(byRule(g, 'Tick').detail).toBe(
      'Disabled: Binance documents tickSize 0 as disabling this rule.',
    );
    const noMax = entryGroup('0.3', { PRICE_FILTER: priceFilter('0.1', '0', '0.1') });
    expect(outcomes(noMax)).toEqual(['within', 'not_checked', 'within']);
  });

  it('concludes nothing from a PRICE_FILTER whose enabled minimum is above its maximum', () => {
    const g = entryGroup('0.3', { PRICE_FILTER: priceFilter('2', '1', '0.1') });
    expect(outcomes(g)).toEqual(['not_checked', 'not_checked', 'not_checked']);
    expect(g.checks[0]?.constraint).toBe('minPrice 2 USDT is above maxPrice 1 USDT');
  });

  it('withholds every price check without a PRICE_FILTER', () => {
    const g = entryGroup('0.3', { PRICE_FILTER: undefined });
    expect(outcomes(g)).toEqual(['not_checked', 'not_checked', 'not_checked']);
  });
});

describe('compareWithFilters: minimum notional', () => {
  const notional = (size: string, filters = {}) =>
    group(compareWithFilters(scenario({ size }), facts(filters)), 'MIN_NOTIONAL').checks[0];

  it('compares the simulated entry notional exactly, inclusive of the minimum', () => {
    expect(notional('5')?.outcome).toBe('within');
    expect(notional('4.99999999')).toMatchObject({
      compared: '4.99999999 USDT (quantity × entry fill)',
      outcome: 'outside',
    });
  });

  it('withholds the check without a MIN_NOTIONAL filter', () => {
    expect(notional('5', { MIN_NOTIONAL: undefined })).toMatchObject({
      outcome: 'not_checked',
      constraint: 'Not reported: the snapshot has no MIN_NOTIONAL filter',
    });
  });
});

describe('isStale: Popup policy', () => {
  it('is fresh at exactly 60 seconds and stale one millisecond later', () => {
    expect(STALE_AFTER_MS).toBe(60_000);
    expect(isStale(1_000, 61_000)).toBe(false);
    expect(isStale(1_000, 61_001)).toBe(true);
  });
});
