import { describe, expect, it } from 'vitest';
import { formatCandleIssues, type DailyCandle as Candle } from '@/lib/candleValidation';
import {
  evaluateSwingStructure,
  SWING_STRUCTURE_CANDIDATE_ID,
  SWING_STRUCTURE_CANDIDATE_VERSION,
  type SwingStructureConfig,
  type SwingStructureObservation,
  type SwingStructureTimeframe,
} from './swingStructure';

// Every candle below is synthetic, and every configuration is a test input, not a setting.
const DAY = 86_400_000;
const FOUR_HOURS = 4 * 3_600_000;
const T0 = Date.UTC(2026, 0, 1);
const DAILY: SwingStructureTimeframe = { label: '1d', intervalMs: DAY };
const L1R1: SwingStructureConfig = { leftBars: 1, rightBars: 1 };
const L1R2: SwingStructureConfig = { leftBars: 1, rightBars: 2 };

type Bar = [high: number, low: number, close: number];

const openOf = (i: number, intervalMs = DAY) => T0 + i * intervalMs;
const closeOf = (i: number, intervalMs = DAY) => openOf(i + 1, intervalMs) - 1;

function series(bars: Bar[], intervalMs = DAY): Candle[] {
  return bars.map(([high, low, close], i) => ({
    timestamp: openOf(i, intervalMs),
    closeTime: closeOf(i, intervalMs),
    high,
    low,
    close,
  }));
}

/** The same shape upside down around 15: highs become lows. */
const mirror = (bars: Bar[]): Bar[] =>
  bars.map(([high, low, close]) => [30 - low, 30 - high, 30 - close]);

function evaluate(
  candles: Candle[],
  cutoff: number,
  config: SwingStructureConfig,
  timeframe = DAILY,
): SwingStructureObservation {
  return evaluateSwingStructure({ candles, timeframe, config, cutoff });
}

function valid(observation: SwingStructureObservation) {
  if (observation.status === 'INVALID_INPUT') {
    throw new Error(formatCandleIssues(observation.issues));
  }
  return observation;
}

const pivot = (kind: 'high' | 'low', price: number, day: number, knownDay: number) => ({
  kind,
  price,
  candleOpenTime: openOf(day),
  availableAt: closeOf(knownDay),
});

// The documented walkthrough: D0–D5 rise; D7 trades below the D4 higher low; D8 closes below it.
const WALKTHROUGH: Bar[] = [
  [10, 8, 9],
  [12, 10, 11],
  [11, 9, 10],
  [14, 11, 12.5],
  [13, 10, 11.5],
  [15, 12, 13.5],
  [12, 10.5, 11],
  [11, 9.5, 10.2],
  [10.4, 9, 9.4],
  [10, 9.2, 9.6],
];

describe('swing-structure-direction 0.1.0 (synthetic candles)', () => {
  it('1. reads rising confirmed highs and lows as Up, with the latest higher low as reference', () => {
    const observation = valid(evaluate(series(WALKTHROUGH.slice(0, 6)), closeOf(5), L1R1));

    expect(observation).toMatchObject({
      status: 'EVALUATED',
      direction: 'Up',
      reason: 'HIGHER_HIGH_AND_HIGHER_LOW',
      establishedAt: closeOf(5),
      supportingHighs: [pivot('high', 12, 1, 2), pivot('high', 14, 3, 4)],
      supportingLows: [pivot('low', 9, 2, 3), pivot('low', 10, 4, 5)],
      reference: pivot('low', 10, 4, 5),
      breach: { firstClose: null, firstExtreme: null },
    });
  });

  it('2. reads falling confirmed highs and lows as Down, with the latest lower high as reference', () => {
    const observation = valid(evaluate(series(mirror(WALKTHROUGH).slice(0, 6)), closeOf(5), L1R1));

    expect(observation).toMatchObject({
      status: 'EVALUATED',
      direction: 'Down',
      reason: 'LOWER_HIGH_AND_LOWER_LOW',
      establishedAt: closeOf(5),
      supportingHighs: [pivot('high', 21, 2, 3), pivot('high', 20, 4, 5)],
      supportingLows: [pivot('low', 18, 1, 2), pivot('low', 16, 3, 4)],
      reference: pivot('high', 20, 4, 5),
      breach: { firstClose: null, firstExtreme: null },
    });
  });

  it.each<[string, Bar[]]>([
    [
      'higher high with a lower low',
      [
        [10, 8, 9],
        [12, 10, 11],
        [11, 9, 10],
        [14, 11, 12.5],
        [13, 7, 8],
        [15, 8, 14],
      ],
    ],
    [
      'lower high with a higher low',
      [
        [10, 8, 9],
        [14, 10, 12],
        [11, 9, 10],
        [13, 11, 12],
        [12, 10, 11],
        [13.5, 11, 12],
      ],
    ],
  ])('3. reads mixed structure (%s) as Unclear, with no reference', (_, bars) => {
    const observation = valid(evaluate(series(bars), closeOf(5), L1R1));

    expect(observation).toMatchObject({
      status: 'EVALUATED',
      direction: 'Unclear',
      reason: 'MIXED_STRUCTURE',
      reference: null,
      breach: null,
    });
    expect(observation.supportingHighs).toHaveLength(2);
    expect(observation.supportingLows).toHaveLength(2);
  });

  describe('4. equal prices, plateaus and bars that qualify as both', () => {
    it('keeps two separate equal pivot highs and reads them as Unclear, not Up', () => {
      const observation = valid(
        evaluate(
          series([
            [10, 8, 9],
            [12, 10, 11],
            [11, 9, 10],
            [12, 11, 11.5],
            [11.5, 10, 11],
            [13, 10.5, 12],
          ]),
          closeOf(5),
          L1R1,
        ),
      );

      expect(observation).toMatchObject({
        direction: 'Unclear',
        reason: 'EQUAL_PIVOT_LEVEL',
        supportingHighs: [pivot('high', 12, 1, 2), pivot('high', 12, 3, 4)],
        supportingLows: [pivot('low', 9, 2, 3), pivot('low', 10, 4, 5)],
        reference: null,
      });
    });

    it('makes only the first bar of a high plateau the pivot high', () => {
      const observation = valid(
        evaluate(
          series([
            [10, 8, 9],
            [12, 10, 11],
            [12, 10.5, 11],
            [11, 9, 10],
          ]),
          closeOf(3),
          L1R2,
        ),
      );

      expect(observation.supportingHighs).toEqual([pivot('high', 12, 1, 3)]);
    });

    it('makes only the first bar of a low plateau the pivot low', () => {
      const observation = valid(
        evaluate(
          series([
            [20, 18, 19],
            [18, 16, 17],
            [18.5, 16, 17],
            [19, 17, 18],
          ]),
          closeOf(3),
          L1R2,
        ),
      );

      expect(observation.supportingLows).toEqual([pivot('low', 16, 1, 3)]);
    });

    it('lists an outside bar in both the high and the low pivots', () => {
      const observation = valid(
        evaluate(
          series([
            [10, 8, 9],
            [12, 6, 7],
            [11, 7, 10],
          ]),
          closeOf(2),
          L1R1,
        ),
      );

      expect(observation.supportingHighs).toEqual([pivot('high', 12, 1, 2)]);
      expect(observation.supportingLows).toEqual([pivot('low', 6, 1, 2)]);
    });
  });

  it('5. reports fewer than two confirmed highs or lows as INSUFFICIENT, never a direction', () => {
    const twoHighsOneLow = valid(evaluate(series(WALKTHROUGH.slice(0, 5)), closeOf(4), L1R1));
    expect(twoHighsOneLow).toMatchObject({
      status: 'INSUFFICIENT',
      direction: 'Unclear',
      reason: 'INSUFFICIENT_CONFIRMED_PIVOTS',
      establishedAt: null,
      reference: null,
      breach: null,
    });
    expect(twoHighsOneLow.supportingHighs).toHaveLength(2);
    expect(twoHighsOneLow.supportingLows).toHaveLength(1);

    expect(valid(evaluate([], closeOf(4), L1R1))).toMatchObject({
      status: 'INSUFFICIENT',
      closedCandles: 0,
      latestCloseTime: null,
      supportingHighs: [],
      supportingLows: [],
    });
  });

  it('6. never reports a provisional pivot that a right-window candle exceeds before confirmation', () => {
    const candles = series([
      [10, 8, 9],
      [12, 10, 11], // provisional high after D2...
      [11, 9, 10],
      [13, 10, 12], // ...exceeded on D3, inside its two-candle right window
      [12, 10.5, 11],
      [11, 9.8, 10],
    ]);

    const provisional = valid(evaluate(candles, closeOf(2), L1R2));
    const exceeded = valid(evaluate(candles, closeOf(3), L1R2));
    const later = valid(evaluate(candles, closeOf(5), L1R2));

    expect(provisional.supportingHighs).toEqual([]);
    expect(exceeded.supportingHighs).toEqual([]);
    // In hindsight the D1 high still does not appear; D3's high is dated by its own confirmation.
    expect(later.supportingHighs).toEqual([pivot('high', 13, 3, 5)]);
  });

  it('7. reports a pivot only from the close of its last right-window candle', () => {
    const candles = series([
      [10, 8, 9],
      [12, 10, 11],
      [11, 9, 10],
      [11.5, 9.5, 10.5],
    ]);

    const oneMsBefore = valid(evaluate(candles, closeOf(3) - 1, L1R2));
    const atClose = valid(evaluate(candles, closeOf(3), L1R2));

    expect(oneMsBefore).toMatchObject({ closedCandles: 3, latestCloseTime: closeOf(2) });
    expect(oneMsBefore.supportingHighs).toEqual([]);
    expect(atClose.supportingHighs).toEqual([
      { kind: 'high', price: 12, candleOpenTime: openOf(1), availableAt: closeOf(3) },
    ]);
    // Never backdated: known two full candles after its own candle closed.
    expect(atClose.supportingHighs[0]?.availableAt).toBe(closeOf(1) + 2 * DAY);
  });

  describe('8. a reference breach is reported apart from direction and never as an action', () => {
    const candles = series(WALKTHROUGH);

    it('reports the first trade and the first close below a higher low while the direction stays Up', () => {
      const beforeBreach = valid(evaluate(candles, closeOf(6), L1R1));
      const traded = valid(evaluate(candles, closeOf(7), L1R1));
      const closedBelow = valid(evaluate(candles, closeOf(8), L1R1));

      expect(beforeBreach).toMatchObject({
        direction: 'Up',
        breach: { firstClose: null, firstExtreme: null },
      });
      const firstExtreme = {
        field: 'low',
        price: 9.5,
        candleOpenTime: openOf(7),
        knowableAt: closeOf(7),
      };
      expect(traded).toMatchObject({
        direction: 'Up',
        breach: { firstClose: null, firstExtreme },
      });
      expect(closedBelow).toMatchObject({
        status: 'EVALUATED',
        direction: 'Up',
        reason: 'HIGHER_HIGH_AND_HIGHER_LOW',
        reference: pivot('low', 10, 4, 5),
        breach: {
          firstClose: {
            field: 'close',
            price: 9.4,
            candleOpenTime: openOf(8),
            knowableAt: closeOf(8),
          },
          firstExtreme,
        },
      });
      // Descriptive fields only: no action, side, order, stop or sizing field exists.
      expect(Object.keys(closedBelow).sort()).toEqual(
        [
          'breach',
          'candidateId',
          'candidateVersion',
          'closedCandles',
          'config',
          'cutoff',
          'direction',
          'establishedAt',
          'latestCloseTime',
          'reason',
          'reference',
          'status',
          'supportingHighs',
          'supportingLows',
          'timeframe',
        ].sort(),
      );
    });

    it('changes direction only when a new pivot confirms, and then to Unclear, not Down', () => {
      const observation = valid(evaluate(candles, closeOf(9), L1R1));

      expect(observation).toMatchObject({
        direction: 'Unclear',
        reason: 'MIXED_STRUCTURE',
        establishedAt: closeOf(9),
        supportingLows: [pivot('low', 10, 4, 5), pivot('low', 9, 8, 9)],
        reference: null,
        breach: null,
      });
    });

    it('reports the mirror breach above a lower high while the direction stays Down', () => {
      const observation = valid(evaluate(series(mirror(WALKTHROUGH)), closeOf(8), L1R1));

      expect(observation).toMatchObject({
        direction: 'Down',
        reference: pivot('high', 20, 4, 5),
        breach: {
          firstClose: {
            field: 'close',
            price: 20.6,
            candleOpenTime: openOf(8),
            knowableAt: closeOf(8),
          },
          firstExtreme: {
            field: 'high',
            price: 20.5,
            candleOpenTime: openOf(7),
            knowableAt: closeOf(7),
          },
        },
      });
    });
  });

  describe('9. invalid candle input', () => {
    const base = () => series(WALKTHROUGH.slice(0, 6));
    const at = (candles: Candle[], index: number, change: Partial<Candle>) =>
      candles.map((candle, i) => (i === index ? { ...candle, ...change } : candle));
    const swap = (candles: Candle[]) => [
      candles[0],
      candles[1],
      candles[3],
      candles[2],
      candles[4],
      candles[5],
    ];

    it.each<[string, () => Candle[], string]>([
      ['candles out of order', () => swap(base()) as Candle[], 'TIMESTAMP_OUT_OF_ORDER'],
      [
        'a duplicate open time',
        () => [...base().slice(0, 3), ...base().slice(2)],
        'DUPLICATE_TIMESTAMP',
      ],
      ['a missing candle', () => [...base().slice(0, 3), ...base().slice(4)], 'MISSING_INTERVAL'],
      ['a non-finite high', () => at(base(), 2, { high: Number.NaN }), 'NONFINITE_PRICE'],
      ['an infinite close', () => at(base(), 2, { close: Infinity }), 'NONFINITE_PRICE'],
      ['a non-positive low', () => at(base(), 2, { low: 0 }), 'NON_POSITIVE_PRICE'],
      ['high below low', () => at(base(), 2, { high: 8, low: 9 }), 'HIGH_BELOW_LOW'],
      ['a close above the high', () => at(base(), 2, { close: 11.5 }), 'CLOSE_OUTSIDE_RANGE'],
      ['an open below the low', () => at(base(), 2, { open: 8.5 }), 'OPEN_OUTSIDE_RANGE'],
      [
        'a close time that does not fit the timeframe',
        () => at(base(), 2, { closeTime: openOf(3) }),
        'CLOSE_TIME_CONVENTION_MISMATCH',
      ],
      [
        'an open time that cannot be placed, even after the cutoff',
        () => [...base(), { ...base()[5]!, timestamp: Number.NaN }],
        'INVALID_TIMESTAMP',
      ],
    ])('rejects %s without evaluating a direction', (_, candles, code) => {
      const observation = evaluate(candles(), closeOf(5), L1R1);

      expect(observation.status).toBe('INVALID_INPUT');
      if (observation.status !== 'INVALID_INPUT') return;
      expect(observation.issues.map((item) => item.code)).toContain(code);
      expect('direction' in observation).toBe(false);
    });

    it.each<[string, Partial<Parameters<typeof evaluateSwingStructure>[0]>]>([
      ['a missing leftBars', { config: { rightBars: 1 } as SwingStructureConfig }],
      ['a zero leftBars', { config: { leftBars: 0, rightBars: 1 } }],
      ['a fractional rightBars', { config: { leftBars: 1, rightBars: 1.5 } }],
      ['an unstated timeframe label', { timeframe: { label: ' ', intervalMs: DAY } }],
      ['a zero interval', { timeframe: { label: '1d', intervalMs: 0 } }],
      ['a non-integer cutoff', { cutoff: Number.NaN }],
    ])('throws on %s instead of assuming a default', (_, override) => {
      expect(() =>
        evaluateSwingStructure({
          candles: base(),
          timeframe: DAILY,
          config: L1R1,
          cutoff: closeOf(5),
          ...override,
        }),
      ).toThrow(RangeError);
    });
  });

  it('10. gives the same observation from a longer series as from only the candles closed by the cutoff', () => {
    const plateau = series([
      [10, 8, 9],
      [12, 10, 11],
      [12, 10.5, 11],
      [11, 9, 10],
      [12, 9.5, 11],
      [11.8, 9.2, 10],
      [13, 9.6, 12],
    ]);
    const cases: Array<[Candle[], SwingStructureConfig]> = [
      [series(WALKTHROUGH), L1R1],
      [series(mirror(WALKTHROUGH)), L1R1],
      [series(WALKTHROUGH), L1R2],
      [plateau, L1R2],
    ];

    for (const [full, config] of cases) {
      for (let i = -1; i < full.length; i += 1) {
        for (const cutoff of [closeOf(i) - 1, closeOf(i)]) {
          const prefix = full.filter((candle) => candle.closeTime <= cutoff);
          expect(evaluate(full, cutoff, config)).toEqual(evaluate(prefix, cutoff, config));
        }
      }
    }
  });

  it('11. never lets candles after the cutoff change an earlier observation', () => {
    const known = series(WALKTHROUGH.slice(0, 8));
    const past = evaluate(known, closeOf(7), L1R1);
    const futures: Candle[][] = [
      series(WALKTHROUGH), // D8 undercuts D7, so D7 never becomes a pivot low
      series([...WALKTHROUGH.slice(0, 8), [11, 10, 10.5]]), // D8 holds, so D7 becomes one at D8's close
      series([...WALKTHROUGH.slice(0, 8), [20, 1, 2]]), // an extreme bar
      [...known, { ...series(WALKTHROUGH)[8]!, high: 1, low: 2 }], // an invalid later candle
    ];

    for (const extended of futures) {
      expect(evaluate(extended, closeOf(7), L1R1)).toEqual(past);
    }
    // The D7 pivot low exists only from D8's close, never at D7's.
    const confirmed = valid(evaluate(futures[1]!, closeOf(8), L1R1));
    expect(confirmed.supportingLows.at(-1)).toEqual(pivot('low', 9.5, 7, 8));
  });

  it('12. records the candidate version, configuration and timeframe, and assumes no bar length', () => {
    const fourHour: SwingStructureTimeframe = { label: '4h', intervalMs: FOUR_HOURS };
    const cutoff = closeOf(5, FOUR_HOURS);
    const observation = valid(
      evaluate(series(WALKTHROUGH.slice(0, 6), FOUR_HOURS), cutoff, L1R1, fourHour),
    );

    expect(observation).toMatchObject({
      candidateId: SWING_STRUCTURE_CANDIDATE_ID,
      candidateVersion: SWING_STRUCTURE_CANDIDATE_VERSION,
      config: { leftBars: 1, rightBars: 1 },
      timeframe: { label: '4h', intervalMs: FOUR_HOURS },
      cutoff,
      direction: 'Up',
      establishedAt: cutoff,
    });
    expect(SWING_STRUCTURE_CANDIDATE_ID).toBe('swing-structure-direction');
    expect(SWING_STRUCTURE_CANDIDATE_VERSION).toBe('0.1.0');

    // Daily candles stated as 4h are refused, not reinterpreted.
    const mislabelled = evaluate(series(WALKTHROUGH.slice(0, 6)), closeOf(5), L1R1, fourHour);
    expect(mislabelled.status).toBe('INVALID_INPUT');

    // The configuration is part of the observation because it changes the result.
    const wider = valid(evaluate(series(WALKTHROUGH), closeOf(9), { leftBars: 2, rightBars: 2 }));
    expect(wider).toMatchObject({
      config: { leftBars: 2, rightBars: 2 },
      status: 'INSUFFICIENT',
      supportingHighs: [pivot('high', 15, 5, 7)],
      supportingLows: [],
    });
  });
});
