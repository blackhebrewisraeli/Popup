import { describe, expect, it } from 'vitest';
import {
  decimalInput,
  EMPTY_SCENARIO,
  planSpotScenario,
  type ScenarioInputs,
} from '@/lib/spotScenario';

/** Labeled synthetic inputs: no value here is a quote, a balance or a recommendation. */
const plan = (inputs: Partial<ScenarioInputs>) =>
  planSpotScenario({ ...EMPTY_SCENARIO, ...inputs });
const base = { allocation: '1000', maxLoss: '50', entry: '100', stop: '90' };

function scenarioOf(inputs: Partial<ScenarioInputs>) {
  const check = plan(inputs);
  if (!check.ok) throw new Error(JSON.stringify(check));
  return check.scenario;
}

function errorsOf(inputs: Partial<ScenarioInputs>) {
  const check = plan(inputs);
  if (check.ok) throw new Error('expected validation errors');
  return check;
}

describe('planSpotScenario: sizing', () => {
  it('is limited by the loss budget when the stop distance would lose more', () => {
    expect(scenarioOf(base)).toEqual({
      quantity: '5',
      limitedBy: 'maxLoss',
      notional: '500.00',
      unallocated: '500.00',
      stopDistance: '10',
      stopDistancePercent: '10.00%',
      lossAtStop: '50.00',
      fees: null,
    });
  });

  it('is limited by the allocation when the loss budget would buy more', () => {
    expect(scenarioOf({ ...base, maxLoss: '200' })).toMatchObject({
      quantity: '10',
      limitedBy: 'allocation',
      notional: '1,000.00',
      unallocated: '0.00',
      lossAtStop: '100.00',
    });
  });

  it('names both limits when they meet exactly', () => {
    expect(scenarioOf({ ...base, maxLoss: '100' }).limitedBy).toBe('both');
  });

  it('floors a fractional quantity so it never exceeds the loss budget', () => {
    // 20 / 3,234.56 = 0.0061832241… BTC: floored, the exact loss is 19.9999960832 USDT.
    expect(
      scenarioOf({ allocation: '1000', maxLoss: '20', entry: '101234.56', stop: '98000' }),
    ).toEqual({
      quantity: '0.00618322',
      limitedBy: 'maxLoss',
      notional: '625.96',
      unallocated: '374.04',
      stopDistance: '3,234.56',
      stopDistancePercent: '3.20%',
      lossAtStop: '20.00',
      fees: null,
    });
  });

  it('keeps every digit of a small-price asset, where floating point would not', () => {
    const scenario = scenarioOf({
      allocation: '1000',
      maxLoss: '100',
      entry: '0.00000612',
      stop: '0.0000055',
    });
    expect(scenario).toEqual({
      quantity: '161,290,322.58064516',
      limitedBy: 'maxLoss',
      notional: '987.10',
      unallocated: '12.90',
      stopDistance: '0.00000062',
      stopDistancePercent: '10.13%',
      // Exactly 99.9999999999999992 USDT: within the budget, shown to the cent.
      lossAtStop: '100.00',
      fees: null,
    });
    // The same quantity as a double has already lost its last digit.
    expect(String(Number('161290322.58064516'))).not.toBe('161290322.58064516');
  });

  it('shows a positive amount below half a cent as "<0.01", never as zero', () => {
    expect(
      scenarioOf({ allocation: '0.01', maxLoss: '0.01', entry: '101234.56', stop: '100000' }),
    ).toMatchObject({ quantity: '0.00000009', notional: '0.01', lossAtStop: '<0.01' });
  });

  it('refuses a budget too small to buy one 1e-8 unit instead of showing zero', () => {
    expect(
      errorsOf({ allocation: '0.00000001', maxLoss: '0.00000001', entry: '101234.56', stop: '1' })
        .errors,
    ).toEqual({
      form: 'At this entry, the allocation or the loss budget buys less than 0.00000001 of the base asset.',
    });
  });
});

describe('planSpotScenario: fee assumption', () => {
  it('leaves fees unspecified by default and says so with null, not zero', () => {
    expect(scenarioOf(base).fees).toBeNull();
  });

  it('sizes within both budgets including an explicit fee per fill', () => {
    // 0.1% at entry and at the stop: 50 / (10 + 0.001 × 190) = 4.906771344… units.
    expect(scenarioOf({ ...base, feePercent: '0.1' })).toEqual({
      quantity: '4.90677134',
      limitedBy: 'maxLoss',
      notional: '490.68',
      // 1,000 − 490.677134 − 0.490677134 entry fee.
      unallocated: '508.83',
      stopDistance: '10',
      stopDistancePercent: '10.00%',
      lossAtStop: '49.07',
      fees: { entry: '0.49', exit: '0.44', lossWithFees: '50.00' },
    });
  });

  it('keeps notional plus the entry fee within the allocation', () => {
    const scenario = scenarioOf({ ...base, maxLoss: '1000', feePercent: '0.1' });
    // 1,000 / (100 × 1.001) = 9.99000999 units: 999.000999 + 0.999000999 fee ≤ 1,000.
    expect(scenario).toMatchObject({ quantity: '9.99000999', limitedBy: 'allocation' });
    expect(scenario.unallocated).toBe('<0.01');
  });

  it('treats an explicit 0% as an assumption, distinct from unspecified', () => {
    expect(scenarioOf({ ...base, feePercent: '0' }).fees).toEqual({
      entry: '0.00',
      exit: '0.00',
      lossWithFees: '50.00',
    });
  });

  it('refuses an excessive or malformed fee', () => {
    expect(errorsOf({ ...base, feePercent: '1.5' }).errors.feePercent).toBe(
      'Enter at most 1% per fill.',
    );
    expect(errorsOf({ ...base, feePercent: '0.00001' }).errors.feePercent).toBe(
      'Use at most 4 decimal places.',
    );
    expect(errorsOf({ ...base, feePercent: '-0.1' }).errors.feePercent).toBe(
      'Enter a positive number.',
    );
  });
});

describe('planSpotScenario: validation', () => {
  it('lists missing inputs and produces no figure', () => {
    expect(plan({})).toEqual({
      ok: false,
      missing: ['allocation', 'maxLoss', 'entry', 'stop'],
      errors: {},
    });
    expect(plan({ ...base, stop: '  ' })).toEqual({ ok: false, missing: ['stop'], errors: {} });
  });

  it('refuses a stop reference at or above entry', () => {
    const message =
      'Must be below the entry price: this planner covers a Spot buy, whose stop reference sits below entry.';
    expect(errorsOf({ ...base, stop: '100' }).errors).toEqual({ stop: message });
    expect(errorsOf({ ...base, stop: '100.00000001' }).errors).toEqual({ stop: message });
  });

  it.each([
    ['0', 'Must be greater than 0.'],
    ['0.00000000', 'Must be greater than 0.'],
    ['-5', 'Enter a positive number.'],
    ['Infinity', expect.stringMatching(/^Enter a plain decimal/)],
    ['NaN', expect.stringMatching(/^Enter a plain decimal/)],
    ['1e3', expect.stringMatching(/^Enter a plain decimal/)],
    ['1,000', expect.stringMatching(/^Enter a plain decimal/)],
    ['.', expect.stringMatching(/^Enter a plain decimal/)],
    ['1.123456789', 'Use at most 8 decimal places.'],
    ['1000000000.00000001', "Above 1,000,000,000 is outside this planner's range."],
  ])('refuses %j for every amount and price', (value, message) => {
    for (const field of ['allocation', 'maxLoss', 'entry', 'stop'] as const) {
      expect(errorsOf({ ...base, [field]: value }).errors[field]).toEqual(message);
    }
  });

  it('accepts a leading or trailing point and surrounding spaces', () => {
    expect(
      scenarioOf({ allocation: ' 1000. ', maxLoss: '50', entry: '100', stop: '.9' }),
    ).toMatchObject({ quantity: '0.50454086', limitedBy: 'maxLoss' });
  });

  it('refuses a loss budget above the allocation', () => {
    expect(errorsOf({ ...base, maxLoss: '1000.01' }).errors).toEqual({
      maxLoss: 'Cannot exceed the allocation: a Spot buy cannot lose more than it spends.',
    });
  });
});

describe('decimalInput', () => {
  it('writes a recorded close as a plain decimal, never an exponent', () => {
    expect(decimalInput(6.12e-7)).toBe('0.00000061');
    expect(decimalInput(101234.56)).toBe('101234.56');
    expect(decimalInput(38)).toBe('38');
  });
});
