import { describe, expect, it } from 'vitest';
import {
  classifyRegime,
  evaluateCandles,
  FLAT_MOMENTUM,
  LONG_SETUP_MIN_SCORE,
  modelSetups,
  momentumFactorScore,
  REGIME_WEIGHTS,
  RISK_SETUP_MAX_SCORE,
  rsiFactorScore,
  scoreFactors,
  volatilityFactorScore,
  type CanonicalScore,
  type EngineCandle,
  type FactorInputs,
  type MarketRegime,
} from '@/lib/canonicalModel';

/**
 * The structural contract docs/MODEL_DIAGNOSTIC.md derives from canonicalModel.ts: where each
 * setup is reachable, what rounding does at the thresholds, and candle paths that reach each
 * cell. Pins the model as it is; none of this changes it.
 */
const setupsOf = (inputs: FactorInputs) => {
  const score = scoreFactors(inputs);
  return { ...score, ...modelSetups({ ...score, inputs }) };
};

/** The unrounded composite, in scoreFactors' operation order. */
const rawOf = (inputs: FactorInputs) => {
  const { weights: w, rsiScore, momentumScore, volatilityScore } = scoreFactors(inputs).components;
  return w.rsi * rsiScore + w.momentum * momentumScore + w.volatility * volatilityScore;
};

/**
 * Abstract factor inputs on a grid (RSI 0-100 by 2.5, momentum ±2.5% by 0.05%, volatility
 * 0.25%-8% by 0.25%): a check of the derived bounds, not a proof or a search for settings.
 */
const READINGS: (ReturnType<typeof setupsOf> & { inputs: FactorInputs; raw: number })[] = [];
for (let rsi = 0; rsi <= 100; rsi += 2.5)
  for (let m = -50; m <= 50; m += 1)
    for (let v = 1; v <= 32; v += 1) {
      const inputs = { rsi, momentumPercent: m / 2_000, volatilityPercent: v / 400 };
      READINGS.push({ inputs, raw: rawOf(inputs), ...setupsOf(inputs) });
    }

describe('composite arithmetic', () => {
  it('weights each regime row to exactly 1, so the division by the weight sum is exact', () => {
    for (const w of Object.values(REGIME_WEIGHTS))
      expect(w.rsi + w.momentum + w.volatility).toBe(1);
  });

  it('decides the thresholds on the rounded score: Long from raw 77.5, low score below raw 28.5', () => {
    expect([Math.round(77.5), Math.round(77.4999), Math.round(28.5), Math.round(28.4999)]).toEqual([
      78, 77, 29, 28,
    ]);
    // TRENDING at RSI 50 (factor 55) and +1% momentum (100): volatility moves raw across 77.5.
    const at = (v: number) => setupsOf({ rsi: 50, momentumPercent: 0.01, volatilityPercent: v });
    expect(rawOf({ rsi: 50, momentumPercent: 0.01, volatilityPercent: 0.02749 })).toBeGreaterThan(
      77.5,
    );
    expect(at(0.02749)).toMatchObject({ regime: 'TRENDING', signal_score: 78, long: true });
    expect(at(0.02751)).toMatchObject({ regime: 'TRENDING', signal_score: 77, long: false });
    // Raw 28.6 is not a low score; raw 28.4 is.
    const low = (m: number) => setupsOf({ rsi: 60, momentumPercent: m, volatilityPercent: 0.035 });
    expect(rawOf({ rsi: 60, momentumPercent: -0.00602, volatilityPercent: 0.035 })).toBeLessThan(
      28.5,
    );
    expect(low(-0.00602)).toMatchObject({ regime: 'TRENDING', signal_score: 28, risk: true });
    expect(low(-0.00598)).toMatchObject({ regime: 'TRENDING', signal_score: 29, risk: false });
  });

  it('never needs the 0-100 clamp: raw always lies inside it', () => {
    expect(READINGS.every((r) => r.raw >= 0 && r.raw <= 100)).toBe(true);
  });
});

describe('factor clipping and saturation', () => {
  it('saturates momentum at ±1% of price and volatility at 0.5% and 5.5%', () => {
    expect([0.01, 0.05].map(momentumFactorScore)).toEqual([100, 100]);
    expect([-0.01, -0.05].map(momentumFactorScore)).toEqual([0, 0]);
    expect(momentumFactorScore(FLAT_MOMENTUM)).toBeCloseTo(52.5, 12);
    expect([0, 0.005].map(volatilityFactorScore)).toEqual([100, 100]);
    expect(volatilityFactorScore(0.055)).toBeCloseTo(0, 12);
    expect(volatilityFactorScore(0.2)).toBe(0);
    // The HIGH_VOLATILITY threshold sits at a volatility factor of 30.
    expect(volatilityFactorScore(0.04)).toBeCloseTo(30, 12);
  });

  it('clips RSI to 0-100 and flattens its curve outside 30-70', () => {
    expect([rsiFactorScore(-5), rsiFactorScore(105)]).toEqual([100, 0]);
    expect([0, 30, 50, 70, 100].map(rsiFactorScore)).toEqual([100, 95, 55, 15, 0]);
    // Slopes: 1/6 point per RSI point in the oversold tail, 2 in the middle, 1/2 above 70.
    expect(rsiFactorScore(10) - rsiFactorScore(20)).toBeCloseTo(10 / 6, 12);
    expect(rsiFactorScore(40) - rsiFactorScore(50)).toBeCloseTo(20, 12);
    expect(rsiFactorScore(80) - rsiFactorScore(90)).toBeCloseTo(5, 12);
  });
});

describe('regime precedence at exact thresholds', () => {
  it('counts each threshold as met at equality, and tests volatility, momentum, RSI in that order', () => {
    const regime = (rsi: number, momentumPercent: number, volatilityPercent: number) =>
      classifyRegime({ rsi, momentumPercent, volatilityPercent });
    expect(regime(10, 0.05, 0.04)).toBe('HIGH_VOLATILITY');
    expect(regime(10, 0.005, 0.0399)).toBe('TRENDING');
    expect(regime(10, -0.005, 0.0399)).toBe('TRENDING');
    expect(regime(30, 0.0049, 0.0399)).toBe('MEAN_REVERTING');
    expect(regime(70, -0.0049, 0.0399)).toBe('MEAN_REVERTING');
    expect(regime(30.0001, 0.0049, 0.0399)).toBe('NEUTRAL');
    expect(regime(69.9999, -0.0049, 0.0399)).toBe('NEUTRAL');
  });

  it('moves the score discontinuously when a regime flips: here 10 points for 0.01% of ATR', () => {
    const below = scoreFactors({ rsi: 0, momentumPercent: 0, volatilityPercent: 0.0399 });
    const above = scoreFactors({ rsi: 0, momentumPercent: 0, volatilityPercent: 0.04 });
    expect([below.regime, below.signal_score]).toEqual(['MEAN_REVERTING', 71]);
    expect([above.regime, above.signal_score]).toEqual(['HIGH_VOLATILITY', 62]);
  });
});

describe('where each setup is reachable from abstract factor inputs', () => {
  const where = (test: (r: (typeof READINGS)[number]) => boolean) => READINGS.filter(test);
  const inRegime = (regime: MarketRegime) => (r: (typeof READINGS)[number]) => r.regime === regime;

  it('caps HIGH_VOLATILITY at raw 79 and closes Long above 4.25% ATR/close', () => {
    // Best case: RSI 0 and +1% momentum, so raw = 70 + 0.3 × volatility factor.
    const best = (v: number) => setupsOf({ rsi: 0, momentumPercent: 0.01, volatilityPercent: v });
    expect(rawOf({ rsi: 0, momentumPercent: 0.01, volatilityPercent: 0.04 })).toBeCloseTo(79, 12);
    expect(best(0.0424)).toMatchObject({ regime: 'HIGH_VOLATILITY', long: true, risk: true });
    expect(best(0.0426)).toMatchObject({
      regime: 'HIGH_VOLATILITY',
      long: false,
      signal_score: 77,
    });
    expect(best(0.055).signal_score).toBe(70);
    for (const r of where((r) => r.long && r.regime === 'HIGH_VOLATILITY')) {
      expect(r.inputs.volatilityPercent).toBeLessThanOrEqual(0.0425);
      expect(r.inputs.rsi).toBeLessThanOrEqual(25.72);
      expect(r.inputs.momentumPercent).toBeGreaterThanOrEqual(0.0091);
    }
    expect(where((r) => r.long && r.regime === 'HIGH_VOLATILITY').length).toBeGreaterThan(0);
  });

  it('reaches Long in every regime, each in a narrow corner', () => {
    const longs = (regime: MarketRegime) => where((r) => r.long && inRegime(regime)(r));
    for (const regime of ['TRENDING', 'MEAN_REVERTING', 'NEUTRAL'] as const)
      expect(longs(regime).length).toBeGreaterThan(0);
    for (const r of longs('TRENDING')) {
      expect(r.inputs.momentumPercent).toBeGreaterThanOrEqual(0.005);
      // RSI factor >= 25 even with momentum and volatility factors at 100.
      expect(r.inputs.rsi).toBeLessThanOrEqual(65);
    }
    for (const r of longs('MEAN_REVERTING')) expect(r.inputs.rsi).toBeLessThanOrEqual(30);
    for (const r of longs('NEUTRAL')) {
      expect(r.inputs.rsi).toBeLessThan(43.2);
      expect(r.inputs.momentumPercent).toBeLessThan(0.005);
      expect(r.inputs.volatilityPercent).toBeLessThan(0.03125);
    }
  });

  it('lets the momentum gate bind only in NEUTRAL and MEAN_REVERTING', () => {
    const scoreOnly = where((r) => r.signal_score >= LONG_SETUP_MIN_SCORE && !r.long);
    expect(scoreOnly.length).toBeGreaterThan(0);
    for (const r of scoreOnly) expect(['NEUTRAL', 'MEAN_REVERTING']).toContain(r.regime);
    // NEUTRAL only just above RSI 30 and near 0.5% ATR/close: at RSI 32 it is gone.
    const neutral = (rsi: number) =>
      setupsOf({ rsi, momentumPercent: 0.0004, volatilityPercent: 0.005 });
    expect(neutral(30.5)).toMatchObject({ regime: 'NEUTRAL', signal_score: 78, long: false });
    expect(neutral(32).signal_score).toBe(77);
  });

  it('puts Long and Risk together only through HIGH_VOLATILITY, never through a low score', () => {
    const both = where((r) => r.long && r.risk);
    expect(both.length).toBeGreaterThan(0);
    for (const r of both) expect(r.regime).toBe('HIGH_VOLATILITY');
  });

  it('reaches a low score outside HIGH_VOLATILITY only when overbought or close to the bounds', () => {
    for (const r of where(
      (r) => r.signal_score <= RISK_SETUP_MAX_SCORE && inRegime('MEAN_REVERTING')(r),
    ))
      expect(r.inputs.rsi).toBeGreaterThanOrEqual(70);
    // NEUTRAL's composite never falls below 22 (RSI factor > 15, momentum > 25, volatility > 30).
    expect(where(inRegime('NEUTRAL')).every((r) => r.raw > 22)).toBe(true);
    expect(
      where((r) => r.signal_score <= RISK_SETUP_MAX_SCORE && inRegime('TRENDING')(r)).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * Labeled synthetic candles, not market data: 199 daily candles flat at 100, then each
 * [days, daily return] segment, every candle spanning open and close ± `range`. Only + − × ÷,
 * so every engine computes the same readings.
 */
function synthetic(
  segments: readonly (readonly [number, number])[],
  range: number,
): EngineCandle[] {
  const returns = segments.flatMap(([days, ret]) => new Array<number>(days).fill(ret));
  const all = [...new Array<number>(199 - returns.length).fill(0), ...returns];
  let close = 100;
  return all.map((ret) => {
    const open = close;
    close = open * (1 + ret);
    return {
      high: Math.max(open, close) * (1 + range),
      low: Math.min(open, close) * (1 - range),
      close,
    };
  });
}

const PATHS = {
  'Long, NEUTRAL': {
    path: synthetic(
      [
        [6, -0.0033],
        [20, -0.0048],
        [5, 0.0014],
        [16, 0.0004],
      ],
      0.0025,
    ),
    regime: 'NEUTRAL',
    setups: { long: true, risk: false },
  },
  'Long, MEAN_REVERTING': {
    path: synthetic(
      [
        [11, -0.0872],
        [18, 0.0051],
        [44, -0.0005],
      ],
      0.0129,
    ),
    regime: 'MEAN_REVERTING',
    setups: { long: true, risk: false },
  },
  'Long, TRENDING': {
    path: synthetic(
      [
        [19, -0.0063],
        [9, -0.0371],
        [28, -0.0363],
        [13, 0.019],
      ],
      0.0025,
    ),
    regime: 'TRENDING',
    setups: { long: true, risk: false },
  },
  'Long and Risk, HIGH_VOLATILITY': {
    path: synthetic(
      [
        [51, -0.0592],
        [5, 0.0426],
        [23, -0.0091],
        [9, -0.0179],
      ],
      0.0043,
    ),
    regime: 'HIGH_VOLATILITY',
    setups: { long: true, risk: true },
  },
  'score gate without the momentum gate': {
    path: synthetic(
      [
        [46, 0.0424],
        [38, -0.008],
        [12, -0.0037],
      ],
      0,
    ),
    regime: 'MEAN_REVERTING',
    setups: { long: false, risk: false },
  },
  'low-score Risk outside HIGH_VOLATILITY (overbought, momentum fading)': {
    path: synthetic(
      [
        [14, -0.0775],
        [31, 0.0409],
        [24, 0.0092],
      ],
      0.0157,
    ),
    regime: 'TRENDING',
    setups: { long: false, risk: true },
  },
  'low-score Risk, MEAN_REVERTING (one up day after a flat history: RSI 100)': {
    path: synthetic([[1, 0.0261]], 0.0163),
    regime: 'MEAN_REVERTING',
    setups: { long: false, risk: true },
  },
  'low-score Risk, NEUTRAL (RSI near 70, histogram near −0.5%, ATR/close near 4%)': {
    path: synthetic(
      [
        [27, 0.0098],
        [1, -0.0604],
        [6, -0.0114],
        [2, 0.0692],
      ],
      0.0094,
    ),
    regime: 'NEUTRAL',
    setups: { long: false, risk: true },
  },
} as const;

describe('synthetic candle paths reach each cell', () => {
  it.each(Object.entries(PATHS))('%s', (_, { path, regime, setups }) => {
    const result = evaluateCandles(path);
    expect(result.status).toBe('OK');
    const score = result as CanonicalScore;
    expect(score.regime).toBe(regime);
    expect(modelSetups(score)).toEqual(setups);
  });

  it('keeps the score gate and Risk apart from the momentum reading where the cell says so', () => {
    const scoreOnly = evaluateCandles(
      PATHS['score gate without the momentum gate'].path,
    ) as CanonicalScore;
    expect(scoreOnly.signal_score).toBeGreaterThanOrEqual(LONG_SETUP_MIN_SCORE);
    expect(scoreOnly.inputs.momentumPercent).toBeLessThan(FLAT_MOMENTUM);
    const overbought = evaluateCandles(
      PATHS['low-score Risk outside HIGH_VOLATILITY (overbought, momentum fading)'].path,
    ) as CanonicalScore;
    expect(overbought.inputs.rsi).toBeGreaterThan(90);
    expect(overbought.signal_score).toBeLessThanOrEqual(RISK_SETUP_MAX_SCORE);
  });
});
