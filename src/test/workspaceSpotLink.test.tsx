import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { describe, expect, it, vi } from 'vitest';

// Account itself is covered with the Binance card in spotExperiments.test.tsx; here it only
// reports whether the URL asked it to reveal Manual Spot experiments.
vi.mock('@/components/AccountPanel', () => ({
  AccountPanel: ({ revealSpotExperiments }: { revealSpotExperiments?: boolean }) => (
    <p>{revealSpotExperiments ? 'Account: reveal Manual Spot experiments' : 'Account'}</p>
  ),
}));

import { AccountZone, ClosedBetaBanner } from '@/components/Workspace';

/** The workspace's banner over a Research and an Account zone, starting at `path`. */
function renderAt(path: string) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const root = createRootRoute({
    component: () => (
      <>
        <ClosedBetaBanner />
        <Outlet />
      </>
    ),
  });
  const routeTree = root.addChildren([
    createRoute({ getParentRoute: () => root, path: '/', component: () => <p>Research</p> }),
    createRoute({
      getParentRoute: () => root,
      path: '/account',
      component: () => <AccountZone assets={[]} />,
    }),
  ]);
  const router = createRouter({ routeTree, history });
  render(<RouterProvider router={router} />);
  return { router, history };
}

const link = () => screen.getByRole('link', { name: 'Manual Spot experiments' });

describe('the workspace link to Manual Spot experiments', () => {
  it('leads from another zone to the section in Account', async () => {
    const { router } = renderAt('/');
    expect(await screen.findByText('Research')).toBeInTheDocument();
    expect(link()).toHaveAttribute('href', '/account#spot-experiments');

    fireEvent.click(link());
    expect(await screen.findByText('Account: reveal Manual Spot experiments')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/account');
  });

  it('reveals the section on a direct load or refresh of the link, and not on plain /account', async () => {
    renderAt('/account#spot-experiments');
    expect(await screen.findByText('Account: reveal Manual Spot experiments')).toBeInTheDocument();
    cleanup();

    renderAt('/account');
    expect(await screen.findByText('Account')).toBeInTheDocument();
  });

  it('follows back and forward, also within Account', async () => {
    const { history } = renderAt('/account');
    expect(await screen.findByText('Account')).toBeInTheDocument();

    fireEvent.click(link());
    expect(await screen.findByText('Account: reveal Manual Spot experiments')).toBeInTheDocument();

    await act(async () => history.back());
    expect(await screen.findByText('Account')).toBeInTheDocument();

    await act(async () => history.forward());
    expect(await screen.findByText('Account: reveal Manual Spot experiments')).toBeInTheDocument();
  });
});
