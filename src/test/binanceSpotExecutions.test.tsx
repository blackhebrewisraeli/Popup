import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabaseClient', () => ({ supabase: { functions: { invoke } } }));

import { BinanceSpotExecutions } from '@/components/BinanceSpotExecutions';
import {
  parseSpotExecutionRead,
  readSpotExecutions,
  type SpotExecution,
  type SpotExecutionConflict,
  type SpotExecutionFailure,
  type SpotExecutionRead,
} from '@/lib/binanceSpotAccount';

const RANGE = {
  startTime: Date.parse('2026-11-10T08:00:00.000Z'),
  endTime: Date.parse('2026-11-10T09:00:00.000Z'),
};

const execution = (
  tradeId: string,
  symbol = 'BTCUSDT',
  overrides: Partial<SpotExecution> = {},
): SpotExecution => ({
  symbol,
  tradeId,
  orderId: '42',
  time: RANGE.startTime + Number(tradeId),
  side: 'buy',
  quantity: '0.00000001',
  price: '64000.12345678',
  quoteQuantity: '0.0006400012345678',
  commission: '0.000000000123456789',
  commissionAsset: 'BNB',
  ...overrides,
});

const page = (
  executions: SpotExecution[],
  options: {
    continuation?: string;
    failures?: SpotExecutionFailure[];
    conflicts?: SpotExecutionConflict[];
    completedSymbols?: string[];
    symbols?: string[];
  } = {},
): SpotExecutionRead => {
  const failures = options.failures ?? [];
  const symbols = options.symbols ?? [
    ...new Set(
      executions
        .map((item) => item.symbol)
        .concat(
          failures.map((item) => item.symbol),
          'BTCUSDT',
        ),
    ),
  ];
  return {
    state: 'executions',
    executions,
    conflicts: options.conflicts ?? [],
    coverage: {
      symbols,
      ...RANGE,
      returned: executions.length,
      retrievedAt: '2026-11-10T09:00:01.000Z',
      hasMore: options.continuation !== undefined,
      partial: failures.length > 0,
      failures,
      completedSymbols:
        options.completedSymbols ??
        (options.continuation
          ? []
          : symbols.filter((symbol) => !failures.some((failure) => failure.symbol === symbol))),
      limitation: 'selected_pairs_and_24h_window',
    },
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
};

function deferredReads() {
  const pending: Array<(read: SpotExecutionRead) => void> = [];
  const read = vi.fn(() => new Promise<SpotExecutionRead>((resolve) => pending.push(resolve)));
  const answer = async (index: number, result: SpotExecutionRead) => {
    await act(async () => pending[index]?.(result));
  };
  return { read, answer };
}

afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

describe('Binance Spot execution view', () => {
  it('does not read until the owner asks and sends only the selected pair and bounded range', async () => {
    vi.useFakeTimers({ now: RANGE.endTime });
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    expect(read).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Pair' }), {
      target: { value: 'ETHUSDT' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Range' }), {
      target: { value: '6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    expect(read).toHaveBeenCalledWith({
      symbols: ['ETHUSDT'],
      startTime: RANGE.endTime - 6 * 60 * 60 * 1000,
      endTime: RANGE.endTime,
    });
    await answer(0, page([]));
  });

  it('shows every fill separately with exact decimal and commission-asset strings', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(
      0,
      page([
        execution('1', 'BTCUSDT', { orderId: '9000', commissionAsset: 'BNB' }),
        execution('2', 'BTCUSDT', {
          orderId: '9000',
          side: 'sell',
          quantity: '123456789012345678.123456789012345678',
          commission: '0.000000000000000001',
          commissionAsset: 'USDT',
        }),
      ]),
    );
    const table = screen.getByRole('table', { name: 'Binance Spot execution history' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByText('9000')).toHaveLength(2);
    expect(within(table).getByText('123456789012345678.123456789012345678')).toBeVisible();
    expect(within(table).getByText('0.000000000000000001 USDT')).toBeVisible();
    expect(screen.getByText(/does not convert BNB or another fee asset/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/cost basis|realized|unrealized|tax|P&L/i);
  });

  it('deduplicates overlapping pages by symbol and trade ID, not order ID', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(
      0,
      page(
        [execution('1', 'BTCUSDT', { orderId: '7' }), execution('2', 'BTCUSDT', { orderId: '7' })],
        { continuation: 'opaque-page-token' },
      ),
    );
    const nextPage = screen.getByRole('button', { name: 'Load next page' });
    nextPage.focus();
    fireEvent.click(nextPage);
    expect(read).toHaveBeenLastCalledWith({ continuation: 'opaque-page-token' });
    await answer(
      1,
      page([
        execution('2', 'BTCUSDT', { orderId: '7' }),
        execution('1', 'ETHUSDT', { orderId: '7' }),
        execution('3', 'BTCUSDT', { orderId: '8' }),
      ]),
    );
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(screen.getByText('Records shown').parentElement).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: 'No continuation' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'No continuation' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('turns conflicting rows across pages into explicit non-authoritative evidence', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(
      0,
      page([execution('1', 'BTCUSDT', { quantity: '1.0' })], { continuation: 'next' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    await answer(1, page([execution('1', 'BTCUSDT', { quantity: '1.00' })]));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Inconsistent execution evidence. Conflicting rows share one pair and trade ID; no variant is authoritative: BTCUSDT trade 1 (2 variants).',
    );
    expect(screen.queryByRole('table', { name: 'Binance Spot execution history' })).toBeNull();
    const conflicts = screen.getByRole('table', {
      name: 'Conflicting Binance Spot execution evidence',
    });
    expect(within(conflicts).getByText('1.0')).toBeVisible();
    expect(within(conflicts).getByText('1.00')).toBeVisible();
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');
  });

  it('retains an earlier pair failure after another pair reaches its terminal page', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(
      0,
      page([execution('1')], {
        continuation: 'next',
        failures: [{ symbol: 'ETHUSDT', error: 'timeout' }],
        symbols: ['BTCUSDT', 'ETHUSDT'],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    await answer(1, page([], { symbols: ['BTCUSDT', 'ETHUSDT'], completedSymbols: ['BTCUSDT'] }));

    expect(screen.getByRole('alert')).toHaveTextContent('ETHUSDT (timeout)');
    expect(screen.getByText('Continuation').parentElement).toHaveTextContent('None');
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');
  });

  it('distinguishes a failed terminal page from complete requested coverage', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(
      0,
      page([], {
        failures: [{ symbol: 'BTCUSDT', error: 'timeout' }],
        completedSymbols: [],
      }),
    );
    expect(screen.getByText('Continuation').parentElement).toHaveTextContent('None');
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');
  });

  it('marks a full page followed by an empty terminal page complete for only its requested scope', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(
      0,
      page(
        Array.from({ length: 100 }, (_, index) => execution(String(index + 1))),
        { continuation: 'next' },
      ),
    );
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');
    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    await answer(1, page([], { completedSymbols: ['BTCUSDT'] }));
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent(
      'Complete for requested pairs and window',
    );
    expect(screen.getByRole('button', { name: 'No continuation' })).toBeVisible();
    expect(document.body).toHaveTextContent('This is not complete account history');
  });

  it('keeps a continuation failure unresolved after retry, but a fresh success starts over', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    const load = screen.getByRole('button', { name: 'Load executions' });
    fireEvent.click(load);
    await answer(0, page([execution('1')], { continuation: 'next' }));

    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    await answer(1, { state: 'error', error: 'timeout' });
    expect(screen.getByText(/Continuation failed earlier/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    await answer(2, page([], { completedSymbols: ['BTCUSDT'] }));
    expect(screen.getByText(/Continuation failed earlier/)).toBeVisible();
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');

    fireEvent.click(load);
    await answer(3, page([]));
    expect(screen.queryByText(/Continuation failed earlier/)).toBeNull();
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent(
      'Complete for requested pairs and window',
    );
  });

  it('distinguishes no executions, partial retrieval and a retained failed refresh', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    const load = screen.getByRole('button', { name: 'Load executions' });
    fireEvent.click(load);
    await answer(0, page([]));
    expect(screen.getByText(/returned no executions/)).toBeVisible();

    fireEvent.click(load);
    await answer(
      1,
      page([execution('1')], { failures: [{ symbol: 'ETHUSDT', error: 'timeout' }] }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Partial retrieval. Failed pairs/pages: ETHUSDT (timeout). Records shown are retained.',
    );
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');
    expect(screen.getByRole('table')).toBeVisible();

    fireEvent.click(load);
    await answer(2, { state: 'error', error: 'timeout' });
    expect(
      screen.getByText(
        'Refresh failed. Retaining the previous result below unchanged. Binance did not answer in time.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByText('Requested coverage').parentElement).toHaveTextContent('Incomplete');
  });

  it('ignores a late response after the selection changes', async () => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Pair' }), {
      target: { value: 'ETHUSDT' },
    });
    await answer(0, page([execution('1')]));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Records shown')).toBeNull();
  });

  it('drops accumulated private evidence and a late answer when the owner account remounts', async () => {
    const { read, answer } = deferredReads();
    const view = render(<BinanceSpotExecutions key="owner-a" read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    view.rerender(<BinanceSpotExecutions key="owner-b" read={read} />);
    await answer(0, page([execution('1')]));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Records shown')).toBeNull();
  });

  it('uses native labeled controls and keeps focus during a keyboard-triggered read', () => {
    const { read } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    const button = screen.getByRole('button', { name: 'Load executions' });
    button.focus();
    fireEvent.click(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('honors the provider retry delay without another execution request', async () => {
    vi.useFakeTimers({ now: RANGE.endTime });
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(0, { state: 'error', error: 'rate_limited', retryAfterSeconds: 7 });
    const paused = screen.getByRole('button', { name: 'Rate limited' });
    expect(paused).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(paused);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('button', { name: 'Load executions' })).toHaveAttribute(
      'aria-disabled',
      'false',
    );
  });
});

describe('Binance Spot execution view after a refused or unrecognized answer', () => {
  const loadThenAnswer = async (first: SpotExecutionRead, second: SpotExecutionRead) => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    const load = screen.getByRole('button', { name: 'Load executions' });
    fireEvent.click(load);
    await answer(0, first);
    fireEvent.click(load);
    await answer(1, second);
  };

  it.each(['unauthenticated', 'forbidden'] as const)(
    'drops the records shown once access is lost (%s)',
    async (error) => {
      await loadThenAnswer(page([execution('1')]), { state: 'error', error });
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent('Binance reported an error.');
    },
  );

  it.each([{ state: 'not_configured' }, { state: 'unavailable' }] as const)(
    'shows no records and no failure when the answer is $state',
    async (answer) => {
      await loadThenAnswer(page([execution('1')]), answer);
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('pauses for the default delay when one pair was rate-limited without a hint', async () => {
    vi.useFakeTimers({ now: RANGE.endTime });
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    const limited = page([execution('1')], { continuation: 'next' });
    if (limited.state !== 'executions') throw new Error('unreachable');
    limited.coverage.failures = [{ symbol: 'ETHUSDT', error: 'rate_limited' }];
    await answer(0, limited);
    expect(screen.getAllByRole('button', { name: 'Rate limited' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate limited' })[1] as HTMLElement);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(55_000));
    expect(screen.getAllByRole('button', { name: 'Rate limited' })).toHaveLength(2);
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('button', { name: 'Load next page' })).toBeVisible();
  });

  it('treats a read that throws as a network failure', async () => {
    const read = vi.fn(() => Promise.reject(new Error('boom')));
    render(<BinanceSpotExecutions read={read} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load executions' })));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server or Binance.');
  });

  it.each([
    ['invalid_request', 'was not accepted'],
    ['binance_auth', 'rejected the API key'],
    ['permissions_refused', 'can do more than read'],
    ['permissions_unverified', 'did not confirm'],
    ['malformed_response', 'could not be read safely'],
    ['provider_error', 'reported an error'],
  ] as const)('explains %s', async (error, text) => {
    const { read, answer } = deferredReads();
    render(<BinanceSpotExecutions read={read} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load executions' }));
    await answer(0, { state: 'error', error });
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
});

describe('reading executions through the edge function', () => {
  const wire = (
    overrides: Record<string, unknown> = {},
    coverage: Record<string, unknown> = {},
  ) => {
    const answer = page([execution('1'), execution('2')], { continuation: 'opaque' });
    if (answer.state !== 'executions') throw new Error('unreachable');
    return { ...answer, ...overrides, coverage: { ...answer.coverage, ...coverage } };
  };

  it('posts the selection, or only the continuation, to the one function', async () => {
    invoke.mockResolvedValue({ data: wire(), error: null });
    const selection = { symbols: ['BTCUSDT'], ...RANGE };
    expect(await readSpotExecutions(selection)).toEqual(wire());
    expect(invoke).toHaveBeenLastCalledWith('binance-spot-account', {
      method: 'POST',
      body: { action: 'executions', ...selection },
      timeout: 20_000,
    });
    await readSpotExecutions({ continuation: 'opaque' });
    expect(invoke).toHaveBeenLastCalledWith('binance-spot-account', {
      method: 'POST',
      body: { action: 'executions', continuation: 'opaque' },
      timeout: 20_000,
    });
  });

  it('reads the reason out of a non-2xx answer and never throws', async () => {
    const failed = (context: unknown) => ({
      data: null,
      error: Object.assign(new Error('x'), { context }),
    });
    invoke.mockResolvedValue(
      failed(new Response('{"state":"error","error":"invalid_request"}', { status: 400 })),
    );
    expect(await readSpotExecutions({ continuation: 'x' })).toEqual({
      state: 'error',
      error: 'invalid_request',
    });
    invoke.mockResolvedValue(failed(new Response('<html>', { status: 502 })));
    expect(await readSpotExecutions({ continuation: 'x' })).toEqual({ state: 'unavailable' });
    invoke.mockResolvedValue(failed(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    expect(await readSpotExecutions({ continuation: 'x' })).toEqual({
      state: 'error',
      error: 'timeout',
    });
    invoke.mockRejectedValue(new Error('boom'));
    expect(await readSpotExecutions({ continuation: 'x' })).toEqual({
      state: 'error',
      error: 'network',
    });
  });

  it('keeps only the fields it knows, with per-pair failures and their retry hints', () => {
    const read = parseSpotExecutionRead(
      wire(
        { continuation: 7, secret: 'x' },
        {
          partial: true,
          failures: [
            { symbol: 'ETHUSDT', error: 'rate_limited', retryAfterSeconds: 9, extra: 1 },
            { symbol: 'SOLUSDT', error: 'timeout', retryAfterSeconds: 'soon' },
          ],
          extra: 1,
        },
      ),
    );
    expect(read).toEqual({
      state: 'executions',
      executions: [execution('1'), execution('2')],
      conflicts: [],
      coverage: {
        ...wire().coverage,
        partial: true,
        failures: [
          { symbol: 'ETHUSDT', error: 'rate_limited', retryAfterSeconds: 9 },
          { symbol: 'SOLUSDT', error: 'timeout' },
        ],
      },
    });
  });

  it('parses every exact conflicting variant without selecting an authoritative row', () => {
    const variants = [
      execution('1', 'BTCUSDT', { quantity: '1.0' }),
      execution('1', 'BTCUSDT', { quantity: '1.00' }),
    ];
    const answer = page([], {
      conflicts: [{ symbol: 'BTCUSDT', tradeId: '1', variants }],
      completedSymbols: ['BTCUSDT'],
    });
    expect(parseSpotExecutionRead(answer)).toEqual(answer);
  });

  it('passes through not_configured and a known error', () => {
    expect(parseSpotExecutionRead({ state: 'not_configured' })).toEqual({
      state: 'not_configured',
    });
    expect(
      parseSpotExecutionRead({
        state: 'error',
        error: 'permissions_refused',
        enabled: ['enableWithdrawals', 3],
        retryAfterSeconds: 0,
      }),
    ).toEqual({ state: 'error', error: 'permissions_refused', enabled: ['enableWithdrawals'] });
  });

  it.each([
    ['is not an object', null],
    ['is an unknown error', { state: 'error', error: 'surprise' }],
    ['is a balance answer', { state: 'connected', readAt: '2026-11-10T09:00:00Z', balances: [] }],
    ['has executions that are not a list', wire({ executions: 'all' })],
    ['has conflicts that are not a list', wire({ conflicts: null })],
    [
      'has a conflict with only one variant',
      wire({
        conflicts: [{ symbol: 'BTCUSDT', tradeId: '1', variants: [execution('1')] }],
      }),
    ],
    [
      'has a conflict whose variant uses another identity',
      wire({
        conflicts: [
          {
            symbol: 'BTCUSDT',
            tradeId: '1',
            variants: [execution('1'), execution('2')],
          },
        ],
      }),
    ],
    [
      'has a fill with a numeric quantity',
      wire({ executions: [{ ...execution('1'), quantity: 1 }] }),
    ],
    [
      'has a fill with an unknown side',
      wire({ executions: [{ ...execution('1'), side: 'hold' }] }),
    ],
    ['has no coverage', { ...wire(), coverage: null }],
    ['has pairs that are not a list', wire({}, { symbols: 'BTCUSDT' })],
    ['has a pair that is not a string', wire({}, { symbols: [1] })],
    ['has a start time that is not a number', wire({}, { startTime: '1' })],
    ['has an end time that is not a number', wire({}, { endTime: '2' })],
    ['has a count that is not a number', wire({}, { returned: '2' })],
    ['has a count that disagrees with the records', wire({}, { returned: 3 })],
    ['has a retrieval time that is not a string', wire({}, { retrievedAt: 5 })],
    ['has a retrieval time that is not a date', wire({}, { retrievedAt: 'yesterday' })],
    ['has no more-results flag', wire({}, { hasMore: 'yes' })],
    ['has no partial flag', wire({}, { partial: 0 })],
    ['has failures that are not a list', wire({}, { failures: null })],
    ['has completed pairs that are not a list', wire({}, { completedSymbols: null })],
    ['has a completed pair outside the selection', wire({}, { completedSymbols: ['ETHUSDT'] })],
    ['has a failure that is not an object', wire({}, { failures: ['ETHUSDT'] })],
    ['has a failure without a pair', wire({}, { failures: [{ error: 'timeout' }] })],
    ['has a failure without a code', wire({}, { failures: [{ symbol: 'ETHUSDT' }] })],
    [
      'has a failure with an unknown code',
      wire({}, { failures: [{ symbol: 'ETHUSDT', error: 'surprise' }] }),
    ],
    ['claims a different limitation', wire({}, { limitation: 'complete_history' })],
  ])('treats the answer as unavailable when it %s', (_, body) => {
    expect(parseSpotExecutionRead(body)).toEqual({ state: 'unavailable' });
  });
});
