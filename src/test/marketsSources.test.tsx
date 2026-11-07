import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import type { MarketsSource } from '@/components/TradingViewDevScan';
import { MarketsSection, ResearchZone, type ResearchPlace } from '@/components/Workspace';
import type { Candle } from '@/lib/binance';
import { REGIME_LABELS } from '@/lib/canonicalModel';
import { evaluateScan, type ScanInput } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan as DevScan,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, falling, rising, split, wave } from './usEquityFixtures';

const DAY = 86_400_000;

// The allocation advisor belongs to the market-data view; a stand-in shows whether it renders.
vi.mock('@/components/RoboAdvisor', () => ({
  RoboAdvisor: () => <button type="button">Build Portfolio</button>,
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(EQUITY_NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Labeled fixture: 199 closed daily crypto candles of a gentle wave, standing in for Binance. */
function crypto(ticker: string): ScanInput {
  const today = EQUITY_NOW - (EQUITY_NOW % DAY);
  const first = today - 199 * DAY;
  return {
    ticker,
    instrument: `BINANCE:${ticker.replace('-USD', 'USDT')}`,
    candles: Array.from({ length: 199 }, (_, i): Candle => {
      const close = 100 + Math.sin(i / 6) * 8;
      return {
        timestamp: first + i * DAY,
        closeTime: first + i * DAY + DAY - 1,
        open: close,
        high: close * 1.01,
        low: close * 0.99,
        close,
      };
    }),
  };
}

/** Labeled fixture: synthetic equity series, not TradingView data. */
function equity(ticker: string, path: (i: number) => number): ScanInput {
  return {
    ticker,
    instrument: `US:${ticker}`,
    equity: {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-12', to: '2026-10-27' },
      series: split(bars(path)),
      fetchedAt: EQUITY_NOW - 60_000,
      cached: false,
    },
  };
}

const MARKET_SCAN = evaluateScan([crypto('BTC-USD'), crypto('ETH-USD')], {
  evaluationTime: EQUITY_NOW,
  universeSource: 'assets_status',
});

function importOf(inputs: ScanInput[]): DevScan {
  return {
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: '20261028T170000Z-00000000',
    importedAt: new Date(EQUITY_NOW).toISOString(),
    source: {
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
      symbols: { AAPL: 'NASDAQ:AAPL', MSFT: 'NASDAQ:MSFT', NVDA: 'NASDAQ:NVDA', SPY: 'AMEX:SPY' },
      notice: 'regular session only; prices are split-adjusted only.',
      selectionRule: 'Labeled fixture universe.',
      pineAlerts: { checkedAt: '2026-10-28T17:01:00.000Z', symbols: [] },
    },
    scan: evaluateScan(inputs, {
      evaluationTime: EQUITY_NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    }),
  };
}

const IMPORT = importOf([
  equity('AAPL', wave),
  equity('MSFT', rising),
  equity('NVDA', falling),
  equity('SPY', (i) => (i % 2 === 0 ? 100 : 106)),
]);

function Markets() {
  const [source, setSource] = useState<MarketsSource>('market-data');
  const [place, setPlace] = useState<ResearchPlace>('scan');
  return (
    <ResearchZone
      pending={false}
      failed={false}
      empty={false}
      onPreview={() => {}}
      scan={
        <MarketScanSummary
          scan={MARKET_SCAN}
          completedAt={EQUITY_NOW}
          scanning={false}
          failed={false}
        />
      }
      markets={<div aria-label="Markets table" role="table" />}
      alerts={null}
      source={source}
      onSource={setSource}
      place={place}
      onPlace={setPlace}
    />
  );
}

function serve(respond: () => Promise<Response>) {
  const fetch = vi.fn((_url: string, _init?: RequestInit) => respond());
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Markets />
    </QueryClientProvider>,
  );
  const pick = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));
  /** Waits for the picker to name the import's state, then opens the review. */
  const open = async (state: string) => {
    await screen.findByRole('tab', { name: `TradingView import ${state}` });
    pick(/TradingView import/);
    return screen.getByRole('region', { name: 'TradingView development scan' });
  };
  return { fetch, pick, open };
}

const json = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body)));

function rowsOf(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>('.scan-row')];
}

describe('Markets source: market data or the local TradingView import', () => {
  it('opens on market data and names the import by its evaluated count, without showing it', async () => {
    serve(json(IMPORT));
    expect(await screen.findByRole('tab', { name: 'TradingView import 4' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('tab', { name: 'Market data' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Market scan' })).toBeInTheDocument();
    // The directory is its own place, out of the scan's way until opened.
    expect(screen.queryByRole('table', { name: 'Markets table' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Markets directory' }));
    expect(screen.getByRole('table', { name: 'Markets table' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Market scan' })).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Markets source' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Scan' }));
    expect(
      screen.queryByRole('region', { name: 'TradingView development scan' }),
    ).not.toBeInTheDocument();
  });

  it('lists every imported asset with the snapshot rank, score, regime and setups, and nothing else', async () => {
    const { open } = serve(json(IMPORT));
    const panel = await open('4');
    expect(screen.queryByRole('region', { name: 'Market scan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Markets table' })).not.toBeInTheDocument();

    const evaluated = IMPORT.scan.results.filter((result) => result.status === 'EVALUATED');
    const longs = evaluated.filter((result) => result.setups?.long).length;
    const risks = evaluated.filter((result) => result.setups?.risk).length;
    // The primary list is every ranked asset, not only those meeting a setup.
    expect(within(panel).getByRole('tab', { name: /All ranked/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(panel).getByRole('tab', { name: /Long setups/ })).toHaveTextContent(
      `Long setups${longs}`,
    );
    expect(within(panel).getByRole('tab', { name: /Risk warnings/ })).toHaveTextContent(
      `Risk warnings${risks}`,
    );

    const rows = rowsOf(panel);
    expect(rows).toHaveLength(evaluated.length);
    rows.forEach((row, index) => {
      const result = evaluated[index]!;
      const model = result.model!;
      expect(row.querySelector('.market-scan-rank')).toHaveTextContent(`#${result.rank}`);
      expect(row.querySelector('.market-scan-ticker')).toHaveTextContent(result.ticker);
      expect(row.querySelector('.market-scan-score')).toHaveTextContent(
        `Score ${model.signal_score}`,
      );
      // The short reason is the clause that decides the setup state; zero long setups here.
      const reason = row.querySelector('.scan-row-reason')?.textContent;
      if (result.setups!.risk) expect(reason).toMatch(/^(Score \d+ ≤ 28|High-volatility: ATR )/);
      else expect(reason).toMatch(/^Short of ZC LONG: /);
      expect(row.querySelector('.is-long') !== null).toBe(result.setups!.long);
      expect(row.querySelector('.is-risk') !== null).toBe(result.setups!.risk);
      if (!result.setups!.long && !result.setups!.risk) expect(row).toHaveTextContent('No setup');
    });
    expect(panel.textContent).not.toMatch(/BTC|ETH|Binance spot/);
  });

  it('keeps zero long setups a full answer while every asset stays reviewable', async () => {
    const { open } = serve(json(IMPORT));
    const panel = await open('4');
    expect(IMPORT.scan.results.some((result) => result.setups?.long)).toBe(false);
    fireEvent.click(within(panel).getByRole('tab', { name: /Long setups/ }));
    expect(
      within(panel).getByText('None — all 4 supported assets were evaluated.'),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('tab', { name: /All ranked/ }));
    expect(rowsOf(panel)).toHaveLength(4);
    expect(panel).toHaveTextContent('#1 is not a buy');
    expect(panel).toHaveTextContent('Not a probability, a valuation or a demonstrated expected');
    expect(panel).toHaveTextContent('found higher ranks followed by smaller price changes');
  });

  it('never carries a comparison or an explanation from one source to the other', async () => {
    const { pick } = serve(json(IMPORT));
    await screen.findByRole('tab', { name: 'TradingView import 4' });
    const market = screen.getByRole('region', { name: 'Market scan' });
    fireEvent.click(within(market).getByRole('tab', { name: /All ranked/ }));
    fireEvent.click(within(market).getByRole('checkbox', { name: 'Compare BTC-USD' }));
    fireEvent.click(within(market).getByRole('checkbox', { name: 'Compare ETH-USD' }));
    expect(screen.getByRole('region', { name: 'Crypto comparison' })).toBeInTheDocument();
    fireEvent.click(within(market).getByRole('button', { name: /^BTC-USD,/ }));
    expect(screen.getByRole('dialog', { name: 'BTC-USD explanation' })).toBeInTheDocument();

    pick(/TradingView import/);
    const panel = await screen.findByRole('region', { name: 'TradingView development scan' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Crypto comparison' })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare AAPL' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare MSFT' }));
    expect(screen.getByRole('region', { name: 'Equities & ETFs comparison' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /^AAPL,/ }));
    const dialog = screen.getByRole('dialog', { name: 'AAPL explanation' });
    // The recorded rationale, which names the regime, moved from the row to the evidence.
    const aapl = IMPORT.scan.results.find((result) => result.ticker === 'AAPL')!.model!;
    expect(dialog).toHaveTextContent(aapl.rationale);
    expect(aapl.rationale).toContain(`${REGIME_LABELS[aapl.regime]} regime`);

    pick(/Market data/);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Equities & ETFs comparison' }),
    ).not.toBeInTheDocument();
    // The market-data review starts over too: its earlier comparison is gone.
    expect(screen.queryByRole('region', { name: 'Crypto comparison' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Market scan' })).not.toHaveTextContent('AAPL');

    pick(/TradingView import/);
    expect(
      screen.queryByRole('region', { name: 'Equities & ETFs comparison' }),
    ).not.toBeInTheDocument();
  });

  it('reads only the local import route, once, however the review is used', async () => {
    const { fetch, pick, open } = serve(json(IMPORT));
    const panel = await open('4');
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare AAPL' }));
    fireEvent.click(within(panel).getByRole('button', { name: /^AAPL,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    pick(/Market data/);
    pick(/TradingView import/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
  });
});

describe('Markets source: import states', () => {
  it('says the import is loading, in the picker and the review', () => {
    const { pick } = serve(() => new Promise<Response>(() => {}));
    pick(/TradingView import Loading/);
    expect(screen.getByRole('region', { name: 'TradingView development scan' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByText('Reading the local TradingView import…')).toBeInTheDocument();
  });

  it('says nothing was imported, and shows no market data in its place', async () => {
    const { open } = serve(() => Promise.resolve(new Response('', { status: 404 })));
    await open('None');
    expect(
      screen.getByText(/No TradingView scan is published on this machine/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Market scan' })).not.toBeInTheDocument();
  });

  it('says an unreadable import could not be read', async () => {
    const { fetch, open } = serve(json({ kind: 'something-else' }));
    await open('Unreadable');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The TradingView development scan could not be read (Not a TradingView development scan file.)',
    );
  });

  it('marks a partial import incomplete and lists what failed', async () => {
    const partial = importOf([
      equity('AAPL', wave),
      equity('MSFT', rising),
      {
        ticker: 'SPY',
        instrument: 'US:SPY',
        error: { code: 'FETCH_FAILED', detail: 'TradingView get_ohlcv (AMEX:SPY): HTTP 429' },
      },
    ]);
    const { open } = serve(json(partial));
    const panel = await open('2');
    expect(within(panel).getAllByText('Incomplete').length).toBeGreaterThan(0);
    expect(panel.querySelector('.market-scan-head')).toHaveTextContent('3 requested · 1 failed');
    expect(
      within(within(panel).getByRole('region', { name: 'Not evaluated this scan' })).getByText(
        /HTTP 429/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('tab', { name: /Long setups/ }));
    expect(panel).toHaveTextContent('not a full answer');
  });

  it('marks an import stale once two newer sessions are final', async () => {
    vi.setSystemTime(EQUITY_NOW + 4 * DAY);
    const { open } = serve(json(IMPORT));
    const panel = await open('4');
    expect(within(panel).getByText('Stale', { selector: '.market-scan-status' })).toBeVisible();
  });
});

describe('Research zone', () => {
  const marketData = {
    scan: (
      <MarketScanSummary
        scan={MARKET_SCAN}
        completedAt={EQUITY_NOW}
        scanning={false}
        failed={false}
      />
    ),
    markets: (
      <MarketsSection
        rows={[]}
        scores={new Map()}
        assets={[]}
        marketView="signals"
        onMarketView={() => {}}
        assetClass="Crypto"
        onAssetClass={() => {}}
        onSelect={() => {}}
        onInvest={() => {}}
      />
    ),
    alerts: <section aria-label="Price alerts" />,
  };

  function Research(state: Readonly<{ pending?: boolean; failed?: boolean; empty?: boolean }>) {
    const [source, setSource] = useState<MarketsSource>('market-data');
    const [place, setPlace] = useState<ResearchPlace>('scan');
    return (
      <ResearchZone
        pending={state.pending ?? false}
        failed={state.failed ?? false}
        empty={state.empty ?? false}
        onPreview={() => {}}
        {...marketData}
        source={source}
        onSource={setSource}
        place={place}
        onPlace={setPlace}
      />
    );
  }

  function renderResearch(state: Parameters<typeof Research>[0] = {}) {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Research {...state} />
      </QueryClientProvider>,
    );
  }

  it('opens on the scan and keeps the Markets directory, advisor and alerts in a place of their own', async () => {
    vi.stubGlobal('fetch', vi.fn(json(IMPORT)));
    renderResearch();
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Market scan' })).toBeInTheDocument();
    for (const name of ['Markets directory', 'Price alerts']) {
      expect(screen.queryByRole('region', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Build Portfolio' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Markets directory' }));
    const markets = screen.getByRole('region', { name: 'Markets directory' });
    expect(within(markets).getByText('0 ASSETS')).toBeInTheDocument();
    expect(await within(markets).findByRole('button', { name: 'Build Portfolio' })).toBeVisible();
    expect(within(markets).getByRole('group', { name: 'Market view' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Price alerts' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Market scan' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Scan' }));

    await screen.findByRole('tab', { name: 'TradingView import 4' });
    fireEvent.click(screen.getByRole('tab', { name: /TradingView import/ }));
    expect(
      screen.getByRole('region', { name: 'TradingView development scan' }),
    ).toBeInTheDocument();
    for (const name of ['Market scan', 'Markets directory', 'Price alerts']) {
      expect(screen.queryByRole('region', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Build Portfolio' })).toBeNull();
  });

  it.each([
    ['still loading', { pending: true }],
    ['failed with nothing to show', { failed: true, empty: true }],
  ])('shows the local import while market data is %s', async (_, state) => {
    vi.stubGlobal('fetch', vi.fn(json(IMPORT)));
    renderResearch(state);
    expect(screen.queryByRole('region', { name: 'Market scan' })).toBeNull();
    await screen.findByRole('tab', { name: 'TradingView import 4' });
    fireEvent.click(screen.getByRole('tab', { name: /TradingView import/ }));
    const panel = screen.getByRole('region', { name: 'TradingView development scan' });
    expect(rowsOf(panel)).toHaveLength(4);
  });

  it('has no source picker in a production build, and never reads the import', () => {
    vi.stubEnv('DEV', false);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    renderResearch();
    expect(screen.queryByRole('tablist', { name: 'Markets source' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Market scan' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('holds the scan place while market data loads, in a production build too', () => {
    vi.stubEnv('DEV', false);
    renderResearch({ pending: true });
    // Each place holds its own spot; only the open one is shown.
    const [loading] = screen.getAllByLabelText('Loading market data').filter((el) => {
      return el.closest('[hidden]') === null;
    });
    expect(loading).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('region', { name: 'Markets directory' })).toBeNull();
  });

  it('keeps the scan filters, selection and comparison while the directory is open', () => {
    vi.stubEnv('DEV', false);
    renderResearch();
    const scan = screen.getByRole('region', { name: 'Market scan' });
    const search = within(scan).getByRole('searchbox', { name: 'Search ticker or symbol' });
    fireEvent.change(search, { target: { value: 'BTC' } });
    fireEvent.click(within(scan).getByRole('checkbox', { name: 'Compare BTC-USD' }));
    fireEvent.click(within(scan).getByRole('button', { name: /^BTC-USD,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Markets directory' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Scan' }));
    expect(search).toHaveValue('BTC');
    expect(within(scan).getByRole('checkbox', { name: 'Compare BTC-USD' })).toBeChecked();
    expect(within(scan).getByRole('button', { name: /^BTC-USD,/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
});

describe('Markets source: Reload local scan', () => {
  const HOUR = 3_600_000;
  /** Labeled fixture "scan B": a later local publish with other assets, compared with A. */
  const B: DevScan = {
    ...importOf([equity('AAPL', rising), equity('MSFT', wave)]),
    scanId: '20261029T170000Z-0000000b',
    importedAt: new Date(EQUITY_NOW + HOUR).toISOString(),
    baseline: { scanId: IMPORT.scanId, importedAt: IMPORT.importedAt, scan: IMPORT.scan },
  };

  /** Answers each read with the next responder; the last one repeats. */
  function reads(...responders: Array<() => Promise<Response>>) {
    return () => (responders.length > 1 ? responders.shift()! : responders[0]!)();
  }

  function deferred() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => (resolve = done));
    return { respond: () => promise, resolve };
  }

  const reload = () => fireEvent.click(screen.getByRole('button', { name: 'Reload local scan' }));

  /** Compares and selects AAPL in the open review, then closes its evidence. */
  function reviewAapl(panel: HTMLElement) {
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare AAPL' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Compare MSFT' }));
    fireEvent.click(within(panel).getByRole('button', { name: /^AAPL,/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('region', { name: 'Equities & ETFs comparison' })).toBeInTheDocument();
  }

  it('replaces scan A with a newly published scan B everywhere at once', async () => {
    const { fetch, open } = serve(reads(json(IMPORT), json(B)));
    const panel = await open('4');
    expect(screen.getByRole('status')).toHaveTextContent(`Scan ${IMPORT.scanId}`);
    reviewAapl(panel);

    reload();
    await screen.findByRole('tab', { name: 'TradingView import 2' });
    const review = screen.getByRole('region', { name: 'TradingView development scan' });
    expect(screen.getByRole('status')).toHaveTextContent(`Scan ${B.scanId}`);
    expect(review.querySelector('.market-scan-head')).toHaveTextContent('2 of 2 evaluated');
    const evaluated = B.scan.results.filter((result) => result.status === 'EVALUATED');
    expect(
      rowsOf(review).map((row) => row.querySelector('.market-scan-score')?.textContent),
    ).toEqual(evaluated.map((result) => `Score ${result.model!.signal_score}`));
    const changes = within(review).getByRole('region', { name: /Changes since previous scan/ });
    expect(changes).toHaveTextContent(`Baseline${IMPORT.scanId}`);
    expect(changes).toHaveTextContent(`Displayed${B.scanId}`);
    // The review started over: no comparison, selection or evidence from scan A.
    expect(screen.queryByRole('region', { name: 'Equities & ETFs comparison' })).toBeNull();
    expect(within(review).getByRole('checkbox', { name: 'Compare AAPL' })).not.toBeChecked();
    expect(review.querySelector('[aria-current="true"]')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetch.mock.calls).toEqual([
      [TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' }],
      [TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' }],
    ]);
  });

  it('keeps the review as it was when the file has not changed', async () => {
    const pending = deferred();
    const { fetch, open } = serve(reads(json(IMPORT), pending.respond));
    const panel = await open('4');
    reviewAapl(panel);
    reload();
    await screen.findByRole('tab', { name: 'TradingView import Reloading' });
    expect(screen.getByRole('status')).toHaveTextContent('Reading the local file…');
    pending.resolve(new Response(JSON.stringify(IMPORT)));
    await screen.findByRole('tab', { name: 'TradingView import 4' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent(`Scan ${IMPORT.scanId}`);
    expect(screen.getByRole('region', { name: 'Equities & ETFs comparison' })).toBeInTheDocument();
    expect(within(panel).getByRole('checkbox', { name: 'Compare AAPL' })).toBeChecked();
    expect(within(panel).getByRole('button', { name: /^AAPL,/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it.each([
    [
      'a malformed file',
      json({ kind: 'something-else' }),
      'Not a TradingView development scan file.',
    ],
    [
      'a file that is not JSON',
      () => Promise.resolve(new Response('{"kind":')),
      'The file is not valid JSON.',
    ],
    ['a server failure', () => Promise.resolve(new Response('', { status: 500 })), 'HTTP 500'],
    [
      'an unreachable server',
      () => Promise.reject(new TypeError('Failed to fetch')),
      'Failed to fetch',
    ],
  ])('keeps scan A on %s, labeled as not reloaded', async (_, failure, reason) => {
    const { open } = serve(reads(json(IMPORT), failure));
    const panel = await open('4');
    reload();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      `Reload failed (${reason}). Still showing scan ${IMPORT.scanId}, imported`,
    );
    expect(alert).toHaveTextContent('it may not be the published scan');
    expect(screen.getByRole('tab', { name: 'TradingView import Failed' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(rowsOf(panel)).toHaveLength(4);
  });

  it('says the scan is no longer published when the file was removed', async () => {
    const { open } = serve(
      reads(json(IMPORT), () => Promise.resolve(new Response('', { status: 404 }))),
    );
    await open('4');
    reload();
    await screen.findByRole('tab', { name: 'TradingView import None' });
    const panel = screen.getByRole('region', { name: 'TradingView development scan' });
    expect(panel).toHaveTextContent('No TradingView scan is published on this machine');
    expect(rowsOf(panel)).toHaveLength(0);
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it.each([
    ['nothing was published', () => Promise.resolve(new Response('', { status: 404 })), 'None'],
    ['the file could not be read', json({ kind: 'something-else' }), 'Unreadable'],
  ])('reloads from the state where %s', async (_, first, state) => {
    const { open } = serve(reads(first, json(B)));
    await open(state);
    reload();
    await screen.findByRole('tab', { name: 'TradingView import 2' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(`Scan ${B.scanId}`);
  });

  it('joins a read in flight instead of starting another', async () => {
    const pending = deferred();
    const { fetch, open } = serve(reads(json(IMPORT), pending.respond));
    await open('4');
    reload();
    reload();
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Reload local scan' })).toHaveAttribute(
        'aria-disabled',
        'true',
      ),
    );
    reload();
    reload();
    expect(fetch).toHaveBeenCalledTimes(2);
    pending.resolve(new Response(JSON.stringify(B)));
    await screen.findByRole('tab', { name: 'TradingView import 2' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never re-reads on its own after a failed reload: not on focus, reconnect or a source switch', async () => {
    const { fetch, pick, open } = serve(
      reads(json(IMPORT), () => Promise.resolve(new Response('', { status: 500 })), json(B)),
    );
    await open('4');
    reload();
    await screen.findByRole('tab', { name: 'TradingView import Failed' });
    pick(/Market data/);
    pick(/TradingView import/);
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    focusManager.setFocused(undefined);
    window.dispatchEvent(new Event('online'));
    await new Promise((done) => setTimeout(done, 50));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent(`Still showing scan ${IMPORT.scanId}`);
  });

  it('lands a reload started before switching to market data, without another read', async () => {
    const pending = deferred();
    const { fetch, pick, open } = serve(reads(json(IMPORT), pending.respond));
    await open('4');
    reload();
    pick(/Market data/);
    expect(screen.getByRole('region', { name: 'Market scan' })).toBeInTheDocument();
    pending.resolve(new Response(JSON.stringify(B)));
    await screen.findByRole('tab', { name: 'TradingView import 2' });
    expect(screen.getByRole('region', { name: 'Market scan' })).not.toHaveTextContent('AAPL');
    pick(/TradingView import/);
    expect(screen.getByRole('status')).toHaveTextContent(`Scan ${B.scanId}`);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
