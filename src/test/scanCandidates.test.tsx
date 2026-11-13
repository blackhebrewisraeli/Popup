import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { Candle } from '@/lib/binance';
import { evaluateScan, type MarketScan, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';

/**
 * Candidates to review first (docs/MARKET_SCANNER.md#candidates-to-review-first), on labeled
 * synthetic scans only: every candle is invented to make model 1.0.0 record a known rank and
 * setup state. No value is market data, and no candidate is a recommendation.
 */
const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function wideScreen() {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(min-width: 1024px)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function candles(path: (i: number) => number, spread: number, count = 199): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = path(i);
    const timestamp = TODAY - (count - i) * DAY;
    return {
      timestamp,
      closeTime: timestamp + DAY - 1,
      open: close,
      high: close * (1 + spread),
      low: close * (1 - spread),
      close,
    };
  });
}

const declineThenFlat = (rate: number, flat: number) => (i: number) =>
  100 * Math.pow(1 - rate, Math.min(i, 198 - flat));
const wave = (period: number, amplitude: number) => (i: number) =>
  100 + Math.sin(i / period) * amplitude;
const grow = (rate: number) => (i: number) => 100 * Math.pow(1 + rate, i);
/** A slow slide, steeper over the last day: a high score with momentum under the Long gate. */
const slide = (drop: number) => (i: number) =>
  100 * Math.pow(0.999, Math.min(i, 198)) * (i === 198 ? 1 - drop : 1);

const pair = (ticker: string, rows: Candle[]): ScanInput => {
  const symbol = `BINANCE:${ticker.replace('-', '')}`;
  return {
    ticker,
    instrument: symbol,
    providerSymbol: { requested: symbol, validated: symbol },
    candles: rows,
  };
};

// Recorded score and setups under model 1.0.0, as the scan records them.
const PAIRS = {
  LONG: pair('LONG-USDT', candles(declineThenFlat(0.005, 6), 0.005)), // 89, Long
  BOTH: pair('BOTH-USDT', candles(declineThenFlat(0.01, 12), 0.019)), // 79, Long + Risk (HV)
  CALM: pair('CALM-USDT', candles(wave(9, 3), 0.005)), // 75, none
  WAVE: pair('WAVE-USDT', candles(wave(6, 8), 0.01)), // 67, none
  FLAT: pair(
    'FLAT-USDT',
    candles(() => 100, 0.002),
  ), // 62, none
  DROP: pair('DROP-USDT', candles(grow(-0.006), 0.05)), // 55, Risk (HV)
  HOT: pair('HOT-USDT', candles(wave(20, 9), 0.05)), // 47, Risk (HV)
  RISE: pair('RISE-USDT', candles(grow(0.004), 0.01)), // 30, none
  SWING: pair('SWING-USDT', candles(wave(4, 12), 0.03)), // 27, Risk (HV and low score)
  PUMP: pair('PUMP-USDT', candles(grow(0.01), 0.04)), // 21, Risk (HV and low score)
  YOUNG: pair('YOUNG-USDT', candles(wave(6, 8), 0.01, 120)), // INSUFFICIENT_HISTORY
};

/** Seven evaluated (two Long) and one short history. */
const MIXED = [
  PAIRS.LONG,
  PAIRS.BOTH,
  PAIRS.CALM,
  PAIRS.WAVE,
  PAIRS.FLAT,
  PAIRS.DROP,
  PAIRS.HOT,
  PAIRS.YOUNG,
];
/** No Long anywhere; the top rank holds a Risk warning. */
const NO_LONG = [PAIRS.DROP, PAIRS.HOT, PAIRS.RISE, PAIRS.SWING, PAIRS.PUMP];

function scanOf(inputs: ScanInput[], evaluationTime = NOW): MarketScan {
  return evaluateScan(inputs, {
    evaluationTime,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
  });
}

function sourceOf(scan: MarketScan): TradingViewDevSource {
  return {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T17:00:00.000Z', completedAt: '2026-10-28T17:02:00.000Z' },
    symbols: Object.fromEntries(
      scan.universe.members.map((ticker) => [ticker, `BINANCE:${ticker.replace('-', '')}`]),
    ),
    notice: 'the last bar is still forming and may change.',
    selectionRule: 'Labeled synthetic fixture universe.',
    pineAlerts: { checkedAt: '2026-10-28T17:03:00.000Z', symbols: [] },
  };
}

/** A TradingView import, keyed by scan as the Research view keys it. */
function view(scan: MarketScan, scanId: string) {
  return (
    <MarketScanSummary
      key={scanId}
      scan={scan}
      completedAt={NOW}
      scanning={false}
      failed={false}
      source={sourceOf(scan)}
      scanId={scanId}
    />
  );
}

function renderScan(inputs: ScanInput[], scanId = '20261028T170000Z-synthetic') {
  const scan = scanOf(inputs);
  const rendered = render(view(scan, scanId));
  return {
    ...rendered,
    scan,
    panel: screen.getByRole('region', { name: 'TradingView development scan' }),
  };
}

const list = () => screen.getByRole('list', { name: 'Crypto candidates' });
/** Each candidate's ticker and rank, from its accessible name. */
const shown = () =>
  within(list())
    .getAllByRole('button')
    .map((button) =>
      /^Open evidence: (\S+), rank (\d+ of \d+)/
        .exec(button.getAttribute('aria-label') ?? '')!
        .slice(1),
    );
const candidate = (ticker: string) =>
  within(list()).getByRole('button', { name: new RegExp(`^Open evidence: ${ticker},`) });
const candidates = () =>
  screen.getByRole('region', { name: /^(Candidates to review first|Historical top ranks)/ });

describe('Candidates to review first', () => {
  it('lists the top five evaluated in recorded rank, with instrument, score, setup and evidence lines', () => {
    const { scan } = renderScan(MIXED);
    const expected = scan.results
      .filter((result) => result.status === 'EVALUATED')
      .slice(0, 5)
      .map((result) => [result.ticker, `${result.rank} of 7`]);
    expect(shown()).toEqual(expected);
    expect(shown().map(([ticker]) => ticker)).toEqual([
      'LONG-USDT',
      'BOTH-USDT',
      'CALM-USDT',
      'WAVE-USDT',
      'FLAT-USDT',
    ]);
    expect(candidate('BOTH-USDT')).toHaveAccessibleName(
      'Open evidence: BOTH-USDT, rank 2 of 7, score 79, Long setup, Risk: high volatility',
    );
    expect(candidate('CALM-USDT')).toHaveAccessibleName(
      'Open evidence: CALM-USDT, rank 3 of 7, score 75, No setup',
    );
    const both = candidate('BOTH-USDT');
    expect(both).toHaveTextContent('BINANCE:BOTHUSDT');
    expect(both).toHaveTextContent('Risk: high volatility');
    expect(both).toHaveAccessibleDescription(
      /^Largest term: \w[\w ]+ \(.+\): \d+ × \d+% Against: ZC RISK holds: High volatility \(ATR \d+\.\d\d%\)$/,
    );
    expect(candidate('CALM-USDT')).toHaveAccessibleDescription(
      'Largest term: Mean Reversion (RSI(14) 27.0): 95 × 50% Against: Short of ZC LONG: Score 75, needs ≥ 78; MACD momentum -0.41%, needs ≥ +0.05% of price',
    );
    // The short history is neither listed nor silently dropped.
    expect(within(list()).queryByText('YOUNG-USDT')).not.toBeInTheDocument();
    expect(candidates()).toHaveTextContent(
      '1 of 8 supported crypto were not evaluated this scan and cannot appear here.',
    );
    expect(candidates()).toHaveTextContent(
      '1 of 5 carry a Risk warning, named on each; a high rank does not resolve it.',
    );
    expect(candidates()).toHaveTextContent(
      'Ranked on candles to 27 Oct close (UTC): the top 5 of 7 evaluated',
    );
    expect(candidates()).toHaveTextContent('Scan 20261028T170000Z-synthetic');
    expect(candidates()).not.toHaveTextContent(/None (of these )?holds ZC LONG/);
  });

  it('keeps a top rank without Long, names every Risk clause, and says no Long exists', () => {
    renderScan(NO_LONG);
    expect(shown().map(([ticker]) => ticker)).toEqual([
      'DROP-USDT',
      'HOT-USDT',
      'RISE-USDT',
      'SWING-USDT',
      'PUMP-USDT',
    ]);
    expect(candidate('DROP-USDT')).toHaveAccessibleName(
      /^Open evidence: DROP-USDT, rank 1 of 5, score 55, Risk: high volatility$/,
    );
    expect(candidate('DROP-USDT')).toHaveAccessibleDescription(
      /Against: ZC RISK holds: High volatility \(ATR \d+\.\d\d%\)\. Short of ZC LONG: Score 55, needs ≥ 78/,
    );
    for (const ticker of ['SWING-USDT', 'PUMP-USDT']) {
      expect(candidate(ticker)).toHaveTextContent('Risk: high volatility and low score');
      expect(candidate(ticker)).toHaveAccessibleDescription(
        /ZC RISK holds: High volatility \(ATR \d+\.\d\d%\), Low score \(Score \d+\)/,
      );
    }
    expect(candidates()).toHaveTextContent(
      'None holds ZC LONG: no evaluated crypto met it in this scan. These are the highest ranks only, not model-qualified Long setups.',
    );
    expect(candidates()).toHaveTextContent('4 of 5 carry a Risk warning');
    expect(candidates().textContent).not.toMatch(/recommended|buy now|opportunit|affordable/i);
  });

  it('says when a Long setup ranks below the five', () => {
    const quiet = [0.002, 0.005, 0.01, 0.02, 0.03].map((drop, i) =>
      pair(`QUIET${i + 1}-USDT`, candles(slide(drop), 0.002)),
    );
    const { scan } = renderScan([...quiet, PAIRS.BOTH]);
    const both = scan.results.find((result) => result.ticker === 'BOTH-USDT')!;
    expect(both.rank).toBe(6);
    expect(both.setups?.long).toBe(true);
    expect(shown().map(([ticker]) => ticker)).not.toContain('BOTH-USDT');
    expect(candidates()).toHaveTextContent(
      'None of these holds ZC LONG; 1 lower-ranked asset does (Long setups).',
    );
  });

  it('lists fewer than five, and none when nothing was evaluated', () => {
    const { unmount } = renderScan([PAIRS.CALM, PAIRS.WAVE, PAIRS.YOUNG]);
    expect(shown()).toEqual([
      ['CALM-USDT', '1 of 2'],
      ['WAVE-USDT', '2 of 2'],
    ]);
    unmount();
    renderScan([
      PAIRS.YOUNG,
      {
        ticker: 'GONE-USDT',
        instrument: 'BINANCE:GONEUSDT',
        error: { code: 'FETCH_FAILED', detail: 'synthetic failure' },
      },
    ]);
    expect(screen.queryByRole('list', { name: 'Crypto candidates' })).not.toBeInTheDocument();
    expect(candidates()).toHaveTextContent(
      'No candidates: no crypto asset was evaluated in this scan, so there is nothing to rank.',
    );
    expect(candidates()).toHaveTextContent('2 of 2 supported crypto were not evaluated');
  });

  it('presents a scan within its freshness rule as candidates, with no historical label', () => {
    renderScan(MIXED);
    expect(candidates()).not.toHaveTextContent('Historical');
    screen.getByRole('region', { name: /^Candidates to review first/ });
  });

  it('labels the same scan historical once a newer UTC day has closed', () => {
    vi.setSystemTime(NOW + 2 * DAY);
    renderScan(MIXED);
    const section = screen.getByRole('region', { name: /^Historical top ranks/ });
    expect(
      within(section).getByText('Historical', { selector: '.market-scan-status' }),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent(
      /Stale: latest candle closed \d+h \d\dm ago; a newer UTC day has closed, and this scan does not refresh/,
    );
    expect(section).toHaveTextContent('Historical, not a current shortlist');
    expect(
      screen.queryByRole('region', { name: /^Candidates to review first/ }),
    ).not.toBeInTheDocument();
    // The ranks themselves are the recorded ones, unchanged.
    expect(shown()[0]).toEqual(['LONG-USDT', '1 of 7']);
  });

  it('takes the whole scan, never the rows a view or filter leaves', () => {
    const { panel } = renderScan(MIXED);
    const before = shown();
    fireEvent.click(within(panel).getByRole('tab', { name: /Risk warnings/ }));
    fireEvent.change(within(panel).getByRole('searchbox', { name: 'Search ticker or symbol' }), {
      target: { value: 'drop' },
    });
    expect(within(panel).getAllByRole('button', { name: /^\S+-USDT, rank/ })).toHaveLength(1);
    expect(shown()).toEqual(before);
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Filter by regime' }), {
      target: { value: 'TRENDING' },
    });
    expect(shown()).toEqual(before);
  });

  it('opens the candidate’s own evidence beside the list on a wide screen', () => {
    wideScreen();
    const { panel, scan } = renderScan(MIXED);
    fireEvent.click(candidate('WAVE-USDT'));
    const evidence = within(panel).getByRole('region', { name: 'WAVE-USDT evidence' });
    const wave = scan.results.find((result) => result.ticker === 'WAVE-USDT')!;
    expect(evidence).toHaveTextContent(wave.model!.rationale);
    expect(evidence).toHaveTextContent('#4 of 7');
    expect(candidate('WAVE-USDT')).toHaveAttribute('aria-controls', evidence.id);
    expect(within(panel).getAllByRole('button', { current: true })).toEqual([
      candidate('WAVE-USDT'),
      within(panel).getByRole('button', { name: /^WAVE-USDT, rank/ }),
    ]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the evidence sheet on a narrow screen and returns focus to the candidate', () => {
    renderScan(MIXED);
    candidate('CALM-USDT').focus();
    fireEvent.click(candidate('CALM-USDT'));
    const sheet = screen.getByRole('dialog', { name: 'CALM-USDT explanation' });
    expect(sheet).toHaveTextContent('#3 of 7');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(candidate('CALM-USDT')).toHaveFocus();
  });

  it('keeps Tab inside the evidence sheet with the scenario closed, open and closed again', () => {
    renderScan(MIXED);
    candidate('CALM-USDT').focus();
    fireEvent.click(candidate('CALM-USDT'));
    const sheet = screen.getByRole('dialog', { name: 'CALM-USDT explanation' });
    const close = within(sheet).getByRole('button', { name: 'Close' });
    const summary = within(sheet).getByText('Plan a hypothetical scenario', {
      selector: 'summary',
    });
    const press = (shiftKey = false) =>
      fireEvent.keyDown(window, { key: 'Tab', shiftKey, cancelable: true });
    expect(close).toHaveFocus();

    // Closed: the summary is the last control; the hidden fields are not.
    expect(press(true)).toBe(false); // fireEvent returns false once the default is prevented
    expect(summary).toHaveFocus();
    expect(press()).toBe(false);
    expect(close).toHaveFocus();

    // Open: Tab leaves the summary for the fields, and wraps after the last of them.
    fireEvent.click(summary);
    const clear = within(sheet).getByRole('button', { name: 'Clear scenario' });
    summary.focus();
    expect(press()).toBe(true);
    close.focus();
    expect(press(true)).toBe(false);
    expect(clear).toHaveFocus();
    expect(press()).toBe(false);
    expect(close).toHaveFocus();

    // Closed again: the boundary returns to the summary.
    fireEvent.click(summary);
    expect(press(true)).toBe(false);
    expect(summary).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(candidate('CALM-USDT')).toHaveFocus();
  });

  it('switches with the scan: candidates, selection and evidence come from the scan shown', () => {
    wideScreen();
    const first = scanOf(MIXED);
    const { rerender } = render(view(first, '20261028T170000Z-first'));
    fireEvent.click(candidate('LONG-USDT'));
    expect(screen.getByRole('region', { name: 'LONG-USDT evidence' })).toBeInTheDocument();

    rerender(view(scanOf(NO_LONG), '20261028T170000Z-second'));
    expect(shown().map(([ticker]) => ticker)).toEqual([
      'DROP-USDT',
      'HOT-USDT',
      'RISE-USDT',
      'SWING-USDT',
      'PUMP-USDT',
    ]);
    expect(candidates()).toHaveTextContent('Scan 20261028T170000Z-second');
    expect(screen.queryByRole('button', { current: true })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Evidence' })).toHaveTextContent(
      'Select an asset to read its evidence',
    );
    fireEvent.click(candidate('DROP-USDT'));
    expect(screen.getByRole('region', { name: 'DROP-USDT evidence' })).toHaveTextContent('#1 of 5');
  });

  it('recomputes from a Market data rescan in place', () => {
    // Binance klines under the 48h rule; nothing names a TradingView symbol.
    const market = (inputs: ScanInput[]) =>
      evaluateScan(
        inputs.map(({ ticker, instrument, candles }) => ({
          ticker,
          instrument,
          candles: candles ?? [],
        })),
        { evaluationTime: NOW, universeSource: 'assets_status' },
      );
    const summary = (scan: MarketScan) => (
      <MarketScanSummary scan={scan} completedAt={NOW} scanning={false} failed={false} />
    );
    const { rerender } = render(summary(market([PAIRS.CALM, PAIRS.WAVE])));
    expect(shown().map(([ticker]) => ticker)).toEqual(['CALM-USDT', 'WAVE-USDT']);
    // No scan ID and no stale verdict: the header states source, data time and freshness.
    expect(candidates().querySelector('.scan-candidates-meta')).toBeNull();
    rerender(summary(market([PAIRS.CALM, PAIRS.WAVE, PAIRS.LONG])));
    expect(shown()).toEqual([
      ['LONG-USDT', '1 of 3'],
      ['CALM-USDT', '2 of 3'],
      ['WAVE-USDT', '3 of 3'],
    ]);
    // A Market data pair has no Manual Spot scenario.
    fireEvent.click(candidate('LONG-USDT'));
    expect(
      within(screen.getByRole('dialog')).queryByRole('region', { name: 'Manual Spot scenario' }),
    ).not.toBeInTheDocument();
  });

  describe('Manual Spot scenario through a candidate', () => {
    const scenario = () => {
      const section = screen.getByRole('region', { name: 'Manual Spot scenario' });
      const details = section.querySelector('details');
      if (details && !details.open)
        fireEvent.click(within(section).getByText('Plan a hypothetical scenario'));
      return section;
    };
    const input = (label: string) =>
      within(scenario()).getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement;
    const LABELS = [
      'Available allocation',
      'Maximum planned loss',
      'Hypothetical entry',
      'Stop reference',
    ];

    it('reaches it with empty inputs, and starts it over for another asset or scan', () => {
      wideScreen();
      const { rerender } = render(view(scanOf(MIXED), '20261028T170000Z-first'));
      fireEvent.click(candidate('LONG-USDT'));
      // Nothing is prefilled: no entry, stop, allocation or loss budget.
      expect(LABELS.map((label) => input(label).value)).toEqual(['', '', '', '']);
      fireEvent.change(input('Available allocation'), { target: { value: '100' } });
      fireEvent.change(input('Maximum planned loss'), { target: { value: '5' } });
      expect(input('Available allocation').value).toBe('100');

      fireEvent.click(candidate('BOTH-USDT'));
      expect(screen.getByRole('region', { name: 'BOTH-USDT evidence' })).toBeInTheDocument();
      expect(LABELS.map((label) => input(label).value)).toEqual(['', '', '', '']);
      fireEvent.click(candidate('LONG-USDT'));
      expect(input('Available allocation').value).toBe('');

      fireEvent.change(input('Available allocation'), { target: { value: '100' } });
      rerender(view(scanOf(MIXED), '20261028T170000Z-second'));
      expect(
        screen.queryByRole('region', { name: 'Manual Spot scenario' }),
      ).not.toBeInTheDocument();
      fireEvent.click(candidate('LONG-USDT'));
      expect(input('Available allocation').value).toBe('');
    });

    it('requests nothing and stores nothing on the way', () => {
      wideScreen();
      const fetch = vi.spyOn(globalThis, 'fetch');
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      renderScan(MIXED);
      for (const [ticker] of shown()) fireEvent.click(candidate(ticker!));
      fireEvent.click(candidate('LONG-USDT'));
      fireEvent.change(input('Available allocation'), { target: { value: '100' } });
      expect(fetch).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled();
    });
  });
});
