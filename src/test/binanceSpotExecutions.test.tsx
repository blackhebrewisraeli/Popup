import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BinanceSpotExecutions } from '@/components/BinanceSpotExecutions';
import type { SpotExecution, SpotExecutionRead } from '@/lib/binanceSpotAccount';

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
    failures?: Array<{ symbol: string; error: 'timeout' }>;
  } = {},
): SpotExecutionRead => ({
  state: 'executions',
  executions,
  coverage: {
    symbols: [...new Set(executions.map((item) => item.symbol).concat('BTCUSDT'))],
    ...RANGE,
    returned: executions.length,
    retrievedAt: '2026-11-10T09:00:01.000Z',
    hasMore: options.continuation !== undefined,
    partial: (options.failures?.length ?? 0) > 0,
    failures: options.failures ?? [],
    limitation: 'selected_pairs_and_24h_window',
  },
  ...(options.continuation ? { continuation: options.continuation } : {}),
});

function deferredReads() {
  const pending: Array<(read: SpotExecutionRead) => void> = [];
  const read = vi.fn(() => new Promise<SpotExecutionRead>((resolve) => pending.push(resolve)));
  const answer = async (index: number, result: SpotExecutionRead) => {
    await act(async () => pending[index]?.(result));
  };
  return { read, answer };
}

afterEach(() => vi.useRealTimers());

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
    expect(screen.getByRole('button', { name: 'No more results' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'No more results' })).toHaveAttribute(
      'aria-disabled',
      'true',
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
    expect(screen.getByRole('table')).toBeVisible();

    fireEvent.click(load);
    await answer(2, { state: 'error', error: 'timeout' });
    expect(
      screen.getByText(
        'Refresh failed. Retaining the records shown below. Binance did not answer in time.',
      ),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('table')).toBeVisible();
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
