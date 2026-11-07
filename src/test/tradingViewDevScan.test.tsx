import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { TradingViewDevScan } from '@/components/TradingViewDevScan';
import { evaluateScan, type MarketScan } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan as DevScan,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, split, wave } from './usEquityFixtures';

/** Labeled fixture: one synthetic equity series, not TradingView data. */
const VIEW: DevScan = {
  kind: TRADINGVIEW_DEV_SCAN_KIND,
  scanId: '20261028T170000Z-00000000',
  importedAt: new Date(EQUITY_NOW).toISOString(),
  source: {
    tool: 'get_ohlcv',
    interval: '1D',
    retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: '2026-10-28T17:00:00.000Z' },
    symbols: { AAPL: 'NASDAQ:AAPL' },
    notice: 'regular session only; prices are split-adjusted only.',
    selectionRule: 'Labeled fixture universe.',
    pineAlerts: null,
  },
  scan: scanAt(EQUITY_NOW),
};

/** One synthetic AAPL series scored at `time`, on the latest session final by then. */
function scanAt(time: number, last?: string): MarketScan {
  return evaluateScan(
    [
      {
        ticker: 'AAPL',
        instrument: 'US:AAPL',
        equity: {
          provider: TRADINGVIEW_DEV_PROVIDER_ID,
          range: { from: '2026-01-12', to: last ?? '2026-10-27' },
          series: split(bars(wave, 200, last)),
          fetchedAt: time,
          cached: false,
        },
      },
    ],
    {
      evaluationTime: time,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    },
  );
}

const DAY = 86_400_000;

const HOUR = 3_600_000;

/** The fixture's Risk warning recorded the other way by hand. */
function flipped(scan: MarketScan): MarketScan {
  const risk = !VIEW.scan.results[0]!.setups!.risk;
  return {
    ...scan,
    results: scan.results.map((result) => ({ ...result, setups: { long: false, risk } })),
  };
}

/** The 26 Oct reading of the same fixture, its Risk warning recorded the other way. */
function baselineScan(): MarketScan {
  return flipped(scanAt(EQUITY_NOW - DAY, '2026-10-26'));
}

/** A scan at `time` in which AAPL was never retrieved. */
function failedScan(time: number): MarketScan {
  return evaluateScan(
    [
      {
        ticker: 'AAPL',
        instrument: 'US:AAPL',
        equity: {
          provider: TRADINGVIEW_DEV_PROVIDER_ID,
          range: { from: '2026-01-12', to: '2026-10-27' },
        },
        error: { code: 'FETCH_FAILED', detail: 'Labeled fixture: never retrieved.' },
      },
    ],
    {
      evaluationTime: time,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    },
  );
}

function serve(response: Response) {
  const fetch = vi.fn(async () => response);
  vi.stubGlobal('fetch', fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TradingViewDevScan />
    </QueryClientProvider>,
  );
  return { fetch, ...view };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TradingViewDevScan', () => {
  it('shows the imported scan from the dev-server route', async () => {
    const { fetch } = serve(new Response(JSON.stringify(VIEW)));
    expect(await screen.findByText('TradingView alerts were not checked.')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'TradingView development scan' }),
    ).not.toHaveAttribute('aria-busy', 'true');
    expect(fetch).toHaveBeenCalledWith(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
  });

  it('says it is reading the import while the route has not answered', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TradingViewDevScan />
      </QueryClientProvider>,
    );
    const panel = screen.getByRole('region', { name: 'TradingView development scan' });
    expect(panel).toHaveAttribute('aria-busy', 'true');
    expect(panel).toHaveTextContent('Reading the local TradingView import…');
  });

  it('says nothing was imported, and how a scan is made, when the route has no file', async () => {
    serve(new Response(null, { status: 404 }));
    const panel = await screen.findByRole('region', { name: 'TradingView development scan' });
    await vi.waitFor(() =>
      expect(panel).toHaveTextContent('No TradingView scan has been imported on this machine'),
    );
    expect(panel).toHaveTextContent('npm run evaluate -- tradingview-import');
    expect(panel.querySelector('.scan-row')).toBeNull();
  });

  it('reports an unreadable file instead of a partial scan', async () => {
    serve(new Response(JSON.stringify({ kind: TRADINGVIEW_DEV_SCAN_KIND })));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not a TradingView development scan file.',
    );
    expect(screen.queryByText('Ranked valid assets')).not.toBeInTheDocument();
  });

  it('reports a server error', async () => {
    serve(new Response(null, { status: 403 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403');
  });

  it('says no baseline is named, and how to name one, before any comparison', async () => {
    serve(new Response(JSON.stringify(VIEW)));
    const changes = await screen.findByRole('region', { name: /Changes since previous scan/ });
    expect(changes).toHaveTextContent('No earlier scan is named, so nothing is compared.');
    expect(changes).toHaveTextContent('npm run evaluate -- tradingview-baseline SCAN_ID');
  });

  it('lists a setup that moved and opens that asset’s evidence from the change', async () => {
    const baseline = {
      scanId: '20261027T170000Z-00000000',
      importedAt: VIEW.importedAt,
      scan: baselineScan(),
    };
    serve(new Response(JSON.stringify({ ...VIEW, baseline })));
    const changes = await screen.findByRole('region', { name: /Changes since previous scan/ });
    expect(changes).toHaveTextContent(baseline.scanId);
    expect(changes).toHaveTextContent('26 Oct session (New York) · 1 of 1 evaluated');
    expect(changes).toHaveTextContent('27 Oct session (New York) · 1 of 1 evaluated');
    expect(changes).toHaveTextContent('Consecutive sessions.');
    const moved = within(within(changes).getByRole('list', { name: 'Setups that changed' }));
    const word = VIEW.scan.results[0]!.setups!.risk ? 'appeared' : 'cleared';
    const row = moved.getByRole('button', { name: new RegExp(`AAPL.*Risk warning ${word}`) });
    expect(row).toHaveTextContent(/Score \d+ → \d+/);

    fireEvent.click(row);
    const sheet = await screen.findByRole('dialog', { name: 'AAPL explanation' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    // The ranked list is still there, unchanged.
    expect(document.querySelectorAll('[data-scan-row]')).toHaveLength(1);
  });

  it.each([
    {
      name: 'a same-session re-import as a revision',
      baseline: () => flipped(scanAt(EQUITY_NOW - 2 * HOUR)),
      displayed: VIEW.scan,
      expected: ['Both rest on the same session', /Risk warning (holds|gone) after revision/],
    },
    {
      name: 'the sessions a gap skipped',
      baseline: () => scanAt(EQUITY_NOW - 7 * DAY, '2026-10-20'),
      displayed: VIEW.scan,
      expected: ['4 sessions between them (21 Oct–26 Oct) were never evaluated', 'not an alert'],
    },
    {
      name: 'an asset evaluated only now as having no earlier reading',
      baseline: () => failedScan(EQUITY_NOW - DAY),
      displayed: VIEW.scan,
      expected: [
        'One scan evaluated no asset',
        'Evaluated only in the displayed scan, so there is no earlier reading: AAPL.',
        'No asset was evaluated in both scans.',
        'Risk warnings0 appeared · 0 cleared · 0 held in both',
      ],
    },
    {
      name: 'an asset evaluated only before as neither confirmed nor cleared',
      baseline: () => scanAt(EQUITY_NOW - DAY, '2026-10-26'),
      displayed: failedScan(EQUITY_NOW),
      expected: [
        'Not evaluated in the displayed scan, so their earlier setups are neither confirmed nor cleared: AAPL.',
        'Risk warnings0 appeared · 0 cleared · 0 held in both',
      ],
    },
  ])('describes $name', async ({ baseline, displayed, expected }) => {
    const view = {
      ...VIEW,
      scan: displayed,
      baseline: {
        scanId: '20261027T170000Z-00000000',
        importedAt: VIEW.importedAt,
        scan: baseline(),
      },
    };
    serve(new Response(JSON.stringify(view)));
    const changes = await screen.findByRole('region', { name: /Changes since previous scan/ });
    for (const text of expected) expect(changes).toHaveTextContent(text);
  });

  it('says what differs instead of comparing an incompatible baseline', async () => {
    const scan = { ...baselineScan(), modelVersion: '0.9.0' as '1.0.0' };
    const baseline = { scanId: '20261027T170000Z-00000000', importedAt: VIEW.importedAt, scan };
    serve(new Response(JSON.stringify({ ...VIEW, baseline })));
    const changes = await screen.findByRole('region', { name: /Changes since previous scan/ });
    expect(changes).toHaveTextContent('Not comparable');
    expect(within(changes).getByRole('row', { name: 'Model 0.9.0 1.0.0' })).toBeInTheDocument();
    expect(within(changes).queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows no changes view outside the TradingView import', () => {
    render(
      <MarketScanSummary
        scan={VIEW.scan}
        completedAt={EQUITY_NOW}
        scanning={false}
        failed={false}
      />,
    );
    expect(screen.queryByRole('region', { name: /Changes since previous scan/ })).toBeNull();
  });
});
