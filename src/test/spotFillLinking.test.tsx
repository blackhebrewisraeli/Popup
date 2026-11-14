import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Labeled synthetic data only: invented trade and order IDs, prices, times and experiment IDs.
 * No request leaves the test: the Supabase client is replaced below and executions come from a
 * stub read.
 */
const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  insertResult: vi.fn(),
  listResult: vi.fn(),
  lookupResult: vi.fn(),
  reads: [] as { table: string; columns: string; filters: unknown[][] }[],
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: db.rpc,
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        db.inserts.push({ table, row });
        return { select: () => ({ single: () => db.insertResult() }) };
      },
      select: (columns: string) => {
        const read = { table, columns, filters: [] as unknown[][] };
        db.reads.push(read);
        const chain = {
          eq: (...args: unknown[]) => (read.filters.push(['eq', ...args]), chain),
          order: (...args: unknown[]) => (read.filters.push(['order', ...args]), chain),
          limit: (...args: unknown[]) => (read.filters.push(['limit', ...args]), db.listResult()),
          maybeSingle: () => db.lookupResult(),
        };
        return chain;
      },
    }),
  },
}));

import { BinanceSpotExecutions } from '@/components/BinanceSpotExecutions';
import { SpotExperiments } from '@/components/SpotExperiments';
import type { SpotExecution, SpotExecutionRead } from '@/lib/binanceSpotAccount';
import {
  fillDifferences,
  fillRow,
  linkSpotFill,
  matchingExperiments,
  storedLink,
  type LinkedFill,
  type SpotExperimentRecord,
  type SpotFillInsert,
} from '@/lib/spotExperiments';

const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const START = Date.parse('2026-10-28T08:00:00.000Z');
const END = Date.parse('2026-10-28T09:00:00.000Z');
const RETRIEVED = '2026-10-28T09:00:01.250Z';
const EXP_A = 'e0000000-0000-4000-8000-00000000000a';
const EXP_B = 'e0000000-0000-4000-8000-00000000000b';
const EXP_OTHER_LABEL = 'e0000000-0000-4000-8000-00000000000c';
const EXP_ETH = 'e0000000-0000-4000-8000-00000000000d';

/** Decimal strings Binance might send, trailing zeros and 18 decimal places included. */
const fill = (tradeId: string, overrides: Partial<SpotExecution> = {}): SpotExecution => ({
  symbol: 'BTCUSDT',
  tradeId,
  orderId: '9000000000000000001',
  time: START + 1_234,
  side: 'buy',
  quantity: '0.00100000',
  price: '64000.12000000',
  quoteQuantity: '64.00012000',
  commission: '0.000000000123456789',
  commissionAsset: 'BNB',
  ...overrides,
});

function page(
  executions: SpotExecution[],
  conflicts: { symbol: string; tradeId: string; variants: SpotExecution[] }[] = [],
  continuation?: string,
): SpotExecutionRead {
  return {
    state: 'executions',
    executions,
    conflicts,
    coverage: {
      symbols: ['BTCUSDT'],
      startTime: START,
      endTime: END,
      returned: executions.length,
      retrievedAt: RETRIEVED,
      hasMore: continuation !== undefined,
      partial: false,
      failures: [],
      completedSymbols: continuation ? [] : ['BTCUSDT'],
      limitation: 'selected_pairs_and_24h_window',
    },
    ...(continuation ? { continuation } : {}),
  };
}

function experiment(
  id: string,
  overrides: Partial<SpotExperimentRecord> = {},
): SpotExperimentRecord {
  return {
    id,
    recorded_at: '2026-10-28T07:00:00.5+00:00',
    account_label: 'main',
    symbol: 'BTCUSDT',
    source_scan_id: '20261028T060000Z-0000c0de',
    source_snapshot_sha256: 'a1'.repeat(32),
    source_reproduction: 'match',
    source_evidence: {},
    decision: `Synthetic decision ${id.slice(-1)}`,
    decision_stated_at: null,
    spot_experiment_entries: [],
    spot_experiment_fills: [],
    ...overrides,
  };
}

const READ = {
  accountLabel: 'main',
  retrievedAt: RETRIEVED,
  startTime: START,
  endTime: END,
  complete: true,
};

/** The stored copy the database would return for `row`. */
function stored(row: SpotFillInsert, overrides: Partial<LinkedFill> = {}): LinkedFill {
  return {
    ...row,
    id: 'f0000000-0000-4000-8000-000000000001',
    recorded_at: '2026-10-28T09:05:00.75+00:00',
    ...overrides,
  };
}

beforeEach(() => {
  db.inserts = [];
  db.reads = [];
  db.rpc.mockResolvedValue({ data: true, error: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.rpc.mockReset();
  db.insertResult.mockReset();
  db.listResult.mockReset();
  db.lookupResult.mockReset();
});

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fact(scope: HTMLElement, name: string) {
  return within(scope).getAllByText(name, { selector: 'dt' })[0]?.nextElementSibling?.textContent;
}

describe('a fill row', () => {
  it('copies the fill exactly, commission in its own asset, with the read it came from', () => {
    const row = fillRow(EXP_A, fill('7', { side: 'sell' }), { ...READ, complete: false });
    expect(row).toEqual({
      experiment_id: EXP_A,
      account_label: 'main',
      symbol: 'BTCUSDT',
      trade_id: '7',
      order_id: '9000000000000000001',
      side: 'sell',
      trade_time_ms: START + 1_234,
      quantity: '0.00100000',
      price: '64000.12000000',
      quote_quantity: '64.00012000',
      commission: '0.000000000123456789',
      commission_asset: 'BNB',
      retrieved_at: RETRIEVED,
      window_start_ms: START,
      window_end_ms: END,
      coverage_complete: false,
    });
    expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['id', 'user_id', 'recorded_at']));
  });

  it('may join only experiments with the same pair and account label', () => {
    const experiments = [
      experiment(EXP_A),
      experiment(EXP_OTHER_LABEL, { account_label: 'spare' }),
      experiment(EXP_ETH, { symbol: 'ETHUSDT' }),
    ];
    expect(matchingExperiments(experiments, 'BTCUSDT', 'main').map((item) => item.id)).toEqual([
      EXP_A,
    ]);
    expect(matchingExperiments(experiments, 'BTCUSDT', 'Main')).toEqual([]);
  });

  it('finds a stored link by label, pair and trade, and compares fill fields exactly', () => {
    const row = fillRow(EXP_A, fill('7'), READ);
    const linked = stored(row);
    const experiments = [experiment(EXP_A, { spot_experiment_fills: [linked] })];
    expect(storedLink(experiments, 'main', 'BTCUSDT', '7')?.fill).toBe(linked);
    expect(storedLink(experiments, 'spare', 'BTCUSDT', '7')).toBeNull();
    expect(storedLink(experiments, 'main', 'BTCUSDT', '8')).toBeNull();
    // Another read of the same fill differs only in provenance, which is not fill content.
    expect(
      fillDifferences(linked, {
        ...row,
        retrieved_at: '2026-10-29T00:00:00Z',
        coverage_complete: false,
      }),
    ).toEqual([]);
    // "0.001" is the same number as "0.00100000" but not the same string.
    expect(
      fillDifferences(linked, { ...row, quantity: '0.001', commission_asset: 'USDT' }),
    ).toEqual(['quantity', 'commission asset']);
  });
});

describe('storing a link', () => {
  const row = fillRow(EXP_A, fill('7'), READ);

  it('reports linked only with the row the database returned', async () => {
    db.insertResult.mockResolvedValue({ data: stored(row), error: null });
    expect(await linkSpotFill(row)).toEqual({ state: 'linked', fill: stored(row) });
    expect(db.inserts).toEqual([{ table: 'spot_experiment_fills', row }]);
    db.insertResult.mockResolvedValue({ data: null, error: null });
    expect(await linkSpotFill(row)).toMatchObject({ state: 'unknown' });
  });

  it('reads the stored copy back when the database refuses a second link for the trade', async () => {
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    db.lookupResult.mockResolvedValue({ data: stored(row), error: null });
    expect(await linkSpotFill(row)).toEqual({ state: 'already', fill: stored(row) });
    expect(db.reads.at(-1)).toMatchObject({
      table: 'spot_experiment_fills',
      filters: [
        ['eq', 'account_label', 'main'],
        ['eq', 'symbol', 'BTCUSDT'],
        ['eq', 'trade_id', '7'],
      ],
    });
    db.lookupResult.mockResolvedValue({ data: null, error: { code: '', message: 'offline' } });
    expect(await linkSpotFill(row)).toEqual({ state: 'already', fill: null });
  });

  it('tells a refusal the database answered from an outcome nobody knows', async () => {
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    expect(await linkSpotFill(row)).toEqual({
      state: 'refused',
      message: expect.stringMatching(/^Permission denied: only the configured Binance owner/),
    });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '23503', message: 'violates foreign key constraint' },
    });
    expect(await linkSpotFill(row)).toEqual({
      state: 'refused',
      message: expect.stringMatching(
        /^The experiment does not accept it: its pair or account label differ/,
      ),
    });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'TypeError: Failed to fetch' },
    });
    expect(await linkSpotFill(row)).toEqual({
      state: 'unknown',
      message: 'TypeError: Failed to fetch',
    });
    db.insertResult.mockRejectedValue(new Error('aborted'));
    expect(await linkSpotFill(row)).toEqual({ state: 'unknown', message: 'aborted' });
  });
});

/** The execution view as Account shows it to the owner, after one load with `label`. */
async function loadView(
  executions: SpotExecutionRead,
  label = 'main',
  experiments: SpotExperimentRecord[] = [experiment(EXP_A)],
) {
  db.listResult.mockResolvedValue({ data: experiments, error: null });
  const read = vi.fn<() => Promise<SpotExecutionRead>>().mockResolvedValue(executions);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <BinanceSpotExecutions read={read} linkFor={OWNER} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Account label' }), {
    target: { value: label },
  });
  fireEvent.click(screen.getByRole('button', { name: /Load executions/ }));
  await screen.findByLabelText('Execution history coverage');
  return { ...view, read };
}

const linkButton = (tradeId: string) =>
  screen.findByRole('button', { name: new RegExp(`trade ${tradeId} to an experiment$`) });
const panel = () => screen.getByRole('region', { name: /to an experiment$/ });
const confirmButton = () =>
  within(panel()).getByRole('button', {
    name: /^(Confirm and link|Linking…|Linked|Not linked again|Try again)$/,
  });

describe('Link to experiment in the execution view', () => {
  it('asks for an account label first, and refuses one the database would refuse', async () => {
    const { read, unmount } = await loadView(page([fill('1')]), '');
    expect(
      screen.getByText(/^To link a fill to an experiment, enter the account label/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Experiment' })).toBeNull();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
    unmount();

    const bad = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BinanceSpotExecutions read={bad} linkFor={OWNER} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Account label' }), {
      target: { value: 'Main' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load executions/ }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /^The account label must be 1 to 40 lowercase .* Nothing was requested\.$/,
    );
    expect(bad).not.toHaveBeenCalled();
  });

  it('clears the result when the label changes: the label belongs to the retrieval', async () => {
    await loadView(page([fill('1')]));
    expect(await linkButton('1')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Account label' }), {
      target: { value: 'spare' },
    });
    expect(screen.queryByLabelText('Execution history coverage')).toBeNull();
  });

  it('offers links only on consistent rows, into experiments with the same pair and label', async () => {
    const variant = fill('3', { quantity: '0.002' });
    await loadView(
      page(
        [fill('1'), fill('2', { symbol: 'ETHUSDT' })],
        [{ symbol: 'BTCUSDT', tradeId: '3', variants: [fill('3'), variant] }],
      ),
      'main',
      [
        experiment(EXP_A),
        experiment(EXP_B, { recorded_at: '2026-10-28T07:30:00+00:00' }),
        experiment(EXP_OTHER_LABEL, { account_label: 'spare' }),
        experiment(EXP_ETH, { symbol: 'ETHUSDT', account_label: 'spare' }),
      ],
    );
    expect(await linkButton('1')).toBeInTheDocument();
    expect(screen.getByText('No ETHUSDT experiment under main')).toBeInTheDocument();
    // The conflicting trade has no link control anywhere.
    expect(screen.queryByRole('button', { name: /trade 3 to an experiment$/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /to an experiment$/ })).toHaveLength(1);

    fireEvent.click(await linkButton('1'));
    const options = within(panel())
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual([
      'Choose an experiment',
      'BTCUSDT · main · recorded 2026-10-28 07:00:00.500 UTC',
      'BTCUSDT · main · recorded 2026-10-28 07:30:00 UTC',
    ]);
    // Nothing is chosen for the owner when more than one experiment matches.
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirmButton());
    expect(db.inserts).toEqual([]);
  });

  it('shows exactly what will be stored, then stores one link however often Confirm is pressed', async () => {
    const { read } = await loadView(page([fill('1')]));
    fireEvent.click(await linkButton('1'));
    const region = panel();
    expect(region.querySelector('h5')).toHaveFocus();
    expect(fact(region, 'Experiment')).toBe(
      'BTCUSDT · main · recorded 2026-10-28 07:00:00.500 UTC: Synthetic decision a',
    );
    expect(fact(region, 'Account label')).toBe('main (the label you gave this retrieval)');
    expect(fact(region, 'Side')).toBe('Buy');
    expect(fact(region, 'Trade ID')).toBe('1');
    expect(fact(region, 'Order ID')).toBe('9000000000000000001');
    expect(fact(region, 'Trade time')).toBe('2026-10-28 08:00:01.234 UTC');
    expect(fact(region, 'Quantity')).toBe('0.00100000');
    expect(fact(region, 'Price')).toBe('64000.12000000');
    expect(fact(region, 'Quote quantity')).toBe('64.00012000');
    expect(fact(region, 'Commission')).toBe('0.000000000123456789 BNB');
    expect(fact(region, 'Retrieved')).toBe(
      '2026-10-28 09:00:01.250 UTC, the function’s clock for this retrieval’s latest page',
    );
    expect(fact(region, 'Requested window')).toBe(
      '2026-10-28 08:00:00 UTC – 2026-10-28 09:00:00 UTC',
    );
    expect(fact(region, 'Coverage')).toBe('Complete for the requested pair and window');
    expect(region).toHaveTextContent('The server does not re-read Binance to verify them.');
    expect(region).toHaveTextContent('Linking never closes the experiment, a sell included');

    const answer = deferred<unknown>();
    db.insertResult.mockReturnValue(answer.promise);
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    fireEvent.keyDown(confirmButton(), { key: 'Enter' });
    fireEvent.click(confirmButton());
    expect(confirmButton()).toHaveTextContent('Linking…');
    expect(db.inserts).toEqual([
      { table: 'spot_experiment_fills', row: fillRow(EXP_A, fill('1'), READ) },
    ]);
    const before = db.reads.filter((item) => item.table === 'spot_experiments').length;
    const row = fillRow(EXP_A, fill('1'), READ);
    db.listResult.mockResolvedValue({
      data: [experiment(EXP_A, { spot_experiment_fills: [stored(row)] })],
      error: null,
    });
    await act(async () => answer.resolve({ data: stored(row), error: null }));
    expect(within(panel()).getByText(/^Linked\. The database stored link/)).toHaveTextContent(
      'f0000000-0000-4000-8000-000000000001 at 2026-10-28 09:05:00.750 UTC, by its own clock',
    );
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
    // The experiments are read again, and the row now says where it is linked.
    await waitFor(() =>
      expect(db.reads.filter((item) => item.table === 'spot_experiments').length).toBe(before + 1),
    );
    expect(await screen.findByText(/^Linked: BTCUSDT recorded/)).toBeInTheDocument();
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts.some((item) => item.table === 'spot_experiment_entries')).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);

    fireEvent.click(within(panel()).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.getByText(/^Linked: BTCUSDT/)).toHaveFocus());
  });

  it('keeps the choice after a refusal and lets the owner try again', async () => {
    await loadView(page([fill('1')]));
    fireEvent.click(await linkButton('1'));
    db.insertResult.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    fireEvent.click(confirmButton());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      /^Not linked\. Permission denied: .* Nothing was stored\.$/,
    );
    expect(confirmButton()).toHaveTextContent('Confirm and link');
    expect(confirmButton()).not.toHaveAttribute('aria-disabled');
    const row = fillRow(EXP_A, fill('1'), READ);
    db.insertResult.mockResolvedValueOnce({ data: stored(row), error: null });
    fireEvent.click(confirmButton());
    expect(await within(panel()).findByText(/^Linked\./)).toBeInTheDocument();
    expect(db.inserts).toHaveLength(2);
  });

  it('says a link may or may not be stored without an answer, and a retry finds the stored one', async () => {
    await loadView(page([fill('1')]));
    fireEvent.click(await linkButton('1'));
    db.insertResult.mockResolvedValueOnce({
      data: null,
      error: { code: '', message: 'TypeError: Failed to fetch' },
    });
    fireEvent.click(confirmButton());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'No confirmation from the database (TypeError: Failed to fetch). The link may or may not be stored.',
    );
    expect(confirmButton()).toHaveTextContent('Try again');
    const row = fillRow(EXP_A, fill('1'), READ);
    db.insertResult.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    db.lookupResult.mockResolvedValueOnce({ data: stored(row), error: null });
    fireEvent.click(confirmButton());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      /^Not linked again\. The database already holds a link for trade 1 under the label main, stored 2026-10-28 09:05:00\.750 UTC\. Its fill values are the same as this read\.$/,
    );
    expect(confirmButton()).toHaveAttribute('aria-disabled', 'true');
    expect(db.inserts).toHaveLength(2);
  });

  it('names another experiment and every differing field when the trade is linked elsewhere', async () => {
    await loadView(page([fill('1')]), 'main', [
      experiment(EXP_A),
      experiment(EXP_B, {
        account_label: 'main',
        symbol: 'BTCUSDT',
        recorded_at: '2026-10-27T07:00:00+00:00',
      }),
    ]);
    fireEvent.click(await linkButton('1'));
    fireEvent.change(within(panel()).getByRole('combobox', { name: 'Experiment' }), {
      target: { value: EXP_A },
    });
    const row = fillRow(EXP_A, fill('1'), READ);
    db.insertResult.mockResolvedValueOnce({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    db.lookupResult.mockResolvedValueOnce({
      data: stored(row, { experiment_id: EXP_B, price: '64000.12', commission: '0' }),
      error: null,
    });
    fireEvent.click(confirmButton());
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'It belongs to another experiment (BTCUSDT · main · recorded 2026-10-27 07:00:00 UTC); a trade belongs to one experiment. Its stored copy differs from this read in: price, commission. Nothing was changed',
    );
  });

  it('shows a trade already linked instead of offering it again, and flags a differing copy', async () => {
    const row = fillRow(EXP_A, fill('1'), READ);
    await loadView(page([fill('1'), fill('2')]), 'main', [
      experiment(EXP_A, {
        spot_experiment_fills: [
          stored(row),
          stored(fillRow(EXP_A, fill('2'), READ), { id: 'f2', quantity: '0.001' }),
        ],
      }),
    ]);
    const cells = await screen.findAllByText(
      /^Linked: BTCUSDT recorded 2026-10-28 07:00:00\.500 UTC/,
    );
    expect(cells).toHaveLength(2);
    expect(cells[0]).not.toHaveTextContent('differs');
    expect(cells[1]).toHaveTextContent('stored copy differs from this read');
    expect(screen.queryByRole('button', { name: /to an experiment$/ })).toBeNull();
  });

  it('links a sell as a sell and writes no close', async () => {
    const sell = fill('5', { side: 'sell', commission: '0.06400012', commissionAsset: 'USDT' });
    await loadView(page([sell]));
    fireEvent.click(await linkButton('5'));
    expect(fact(panel(), 'Side')).toBe('Sell');
    expect(fact(panel(), 'Commission')).toBe('0.06400012 USDT');
    const row = fillRow(EXP_A, sell, READ);
    db.insertResult.mockResolvedValueOnce({ data: stored(row), error: null });
    fireEvent.click(confirmButton());
    expect(await within(panel()).findByText(/^Linked\./)).toBeInTheDocument();
    expect(db.inserts).toEqual([{ table: 'spot_experiment_fills', row }]);
    expect(row.side).toBe('sell');
  });

  it('refuses a fill a later page turned into a conflict while its review was open', async () => {
    const read = vi
      .fn<() => Promise<SpotExecutionRead>>()
      .mockResolvedValueOnce(page([fill('1')], [], 'cursor-1'))
      .mockResolvedValueOnce(page([fill('1', { price: '1.00000000' })]));
    db.listResult.mockResolvedValue({ data: [experiment(EXP_A)], error: null });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BinanceSpotExecutions read={read} linkFor={OWNER} />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Account label' }), {
      target: { value: 'main' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Load executions/ }));
    fireEvent.click(await linkButton('1'));
    expect(fact(panel(), 'Coverage')).toMatch(/^Incomplete/);
    fireEvent.click(screen.getByRole('button', { name: 'Load next page' }));
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      /^This fill is no longer a consistent record in this retrieval/,
    );
    fireEvent.click(confirmButton());
    expect(db.inserts).toEqual([]);
  });

  it('returns focus to the row when the review is cancelled', async () => {
    await loadView(page([fill('1')]));
    const button = await linkButton('1');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: /to an experiment$/ })).toBeNull();
    await waitFor(() => expect(button).toHaveFocus());
  });

  it('says why nothing can be linked for a sign-in the database does not name', async () => {
    db.rpc.mockResolvedValue({ data: false, error: null });
    await loadView(page([fill('1')]));
    expect(
      await screen.findByText(/^Linking unavailable: the database names no Binance owner/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Experiment' })).toBeNull();
  });
});

describe('Linked fills in Account', () => {
  it('shows each fill exactly, with the read it came from and when it was linked, in trade time order', async () => {
    const buy = stored(fillRow(EXP_A, fill('1'), READ), { id: 'f1' });
    const sell = stored(
      fillRow(EXP_A, fill('2', { side: 'sell', time: START + 60_000 }), {
        ...READ,
        complete: false,
      }),
      { id: 'f2', recorded_at: '2026-10-28T12:00:00+00:00' },
    );
    db.listResult.mockResolvedValue({
      data: [
        experiment(EXP_A, {
          spot_experiment_fills: [sell, buy],
          spot_experiment_entries: [
            {
              id: 'c1',
              experiment_id: EXP_A,
              kind: 'close',
              observed_in: null,
              rule: null,
              rule_status: null,
              supersedes: null,
              statement: 'Synthetic close',
              stated_at: null,
              recorded_at: '2026-10-28T10:00:00+00:00',
            },
          ],
        }),
      ],
      error: null,
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SpotExperiments userId={OWNER} />
      </QueryClientProvider>,
    );
    const item = (await screen.findByText('BTCUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('BTCUSDT'));
    const list = within(item).getByRole('list', { name: 'Linked fills, in trade time order' });
    const [first, second] = within(list).getAllByRole('listitem');
    if (!first || !second) throw new Error('fills');
    expect(first).toHaveTextContent('Buy trade 1 · order 9000000000000000001');
    expect(first).not.toHaveTextContent('Linked after the close');
    expect(fact(first, 'Trade time')).toBe('2026-10-28 08:00:01.234 UTC');
    expect(fact(first, 'Quantity')).toBe('0.00100000');
    expect(fact(first, 'Price')).toBe('64000.12000000');
    expect(fact(first, 'Quote quantity')).toBe('64.00012000');
    expect(fact(first, 'Commission')).toBe('0.000000000123456789 BNB');
    expect(fact(first, 'Copied from')).toBe(
      'A read retrieved 2026-10-28 09:00:01.250 UTC (the function’s clock) for 2026-10-28 08:00:00 UTC – 2026-10-28 09:00:00 UTC; coverage complete for that pair and window',
    );
    expect(fact(first, 'Linked')).toBe('2026-10-28 09:05:00.750 UTC, the database’s clock');
    expect(second).toHaveTextContent('Sell trade 2');
    expect(second).toHaveTextContent('Linked after the close');
    expect(fact(second, 'Copied from')).toMatch(/; coverage incomplete$/);
    expect(item).toHaveTextContent('The server did not verify them against Binance.');
    expect(fact(item, 'Close')).toMatch(/^Synthetic close/);
    expect(item).not.toHaveTextContent(/remaining|position size|order status|profit/i);
  });
});
