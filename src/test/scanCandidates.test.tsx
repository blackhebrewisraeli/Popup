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
    .getAllByRole('button', { name: /^Open evidence: / })
    .map((button) =>
      /^Open evidence: (\S+), rank (\d+ of \d+)/
        .exec(button.getAttribute('aria-label') ?? '')!
        .slice(1),
    );
const candidate = (ticker: string) =>
  within(list()).getByRole('button', { name: new RegExp(`^Open evidence: ${ticker},`) });
const candidates = () =>
  screen.getByRole('region', { name: /^(Candidates to review first|Historical top ranks)/ });
/** A candidate's whole card: its status lines, disclosure and Open evidence button. */
const card = (ticker: string) => candidate(ticker).closest('li')!;
const start = () => screen.getByRole('button', { name: /^Start review: / });
const viewing = () => screen.getByRole('note', { name: 'What this view shows' });

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
    expect(card('BOTH-USDT')).toHaveTextContent('BINANCE:BOTHUSDT');
    expect(candidate('BOTH-USDT')).toHaveAccessibleDescription(
      /^Rank 2 of 7 evaluated Score 79 of 100 Long Long conditions met \(needs Score ≥ 78 and MACD momentum ≥ \+0\.05% of price; recorded Score 79, MACD momentum \+\d\.\d\d%\) Model Risk Model Risk flag: high volatility \(flagged at ATR ≥ 4\.00% of price or Score ≤ 28; recorded ATR \d+\.\d\d%, Score 79\)$/,
    );
    expect(candidate('CALM-USDT')).toHaveAccessibleDescription(
      /^Rank 3 of 7 evaluated Score 75 of 100 Long Long conditions not met \(needs Score ≥ 78 and MACD momentum ≥ \+0\.05% of price; recorded Score 75, MACD momentum -0\.41%\) Model Risk No model Risk flag \(flagged at ATR ≥ 4\.00% of price or Score ≤ 28; recorded ATR \d\.\d\d%, Score 75\)$/,
    );
    // The blend terms are details on demand, largest first.
    const terms = within(card('CALM-USDT')).getByText('Score contributions').closest('details')!;
    expect(terms.open).toBe(false);
    expect(within(terms).getAllByRole('listitem')[0]).toHaveTextContent(
      'Mean Reversion (RSI(14) 27.0): 95 × 50%',
    );
    // The short history is neither listed nor silently dropped.
    expect(within(list()).queryByText('YOUNG-USDT')).not.toBeInTheDocument();
    expect(candidates()).toHaveTextContent(
      '1 of 8 supported crypto were not evaluated this scan and cannot appear here.',
    );
    expect(candidates()).toHaveTextContent(
      '1 of 5 carry a model Risk flag, named on each; a high rank does not remove it.',
    );
    expect(candidates()).toHaveTextContent(
      'Ranked on candles to 27 Oct close (UTC): the top 5 of 7 evaluated',
    );
    expect(candidates()).toHaveTextContent('Scan 20261028T170000Z-synthetic');
    expect(candidates()).not.toHaveTextContent(/Long conditions not met by any/);
    expect(candidates()).not.toHaveTextContent(/ZC LONG|ZC RISK|Short of/);
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
      /Long conditions not met \(needs Score ≥ 78 and MACD momentum ≥ \+0\.05% of price; recorded Score 55, .*Model Risk flag: high volatility \(/,
    );
    for (const ticker of ['SWING-USDT', 'PUMP-USDT']) {
      expect(candidate(ticker)).toHaveAccessibleDescription(
        /Model Risk flag: high volatility and low score \(flagged at ATR ≥ 4\.00% of price or Score ≤ 28; recorded ATR \d+\.\d\d%, Score \d+\)$/,
      );
    }
    expect(candidates()).toHaveTextContent(
      'Long conditions not met by any evaluated crypto in this scan. These are the highest ranks only, not Long setups.',
    );
    expect(candidates()).toHaveTextContent('4 of 5 carry a model Risk flag');
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
      'Long conditions not met by any of these; 1 lower-ranked asset meets them (Long setups).',
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

  it('offers one Start review that opens the top candidate beside the list on a wide screen', () => {
    wideScreen();
    const { panel } = renderScan(NO_LONG);
    expect(within(panel).getAllByRole('button', { name: /^Start review: / })).toHaveLength(1);
    expect(start()).toHaveAccessibleName('Start review: #1 DROP-USDT');
    expect(candidates()).toHaveTextContent(
      'Opens the evidence for the highest-ranked candidate. Reviewing evidence is not a decision to buy, and a rank is not a buy recommendation.',
    );
    fireEvent.click(start());
    const evidence = within(panel).getByRole('region', { name: 'DROP-USDT evidence' });
    expect(start()).toHaveAttribute('aria-controls', evidence.id);
    expect(candidate('DROP-USDT')).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the top candidate’s sheet from Start review on a narrow screen and returns focus', () => {
    renderScan(MIXED);
    start().focus();
    fireEvent.click(start());
    expect(screen.getByRole('dialog', { name: 'LONG-USDT explanation' })).toHaveTextContent(
      '#1 of 7',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(start()).toHaveFocus();
  });

  it('explains rank, score, Long and model Risk with the model’s own thresholds', () => {
    renderScan(MIXED);
    expect(candidates()).toHaveTextContent(
      'LongLong conditions are met only when score ≥ 78 and MACD momentum ≥ +0.05% of price, both on the last closed daily candle.',
    );
    expect(candidates()).toHaveTextContent(
      'Model RiskA model Risk flag means high volatility (ATR ≥ 4.00% of price), a low score (≤ 28), or both.',
    );
    expect(card('LONG-USDT')).toHaveTextContent('LongLong conditions met');
    expect(card('CALM-USDT')).toHaveTextContent('Model RiskNo model Risk flag');
  });

  it('names a saved scan, its cutoff, scope and retrieval, and keeps study eligibility separate', () => {
    renderScan(MIXED);
    expect(viewing()).toHaveTextContent(
      'Saved TradingView scan 20261028T170000Z-synthetic' +
        'TradingView MCP get_ohlcv · candles to 27 Oct close (UTC) · 7 of 8 crypto evaluated · retrieved 28 Oct, 17:00–17:02 UTC',
    );
    expect(viewing()).toHaveTextContent(
      'Study eligibility is checked separately: being saved does not make a scan part of any study.',
    );
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
    const record = within(sheet).getByText('Record experiment (saves to Account)', {
      selector: 'summary',
    });
    const press = (shiftKey = false) =>
      fireEvent.keyDown(window, { key: 'Tab', shiftKey, cancelable: true });
    expect(close).toHaveFocus();

    // Closed: Record experiment's summary is the last control; the hidden fields are not.
    expect(press(true)).toBe(false); // fireEvent returns false once the default is prevented
    expect(record).toHaveFocus();
    expect(press()).toBe(false);
    expect(close).toHaveFocus();

    // Open: Tab leaves the summary for the fields, and from the last of them on to Record
    // experiment, which stays the boundary.
    fireEvent.click(summary);
    const clear = within(sheet).getByRole('button', { name: 'Clear scenario' });
    summary.focus();
    expect(press()).toBe(true);
    clear.focus();
    expect(press()).toBe(true);
    close.focus();
    expect(press(true)).toBe(false);
    expect(record).toHaveFocus();

    // Closed again: the boundary is still Record experiment's summary.
    fireEvent.click(summary);
    close.focus();
    expect(press(true)).toBe(false);
    expect(record).toHaveFocus();

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
    // A live browser check: never saved, no scan ID, and computed when this page scanned.
    expect(viewing()).toHaveTextContent(
      'Live browser check not saved, no scan ID' +
        'Binance spot klines · candles to 27 Oct close (UTC) · 2 of 2 crypto evaluated · computed in this browser at 28 Oct, 17:00 UTC',
    );
    expect(viewing().querySelector('code')).toBeNull();
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

describe('Evidence: an open summary, then closed sections', () => {
  const SECTIONS = [
    'Model conditions',
    'Indicators and score calculation',
    'Score contributions relative to the Long threshold',
    'Data provenance and limitations',
  ];
  const row = (ticker: string) =>
    screen.getByRole('button', { name: new RegExp(`^${ticker}, rank`) });
  const evidenceOf = (ticker: string) => screen.getByRole('region', { name: `${ticker} evidence` });
  /** The evidence review alone: the summary and its sections, not the optional scenario. */
  const reviewOf = (evidence: HTMLElement) =>
    evidence.querySelector<HTMLElement>('.scan-evidence-review')!;
  const section = (evidence: HTMLElement, title: string) =>
    within(evidence).getByText(title, { selector: 'summary' }).parentElement as HTMLDetailsElement;
  const fact = (scope: HTMLElement, name: string) =>
    within(scope).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
  const count = (text: string, phrase: string) => text.split(phrase).length - 1;

  it('summarizes the asset in the open and keeps the full evidence in four closed sections', () => {
    wideScreen();
    const { scan } = renderScan(MIXED);
    fireEvent.click(row('DROP-USDT'));
    const evidence = evidenceOf('DROP-USDT');
    const drop = scan.results.find((result) => result.ticker === 'DROP-USDT')!;
    const summary = within(evidence).getByRole('region', { name: 'Summary' });
    expect(summary.closest('details')).toBeNull();
    expect(fact(summary, 'Instrument')).toBe('BINANCE:DROPUSDT');
    expect(fact(summary, 'Last evaluated')).toBe('27 Oct candle (UTC)');
    expect(fact(summary, 'Rank')).toBe(`${drop.rank} of 7 evaluated`);
    expect(fact(summary, 'Score')).toBe(`${drop.model!.signal_score} of 100`);
    expect(fact(summary, 'Long')).toMatch(/^Long conditions not met \(needs Score ≥ 78 and /);
    expect(fact(summary, 'Model Risk')).toMatch(/^Model Risk flag: high volatility \(flagged at /);
    expect(fact(summary, 'Main reasons')).toContain(drop.model!.rationale);
    expect(fact(summary, 'Main reasons')).toContain(
      'momentum is MACD’s direction; the High-volatility regime is a classification that selects the factor weights, not a direction',
    );

    const sections = [...evidence.querySelectorAll('details.scan-evidence-section')];
    expect(
      sections.map((details) => details.querySelector(':scope > summary')?.textContent),
    ).toEqual(SECTIONS);
    expect(sections.every((details) => !(details as HTMLDetailsElement).open)).toBe(true);
    // A native disclosure: its summary opens and closes it.
    const conditions = section(evidence, 'Model conditions');
    fireEvent.click(within(conditions).getByText('Model conditions'));
    expect(conditions.open).toBe(true);
    fireEvent.click(within(conditions).getByText('Model conditions'));
    expect(conditions.open).toBe(false);
  });

  it('gives each fact one place and says what “supports” refers to', () => {
    wideScreen();
    const { scan } = renderScan(MIXED);
    fireEvent.click(row('DROP-USDT'));
    const evidence = evidenceOf('DROP-USDT');
    const review = reviewOf(evidence);
    const drop = scan.results.find((result) => result.ticker === 'DROP-USDT')!;
    for (const name of ['Instrument', 'Last evaluated', 'Window', 'Fetched']) {
      expect(within(review).getAllByText(name, { selector: 'dt' })).toHaveLength(1);
    }
    const text = review.textContent ?? '';
    expect(count(text, 'No TradingView alert existed on BINANCE:DROPUSDT when checked')).toBe(1);
    expect(count(text, 'Pine alerts only on the bar a condition turns true')).toBe(1);

    // ZC RISK held by the regime alone: said under Model conditions, not as factor points.
    const conditions = section(evidence, 'Model conditions');
    expect(conditions).toHaveTextContent(
      'sets the High-volatility regime, which holds ZC RISK on its own',
    );
    expect(conditions).toHaveTextContent('Toward the model Risk flag');
    expect(conditions).toHaveTextContent('Toward and away refer only to ZC RISK’s clauses.');

    // The contributions are always against 78, and say what supports and weakens mean.
    const contributions = section(evidence, 'Score contributions relative to the Long threshold');
    const m = drop.model!.components;
    const margin =
      m.weights.rsi * m.rsiScore +
      m.weights.momentum * m.momentumScore +
      m.weights.volatility * m.volatilityScore -
      78;
    expect(contributions).toHaveTextContent(
      `Together they come to −${Math.abs(margin).toFixed(1)}, the unrounded score’s margin from 78.`,
    );
    expect(within(contributions).getByText('Weakens: component below 78')).toBeInTheDocument();
    const lines = [...contributions.querySelectorAll('li')].map((item) => item.textContent);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/pts vs 78$/);
    expect(contributions).toHaveTextContent(
      '“Supports” and “weakens” describe only this arithmetic: whether a factor lifts the blended score toward 78 or holds it below. They say nothing about price direction, a trade or a forecast.',
    );
    expect(contributions).toHaveTextContent(
      'ZC LONG’s other clause, MACD momentum ≥ +0.05% of price, is under Model conditions.',
    );
  });

  it('keeps regime apart from momentum and profile rules apart from suitability', () => {
    wideScreen();
    renderScan(MIXED);
    fireEvent.click(row('CALM-USDT'));
    const indicators = section(evidenceOf('CALM-USDT'), 'Indicators and score calculation');
    expect(fact(indicators, 'MACD hist / price')).toMatch(
      /^[+-]\d\.\d\d% · (Bullish|Bearish|Flat) momentum$/,
    );
    expect(fact(indicators, 'Regime (selects the weights)')).toMatch(/^\S+: ATR /);
    expect(fact(indicators, 'Risk-profile rules')).toMatch(
      /^Meets (the \S+( · \S+)* profile rules|no profile’s rules)$/,
    );
    expect(indicators).toHaveTextContent(
      'Meeting them is not an assessment of whether the asset suits you.',
    );
    expect(indicators.textContent).not.toMatch(/\bFits\b/);
    const filter = screen.getByRole('combobox', { name: /^Filter by risk-profile rules/ });
    expect([...filter.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'Any profile rules',
      'Meets conservative rules',
      'Meets moderate rules',
      'Meets aggressive rules',
      'Meets no profile’s rules',
    ]);
  });

  it('keeps stale, incomplete and unconfirmed-symbol warnings in the open summary', () => {
    vi.setSystemTime(NOW + 2 * DAY);
    wideScreen();
    // Labeled synthetic: an import without TradingView's confirmation of the symbol.
    renderScan([
      ...MIXED,
      { ticker: 'OLD-USDT', instrument: 'BINANCE:OLDUSDT', candles: PAIRS.CALM.candles ?? [] },
    ]);
    fireEvent.click(row('OLD-USDT'));
    const evidence = evidenceOf('OLD-USDT');
    const summary = within(evidence).getByRole('region', { name: 'Summary' });
    const warnings = [...summary.querySelectorAll('.scan-evidence-warnings > li')];
    expect(warnings.map((item) => item.textContent)).toEqual([
      expect.stringMatching(
        /^Historical Stale: latest candle closed \d+h \d\dm ago; a newer UTC day has closed, and this scan does not refresh\.$/,
      ),
      'This scan is incomplete: the rank is among 8 evaluated, not all 9 supported.',
      'TradingView symbol: Not recorded in this scan’s evidence. The view lists BINANCE:OLDUSDT, unverified.',
    ]);
    // Each warning has one place in the review: the limitations no longer repeat them.
    const text = reviewOf(evidence).textContent ?? '';
    expect(count(text, 'a newer UTC day has closed')).toBe(1);
    expect(count(text, 'This scan is incomplete')).toBe(1);
  });

  it('puts the optional scenario after the review, outside every evidence section', () => {
    wideScreen();
    renderScan(MIXED);
    fireEvent.click(row('LONG-USDT'));
    const evidence = evidenceOf('LONG-USDT');
    const review = reviewOf(evidence);
    const scenario = within(evidence).getByRole('region', { name: 'Manual Spot scenario' });
    expect(review.contains(scenario)).toBe(false);
    expect(scenario.parentElement?.closest('details')).toBeNull();
    expect(
      review.compareDocumentPosition(scenario) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(scenario).toHaveTextContent('Optional, and separate from reviewing the evidence above');
    // Its two disclosures stay as they were: planning, then the explicit save.
    expect([...scenario.querySelectorAll('summary')].map((summary) => summary.textContent)).toEqual(
      ['Plan a hypothetical scenario', 'Record experiment (saves to Account)'],
    );
  });
});
