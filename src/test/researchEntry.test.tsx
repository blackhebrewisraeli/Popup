import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRoute,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortfolioContainer } from '@/lib/portfolioAccounting';

/**
 * Research's entry point in the real workspace shell, on SYNTHETIC data: the collector runs
 * against a fake Binance into an in-process store, and a stand-in Supabase client serves those
 * rows and records every table read. Market data and the model scan are stubbed so each can fail
 * or come back empty on its own.
 */
const db = vi.hoisted(() => ({
  owner: true,
  rows: { discovery_batches: [] as unknown[], discovery_attempts: [] as unknown[] },
  reads: [] as string[],
  scanFailed: false,
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name: string) => {
      if (name !== 'is_binance_spot_owner') throw new Error(`Unexpected RPC ${name}`);
      return { data: db.owner, error: null };
    },
    from: (table: string) => {
      db.reads.push(table);
      const rows = (db.rows as Record<string, unknown[]>)[table] ?? [];
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: (n: number) => ({
          abortSignal: async () => ({ data: rows.slice(0, n), error: null }),
        }),
      };
      return chain;
    },
  },
}));
vi.mock('@/lib/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authStore')>()),
  useAuth: () => ({
    user: { id: '00000000-0000-4000-8000-0000000000d1', email: 'owner@example.test' },
    loading: false,
    signOut: vi.fn(),
  }),
}));
const EMPTY: PortfolioContainer = {
  type: 'real_tracking',
  positions: [],
  cashBalance: 0,
  cashLedger: [],
  transactions: [],
  realizedPnl: 0,
};
vi.mock('@/lib/portfolioStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/portfolioStore')>()),
  usePortfolio: () => ({
    activePortfolioType: 'real_tracking',
    portfolios: { paper_trading: EMPTY, long_term_sim: EMPTY, real_tracking: EMPTY },
  }),
}));
vi.mock('@/lib/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assets')>()),
  fetchAssets: vi.fn(),
}));
vi.mock('@/hooks/useBinanceWebSocket', () => ({ useBinanceWebSocket: () => {} }));
vi.mock('@/hooks/useAlertEngine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAlertEngine')>()),
  useAlertEngine: () => {},
}));
vi.mock('@/hooks/useMarketScan', () => ({
  useMarketScan: () => ({
    data: undefined,
    dataUpdatedAt: 0,
    isFetching: false,
    isError: db.scanFailed,
  }),
}));
vi.mock('@/components/AccountPanel', () => ({ AccountPanel: () => <p>Account panel</p> }));

import { Workspace } from '@/components/Workspace';
import { fetchAssets, type Asset } from '@/lib/assets';
import { findTarget } from '@/lib/tourSteps';
import { runDailyDiscovery } from '../../scripts/dailyDiscovery';
import {
  at,
  binanceFake,
  memoryDiscoveryStore,
  syntheticMarket,
  testClock,
} from './dailyDiscoveryFixtures';

const BTC: Asset = {
  ticker: 'BTC-USD',
  name: 'Bitcoin',
  current_price: 1,
  stable_signal: null,
  radar_signal: null,
  stable_explanation: null,
  radar_explanation: null,
  risk_pct: null,
  reward_pct: null,
  volume_spike: null,
  rsi_14: null,
  sma_50: null,
  sma_200: null,
  change_24h: null,
};

/** Runs the collector once per time and serves the stored rows to the board. */
async function collect(times: number[]) {
  const storage = memoryDiscoveryStore();
  for (const [index, time] of times.entries()) {
    const clock = testClock(time);
    await runDailyDiscovery({
      store: storage.store,
      attemptId: `gh-${index + 1}-1`,
      deps: {
        fetch: binanceFake(syntheticMarket(), clock).fetch,
        now: clock.now,
        sleep: clock.sleep,
      },
    });
  }
  db.rows.discovery_batches = storage.batchRows();
  db.rows.discovery_attempts = storage.attemptRows();
}

/** A fresh load of `/`, as the app routes it: zones under the shared workspace layout. */
function load() {
  vi.setSystemTime(at(9));
  const root = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => root, id: '_workspace', component: Workspace });
  const zones: AnyRoute[] = ['/', 'paper-trading', 'account'].map((path) =>
    createRoute({ getParentRoute: () => shell, path }),
  );
  const router = createRouter({
    routeTree: root.addChildren([shell.addChildren(zones)]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  // No wait before the market-data query's own retry.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const places = () => screen.getByRole('tablist', { name: 'Research' });
const place = (name: string) => within(places()).getByRole('tab', { name });
const board = () => screen.findByRole('region', { name: 'Daily candidates' });
const shown = (name: string) =>
  screen.queryAllByRole('region', { name }).filter((el) => el.closest('[hidden]') === null);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('DEV', false);
  db.owner = true;
  db.reads = [];
  db.scanFailed = false;
  db.rows = { discovery_batches: [], discovery_attempts: [] };
  vi.mocked(fetchAssets).mockReset().mockResolvedValue([BTC]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Research entry point', () => {
  it('opens on Daily candidates, ahead of Model scan (1D) and the Markets directory', async () => {
    await collect([at(0, 33, 5)]);
    load();
    const section = await board();
    expect(
      within(places())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Daily candidates', 'Model scan (1D)', 'Markets directory']);
    expect(place('Daily candidates')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/Dated Binance Spot liquidity discovery/).textContent).toMatch(
      /That rank is not a model score or a prediction\./,
    );
    expect(within(section).getByText('Current')).toBeInTheDocument();
    expect(
      await within(section).findByRole('button', { name: 'Open BTC-USD details (BTCUSDT)' }),
    ).toBeInTheDocument();
    expect(shown('Market scan')).toHaveLength(0);
    expect(shown('Markets directory')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /saved crypto scan/i })).toBeNull();

    fireEvent.click(place('Model scan (1D)'));
    expect(place('Model scan (1D)')).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByText(/existing model evaluated on closed daily \(1D\) candles/),
    ).toBeTruthy();
    expect(shown('Market scan')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /saved crypto scan/i })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Daily candidates' })).toBeNull();

    fireEvent.click(place('Markets directory'));
    expect(shown('Markets directory')).toHaveLength(1);
    expect(screen.queryByText(/Dated Binance Spot liquidity discovery/)).toBeNull();

    fireEvent.click(place('Daily candidates'));
    expect(within(await board()).getByText('Current')).toBeInTheDocument();
  });

  it('shows other sign-ins the access notice and reads no batch or attempt', async () => {
    await collect([at(0, 33, 5)]);
    db.owner = false;
    load();
    expect(await screen.findByText(/visible only to the configured owner/)).toBeInTheDocument();
    expect(place('Daily candidates')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('table')).toBeNull();
    expect(db.reads.filter((table) => table.startsWith('discovery_'))).toEqual([]);
  });

  it('keeps the board usable when market data and the model scan fail', async () => {
    await collect([at(0, 33, 5)]);
    vi.mocked(fetchAssets).mockRejectedValue(new Error('synthetic outage'));
    db.scanFailed = true;
    load();
    const section = await board();
    await waitFor(() => expect(screen.getByText('Offline')).toBeInTheDocument());
    expect(within(section).getByText('Current')).toBeInTheDocument();
    expect(within(within(section).getByRole('table')).getAllByRole('row')).toHaveLength(51);
    // No row claims its pair has no Popup asset: the detail route is simply not loaded.
    expect(within(section).queryByRole('button', { name: /^Open / })).toBeNull();
    expect(
      within(section).getAllByText('Live market data is not loaded, so no asset detail is linked'),
    ).toHaveLength(50);
    expect(within(section).queryByText('No Popup asset maps to this exact pair')).toBeNull();
    // The market-data banner belongs to the scan and directory, not to the board.
    expect(screen.queryByText(/Unable to load signals/)).toBeNull();

    fireEvent.click(place('Model scan (1D)'));
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load signals');
  });

  it('never labels the board as sample data when market data comes back empty', async () => {
    await collect([at(0, 33, 5)]);
    vi.mocked(fetchAssets).mockResolvedValue([]);
    load();
    const section = await board();
    await waitFor(() => expect(screen.getAllByText('Sample data')).toHaveLength(1));
    expect(screen.queryByText(/Illustrative prices and signals/)).toBeNull();
    expect(within(section).getByText('ZCT001USDT')).toBeInTheDocument();
    expect(within(section).getAllByText('No Popup asset maps to this exact pair')).toHaveLength(50);

    fireEvent.click(place('Model scan (1D)'));
    expect(screen.getByText(/Illustrative prices and signals/)).toBeInTheDocument();
  });

  it('says when no batch exists yet, with nothing standing in for it', async () => {
    await collect([at(6, 5)]);
    load();
    const section = await board();
    expect(within(section).getByText('No batch to show')).toBeInTheDocument();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('tours Daily candidates first, opening each Research place before pointing at it', async () => {
    db.owner = false;
    const router = load();
    await screen.findByText(/visible only to the configured owner/);
    fireEvent.click(screen.getByRole('tab', { name: 'Account' }));
    await screen.findByText('Account panel');

    fireEvent.click(screen.getByRole('button', { name: 'Start product tour' }));
    await screen.findByRole('heading', { name: 'Your workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Research › Daily candidates' }, { timeout: 3000 });
    expect(router.state.location.pathname).toBe('/');
    expect(findTarget(['place-daily'])).toBe(place('Daily candidates'));
    expect(place('Daily candidates')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Research › Model scan (1D)' }, { timeout: 3000 });
    expect(findTarget(['place-scan'])).toBe(place('Model scan (1D)'));
    expect(place('Model scan (1D)')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Research › Daily candidates' }, { timeout: 3000 });
    expect(place('Daily candidates')).toHaveAttribute('aria-selected', 'true');
  }, 10_000);
});
