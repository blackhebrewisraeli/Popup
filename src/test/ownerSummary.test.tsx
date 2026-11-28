import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpotRead } from '@/lib/binanceSpotAccount';

// Synthetic balances and alerts throughout; no Binance account or TradingView webhook is involved.
const OWNER = '00000000-0000-4000-8000-0000000000aa';

type Listener = (payload?: unknown) => void;
interface FakeChannel {
  name: string;
  on: { type: string; filter: Record<string, string>; callback: Listener }[];
  status: ((status: string) => void) | null;
}

const sb = vi.hoisted(() => ({
  owner: true,
  alerts: [] as { id: string; ticker: string; action: string; created_at: string }[],
  alertsError: null as null | { message: string },
  alertQueries: [] as unknown[][][],
  channels: [] as FakeChannel[],
  removed: [] as FakeChannel[],
  invokes: [] as ((answer: { data: unknown; error: unknown }) => void)[],
}));

const auth = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { user: null as null | { id: string } };
  return {
    get: () => state.user,
    set: (user: null | { id: string }) => {
      state.user = user;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name: string) => {
      if (name !== 'is_binance_spot_owner') throw new Error(`Unexpected RPC ${name}`);
      return { data: sb.owner, error: null };
    },
    functions: {
      invoke: (name: string) => {
        if (name !== 'binance-spot-account') throw new Error(`Unexpected function ${name}`);
        return new Promise((resolve) => sb.invokes.push(resolve));
      },
    },
    from: (table: string) => {
      const calls: unknown[][] = [['from', table]];
      const chain = {
        select: (...args: unknown[]) => (calls.push(['select', ...args]), chain),
        eq: (...args: unknown[]) => (calls.push(['eq', ...args]), chain),
        order: (...args: unknown[]) => (calls.push(['order', ...args]), chain),
        limit: (n: number) => {
          calls.push(['limit', n]);
          sb.alertQueries.push(calls);
          return Promise.resolve(
            sb.alertsError
              ? { data: null, error: sb.alertsError }
              : { data: sb.alerts.slice(0, n), error: null },
          );
        },
      };
      return chain;
    },
    channel: (name: string) => {
      const channel: FakeChannel = { name, on: [], status: null };
      const api = {
        on: (type: string, filter: Record<string, string>, callback: Listener) => {
          channel.on.push({ type, filter, callback });
          return api;
        },
        subscribe: (callback: (status: string) => void) => {
          channel.status = callback;
          return api;
        },
        channel,
      };
      sb.channels.push(channel);
      return api;
    },
    removeChannel: async (api: { channel: FakeChannel }) => {
      sb.removed.push(api.channel);
      api.channel.status?.('CLOSED');
      return 'ok';
    },
  },
}));
vi.mock('@/lib/authStore', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react');
  return {
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useAuth: () => ({
      user: useSyncExternalStore(auth.subscribe, auth.get),
      loading: false,
      signOut: vi.fn(),
    }),
  };
});
// The daily board has its own tests; here it only has to stay out of the way.
vi.mock('@/components/DailyCandidates', () => ({ DailyCandidates: () => null }));

import { BinanceSpotBalances } from '@/components/BinanceSpotBalances';
import { OwnerSummary } from '@/components/OwnerSummary';
import { Home, Workspace } from '@/components/Workspace';
import { receivedAlertsKey } from '@/lib/receivedAlerts';
import {
  clearSpotBalanceSession,
  readSpotBalances,
  SPOT_REFRESH_MS,
} from '@/lib/spotBalanceSession';

const START = Date.parse('2026-11-28T09:00:00.000Z');
const connected = (balances = [{ asset: 'BTC', free: '0.00000001', locked: '0.50000000' }]) =>
  ({ state: 'connected', readAt: new Date(Date.now()).toISOString(), balances }) as SpotRead;
const failed = (error: string, extra: object = {}) =>
  ({ state: 'error', error, ...extra }) as SpotRead;
const alert = (n: number, action = 'BUY') => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  ticker: `SYN${n}USDT`,
  action,
  created_at: new Date(START - n * 60_000).toISOString(),
});

/** A balance `read` whose answers the test releases one at a time. */
function deferredReads() {
  const pending: ((read: SpotRead) => void)[] = [];
  const read = vi.fn(() => new Promise<SpotRead>((resolve) => pending.push(resolve)));
  const answer = async (index: number, result: SpotRead) => {
    await act(async () => pending[index]?.(result));
  };
  return { read, answer };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });

function renderSummary(read: () => Promise<SpotRead>, client = newClient()) {
  const view = render(
    <QueryClientProvider client={client}>
      <OwnerSummary userId={OWNER} readBalances={read} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

/** The app's workspace shell with the home screen and a Journal holding the balance card. */
function renderWorkspace() {
  const root = createRootRoute({ component: Outlet });
  const shell = createRoute({ getParentRoute: () => root, id: '_workspace', component: Workspace });
  const zones = [
    createRoute({ getParentRoute: () => shell, path: '/', component: Home }),
    createRoute({
      getParentRoute: () => shell,
      path: 'account',
      component: () => <BinanceSpotBalances accountContext={OWNER} />,
    }),
  ];
  const router = createRouter({
    routeTree: root.addChildren([shell.addChildren(zones)]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const client = newClient();
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return client;
}

/** Answers the newest pending Edge Function call. */
async function answerInvoke(body: unknown) {
  await act(async () => sb.invokes.at(-1)?.({ data: body, error: null }));
}

const balances = () => screen.getByRole('region', { name: /Binance Spot balances/ });
const received = () => screen.getByRole('region', { name: 'Received TradingView alerts' });
const tableRows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .map((row) => Array.from(row.children, (cell) => cell.textContent));
const channel = () => sb.channels.at(-1) as FakeChannel;
const insertListener = () => channel().on[0]?.callback as Listener;

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
}

beforeEach(() => {
  // Date and the minute cadence are simulated; promise and render timers stay real.
  vi.useFakeTimers({ now: START, toFake: ['Date', 'setInterval', 'clearInterval'] });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  visibility = 'visible';
  sb.owner = true;
  sb.alerts = [];
  sb.alertsError = null;
  sb.alertQueries = [];
  sb.channels = [];
  sb.removed = [];
  sb.invokes = [];
  auth.set({ id: OWNER });
});
afterEach(() => {
  cleanup();
  clearSpotBalanceSession();
  vi.useRealTimers();
});

describe('owner gate', () => {
  it('reads neither balances nor alerts for a sign-in without owner access', async () => {
    sb.owner = false;
    renderWorkspace();
    expect(await screen.findByText('This sign-in does not have workspace access.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Account and alerts' })).toBeNull();
    expect(sb.invokes).toHaveLength(0);
    expect(sb.alertQueries).toHaveLength(0);
    expect(sb.channels).toHaveLength(0);
  });

  it('shows the summary on the home screen once the owner check passes', async () => {
    sb.alerts = [alert(1)];
    renderWorkspace();
    expect(await screen.findByRole('region', { name: 'Account and alerts' })).toBeVisible();
    expect(sb.invokes).toHaveLength(1);
    expect(sb.alertQueries[0]).toEqual([
      ['from', 'trading_signals'],
      ['select', 'id, ticker, action, created_at'],
      ['eq', 'user_id', OWNER],
      ['order', 'created_at', { ascending: false }],
      ['order', 'id', { ascending: false }],
      ['limit', 5],
    ]);
    expect(channel().on).toEqual([
      {
        type: 'postgres_changes',
        filter: {
          event: 'INSERT',
          schema: 'public',
          table: 'trading_signals',
          filter: `user_id=eq.${OWNER}`,
        },
        callback: expect.any(Function),
      },
    ]);
  });
});

describe('Binance Spot balances in the summary', () => {
  it('loads on entry and shows asset, available and locked exactly as read', async () => {
    const { read, answer } = deferredReads();
    renderSummary(read);
    expect(within(balances()).getByRole('status')).toHaveTextContent(
      'Reading balances from Binance…',
    );
    expect(within(balances()).queryByRole('table')).toBeNull();
    await answer(
      0,
      connected([
        { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
        { asset: 'USDT', free: '4723846.89208129', locked: '30.00000000' },
      ]),
    );
    expect(tableRows(within(balances()).getByRole('table'))).toEqual([
      ['Asset', 'Available', 'Locked'],
      ['BTC', '0.00000001', '0.00000000'],
      ['USDT', '4723846.89208129', '30.00000000'],
    ]);
    expect(within(balances()).getByRole('status')).toHaveTextContent(
      /^Connected\. Key verified read-only\. Last successful read/,
    );
    expect(within(balances()).getByRole('status').querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(START).toISOString(),
    );
    // No valuation or total is derived from the balances.
    expect(balances().textContent).not.toMatch(/\$|USD\b|total|value/i);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['empty', connected([]), /^Connected\./, 'Binance reports no non-zero Spot balances.'],
    ['not configured', { state: 'not_configured' } as SpotRead, /^Not configured\./, null],
    ['unavailable', { state: 'unavailable' } as SpotRead, /^Unavailable\./, null],
    ['unauthorized', failed('forbidden'), /^Unavailable\./, null],
    ['failed', failed('timeout'), /^$/, 'Binance did not answer in time.'],
  ])('tells the %s state apart', async (name, result, status, text) => {
    const { read, answer } = deferredReads();
    renderSummary(read);
    await answer(0, result);
    const card = balances();
    expect(within(card).getByRole('status')).toHaveTextContent(status);
    if (text) expect(card).toHaveTextContent(text);
    expect(within(card).queryByRole('table')).toBeNull();
    expect(within(card).queryAllByRole('alert')).toHaveLength(name === 'failed' ? 1 : 0);
  });

  it('refreshes every minute while visible, not while hidden, and on return when due', async () => {
    const { read, answer } = deferredReads();
    renderSummary(read);
    await answer(0, connected());
    await act(async () => vi.advanceTimersByTime(SPOT_REFRESH_MS - 5_000));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(5_000));
    expect(read).toHaveBeenCalledTimes(2);
    await answer(1, connected());

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTime(3 * SPOT_REFRESH_MS));
    expect(read).toHaveBeenCalledTimes(2);
    act(() => setVisibility('visible'));
    expect(read).toHaveBeenCalledTimes(3);
    await answer(2, connected());
    // Back again straight away: nothing is due, so nothing is read.
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('sends one request at a time and honors Retry-After for manual and automatic reads', async () => {
    const { read, answer } = deferredReads();
    renderSummary(read);
    await answer(0, connected());
    const refresh = () =>
      within(balances()).getByRole('button', { name: /refresh balances|reading/i });
    fireEvent.click(refresh());
    fireEvent.click(refresh());
    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh()).toHaveAttribute('aria-disabled', 'true');

    await answer(1, failed('rate_limited', { retryAfterSeconds: 120 }));
    expect(within(balances()).getByRole('alert')).toHaveTextContent(
      'Refresh failed. Binance rate limit reached. Refresh is paused for about 120 seconds.',
    );
    expect(refresh()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => vi.advanceTimersByTime(SPOT_REFRESH_MS + 5_000));
    fireEvent.click(refresh());
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTime(120_000 - SPOT_REFRESH_MS));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('never sends a second read while one is in flight, whoever asks', async () => {
    const { read, answer } = deferredReads();
    readSpotBalances(OWNER, read);
    readSpotBalances(OWNER, read);
    renderSummary(read);
    act(() => setVisibility('visible'));
    expect(read).toHaveBeenCalledTimes(1);
    await answer(0, connected());
    readSpotBalances(OWNER, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good balances, labeled, after a failed read and drops them when access is lost', async () => {
    const { read, answer } = deferredReads();
    renderSummary(read);
    await answer(0, connected());
    const readAt = new Date(START).toISOString();
    await act(async () => vi.advanceTimersByTime(SPOT_REFRESH_MS));
    await answer(1, failed('timeout'));
    expect(within(balances()).getByRole('status')).toHaveTextContent(
      /^Not current\. Showing the last successful read, from/,
    );
    expect(within(balances()).getByRole('status').querySelector('time')).toHaveAttribute(
      'datetime',
      readAt,
    );
    expect(within(balances()).getByRole('alert')).toHaveTextContent(
      'Refresh failed. Binance did not answer in time.',
    );
    expect(within(balances()).getByText('0.50000000')).toBeVisible();

    await act(async () => vi.advanceTimersByTime(SPOT_REFRESH_MS));
    await answer(2, failed('forbidden'));
    expect(within(balances()).queryByRole('table')).toBeNull();
    expect(within(balances()).getByRole('status')).toHaveTextContent(/^Unavailable\./);
  });

  it('shares one read with the Journal, so navigating does not read again', async () => {
    renderWorkspace();
    await screen.findByRole('region', { name: 'Account and alerts' });
    await answerInvoke(connected());
    expect(within(balances()).getByText('0.50000000')).toBeVisible();

    fireEvent.click(screen.getByRole('link', { name: 'Journal' }));
    const journal = await screen.findByRole('region', { name: /^Binance Spot\s*Read-only$/ });
    expect(within(journal).getByText('0.50000000')).toBeVisible();
    expect(sb.invokes).toHaveLength(1);

    // The minute cadence carries over to whichever view is on screen.
    await act(async () => vi.advanceTimersByTime(SPOT_REFRESH_MS));
    expect(sb.invokes).toHaveLength(2);
  });

  it('drops an answer that arrives after logout and starts clean at the next sign-in', async () => {
    sb.alerts = [alert(1)];
    const client = renderWorkspace();
    await screen.findByRole('region', { name: 'Account and alerts' });
    await within(received()).findByRole('table');
    expect(sb.invokes).toHaveLength(1);

    act(() => auth.set(null));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(sb.removed).toContain(sb.channels[0]);
    expect(client.getQueryData(receivedAlertsKey(OWNER))).toBeUndefined();

    // The read sent before logout answers now; nobody may see it.
    await act(async () => sb.invokes[0]?.({ data: connected(), error: null }));
    expect(screen.queryByText('0.50000000')).toBeNull();

    act(() => auth.set({ id: OWNER }));
    await screen.findByRole('region', { name: 'Account and alerts' });
    expect(sb.invokes).toHaveLength(2);
    expect(within(balances()).queryByRole('table')).toBeNull();
    expect(within(balances()).getByRole('status')).toHaveTextContent(
      'Reading balances from Binance…',
    );
  });
  it('forgets balances and alerts when the owner check stops passing', async () => {
    sb.alerts = [alert(1)];
    const client = renderWorkspace();
    await screen.findByRole('region', { name: 'Account and alerts' });
    await answerInvoke(connected());
    await within(received()).findByRole('table');

    // The owner check runs again on return to the tab and now says no.
    sb.owner = false;
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    expect(await screen.findByText('This sign-in does not have workspace access.')).toBeVisible();
    expect(client.getQueryData(receivedAlertsKey(OWNER))).toBeUndefined();
    expect(sb.removed).toContain(sb.channels[0]);

    // Access restored: nothing from before is shown, and the balances are read afresh.
    sb.owner = true;
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await screen.findByRole('region', { name: 'Account and alerts' });
    expect(screen.queryByText('0.50000000')).toBeNull();
    expect(sb.invokes).toHaveLength(2);
  });
});

describe('received TradingView alerts', () => {
  const never = () => new Promise<SpotRead>(() => {});

  it('lists the latest five with symbol, action and receipt time, independent of balances', async () => {
    sb.alerts = [1, 2, 3, 4, 5, 6].map((n) => alert(n, n % 2 ? 'BUY' : 'SELL'));
    renderSummary(never);
    const table = await within(received()).findByRole('table', {
      name: 'Received TradingView alerts',
    });
    expect(tableRows(table).slice(0, 3)).toEqual([
      ['Symbol', 'Action', 'Received'],
      ['SYN1USDT', 'BUY', expect.any(String)],
      ['SYN2USDT', 'SELL', expect.any(String)],
    ]);
    expect(tableRows(table)).toHaveLength(6);
    expect(table.querySelector('time')).toHaveAttribute('datetime', alert(1).created_at);
    // Balances are still reading; the alerts did not wait for them.
    expect(within(balances()).getByRole('status')).toHaveTextContent('Reading balances');
    expect(received().textContent).not.toMatch(/executed|filled|order placed/i);
  });

  it('says no alerts were received, apart from a failed read', async () => {
    renderSummary(never);
    expect(
      await within(received()).findByText(
        'No TradingView alerts have been received for this account.',
      ),
    ).toBeVisible();
    expect(within(received()).queryByRole('alert')).toBeNull();
    cleanup();

    sb.alertsError = { message: 'permission denied' };
    renderSummary(never);
    expect(await within(received()).findByRole('alert')).toHaveTextContent(
      'Could not read received alerts.',
    );
    expect(within(received()).queryByText(/No TradingView alerts/)).toBeNull();
    expect(within(received()).queryByRole('table')).toBeNull();
  });

  it('shows an incoming alert, stays bounded to five, and reconciles after a reconnect', async () => {
    sb.alerts = [1, 2, 3, 4, 5].map((n) => alert(n));
    renderSummary(never);
    await within(received()).findByRole('table');
    expect(within(received()).getByRole('status')).toHaveTextContent('Connecting to live updates…');
    await act(async () => channel().status?.('SUBSCRIBED'));
    expect(within(received()).getByRole('status')).toHaveTextContent(
      'Live. New alerts appear as they are received.',
    );

    sb.alerts.unshift({ ...alert(0, 'SELL'), ticker: 'NEWUSDT' });
    await act(async () => insertListener()({ eventType: 'INSERT' }));
    await within(received()).findByText('NEWUSDT');
    const rows = tableRows(within(received()).getByRole('table'));
    expect(rows).toHaveLength(6);
    expect(rows[1]?.slice(0, 2)).toEqual(['NEWUSDT', 'SELL']);
    expect(within(received()).queryByText('SYN5USDT')).toBeNull();

    // An alert lands while the connection is down; the reconnect picks it up.
    await act(async () => channel().status?.('CHANNEL_ERROR'));
    expect(within(received()).getByRole('status')).toHaveTextContent(
      'Live updates unavailable. Use Refresh alerts to check for new ones.',
    );
    sb.alerts.unshift({ ...alert(0), id: 'gap', ticker: 'GAPUSDT' });
    await act(async () => channel().status?.('SUBSCRIBED'));
    expect(await within(received()).findByText('GAPUSDT')).toBeVisible();
  });

  it('refreshes by hand when Realtime is unavailable, and stops listening on unmount', async () => {
    sb.alerts = [alert(1)];
    const { unmount } = renderSummary(never);
    await within(received()).findByRole('table');
    await act(async () => channel().status?.('TIMED_OUT'));
    expect(within(received()).getByRole('status')).toHaveTextContent('Live updates unavailable.');
    const before = sb.alertQueries.length;
    sb.alerts.unshift({ ...alert(0), ticker: 'HANDUSDT' });
    fireEvent.click(within(received()).getByRole('button', { name: 'Refresh alerts' }));
    expect(await within(received()).findByText('HANDUSDT')).toBeVisible();
    expect(sb.alertQueries).toHaveLength(before + 1);

    unmount();
    expect(sb.removed).toEqual([sb.channels[0]]);
  });
});
