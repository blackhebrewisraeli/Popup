/**
 * The optional scenario snapshot a Manual Spot experiment can carry
 * (docs/MANUAL_SPOT_EXPERIMENTS.md#scenario-snapshot): the owner's input strings and the figures
 * `planSpotScenario` showed in the review, kept as text. A client-submitted planning record: not a
 * rule, an order, a balance or an execution. The database checks its shape, never its arithmetic,
 * and a stored snapshot is shown as stored, never worked out again.
 */
import type { Json } from '@/integrations/supabase/types';
import {
  planSpotScenario,
  SPOT_SCENARIO_CALCULATION,
  type LimitedBy,
  type ScenarioField,
  type ScenarioInputs,
} from '@/lib/spotScenario';

/** Type aliases, not interfaces, so a snapshot is assignable to the JSON column. */
export type ScenarioSnapshotFigures = {
  readonly quantity: string;
  readonly limitedBy: LimitedBy;
  readonly notional: string;
  readonly unallocated: string;
  readonly stopDistance: string;
  readonly stopDistancePercent: string;
  readonly lossAtStop: string;
  readonly fees: {
    readonly entry: string;
    readonly exit: string;
    readonly lossWithFees: string;
  } | null;
};

export type ScenarioSnapshot = {
  /** The snapshot's format. */
  readonly version: 1;
  /** The scenario calculation behind `figures` (`SPOT_SCENARIO_CALCULATION`), not the model's version. */
  readonly calculationVersion: string;
  /**
   * The owner's inputs as the calculation read them (trimmed), never passed through a number. An
   * unspecified fee is null; "0" is a stated zero.
   */
  readonly inputs: {
    readonly allocation: string;
    readonly maxLoss: string;
    readonly entry: string;
    readonly stop: string;
    readonly feePercent: string | null;
  };
  /** The figures as shown: display text (grouped digits, cents, "<0.01", a percent), not amounts. */
  readonly figures: ScenarioSnapshotFigures;
};

/** The longest input string the database stores. */
export const MAX_SNAPSHOT_INPUT = 32;

const AMOUNT_FIELDS = ['allocation', 'maxLoss', 'entry', 'stop'] as const;
const INPUT_FIELDS: readonly ScenarioField[] = [...AMOUNT_FIELDS, 'feePercent'];
const FIGURE_TEXT = [
  'quantity',
  'notional',
  'unallocated',
  'stopDistance',
  'stopDistancePercent',
  'lossAtStop',
] as const;
const FEE_TEXT = ['entry', 'exit', 'lossWithFees'] as const;
const LIMITED_BY: readonly string[] = ['allocation', 'maxLoss', 'both'] satisfies LimitedBy[];

/**
 * A frozen copy of the scenario these inputs give now, or why it cannot be included. Nothing is
 * worked out here that `planSpotScenario` does not already show.
 */
export function scenarioSnapshot(inputs: ScenarioInputs): ScenarioSnapshot | string {
  const check = planSpotScenario(inputs);
  if (!check.ok) {
    return 'Complete Plan a hypothetical scenario with valid inputs first, or leave the scenario out of the record.';
  }
  const typed = (field: ScenarioField) => inputs[field].trim();
  if (INPUT_FIELDS.some((field) => typed(field).length > MAX_SNAPSHOT_INPUT)) {
    return `An input is longer than ${MAX_SNAPSHOT_INPUT} characters, more than the record stores. Shorten it, or leave the scenario out.`;
  }
  const { scenario } = check;
  return Object.freeze({
    version: 1,
    calculationVersion: SPOT_SCENARIO_CALCULATION,
    inputs: Object.freeze({
      allocation: typed('allocation'),
      maxLoss: typed('maxLoss'),
      entry: typed('entry'),
      stop: typed('stop'),
      feePercent: typed('feePercent') === '' ? null : typed('feePercent'),
    }),
    figures: Object.freeze({
      quantity: scenario.quantity,
      limitedBy: scenario.limitedBy,
      notional: scenario.notional,
      unallocated: scenario.unallocated,
      stopDistance: scenario.stopDistance,
      stopDistancePercent: scenario.stopDistancePercent,
      lossAtStop: scenario.lossAtStop,
      fees: scenario.fees && Object.freeze({ ...scenario.fees }),
    }),
  });
}

export type StoredScenario =
  | { state: 'none' }
  | { state: 'recorded'; snapshot: ScenarioSnapshot }
  /** A snapshot in a format or calculation this view does not read. */
  | { state: 'unsupported'; version: string }
  /** Something is stored, but not a snapshot. */
  | { state: 'malformed' };

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** Exactly these keys: `strings` hold strings, `others` are checked by the caller. */
const shaped = (value: Fields, strings: readonly string[], others: readonly string[] = []) =>
  Object.keys(value).length === strings.length + others.length &&
  strings.every((key) => typeof value[key] === 'string') &&
  others.every((key) => key in value);

/** A stored snapshot read back. Null, as on every experiment recorded without one, is `none`. */
export function readScenarioSnapshot(value: Json | null): StoredScenario {
  if (value === null) return { state: 'none' };
  if (!isFields(value)) return { state: 'malformed' };
  const version = value['version'];
  const calculation = value['calculationVersion'];
  if (typeof version !== 'number') return { state: 'malformed' };
  if (version !== 1 || calculation !== SPOT_SCENARIO_CALCULATION) {
    const named = typeof calculation === 'string' ? calculation : 'not named';
    return { state: 'unsupported', version: `format ${version}, calculation ${named}` };
  }
  const inputs = value['inputs'];
  const figures = value['figures'];
  if (!isFields(inputs) || !isFields(figures)) return { state: 'malformed' };
  const fee = inputs['feePercent'];
  const fees = figures['fees'];
  const valid =
    shaped(value, ['calculationVersion'], ['version', 'inputs', 'figures']) &&
    shaped(inputs, AMOUNT_FIELDS, ['feePercent']) &&
    (fee === null || typeof fee === 'string') &&
    shaped(figures, FIGURE_TEXT, ['limitedBy', 'fees']) &&
    LIMITED_BY.includes(figures['limitedBy'] as string) &&
    (fees === null || (isFields(fees) && shaped(fees, FEE_TEXT))) &&
    // A fee was assumed, "0" included, exactly when the figures carry fees.
    (fee === null) === (fees === null);
  return valid
    ? { state: 'recorded', snapshot: value as unknown as ScenarioSnapshot }
    : { state: 'malformed' };
}
