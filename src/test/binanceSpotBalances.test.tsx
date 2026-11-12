import { readFileSync } from 'node:fs';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabaseClient', () => ({ supabase: { functions: { invoke } } }));

import { BinanceSpotBalances } from '@/components/BinanceSpotBalances';
import {
  applySpotRead,
  INITIAL_SPOT_VIEW,
  isSpotSnapshotStale,
  parseSpotRead,
  readSpotAccount,
  SPOT_STALE_AFTER_MS,
  type SpotRead,
} from '@/lib/binanceSpotAccount';

// Synthetic balances throughout; no Binance account is involved.
const connected = (
  readAt: string,
  balances = [{ asset: 'BTC', free: '0.00000001', locked: '0.50000000' }],
) => ({ state: 'connected', readAt, balances }) satisfies SpotRead;
const failed = (error: string, extra: object = {}) =>
  ({ state: 'error', error, ...extra }) as SpotRead;

/** A `read` whose answers the test releases one by one, in any order. */
function deferredReads() {
  const pending: ((read: SpotRead) => void)[] = [];
  const read = vi.fn(() => new Promise<SpotRead>((resolve) => pending.push(resolve)));
  const answer = async (index: number, result: SpotRead) => {
    await act(async () => pending[index]?.(result));
  };
  return { read, answer };
}

const refreshButton = () => screen.getByRole('button', { name: /refresh balances|reading/i });

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

describe('Binance Spot balance view', () => {
  it('shows nothing while the first answer is pending, and nothing to anyone but the owner', async () => {
    for (const result of [
      failed('forbidden'),
      failed('unauthenticated'),
      { state: 'unavailable' } as const,
    ]) {
      const { read, answer } = deferredReads();
      const { container, unmount } = render(<BinanceSpotBalances read={read} />);
      expect(container).toBeEmptyDOMElement();
      await answer(0, result);
      expect(container).toBeEmptyDOMElement();
      expect(read).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('says when the connection is not configured', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, { state: 'not_configured' });
    expect(screen.getByRole('status')).toHaveTextContent(/^Not configured\./);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows asset, available and locked quantities exactly as read', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(
      0,
      connected(new Date().toISOString(), [
        { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
        { asset: 'USDT', free: '4723846.89208129', locked: '30.00000000' },
      ]),
    );
    expect(screen.getByRole('heading', { name: /Binance Spot\s*Read-only/ })).toBeVisible();
    const rows = within(screen.getByRole('table', { name: 'Binance Spot balances' })).getAllByRole(
      'row',
    );
    expect(rows.map((row) => Array.from(row.children, (c) => c.textContent))).toEqual([
      ['Asset', 'Available', 'Locked'],
      ['BTC', '0.00000001', '0.00000000'],
      ['USDT', '4723846.89208129', '30.00000000'],
    ]);
    expect(screen.getByRole('status')).toHaveTextContent(
      /Connected\. Key verified read-only\. Last successful read/,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Stale');
    // No valuation, total or P&L is derived from the balances.
    expect(document.body.textContent).not.toMatch(/\$|USD\b|total|P&L|value/i);
  });

  it('distinguishes a connected account with zero balances', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, connected(new Date().toISOString(), []));
    expect(screen.getByText('Binance reports no non-zero Spot balances.')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/Connected\./);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it.each([
    ['binance_auth', {}, /rejected the API key/],
    [
      'permissions_refused',
      { enabled: ['enableWithdrawals'] },
      /Refused: this API key can do more than read \(enableWithdrawals\)/,
    ],
    ['permissions_unverified', {}, /Unverified: Binance did not confirm/],
    ['rate_limited', { retryAfterSeconds: 37 }, /rate limit reached.*about 37 seconds/],
    ['timeout', {}, /did not answer in time/],
    ['network', {}, /Could not reach/],
    ['malformed_response', {}, /could not be read as balances/],
    ['provider_error', {}, /reported an error/],
  ])('names a %s failure and claims no connection', async (error, extra, message) => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, failed(error, extra));
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('status')).not.toHaveTextContent(/Connected|verified/);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('keeps the earlier balances, labeled as not current, when a refresh fails', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, connected('2026-11-10T08:00:00.000Z'));
    fireEvent.click(refreshButton());
    expect(refreshButton()).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Reading balances from Binance…');
    await answer(1, failed('timeout'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh failed. Binance did not answer in time.',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /^Not current\. Showing the last successful read, from/,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Connected');
    expect(within(screen.getByRole('table')).getByText('0.50000000')).toBeVisible();
    expect(screen.getByRole('status').querySelector('time')).toHaveAttribute(
      'datetime',
      '2026-11-10T08:00:00.000Z',
    );
    expect(refreshButton()).toHaveAttribute('aria-disabled', 'false');

    // A later success clears the failure.
    fireEvent.click(refreshButton());
    await answer(2, connected(new Date().toISOString(), []));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('labels a read older than five minutes as stale without another request', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-10T08:00:00.000Z') });
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, connected('2026-11-10T08:00:00.000Z'));
    expect(screen.getByRole('status')).not.toHaveTextContent('Stale');
    await act(async () => vi.advanceTimersByTime(SPOT_STALE_AFTER_MS + 5_000));
    expect(screen.getByRole('status')).toHaveTextContent('Stale Read more than 5 minutes ago.');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('pauses refresh for as long as Binance asks after a rate limit', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-10T08:00:00.000Z') });
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, failed('rate_limited', { retryAfterSeconds: 37 }));
    expect(refreshButton()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(refreshButton()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(refreshButton()).toHaveAttribute('aria-disabled', 'false');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('refreshes from the keyboard through a real button', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotBalances read={read} />);
    await answer(0, connected(new Date().toISOString()));
    const button = refreshButton();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(read).toHaveBeenCalledTimes(2);
    // Focus stays on the button while it reads, so the keyboard user is not dropped.
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    // One read at a time: a second activation while reading does nothing.
    fireEvent.click(button);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads once on mount under React StrictMode, and still refreshes on request', async () => {
    const { read, answer } = deferredReads();
    render(
      <StrictMode>
        <BinanceSpotBalances read={read} />
      </StrictMode>,
    );
    // StrictMode runs the mount effect, its cleanup, and the effect again.
    expect(read).toHaveBeenCalledTimes(1);
    await answer(0, connected(new Date().toISOString()));
    expect(within(screen.getByRole('table')).getByText('0.50000000')).toBeVisible();
    expect(refreshButton()).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(refreshButton());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('ignores an answer that arrives after the account changed', async () => {
    const first = deferredReads();
    const second = deferredReads();
    const { container, rerender } = render(
      <StrictMode>
        <BinanceSpotBalances key="user-a" read={first.read} />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <BinanceSpotBalances key="user-b" read={second.read} />
      </StrictMode>,
    );
    await first.answer(0, connected(new Date().toISOString()));
    expect(container).toBeEmptyDOMElement();
    expect(second.read).toHaveBeenCalledTimes(1);
    await second.answer(0, { state: 'not_configured' });
    expect(screen.getByRole('status')).toHaveTextContent(/^Not configured\./);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('survives a read that throws', async () => {
    render(<BinanceSpotBalances read={() => Promise.reject(new Error('boom'))} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach');
  });
});

describe('overlapping refreshes', () => {
  const older = connected('2026-11-10T08:00:00.000Z', [{ asset: 'BTC', free: '1', locked: '0' }]);
  const newer = connected('2026-11-10T08:00:05.000Z', [{ asset: 'BTC', free: '2', locked: '0' }]);

  it('drops the answer to an earlier request that arrives after a later one', () => {
    let view = applySpotRead(INITIAL_SPOT_VIEW, 2, newer);
    view = applySpotRead(view, 1, older);
    expect(view.snapshot?.balances[0]?.free).toBe('2');
    view = applySpotRead(view, 1, failed('timeout'));
    expect(view.failure).toBeNull();
    expect(applySpotRead(view, 2, older)).toBe(view);
  });

  it('never replaces a snapshot with one Binance produced earlier', () => {
    let view = applySpotRead(INITIAL_SPOT_VIEW, 1, newer);
    view = applySpotRead(view, 2, older);
    expect(view.snapshot).toEqual({ readAt: newer.readAt, balances: newer.balances });
    expect(view.seq).toBe(2);
  });

  it('applies answers in request order when they arrive in order', () => {
    let view = applySpotRead(INITIAL_SPOT_VIEW, 1, older);
    view = applySpotRead(view, 2, newer);
    expect(view.snapshot?.balances[0]?.free).toBe('2');
  });

  it('drops the retained balances once access is lost or the connection is removed', () => {
    const shown = applySpotRead(INITIAL_SPOT_VIEW, 1, newer);
    for (const read of [
      failed('forbidden'),
      failed('unauthenticated'),
      { state: 'unavailable' } as const,
    ]) {
      expect(applySpotRead(shown, 2, read)).toMatchObject({ access: 'hidden', snapshot: null });
    }
    expect(applySpotRead(shown, 2, { state: 'not_configured' })).toMatchObject({
      access: 'not_configured',
      snapshot: null,
    });
  });

  it('marks a snapshot stale only past the threshold', () => {
    const at = Date.parse(older.readAt);
    expect(isSpotSnapshotStale(older.readAt, at + SPOT_STALE_AFTER_MS)).toBe(false);
    expect(isSpotSnapshotStale(older.readAt, at + SPOT_STALE_AFTER_MS + 1)).toBe(true);
  });
});

describe('reading through the edge function', () => {
  const httpError = (status: number, body: string) => ({
    data: null,
    error: Object.assign(new Error('non-2xx'), { context: new Response(body, { status }) }),
  });

  it('posts to the one function with no body and no credentials of its own', async () => {
    invoke.mockResolvedValue({ data: { state: 'not_configured' }, error: null });
    expect(await readSpotAccount()).toEqual({ state: 'not_configured' });
    expect(invoke).toHaveBeenCalledWith('binance-spot-account', {
      method: 'POST',
      timeout: 20_000,
    });
  });

  it('reads the reason out of a non-2xx answer', async () => {
    invoke.mockResolvedValue(
      httpError(429, '{"state":"error","error":"rate_limited","retryAfterSeconds":9}'),
    );
    expect(await readSpotAccount()).toEqual({
      state: 'error',
      error: 'rate_limited',
      retryAfterSeconds: 9,
    });
    invoke.mockResolvedValue(httpError(403, '{"state":"error","error":"forbidden"}'));
    expect(await readSpotAccount()).toEqual({ state: 'error', error: 'forbidden' });
  });

  it.each([
    [
      'the function is not deployed',
      httpError(404, '{"code":"NOT_FOUND","message":"Requested function was not found"}'),
    ],
    ['the gateway rejects the session', httpError(401, '{"code":401,"message":"Invalid JWT"}')],
    ['the body is not JSON', httpError(502, '<html>')],
    [
      'the body is an unknown shape',
      { data: { state: 'connected', balances: 'all of them' }, error: null },
    ],
    ['the error code is unknown', { data: { state: 'error', error: 'surprise' }, error: null }],
  ])('treats the view as unavailable when %s', async (_, answer) => {
    invoke.mockResolvedValue(answer);
    expect(await readSpotAccount()).toEqual({ state: 'unavailable' });
  });

  it('tells a timeout from a network failure and never throws', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('x'), { context: abort }),
    });
    expect(await readSpotAccount()).toEqual({ state: 'error', error: 'timeout' });
    invoke.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('x'), { context: new TypeError('Failed to fetch') }),
    });
    expect(await readSpotAccount()).toEqual({ state: 'error', error: 'network' });
    invoke.mockRejectedValue(new Error('boom'));
    expect(await readSpotAccount()).toEqual({ state: 'error', error: 'network' });
  });

  it('keeps quantities as strings and drops fields it does not show', () => {
    const read = parseSpotRead({
      state: 'connected',
      readAt: '2026-11-10T08:00:00.000Z',
      balances: [{ asset: 'BTC', free: '0.00000001', locked: '0.00000000', usdValue: '1' }],
      canTrade: true,
    });
    expect(read).toEqual(
      connected('2026-11-10T08:00:00.000Z', [
        { asset: 'BTC', free: '0.00000001', locked: '0.00000000' },
      ]),
    );
    expect(
      parseSpotRead({
        state: 'connected',
        readAt: 'x',
        balances: [{ asset: 'BTC', free: 1, locked: '0' }],
      }),
    ).toEqual({ state: 'unavailable' });
  });
});

describe('separation from Popup ledgers', () => {
  it('imports no portfolio, ledger, storage or database module', () => {
    for (const file of [
      'src/lib/binanceSpotAccount.ts',
      'src/lib/binanceSpotEvidence.ts',
      'src/lib/binanceSpotReconciliation.ts',
      'src/components/BinanceSpotBalances.tsx',
      'src/components/BinanceSpotExecutions.tsx',
    ]) {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      expect(imports.join(' ')).not.toMatch(/portfolio|ledger|\/db|paper|broker|alerts|hydration/i);
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|useQuery|VITE_/);
    }
  });
});
