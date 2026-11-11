import { describe, expect, it } from 'vitest';
import type { MarketRegime, ModelSetups } from '@/lib/canonicalModel';
import { evaluateScan, type MarketScan, type ScanInput } from '@/lib/marketScanner';
import {
  compareScans,
  exactSymbol,
  scoreCounts,
  setupCounts,
  type NamedScan,
} from '@/lib/scanChanges';
import { explainResult, riskClauses } from '@/lib/scanReview';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { sessionFinalAt } from '@/lib/usEquityDaily';
import { bars, falling, rising, split, wave } from './usEquityFixtures';

/**
 * Labeled fixtures, not TradingView data: synthetic series on real NYSE
 * sessions, scored by the canonical engine. Where a test needs a particular
 * transition, the recorded setups are set by hand, since the comparison reads
 * only what each scan recorded.
 */
const PATHS = { AAPL: wave, KO: rising, MSFT: falling };
const HOUR = 3_600_000;

/**
 * Each evaluated ticker is recorded as requested and confirmed on `NYSE:<ticker>`,
 * or on the symbol `symbols` names; `null` records none, as a snapshot from before
 * exact symbols were kept. A failed ticker was never retrieved, so records none.
 */
function scanOn(
  last: string,
  options: {
    failed?: readonly string[];
    later?: number;
    tickers?: readonly string[];
    symbols?: Readonly<Record<string, string | null>>;
  } = {},
): NamedScan {
  const evaluationTime = sessionFinalAt(last) + HOUR + (options.later ?? 0);
  const inputs = (options.tickers ?? Object.keys(PATHS)).map((ticker): ScanInput => {
    const equity = {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-02', to: last },
    };
    if (options.failed?.includes(ticker)) {
      return {
        ticker,
        instrument: `US:${ticker}`,
        equity,
        error: { code: 'FETCH_FAILED', detail: 'fixture: never retrieved' },
      };
    }
    const path = PATHS[ticker as keyof typeof PATHS] ?? wave;
    const series = split(bars(path, 200, last));
    const symbol =
      options.symbols?.[ticker] === undefined ? `NYSE:${ticker}` : options.symbols[ticker];
    return {
      ticker,
      instrument: `US:${ticker}`,
      ...(symbol && { providerSymbol: { requested: symbol, validated: symbol } }),
      equity: { ...equity, series, fetchedAt: evaluationTime - 60_000, cached: false },
    };
  });
  const scan = evaluateScan(inputs, {
    evaluationTime,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
  });
  return { scanId: `scan-${last}-${evaluationTime}`, scan };
}

/** Sets one ticker's recorded setups, score or regime by hand. */
function recorded(
  named: NamedScan,
  ticker: string,
  reading: Partial<ModelSetups> & { score?: number; regime?: MarketRegime },
): NamedScan {
  const { score, regime, ...setups } = reading;
  const results = named.scan.results.map((result) =>
    result.ticker === ticker && result.model && result.setups
      ? {
          ...result,
          setups: { ...result.setups, ...setups },
          model: {
            ...result.model,
            signal_score: score ?? result.model.signal_score,
            regime: regime ?? result.model.regime,
          },
        }
      : result,
  );
  return { ...named, scan: { ...named.scan, results } };
}

function edit(named: NamedScan, change: (scan: MarketScan) => MarketScan): NamedScan {
  return { ...named, scan: change(structuredClone(named.scan)) };
}

describe('compareScans', () => {
  it('says there is no baseline instead of comparing against nothing', () => {
    expect(compareScans(scanOn('2026-10-27'), undefined)).toEqual({ status: 'NO_BASELINE' });
  });

  it('names the setups that appeared, cleared or held, with both scores', () => {
    let before = scanOn('2026-10-26');
    let after = scanOn('2026-10-27');
    before = recorded(before, 'AAPL', { long: false, risk: false, score: 70 });
    after = recorded(after, 'AAPL', { long: true, risk: false, score: 81 });
    before = recorded(before, 'KO', { long: false, risk: true, score: 25 });
    after = recorded(after, 'KO', { long: false, risk: false, score: 40 });
    before = recorded(before, 'MSFT', { long: false, risk: true, score: 20 });
    after = recorded(after, 'MSFT', { long: false, risk: true, score: 20 });

    const comparison = compareScans(after, before);
    expect(comparison).toMatchObject({
      status: 'COMPARED',
      gap: { kind: 'NEXT' },
      before: { scanId: before.scanId, session: '2026-10-26', evaluated: 3, supported: 3 },
      after: { scanId: after.scanId, session: '2026-10-27', evaluated: 3, supported: 3 },
      onlyAfter: [],
      onlyBefore: [],
      neither: [],
    });
    if (comparison.status !== 'COMPARED') throw new Error('not compared');
    expect(comparison.changes).toEqual([
      {
        ticker: 'AAPL',
        long: 'APPEARED',
        risk: 'NONE',
        score: { before: 70, after: 81 },
        sessions: { before: '2026-10-26', after: '2026-10-27' },
      },
      expect.objectContaining({ ticker: 'KO', long: 'NONE', risk: 'CLEARED' }),
      expect.objectContaining({ ticker: 'MSFT', long: 'NONE', risk: 'HELD' }),
    ]);
    expect(setupCounts(comparison.changes, 'long')).toEqual({
      APPEARED: 1,
      CLEARED: 0,
      HELD: 0,
      NONE: 2,
    });
    expect(setupCounts(comparison.changes, 'risk')).toEqual({
      APPEARED: 0,
      CLEARED: 1,
      HELD: 1,
      NONE: 1,
    });
    expect(scoreCounts(comparison.changes)).toEqual({ higher: 2, lower: 0, same: 1 });
  });

  it('keeps a Risk warning held when the clause holding it changes', () => {
    const before = recorded(scanOn('2026-10-26'), 'KO', {
      risk: true,
      score: 50,
      regime: 'HIGH_VOLATILITY',
    });
    const after = recorded(scanOn('2026-10-27'), 'KO', {
      risk: true,
      score: 20,
      regime: 'NEUTRAL',
    });
    const clauses = (named: NamedScan) => {
      const ko = named.scan.results.find((result) => result.ticker === 'KO')!;
      return riskClauses(explainResult(ko.model!, ko.setups!));
    };
    expect(clauses(before)).toEqual(['High volatility']);
    expect(clauses(after)).toEqual(['Low score']);

    const comparison = compareScans(after, before);
    if (comparison.status !== 'COMPARED') throw new Error('not compared');
    expect(comparison.changes.find((change) => change.ticker === 'KO')).toMatchObject({
      risk: 'HELD',
      score: { before: 50, after: 20 },
    });
    // The comparison records no clause, so none can be shown as a transition.
    expect(Object.keys(comparison.changes[0]!).sort()).toEqual([
      'long',
      'risk',
      'score',
      'sessions',
      'ticker',
    ]);
  });

  it('never reads an asset missing from one scan as a cleared or a new condition', () => {
    const before = recorded(scanOn('2026-10-26', { failed: ['KO', 'MSFT'] }), 'AAPL', {
      risk: true,
    });
    const after = recorded(scanOn('2026-10-27', { failed: ['AAPL', 'MSFT'] }), 'KO', {
      long: true,
    });
    const comparison = compareScans(after, before);
    expect(comparison).toMatchObject({
      status: 'COMPARED',
      before: { status: 'PARTIAL', evaluated: 1, supported: 3 },
      after: { status: 'PARTIAL', evaluated: 1, supported: 3 },
      changes: [],
      onlyBefore: ['AAPL'],
      onlyAfter: ['KO'],
      neither: ['MSFT'],
    });
  });

  it('has no session pair when one scan evaluated nothing', () => {
    const before = scanOn('2026-10-26', { failed: ['AAPL', 'KO', 'MSFT'] });
    expect(compareScans(scanOn('2026-10-27'), before)).toMatchObject({
      status: 'COMPARED',
      gap: { kind: 'NONE' },
      before: { status: 'FAILED', session: null, evaluated: 0 },
      changes: [],
      onlyAfter: ['AAPL', 'KO', 'MSFT'],
    });
  });

  it('refuses scans scored under other versions, sources, universes or instruments', () => {
    const before = scanOn('2026-10-26');
    const after = scanOn('2026-10-27');
    const fields = (changed: NamedScan, baseline = before) => {
      const comparison = compareScans(changed, baseline);
      if (comparison.status !== 'INCOMPATIBLE') return comparison.status;
      // An incomparable pair shows what differs and no asset-level change at all.
      expect(comparison).not.toHaveProperty('changes');
      return comparison.differences.map((difference) => difference.field);
    };
    expect(fields(after)).toBe('COMPARED');
    expect(fields(edit(after, (scan) => ({ ...scan, modelVersion: '2.0.0' as '1.0.0' })))).toEqual([
      'Model',
    ]);
    expect(
      fields(
        edit(after, (scan) => ({ ...scan, scannerVersion: 'market-scan-v3' as 'market-scan-v2' })),
      ),
    ).toEqual(['Scanner']);
    expect(
      fields(
        edit(after, (scan) => ({
          ...scan,
          cohorts: scan.cohorts.map((cohort) => ({
            ...cohort,
            candlePolicyVersion: 'us-equity-daily-v2',
          })),
        })),
      ),
    ).toEqual(['Candle policy']);
    expect(
      fields(
        edit(after, (scan) => ({
          ...scan,
          cohorts: scan.cohorts.map((cohort) => ({ ...cohort, provider: 'another-provider' })),
        })),
      ),
    ).toEqual(['Source']);
    expect(fields(scanOn('2026-10-27', { tickers: ['AAPL', 'KO', 'NVDA'] }))).toEqual(['Universe']);
    expect(
      fields(
        edit(after, (scan) => ({
          ...scan,
          results: scan.results.map((result) =>
            result.ticker === 'KO' ? { ...result, instrument: 'US:KO.B' } : result,
          ),
        })),
      ),
    ).toEqual(['Instrument']);
    // The baseline must be the earlier scan, never the displayed one or a later one.
    expect(fields(before, after)).toEqual(['Evaluated', 'Evaluated session']);
    expect(fields(after, after)).toEqual(['Evaluated']);
  });

  it('compares two readings of a ticker only on the same exact symbol', () => {
    const before = recorded(scanOn('2026-10-26'), 'AAPL', { long: false });
    const after = recorded(scanOn('2026-10-27'), 'AAPL', { long: true });
    expect(after.scan.results.map(exactSymbol).sort()).toEqual([
      'NYSE:AAPL',
      'NYSE:KO',
      'NYSE:MSFT',
    ]);
    const comparison = compareScans(after, before);
    expect(comparison.status).toBe('COMPARED');
    if (comparison.status !== 'COMPARED') throw new Error('not compared');
    expect(comparison.changes[0]).toMatchObject({ ticker: 'AAPL', long: 'APPEARED' });
  });

  it('refuses the same ticker read on another exchange-qualified listing, rather than report a change', () => {
    const before = recorded(scanOn('2026-10-26', { symbols: { AAPL: 'NASDAQ:AAPL' } }), 'AAPL', {
      long: false,
    });
    const after = recorded(scanOn('2026-10-27', { symbols: { AAPL: 'NYSE:AAPL' } }), 'AAPL', {
      long: true,
    });
    const comparison = compareScans(after, before);
    expect(comparison).toEqual({
      status: 'INCOMPATIBLE',
      before: expect.objectContaining({ scanId: before.scanId }),
      after: expect.objectContaining({ scanId: after.scanId }),
      differences: [
        { field: 'TradingView symbol', before: 'AAPL NASDAQ:AAPL', after: 'AAPL NYSE:AAPL' },
      ],
    });
    // The generic instrument is the same, so only the exact symbol tells the listings apart.
    expect(before.scan.results[0]?.instrument).toBe(after.scan.results[0]?.instrument);

    // A listing change counts even where the asset failed: it was requested on another symbol.
    const failedNow = edit(scanOn('2026-10-27', { failed: ['AAPL'] }), (scan) => ({
      ...scan,
      results: scan.results.map((result) =>
        result.ticker === 'AAPL'
          ? { ...result, providerSymbol: { requested: 'NYSE:AAPL', validated: null } }
          : result,
      ),
    }));
    expect(compareScans(failedNow, before)).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [{ field: 'TradingView symbol' }],
    });
  });

  it('never establishes identity from a scan that recorded no exact symbol', () => {
    const legacy = { AAPL: null, KO: null, MSFT: null };
    const before = recorded(scanOn('2026-10-26', { symbols: legacy }), 'AAPL', { long: false });
    const after = recorded(scanOn('2026-10-27'), 'AAPL', { long: true });
    const none = 'Not recorded or not confirmed for any of the 3 evaluated in both';
    expect(compareScans(after, before)).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [{ field: 'Exact symbol', before: none, after: 'Recorded and confirmed' }],
    });
    // Two legacy scans are not vouched for by today's instrument map either.
    expect(compareScans(scanOn('2026-10-27', { symbols: legacy }), before)).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [{ field: 'Exact symbol', before: none, after: none }],
    });
    // One ticker without a symbol is enough, and it is named.
    expect(compareScans(after, scanOn('2026-10-26', { symbols: { KO: null } }))).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [
        {
          field: 'Exact symbol',
          before: 'Not recorded or not confirmed for KO',
          after: 'Recorded and confirmed',
        },
      ],
    });
  });

  it('does not accept an evaluated reading whose response never confirmed its symbol', () => {
    const unconfirmed = edit(scanOn('2026-10-27'), (scan) => ({
      ...scan,
      results: scan.results.map((result) =>
        result.ticker === 'MSFT'
          ? { ...result, providerSymbol: { requested: 'NYSE:MSFT', validated: 'NASDAQ:MSFT' } }
          : result,
      ),
    }));
    expect(exactSymbol(unconfirmed.scan.results.find((r) => r.ticker === 'MSFT')!)).toBeNull();
    expect(compareScans(unconfirmed, scanOn('2026-10-26'))).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [
        {
          field: 'Exact symbol',
          before: 'Recorded and confirmed',
          after: 'Not recorded or not confirmed for MSFT',
        },
      ],
    });
  });

  it('treats a re-import of the same evaluated session as a revision, not a new session', () => {
    const before = recorded(scanOn('2026-10-27'), 'AAPL', { score: 64 });
    const after = recorded(scanOn('2026-10-27', { later: 2 * HOUR }), 'AAPL', { score: 63 });
    const comparison = compareScans(after, before);
    expect(comparison).toMatchObject({
      status: 'COMPARED',
      gap: { kind: 'SAME' },
      before: { session: '2026-10-27' },
      after: { session: '2026-10-27' },
    });
    if (comparison.status !== 'COMPARED') throw new Error('not compared');
    expect(comparison.changes[0]).toMatchObject({
      ticker: 'AAPL',
      score: { before: 64, after: 63 },
      sessions: { before: '2026-10-27', after: '2026-10-27' },
    });
  });

  it('lists the sessions neither scan evaluated between nonconsecutive sessions', () => {
    const comparison = compareScans(scanOn('2026-10-27'), scanOn('2026-10-20'));
    expect(comparison).toMatchObject({
      status: 'COMPARED',
      gap: { kind: 'GAP', skipped: ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'] },
    });
  });
});
