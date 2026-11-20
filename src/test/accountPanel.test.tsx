import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account's order and its closed secondary tools. The Binance card, Manual Spot experiments and
 * Tracked Holdings are stand-ins here; their own gates and reads are covered in
 * spotExperiments.test.tsx, binanceSpotBalances*.test.tsx and the portfolio tests.
 */
const harness = vi.hoisted(() => ({
  user: { id: 'synthetic-owner', email: 'owner@example.test' } as { id: string; email: string },
  pineMounts: 0,
  pricing: vi.fn(() => null),
  perpetual: vi.fn(() => null),
  download: vi.fn(),
  loadWalkForward: vi.fn(() => []),
}));

vi.mock('@/lib/authStore', () => ({
  useAuth: () => ({ user: harness.user, isPro: false }),
}));
vi.mock('@/lib/portfolioStore', () => ({
  usePortfolio: () => ({
    portfolios: {
      paper_trading: { transactions: [{ id: 'p1' }] },
      long_term_sim: { transactions: [{ id: 's1' }] },
      real_tracking: { transactions: [] },
    },
  }),
}));
vi.mock('@/lib/tradeLedger', () => ({
  downloadCsv: harness.download,
  tradeLedgerCsv: (rows: unknown[]) => `rows:${rows.length}`,
}));
vi.mock('@/lib/engine/walkForwardLogger', () => ({
  loadWalkForward: harness.loadWalkForward,
  walkForwardCsv: () => 'audit',
}));
vi.mock('@/components/BinanceSpotBalances', async () => {
  const { useState } = await import('react');
  return {
    BinanceSpotBalances: ({
      accountContext,
      requested,
      children,
    }: {
      accountContext: string;
      requested?: boolean;
      children?: ReactNode;
    }) => {
      // Fixed at mount: tells a fresh card for a new sign-in from a reused one.
      const [mountedFor] = useState(accountContext);
      return (
        <section
          aria-label="Binance Spot card"
          data-account={accountContext}
          data-mounted-for={mountedFor}
          data-requested={requested}
        >
          {children}
        </section>
      );
    },
  };
});
vi.mock('@/components/SpotExperiments', () => ({
  SpotExperiments: ({ userId, reveal }: { userId: string; reveal?: boolean }) => (
    <section aria-label="Manual Spot experiments" data-user={userId} data-reveal={reveal} />
  ),
}));
vi.mock('@/components/PortfolioDashboard', () => ({
  PortfolioDashboard: ({ portfolioType }: { portfolioType: string }) => (
    <section aria-label="Tracked real holdings" data-type={portfolioType} />
  ),
}));
vi.mock('@/components/PineScriptModal', () => ({
  PineScriptModal: ({ open }: { open: boolean }) => {
    harness.pineMounts += 1;
    return open ? <div role="dialog" aria-label="Pine Script export" /> : null;
  },
}));
// Account no longer imports either; these record any render that would bring them back.
vi.mock('@/components/PricingModal', () => ({ PricingModal: harness.pricing }));
vi.mock('@/components/PerpetualFilterComparison', () => ({
  PerpetualWorkspace: harness.perpetual,
}));
// Account renders outside a router here; its one in-app link only needs to be an anchor.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  Link: ({ to, children, className }: { to: string; children?: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

import { AccountPanel } from '@/components/AccountPanel';

const SUMMARY = 'Data export and TradingView webhook';
const summary = () => screen.getByText(SUMMARY);
const disclosure = () => summary().closest('details')!;
const before = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** A details element announces `toggle` after the click, not during it. */
async function openTools() {
  fireEvent.click(summary());
  return screen.findByRole('region', { name: 'Data Export' });
}

beforeEach(() => {
  harness.user = { id: 'synthetic-owner', email: 'owner@example.test' };
  harness.pineMounts = 0;
  harness.pricing.mockClear();
  harness.perpetual.mockClear();
  harness.download.mockClear();
  harness.loadWalkForward.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Account order', () => {
  it('puts the Binance card with Manual Spot experiments first, then tracked holdings, then closed secondary tools', () => {
    render(<AccountPanel assets={[]} />);
    const heading = screen.getByRole('heading', { level: 2, name: 'Account' });
    const card = screen.getByRole('region', { name: 'Binance Spot card' });
    const holdings = screen.getByRole('region', { name: 'Tracked real holdings' });

    expect(
      within(card).getByRole('region', { name: 'Manual Spot experiments' }),
    ).toBeInTheDocument();
    expect(holdings).toHaveAttribute('data-type', 'real_tracking');
    expect(card).not.toContainElement(holdings);
    expect(before(heading, card)).toBe(true);
    expect(before(card, holdings)).toBe(true);
    expect(before(holdings, disclosure())).toBe(true);
    // Nothing else sits between the heading and the Binance card.
    expect(heading.closest('header')?.nextElementSibling).toBe(card);
  });

  it('passes the workspace link on to the Binance card and Manual Spot experiments', () => {
    const { rerender } = render(<AccountPanel assets={[]} />);
    const card = () => screen.getByRole('region', { name: 'Binance Spot card' });
    const experiments = () => screen.getByRole('region', { name: 'Manual Spot experiments' });
    expect(card()).toHaveAttribute('data-requested', 'false');
    expect(experiments()).toHaveAttribute('data-reveal', 'false');

    rerender(<AccountPanel assets={[]} revealSpotExperiments />);
    expect(card()).toHaveAttribute('data-requested', 'true');
    expect(experiments()).toHaveAttribute('data-reveal', 'true');
    // Following the link reuses the same card, and with it the card's earlier read.
    expect(card()).toHaveAttribute('data-mounted-for', 'synthetic-owner');
  });

  it('remounts the Binance card for another sign-in, so no account sees another one’s card', () => {
    const { rerender } = render(<AccountPanel assets={[]} />);
    harness.user = { id: 'synthetic-other', email: 'other@example.test' };
    rerender(<AccountPanel assets={[]} />);

    const card = screen.getByRole('region', { name: 'Binance Spot card' });
    expect(card).toHaveAttribute('data-mounted-for', 'synthetic-other');
    expect(card).toHaveAttribute('data-account', 'synthetic-other');
    expect(screen.getByRole('region', { name: 'Manual Spot experiments' })).toHaveAttribute(
      'data-user',
      'synthetic-other',
    );
  });
});

describe('Account secondary tools', () => {
  it('start closed, with no export, webhook control or dialog mounted', () => {
    render(<AccountPanel assets={[]} />);
    expect(summary().tagName).toBe('SUMMARY');
    expect(disclosure()).not.toHaveAttribute('open');
    expect(screen.queryByRole('heading', { name: 'Data Export' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'TradingView Webhook' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Simulation history/ })).toBeNull();
    expect(harness.pineMounts).toBe(0);
  });

  it('keep every export, its filename, the history link and webhook management once opened', async () => {
    render(<AccountPanel assets={[]} />);
    const exports = await openTools();
    expect(disclosure()).toHaveAttribute('open');
    const button = (name: string) => within(exports).getByRole('button', { name });

    fireEvent.click(button('Paper Trading'));
    fireEvent.click(button('Simulation'));
    expect(button('Live Tracking')).toBeDisabled();
    fireEvent.click(button('Export Beta Audit CSV'));
    expect(harness.download.mock.calls).toEqual([
      ['popup-ledger-paper.csv', 'rows:1'],
      ['popup-ledger-simulation.csv', 'rows:1'],
      ['popup-beta-audit.csv', 'audit'],
    ]);
    expect(harness.loadWalkForward).toHaveBeenCalledWith('synthetic-owner');
    expect(within(exports).getByRole('link', { name: /Simulation history/ })).toHaveAttribute(
      'href',
      '/paper-trading',
    );

    expect(harness.pineMounts).toBe(0);
    const webhook = screen.getByRole('region', { name: 'TradingView Webhook' });
    fireEvent.click(within(webhook).getByRole('button', { name: 'Manage webhook keys' }));
    expect(screen.getByRole('dialog', { name: 'Pine Script export' })).toBeInTheDocument();
  });

  it('unmount their contents again when closed', async () => {
    render(<AccountPanel assets={[]} />);
    await openTools();
    fireEvent.click(summary());
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Data Export' })).toBeNull());
    expect(disclosure()).not.toHaveAttribute('open');
  });
});

describe('Account removed surfaces', () => {
  it('shows no subscription promotion and no perpetual tools, open or closed', async () => {
    render(<AccountPanel assets={[]} />);
    const absent = () => {
      expect(screen.queryByRole('heading', { name: 'Subscription' })).toBeNull();
      expect(screen.queryByRole('button', { name: /See Pro plans/ })).toBeNull();
      expect(screen.queryByText(/Basic · Free/)).toBeNull();
      expect(screen.queryByRole('region', { name: /^Leverage simulation/ })).toBeNull();
      expect(harness.pricing).not.toHaveBeenCalled();
      expect(harness.perpetual).not.toHaveBeenCalled();
    };
    absent();
    await openTools();
    absent();
  });

  it('opening Account and its secondary tools sends no request and writes no storage', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    render(<AccountPanel assets={[]} />);
    await openTools();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    // The Beta Audit log is read only on its export press.
    expect(harness.loadWalkForward).not.toHaveBeenCalled();
  });
});
