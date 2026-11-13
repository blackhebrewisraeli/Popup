// The manual quantity-reconciliation flow in the Account card
// (docs/BINANCE_SPOT_RECONCILIATION.md, section 10). Every owner, time, ID and amount is
// synthetic; the clock is mocked; no Binance account, credential or network is involved.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabaseClient', () => ({ supabase: { functions: { invoke } } }));

import { BinanceSpotBalances } from '@/components/BinanceSpotBalances';
import { BinanceSpotReconciliation } from '@/components/BinanceSpotReconciliation';
import type {
  SpotExecution,
  SpotExecutionConflict,
  SpotExecutionFailure,
  SpotExecutionRead,
  SpotRead,
} from '@/lib/binanceSpotAccount';
import { nextExecutionEvidence, type SpotExecutionEvidence } from '@/lib/binanceSpotEvidence';
import {
  MAX_BALANCE_INTERVAL_MS,
  RECONCILIATION_GUARD_MS,
  reconcileSpotQuantity,
} from '@/lib/binanceSpotReconciliation';

const OWNER = 'synthetic-owner-a';
const G = RECONCILIATION_GUARD_MS;
const O = Date.parse('2026-11-13T08:00:00.000Z');
const C = Date.parse('2026-11-13T10:00:00.000Z');
const WINDOW = { symbols: ['BTCUSDT'], startTime: O - G, endTime: C + G };
const OPEN_BTC = '0.10000000';
// One buy of 0.001 BTC paying 0.000001 BTC: 0.1 + 0.001 − 0.000001 = 0.100999.
const CONSISTENT_BTC = '0.10099900';
const ONE_SATOSHI_SHORT = '0.10099899';
const ONE_SATOSHI_OVER = '0.10099901';

const balanceRead = (at: number, btc: string): Extract<SpotRead, { state: 'connected' }> => ({
  state: 'connected',
  readAt: new Date(at).toISOString(),
  balances: [
    { asset: 'BTC', free: btc, locked: '0.00000000' },
    { asset: 'USDT', free: '900.00000000', locked: '0.00000000' },
  ],
});

const fill = (tradeId: string, overrides: Partial<SpotExecution> = {}): SpotExecution => ({
  symbol: 'BTCUSDT',
  tradeId,
  orderId: '7',
  time: O + 60 * 60 * 1000 + Number(tradeId),
  side: 'buy',
  quantity: '0.00100000',
  price: '50000.00000000',
  quoteQuantity: '50.00000000',
  commission: '0.00000100',
  commissionAsset: 'BTC',
  ...overrides,
});

const page = (
  executions: SpotExecution[],
  options: {
    continuation?: string;
    failures?: SpotExecutionFailure[];
    conflicts?: SpotExecutionConflict[];
  } = {},
): SpotExecutionRead => {
  const failures = options.failures ?? [];
  return {
    state: 'executions',
    executions,
    conflicts: options.conflicts ?? [],
    coverage: {
      ...WINDOW,
      returned: executions.length,
      retrievedAt: new Date(C + G + 1000).toISOString(),
      hasMore: options.continuation !== undefined,
      partial: failures.length > 0,
      failures,
      completedSymbols: options.continuation || failures.length > 0 ? [] : ['BTCUSDT'],
      limitation: 'selected_pairs_and_24h_window',
    },
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
};

const firstPageReadAt = (answer: SpotExecutionRead, at: number): SpotExecutionRead =>
  answer.state === 'executions'
    ? { ...answer, coverage: { ...answer.coverage, retrievedAt: new Date(at).toISOString() } }
    : answer;

/** A reader whose answers the test releases one by one, in any order. */
function deferred<T>() {
  const pending: ((value: T) => void)[] = [];
  const fn = vi.fn((..._args: unknown[]) => new Promise<T>((resolve) => pending.push(resolve)));
  const answer = async (index: number, value: T) => {
    await act(async () => pending[index]?.(value));
  };
  return { fn, answer };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const detail = (term: string) => screen.getByText(term, { selector: 'dt' }).nextElementSibling;
const title = () => screen.getByRole('heading', { level: 5 });
const reasons = () =>
  within(screen.getByRole('list', { name: /^Result:/ }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

function renderFlow(props: { commissionCoverage?: 'unverified' | 'verified' } = {}) {
  const balances = deferred<SpotRead>();
  const executions = deferred<SpotExecutionRead>();
  const view = render(
    <BinanceSpotReconciliation
      accountContext={OWNER}
      readBalances={balances.fn}
      readExecutions={executions.fn}
      {...props}
    />,
  );
  return { balances, executions, view };
}

/** Opening at O, closing at C, then the clock moves to C + g and the owner asks for executions. */
async function reachRetrieval(
  closingBtc: string,
  props: { commissionCoverage?: 'unverified' | 'verified' } = {},
) {
  vi.useFakeTimers({ now: C + 1000 });
  const flow = renderFlow(props);
  fireEvent.click(button('Capture opening balance'));
  await flow.balances.answer(0, balanceRead(O, OPEN_BTC));
  fireEvent.click(button('Capture closing balance'));
  await flow.balances.answer(1, balanceRead(C, closingBtc));
  await act(async () => vi.advanceTimersByTime(G));
  fireEvent.click(button('Retrieve executions'));
  return flow;
}

/** The pure result for the same synthetic evidence, without the view's commission gate. */
const pureResult = (closingBtc: string, answer: SpotExecutionRead) =>
  reconcileSpotQuantity({
    subject: 'BTC',
    opening: { accountContext: OWNER, read: balanceRead(O, OPEN_BTC) },
    closing: { accountContext: OWNER, read: balanceRead(C, closingBtc) },
    executions: {
      accountContext: OWNER,
      evidence: nextExecutionEvidence(null, answer, false) as SpotExecutionEvidence,
    },
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  invoke.mockReset();
});

describe('quantity reconciliation flow: reads', () => {
  it('requests nothing on its own and offers only eligible subjects', async () => {
    vi.useFakeTimers({ now: C });
    const { balances, executions } = renderFlow();
    await act(async () => vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000));
    expect(balances.fn).not.toHaveBeenCalled();
    expect(executions.fn).not.toHaveBeenCalled();
    const options = within(screen.getByRole('combobox', { name: 'Asset' })).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'BTC',
      'ETH',
      'SOL',
      'AVAX',
      'LINK',
      'XRP',
      'ADA',
      'DOGE',
      'DOT',
      'MATIC',
      'LTC',
    ]);
    expect(title()).toHaveTextContent('Result: Indeterminate — commission coverage unverified');
    expect(reasons()).toContain('Capture an opening balance read.');
  });

  it('captures opening and closing only from successful reads, with their server times', async () => {
    vi.useFakeTimers({ now: C + 1000 });
    const { balances } = renderFlow();
    fireEvent.click(button('Capture opening balance'));
    await balances.answer(0, { state: 'error', error: 'timeout' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The opening balance was not captured. Binance did not answer in time.',
    );
    expect(detail('Opening read')).toHaveTextContent('Not captured');
    expect(button('Capture closing balance')).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(button('Capture opening balance'));
    await balances.answer(1, balanceRead(O, OPEN_BTC));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(detail('Opening read')?.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(O).toISOString(),
    );
    expect(button('Capture opening balance')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: 'Asset' })).toBeDisabled();

    fireEvent.click(button('Capture closing balance'));
    await balances.answer(2, balanceRead(C, CONSISTENT_BTC));
    expect(detail('Closing read')?.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(C).toISOString(),
    );
    const window = detail('Guarded execution window')?.querySelectorAll('time') ?? [];
    expect(Array.from(window, (time) => time.getAttribute('datetime'))).toEqual([
      new Date(O - G).toISOString(),
      new Date(C + G).toISOString(),
    ]);
    expect(balances.fn).toHaveBeenCalledTimes(3);
  });

  it('waits for the guarded window, counts down without requesting, then asks for [O − g, C + g]', async () => {
    vi.useFakeTimers({ now: C + 1000 });
    const { balances, executions } = renderFlow();
    fireEvent.click(button('Capture opening balance'));
    await balances.answer(0, balanceRead(O, OPEN_BTC));
    fireEvent.click(button('Capture closing balance'));
    await balances.answer(1, balanceRead(C, CONSISTENT_BTC));

    expect(button('Retrieve executions')).toHaveAttribute('aria-disabled', 'true');
    expect(reasons().join(' ')).toMatch(/can be requested from .*\(in 59 s\)/);
    fireEvent.click(button('Retrieve executions'));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(reasons().join(' ')).toMatch(/\(in 29 s\)/);
    await act(async () => vi.advanceTimersByTime(29_000));
    expect(button('Retrieve executions')).toHaveAttribute('aria-disabled', 'false');
    await act(async () => vi.advanceTimersByTime(10 * 60 * 1000));
    expect(executions.fn).not.toHaveBeenCalled();

    fireEvent.click(button('Retrieve executions'));
    expect(executions.fn).toHaveBeenCalledTimes(1);
    expect(executions.fn).toHaveBeenCalledWith(WINDOW);
  });

  it('explains reads too far apart for one 24-hour window and never requests it', async () => {
    const closing = O + MAX_BALANCE_INTERVAL_MS + 1;
    vi.useFakeTimers({ now: closing + 1000 });
    const { balances, executions } = renderFlow();
    fireEvent.click(button('Capture opening balance'));
    await balances.answer(0, balanceRead(O, OPEN_BTC));
    fireEvent.click(button('Capture closing balance'));
    await balances.answer(1, balanceRead(closing, CONSISTENT_BTC));
    await act(async () => vi.advanceTimersByTime(10 * G));
    expect(reasons().join(' ')).toContain("would exceed Binance's 24-hour limit");
    fireEvent.click(button('Retrieve executions'));
    expect(executions.fn).not.toHaveBeenCalled();
  });

  it('sends one read for a double click and pauses every request for Retry-After', async () => {
    vi.useFakeTimers({ now: C });
    const { balances } = renderFlow();
    const capture = button('Capture opening balance');
    capture.focus();
    fireEvent.click(capture);
    fireEvent.click(capture);
    expect(balances.fn).toHaveBeenCalledTimes(1);
    expect(capture).toHaveFocus();
    expect(screen.getByText('Capturing the opening balance read…')).toBeVisible();

    await balances.answer(0, { state: 'error', error: 'rate_limited', retryAfterSeconds: 7 });
    expect(screen.getByRole('alert')).toHaveTextContent('paused for about 7 seconds');
    expect(screen.getByText(/requests here are paused until/)).toBeVisible();
    expect(capture).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(capture);
    expect(balances.fn).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(8_000));
    expect(capture).toHaveAttribute('aria-disabled', 'false');
    fireEvent.click(capture);
    expect(balances.fn).toHaveBeenCalledTimes(2);
  });

  it('treats a read that throws as a network failure', async () => {
    render(
      <BinanceSpotReconciliation
        accountContext={OWNER}
        readBalances={() => Promise.reject(new Error('boom'))}
      />,
    );
    await act(async () => fireEvent.click(button('Capture opening balance')));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server or Binance.');
    expect(detail('Opening read')).toHaveTextContent('Not captured');
  });
});

describe('quantity reconciliation flow: commission gate', () => {
  it.each([
    ['consistent', CONSISTENT_BTC, 'CONSISTENT', '0.00000000'],
    ['one satoshi short', ONE_SATOSHI_SHORT, 'DISCREPANCY', '-0.00000001'],
  ] as const)(
    'keeps a %s result Indeterminate with no figures while D3 is unverified',
    async (_, closing, status, difference) => {
      const answer = page([fill('1')]);
      const pure = pureResult(closing, answer);
      expect(pure.status).toBe(status);
      expect(pure.status !== 'INDETERMINATE' && pure.difference).toBe(difference);

      const { executions } = await reachRetrieval(closing);
      await executions.answer(0, answer);
      expect(title()).toHaveTextContent('Result: Indeterminate — commission coverage unverified');
      expect(reasons()).toEqual([
        expect.stringMatching(/^Commission coverage is unverified \(D3\)/),
        'No other reason blocks this evidence. Only the unverified commission coverage holds the result back.',
      ]);
      expect(detail('Requested coverage')).toHaveTextContent(
        'Complete for the requested pair and window',
      );
      expect(screen.queryByRole('group', { name: 'Quantity figures' })).toBeNull();
      expect(screen.queryByText('Quantity figures')).toBeNull();
      const text = document.body.textContent ?? '';
      expect(text).not.toMatch(/Consistent|Discrepancy|difference \(closing/i);
      for (const figure of [difference, closing, OPEN_BTC, '0.00100000', '0.00000100']) {
        expect(text).not.toContain(figure);
      }
    },
  );

  it.each([
    ['consistent', CONSISTENT_BTC, 'Result: Consistent within this scope', '0.00000000'],
    ['one satoshi short', ONE_SATOSHI_SHORT, 'Result: Discrepancy', '-0.00000001'],
    ['one satoshi over', ONE_SATOSHI_OVER, 'Result: Discrepancy', '+0.00000001'],
  ] as const)(
    'shows exact figures for a %s result only where the gate permits (synthetic)',
    async (_, closing, heading, difference) => {
      const { executions } = await reachRetrieval(closing, { commissionCoverage: 'verified' });
      await executions.answer(0, page([fill('1')]));
      expect(title()).toHaveTextContent(heading);
      expect(screen.queryByRole('list', { name: /^Result:/ })).toBeNull();
      expect(detail('Opening BTC (available + locked)')).toHaveTextContent(OPEN_BTC);
      expect(detail('Bought')).toHaveTextContent('0.00100000');
      expect(detail('Sold')).toHaveTextContent('0.00000000');
      expect(detail('Fees paid in BTC')).toHaveTextContent('0.00000100');
      expect(detail('Expected closing')).toHaveTextContent(CONSISTENT_BTC);
      expect(detail('Closing BTC (available + locked)')).toHaveTextContent(closing);
      expect(detail('Difference (closing − expected)')).toHaveTextContent(difference);
      expect(detail('Fills counted')).toHaveTextContent('1');
      expect(detail('Fees in other assets (not converted)')).toHaveTextContent('None');
      expect(document.body.textContent).toMatch(
        difference === '0.00000000'
          ? /numerical consistency within this scope only/
          : new RegExp(
              `by \\${difference} \\(closing − expected\\)\\. The difference is unattributed`,
            ),
      );
    },
  );
});

describe('quantity reconciliation flow: incomplete and inconsistent evidence', () => {
  it('asks for the next page, and a failed continuation stays recorded after a successful retry', async () => {
    const twoFills = '0.10199800'; // 0.1 + 2 × (0.001 − 0.000001)
    const { executions } = await reachRetrieval(twoFills, { commissionCoverage: 'verified' });
    await executions.answer(0, page([fill('1')], { continuation: 'cursor-1' }));
    expect(detail('Continuation')).toHaveTextContent('Available');
    expect(reasons()).toEqual(['BTCUSDT has not reached its last page. Load the next page.']);

    fireEvent.click(button('Load next page'));
    expect(executions.fn).toHaveBeenLastCalledWith({ continuation: 'cursor-1' });
    await executions.answer(1, { state: 'error', error: 'timeout' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The next page was not retrieved. The evidence so far and its cursor are kept',
    );
    expect(detail('Continuation')).toHaveTextContent('Available');

    fireEvent.click(button('Load next page'));
    expect(executions.fn).toHaveBeenLastCalledWith({ continuation: 'cursor-1' });
    await executions.answer(2, page([fill('2')]));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(detail('Fills retrieved')).toHaveTextContent('2');
    expect(detail('Continuation')).toHaveTextContent('None');
    expect(detail('Requested coverage')).toHaveTextContent('Incomplete');
    expect(title()).toHaveTextContent('Result: Indeterminate');
    expect(reasons()).toEqual([
      'A continuation failed (timeout). This retrieval stays unresolved even after a successful retry; retrieve again from the start for a usable result.',
    ]);

    // Only a fresh retrieval of the whole guarded window starts a new evidence state.
    fireEvent.click(button('Retrieve again from the start'));
    expect(executions.fn).toHaveBeenLastCalledWith(WINDOW);
    await executions.answer(3, page([fill('1'), fill('2')]));
    expect(title()).toHaveTextContent('Result: Consistent within this scope');
  });

  it.each([
    [
      'conflicting rows',
      page([], {
        conflicts: [
          {
            symbol: 'BTCUSDT',
            tradeId: '1',
            variants: [fill('1'), fill('1', { quantity: '0.00100001' })],
          },
        ],
      }),
      'Binance returned conflicting rows for BTCUSDT trade 1, and no variant is authoritative.',
    ],
    [
      'a failed pair',
      page([fill('1')], { failures: [{ symbol: 'BTCUSDT', error: 'timeout' }] }),
      'Part of the BTCUSDT retrieval failed (timeout). That retrieval stays incomplete; retrieve again from the start.',
    ],
    [
      'a fill near a read',
      page([fill('1', { time: O + 30_000 })]),
      'BTCUSDT fills within 60 s of a balance read (trade 1)',
    ],
    [
      'a first page read too early',
      firstPageReadAt(page([fill('1')]), C + G - 5000),
      "By the server's clock, the first execution page was read less than 60 s after the closing read",
    ],
  ])('names %s as an actionable reason and shows no figure', async (_, answer, reason) => {
    const { executions } = await reachRetrieval(CONSISTENT_BTC, { commissionCoverage: 'verified' });
    await executions.answer(0, answer);
    expect(title()).toHaveTextContent(/^Result: Indeterminate$/);
    expect(reasons().join(' ')).toContain(reason);
    expect(screen.queryByText('Expected closing')).toBeNull();
  });

  it('keeps the earlier evidence unchanged when a fresh retrieval fails', async () => {
    const { executions } = await reachRetrieval(CONSISTENT_BTC, { commissionCoverage: 'verified' });
    await executions.answer(0, page([fill('1')]));
    fireEvent.click(button('Retrieve again from the start'));
    await executions.answer(1, { state: 'error', error: 'malformed_response' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The retrieval failed. The earlier evidence is unchanged.',
    );
    expect(title()).toHaveTextContent('Result: Consistent within this scope');
  });
});

describe('quantity reconciliation flow: session boundaries', () => {
  it('drops a late answer after a reset and keeps the newer session', async () => {
    vi.useFakeTimers({ now: C + 1000 });
    const { balances } = renderFlow();
    fireEvent.click(button('Capture opening balance'));
    fireEvent.click(button('Reset'));
    fireEvent.click(button('Capture opening balance'));
    await balances.answer(1, balanceRead(O + 5000, OPEN_BTC));
    await balances.answer(0, balanceRead(O, OPEN_BTC));
    expect(detail('Opening read')?.querySelector('time')).toHaveAttribute(
      'datetime',
      new Date(O + 5000).toISOString(),
    );
  });

  it('ignores an execution answer that arrives after a reset', async () => {
    const { executions } = await reachRetrieval(CONSISTENT_BTC);
    fireEvent.click(button('Reset'));
    await executions.answer(0, page([fill('1')]));
    expect(screen.queryByText('Fills retrieved')).toBeNull();
    expect(detail('Opening read')).toHaveTextContent('Not captured');
    expect(reasons()).toContain('Capture an opening balance read.');
  });

  it('starts empty for another owner and ignores the previous owner’s late answer', async () => {
    const balances = deferred<SpotRead>();
    const view = render(
      <BinanceSpotReconciliation
        key="owner-a"
        accountContext="owner-a"
        readBalances={balances.fn}
      />,
    );
    fireEvent.click(button('Capture opening balance'));
    view.rerender(
      <BinanceSpotReconciliation
        key="owner-b"
        accountContext="owner-b"
        readBalances={balances.fn}
      />,
    );
    await balances.answer(0, balanceRead(O, OPEN_BTC));
    expect(detail('Opening read')).toHaveTextContent('Not captured');
    expect(button('Capture opening balance')).toHaveAttribute('aria-disabled', 'false');

    // Logout unmounts the card; a late answer then changes nothing and throws nothing.
    fireEvent.click(button('Capture opening balance'));
    view.unmount();
    await balances.answer(1, balanceRead(O, OPEN_BTC));
    expect(document.body.textContent).toBe('');
  });

  it.each([
    { state: 'error', error: 'forbidden' },
    { state: 'error', error: 'unauthenticated' },
    { state: 'not_configured' },
    { state: 'unavailable' },
  ] as const)('clears the session when access ends ($state $error)', async (lost) => {
    vi.useFakeTimers({ now: C + 1000 });
    const { balances } = renderFlow();
    fireEvent.click(button('Capture opening balance'));
    await balances.answer(0, balanceRead(O, OPEN_BTC));
    fireEvent.click(button('Capture closing balance'));
    await balances.answer(1, lost);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Access to the Binance connection ended, so this reconciliation session was cleared.',
    );
    expect(detail('Opening read')).toHaveTextContent('Not captured');
  });

  it('keeps a captured read when the ordinary balance refresh reads again', async () => {
    vi.useFakeTimers({ now: C });
    const card = deferred<SpotRead>();
    invoke.mockResolvedValueOnce({ data: balanceRead(O, OPEN_BTC), error: null });
    render(<BinanceSpotBalances accountContext={OWNER} read={card.fn} />);
    await card.answer(0, balanceRead(O - 60_000, OPEN_BTC));
    const reconciliation = within(screen.getByRole('region', { name: /Quantity reconciliation/ }));

    await act(async () =>
      fireEvent.click(reconciliation.getByRole('button', { name: 'Capture opening balance' })),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('binance-spot-account', {
      method: 'POST',
      timeout: 20_000,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh balances' }));
    await card.answer(1, balanceRead(O + 30 * 60_000, '0.20000000'));
    expect(screen.getByText('0.20000000')).toBeVisible();
    expect(
      screen
        .getByText('Opening read', { selector: 'dt' })
        .nextElementSibling?.querySelector('time'),
    ).toHaveAttribute('datetime', new Date(O).toISOString());
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('writes no browser storage and sends only balance reads and the guarded execution request', async () => {
    const writes = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const { balances, executions } = await reachRetrieval(CONSISTENT_BTC);
    await executions.answer(0, page([fill('1')], { continuation: 'cursor-1' }));
    fireEvent.click(button('Load next page'));
    await executions.answer(1, page([fill('2')]));
    fireEvent.click(button('Reset'));
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(balances.fn.mock.calls).toEqual([[], []]);
    expect(executions.fn.mock.calls).toEqual([[WINDOW], [{ continuation: 'cursor-1' }]]);
  });
});
