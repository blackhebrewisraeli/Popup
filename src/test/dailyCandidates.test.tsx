import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * End to end on SYNTHETIC data: the real collector runs against a fake Binance into an
 * in-process store, and the board reads those rows through a stand-in Supabase client.
 */
const db = vi.hoisted(() => ({
  owner: true as boolean | Error,
  rows: { discovery_batches: [] as unknown[], discovery_attempts: [] as unknown[] },
  readError: null as { message: string } | null,
  reads: [] as { table: string; filters: unknown[][] }[],
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name: string) => {
      if (name !== 'is_binance_spot_owner') throw new Error(`Unexpected RPC ${name}`);
      return db.owner instanceof Error
        ? { data: null, error: { message: db.owner.message, code: 'PGRST000' } }
        : { data: db.owner, error: null };
    },
    from: (table: 'discovery_batches' | 'discovery_attempts') => ({
      select: () => {
        const read = { table, filters: [] as unknown[][] };
        db.reads.push(read);
        const chain = {
          eq: (...args: unknown[]) => (read.filters.push(['eq', ...args]), chain),
          order: (...args: unknown[]) => (read.filters.push(['order', ...args]), chain),
          limit: (n: number) => ({
            abortSignal: async () =>
              db.readError
                ? { data: null, error: db.readError }
                : { data: db.rows[table].slice(0, n), error: null },
          }),
        };
        return chain;
      },
    }),
  },
}));
vi.mock('@/lib/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authStore')>()),
  useAuth: () => ({ user: { id: '00000000-0000-4000-8000-0000000000d1' } }),
}));

import { DailyCandidates } from '@/components/DailyCandidates';
import { ResearchZone } from '@/components/Workspace';
import type { Asset } from '@/lib/assets';
import { evidenceSha256, selectCandidates, type DiscoveryEvidence } from '@/lib/dailyDiscovery';
import { runDailyDiscovery } from '../../scripts/dailyDiscovery';
import {
  at,
  binanceFake,
  json,
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

/** Runs the collector at each time against one store and serves its rows to the board. */
async function collect(
  times: number[],
  options: { market?: ReturnType<typeof syntheticMarket>; failTickerAt?: number[] } = {},
) {
  const storage = memoryDiscoveryStore();
  for (const [index, time] of times.entries()) {
    const clock = testClock(time);
    const fail = options.failTickerAt?.includes(index);
    await runDailyDiscovery({
      store: storage.store,
      attemptId: `gh-${index + 1}-1`,
      deps: {
        fetch: binanceFake(options.market ?? syntheticMarket(), clock, {
          ticker: fail ? [() => json(451, {})] : [],
        }).fetch,
        now: clock.now,
        sleep: clock.sleep,
      },
    });
  }
  // As PostgREST returns them: jsonb reorders keys; timestamps come back with +00:00.
  db.rows.discovery_batches = storage.batchRows().map((row) => ({
    ...row,
    collected_at: row.collected_at.replace('Z', '+00:00'),
  }));
  db.rows.discovery_attempts = storage.attemptRows();
  return storage;
}

function show(now: number, assets: Asset[] | null = [], onOpenAsset = vi.fn()) {
  vi.setSystemTime(now);
  // No wait between the board's own retry and the next read.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>{node}</QueryClientProvider>
  );
  render(wrap(<DailyCandidates assets={assets} onOpenAsset={onOpenAsset} />));
  return onOpenAsset;
}

const board = () => screen.findByRole('region', { name: 'Daily candidates' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  db.owner = true;
  db.readError = null;
  db.reads = [];
  db.rows = { discovery_batches: [], discovery_attempts: [] };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Daily candidates', () => {
  it('shows the latest verified batch with its source, policy, coverage and candidates', async () => {
    await collect([at(0, 33, 5)]);
    show(at(9), [BTC]);
    const section = await board();
    expect(within(section).getByText('Current')).toBeTruthy();
    expect(
      within(section).getByText(
        /not a BUY\/SELL signal, a model score or evidence of profitability/,
      ),
    ).toBeTruthy();
    // The batch summary: date, collection time and freshness, counts, latest attempt.
    const summary = within(section).getByText('Batch date').closest('dl')!;
    expect(within(summary).getByText('2026-11-20')).toBeTruthy();
    expect(within(summary).getByText('20 Nov, 00:33 UTC')).toBeTruthy();
    expect(within(summary).getByText('8h 27m ago')).toBeTruthy();
    expect(within(summary).getByText('50 of 62 eligible')).toBeTruthy();
    expect(within(summary).getByText('Batch collected')).toBeTruthy();
    expect(within(summary).getByText('Latest attempt').closest('div')?.textContent).toContain(
      'Collectedslot 2026-11-20',
    );
    // Provenance stays one disclosure away, closed by default.
    const details = within(section).getByText('Batch details').closest('details')!;
    expect(details.open).toBe(false);
    expect(within(details).getByText('binance-spot-usdt-liquidity-v1')).toBeTruthy();
    expect(within(details).getByText('Binance Spot public REST')).toBeTruthy();
    expect(within(details).getByText(/rolling, not a UTC calendar day/)).toBeTruthy();
    expect(within(details).getByText(/Passed in this browser before display/)).toBeTruthy();
    const table = within(section).getByRole('table', { name: /Candidates for 2026-11-20/ });
    expect(
      within(table).getByText(
        /Ranks 1–50 of 62 eligible pairs by rolling 24-hour quote volume, every window to 00:33:03 UTC/,
      ),
    ).toBeTruthy();
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['Rank', 'Pair', '24h quote volume (USDT)', 'Classification', 'Asset detail']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(50);
    // Each row is named by its exact pair; rank and the exact-decimal volume follow it.
    expect(within(rows[0]!).getByRole('rowheader').textContent).toMatch(/^ZCT001USDT/);
    const [rank, volume, category] = within(rows[0]!).getAllByRole('cell');
    expect(rank!.textContent).toBe('1');
    expect(volume!.textContent).toBe('60,000,000');
    expect(volume!.title).toBe('60000000.5 USDT, exactly as reported');
    expect(category!.textContent).toBe('Not classified');
    expect(within(rows[15]!).getByRole('rowheader').textContent).toMatch(/^BTCUSDT/);
    expect(within(rows[31]!).getAllByRole('cell')[2]!.textContent).toBe('Tokenized commodity');
    // No prices from the ticker are shown as if they were refreshed evidence.
    expect(within(section).queryByText('1.10')).toBeNull();
    expect(db.reads.every((read) => read.filters.some((f) => f[1] === 'policy_id'))).toBe(true);
  });

  it('opens its disclosures without reading anything', async () => {
    await collect([at(0, 33, 5)]);
    show(at(9));
    const section = await board();
    const reads = db.reads.length;
    for (const summary of within(section).getAllByText(/^(Batch details|Excluded or unranked)/)) {
      const details = summary.closest('details')!;
      fireEvent.click(summary);
      details.open = true;
      fireEvent(details, new Event('toggle'));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.reads).toHaveLength(reads);
  });

  it('tells unloaded market data apart from an unmapped pair', async () => {
    await collect([at(0, 33, 5)]);
    show(at(9), null);
    const section = await board();
    expect(
      within(section).getByText('Live market data is not loaded, so no asset detail is linked.'),
    ).toBeTruthy();
    expect(within(section).queryAllByRole('button', { name: /^Open / })).toHaveLength(0);
    const btc = within(section)
      .getByRole('rowheader', { name: /^BTCUSDT/ })
      .closest('tr')!;
    expect(within(btc).getByText(/Live market data is not loaded/)).toBeTruthy();
    expect(within(btc).queryByText('No Popup asset maps to this exact pair')).toBeNull();
  });

  it('opens Popup’s asset detail only for an exact symbol mapping', async () => {
    await collect([at(0, 33, 5)]);
    const onOpen = show(at(9), [BTC]);
    const section = await board();
    const button = within(section).getByRole('button', { name: 'Open BTC-USD details (BTCUSDT)' });
    expect(within(section).getAllByRole('button', { name: /^Open / })).toHaveLength(1);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(BTC);
    const zct = within(section).getByText('ZCT001USDT').closest('tr');
    expect(within(zct!).getByText('No Popup asset maps to this exact pair')).toBeTruthy();
  });

  it('keeps the wide table in a keyboard-scrollable region', async () => {
    await collect([at(0, 33, 5)]);
    show(at(9));
    const region = await screen.findByRole('region', { name: 'Candidates, scrollable' });
    expect(region.tabIndex).toBe(0);
  });

  it('lists exclusions and unranked pairs by reason', async () => {
    await collect([at(0, 33, 5)]);
    show(at(9));
    const section = await board();
    const details = within(section)
      .getByText(/Excluded or unranked USDT pairs \(3\)/)
      .closest('details');
    expect(within(details!).getByText(/Stablecoin base asset/).textContent).toContain('(1)');
    expect(within(details!).getByText('USDCUSDT', { exact: false })).toBeTruthy();
  });

  it('marks the batch stale exactly at the next slot’s 06:00 UTC deadline', async () => {
    await collect([at(0, 33, 5)]);
    show(at(24 + 6) - 1);
    expect(within(await board()).getByText('Today’s batch not in yet')).toBeTruthy();
    cleanup();
    show(at(24 + 6));
    const section = await board();
    expect(within(section).getByText('Stale')).toBeTruthy();
    expect(within(section).getByRole('note').textContent).toMatch(
      /Older than the daily bound: the next slot’s 06:00 UTC deadline passed/,
    );
  });

  it('never shows yesterday’s batch as current after today’s attempt failed', async () => {
    await collect([at(0, 33, 5), at(24, 33)], { failTickerAt: [1] });
    show(at(24, 40));
    const section = await board();
    expect(within(section).getByText('Today’s attempt failed')).toBeTruthy();
    expect(within(section).queryByText('Current')).toBeNull();
    expect(within(section).getByRole('note').textContent).toMatch(
      /previous slot’s batch: today’s collection failed/,
    );
    // The shown batch's collection time stays apart from the latest attempt's.
    expect(within(section).getByText('2026-11-20')).toBeTruthy();
    expect(within(section).getByText('20 Nov, 00:33 UTC')).toBeTruthy();
    const attempt = within(section).getByText('Failed').closest('div');
    expect(attempt?.textContent).toContain('slot 2026-11-21 · REGION_BLOCKED');
    expect(attempt?.textContent).toContain('3m after the slot');
  });

  it('shows a missed slot and no candidates when nothing was ever collected', async () => {
    await collect([at(6, 5)]);
    show(at(7));
    const section = await board();
    expect(within(section).getByText('No batch to show')).toBeTruthy();
    expect(within(section).getByText('Missed: started after 06:00 UTC')).toBeTruthy();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('refuses a tampered batch and shows nothing in its place', async () => {
    await collect([at(0, 33, 5)]);
    const [row] = db.rows.discovery_batches as { evidence: { result: { members: unknown[] } } }[];
    row!.evidence.result.members.reverse();
    show(at(9));
    const section = await board();
    expect(within(section).getByRole('alert').textContent).toMatch(
      /2026-11-20 batch failed verification: Stored evidence does not match its recorded SHA-256/,
    );
    expect(within(section).getByText('No batch to show')).toBeTruthy();
    expect(within(section).queryByRole('table')).toBeNull();
  });

  it('refuses a re-hashed batch whose members do not re-derive', async () => {
    await collect([at(0, 33, 5)]);
    const [row] = db.rows.discovery_batches as {
      evidence: { result: { members: unknown[] } };
      evidence_sha256: string;
    }[];
    row!.evidence.result.members.reverse();
    row!.evidence_sha256 = await evidenceSha256(row!.evidence);
    show(at(9));
    expect(within(await board()).getByRole('alert').textContent).toMatch(/do not re-derive/);
  });

  it('refuses a forged batch whose stored volume cannot render, and shows no older batch', async () => {
    await collect([at(0, 33, 5), at(24, 33, 5)]);
    const [latest] = db.rows.discovery_batches as {
      evidence: DiscoveryEvidence;
      evidence_sha256: string;
      member_count: number;
      status: string;
    }[];
    // A consistent forgery: result re-derived from the changed input, hash recomputed.
    const { evidence } = latest!;
    evidence.inputs.tickers.find((t) => t.symbol === 'ZCT001USDT')!.quoteVolume = '99999999x';
    evidence.result = selectCandidates(evidence.inputs);
    latest!.member_count = evidence.result.members.length;
    latest!.status = evidence.result.status.toLowerCase();
    latest!.evidence_sha256 = await evidenceSha256(evidence);
    show(at(24, 40));
    const section = await board();
    expect(within(section).getByRole('alert').textContent).toMatch(
      /The 2026-11-21 batch failed verification: .*quote volume/,
    );
    expect(within(section).queryByRole('table')).toBeNull();
    expect(within(section).queryByText(/2026-11-20/)).toBeNull();
    expect(within(section).getByText('No batch to show')).toBeTruthy();
  });

  it('labels a partial batch and an empty one', async () => {
    const market = syntheticMarket({
      volumeOf: (symbol, fallback) => (symbol === 'ZCT001USDT' ? 'bad' : fallback),
    });
    await collect([at(0, 33, 5)], { market });
    show(at(9));
    const section = await board();
    expect(within(section).getByText('Partial')).toBeTruthy();
    expect(
      within(section).getByText(/Partial batch: 1 eligible pair has no valid 24h figure/),
    ).toBeTruthy();
    expect(within(section).getByText('1 eligible without a valid 24h figure')).toBeTruthy();
    cleanup();
    await collect([at(0, 33, 5)], { market: { instruments: [], tickers: () => [] } });
    show(at(9));
    const empty = await board();
    expect(within(empty).getByText(/no USDT pair was eligible/)).toBeTruthy();
    expect(within(empty).queryByRole('table')).toBeNull();
  });

  it('reports a read failure without showing any batch', async () => {
    await collect([at(0, 33, 5)]);
    db.readError = { message: 'synthetic outage' };
    show(at(9));
    // The board retries a failed read once before saying so.
    const alert = await screen.findByRole('alert');
    expect(db.reads.filter((read) => read.table === 'discovery_batches')).toHaveLength(2);
    expect(alert.textContent).toMatch(/Couldn’t read daily batches \(synthetic outage\)/);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('is owner-only during the private beta and reads nothing for anyone else', async () => {
    await collect([at(0, 33, 5)]);
    db.owner = false;
    show(at(9));
    expect(await screen.findByText(/visible only to the configured owner/)).toBeTruthy();
    expect(db.reads).toEqual([]);
  });

  it('says when access could not be checked', async () => {
    db.owner = new Error('synthetic RPC failure');
    show(at(9));
    expect((await screen.findByRole('alert')).textContent).toMatch(/synthetic RPC failure/);
    expect(db.reads).toEqual([]);
  });
});

describe('Research › Daily candidates', () => {
  it('is its own place, shown even while the market universe is loading', () => {
    vi.setSystemTime(at(9));
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ResearchZone
          pending
          failed={false}
          empty={false}
          onPreview={() => undefined}
          scan={<p>scan body</p>}
          markets={<p>markets body</p>}
          alerts={null}
          daily={<p>daily body</p>}
          source="market-data"
          onSource={() => undefined}
          place="daily"
          onPlace={() => undefined}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('tab', { name: 'Daily candidates', selected: true })).toBeTruthy();
    expect(screen.getByText('daily body')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Daily candidates',
      'Model scan (1D)',
      'Markets directory',
    ]);
    // Opening a saved TradingView scan stays under Model scan (1D).
    expect(screen.queryByRole('button', { name: /saved crypto scan/i })).toBeNull();
  });
});
