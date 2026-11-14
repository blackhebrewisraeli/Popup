import { describe, expect, it } from 'vitest';
import {
  EMPTY_PERPETUAL,
  SHARED_PRICE_NOTE,
  simulatePerpetualLong,
  type PerpetualInputs,
} from '@/lib/perpetualScenario';
import { EMPTY_SCENARIO, planSpotScenario } from '@/lib/spotScenario';

/** Labeled synthetic inputs: no value here is a quote, a balance, a rate or a recommendation. */
const base: PerpetualInputs = {
  ...EMPTY_PERPETUAL,
  collateral: '10',
  sizing: 'notional',
  size: '50',
  entry: '1',
  exit: '0.96',
  entryFeePercent: '0',
  exitFeePercent: '0',
  carryingCost: '0',
  maintenanceRatePercent: '1',
  maintenanceAmount: '0',
  bracketFloor: '0',
  bracketCap: '50000',
};

const run = (inputs: Partial<PerpetualInputs>) => simulatePerpetualLong({ ...base, ...inputs });

function scenarioOf(inputs: Partial<PerpetualInputs>) {
  const check = run(inputs);
  if (!check.ok) throw new Error(JSON.stringify(check));
  return check.scenario;
}

function errorsOf(inputs: Partial<PerpetualInputs>) {
  const check = run(inputs);
  if (check.ok) throw new Error('expected validation errors');
  return check;
}

const reference80of99 = {
  status: 'reference',
  collateralBeforeMove: '10',
  price: '0.80808081',
  exact: { numerator: '80', denominator: '99' },
  notionalAtReference: '40.40404041',
  exitFill: 'above_reference',
  stopTrigger: null,
  note: SHARED_PRICE_NOTE,
};

describe('simulatePerpetualLong: acceptance fixture', () => {
  it('loses 2, or 20% of starting collateral, on a 4% move at notional 50 with zero costs', () => {
    expect(scenarioOf({})).toEqual({
      quantity: '50',
      targetNotional: '50',
      entryNotional: '50',
      exitNotional: '48',
      fees: { entry: '0', exit: '0', total: '0' },
      carryingCost: '0',
      priceMove: '-2',
      equityAtExit: '8',
      netResult: '-2',
      collateralChangePercent: '-20',
      collateralExhausted: false,
      exitFill: { price: '0.96', stopTrigger: null, priceMinusTrigger: null },
      liquidation: { zeroCost: reference80of99, afterCosts: reference80of99 },
    });
  });

  it('puts the zero-cost reference at 40 / 49.5 with MMR 1% and maintenance amount 0', () => {
    const { zeroCost } = scenarioOf({}).liquidation;
    if (zeroCost.status !== 'reference') throw new Error(zeroCost.status);
    // 40 / 49.5 = 80 / 99, reduced; the decimal is rounded up, never down.
    expect(zeroCost.exact).toEqual({ numerator: '80', denominator: '99' });
    expect(zeroCost.price).toBe('0.80808081');
  });
});

describe('simulatePerpetualLong: sizing', () => {
  it('sizes 5× leverage on 10 exactly as a notional of 50', () => {
    expect(scenarioOf({ sizing: 'leverage', size: '5' })).toEqual(scenarioOf({}));
  });

  it.each([
    // leverage, notional, loss on a 4% move, % of collateral, reference fraction, rounded up
    ['2', '20', '-0.8', '-8', '50', '99', '0.50505051'],
    ['5', '50', '-2', '-20', '80', '99', '0.80808081'],
    ['10', '100', '-4', '-40', '10', '11', '0.90909091'],
  ])(
    'at %s× the 4%% move costs a proportional share of collateral',
    (leverage, notional, loss, percent, numerator, denominator, price) => {
      const scenario = scenarioOf({ sizing: 'leverage', size: leverage });
      expect(scenario.entryNotional).toBe(notional);
      expect(scenario.netResult).toBe(loss);
      expect(scenario.collateralChangePercent).toBe(percent);
      expect(scenario.liquidation.zeroCost).toMatchObject({
        status: 'reference',
        exact: { numerator, denominator },
        price,
      });
    },
  );

  it('floors quantity to 1e-8 and reports entry notional below the target', () => {
    const scenario = scenarioOf({ entry: '0.3136', exit: '0.3019' });
    expect(scenario.quantity).toBe('159.43877551');
    expect(scenario.targetNotional).toBe('50');
    expect(scenario.entryNotional).toBe('49.999999999936');
  });

  it('refuses a size that buys less than 1e-8 of the base asset', () => {
    expect(errorsOf({ size: '0.00000001', entry: '2' }).errors.form).toMatch(/less than/);
  });
});

describe('simulatePerpetualLong: costs', () => {
  it('deducts both fees and a paid carrying cost from equity', () => {
    const scenario = scenarioOf({
      entryFeePercent: '0.05',
      exitFeePercent: '0.05',
      carryingCost: '0.105',
    });
    expect(scenario.fees).toEqual({ entry: '0.025', exit: '0.024', total: '0.049' });
    expect(scenario.carryingCost).toBe('0.105');
    // 10 − 2 − 0.025 − 0.024 − 0.105
    expect(scenario.equityAtExit).toBe('7.846');
    expect(scenario.netResult).toBe('-2.154');
    expect(scenario.collateralChangePercent).toBe('-21.54');
    // The zero-cost reference ignores costs; the after-cost one starts from 10 − 0.025 − 0.105.
    expect(scenario.liquidation.zeroCost).toEqual(reference80of99);
    expect(scenario.liquidation.afterCosts).toMatchObject({
      status: 'reference',
      collateralBeforeMove: '9.87',
      exact: { numerator: '4013', denominator: '4950' },
      price: '0.81070708',
    });
  });

  it('adds a received carrying amount (a funding credit) to equity', () => {
    const scenario = scenarioOf({ carryingCost: '-0.105' });
    expect(scenario.carryingCost).toBe('-0.105');
    expect(scenario.equityAtExit).toBe('8.105');
    expect(scenario.netResult).toBe('-1.895');
    expect(scenario.collateralChangePercent).toBe('-18.95');
    expect(scenario.liquidation.afterCosts).toMatchObject({
      status: 'reference',
      collateralBeforeMove: '10.105',
      exact: { numerator: '7979', denominator: '9900' },
      price: '0.8059596',
    });
  });

  it('reports a profit, net of costs, when the exit fill is above entry', () => {
    const scenario = scenarioOf({ exit: '1.1', entryFeePercent: '0.02', exitFeePercent: '0.02' });
    expect(scenario.priceMove).toBe('5');
    expect(scenario.fees).toEqual({ entry: '0.01', exit: '0.011', total: '0.021' });
    expect(scenario.netResult).toBe('4.979');
    expect(scenario.collateralChangePercent).toBe('49.79');
  });

  it('rounds collateral change half away from zero to 4 decimals', () => {
    // −2 / 3 × 100 = −66.6666…
    expect(scenarioOf({ collateral: '3' }).collateralChangePercent).toBe('-66.6667');
  });
});

describe('simulatePerpetualLong: exhausted collateral, never clamped', () => {
  it('lets a loss exceed the starting collateral and flags it', () => {
    const scenario = scenarioOf({ exit: '0.7' });
    expect(scenario.equityAtExit).toBe('-5');
    expect(scenario.netResult).toBe('-15');
    expect(scenario.collateralChangePercent).toBe('-150');
    expect(scenario.collateralExhausted).toBe(true);
    expect(scenario.liquidation.zeroCost).toMatchObject({ exitFill: 'at_or_below_reference' });
  });

  it('flags equity of exactly zero as exhausted', () => {
    const scenario = scenarioOf({ exit: '0.8' });
    expect(scenario.equityAtExit).toBe('0');
    expect(scenario.collateralExhausted).toBe(true);
  });

  it('gives no after-cost reference when costs use up the collateral before any move', () => {
    const scenario = scenarioOf({ carryingCost: '10' });
    expect(scenario.liquidation.afterCosts).toEqual({
      status: 'collateral_exhausted',
      collateralBeforeMove: '0',
    });
    expect(scenario.liquidation.zeroCost).toEqual(reference80of99);
    expect(scenario.netResult).toBe('-12');
    expect(scenario.collateralChangePercent).toBe('-120');
  });
});

describe('simulatePerpetualLong: liquidation reference self-consistency', () => {
  it('lowers the reference with a maintenance amount', () => {
    // (50 − 10 − 0.5) / (50 × 0.975) = 39.5 / 48.75 = 158 / 195
    expect(
      scenarioOf({ maintenanceRatePercent: '2.5', maintenanceAmount: '0.5' }).liquidation.zeroCost,
    ).toMatchObject({ exact: { numerator: '158', denominator: '195' }, price: '0.81025642' });
  });

  it('has no positive solution at 1× with MMR 1%', () => {
    expect(scenarioOf({ size: '10' }).liquidation.zeroCost).toEqual({
      status: 'no_positive_solution',
      collateralBeforeMove: '10',
    });
  });

  it('has no positive solution when the maintenance amount cancels the borrowed notional', () => {
    expect(
      scenarioOf({ maintenanceRatePercent: '0', maintenanceAmount: '40' }).liquidation.zeroCost,
    ).toMatchObject({ status: 'no_positive_solution' });
  });

  it('refuses a reference at entry: the requirement already equals equity there', () => {
    // m = 20%: requirement at entry 50 × 0.2 = 10 = collateral, so P* = 1 = entry.
    expect(scenarioOf({ maintenanceRatePercent: '20' }).liquidation.zeroCost).toEqual({
      status: 'not_below_entry',
      collateralBeforeMove: '10',
    });
  });

  it('reports a bracket mismatch with the notional the bracket would have to cover', () => {
    expect(scenarioOf({ bracketFloor: '50', bracketCap: '250' }).liquidation.zeroCost).toEqual({
      status: 'bracket_mismatch',
      collateralBeforeMove: '10',
      notionalAtReference: '40.40404041',
    });
  });

  it.each([
    ['0', '40', 'reference'],
    ['40', '100', 'reference'],
    ['40.00000001', '100', 'bracket_mismatch'],
    ['0', '39.99999999', 'bracket_mismatch'],
  ])('treats bracket [%s, %s] as inclusive at notional exactly 40', (floor, cap, status) => {
    // m = 0, A = 0: P* = (50 − 10) / 50 = 0.8 and the notional there is exactly 40.
    const reference = scenarioOf({
      maintenanceRatePercent: '0',
      bracketFloor: floor,
      bracketCap: cap,
    }).liquidation.zeroCost;
    expect(reference.status).toBe(status);
  });
});

describe('simulatePerpetualLong: stop trigger versus fill', () => {
  it('computes equity at the fill and reports the fill’s distance from the trigger', () => {
    const scenario = scenarioOf({ stopTrigger: '0.97' });
    expect(scenario.exitFill).toEqual({
      price: '0.96',
      stopTrigger: '0.97',
      priceMinusTrigger: '-0.01',
    });
    expect(scenario.equityAtExit).toBe('8');
    expect(scenarioOf({ stopTrigger: '0.99' }).equityAtExit).toBe('8');
  });

  it('compares the trigger with the reference on one shared price, with the note', () => {
    expect(scenarioOf({ stopTrigger: '0.97' }).liquidation.zeroCost).toMatchObject({
      stopTrigger: 'above_reference',
      note: SHARED_PRICE_NOTE,
    });
    expect(scenarioOf({ stopTrigger: '0.8' }).liquidation.zeroCost).toMatchObject({
      stopTrigger: 'at_or_below_reference',
    });
    expect(SHARED_PRICE_NOTE).toMatch(/mark price/);
  });

  it('refuses a protective stop trigger at or above entry', () => {
    expect(errorsOf({ stopTrigger: '1' }).errors.stopTrigger).toMatch(/below the entry/);
  });
});

describe('simulatePerpetualLong: validation', () => {
  it('lists every missing required input and gives no figure', () => {
    const check = simulatePerpetualLong(EMPTY_PERPETUAL);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.missing).toEqual([
      'collateral',
      'size',
      'entry',
      'exit',
      'entryFeePercent',
      'exitFeePercent',
      'carryingCost',
      'maintenanceRatePercent',
      'maintenanceAmount',
      'bracketFloor',
      'bracketCap',
    ]);
    expect(check).not.toHaveProperty('scenario');
  });

  it.each<[Partial<PerpetualInputs>, string, RegExp]>([
    [{ collateral: '0' }, 'collateral', /greater than 0/],
    [{ size: '1,000' }, 'size', /plain decimal/],
    [{ entry: '-1' }, 'entry', /positive/],
    [{ exit: '0.000000001' }, 'exit', /8 decimal/],
    [{ entryFeePercent: '100' }, 'entryFeePercent', /below 100/],
    [{ exitFeePercent: '0.00001' }, 'exitFeePercent', /4 decimal/],
    [{ maintenanceRatePercent: '100' }, 'maintenanceRatePercent', /below 100/],
    [{ carryingCost: '--1' }, 'carryingCost', /plain decimal/],
    [{ carryingCost: '+1' }, 'carryingCost', /plain decimal/],
    [{ carryingCost: '-' }, 'carryingCost', /plain decimal/],
    [{ carryingCost: '-1000000001' }, 'carryingCost', /outside/],
    [{ bracketCap: '0' }, 'bracketCap', /above the bracket floor/],
    [{ size: '1000000001' }, 'size', /outside/],
  ])('refuses %j', (inputs, field, message) => {
    const errors: Record<string, string | undefined> = errorsOf(inputs).errors;
    expect(errors[field]).toMatch(message);
  });

  it('accepts a negative zero carrying cost as zero', () => {
    expect(scenarioOf({ carryingCost: '-0' }).carryingCost).toBe('0');
  });
});

describe('simulatePerpetualLong: Spot comparison, same quantity and zero costs only', () => {
  it('matches the Spot planner’s absolute loss; only the denominator differs', () => {
    // Equivalent sizing: a 50 USDT cash buy of 50 units at 1 versus notional 50 on 10 collateral.
    const spot = planSpotScenario({
      ...EMPTY_SCENARIO,
      allocation: '50',
      maxLoss: '50',
      entry: '1',
      stop: '0.96',
    });
    if (!spot.ok) throw new Error(JSON.stringify(spot));
    const perpetual = scenarioOf({});
    expect(perpetual.quantity).toBe(spot.scenario.quantity);
    expect(spot.scenario.lossAtStop).toBe('2.00');
    expect(perpetual.netResult).toBe('-2');
    // The same 2 is 4% of 50 in cash and 20% of 10 in collateral.
    expect(perpetual.collateralChangePercent).toBe('-20');
  });
});
