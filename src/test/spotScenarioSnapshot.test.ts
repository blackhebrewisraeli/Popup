import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import {
  planSpotScenario,
  SPOT_SCENARIO_CALCULATION,
  type ScenarioInputs,
} from '@/lib/spotScenario';
import {
  readScenarioSnapshot,
  scenarioSnapshot,
  type ScenarioSnapshot,
} from '@/lib/spotScenarioSnapshot';

/** Invented inputs: a small-price pair, as a PEPE-sized quote would be. */
const SMALL: ScenarioInputs = {
  allocation: '15',
  maxLoss: '1',
  entry: '0.00000612',
  stop: '0.0000055',
  feePercent: '',
};

function snapshot(inputs: ScenarioInputs): ScenarioSnapshot {
  const result = scenarioSnapshot(inputs);
  if (typeof result === 'string') throw new Error(result);
  return result;
}

/** What a stored snapshot looks like after a database round trip. */
const stored = (value: unknown) => JSON.parse(JSON.stringify(value)) as Json;

describe('taking a scenario snapshot', () => {
  it('keeps the input strings and the figures the planner shows, without working anything out again', () => {
    const check = planSpotScenario(SMALL);
    if (!check.ok) throw new Error('scenario');
    expect(snapshot(SMALL)).toEqual({
      version: 1,
      calculationVersion: 'spot-scenario-1',
      inputs: {
        allocation: '15',
        maxLoss: '1',
        entry: '0.00000612',
        stop: '0.0000055',
        feePercent: null,
      },
      figures: {
        quantity: '1,612,903.22580645',
        limitedBy: 'maxLoss',
        notional: '9.87',
        unallocated: '5.13',
        stopDistance: '0.00000062',
        stopDistancePercent: '10.13%',
        lossAtStop: '1.00',
        fees: null,
      },
    });
    // Exactly the planner's own figures, field for field.
    expect(snapshot(SMALL).figures).toEqual(check.scenario);
    expect(SPOT_SCENARIO_CALCULATION).toBe('spot-scenario-1');
  });

  it('keeps an unspecified fee apart from a stated zero', () => {
    const unspecified = snapshot(SMALL);
    const zero = snapshot({ ...SMALL, feePercent: '0' });
    expect(unspecified.inputs.feePercent).toBeNull();
    expect(unspecified.figures.fees).toBeNull();
    expect(zero.inputs.feePercent).toBe('0');
    expect(zero.figures.fees).toEqual({ entry: '0.00', exit: '0.00', lossWithFees: '1.00' });
    // Every other figure is the same: the fee is only stated, not charged.
    expect({ ...zero.figures, fees: null }).toEqual(unspecified.figures);
  });

  it('stores the trimmed text the planner read, digits untouched by any number conversion', () => {
    const typed = snapshot({
      allocation: ' 1000 ',
      maxLoss: '1000',
      entry: '1000000000',
      stop: '0.00000001',
      feePercent: ' 1.0000 ',
    });
    expect(typed.inputs).toEqual({
      allocation: '1000',
      maxLoss: '1000',
      entry: '1000000000',
      stop: '0.00000001',
      feePercent: '1.0000',
    });
    expect(typed.figures).toMatchObject({
      quantity: '0.00000099',
      stopDistance: '999,999,999.99999999',
      stopDistancePercent: '100.00%',
      fees: { entry: '9.90', exit: '<0.01', lossWithFees: '999.90' },
    });
    // 17 significant digits would not survive a double.
    expect(snapshot({ ...SMALL, entry: '12345678.12345678', stop: '1' }).inputs.entry).toBe(
      '12345678.12345678',
    );
  });

  it('is frozen: the review holds one copy that nothing can change', () => {
    const copy = snapshot({ ...SMALL, feePercent: '0.075' });
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.inputs)).toBe(true);
    expect(Object.isFrozen(copy.figures)).toBe(true);
    expect(Object.isFrozen(copy.figures.fees)).toBe(true);
  });

  it('refuses an incomplete, invalid or overlong scenario instead of guessing', () => {
    const incomplete = scenarioSnapshot({ ...SMALL, stop: '' });
    expect(incomplete).toMatch(/^Complete Plan a hypothetical scenario with valid inputs first/);
    expect(scenarioSnapshot({ ...SMALL, stop: '0.00000612' })).toEqual(incomplete);
    expect(scenarioSnapshot({ ...SMALL, entry: '0.000006123' })).toEqual(incomplete);
    expect(scenarioSnapshot({ ...SMALL, feePercent: '0' })).not.toBeTypeOf('string');
    expect(scenarioSnapshot({ ...SMALL, allocation: `${'0'.repeat(31)}15` })).toMatch(
      /longer than 32 characters/,
    );
  });
});

describe('reading a stored scenario snapshot', () => {
  it('reads none for an experiment recorded without one', () => {
    expect(readScenarioSnapshot(null)).toEqual({ state: 'none' });
  });

  it('reads back exactly what was stored', () => {
    for (const fee of ['', '0', '0.075']) {
      const copy = snapshot({ ...SMALL, feePercent: fee });
      expect(readScenarioSnapshot(stored(copy))).toEqual({ state: 'recorded', snapshot: copy });
    }
  });

  it('names a format or calculation it does not read, and shows none of it', () => {
    const copy = stored(snapshot(SMALL)) as Record<string, Json>;
    expect(readScenarioSnapshot({ ...copy, version: 2 })).toEqual({
      state: 'unsupported',
      version: 'format 2, calculation spot-scenario-1',
    });
    expect(readScenarioSnapshot({ ...copy, calculationVersion: 'spot-scenario-2' })).toEqual({
      state: 'unsupported',
      version: 'format 1, calculation spot-scenario-2',
    });
  });

  it('treats anything that is not a snapshot as malformed', () => {
    const copy = stored(snapshot({ ...SMALL, feePercent: '0' })) as {
      [key: string]: Json;
      inputs: { [key: string]: Json };
      figures: { [key: string]: Json };
    };
    const malformed = [
      [],
      'scenario',
      { ...copy, version: '1' },
      { ...copy, extra: true },
      { ...copy, inputs: [] },
      { ...copy, inputs: { ...copy.inputs, allocation: 15 } },
      { ...copy, inputs: { ...copy.inputs, feePercent: null } },
      { ...copy, figures: { ...copy.figures, fees: null } },
      { ...copy, figures: { ...copy.figures, limitedBy: 'target' } },
      { ...copy, figures: { ...copy.figures, lossAtStop: undefined } },
      { ...copy, figures: { ...copy.figures, fees: { entry: '0.00' } } },
    ];
    for (const value of malformed) {
      expect(readScenarioSnapshot(stored(value))).toEqual({ state: 'malformed' });
    }
  });
});
