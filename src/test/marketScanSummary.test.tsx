import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { Candle } from '@/lib/binance';
import { explainResult } from '@/lib/scanReview';
import { evaluateScan, UNSUPPORTED_DETAIL, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, falling, rising, split, wave } from './usEquityFixtures';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;

// Freshness is judged against the clock: pin it to the fixtures' scan time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A screen wide enough for the evidence to sit beside the list. */
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

/** Labeled fixture: 199 closed daily candles of a gentle wave (no setup fires). */
function candles(path = (i: number) => 100 + Math.sin(i / 6) * 8): Candle[] {
  const first = TODAY - 199 * DAY;
  return Array.from({ length: 199 }, (_, i) => {
    const close = path(i);
    return {
      timestamp: first + i * DAY,
      closeTime: first + i * DAY + DAY - 1,
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
    };
  });
}

const supported = (ticker: string): ScanInput => ({
  ticker,
  instrument: `BINANCE:${ticker.replace('-USD', 'USDT')}`,
  candles: candles(),
});

function scanOf(inputs: ScanInput[]) {
  return evaluateScan(inputs, { evaluationTime: NOW, universeSource: 'assets_status' });
}

function renderScan(inputs: ScanInput[]) {
  render(
    <MarketScanSummary scan={scanOf(inputs)} completedAt={NOW} scanning={false} failed={false} />,
  );
  return screen.getByRole('region', { name: 'Market scan' });
}

/** The value a scan-header fact shows, and the quieter line under it. */
function fact(panel: HTMLElement, label: string) {
  const term = within(panel.querySelector('.market-scan-head')!).getByText(label, {
    selector: 'dt',
  });
  const [value, detail] = term.parentElement!.querySelectorAll('dd');
  return { value: value!.textContent, detail: detail?.textContent ?? null };
}

describe('MarketScanSummary', () => {
  it('says "none" only as a full answer when every supported asset was scored', () => {
    const panel = renderScan([
      supported('BTC-USD'),
      supported('ETH-USD'),
      { ticker: 'AAPL', instrument: null },
      { ticker: 'EURUSD=X', instrument: null },
    ]);
    expect(panel.querySelector('.market-scan-head')).toHaveTextContent('Complete');
    // Named by its source, so it cannot be read as the TradingView development scan.
    expect(fact(panel, 'Source')).toEqual({
      value: 'Binance spot klines',
      detail: 'model 1.0.0 · binance-daily-v1',
    });
    expect(fact(panel, 'Timeframe')).toEqual({ value: '1D', detail: 'UTC days' });
    expect(fact(panel, 'Data as of').value).toBe('candles to 27 Oct close (UTC)');
    expect(fact(panel, 'Coverage')).toEqual({
      value: '2 of 2 evaluated',
      detail: '4 in the Markets universe · 2 not scanned (1 equity, 1 forex)',
    });
    // The scan opens on every ranked asset; zero long setups is a full answer under its tab.
    expect(within(panel).getByRole('tab', { name: /All ranked/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.click(within(panel).getByRole('tab', { name: /Long setups/ }));
    expect(
      within(panel).getByText('None — all 2 supported assets were evaluated.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText(/Completed 28 Oct, 17:00 UTC/)).toBeInTheDocument();
    const coverage = within(panel).getByRole('region', { name: 'Coverage by asset class' });
    expect(within(coverage).getAllByRole('listitem')).toHaveLength(3);
    expect(within(coverage).getByText('2 of 2 evaluated')).toBeInTheDocument();
    // Source, policy and data time are stated once, in the header.
    expect(coverage).not.toHaveTextContent(/Binance spot klines|binance-daily-v1|27 Oct/);
    expect(panel.querySelector('.scan-asof')).toBeNull();
    expect(within(coverage).getAllByText('Not scanned · 1')).toHaveLength(2);
    expect(within(coverage).getByText(UNSUPPORTED_DETAIL.equity)).toBeInTheDocument();
    expect(within(panel).getByRole('region', { name: 'Crypto results' })).toBeInTheDocument();
    expect(
      within(panel).queryByRole('region', { name: 'Equities & ETFs results' }),
    ).not.toBeInTheDocument();
  });

  it('separates an incomplete scan from "no qualifying setups" and lists what failed', () => {
    const panel = renderScan([
      supported('BTC-USD'),
      {
        ticker: 'ETH-USD',
        instrument: 'BINANCE:ETHUSDT',
        error: { code: 'FETCH_FAILED', detail: 'HTTP 503' },
      },
    ]);
    expect(panel.querySelector('.market-scan-head')).toHaveTextContent('Incomplete');
    expect(fact(panel, 'Coverage')).toEqual({
      value: '1 of 2 evaluated',
      detail: '2 in the Markets universe · 1 failed',
    });
    for (const view of ['Long setups', 'Risk warnings']) {
      fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(view) }));
      expect(
        within(panel).getByText(
          "None among the 1 evaluated. This class's scan is incomplete, so this is not a full answer.",
        ),
      ).toBeInTheDocument();
    }
    expect(within(panel).queryByText(/None — all/)).not.toBeInTheDocument();
    const failures = within(panel).getByRole('region', { name: 'Not evaluated this scan' });
    expect(within(failures).getByText('ETH-USD')).toBeInTheDocument();
    expect(within(failures).getByText('Fetch failed')).toBeInTheDocument();
    expect(within(failures).getByText('HTTP 503')).toBeInTheDocument();
  });

  it('ranks equities in their own section, says their performance is unvalidated, and shows cached age', () => {
    const equity = (ticker: string, path: (i: number) => number, fetchedAt: number): ScanInput => ({
      ticker,
      instrument: `US:${ticker}`,
      equity: {
        provider: 'fixture-eod',
        range: { from: '2026-01-09', to: '2026-10-27' },
        series: split(bars(path)),
        fetchedAt,
        cached: fetchedAt < EQUITY_NOW,
      },
    });
    const scan = evaluateScan(
      [
        { ...supported('BTC-USD'), candles: candles() },
        equity('AAPL', wave, EQUITY_NOW),
        equity('MSFT', rising, EQUITY_NOW - (3 * 60 + 5) * 60_000),
      ],
      {
        evaluationTime: EQUITY_NOW,
        universeSource: 'assets_status',
        equityProvider: 'fixture-eod',
      },
    );
    render(
      <MarketScanSummary scan={scan} completedAt={EQUITY_NOW} scanning={false} failed={false} />,
    );
    const panel = screen.getByRole('region', { name: 'Market scan' });
    expect(fact(panel, 'Data as of').value).toBe(
      'candles to 27 Oct close (UTC); sessions to 27 Oct close (New York)',
    );
    expect(fact(panel, 'Data as of').detail).toContain(
      '1 from cache, fetched up to 3h 05m before this scan',
    );
    // Two scanned classes: each states its own status and data time.
    expect(panel.querySelectorAll('.scan-asof')).toHaveLength(2);
    const equities = within(panel).getByRole('region', { name: 'Equities & ETFs results' });
    expect(
      within(equities).getByText(
        /predictive performance on equities and ETFs has not been validated/,
      ),
    ).toBeInTheDocument();
    expect(within(equities).queryByText('BTC-USD')).not.toBeInTheDocument();
  });

  it('never offers an action: no links, and only review controls', () => {
    const panel = renderScan([supported('BTC-USD')]);
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /^BTC-USD,/ }));
    for (const scope of [panel, screen.getByRole('dialog')]) {
      expect(within(scope).queryByRole('link')).not.toBeInTheDocument();
      for (const button of within(scope).queryAllByRole('button')) {
        // A row opens its own evidence; the rest are Close, Reset and Clear.
        expect(button).toHaveAccessibleName(/^(Close|Reset|Clear|BTC-USD, rank 1, score \d+)/);
      }
      expect(scope.textContent).not.toMatch(/trade now|buy now|place order|broker/i);
    }
  });

  it('shows scanning and failure states without a stale result', () => {
    const { rerender } = render(
      <MarketScanSummary scan={undefined} completedAt={0} scanning failed={false} />,
    );
    expect(screen.getByText('Scanning…')).toBeInTheDocument();
    rerender(<MarketScanSummary scan={undefined} completedAt={0} scanning={false} failed />);
    expect(
      screen.getByText('The market scan could not run. Scores are unavailable.'),
    ).toBeInTheDocument();
  });
});

describe('MarketScanSummary as the TradingView development scan', () => {
  const source: TradingViewDevSource = {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', SPY: 'AMEX:SPY' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: ['BINANCE:BTCUSDT'] },
  };
  const equity = (ticker: string, path: (i: number) => number): ScanInput => ({
    ticker,
    instrument: `US:${ticker}`,
    equity: {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-12', to: '2026-10-27' },
      series: split(bars(path)),
      fetchedAt: EQUITY_NOW - 60_000,
      cached: false,
    },
  });

  function renderDev(inputs: ScanInput[], devSource = source) {
    const scan = evaluateScan(inputs, {
      evaluationTime: EQUITY_NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    });
    render(
      <MarketScanSummary
        scan={scan}
        completedAt={EQUITY_NOW}
        scanning={false}
        failed={false}
        source={devSource}
      />,
    );
    return { scan, panel: screen.getByRole('region', { name: 'TradingView development scan' }) };
  }

  it('labels its origin, ranks every valid asset with components, and keeps failures', () => {
    const failed: ScanInput = {
      ticker: 'SPY',
      instrument: 'US:SPY',
      error: { code: 'FETCH_FAILED', detail: 'TradingView get_ohlcv (AMEX:SPY): HTTP 429' },
    };
    const { scan, panel } = renderDev([equity('AAPL', wave), equity('MSFT', rising), failed]);
    expect(within(panel).getByText('Historical dev import')).toBeInTheDocument();
    expect(fact(panel, 'Coverage')).toEqual({
      value: '2 of 3 evaluated',
      detail: '3 requested · 1 failed',
    });
    expect(fact(panel, 'Retrieved').value).toBe('28 Oct, 16:58–17:00 UTC');
    expect(fact(panel, 'Data as of').value).toBe('sessions to 27 Oct close (New York)');
    expect(fact(panel, 'Timeframe')).toEqual({ value: '1D', detail: 'New York sessions' });
    expect(fact(panel, 'Source').value).toBe('TradingView MCP get_ohlcv');
    // One class: the header's coverage is the whole breakdown.
    expect(within(panel).queryByRole('region', { name: 'Coverage by asset class' })).toBeNull();
    expect(panel).toHaveTextContent(
      'Reloading this page re-reads this import; it does not fetch new TradingView bars',
    );
    expect(panel).toHaveTextContent('never merged into the Market scan or the Markets directory');
    expect(within(panel).queryByText('Stale')).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    const rows = [...panel.querySelectorAll<HTMLElement>('.scan-row')];
    const evaluated = scan.results.filter((result) => result.status === 'EVALUATED');
    expect(rows).toHaveLength(evaluated.length);
    expect(rows[0]).toHaveTextContent(`#1${evaluated[0]!.ticker}`);
    expect(rows[0]).toHaveTextContent(source.symbols[evaluated[0]!.ticker]!);
    expect(rows[0]).toHaveTextContent(/Short of ZC LONG: Score \d+, needs ≥ 78/);
    const failures = within(panel).getByRole('region', { name: 'Not evaluated this scan' });
    expect(within(failures).getByText(/HTTP 429/)).toBeInTheDocument();
    const notes = within(panel).getByRole('region', { name: 'Source and limitations' });
    expect(
      within(notes).getByText(/No TradingView alert exists on any of these symbols/),
    ).toBeInTheDocument();
    expect(within(notes).getByText(/dividends are not adjusted/)).toBeInTheDocument();
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
    expect(panel.textContent).not.toMatch(/\blive\b/i);
  });

  it('says there are no qualifying setups as a full answer only when the scan is complete', () => {
    const { panel } = renderDev([equity('AAPL', wave)]);
    for (const view of ['Long setups', 'Risk warnings']) {
      fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(view) }));
      expect(
        within(panel).getByText('None — all 1 supported assets were evaluated.'),
      ).toBeInTheDocument();
    }
  });

  it('explains a risk setup with the readings behind it', () => {
    // Labeled fixture: closes alternating 6% apart, so ATR/close sits far above the 4% band.
    const { panel } = renderDev([equity('AAPL', (i) => (i % 2 === 0 ? 100 : 106))]);
    fireEvent.click(within(panel).getByRole('tab', { name: /Risk warnings/ }));
    const [item] = panel.querySelectorAll('.scan-row');
    expect(item).toHaveTextContent('AAPL');
    expect(item).toHaveTextContent(/High-volatility: ATR \d+\.\d\d% of price ≥ 4\.00%/);
    fireEvent.click(within(panel).getByRole('button', { name: /^AAPL,/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Volatility Regime \(ATR\)\d+30%/);
  });

  it('names a symbol that does hold a TradingView alert, without calling a setup an alert', () => {
    const pineAlerts = { checkedAt: '2026-10-28T17:01:00.000Z', symbols: ['NASDAQ:AAPL'] };
    const { panel } = renderDev([equity('AAPL', wave)], { ...source, pineAlerts });
    expect(
      within(panel).getByText(
        "TradingView alerts exist on NASDAQ:AAPL; a setup here is still Popup's calculation, not proof an alert fired.",
      ),
    ).toBeInTheDocument();
  });
});

describe('MarketScanSummary as the TradingView crypto scan', () => {
  const source: TradingViewDevSource = {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T17:00:00.000Z', completedAt: '2026-10-28T17:02:00.000Z' },
    symbols: { 'BTC-USDT': 'BINANCE:BTCUSDT', 'ETH-USDT': 'BINANCE:ETHUSDT' },
    notice: 'the last bar is still forming and may change.',
    selectionRule: 'Labeled fixture universe of Binance Spot USDT pairs.',
    pineAlerts: { checkedAt: '2026-10-28T17:03:00.000Z', symbols: [] },
  };
  const pair = (ticker: string, rows: Candle[]): ScanInput => {
    const symbol = `BINANCE:${ticker.replace('-', '')}`;
    return {
      ticker,
      instrument: symbol,
      providerSymbol: { requested: symbol, validated: symbol },
      candles: rows,
    };
  };

  function renderCrypto() {
    const scan = evaluateScan(
      [pair('BTC-USDT', candles()), pair('ETH-USDT', candles().slice(-120))],
      {
        evaluationTime: NOW,
        universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
        cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
      },
    );
    render(
      <MarketScanSummary
        scan={scan}
        completedAt={NOW}
        scanning={false}
        failed={false}
        source={source}
      />,
    );
    return screen.getByRole('region', { name: 'TradingView development scan' });
  }

  it('names TradingView as the source and Binance Spot as the venue, on UTC days', () => {
    const panel = renderCrypto();
    expect(fact(panel, 'Source')).toEqual({
      value: 'TradingView MCP get_ohlcv',
      detail: 'model 1.0.0 · tradingview-crypto-daily-v1',
    });
    expect(fact(panel, 'Venue')).toEqual({
      value: 'Binance Spot',
      detail: 'USDT pairs; where they trade, not the data source',
    });
    expect(fact(panel, 'Timeframe')).toEqual({ value: '1D', detail: 'UTC days' });
    expect(fact(panel, 'Data as of').value).toBe('candles to 27 Oct close (UTC)');
    expect(fact(panel, 'Data as of').detail).toMatch(/; no newer UTC day has closed$/);
    expect(fact(panel, 'Coverage')).toEqual({
      value: '1 of 2 evaluated',
      detail: '2 requested · 1 failed',
    });
    const failures = within(panel).getByRole('region', { name: 'Not evaluated this scan' });
    expect(failures).toHaveTextContent('ETH-USDTShort history120 closed daily candles');
    const notes = within(panel).getByRole('region', { name: 'Source and limitations' });
    expect(notes).toHaveTextContent('Instruments: Binance Spot USDT pairs');
    expect(notes).toHaveTextContent('no Binance candle was read, and Popup places no orders');
    expect(notes).toHaveTextContent('Each score rests on the last 199 closed UTC days');
    expect(notes).not.toHaveTextContent(/dividends|9h after its close|final sessions/);
    // The equity-only research note is not attached to crypto ranks.
    expect(panel).not.toHaveTextContent('retrospective study of this universe');
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
  });

  it('turns stale once a newer UTC day has closed, since the cutoff was frozen', () => {
    vi.setSystemTime(NOW + DAY);
    const panel = renderCrypto();
    expect(within(panel).getByText('Stale')).toBeInTheDocument();
    expect(fact(panel, 'Data as of').detail).toMatch(
      /Stale: latest candle closed \d+h \d\dm ago; a newer UTC day has closed/,
    );
  });
});

describe('Scan review: views, explanation and comparison', () => {
  const choppy = (i: number) => (i % 2 === 0 ? 100 : 106);
  const equity = (ticker: string, path: (i: number) => number): ScanInput => ({
    ticker,
    instrument: `US:${ticker}`,
    equity: {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-12', to: '2026-10-27' },
      series: split(bars(path)),
      fetchedAt: EQUITY_NOW - 60_000,
      cached: false,
    },
  });
  const fourEquities = () => [
    equity('AAPL', wave),
    equity('MSFT', rising),
    equity('NVDA', falling),
    equity('SPY', choppy),
  ];
  const source: TradingViewDevSource = {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', NVDA: 'NASDAQ:NVDA', SPY: 'AMEX:SPY' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: [] },
  };

  function renderReview(inputs: ScanInput[], devSource?: TradingViewDevSource) {
    const scan = evaluateScan(inputs, {
      evaluationTime: EQUITY_NOW,
      universeSource: devSource ? TRADINGVIEW_DEV_UNIVERSE_SOURCE : 'assets_status',
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    });
    render(
      <MarketScanSummary
        scan={scan}
        completedAt={EQUITY_NOW}
        scanning={false}
        failed={false}
        {...(devSource && { source: devSource })}
      />,
    );
    const panel = screen.getByRole('region', {
      name: devSource ? 'TradingView development scan' : 'Market scan',
    });
    const view = (name: string) =>
      fireEvent.click(within(panel).getByRole('tab', { name: new RegExp(name) }));
    const rows = () => [...panel.querySelectorAll<HTMLElement>('.scan-row')];
    return { scan, panel, view, rows };
  }

  it('separates long setups, risk warnings and every ranked asset, and filters by recorded fields', () => {
    const { scan, panel, view, rows } = renderReview(fourEquities());
    const evaluated = scan.results.filter((result) => result.status === 'EVALUATED');
    const risky = evaluated.filter((result) => result.setups?.risk);
    expect(risky.length).toBeGreaterThan(0);
    expect(within(panel).getByRole('tab', { name: /All ranked/ })).toHaveTextContent('All ranked4');

    view('Risk warnings');
    expect(rows().map((row) => row.querySelector('.market-scan-ticker')?.textContent)).toEqual(
      risky.map((result) => result.ticker),
    );
    expect(rows().every((row) => row.textContent?.includes('Risk warning'))).toBe(true);

    view('All ranked');
    expect(rows().map((row) => row.querySelector('.market-scan-rank')?.textContent)).toEqual([
      '#1',
      '#2',
      '#3',
      '#4',
    ]);

    const search = within(panel).getByRole('searchbox', { name: 'Search ticker or symbol' });
    fireEvent.change(search, { target: { value: 'msf' } });
    expect(rows()).toHaveLength(1);
    expect(within(panel).getByText('Showing 1 of 4 ranked assets.')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(rows()).toHaveLength(0);
    expect(
      within(panel).getByText(/No ranked assets match these filters \(4 hidden\)/),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/None — all/)).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear filters' }));
    expect(rows()).toHaveLength(4);
    expect(search).toHaveValue('');

    const spy = evaluated.find((result) => result.ticker === 'SPY')!;
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Filter by regime' }), {
      target: { value: spy.model!.regime },
    });
    expect(rows().map((row) => row.querySelector('.market-scan-ticker')?.textContent)).toContain(
      'SPY',
    );
    expect(rows().every((row) => row.textContent?.includes('High-volatility'))).toBe(true);
  });

  it('gives every form field a name, which Chrome reports as an issue otherwise', () => {
    const { panel } = renderReview(fourEquities());
    const fields = [...panel.querySelectorAll('input, select, textarea')];
    expect(fields.length).toBeGreaterThan(4);
    expect(fields.filter((field) => !field.id && !field.getAttribute('name'))).toEqual([]);
  });

  it('explains one asset from its recorded values only, and closes back to its row', () => {
    const { scan, panel, view } = renderReview(fourEquities());
    view('All ranked');
    const spy = scan.results.find((result) => result.ticker === 'SPY')!;
    const explainButton = within(panel).getByRole('button', { name: /^SPY,/ });
    explainButton.focus();
    fireEvent.click(explainButton);
    const dialog = screen.getByRole('dialog', { name: 'SPY explanation' });
    const fact = (name: string) =>
      within(dialog).getAllByText(name, { selector: 'dt' })[0]!.nextElementSibling?.textContent;
    expect(fact('RSI(14)')).toBe(spy.model!.inputs.rsi.toFixed(1));
    expect(fact('ATR(14) / price')).toBe(
      `${(spy.model!.inputs.volatilityPercent * 100).toFixed(2)}%`,
    );
    expect(fact('Source')).toBe('TradingView MCP get_ohlcv');
    expect(fact('Model')).toBe('1.0.0 · scanner market-scan-v2');
    expect(fact('Last evaluated')).toBe('27 Oct session (New York)');
    expect(
      within(dialog)
        .getByText('ZC RISK', { selector: '.scan-check-head > span' })
        .closest('.scan-check'),
    ).toHaveTextContent('Holds');
    expect(dialog).toHaveTextContent(
      'sets the High-volatility regime, which holds ZC RISK on its own',
    );
    expect(dialog).toHaveTextContent(
      /predictive performance on equities and ETFs has not been validated/,
    );
    expect(dialog).toHaveTextContent('This scan does not read TradingView alerts.');
    expect(dialog.textContent).not.toMatch(/confidence|chance|undervalued|fair value/i);
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(explainButton).toHaveFocus();
  });

  it('compares up to three assets of one cohort with the values the explanation gives', () => {
    const { scan, panel, view } = renderReview(fourEquities());
    view('All ranked');
    const compare = (ticker: string) =>
      within(panel).getByRole('checkbox', { name: `Compare ${ticker}` });
    for (const ticker of ['AAPL', 'MSFT', 'NVDA']) fireEvent.click(compare(ticker));
    expect(compare('SPY')).toBeDisabled();
    expect(compare('SPY').closest('label')).toHaveAttribute('title', 'Compare at most 3 assets');

    const table = within(panel).getByRole('region', { name: 'Equities & ETFs comparison' });
    const header = [...table.querySelectorAll('thead th')].map(
      (th) => th.querySelector('.market-scan-ticker')?.textContent,
    );
    expect(header).toEqual([undefined, 'AAPL', 'MSFT', 'NVDA']);
    const row = (name: string) =>
      [...within(table).getByRole('rowheader', { name }).parentElement!.querySelectorAll('td')].map(
        (cell) => cell.textContent,
      );
    const compared = ['AAPL', 'MSFT', 'NVDA'].map((ticker) =>
      scan.results.find((r) => r.ticker === ticker)!,
    );
    expect(row('Score')).toEqual(compared.map((result) => String(result.model!.signal_score)));
    expect(row('Rank')).toEqual(compared.map((result) => `#${result.rank} of 4`));
    compared.forEach((result, index) => {
      const explanation = explainResult(result.model!, result.setups!);
      expect(row('ZC LONG')[index]!.startsWith('Holds')).toBe(explanation.long.holds);
      expect(row('ZC RISK')[index]!.startsWith('Holds')).toBe(result.setups!.risk);
      expect(row('Regime')[index]).toContain(explanation.regimeRule);
    });

    fireEvent.click(within(table).getByRole('button', { name: 'Remove MSFT from comparison' }));
    expect(row('Score')).toHaveLength(2);
    expect(compare('SPY')).toBeEnabled();
    fireEvent.click(within(table).getByRole('button', { name: 'Clear' }));
    expect(
      within(panel).queryByRole('region', { name: 'Equities & ETFs comparison' }),
    ).not.toBeInTheDocument();
  });

  it('never compares across asset classes', () => {
    const { panel, view } = renderReview([
      supported('BTC-USD'),
      equity('AAPL', wave),
      equity('MSFT', rising),
    ]);
    view('All ranked');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare BTC-USD' }));
    const aapl = within(panel).getByRole('checkbox', { name: 'Compare AAPL' });
    expect(aapl).toBeDisabled();
    expect(aapl.closest('label')).toHaveAttribute(
      'title',
      'Compare assets from one asset class only',
    );
    expect(within(panel).getByRole('region', { name: 'Crypto comparison' })).toHaveTextContent(
      'Select up to 2 more crypto to compare.',
    );
  });

  it('marks an old import stale, never live, in the results and the explanation', () => {
    vi.setSystemTime(Date.UTC(2026, 10, 6, 12));
    const { panel, view } = renderReview(fourEquities(), source);
    expect(within(panel).getByText('Historical dev import')).toBeInTheDocument();
    expect(within(panel).getByText('Stale')).toHaveClass('market-scan-status');
    const asOf = fact(panel, 'Data as of');
    expect(asOf.value).toBe('sessions to 27 Oct close (New York)');
    expect(asOf.detail).toMatch(
      /Stale: \d+ newer sessions are final, and this scan does not refresh/,
    );
    expect(panel.textContent).not.toMatch(/\blive\b/i);
    view('All ranked');
    fireEvent.click(within(panel).getByRole('button', { name: /^AAPL,/ }));
    const dialog = screen.getByRole('dialog', { name: 'AAPL explanation' });
    expect(dialog).toHaveTextContent('Historical import');
    expect(dialog).toHaveTextContent(/Stale: \d+ newer sessions are final/);
    expect(dialog).toHaveTextContent('No TradingView alert existed on NASDAQ:AAPL when checked');
    expect(dialog.textContent).not.toMatch(/\blive\b/i);
  });

  it('marks crypto stale past 48h and keeps an incomplete rank qualified', () => {
    vi.setSystemTime(NOW + 3 * DAY);
    const panel = renderScan([
      supported('BTC-USD'),
      {
        ticker: 'ETH-USD',
        instrument: 'BINANCE:ETHUSDT',
        error: { code: 'FETCH_FAILED', detail: 'HTTP 503' },
      },
    ]);
    expect(fact(panel, 'Data as of').detail).toMatch(
      /Stale: latest candle closed \d+h \d\dm ago, past 48h/,
    );
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    fireEvent.click(within(panel).getByRole('button', { name: /^BTC-USD,/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'This scan is incomplete: the rank is among 1 evaluated, not all 2 supported.',
    );
  });

  it('shows the evidence beside the list on a wide screen, without a dialog or losing the list', () => {
    wideScreen();
    const { scan, panel } = renderReview(fourEquities());
    expect(within(panel).getByRole('region', { name: 'Evidence' })).toHaveTextContent(
      'Select an asset to read its evidence',
    );
    const row = (ticker: string) =>
      within(panel).getByRole('button', { name: new RegExp(`^${ticker},`) });
    for (const ticker of ['AAPL', 'MSFT', 'NVDA']) {
      fireEvent.click(row(ticker));
      const evidence = within(panel).getByRole('region', { name: `${ticker} evidence` });
      const model = scan.results.find((result) => result.ticker === ticker)!.model!;
      expect(evidence).toHaveTextContent(model.rationale);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(within(panel).getAllByRole('button', { current: true })).toEqual([row(ticker)]);
      expect(row(ticker)).toHaveAttribute('aria-controls', evidence.id);
    }
    // The asset's own data; the scan's source, model and time stay in the header.
    const evidence = within(panel).getByRole('region', { name: 'NVDA evidence' });
    const terms = [...evidence.querySelectorAll('dt')].map((term) => term.textContent);
    expect(terms).toEqual(expect.arrayContaining(['Instrument', 'Last evaluated', 'Fetched']));
    expect(terms).not.toEqual(expect.arrayContaining(['Source']));
    expect(terms).not.toContain('Model');

    // Filtering the selection out keeps it open and says so.
    fireEvent.change(within(panel).getByRole('searchbox', { name: 'Search ticker or symbol' }), {
      target: { value: 'msft' },
    });
    expect(evidence).toHaveTextContent('Hidden from the list by the current view or filters.');
    fireEvent.click(row('MSFT'));
    expect(within(panel).getByRole('region', { name: 'MSFT evidence' })).not.toHaveTextContent(
      'Hidden from the list',
    );
  });

  it('moves between rows with Up and Down', () => {
    const { panel } = renderReview(fourEquities());
    const rows = within(panel).getAllByRole('button', { name: /, rank \d+, score/ });
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();
    fireEvent.keyDown(rows[1]!, { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();
    fireEvent.keyDown(rows[0]!, { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();
  });

  it('gives each row a short reason from the clauses that decide its setup', () => {
    // Labeled fixture: a long fall that turns up, so RSI is oversold while MACD turns positive.
    const turn = (i: number) => (i < 194 ? 30 - i * 0.07 : 30 - 194 * 0.07 + (i - 194) * 0.05);
    const { scan, panel } = renderReview([
      { ...supported('LINK-USD'), candles: candles(turn) },
      supported('BTC-USD'),
      equity('SPY', choppy),
    ]);
    const reason = (ticker: string) =>
      within(panel)
        .getByRole('button', { name: new RegExp(`^${ticker},`) })
        .querySelector('.scan-row-reason')?.textContent;
    const setups = (ticker: string) => scan.results.find((r) => r.ticker === ticker)!.setups!;
    expect(setups('LINK-USD').long).toBe(true);
    expect(reason('LINK-USD')).toMatch(
      /^Score \d+ ≥ 78, MACD momentum \+\d\.\d\d% ≥ \+0\.05% of price$/,
    );
    expect(setups('BTC-USD')).toEqual({ long: false, risk: false });
    expect(reason('BTC-USD')).toMatch(/^Short of ZC LONG: Score \d+, needs ≥ 78/);
    expect(setups('SPY').risk).toBe(true);
    expect(reason('SPY')).toMatch(/High-volatility: ATR \d+\.\d\d% of price ≥ 4\.00%$/);
  });
});
