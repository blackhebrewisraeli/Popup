import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  scanInputs: vi.fn(),
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
vi.mock('@/lib/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assets')>()),
  fetchAssets: vi.fn(),
}));
vi.mock('@/hooks/useMarketScan', () => ({
  useMarketScan: (tickers: string[], source: string, active: boolean) => {
    db.scanInputs(tickers, source, active);
    return {
      data: undefined,
      dataUpdatedAt: 0,
      isFetching: false,
      isError: db.scanFailed,
    };
  },
}));

import { DailyResearch, Workspace } from '@/components/Workspace';
import { fetchAssets, type Asset } from '@/lib/assets';
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
  const zones = [
    createRoute({ getParentRoute: () => shell, path: '/', component: DailyResearch }),
    createRoute({
      getParentRoute: () => shell,
      path: 'account',
      component: () => <p>Spot journal test outlet</p>,
    }),
  ];
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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubEnv('DEV', false);
  db.owner = true;
  db.reads = [];
  db.scanFailed = false;
  db.scanInputs.mockClear();
  db.rows = { discovery_batches: [], discovery_attempts: [] };
  vi.mocked(fetchAssets).mockReset().mockResolvedValue([BTC]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('Private Spot workspace', () => {
  it('opens on candidates without reading the model universe, and links to the journal', async () => {
    await collect([at(0, 33, 5)]);
    load();
    const candidates = await board();
    expect(within(candidates).getAllByRole('link', { name: /intraday chart/ })).toHaveLength(50);
    expect(
      within(places())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Daily candidates', 'Model scan (1D)']);
    expect(place('Daily candidates')).toHaveAttribute('aria-selected', 'true');
    expect(fetchAssets).not.toHaveBeenCalled();

    const nav = screen.getByRole('navigation', { name: 'Workspace' });
    const journal = within(nav).getByRole('link', { name: 'Journal' });
    expect(journal).toHaveAttribute('href', '/account');
    fireEvent.click(journal);
    expect(await screen.findByText('Spot journal test outlet')).toBeInTheDocument();
    expect(journal).toHaveAttribute('aria-current', 'page');
  });

  it('reads neither candidates nor the model universe for a different sign-in', async () => {
    db.owner = false;
    load();
    expect(
      await screen.findByText('This sign-in does not have workspace access.'),
    ).toBeInTheDocument();
    expect(db.reads).toEqual([]);
    expect(fetchAssets).not.toHaveBeenCalled();
    expect(screen.queryByRole('navigation', { name: 'Workspace' })).toBeNull();
  });

  it('scans only Binance Spot symbols and keeps candidates usable when the scan fails', async () => {
    await collect([at(0, 33, 5)]);
    vi.mocked(fetchAssets).mockResolvedValue([BTC, { ...BTC, ticker: 'AAPL' }]);
    db.scanFailed = true;
    load();
    await board();
    fireEvent.click(place('Model scan (1D)'));
    await waitFor(() =>
      expect(db.scanInputs).toHaveBeenLastCalledWith(['BTC-USD'], 'assets_status', true),
    );
    expect(await screen.findByRole('button', { name: 'Retry scan' })).toBeInTheDocument();
    fireEvent.click(place('Daily candidates'));
    expect(within(await board()).getByText('Current')).toBeInTheDocument();
  });

  it('shows an empty scan universe without substituting sample assets', async () => {
    vi.mocked(fetchAssets).mockResolvedValue([]);
    load();
    await board();
    fireEvent.click(place('Model scan (1D)'));
    expect(
      await screen.findByText('No Binance Spot pairs are configured for the daily model scan.'),
    ).toBeInTheDocument();
    expect(db.scanInputs).toHaveBeenLastCalledWith([], 'assets_status', true);
  });
});
