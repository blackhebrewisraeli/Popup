import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { Candle } from '@/lib/binance';
import { evaluateScan, type MarketScan, type ScanInput } from '@/lib/marketScanner';
import { decimalInput } from '@/lib/spotScenario';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';

/**
 * Labeled synthetic scans only. Every candle below is invented to make model 1.0.0 produce a
 * known setup state; no value is market data, and no planned figure is a recommendation.
 */
const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;
const SCAN_ID = '20261028T170000Z-synthetic';

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
  const first = TODAY - count * DAY;
  return Array.from({ length: count }, (_, i) => {
    const close = path(i);
    return {
      timestamp: first + i * DAY,
      closeTime: first + i * DAY + DAY - 1,
      open: close,
      high: close * (1 + spread),
      low: close * (1 - spread),
      close,
    };
  });
}

/** A steady decline that goes flat for the last `flat` days: oversold RSI, MACD turning up. */
const declineThenFlat = (rate: number, flat: number) => (i: number) =>
  100 * Math.pow(1 - rate, Math.min(i, 198 - flat));
const wave = (i: number) => 100 + Math.sin(i / 6) * 8;

const pair = (ticker: string, rows: Candle[]): ScanInput => {
  const symbol = `BINANCE:${ticker.replace('-', '')}`;
  return {
    ticker,
    instrument: symbol,
    providerSymbol: { requested: symbol, validated: symbol },
    candles: rows,
  };
};

const source: TradingViewDevSource = {
  tool: 'get_ohlcv',
  interval: '1D',
  retrieval: { startedAt: '2026-10-28T17:00:00.000Z', completedAt: '2026-10-28T17:02:00.000Z' },
  symbols: {
    'LONG-USDT': 'BINANCE:LONGUSDT',
    'BOTH-USDT': 'BINANCE:BOTHUSDT',
    'NONE-USDT': 'BINANCE:NONEUSDT',
    'YOUNG-USDT': 'BINANCE:YOUNGUSDT',
  },
  notice: 'the last bar is still forming and may change.',
  selectionRule: 'Labeled synthetic fixture universe.',
  pineAlerts: { checkedAt: '2026-10-28T17:03:00.000Z', symbols: [] },
};

function cryptoScan(): MarketScan {
  return evaluateScan(
    [
      pair('LONG-USDT', candles(declineThenFlat(0.005, 6), 0.005)),
      pair('BOTH-USDT', candles(declineThenFlat(0.01, 12), 0.019)),
      pair('NONE-USDT', candles(wave, 0.01)),
      pair('YOUNG-USDT', candles(wave, 0.01, 120)),
    ],
    {
      evaluationTime: NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    },
  );
}

function renderScan(scan = cryptoScan(), scanId = SCAN_ID) {
  const view = render(
    <MarketScanSummary
      scan={scan}
      completedAt={NOW}
      scanning={false}
      failed={false}
      source={source}
      scanId={scanId}
    />,
  );
  return { ...view, scan };
}

function select(ticker: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${ticker}, rank`) }));
}

/** The selected asset's scenario section, opened. */
function scenario() {
  const section = screen.getByRole('region', { name: 'Manual Spot scenario' });
  const details = section.querySelector('details');
  if (details && !details.open)
    fireEvent.click(within(section).getByText('Plan a hypothetical scenario'));
  return section;
}

function fill(section: HTMLElement, values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) {
    fireEvent.change(within(section).getByLabelText(new RegExp(`^${label}`)), {
      target: { value },
    });
  }
}

function fact(section: HTMLElement, name: string) {
  return within(section).getByText(name, { selector: 'dt' }).nextElementSibling?.textContent;
}

describe('Manual Spot scenario in the TradingView crypto evidence', () => {
  it('names the evidence it rests on, apart from the hypothesis, and shows no figure yet', () => {
    wideScreen();
    const { scan } = renderScan();
    const long = scan.results.find((result) => result.ticker === 'LONG-USDT');
    expect(long?.setups).toEqual({ long: true, risk: false });
    select('LONG-USDT');
    const section = scenario();
    expect(fact(section, 'Instrument')).toBe(
      'BINANCE:LONGUSDT · requested, and named by TradingView’s response',
    );
    expect(fact(section, 'Venue')).toBe('Binance Spot, USDT pair');
    expect(fact(section, 'Scan')).toBe(SCAN_ID);
    expect(fact(section, 'Model · timeframe')).toBe('1.0.0 · 1D');
    expect(fact(section, 'Evaluated')).toBe('27 Oct candle (UTC)');
    expect(fact(section, 'Technical rank')).toMatch(/^#\d of 3, incomplete scan \(4 supported\)$/);
    expect(fact(section, 'ZC LONG')).toBe('Holds');
    expect(fact(section, 'ZC RISK')).toBe('Does not hold');
    expect(fact(section, 'Freshness')).toMatch(/no newer UTC day has closed$/);
    expect(fact(section, 'Data quality')).toBe('Evaluated on 199 closed UTC days; scan incomplete');
    expect(section).toHaveTextContent(
      'ZC LONG held on the 27 Oct candle (UTC): a recorded technical condition, not a recommendation',
    );
    expect(section).toHaveTextContent(
      'Enter available allocation, maximum planned loss, hypothetical entry, stop reference to see the arithmetic.',
    );
    expect(within(section).queryByText('Illustrative quantity')).not.toBeInTheDocument();
  });

  it('works out an allocation- or loss-limited scenario, fees unspecified by default', () => {
    wideScreen();
    renderScan();
    select('LONG-USDT');
    const section = scenario();
    fill(section, {
      'Available allocation': '1000',
      'Maximum planned loss': '50',
      'Hypothetical entry': '100',
      'Stop reference': '90',
    });
    expect(fact(section, 'Illustrative quantity')).toBe('5 LONG');
    expect(fact(section, 'Limited by')).toBe('Planned-loss budget');
    expect(fact(section, 'Position notional')).toBe('500.00 USDT');
    expect(fact(section, 'Unallocated')).toBe('500.00 USDT');
    expect(fact(section, 'Entry to stop')).toBe('10 USDT per LONG (10.00% of entry)');
    expect(fact(section, 'Planned loss at the stop reference')).toBe('50.00 USDT, price move only');
    expect(fact(section, 'Assumed fees')).toBe('Not specified: every figure excludes fees');
    expect(section).toHaveTextContent('not an executable order');
    expect(section).toHaveTextContent('not a placed stop and not a guaranteed maximum');
    expect(section).toHaveTextContent('Excludes slippage and fees.');

    fill(section, { 'Maximum planned loss': '200' });
    expect(fact(section, 'Limited by')).toBe('Allocation');
    expect(fact(section, 'Illustrative quantity')).toBe('10 LONG');

    fill(section, { 'Maximum planned loss': '50', 'Fee assumption': '0.1' });
    expect(fact(section, 'Illustrative quantity')).toBe('4.90677134 LONG');
    expect(fact(section, 'Assumed fees')).toBe('0.49 USDT at entry + 0.44 USDT at the stop');
    expect(fact(section, 'Planned loss at the stop reference')).toBe(
      '50.00 USDT with assumed fees (49.07 price move)',
    );
    expect(section).toHaveTextContent('Excludes slippage. USDT amounts');
  });

  it('offers the recorded close only as a labeled historical reference', () => {
    wideScreen();
    const { scan } = renderScan();
    select('LONG-USDT');
    const section = scenario();
    const close = decimalInput(
      scan.results.find((result) => result.ticker === 'LONG-USDT')?.model?.close ?? Number.NaN,
    );
    expect(section).toHaveTextContent(
      `Recorded close of the 27 Oct candle (UTC): ${close} USDT. Historical, not a current or executable quote.`,
    );
    const entry = within(section).getByLabelText(/^Hypothetical entry/);
    expect(entry).toHaveValue('');
    fireEvent.click(within(section).getByRole('button', { name: 'Use it as the entry' }));
    expect(entry).toHaveValue(close);
  });

  it('shows validation instead of figures for invalid input', () => {
    wideScreen();
    renderScan();
    select('LONG-USDT');
    const section = scenario();
    fill(section, {
      'Available allocation': '0',
      'Maximum planned loss': '-5',
      'Hypothetical entry': '100',
      'Stop reference': '100',
    });
    expect(within(section).getByLabelText(/^Available allocation/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(within(section).getByLabelText(/^Available allocation/)).toHaveAccessibleDescription(
      'Must be greater than 0.',
    );
    expect(section).toHaveTextContent('Enter a positive number.');
    expect(section).toHaveTextContent('Must be below the entry price');
    expect(section).toHaveTextContent('Correct the inputs above to see the arithmetic.');
    expect(within(section).queryByText('Illustrative quantity')).not.toBeInTheDocument();
    expect(section).not.toHaveTextContent(/0\.00 USDT/);
  });

  it('keeps a missing Long, a Risk warning beside Long, and staleness visible', () => {
    vi.setSystemTime(NOW + DAY);
    wideScreen();
    renderScan();
    select('NONE-USDT');
    let section = scenario();
    expect(within(section).getByText('No Long setup')).toBeInTheDocument();
    expect(section).toHaveTextContent(
      'Model 1.0.0 did not qualify NONE-USDT on the 27 Oct candle (UTC). A scenario here is your own hypothesis, not model-backed.',
    );
    expect(
      within(section).getByText('Stale', { selector: '.market-scan-tag' }),
    ).toBeInTheDocument();
    expect(section).toHaveTextContent(/Stale: latest candle closed .* a newer UTC day has closed/);
    expect(section).toHaveTextContent('describe that day, not the market now');
    fill(section, {
      'Available allocation': '1000',
      'Maximum planned loss': '50',
      'Hypothetical entry': '100',
      'Stop reference': '90',
    });
    // Planning never turns the pair into a setup.
    expect(section).toHaveTextContent('Not model-backed: this pair has no Long setup.');
    expect(within(section).queryByText('Long setup')).not.toBeInTheDocument();

    select('BOTH-USDT');
    section = scenario();
    expect(fact(section, 'ZC LONG')).toBe('Holds');
    // Long stays visible beside the high-volatility clause that holds Risk.
    expect(fact(section, 'ZC RISK')).toMatch(/^Holds: High volatility \(ATR \d\.\d\d%\)$/);
    expect(within(section).getByText('Long setup')).toBeInTheDocument();
    expect(within(section).getByText('Risk: high volatility')).toBeInTheDocument();
    expect(section).toHaveTextContent(
      /ZC LONG and ZC RISK both held on the 27 Oct candle \(UTC\): the Long condition comes with a Risk warning, High volatility \(ATR \d\.\d\d%\)\./,
    );
  });

  it('starts empty when another asset is selected', () => {
    wideScreen();
    renderScan();
    select('LONG-USDT');
    fill(scenario(), { 'Available allocation': '1000', 'Maximum planned loss': '50' });
    select('NONE-USDT');
    expect(within(scenario()).getByLabelText(/^Available allocation/)).toHaveValue('');
    select('LONG-USDT');
    expect(within(scenario()).getByLabelText(/^Available allocation/)).toHaveValue('');
  });

  it('starts empty when the scan shown changes', () => {
    wideScreen();
    const { scan, rerender } = renderScan();
    select('LONG-USDT');
    fill(scenario(), { 'Available allocation': '1000' });
    rerender(
      <MarketScanSummary
        scan={scan}
        completedAt={NOW}
        scanning={false}
        failed={false}
        source={source}
        scanId="20261029T170000Z-another"
      />,
    );
    const section = scenario();
    expect(fact(section, 'Scan')).toBe('20261029T170000Z-another');
    expect(within(section).getByLabelText(/^Available allocation/)).toHaveValue('');
  });

  it('gives a short-history pair no evidence or scenario, and says why', () => {
    wideScreen();
    renderScan();
    expect(screen.queryByRole('button', { name: /^YOUNG-USDT, rank/ })).not.toBeInTheDocument();
    const failures = screen.getByRole('region', { name: 'Not evaluated this scan' });
    expect(failures).toHaveTextContent('YOUNG-USDTShort history120 closed daily candles');
    expect(failures).toHaveTextContent(
      'No score or setup was recorded for these, so none has evidence or a scenario panel',
    );
  });

  it('plans in the narrow sheet too, and closing the sheet clears it', () => {
    renderScan();
    select('LONG-USDT');
    const dialog = screen.getByRole('dialog', { name: 'LONG-USDT explanation' });
    fill(within(dialog).getByRole('region', { name: 'Manual Spot scenario' }), {
      'Available allocation': '1000',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    select('LONG-USDT');
    expect(within(scenario()).getByLabelText(/^Available allocation/)).toHaveValue('');
  });

  it('sends nothing, stores nothing and offers no order action', () => {
    wideScreen();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const local = vi.spyOn(window.localStorage, 'setItem');
    const session = vi.spyOn(window.sessionStorage, 'setItem');
    renderScan();
    select('LONG-USDT');
    const section = scenario();
    fill(section, {
      'Available allocation': '1000',
      'Maximum planned loss': '50',
      'Hypothetical entry': '100',
      'Stop reference': '90',
      'Fee assumption': '0.1',
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Use it as the entry' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Clear scenario' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(
      within(section)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Use it as the entry', 'Clear scenario']);
    expect(section).not.toHaveTextContent(/\b(buy|sell|execute|confirm|place order)\b/i);
  });

  it('is not offered outside the TradingView crypto scan', () => {
    wideScreen();
    render(
      <MarketScanSummary scan={cryptoScan()} completedAt={NOW} scanning={false} failed={false} />,
    );
    select('LONG-USDT');
    expect(screen.queryByRole('region', { name: 'Manual Spot scenario' })).not.toBeInTheDocument();
  });
});
