import {
  issue,
  validatePrices,
  type CandleIssue,
  type DailyCandle as Candle,
} from '@/lib/candleValidation';

/**
 * Research candidate, not a strategy: describes swing structure on a supplied closed-candle
 * series, exactly as docs/MANUAL_SPOT_EXPERIMENTS.md#research-candidate-swing-structure-swing-structure-direction-010
 * specifies. Offline only; nothing in the app, worker, Pine or experiments calls it.
 */
export const SWING_STRUCTURE_CANDIDATE_ID = 'swing-structure-direction';
export const SWING_STRUCTURE_CANDIDATE_VERSION = '0.1.0';

export interface SwingStructureTimeframe {
  label: string;
  intervalMs: number;
}

export interface SwingStructureConfig {
  leftBars: number;
  rightBars: number;
}

export interface SwingPivot {
  kind: 'high' | 'low';
  price: number;
  /** Open time of the pivot's own candle. */
  candleOpenTime: number;
  /** Close time of the rightBars-th following candle: the earliest moment the pivot is known. */
  availableAt: number;
}

export interface ReferenceBreach {
  field: 'close' | 'low' | 'high';
  price: number;
  candleOpenTime: number;
  knowableAt: number;
}

export type StructureDirection = 'Up' | 'Down' | 'Unclear';
export type StructureReason =
  | 'INSUFFICIENT_CONFIRMED_PIVOTS'
  | 'EQUAL_PIVOT_LEVEL'
  | 'HIGHER_HIGH_AND_HIGHER_LOW'
  | 'LOWER_HIGH_AND_LOWER_LOW'
  | 'MIXED_STRUCTURE';

interface ObservationBase {
  candidateId: typeof SWING_STRUCTURE_CANDIDATE_ID;
  candidateVersion: typeof SWING_STRUCTURE_CANDIDATE_VERSION;
  config: SwingStructureConfig;
  timeframe: SwingStructureTimeframe;
  cutoff: number;
}

export type SwingStructureObservation =
  | (ObservationBase & { status: 'INVALID_INPUT'; issues: CandleIssue[] })
  | (ObservationBase & {
      status: 'INSUFFICIENT' | 'EVALUATED';
      closedCandles: number;
      latestCloseTime: number | null;
      direction: StructureDirection;
      reason: StructureReason;
      establishedAt: number | null;
      supportingHighs: SwingPivot[];
      supportingLows: SwingPivot[];
      reference: SwingPivot | null;
      breach: { firstClose: ReferenceBreach | null; firstExtreme: ReferenceBreach | null } | null;
    });

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer; received ${String(value)}.`);
  }
}

/**
 * Selects the candles closed by the cutoff, in supplied order, and reports every defect among
 * them. Closure follows the stated interval, as in candleValidation, so a malformed closeTime can
 * neither admit a later candle nor hide a used one. Nothing is sorted, deduplicated or filled.
 */
function closedCandles(
  candles: readonly Candle[],
  intervalMs: number,
  cutoff: number,
): { closed: Candle[]; issues: CandleIssue[] } {
  const closed: Candle[] = [];
  const issues: CandleIssue[] = [];
  candles.forEach((candle, index) => {
    if (!Number.isSafeInteger(candle.timestamp) || candle.timestamp <= 0) {
      // Cannot be placed before or after the cutoff, so it is never silently skipped.
      issues.push(
        issue('INVALID_TIMESTAMP', index, candle, 'Open time must be a positive integer.'),
      );
      return;
    }
    const end = candle.timestamp + intervalMs - 1;
    if (end > cutoff) return;
    if (candle.closeTime !== end) {
      issues.push(
        issue(
          'CLOSE_TIME_CONVENTION_MISMATCH',
          index,
          candle,
          `Close time must be open time plus ${intervalMs - 1} ms for the stated timeframe.`,
        ),
      );
    }
    issues.push(...validatePrices(candle, index));
    const previous = closed.at(-1);
    if (previous) {
      const step = candle.timestamp - previous.timestamp;
      if (step === 0) {
        issues.push(
          issue(
            'DUPLICATE_TIMESTAMP',
            index,
            candle,
            'Open times must be unique.',
            previous.timestamp,
          ),
        );
      } else if (step < 0) {
        issues.push(
          issue(
            'TIMESTAMP_OUT_OF_ORDER',
            index,
            candle,
            'Candles must be supplied oldest first.',
            previous.timestamp,
          ),
        );
      } else if (step !== intervalMs) {
        issues.push(
          issue(
            'MISSING_INTERVAL',
            index,
            candle,
            `Expected a ${intervalMs} ms step; received ${step} ms.`,
            previous.timestamp,
          ),
        );
      }
    }
    closed.push(candle);
  });
  return { closed, issues };
}

/** Pivots confirmed by the candles supplied: a pivot exists only once its right bars closed. */
function confirmedPivots(
  closed: readonly Candle[],
  { leftBars, rightBars }: SwingStructureConfig,
): { highs: SwingPivot[]; lows: SwingPivot[] } {
  const highs: SwingPivot[] = [];
  const lows: SwingPivot[] = [];
  closed.forEach((candle, i) => {
    const confirmation = closed[i + rightBars];
    if (i < leftBars || !confirmation) return;
    const left = closed.slice(i - leftBars, i);
    const right = closed.slice(i + 1, i + 1 + rightBars);
    const timing = { candleOpenTime: candle.timestamp, availableAt: confirmation.closeTime };
    // Strict on the left, inclusive on the right: a plateau's first bar is the pivot.
    if (left.every((c) => c.high < candle.high) && right.every((c) => c.high <= candle.high)) {
      highs.push({ kind: 'high', price: candle.high, ...timing });
    }
    if (left.every((c) => c.low > candle.low) && right.every((c) => c.low >= candle.low)) {
      lows.push({ kind: 'low', price: candle.low, ...timing });
    }
  });
  return { highs, lows };
}

function classify(
  [h1, h2]: SwingPivot[],
  [l1, l2]: SwingPivot[],
): { direction: StructureDirection; reason: StructureReason } {
  if (!h1 || !h2 || !l1 || !l2) {
    return { direction: 'Unclear', reason: 'INSUFFICIENT_CONFIRMED_PIVOTS' };
  }
  if (h2.price === h1.price || l2.price === l1.price) {
    return { direction: 'Unclear', reason: 'EQUAL_PIVOT_LEVEL' };
  }
  if (h2.price > h1.price && l2.price > l1.price) {
    return { direction: 'Up', reason: 'HIGHER_HIGH_AND_HIGHER_LOW' };
  }
  if (h2.price < h1.price && l2.price < l1.price) {
    return { direction: 'Down', reason: 'LOWER_HIGH_AND_LOWER_LOW' };
  }
  return { direction: 'Unclear', reason: 'MIXED_STRUCTURE' };
}

/** Breach facts on candles that opened after the reference became known. Never an action. */
function referenceBreach(
  closed: readonly Candle[],
  reference: SwingPivot,
): { firstClose: ReferenceBreach | null; firstExtreme: ReferenceBreach | null } {
  const later = closed.filter((c) => c.timestamp > reference.availableAt);
  const beyond = (price: number) =>
    reference.kind === 'low' ? price < reference.price : price > reference.price;
  const event = (candle: Candle | undefined, field: ReferenceBreach['field']) =>
    candle
      ? {
          field,
          price: candle[field],
          candleOpenTime: candle.timestamp,
          knowableAt: candle.closeTime,
        }
      : null;
  return {
    firstClose: event(
      later.find((c) => beyond(c.close)),
      'close',
    ),
    firstExtreme: event(
      later.find((c) => beyond(c[reference.kind])),
      reference.kind,
    ),
  };
}

export function evaluateSwingStructure(input: {
  candles: readonly Candle[];
  timeframe: SwingStructureTimeframe;
  config: SwingStructureConfig;
  cutoff: number;
}): SwingStructureObservation {
  const { candles, timeframe, config, cutoff } = input;
  if (typeof timeframe.label !== 'string' || timeframe.label.trim() === '') {
    throw new RangeError('timeframe.label must be stated.');
  }
  requirePositiveInteger('timeframe.intervalMs', timeframe.intervalMs);
  requirePositiveInteger('config.leftBars', config.leftBars);
  requirePositiveInteger('config.rightBars', config.rightBars);
  if (!Number.isSafeInteger(cutoff)) throw new RangeError('cutoff must be an integer epoch ms.');

  const base: ObservationBase = {
    candidateId: SWING_STRUCTURE_CANDIDATE_ID,
    candidateVersion: SWING_STRUCTURE_CANDIDATE_VERSION,
    config: { leftBars: config.leftBars, rightBars: config.rightBars },
    timeframe: { label: timeframe.label, intervalMs: timeframe.intervalMs },
    cutoff,
  };
  const { closed, issues } = closedCandles(candles, timeframe.intervalMs, cutoff);
  if (issues.length > 0) return { ...base, status: 'INVALID_INPUT', issues };

  const { highs, lows } = confirmedPivots(closed, config);
  const supportingHighs = highs.slice(-2);
  const supportingLows = lows.slice(-2);
  const { direction, reason } = classify(supportingHighs, supportingLows);
  const insufficient = reason === 'INSUFFICIENT_CONFIRMED_PIVOTS';
  let reference: SwingPivot | null = null;
  if (direction === 'Up') reference = supportingLows.at(-1) ?? null;
  if (direction === 'Down') reference = supportingHighs.at(-1) ?? null;

  return {
    ...base,
    status: insufficient ? 'INSUFFICIENT' : 'EVALUATED',
    closedCandles: closed.length,
    latestCloseTime: closed.at(-1)?.closeTime ?? null,
    direction,
    reason,
    establishedAt: insufficient
      ? null
      : Math.max(...[...supportingHighs, ...supportingLows].map((p) => p.availableAt)),
    supportingHighs,
    supportingLows,
    reference,
    breach: reference ? referenceBreach(closed, reference) : null,
  };
}
