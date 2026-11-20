import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRoute,
} from '@tanstack/react-router';
import type { RouteComponent } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalSignal } from '@/lib/decisionJournal';
import {
  applyBuyTransaction,
  replayPaperLedger,
  type PortfolioContainer,
} from '@/lib/portfolioAccounting';

/**
 * Paper Desk and Build Portfolio are paused. Their old URL shows a read-only Simulation history
 * that reads the loaded ledgers and the Signal Journal and writes nothing. SYNTHETIC data only.
 */
const USER = { id: 'synthetic-user', email: 'synthetic@example.test' };

/** One BUY on the paper ledger, one on the simulated portfolio: an open lot in each. */
const PAPER = replayPaperLedger([
  {
    id: 'paper-fill-1',
    action: 'BUY',
    ticker: 'ZCTA-USD',
    quantity: 2,
    price: 100,
    fees: 0.5,
    created_at: '2026-10-27T07:22:05.000Z',
  },
]);
const simulated = applyBuyTransaction(
  {
    type: 'long_term_sim',
    positions: [],
    cashBalance: 10_000,
    cashLedger: [],
    transactions: [],
    realizedPnl: 0,
  },
  { ticker: 'ZCTB-USD', shares: 3, price: 50, fee: 0.375, timestamp: '2026-10-20T10:00:00.000Z' },
);
if (!simulated.ok) throw new Error('synthetic simulated buy was refused');
const EMPTY: PortfolioContainer = {
  type: 'real_tracking',
  positions: [],
  cashBalance: 0,
  cashLedger: [],
  transactions: [],
  realizedPnl: 0,
};

const mocks = vi.hoisted(() => {
  const mutators = Object.fromEntries(
    [
      'setActivePortfolioType',
      'executeBuy',
      'executeSell',
      'depositPortfolioCash',
      'transactPortfolio',
      'withdrawPortfolioCash',
      'executePaperTrade',
      'topUpPaperCash',
      'resetPaperAccount',
      'replacePaperLedger',
      'setTargetAllocations',
      'depositCash',
      'withdrawCash',
      'switchScope',
      'addPosition',
      'addPositions',
      'replacePositions',
      'replacePortfolioState',
      'removePosition',
      'updatePosition',
    ].map((name) => [name, vi.fn()]),
  );
  const writes = {
    savePortfolio: vi.fn(),
    savePortfolioStateV3: vi.fn(),
    insertPaperTransaction: vi.fn(),
    executePaperPortfolio: vi.fn(),
  };
  return { mutators, writes, loadJournalPage: vi.fn(), downloadCsv: vi.fn() };
});

vi.mock('@/lib/portfolioStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/portfolioStore')>()),
  usePortfolio: () => ({
    ...mocks.mutators,
    scopeUserId: USER.id,
    activePortfolioType: 'real_tracking',
    portfolios: { paper_trading: PAPER, long_term_sim: simulated.container, real_tracking: EMPTY },
    getPortfolio: (type: 'paper_trading' | 'long_term_sim' | 'real_tracking') =>
      ({ paper_trading: PAPER, long_term_sim: simulated.container, real_tracking: EMPTY })[type],
  }),
}));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  ...mocks.writes,
  loadJournalPage: mocks.loadJournalPage,
}));
vi.mock('@/lib/tradeLedger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tradeLedger')>()),
  downloadCsv: mocks.downloadCsv,
}));
vi.mock('@/lib/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authStore')>()),
  useAuth: () => ({ user: USER, loading: false, isPro: false, signOut: vi.fn() }),
}));
// The shell's market feed, alert pipeline and scan: none of them is under test here.
vi.mock('@/lib/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/assets')>()),
  fetchAssets: vi.fn(async () => []),
}));
vi.mock('@/hooks/useBinanceWebSocket', () => ({ useBinanceWebSocket: () => {} }));
vi.mock('@/hooks/useAlertEngine', () => ({ useAlertEngine: () => {} }));
vi.mock('@/hooks/useMarketScan', () => ({
  useMarketScan: () => ({ data: undefined, dataUpdatedAt: 0, isFetching: false, isError: false }),
}));
vi.mock('@/components/AccountPanel', () => ({ AccountPanel: () => <p>Account panel</p> }));

import { SimulationHistory } from '@/components/SimulationHistory';
import { Workspace } from '@/components/Workspace';

const JOURNAL_SIGNAL: JournalSignal = {
  id: 'signal-1',
  ticker: 'ZCTAUSDT',
  action: 'BUY',
  signal_kind: 'strategy',
  signal_score: 81,
  quantity: 2,
  stop_loss: 97,
  price: 100,
  status: 'EXECUTED',
  event_id: 'evt-1',
  exchange: 'ZC_SYNTHETIC',
  timeframe: '1D',
  bar_time: '2026-10-27T00:00:00+00:00',
  model_version: '1.0.0-pw200',
  created_at: '2026-10-27T07:20:00+00:00',
  paper_transactions: [
    {
      id: 'paper-fill-1',
      action: 'BUY',
      ticker: 'ZCTA-USD',
      quantity: 2,
      price: 100,
      fees: 0.5,
      created_at: '2026-10-27T07:22:05+00:00',
    },
  ],
  trading_signal_dismissals: null,
};

/** The app's zones under a pathless `_workspace` layout, as in routeTree.gen.ts. */
function renderAt(path: string, layout: RouteComponent = Workspace) {
  const root = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => root, id: '_workspace', component: layout });
  const zones: AnyRoute[] = ['/', 'paper-trading', 'account'].map((zonePath) =>
    createRoute({ getParentRoute: () => shell, path: zonePath }),
  );
  const router = createRouter({
    routeTree: root.addChildren([shell.addChildren(zones)]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
let storageSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadJournalPage.mockResolvedValue({ rows: [JOURNAL_SIGNAL], next: null, total: 1 });
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  storageSpy = vi.spyOn(Storage.prototype, 'setItem');
});
afterEach(() => {
  fetchSpy.mockRestore();
  storageSpy.mockRestore();
});

const nav = () => screen.getByRole('tablist', { name: 'Workspace' });
const tabNames = () =>
  within(nav())
    .getAllByRole('tab')
    .map((tab) => tab.textContent?.trim());

describe('the retired Paper Desk and Build Portfolio', () => {
  it('leave primary navigation with Research and Account only', async () => {
    renderAt('/account');
    expect(await screen.findByText('Account panel')).toBeInTheDocument();
    expect(tabNames()).toEqual(['Research', 'Account']);
    expect(within(nav()).queryByText(/Paper Desk/)).toBeNull();
  });

  it('send an old /paper-trading link to read-only Simulation history, never the terminal', async () => {
    const router = renderAt('/paper-trading');
    const history = await screen.findByRole('region', { name: 'Simulation history' });

    expect(history).toHaveTextContent('Paper Desk and Build Portfolio are paused');
    // History sits under Account; nothing in the header leads back to a trading desk.
    expect(tabNames()).toEqual(['Research', 'Account']);
    expect(within(nav()).getByRole('tab', { name: 'Account' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    for (const name of ['Paper trading terminal', 'Simulated portfolio', 'Quick order']) {
      expect(screen.queryByRole('region', { name })).toBeNull();
    }
    expect(within(history).getByRole('link', { name: 'Back to Research' })).toHaveAttribute(
      'href',
      '/',
    );

    fireEvent.click(within(nav()).getByRole('tab', { name: 'Account' }));
    expect(await screen.findByText('Account panel')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
  });
});

describe('Simulation history', () => {
  it('reads and exports both simulated ledgers and the journal, with no way to change them', async () => {
    renderAt('/paper-trading', () => <SimulationHistory />);
    const history = await screen.findByRole('region', { name: 'Simulation history' });

    // Each ledger states where it ended, as simulated money, without a live price.
    expect(history).toHaveTextContent(
      'At the last record: $99,799.50 simulated cash and 1 open simulated position: ZCTA-USD 2.',
    );
    expect(history).toHaveTextContent(
      'At the last record: $9,849.63 simulated cash and 1 open simulated position: ZCTB-USD 3.',
    );

    const paperToggle = within(history).getByRole('button', { name: 'Paper Trading ledger' });
    expect(paperToggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(paperToggle);
    expect(paperToggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(paperToggle.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(within(panel!).getByText('ZCTA-USD')).toBeInTheDocument();
    fireEvent.click(within(history).getByRole('button', { name: 'Simulation ledger' }));

    fireEvent.click(
      within(history).getByRole('button', { name: 'Export CSV, Paper Trading ledger' }),
    );
    fireEvent.click(within(history).getByRole('button', { name: 'Export CSV, Simulation ledger' }));
    expect(mocks.downloadCsv.mock.calls.map(([filename]) => filename)).toEqual([
      'popup-ledger-paper.csv',
      'popup-ledger-simulation.csv',
    ]);
    expect(mocks.downloadCsv.mock.calls[0]?.[1]).toContain('ZCTA-USD');

    const journal = within(history).getByRole('region', { name: 'Signal journal' });
    expect(await within(journal).findByText('ZCTAUSDT')).toBeInTheDocument();
    expect(journal).toHaveTextContent(
      'the Action Center that executed or dismissed signals is paused',
    );
    fireEvent.click(within(journal).getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(mocks.loadJournalPage).toHaveBeenCalledTimes(2));

    // Only reading controls: ledger toggles, exports and the journal's refresh.
    const buttons = [...history.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent?.trim(),
    );
    expect(buttons).toHaveLength(5);
    expect(new Set(buttons)).toEqual(
      new Set([
        'Paper Trading ledger',
        'Simulation ledger',
        'Export CSV, Paper Trading ledger',
        'Export CSV, Simulation ledger',
        'Refresh',
      ]),
    );

    // Opening, expanding, exporting and refreshing wrote nothing anywhere.
    for (const mutate of Object.values(mocks.mutators)) expect(mutate).not.toHaveBeenCalled();
    for (const write of Object.values(mocks.writes)) expect(write).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
  });
});
