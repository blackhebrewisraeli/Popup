import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Labeled synthetic data only: ZCT pairs, invented candles, IDs, hashes and times. No request
 * leaves the test; the Supabase client is replaced below.
 */
const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  insertResult: vi.fn(),
  listResult: vi.fn(),
  singleResult: vi.fn(),
  listed: [] as { table: string; columns: string; filters: unknown[][] }[],
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
        db.listed.push(read);
        const chain = {
          eq: (...args: unknown[]) => (read.filters.push(['eq', ...args]), chain),
          order: (...args: unknown[]) => (read.filters.push(['order', ...args]), chain),
          limit: (...args: unknown[]) => (read.filters.push(['limit', ...args]), db.listResult()),
          maybeSingle: () => db.singleResult(),
        };
        return chain;
      },
    }),
  },
}));
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authStore')>()),
  useAuth: () => ({ user: auth.userId ? { id: auth.userId } : null }),
}));

import { BinanceSpotBalances } from '@/components/BinanceSpotBalances';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { SpotExperiments } from '@/components/SpotExperiments';
import type { Json } from '@/integrations/supabase/types';
import type { Candle } from '@/lib/binance';
import type { SpotRead } from '@/lib/binanceSpotAccount';
import { evaluateScan, type MarketScan, type ScanInput } from '@/lib/marketScanner';
import {
  checkCloseDraft,
  checkObservationDraft,
  checkDraft,
  checkRuleDraft,
  currentRules,
  experimentRow,
  recordExperimentEntry,
  recordSpotExperiment,
  SPOT_EXPERIMENTS_ANCHOR,
  spotSymbol,
  type CandidateEvidence,
  type ExperimentEntry,
  type LinkedFill,
  type SpotExperimentRecord,
} from '@/lib/spotExperiments';
import {
  parseSavedScanRead,
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
  type TradingViewSavedScan,
} from '@/lib/tradingViewDevScan';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 9, 28);
const NOW = TODAY + 17 * 60 * 60_000;
const SCAN_ID = '20261028T170000Z-0000c0de';
const SHA = 'a1'.repeat(32);
const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const DEV_AUTH = '00000000-0000-4000-8000-000000000001';
const saved: TradingViewSavedScan = {
  repositoryCommit: 'f'.repeat(40),
  legacy: false,
  view: null,
  snapshotSha256: SHA,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  auth.userId = OWNER;
  db.inserts = [];
  db.listed = [];
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === '(min-width: 1024px)',
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.rpc.mockReset();
  db.insertResult.mockReset();
  db.listResult.mockReset();
  db.singleResult.mockReset();
});

function candles(path: (i: number) => number, spread: number, count = 199): Candle[] {
  const first = TODAY - count * DAY;
  return Array.from({ length: count }, (_, i) => {
    const close = path(i);
    return {
      timestamp: first + i * DAY,
      closeTime: first + i * DAY + DAY - 1,
      open: close,
      high: close * (1 + spread),
      low: close * (1 - spread),
      close,
    };
  });
}

const pair = (ticker: string, rows: Candle[]): ScanInput => {
  const symbol = `BINANCE:${ticker.replace('-', '')}`;
  return {
    ticker,
    instrument: symbol,
    providerSymbol: { requested: symbol, validated: symbol },
    candles: rows,
  };
};

const source: TradingViewDevSource = {
  tool: 'get_ohlcv',
  interval: '1D',
  retrieval: { startedAt: '2026-10-28T17:00:00.000Z', completedAt: '2026-10-28T17:02:00.000Z' },
  symbols: { 'ZCTLONG-USDT': 'BINANCE:ZCTLONGUSDT', 'ZCTWAVE-USDT': 'BINANCE:ZCTWAVEUSDT' },
  notice: null,
  selectionRule: 'Labeled synthetic fixture universe.',
  pineAlerts: null,
};

function cryptoScan(): MarketScan {
  return evaluateScan(
    [
      pair(
        'ZCTLONG-USDT',
        candles((i) => 100 * Math.pow(0.995, Math.min(i, 192)), 0.005),
      ),
      pair(
        'ZCTWAVE-USDT',
        candles((i) => 100 + Math.sin(i / 6) * 8, 0.01),
      ),
    ],
    {
      evaluationTime: NOW,
      universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
      cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    },
  );
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Opens Record experiment; a details element announces `toggle` after the click, not during it. */
async function openDisclosure(section: HTMLElement) {
  fireEvent.click(within(section).getByText('Record experiment (saves to Account)'));
  await waitFor(() => expect(section.querySelector('.spot-record')).not.toBeNull());
}

function selectSpotPair(choice: { saved?: TradingViewSavedScan } = { saved }) {
  render(
    wrap(
      <MarketScanSummary
        scan={cryptoScan()}
        completedAt={NOW}
        scanning={false}
        failed={false}
        source={source}
        scanId={SCAN_ID}
        choice={choice}
      />,
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: /^ZCTLONG-USDT, rank/ }));
  return screen.getByRole('region', { name: 'ZCTLONG-USDT evidence' });
}

/** The selected pair's scenario section with Record experiment opened. */
async function openRecord(choice: { saved?: TradingViewSavedScan } = { saved }) {
  selectSpotPair(choice);
  const section = screen.getByRole('region', { name: 'Manual Spot scenario' });
  await openDisclosure(section);
  return section;
}

const field = (section: HTMLElement, label: RegExp) => within(section).getByLabelText(label);

function fillDraft(
  section: HTMLElement,
  values: { decision?: string; label?: string; stated?: string },
) {
  if (values.decision !== undefined) {
    fireEvent.change(field(section, /^Your decision/), { target: { value: values.decision } });
  }
  if (values.label !== undefined) {
    fireEvent.change(field(section, /^Account label/), { target: { value: values.label } });
  }
  if (values.stated !== undefined) {
    fireEvent.change(field(section, /^Stated decision time/), {
      target: { value: values.stated },
    });
  }
}

const reviewButton = (section: HTMLElement) =>
  within(section).getByRole('button', { name: 'Review record' });
const confirmButton = (section: HTMLElement) =>
  within(section).getByRole('button', { name: /^(Confirm and record|Recording…|Recorded)$/ });

function fact(scope: HTMLElement, name: string) {
  return within(scope).getAllByText(name, { selector: 'dt' })[0]?.nextElementSibling?.textContent;
}

/** A promise the test settles when it chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('recording and retrieving a decision to stay out', () => {
  it('recovers a lost save with the same ID and shows the saved evidence in Account', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const research = selectSpotPair();
    const action = within(research).getByText('I reviewed this pair and chose to stay out');
    expect(
      action.compareDocumentPosition(within(research).getByText('Model conditions')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(db.rpc).not.toHaveBeenCalled();
    fireEvent.click(action);
    const reason = await screen.findByLabelText('Why did you choose to stay out?');
    const save = screen.getByRole('button', { name: 'Save no-entry decision' });
    fireEvent.change(reason, { target: { value: '   ' } });
    fireEvent.click(save);
    expect(await screen.findByText('Enter a reason of 1 to 1000 characters.')).toBeVisible();
    expect(db.inserts).toHaveLength(0);

    const note = 'Spread was too wide for my plan.';
    const recorded_at = '2026-10-28T17:03:00.000Z';
    db.insertResult
      .mockRejectedValueOnce(new Error('Reply lost'))
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'Duplicate ID' } });
    fireEvent.change(reason, { target: { value: `  ${note}  ` } });
    fireEvent.click(save);
    const retry = await screen.findByRole('button', { name: 'Retry save' });
    expect(reason).toHaveAttribute('readonly');
    const [first] = db.inserts;
    if (!first) throw new Error('The no-entry decision was not submitted.');
    db.singleResult.mockResolvedValue({ data: { ...first.row, recorded_at }, error: null });
    expect(first).toEqual({
      table: 'spot_no_entry_decisions',
      row: {
        id: expect.any(String),
        reason: note,
        source_evidence: expect.objectContaining({
          instrument: 'BINANCE:ZCTLONGUSDT',
          facts: expect.arrayContaining([['Scan', SCAN_ID]]),
        }),
        source_scan_id: SCAN_ID,
        source_snapshot_sha256: SHA,
        symbol: 'ZCTLONGUSDT',
      },
    });
    fireEvent.click(retry);
    expect(await screen.findByText(/Saved to Journal.*No-entry decisions/)).toBeVisible();
    expect(db.inserts).toEqual([first, first]);
    expect(db.listed[0]?.filters).toEqual([
      ['eq', 'user_id', OWNER],
      ['eq', 'id', first.row['id']],
    ]);

    cleanup();
    db.listResult
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: [{ ...first.row, recorded_at }], error: null });
    render(wrap(<SpotExperiments userId={OWNER} />));
    fireEvent.click(await screen.findByText('No-entry decisions'));
    const list = await screen.findByRole('list', { name: 'Recorded no-entry decisions' });
    fireEvent.click(within(list).getByText('ZCTLONGUSDT'));
    expect(within(list).getByText(note)).toBeVisible();
    expect(within(list).getByText(SCAN_ID)).toBeVisible();
    expect(within(list).getByText(SHA)).toBeVisible();
    expect(within(list).getByText('ZC LONG')).toBeVisible();
    expect(within(list).getByText('2026-10-28 17:03:00 UTC')).toBeVisible();
  });

  it('requires a reproduced saved scan and the configured owner', async () => {
    const published = selectSpotPair({});
    expect(within(published).queryByText('I reviewed this pair and chose to stay out')).toBeNull();

    cleanup();
    db.rpc.mockResolvedValue({ data: false, error: null });
    const savedScan = selectSpotPair();
    fireEvent.click(within(savedScan).getByText('I reviewed this pair and chose to stay out'));
    expect(await within(savedScan).findByText(/Recording unavailable/)).toBeVisible();
    expect(screen.queryByLabelText('Why did you choose to stay out?')).toBeNull();
    expect(db.inserts).toHaveLength(0);
  });
});

describe('the saved snapshot identity', () => {
  it('is required, as 64 lowercase hex digits, on every saved scan read back', () => {
    const view = {
      kind: 'tradingview-dev-scan',
      scanId: SCAN_ID,
      importedAt: '2026-10-28T17:02:00.000Z',
      source: { ...source, retrieval: null, notice: null, selectionRule: null, snapshotOnly: true },
      scan: cryptoScan(),
    };
    const read = (snapshotSha256: unknown) => () =>
      parseSavedScanRead({
        state: 'VERIFIED',
        view: { ...view, saved: { ...saved, snapshotSha256 } },
      });
    expect(read(SHA)()).toMatchObject({ state: 'VERIFIED' });
    for (const bad of [undefined, 'A1'.repeat(32), 'a1'.repeat(31), `${SHA} `]) {
      expect(read(bad)).toThrow('Not a TradingView development scan file.');
    }
  });
});

describe('an experiment draft', () => {
  it('needs a decision and a label the database accepts, and a stated time no later than now', () => {
    expect(checkDraft({ decision: ' \n', accountLabel: 'Main', statedAt: '' }, NOW)).toEqual({
      ok: false,
      errors: {
        decision: 'Describe the decision you made, in your own words.',
        accountLabel:
          'Use 1 to 40 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.',
      },
    });
    for (const label of ['-main', 'a'.repeat(41), 'main account', '']) {
      const check = checkDraft({ decision: 'x', accountLabel: label, statedAt: '' }, NOW);
      expect(check.ok).toBe(false);
    }
    expect(
      checkDraft({ decision: 'x'.repeat(1001), accountLabel: 'main', statedAt: '' }, NOW),
    ).toMatchObject({ ok: false, errors: { decision: 'Use at most 1000 characters.' } });
    expect(
      checkDraft({ decision: 'x', accountLabel: 'main', statedAt: '2026-10-28T17:01' }, NOW),
    ).toMatchObject({ ok: false, errors: { statedAt: expect.stringMatching(/in the future/) } });
    expect(
      checkDraft({ decision: 'x', accountLabel: 'main', statedAt: '2026-02-30T10:00' }, NOW),
    ).toMatchObject({ ok: false, errors: { statedAt: expect.stringMatching(/valid UTC/) } });
    // A datetime-local value is read as UTC, whatever the browser's zone.
    expect(
      checkDraft(
        {
          decision: '  Bought a small ZCT position.  ',
          accountLabel: 'zct_main-1',
          statedAt: '2026-10-28T09:30',
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      decision: 'Bought a small ZCT position.',
      accountLabel: 'zct_main-1',
      statedAt: '2026-10-28T09:30:00.000Z',
    });
  });

  it('becomes a content-only row: never an ID, owner, recorded time, rule or scenario figure', () => {
    const evidence: CandidateEvidence = {
      version: 1,
      instrument: 'BINANCE:ZCTLONGUSDT',
      facts: [['Venue', 'Binance Spot, USDT pair']],
      rank: 1,
      evaluated: 2,
      long: true,
      risk: false,
      stale: false,
    };
    const check = checkDraft(
      { decision: 'Decided not to buy.', accountLabel: 'main', statedAt: '' },
      NOW,
    );
    if (!check.ok) throw new Error('draft');
    expect(experimentRow(check, evidence, SCAN_ID, saved)).toEqual({
      account_label: 'main',
      symbol: 'ZCTLONGUSDT',
      source_scan_id: SCAN_ID,
      source_snapshot_sha256: SHA,
      source_reproduction: 'match',
      source_evidence: evidence,
      decision: 'Decided not to buy.',
      decision_stated_at: null,
    });
    expect(spotSymbol(`BINANCE:${'Z'.repeat(21)}USDT`)).toBeNull();
    expect(
      experimentRow(check, { ...evidence, instrument: 'NASDAQ:AAPL' }, SCAN_ID, saved),
    ).toBeNull();
  });
});

describe('storing an experiment', () => {
  const row = {
    account_label: 'main',
    symbol: 'ZCTLONGUSDT',
    source_scan_id: SCAN_ID,
    source_snapshot_sha256: SHA,
    source_reproduction: 'match',
    source_evidence: {},
    decision: 'x',
    decision_stated_at: null,
  };

  it('reports recorded only with the ID and time the database returned', async () => {
    db.insertResult.mockResolvedValue({
      data: {
        id: 'e0000000-0000-4000-8000-000000000001',
        recorded_at: '2026-10-28T17:00:01.5+00:00',
      },
      error: null,
    });
    expect(await recordSpotExperiment(row)).toEqual({
      state: 'recorded',
      id: 'e0000000-0000-4000-8000-000000000001',
      recordedAt: '2026-10-28T17:00:01.5+00:00',
    });
    expect(db.inserts).toEqual([{ table: 'spot_experiments', row }]);
    db.insertResult.mockResolvedValue({ data: null, error: null });
    expect(await recordSpotExperiment(row)).toMatchObject({ state: 'unknown' });
  });

  it('tells a refusal the database answered from an outcome nobody knows', async () => {
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    expect(await recordSpotExperiment(row)).toEqual({
      state: 'refused',
      message: expect.stringMatching(/^Permission denied: only the configured Binance owner/),
    });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'violates check constraint' },
    });
    expect(await recordSpotExperiment(row)).toMatchObject({ state: 'refused' });
    // supabase-js reports a dropped connection with an empty code.
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'TypeError: Failed to fetch' },
    });
    expect(await recordSpotExperiment(row)).toEqual({
      state: 'unknown',
      message: 'TypeError: Failed to fetch',
    });
    db.insertResult.mockRejectedValue(new Error('aborted'));
    expect(await recordSpotExperiment(row)).toEqual({ state: 'unknown', message: 'aborted' });
  });
});

describe('Record experiment in the Manual Spot scenario', () => {
  it('asks nothing of the database until it is opened, and needs a saved scan', async () => {
    render(
      wrap(
        <MarketScanSummary
          scan={cryptoScan()}
          completedAt={NOW}
          scanning={false}
          failed={false}
          source={source}
          scanId={SCAN_ID}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /^ZCTLONG-USDT, rank/ }));
    expect(screen.getByText('Record experiment (saves to Account)')).toBeInTheDocument();
    expect(db.rpc).not.toHaveBeenCalled();
    const section = screen.getByRole('region', { name: 'Manual Spot scenario' });
    await openDisclosure(section);
    expect(section).toHaveTextContent(
      `Recording needs a saved scan: choose ${SCAN_ID} under Scan shown`,
    );
    expect(db.rpc).not.toHaveBeenCalled();
    expect(within(section).queryByLabelText(/^Your decision/)).not.toBeInTheDocument();
  });

  it('sends nothing for the ?devAuth stub', async () => {
    auth.userId = DEV_AUTH;
    const section = await openRecord();
    expect(section).toHaveTextContent('The ?devAuth preview has no session, so it cannot record');
    expect(within(section).queryByLabelText(/^Your decision/)).not.toBeInTheDocument();
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([]);
  });

  it('sends nothing for a signed-out visitor', async () => {
    auth.userId = null;
    const section = await openRecord();
    expect(section).toHaveTextContent('Sign in to record an experiment.');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('offers no form when the database does not name this sign-in as the owner', async () => {
    db.rpc.mockResolvedValue({ data: false, error: null });
    const section = await openRecord();
    expect(await within(section).findByText(/^Recording unavailable/)).toBeInTheDocument();
    expect(db.rpc).toHaveBeenCalledWith('is_binance_spot_owner');
    expect(within(section).queryByLabelText(/^Your decision/)).not.toBeInTheDocument();
  });

  it('says so when the owner check itself fails', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { code: '', message: 'Failed to fetch' } });
    const section = await openRecord();
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Couldn’t check whether this sign-in may record experiments (Failed to fetch)',
    );
    expect(within(section).queryByLabelText(/^Your decision/)).not.toBeInTheDocument();
  });

  it('checks the draft, shows exactly what will be stored, and stores it once on confirmation', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const section = await openRecord();
    // Scenario inputs, typed first: none of them may reach the record.
    fireEvent.click(within(section).getByText('Plan a hypothetical scenario'));
    fireEvent.change(field(section, /^Available allocation/), { target: { value: '777' } });
    fireEvent.change(field(section, /^Stop reference/), { target: { value: '41.5' } });

    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(reviewButton(section));
    expect(document.activeElement).toBe(field(section, /^Your decision/));
    expect(section).toHaveTextContent('Describe the decision you made, in your own words.');
    expect(db.inserts).toEqual([]);

    fillDraft(section, { decision: 'Bought a small ZCT position.', label: 'main' });
    fireEvent.click(reviewButton(section));
    const review = within(section).getByRole('region', { name: 'Check before recording' });
    expect(document.activeElement).toBe(within(review).getByText('Check before recording'));
    expect(fact(review, 'Pair')).toBe('ZCTLONGUSDT');
    expect(fact(review, 'Account label')).toBe('main');
    expect(fact(review, 'Decision')).toBe('Bought a small ZCT position.');
    expect(fact(review, 'Stated decision time')).toBe('Not stated');
    expect(fact(review, 'Source scan')).toBe(SCAN_ID);
    expect(fact(review, 'Snapshot SHA-256')).toBe(SHA);
    expect(fact(review, 'Reproduction')).toMatch(/^Match/);
    expect(fact(review, 'Authenticity')).toBe('Not established: local snapshots are unsigned');
    expect(fact(review, 'Technical rank')).toMatch(/^#1 of 2/);
    expect(review).toHaveTextContent(
      'No rule is set, so allocation, stop, horizon, target and exit stay Not decided',
    );
    expect(review).not.toHaveTextContent('Retrospective record');
    expect(db.inserts).toEqual([]);

    const answer = deferred<unknown>();
    db.insertResult.mockReturnValue(answer.promise);
    fireEvent.click(confirmButton(section));
    fireEvent.click(confirmButton(section));
    expect(confirmButton(section)).toHaveTextContent('Recording…');
    expect(confirmButton(section)).toHaveAttribute('aria-disabled', 'true');
    expect(within(section).getByRole('button', { name: 'Edit' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(section).not.toHaveTextContent(/Recorded\./);
    expect(db.inserts).toHaveLength(1);
    const stored = db.inserts[0]?.row ?? {};
    expect(Object.keys(stored).sort()).toEqual([
      'account_label',
      'decision',
      'decision_stated_at',
      'source_evidence',
      'source_reproduction',
      'source_scan_id',
      'source_snapshot_sha256',
      'symbol',
    ]);
    expect(JSON.stringify(stored)).not.toMatch(/777|41\.5/);
    expect((stored['source_evidence'] as CandidateEvidence).facts).toContainEqual([
      'Scan',
      SCAN_ID,
    ]);

    await act(async () =>
      answer.resolve({
        data: {
          id: 'e0000000-0000-4000-8000-000000000001',
          recorded_at: '2026-10-28T17:00:01.5+00:00',
        },
        error: null,
      }),
    );
    expect(section).toHaveTextContent(
      'Recorded. The database stored experiment e0000000-0000-4000-8000-000000000001 at 2026-10-28 17:00:01.500 UTC',
    );
    expect(confirmButton(section)).toHaveTextContent('Recorded');
    fireEvent.click(confirmButton(section));
    expect(db.inserts).toHaveLength(1);

    fireEvent.click(within(section).getByRole('button', { name: 'Record another' }));
    expect(field(section, /^Your decision/)).toHaveValue('');
  });

  it('keeps the draft after a refusal and allows another try, never claiming it was stored', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const section = await openRecord();
    await within(section).findByLabelText(/^Your decision/);
    fillDraft(section, { decision: 'Decided not to buy.', label: 'main' });
    fireEvent.click(reviewButton(section));
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'Not recorded. Permission denied: only the configured Binance owner can do this',
    );
    expect(section).not.toHaveTextContent(/Recorded\./);
    expect(confirmButton(section)).not.toHaveAttribute('aria-disabled');
    fireEvent.click(within(section).getByRole('button', { name: 'Edit' }));
    expect(field(section, /^Your decision/)).toHaveValue('Decided not to buy.');
  });

  it('locks Confirm when no answer came back, until the owner reviews again', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const section = await openRecord();
    await within(section).findByLabelText(/^Your decision/);
    fillDraft(section, { decision: 'Decided not to buy.', label: 'main' });
    fireEvent.click(reviewButton(section));
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'Failed to fetch' },
    });
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'No confirmation from the database (Failed to fetch). The experiment may or may not be stored',
    );
    expect(confirmButton(section)).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirmButton(section));
    expect(db.inserts).toHaveLength(1);
    fireEvent.click(within(section).getByRole('button', { name: 'Edit' }));
    fireEvent.click(reviewButton(section));
    expect(confirmButton(section)).not.toHaveAttribute('aria-disabled');
  });

  it('labels a stated decision time as a retrospective record, read as UTC', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const section = await openRecord();
    await within(section).findByLabelText(/^Your decision/);
    fillDraft(section, {
      decision: 'Bought on the 27th.',
      label: 'main',
      stated: '2026-10-27T21:15',
    });
    fireEvent.click(reviewButton(section));
    const review = within(section).getByRole('region', { name: 'Check before recording' });
    expect(fact(review, 'Stated decision time')).toBe('2026-10-27 21:15:00 UTC');
    expect(review).toHaveTextContent('Retrospective record');
    db.insertResult.mockResolvedValue({
      data: {
        id: 'e0000000-0000-4000-8000-000000000002',
        recorded_at: '2026-10-28T17:00:00+00:00',
      },
      error: null,
    });
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(db.inserts[0]?.row['decision_stated_at']).toBe('2026-10-27T21:15:00.000Z');
  });
});

function experiment(overrides: Partial<SpotExperimentRecord> = {}): SpotExperimentRecord {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    recorded_at: '2026-10-28T17:00:01.5+00:00',
    account_label: 'main',
    symbol: 'ZCTLONGUSDT',
    source_scan_id: SCAN_ID,
    source_snapshot_sha256: SHA,
    source_reproduction: 'match',
    source_evidence: {
      version: 1,
      instrument: 'BINANCE:ZCTLONGUSDT',
      facts: [
        ['Technical rank', '#1 of 2'],
        ['Freshness', 'Synthetic freshness note'],
      ],
      rank: 1,
      evaluated: 2,
      long: true,
      risk: false,
      stale: true,
    },
    decision: 'Bought a small ZCT position.',
    decision_stated_at: '2026-10-27T21:15:00+00:00',
    scenario_snapshot: null,
    spot_experiment_entries: [],
    spot_experiment_fills: [],
    ...overrides,
  };
}

const entry = (overrides: Partial<ExperimentEntry>): ExperimentEntry => ({
  id: 'r1',
  experiment_id: 'e0000000-0000-4000-8000-000000000001',
  kind: 'rule',
  observed_in: null,
  rule: 'stop',
  rule_status: 'approved',
  supersedes: null,
  statement: 'Synthetic stop rule',
  stated_at: null,
  recorded_at: '2026-10-28T17:05:00+00:00',
  ...overrides,
});

describe('Manual Spot entry drafts and saves', () => {
  it('checks rule and observation statements and reads their stated times as UTC', () => {
    expect(
      checkRuleDraft(
        { rule: 'stop', status: 'approved', statement: ' ', statedAt: '2026-10-28T18:00' },
        NOW,
      ),
    ).toEqual({
      ok: false,
      errors: {
        statement: 'State the rule in your own words.',
        statedAt: 'This is in the future. A rule cannot be stated after it is recorded.',
      },
    });
    expect(
      checkRuleDraft(
        {
          rule: 'stop',
          status: 'proposed',
          statement: 'Consider a synthetic stop.',
          statedAt: '2026-10-27T21:15',
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      rule: 'stop',
      status: 'proposed',
      statement: 'Consider a synthetic stop.',
      statedAt: '2026-10-27T21:15:00.000Z',
    });
    expect(
      checkObservationDraft(
        {
          observedIn: 'binance_interface',
          statement: 'Synthetic stop appeared open.',
          statedAt: '',
        },
        NOW,
      ),
    ).toEqual({
      ok: false,
      errors: { statedAt: 'State when you observed this, in UTC.' },
    });
    expect(
      checkObservationDraft(
        {
          observedIn: 'elsewhere',
          statement: 'Synthetic note seen elsewhere.',
          statedAt: '2026-10-27T20:05',
        },
        NOW,
      ),
    ).toEqual({
      ok: true,
      observedIn: 'elsewhere',
      statement: 'Synthetic note seen elsewhere.',
      statedAt: '2026-10-27T20:05:00.000Z',
    });
  });

  it('reports a stored entry only from the returned row and separates conflicts, refusals and uncertainty', async () => {
    const row = {
      experiment_id: 'e0000000-0000-4000-8000-000000000001',
      kind: 'rule',
      rule: 'stop',
      rule_status: 'approved',
      supersedes: null,
      observed_in: null,
      statement: 'Synthetic stop',
      stated_at: null,
    };
    db.insertResult.mockResolvedValue({
      data: { ...row, id: 'r1', recorded_at: '2026-10-28T17:01:00+00:00' },
      error: null,
    });
    expect(await recordExperimentEntry(row)).toMatchObject({
      state: 'recorded',
      entry: { id: 'r1' },
    });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate' },
    });
    expect(await recordExperimentEntry(row)).toEqual({
      state: 'conflict',
      message:
        'The rule changed or this reviewed entry was already submitted. Refresh the experiment history before deciding what to do.',
    });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied' },
    });
    expect(await recordExperimentEntry(row)).toMatchObject({ state: 'refused' });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'Failed to fetch' },
    });
    expect(await recordExperimentEntry(row)).toEqual({
      state: 'unknown',
      message: 'Failed to fetch',
    });
  });
});

describe('current rules', () => {
  it('decides a rule only by its current approved entry', () => {
    const rules = currentRules([
      entry({ id: 's1', rule: 'stop', statement: 'first' }),
      entry({ id: 's2', rule: 'stop', supersedes: 's1', statement: 'second' }),
      entry({ id: 't1', rule: 'target', rule_status: 'proposed' }),
      entry({ id: 'h1', rule: 'horizon' }),
      entry({ id: 'h2', rule: 'horizon', rule_status: 'withdrawn', supersedes: 'h1' }),
      entry({ id: 'o1', rule: 'other', statement: 'other one' }),
      entry({ id: 'o2', rule: 'other', statement: 'other two' }),
      entry({ id: 'x1', kind: 'observation', rule: null, rule_status: null }),
    ]);
    expect(rules.named.stop?.statement).toBe('second');
    expect(rules.named.target).toBeNull();
    expect(rules.named.horizon).toBeNull();
    expect(rules.named.allocation_ceiling).toBeNull();
    expect(rules.other.map((rule) => rule.statement)).toEqual(['other one', 'other two']);
  });
});

describe('Manual Spot experiments in Journal', () => {
  const renderList = (userId = OWNER) => render(wrap(<SpotExperiments userId={userId} />));

  it('is loading until the database answers, and sends nothing for the ?devAuth stub', async () => {
    const owner = deferred<unknown>();
    db.rpc.mockReturnValue(owner.promise);
    renderList();
    expect(screen.getByText('Loading experiments…')).toBeInTheDocument();
    await act(async () => owner.resolve({ data: false, error: null }));

    db.rpc.mockClear();
    renderList(DEV_AUTH);
    expect(
      screen.getByText('The ?devAuth preview has no session to read them with.'),
    ).toBeInTheDocument();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('says why nothing is listed for a sign-in the database does not name, and reads no rows', async () => {
    db.rpc.mockResolvedValue({ data: false, error: null });
    renderList();
    expect(
      await screen.findByText(/^Unavailable: the database names no Binance owner/),
    ).toBeInTheDocument();
    expect(db.listed).toEqual([]);
  });

  it('is empty for an owner with no experiments', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [], error: null });
    renderList();
    expect(await screen.findByText(/^No experiments recorded yet/)).toBeInTheDocument();
    expect(db.listed[0]).toMatchObject({
      table: 'spot_experiments',
      filters: [
        ['eq', 'user_id', OWNER],
        ['order', 'recorded_at', { ascending: false }],
        ['order', 'id', { ascending: false }],
        ['limit', 100],
      ],
    });
    expect(db.listed[0]?.columns).toMatch(
      /spot_experiment_entries\(.*\), spot_experiment_fills\(id, experiment_id, recorded_at, .*, coverage_complete\)$/,
    );
  });

  it('names a permission refusal, and any other failure, without showing a list', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied for table spot_experiments' },
    });
    const { unmount } = renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The database refused the read: permission denied (permission denied for table spot_experiments)',
    );
    unmount();
    db.rpc.mockResolvedValue({ data: null, error: { code: '', message: 'Failed to fetch' } });
    renderList();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't load experiments (Failed to fetch). Nothing is shown",
    );
  });

  it('shows the recorded facts, provenance and both times; no rules is Not decided, no fills is No linked fills', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [experiment()], error: null });
    renderList();
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    const summary = within(item).getByText('ZCTLONGUSDT').closest('summary');
    expect(summary).toHaveTextContent('main · recorded 2026-10-28 17:00:01.500 UTC');
    expect(summary).toHaveTextContent('Retrospective');
    expect(summary).toHaveTextContent('Historical scan');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    expect(fact(item, 'Decision')).toBe(
      'Bought a small ZCT position. (stated 2026-10-27 21:15:00 UTC; recorded 2026-10-28 17:00:01.500 UTC)',
    );
    expect(fact(item, 'Stated decision time')).toBe('2026-10-27 21:15:00 UTC, your statement');
    expect(fact(item, 'Recorded')).toBe('2026-10-28 17:00:01.500 UTC, the database’s clock');
    expect(fact(item, 'Scan')).toBe(SCAN_ID);
    expect(fact(item, 'Snapshot SHA-256')).toBe(SHA);
    expect(fact(item, 'Reproduction')).toMatch(/^Match: reproduced offline when recorded/);
    expect(fact(item, 'Authenticity')).toBe('Not established: local snapshots are unsigned');
    expect(fact(item, 'Technical rank')).toBe('#1 of 2');
    for (const rule of ['Allocation ceiling', 'Stop', 'Horizon', 'Target', 'Exit']) {
      expect(fact(item, rule)).toBe('Not decided');
    }
    expect(
      within(item).getByText('Linked fills', { selector: 'h5' }).nextElementSibling,
    ).toHaveTextContent(/^No linked fills$/);
    expect(fact(item, 'Observations')).toBe('None recorded');
    expect(fact(item, 'Close')).toBe('Not closed: no close recorded');
    expect(item).not.toHaveTextContent(/P&L|profit|remaining|position size|order status/i);
  });

  it('shows an approved rule as the owner stated it, and refuses an unreadable evidence copy', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({
      data: [
        experiment({
          decision_stated_at: null,
          source_evidence: { facts: 'not a list' },
          spot_experiment_entries: [entry({ stated_at: '2026-10-28T16:00:00+00:00' })],
        }),
      ],
      error: null,
    });
    renderList();
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    expect(within(item).getByText('ZCTLONGUSDT').closest('summary')).not.toHaveTextContent(
      'Retrospective',
    );
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    expect(fact(item, 'Stated decision time')).toBe('Not stated');
    expect(fact(item, 'Stop')).toBe(
      'Approved — Synthetic stop rule (stated 2026-10-28 16:00:00 UTC; recorded 2026-10-28 17:05:00 UTC)',
    );
    expect(fact(item, 'Target')).toBe('Not decided');
    expect(item).toHaveTextContent('This copy is not in a form this view can read');
  });

  it('distinguishes proposals, approvals, withdrawals and Not decided while preserving rule and observation history', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({
      data: [
        experiment({
          spot_experiment_entries: [
            entry({
              id: 's1',
              rule_status: 'proposed',
              statement: 'Synthetic stop proposal',
              stated_at: '2026-10-27T20:00:00+00:00',
            }),
            entry({
              id: 's2',
              supersedes: 's1',
              statement: 'Synthetic approved stop',
              stated_at: '2026-10-27T21:00:00+00:00',
            }),
            entry({ id: 'h1', rule: 'horizon', statement: 'Synthetic horizon' }),
            entry({
              id: 'h2',
              rule: 'horizon',
              rule_status: 'withdrawn',
              supersedes: 'h1',
              statement: 'Synthetic horizon withdrawn',
            }),
            entry({
              id: 'o1',
              kind: 'observation',
              rule: null,
              rule_status: null,
              observed_in: 'binance_interface',
              supersedes: null,
              statement: 'Synthetic stop appeared open.',
              stated_at: '2026-10-27T22:00:00+00:00',
              recorded_at: '2026-10-28T17:06:00+00:00',
            }),
          ],
        }),
      ],
      error: null,
    });
    renderList();
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    expect(fact(item, 'Stop')).toMatch(/^Approved — Synthetic approved stop/);
    expect(fact(item, 'Horizon')).toMatch(/^Withdrawn — Synthetic horizon withdrawn.*Not decided/);
    expect(fact(item, 'Target')).toBe('Not decided');
    const overview = within(item).getByRole('region', { name: 'Experiment overview' });
    expect(fact(overview, 'Rules')).toBe(
      'Approved: Stop · Not decided: Allocation ceiling, Horizon (withdrawn), Target, Exit · History: 4 entries Approved means you recorded it; Popup does not evaluate, follow or execute it.',
    );
    expect(fact(overview, 'Observations')).toBe('1 recorded');
    const history = within(item).getByRole('list', { name: 'Rule history' });
    expect(history).toHaveTextContent('Proposal — Synthetic stop proposal');
    expect(history).toHaveTextContent('Approved — Synthetic approved stop');
    expect(history).toHaveTextContent('Withdrawn — Synthetic horizon withdrawn');
    const observations = within(item).getByRole('list', { name: 'Dated observations' });
    expect(observations).toHaveTextContent('Binance interface');
    expect(observations).toHaveTextContent('Synthetic stop appeared open.');
    expect(observations).toHaveTextContent('Stated 2026-10-27 22:00:00 UTC');
    expect(observations).toHaveTextContent('Recorded 2026-10-28 17:06:00 UTC');
    expect(observations).toHaveTextContent(
      'This records what was observed then; it does not state what is true now.',
    );
    expect(observations).toHaveTextContent('Retrospective');
  });

  it('reviews a rule, submits it once, and names the current entry it supersedes', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const first = experiment({
      spot_experiment_entries: [entry({ id: 's1', rule_status: 'proposed' })],
    });
    const stored = entry({
      id: 's2',
      rule_status: 'approved',
      supersedes: 's1',
      statement: 'Synthetic approved replacement.',
      stated_at: '2026-10-27T21:15:00.000Z',
      recorded_at: '2026-10-28T17:07:00+00:00',
    });
    db.listResult.mockResolvedValueOnce({ data: [first], error: null }).mockResolvedValueOnce({
      data: [experiment({ spot_experiment_entries: [first.spot_experiment_entries[0]!, stored] })],
      error: null,
    });
    const answer = deferred<unknown>();
    db.insertResult.mockReturnValue(answer.promise);
    renderList();
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    fireEvent.click(within(item).getByText('Add a rule'));
    fireEvent.change(within(item).getByLabelText('Rule'), { target: { value: 'stop' } });
    fireEvent.change(within(item).getByLabelText('Status'), { target: { value: 'approved' } });
    fireEvent.change(within(item).getByLabelText('Rule statement'), {
      target: { value: 'Synthetic approved replacement.' },
    });
    fireEvent.change(within(item).getByLabelText('Rule stated time (UTC, optional)'), {
      target: { value: '2026-10-27T21:15' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review rule' }));
    const review = within(item).getByRole('region', { name: 'Check rule before saving' });
    expect(fact(review, 'Status')).toBe('Approved');
    expect(fact(review, 'Replaces')).toContain('Proposal — Synthetic stop rule');
    expect(fact(review, 'Stated time')).toBe('2026-10-27 21:15:00 UTC');
    const confirm = within(review).getByRole('button', { name: /Confirm and save rule|Saving/ });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(db.inserts).toEqual([
      {
        table: 'spot_experiment_entries',
        row: {
          experiment_id: 'e0000000-0000-4000-8000-000000000001',
          kind: 'rule',
          rule: 'stop',
          rule_status: 'approved',
          supersedes: 's1',
          observed_in: null,
          statement: 'Synthetic approved replacement.',
          stated_at: '2026-10-27T21:15:00.000Z',
        },
      },
    ]);
    await act(async () =>
      answer.resolve({
        data: stored,
        error: null,
      }),
    );
    expect(within(review).getByText(/^Saved\./)).toHaveTextContent('2026-10-28 17:07:00 UTC');
    expect(within(review).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: 'Add another rule' }));
    expect(within(item).getByLabelText('Rule statement')).toHaveValue('');
    expect(within(item).getByLabelText('Rule stated time (UTC, optional)')).toHaveValue('');
    fireEvent.change(within(item).getByLabelText('Rule statement'), {
      target: { value: 'Synthetic next stop proposal.' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review rule' }));
    const nextReview = within(item).getByRole('region', { name: 'Check rule before saving' });
    expect(fact(nextReview, 'Replaces')).toContain('Approved — Synthetic approved replacement.');
  });

  it('keeps an uncertain save locked and reports a failed history refresh without hiding history', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const current = entry({ id: 's1', rule_status: 'proposed' });
    const refresh = deferred<unknown>();
    db.listResult
      .mockResolvedValueOnce({
        data: [experiment({ spot_experiment_entries: [current] })],
        error: null,
      })
      .mockReturnValueOnce(refresh.promise);
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'Synthetic connection ended before confirmation' },
    });
    renderList();
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    fireEvent.click(within(item).getByText('Add a rule'));
    fireEvent.change(within(item).getByLabelText('Rule statement'), {
      target: { value: 'Synthetic uncertain replacement.' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review rule' }));
    const review = within(item).getByRole('region', { name: 'Check rule before saving' });
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and save rule' }));
    expect(await within(review).findByText(/History refresh pending/)).toBeInTheDocument();
    expect(within(review).getByRole('button', { name: 'Confirm and save rule' })).toBeDisabled();
    expect(within(review).queryByText(/history was refreshed/i)).not.toBeInTheDocument();

    await act(async () =>
      refresh.resolve({
        data: null,
        error: { code: '', message: 'Synthetic history read failed' },
      }),
    );
    expect(await within(review).findByText(/History refresh failed/)).toHaveTextContent(
      'The history shown may be stale',
    );
    expect(within(review).getByRole('button', { name: 'Confirm and save rule' })).toBeDisabled();
    expect(within(item).getByRole('list', { name: 'Rule history' })).toHaveTextContent(
      'Synthetic stop rule',
    );
  });

  it('requires an observation time, then reviews where and when without claiming current status', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [experiment()], error: null });
    renderList();
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    fireEvent.click(within(item).getByText('Add an observation'));
    fireEvent.change(within(item).getByLabelText('Observation'), {
      target: { value: 'Synthetic stop appeared open.' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review observation' }));
    expect(within(item).getByText('State when you observed this, in UTC.')).toBeInTheDocument();
    expect(db.inserts).toEqual([]);
    fireEvent.change(within(item).getByLabelText('Observed in'), {
      target: { value: 'binance_interface' },
    });
    fireEvent.change(within(item).getByLabelText('Observed at (UTC)'), {
      target: { value: '2026-10-27T22:00' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review observation' }));
    const review = within(item).getByRole('region', { name: 'Check observation before saving' });
    expect(fact(review, 'Observed in')).toBe('Binance interface');
    expect(fact(review, 'Stated time')).toBe('2026-10-27 22:00:00 UTC');
    expect(review).toHaveTextContent(
      'This records what you observed at that stated time. It never claims the stop or anything else has that status now.',
    );
    expect(review).toHaveTextContent('Retrospective record');
  });

  const reviewObservation = async (statement: string) => {
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    fireEvent.click(within(item).getByText('Add an observation'));
    fireEvent.change(within(item).getByLabelText('Observed in'), {
      target: { value: 'elsewhere' },
    });
    fireEvent.change(within(item).getByLabelText('Observation'), {
      target: { value: statement },
    });
    fireEvent.change(within(item).getByLabelText('Observed at (UTC)'), {
      target: { value: '2026-10-27T22:00' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review observation' }));
    return item;
  };

  it('edits a reviewed observation, allows a retry after a refusal, and Add another starts blank', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [experiment()], error: null });
    renderList();
    const item = await reviewObservation('Synthetic stop appeared open.');
    let review = within(item).getByRole('region', { name: 'Check observation before saving' });
    expect(fact(review, 'Observed in')).toBe('Elsewhere');
    fireEvent.click(within(review).getByRole('button', { name: 'Edit' }));
    expect(within(item).getByLabelText('Observation')).toHaveValue('Synthetic stop appeared open.');
    fireEvent.click(within(item).getByRole('button', { name: 'Review observation' }));
    review = within(item).getByRole('region', { name: 'Check observation before saving' });

    db.insertResult.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'permission denied for table spot_experiment_entries' },
    });
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and save observation' }));
    expect(await within(review).findByRole('alert')).toHaveTextContent(
      /^Not saved\. Permission denied: .* Nothing was stored\.$/,
    );
    const confirm = within(review).getByRole('button', { name: 'Confirm and save observation' });
    expect(confirm).toBeEnabled();

    db.insertResult.mockResolvedValueOnce({
      data: entry({
        id: 'o1',
        kind: 'observation',
        rule: null,
        rule_status: null,
        observed_in: 'elsewhere',
        statement: 'Synthetic stop appeared open.',
        stated_at: '2026-10-27T22:00:00.000Z',
        recorded_at: '2026-10-28T17:08:00+00:00',
      }),
      error: null,
    });
    fireEvent.click(confirm);
    expect(await within(review).findByText(/^Saved\./)).toHaveTextContent(
      'observation at 2026-10-28 17:08:00 UTC',
    );
    expect(db.inserts).toHaveLength(2);
    expect(db.inserts[1]?.row).toMatchObject({ kind: 'observation', observed_in: 'elsewhere' });
    fireEvent.click(within(review).getByRole('button', { name: 'Add another observation' }));
    expect(within(item).getByLabelText('Observation')).toHaveValue('');
    expect(within(item).getByLabelText('Observed at (UTC)')).toHaveValue('');
    expect(within(item).getByLabelText('Observed in')).toHaveValue('binance_interface');
  });

  it('keeps an uncertain observation save locked after its history refresh succeeds', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [experiment()], error: null });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'Synthetic connection ended before confirmation' },
    });
    renderList();
    const item = await reviewObservation('Synthetic uncertain observation.');
    const review = within(item).getByRole('region', { name: 'Check observation before saving' });
    fireEvent.click(within(review).getByRole('button', { name: 'Confirm and save observation' }));
    expect(await within(review).findByText(/History refreshed/)).toHaveTextContent(
      'This observation may or may not be stored.',
    );
    expect(
      within(review).getByRole('button', { name: 'Confirm and save observation' }),
    ).toBeDisabled();
    expect(within(review).getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(db.inserts).toHaveLength(1);
  });
});

describe('arriving from the workspace link to Manual Spot experiments', () => {
  let scrolled: Element[] = [];
  beforeEach(() => {
    scrolled = [];
    // jsdom has no layout, so no scrollIntoView: record what was brought into view instead.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const account = (queries: QueryClient, read: () => Promise<SpotRead>, requested: boolean) => (
    <QueryClientProvider client={queries}>
      <SpotExperiments userId={OWNER} reveal={requested} />
      <BinanceSpotBalances accountContext={OWNER} read={read} />
    </QueryClientProvider>
  );
  const heading = () => screen.queryByRole('heading', { name: 'Manual Spot experiments' });
  const connected: SpotRead = {
    state: 'connected',
    readAt: '2026-10-28T17:00:00.000Z',
    balances: [],
  };

  it('focuses journal history even when Binance cannot be read', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [], error: null });
    const read = vi.fn(async (): Promise<SpotRead> => ({ state: 'unavailable' }));
    render(account(client(), read, true));
    expect(heading()).toHaveFocus();
    expect(scrolled.at(-1)).toBe(heading());
    expect(heading()?.closest('section')).toHaveAttribute('id', SPOT_EXPERIMENTS_ANCHOR);
    await waitFor(() =>
      expect(db.listed.some(({ table }) => table === 'spot_experiments')).toBe(true),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: /^Binance Spot/ })).toBeNull();
  });

  it('takes focus only when the link asks, as on back/forward with the section already shown', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [], error: null });
    const queries = client();
    const read = vi.fn(async () => connected);
    const { rerender } = render(account(queries, read, false));
    await waitFor(() => expect(heading()).not.toBeNull());
    expect(heading()).not.toHaveFocus();
    expect(scrolled).toEqual([]);

    rerender(account(queries, read, true));
    expect(heading()).toHaveFocus();
    expect(scrolled).toEqual([heading()]);
    // Following the link reuses the card's earlier read.
    expect(read).toHaveBeenCalledTimes(1);
  });
});

/** A synthetic linked fill of the default experiment. */
const linkedFill = (overrides: Partial<LinkedFill>): LinkedFill => ({
  id: 'f1',
  experiment_id: 'e0000000-0000-4000-8000-000000000001',
  recorded_at: '2026-10-28T17:03:00+00:00',
  account_label: 'main',
  symbol: 'ZCTLONGUSDT',
  trade_id: '9001',
  order_id: '7001',
  side: 'buy',
  trade_time_ms: Date.UTC(2026, 9, 27, 21, 20),
  quantity: '10.00000000',
  price: '1.00000000',
  quote_quantity: '10.00000000',
  commission: '0.01000000',
  commission_asset: 'ZCTLONG',
  retrieved_at: '2026-10-28T17:02:00+00:00',
  window_start_ms: Date.UTC(2026, 9, 27, 21),
  window_end_ms: Date.UTC(2026, 9, 27, 22),
  coverage_complete: true,
  ...overrides,
});

describe('closing an experiment record', () => {
  const EXPERIMENT_ID = 'e0000000-0000-4000-8000-000000000001';
  const renderList = () => render(wrap(<SpotExperiments userId={OWNER} />));
  const close = (overrides: Partial<ExperimentEntry> = {}) =>
    entry({
      id: 'c1',
      kind: 'close',
      rule: null,
      rule_status: null,
      statement: 'Synthetic close reason.',
      stated_at: '2026-10-28T16:30:00.000Z',
      recorded_at: '2026-10-28T17:10:00+00:00',
      ...overrides,
    });
  const open = async () => {
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    return item;
  };
  const reviewClose = async (reason: string, stated = '') => {
    const item = await open();
    fireEvent.click(within(item).getByText('Close experiment record'));
    fireEvent.change(within(item).getByLabelText('Reason for closing'), {
      target: { value: reason },
    });
    fireEvent.change(within(item).getByLabelText('Close stated time (UTC, optional)'), {
      target: { value: stated },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review close' }));
    return item;
  };
  const confirmClose = (review: HTMLElement) =>
    within(review).getByRole('button', { name: /^(Confirm and save close entry|Saving…)$/ });

  it('needs a reason, takes an optional stated time as UTC, and refuses a future one', () => {
    expect(checkCloseDraft({ statement: '  ', statedAt: '' }, NOW)).toEqual({
      ok: false,
      errors: { statement: 'State why you are closing this record.' },
    });
    expect(checkCloseDraft({ statement: ' Synthetic reason. ', statedAt: '' }, NOW)).toEqual({
      ok: true,
      statement: 'Synthetic reason.',
      statedAt: null,
    });
    expect(
      checkCloseDraft({ statement: 'Synthetic reason.', statedAt: '2026-10-28T16:30' }, NOW),
    ).toEqual({ ok: true, statement: 'Synthetic reason.', statedAt: '2026-10-28T16:30:00.000Z' });
    expect(
      checkCloseDraft({ statement: 'Synthetic reason.', statedAt: '2026-10-28T17:01' }, NOW),
    ).toEqual({
      ok: false,
      errors: { statedAt: 'This is in the future. A close cannot be stated after it is recorded.' },
    });
    expect(checkCloseDraft({ statement: 'x'.repeat(1001), statedAt: 'soon' }, NOW)).toEqual({
      ok: false,
      errors: {
        statement: 'Use at most 1000 characters.',
        statedAt: 'Enter a valid UTC date and time.',
      },
    });
  });

  it('names an existing close when the database refuses a second one', async () => {
    db.insertResult.mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } });
    expect(
      await recordExperimentEntry({
        experiment_id: EXPERIMENT_ID,
        kind: 'close',
        rule: null,
        rule_status: null,
        supersedes: null,
        observed_in: null,
        statement: 'Synthetic close reason.',
        stated_at: null,
      }),
    ).toEqual({
      state: 'conflict',
      message:
        'This experiment already has a close entry: another close was stored first, or this reviewed close was already submitted. Only one is allowed. Refresh the experiment history before deciding what to do.',
    });
  });

  it('reviews the close with a factual summary, explains what it does not do, and stores it once', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const before = experiment({
      spot_experiment_entries: [
        entry({ id: 'r1', rule: 'stop', rule_status: 'approved' }),
        entry({
          id: 'r2',
          rule: 'target',
          rule_status: 'proposed',
          recorded_at: '2026-10-28T17:06:00+00:00',
        }),
        entry({
          id: 'o1',
          kind: 'observation',
          rule: null,
          rule_status: null,
          observed_in: 'elsewhere',
          statement: 'Synthetic observation.',
          stated_at: '2026-10-28T16:00:00.000Z',
        }),
      ],
      spot_experiment_fills: [
        linkedFill({ id: 'f1' }),
        linkedFill({
          id: 'f2',
          trade_id: '9002',
          side: 'sell',
          trade_time_ms: Date.UTC(2026, 9, 27, 21, 40),
        }),
      ],
    });
    const stored = close();
    db.listResult.mockResolvedValueOnce({ data: [before], error: null }).mockResolvedValueOnce({
      data: [{ ...before, spot_experiment_entries: [...before.spot_experiment_entries, stored] }],
      error: null,
    });
    const answer = deferred<unknown>();
    db.insertResult.mockReturnValue(answer.promise);
    renderList();
    const item = await open();
    fireEvent.click(within(item).getByText('Close experiment record'));
    fireEvent.click(within(item).getByRole('button', { name: 'Review close' }));
    expect(within(item).getByText('State why you are closing this record.')).toBeInTheDocument();
    expect(db.inserts).toEqual([]);

    fireEvent.change(within(item).getByLabelText('Reason for closing'), {
      target: { value: '  Synthetic close reason.  ' },
    });
    fireEvent.change(within(item).getByLabelText('Close stated time (UTC, optional)'), {
      target: { value: '2026-10-28T16:30' },
    });
    fireEvent.click(within(item).getByRole('button', { name: 'Review close' }));
    const review = within(item).getByRole('region', { name: 'Check close before saving' });
    expect(
      within(review).getByRole('heading', { name: 'Check close before saving' }),
    ).toHaveFocus();
    expect(fact(review, 'Experiment')).toBe('ZCTLONGUSDT · main');
    expect(fact(review, 'Reason')).toBe('Synthetic close reason.');
    expect(fact(review, 'Stated time')).toBe('2026-10-28 16:30:00 UTC');
    expect(fact(review, 'Recorded time')).toBe('Set by the database when it stores the entry');
    expect(review).toHaveTextContent('Retrospective record');
    expect(review).toHaveTextContent(
      'Closing this record places no order and sends nothing to Binance. It does not show that the Binance position is closed: Popup reads no orders or positions, and linked fills are copies the server did not verify.',
    );
    expect(review).toHaveTextContent(
      'Only one close can be stored, and it cannot be edited or removed. The record stays open to later rules, observations and fills, each marked as recorded after the close.',
    );
    const summary = within(review).getByRole('region', { name: 'What the record holds now' });
    expect(fact(summary, 'Decision')).toBe(
      'Bought a small ZCT position. (stated 2026-10-27 21:15:00 UTC; recorded 2026-10-28 17:00:01.500 UTC)',
    );
    expect(fact(summary, 'Source scan')).toBe(
      `${SCAN_ID} · reproduction: match · authenticity not established`,
    );
    expect(fact(summary, 'Rules')).toBe(
      'Approved: Stop · Not decided: Allocation ceiling, Horizon, Target (proposal), Exit · History: 2 entries',
    );
    expect(fact(summary, 'Linked fills')).toBe(
      '2 linked: 1 buy, 1 sell. Counts only, not a holding: nothing is derived from them.',
    );
    expect(fact(summary, 'Observations')).toBe('1 recorded');
    expect(fact(summary, 'Close')).toBe('Not closed: no close recorded');
    expect(review).not.toHaveTextContent(/remaining|profit|P&L|success|failure|sold out/i);

    fireEvent.click(confirmClose(review));
    fireEvent.keyDown(confirmClose(review), { key: 'Enter' });
    fireEvent.click(confirmClose(review));
    expect(db.inserts).toEqual([
      {
        table: 'spot_experiment_entries',
        row: {
          experiment_id: EXPERIMENT_ID,
          kind: 'close',
          rule: null,
          rule_status: null,
          supersedes: null,
          observed_in: null,
          statement: 'Synthetic close reason.',
          stated_at: '2026-10-28T16:30:00.000Z',
        },
      },
    ]);
    await act(async () => answer.resolve({ data: stored, error: null }));
    expect(within(review).getByText(/^Saved\./)).toHaveTextContent(
      'The database recorded this close entry at 2026-10-28 17:10:00 UTC',
    );
    expect(within(review).queryByRole('button', { name: /Add another/ })).not.toBeInTheDocument();
    expect(within(review).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fact(item, 'Close')).toBe(
        'Synthetic close reason. (stated 2026-10-28 16:30:00 UTC; recorded 2026-10-28 17:10:00 UTC) Ends the record; not evidence of a sale.',
      ),
    );
    expect(db.inserts).toHaveLength(1);
  });

  it('reports a close stored meanwhile as a conflict, refreshes, and offers no second close', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const other = close({
      id: 'c9',
      statement: 'Synthetic close from another tab.',
      stated_at: null,
    });
    db.listResult
      .mockResolvedValueOnce({ data: [experiment()], error: null })
      .mockResolvedValueOnce({
        data: [experiment({ spot_experiment_entries: [other] })],
        error: null,
      });
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    renderList();
    const item = await reviewClose('Synthetic close reason.');
    const review = within(item).getByRole('region', { name: 'Check close before saving' });
    expect(fact(review, 'Stated time')).toBe('Not stated');
    expect(review).not.toHaveTextContent('Retrospective record');
    fireEvent.click(confirmClose(review));
    expect(await within(review).findByRole('alert')).toHaveTextContent(
      'Not saved. This experiment already has a close entry',
    );
    expect(confirmClose(review)).toBeDisabled();
    await waitFor(() =>
      expect(fact(item, 'Close')).toMatch(
        /^Synthetic close from another tab\. \(stated not stated/,
      ),
    );
    fireEvent.click(within(review).getByRole('button', { name: 'Edit' }));
    expect(within(item).queryByText('Close experiment record')).not.toBeInTheDocument();
    expect(within(item).queryByLabelText('Reason for closing')).not.toBeInTheDocument();
    expect(db.inserts).toHaveLength(1);
  });

  it('lets a permission refusal be retried and says nothing was stored', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({ data: [experiment()], error: null });
    db.insertResult.mockResolvedValueOnce({
      data: null,
      error: { code: '42501', message: 'permission denied for table spot_experiment_entries' },
    });
    renderList();
    const item = await reviewClose('Synthetic close reason.');
    const review = within(item).getByRole('region', { name: 'Check close before saving' });
    fireEvent.click(confirmClose(review));
    expect(await within(review).findByRole('alert')).toHaveTextContent(
      /^Not saved\. Permission denied: .* Nothing was stored\.$/,
    );
    expect(confirmClose(review)).toBeEnabled();
    expect(fact(item, 'Close')).toBe('Not closed: no close recorded');
  });

  it('keeps an uncertain close locked while the history refresh is pending and after it', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const refresh = deferred<unknown>();
    db.listResult
      .mockResolvedValueOnce({ data: [experiment()], error: null })
      .mockReturnValueOnce(refresh.promise);
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'Synthetic connection ended before confirmation' },
    });
    renderList();
    const item = await reviewClose('Synthetic close reason.');
    const review = within(item).getByRole('region', { name: 'Check close before saving' });
    fireEvent.click(confirmClose(review));
    expect(await within(review).findByText(/History refresh pending/)).toHaveTextContent(
      'This close entry may or may not be stored.',
    );
    expect(confirmClose(review)).toBeDisabled();
    expect(within(review).getByRole('button', { name: 'Edit' })).toBeDisabled();
    await act(async () =>
      refresh.resolve({
        data: [experiment({ spot_experiment_entries: [close()] })],
        error: null,
      }),
    );
    expect(await within(review).findByText(/History refreshed/)).toBeInTheDocument();
    expect(confirmClose(review)).toBeDisabled();
    expect(within(review).queryByText(/^Saved\./)).not.toBeInTheDocument();
    expect(db.inserts).toHaveLength(1);
  });

  it('shows a stored close after a reload and keeps later evidence visible as after the close', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    db.listResult.mockResolvedValue({
      data: [
        experiment({
          spot_experiment_entries: [
            entry({ id: 'r1', rule: 'stop', recorded_at: '2026-10-28T17:05:00+00:00' }),
            close(),
            entry({
              id: 'r2',
              rule: 'horizon',
              statement: 'Synthetic late horizon.',
              recorded_at: '2026-10-28T17:12:00+00:00',
            }),
            entry({
              id: 'o1',
              kind: 'observation',
              rule: null,
              rule_status: null,
              observed_in: 'binance_interface',
              statement: 'Synthetic late observation.',
              stated_at: '2026-10-28T17:11:00.000Z',
              recorded_at: '2026-10-28T17:15:00+00:00',
            }),
          ],
          spot_experiment_fills: [
            linkedFill({ id: 'f1' }),
            linkedFill({
              id: 'f2',
              trade_id: '9002',
              side: 'sell',
              recorded_at: '2026-10-28T17:20:00+00:00',
            }),
          ],
        }),
      ],
      error: null,
    });
    renderList();
    const item = await open();
    const overview = within(item).getByRole('region', { name: 'Experiment overview' });
    expect(fact(overview, 'Close')).toBe(
      'Synthetic close reason. (stated 2026-10-28 16:30:00 UTC; recorded 2026-10-28 17:10:00 UTC) Ends the record; not evidence of a sale.',
    );
    expect(fact(overview, 'Linked fills')).toBe(
      '2 linked: 1 buy, 1 sell. Counts only, not a holding: nothing is derived from them.',
    );
    expect(within(item).queryByText('Close experiment record')).not.toBeInTheDocument();
    expect(item).toHaveTextContent(
      'Closing doesn’t lock this record: rules, observations and fills added later still appear, each marked as recorded after the close.',
    );
    expect(fact(overview, 'Recorded after the close')).toBe(
      '1 linked fill, 1 rule entry, 1 observation',
    );
    const history = within(item).getByRole('list', { name: 'Rule history' });
    const [early, late] = within(history).getAllByRole('listitem');
    expect(early).not.toHaveTextContent('Recorded after the close');
    expect(late).toHaveTextContent('Synthetic late horizon.');
    expect(late).toHaveTextContent('Recorded after the close');
    expect(within(item).getByRole('list', { name: 'Dated observations' })).toHaveTextContent(
      'Recorded after the close',
    );
    const fills = within(item)
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('experiment-fill'));
    expect(fills[1]).toHaveTextContent('Linked after the close');
    expect(within(item).getByText('Add a rule')).toBeInTheDocument();
    expect(within(item).getByText('Add an observation')).toBeInTheDocument();
    expect(item).not.toHaveTextContent(/remaining|profit|success|failure|sold/i);
  });
});

describe('the experiment overview', () => {
  beforeEach(() => db.rpc.mockResolvedValue({ data: true, error: null }));

  async function openItem(record: SpotExperimentRecord) {
    db.listResult.mockResolvedValue({ data: [record], error: null });
    render(wrap(<SpotExperiments userId={OWNER} />));
    const item = (await screen.findByText(record.symbol)).closest('details');
    if (!item) throw new Error('item');
    return item;
  }

  /** A full copy as candidateEvidence writes it, with ZC LONG and ZC RISK both holding. */
  const BOTH: CandidateEvidence = {
    version: 1,
    instrument: 'BINANCE:ZCTLONGUSDT',
    facts: [
      ['Instrument', 'BINANCE:ZCTLONGUSDT (synthetic)'],
      ['Venue', 'Binance Spot, USDT pair'],
      ['Scan', SCAN_ID],
      ['Model · timeframe', '1.0.0 · 1D'],
      ['Evaluated', '2026-10-27 candle (UTC)'],
      ['Technical rank', '#3 of 25, incomplete scan (24 supported)'],
      ['ZC LONG', 'Holds'],
      ['ZC RISK', 'Holds: high volatility'],
      ['Freshness', 'Stale: synthetic freshness note'],
      ['Data quality', 'Evaluated on 199 closed UTC days; scan incomplete'],
    ],
    rank: 3,
    evaluated: 25,
    long: true,
    risk: true,
    stale: true,
  };

  it('leads with the overview, keeps provenance in one closed disclosure, and reads nothing more when opened', async () => {
    const item = await openItem(experiment({ source_evidence: BOTH }));
    const reads = { listed: db.listed.length, rpc: db.rpc.mock.calls.length };
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    const overview = within(item).getByRole('region', { name: 'Experiment overview' });
    const provenance = within(item)
      .getByText('Provenance and copied evidence', { selector: 'summary' })
      .closest('details');
    if (!provenance) throw new Error('provenance');
    expect(item.querySelector('.experiment-detail')?.firstElementChild).toBe(overview);
    expect(
      overview.compareDocumentPosition(provenance) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(provenance).not.toHaveAttribute('open');

    expect(fact(overview, 'Decision')).toBe(
      'Bought a small ZCT position. (stated 2026-10-27 21:15:00 UTC; recorded 2026-10-28 17:00:01.500 UTC)',
    );
    // Both stored facts, side by side; neither takes precedence or becomes one verdict.
    expect(fact(overview, 'ZC LONG')).toBe('Holds');
    expect(fact(overview, 'ZC RISK')).toBe('Holds: high volatility');
    expect(fact(overview, 'Technical rank')).toBe('#3 of 25, incomplete scan (24 supported)');
    expect(fact(overview, 'Evaluated')).toBe('2026-10-27 candle (UTC)');
    expect(fact(overview, 'Freshness')).toBe('Stale: synthetic freshness note');
    expect(fact(overview, 'Data quality')).toBe(
      'Evaluated on 199 closed UTC days; scan incomplete',
    );
    expect(overview).toHaveTextContent(
      'Copied when you recorded this experiment: historical, not current.',
    );
    expect(fact(overview, 'Rules')).toBe(
      'Not decided: Allocation ceiling, Stop, Horizon, Target, Exit · History: 0 entries Approved means you recorded it; Popup does not evaluate, follow or execute it.',
    );
    expect(fact(overview, 'Linked fills')).toBe('None linked');
    expect(fact(overview, 'Close')).toBe('Not closed: no close recorded');
    expect(overview).not.toHaveTextContent(SCAN_ID);
    expect(overview).not.toHaveTextContent(SHA);
    expect(overview).not.toHaveTextContent(
      /\b(BUY|SELL|HOLD)\b|P&L|profit|remaining|current price/,
    );
    expect(within(item).getByText('ZCTLONGUSDT').closest('summary')).toHaveTextContent(
      'Historical scan',
    );

    fireEvent.click(within(provenance).getByText('Provenance and copied evidence'));
    await waitFor(() => expect(provenance).toHaveAttribute('open'));
    expect(fact(provenance, 'Scan')).toBe(SCAN_ID);
    expect(fact(provenance, 'Snapshot SHA-256')).toBe(SHA);
    expect(fact(provenance, 'Reproduction')).toMatch(/^Match: reproduced offline when recorded/);
    expect(fact(provenance, 'Authenticity')).toBe('Not established: local snapshots are unsigned');
    expect(fact(provenance, 'Account label')).toBe(
      'main (your label; it does not identify a Binance account)',
    );
    for (const [name, value] of BOTH.facts) expect(fact(provenance, name)).toBe(value);

    // The scenario, rules, composers, observations and fills stay in the opened record.
    expect(within(item).getByRole('region', { name: 'Scenario, as recorded' })).toBeInTheDocument();
    expect(within(item).getByText('Add a rule')).toBeInTheDocument();
    expect(within(item).getByText('Add an observation')).toBeInTheDocument();
    expect(within(item).getByText('Dated observations', { selector: 'h5' })).toBeInTheDocument();
    expect(within(item).getByText('Close experiment record')).toBeInTheDocument();
    // Opening the record and its disclosure reads and writes nothing.
    expect(db.listed).toHaveLength(reads.listed);
    expect(db.rpc).toHaveBeenCalledTimes(reads.rpc);
    expect(db.inserts).toEqual([]);
  });

  it('keeps unreadable or missing evidence unknown, and shows a legacy record with no scenario', async () => {
    let item = await openItem(
      experiment({ source_evidence: { facts: 'not a list' }, scenario_snapshot: null }),
    );
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    let overview = within(item).getByRole('region', { name: 'Experiment overview' });
    expect(fact(overview, 'Entry evidence, as recorded')).toBe(
      'Unknown: the copied evidence is not in a form this view can read, so none of it is shown.',
    );
    expect(overview).not.toHaveTextContent(/Does not hold|no risk|HOLD/i);
    expect(within(item).getByRole('region', { name: 'Scenario, as recorded' })).toHaveTextContent(
      'No scenario recorded',
    );
    expect(fact(overview, 'Close')).toBe('Not closed: no close recorded');
    cleanup();

    // A readable copy without the Long and Risk facts: unknown, never "does not hold".
    item = await openItem(experiment());
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    overview = within(item).getByRole('region', { name: 'Experiment overview' });
    expect(fact(overview, 'ZC LONG')).toBe('Unknown: not in this copy');
    expect(fact(overview, 'ZC RISK')).toBe('Unknown: not in this copy');
    expect(fact(overview, 'Technical rank')).toBe('#1 of 2');
    expect(overview).not.toHaveTextContent(/Does not hold/);
  });

  it('counts sells of every unit bought without closing the record or showing a holding', async () => {
    const item = await openItem(
      experiment({
        source_evidence: BOTH,
        spot_experiment_fills: [
          linkedFill({ id: 'f1', quantity: '10.00000000' }),
          linkedFill({
            id: 'f2',
            trade_id: '9002',
            side: 'sell',
            quantity: '10.00000000',
            trade_time_ms: Date.UTC(2026, 9, 27, 21, 40),
          }),
        ],
      }),
    );
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    const overview = within(item).getByRole('region', { name: 'Experiment overview' });
    expect(fact(overview, 'Linked fills')).toBe(
      '2 linked: 1 buy, 1 sell. Counts only, not a holding: nothing is derived from them.',
    );
    expect(fact(overview, 'Close')).toBe('Not closed: no close recorded');
    expect(within(overview).queryByText('Recorded after the close')).toBeNull();
    expect(overview).not.toHaveTextContent(/\b0 (units|remaining)|closed position|sold out|P&L/i);
    // The full fill details stay in the opened record.
    expect(
      within(item)
        .getAllByRole('listitem')
        .filter((li) => li.classList.contains('experiment-fill')),
    ).toHaveLength(2);
  });
});

/** The scenario inputs, by the planner's own labels. */
function fillScenario(
  section: HTMLElement,
  values: Partial<Record<'allocation' | 'maxLoss' | 'entry' | 'stop' | 'fee', string>>,
) {
  const labels = {
    allocation: /^Available allocation/,
    maxLoss: /^Maximum planned loss/,
    entry: /^Hypothetical entry/,
    stop: /^Stop reference/,
    fee: /^Fee assumption per fill/,
  };
  for (const [name, value] of Object.entries(values)) {
    fireEvent.change(field(section, labels[name as keyof typeof labels]), { target: { value } });
  }
}

/** A small-price plan with every digit significant; the fee left unspecified. */
const SMALL_PLAN = { allocation: '15', maxLoss: '1', entry: '0.00000612', stop: '0.0000055' };
const SMALL_SNAPSHOT = {
  version: 1,
  calculationVersion: 'spot-scenario-1',
  inputs: {
    allocation: '15',
    maxLoss: '1',
    entry: '0.00000612',
    stop: '0.0000055',
    feePercent: null,
  },
  figures: {
    quantity: '1,612,903.22580645',
    limitedBy: 'maxLoss',
    notional: '9.87',
    unallocated: '5.13',
    stopDistance: '0.00000062',
    stopDistancePercent: '10.13%',
    lossAtStop: '1.00',
    fees: null,
  },
};

const includeBox = (section: HTMLElement) =>
  within(section).getByRole('checkbox', { name: 'Include this scenario in the record' });
const scenarioRegion = (scope: HTMLElement, name: string) =>
  within(scope).getByRole('region', { name });
/** Every fact a scope shows, name and text, in order. */
const facts = (scope: HTMLElement) =>
  Array.from(scope.querySelectorAll('dt')).map((dt) => [
    dt.textContent,
    dt.nextElementSibling?.textContent,
  ]);
const RECORDED = {
  data: { id: 'e0000000-0000-4000-8000-000000000003', recorded_at: '2026-10-28T17:00:02+00:00' },
  error: null,
};

describe('including the scenario in a recorded experiment', () => {
  beforeEach(() => db.rpc.mockResolvedValue({ data: true, error: null }));

  it('leaves it out by default: a complete scenario is not sent unless the owner includes it', async () => {
    const section = await openRecord();
    fillScenario(section, SMALL_PLAN);
    await within(section).findByLabelText(/^Your decision/);
    expect(includeBox(section)).not.toBeChecked();
    fillDraft(section, { decision: 'Decided not to buy.', label: 'main' });
    fireEvent.click(reviewButton(section));
    const review = scenarioRegion(section, 'Check before recording');
    expect(review).toHaveTextContent('Not recorded: your scenario inputs and figures.');
    expect(within(review).queryByRole('region')).not.toBeInTheDocument();
    db.insertResult.mockResolvedValue(RECORDED);
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.row).not.toHaveProperty('scenario_snapshot');
  });

  it('reviews the exact inputs and figures, sends that copy once, and reads it back the same in Account', async () => {
    const section = await openRecord();
    fillScenario(section, SMALL_PLAN);
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(includeBox(section));
    fillDraft(section, { decision: 'Bought a small ZCT position.', label: 'main' });
    fireEvent.click(reviewButton(section));
    const review = scenarioRegion(section, 'Check before recording');
    const included = scenarioRegion(review, 'Scenario, included as a hypothetical planning record');
    expect(facts(included)).toEqual([
      ['Available allocation', '15 USDT'],
      ['Maximum planned loss', '1 USDT'],
      ['Hypothetical entry', '0.00000612 USDT per ZCTLONG'],
      ['Stop reference', '0.0000055 USDT per ZCTLONG'],
      ['Fee assumption per fill', 'Not specified'],
      ['Calculation', 'spot-scenario-1, in the browser'],
      ['Illustrative quantity', '1,612,903.22580645 ZCTLONG'],
      ['Limited by', 'Planned-loss budget'],
      ['Position notional', '9.87 USDT'],
      ['Unallocated', '5.13 USDT'],
      ['Entry to stop', '0.00000062 USDT per ZCTLONG (10.13% of entry)'],
      ['Planned loss at the stop reference', '1.00 USDT, price move only'],
      ['Assumed fees', 'Not specified: every figure excludes fees'],
    ]);
    expect(included).toHaveTextContent('not a placed stop and not a guaranteed maximum');
    expect(included).toHaveTextContent('A planning record, not a rule');
    expect(included).toHaveTextContent('not a placed order, a verified balance or an actual fill');
    expect(review).toHaveTextContent(
      'Recorded with the scenario above, exactly as shown. No rule is set, so allocation, stop, horizon, target and exit stay Not decided',
    );
    expect(db.inserts).toEqual([]);

    const answer = deferred<unknown>();
    db.insertResult.mockReturnValue(answer.promise);
    fireEvent.click(confirmButton(section));
    fireEvent.click(confirmButton(section));
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0]?.row ?? {};
    expect(row['scenario_snapshot']).toEqual(SMALL_SNAPSHOT);
    expect(Object.isFrozen(row['scenario_snapshot'])).toBe(true);
    expect(JSON.stringify(row['source_evidence'])).not.toMatch(/0\.00000612|1,612,903/);
    await act(async () => answer.resolve(RECORDED));
    expect(section).toHaveTextContent('Recorded. The database stored experiment');
    fireEvent.click(within(section).getByRole('button', { name: 'Record another' }));
    expect(includeBox(section)).not.toBeChecked();

    // A fresh Account read of what was stored shows the reviewed values, fact for fact.
    const reviewed = facts(included);
    cleanup();
    db.listResult.mockResolvedValue({
      data: [
        experiment({
          scenario_snapshot: JSON.parse(JSON.stringify(row['scenario_snapshot'])) as Json,
        }),
      ],
      error: null,
    });
    render(wrap(<SpotExperiments userId={OWNER} />));
    const item = (await screen.findByText('ZCTLONGUSDT')).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText('ZCTLONGUSDT'));
    expect(db.listed[0]?.columns).toMatch(/decision_stated_at, scenario_snapshot, /);
    const shown = scenarioRegion(item, 'Scenario, as recorded');
    expect(facts(shown)).toEqual(reviewed);
    expect(shown).toHaveTextContent(
      'stored with it at 2026-10-28 17:00:01.500 UTC (the database’s clock). Shown as stored.',
    );
  });

  it('keeps an unspecified fee apart from a stated zero', async () => {
    const section = await openRecord();
    fillScenario(section, SMALL_PLAN);
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(includeBox(section));
    fillDraft(section, { decision: 'Bought a small ZCT position.', label: 'main' });
    fireEvent.click(reviewButton(section));
    let included = scenarioRegion(section, 'Scenario, included as a hypothetical planning record');
    expect(fact(included, 'Fee assumption per fill')).toBe('Not specified');
    expect(fact(included, 'Assumed fees')).toBe('Not specified: every figure excludes fees');

    fireEvent.click(within(section).getByRole('button', { name: 'Edit' }));
    fillScenario(section, { fee: '0' });
    fireEvent.click(reviewButton(section));
    included = scenarioRegion(section, 'Scenario, included as a hypothetical planning record');
    expect(fact(included, 'Fee assumption per fill')).toBe('0% of each fill, as stated');
    expect(fact(included, 'Assumed fees')).toBe('0.00 USDT at entry + 0.00 USDT at the stop');
    expect(fact(included, 'Planned loss at the stop reference')).toBe(
      '1.00 USDT with assumed fees (1.00 price move)',
    );
    db.insertResult.mockResolvedValue(RECORDED);
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(db.inserts[0]?.row['scenario_snapshot']).toMatchObject({
      inputs: { feePercent: '0' },
      figures: { fees: { entry: '0.00', exit: '0.00', lossWithFees: '1.00' } },
    });
  });

  it('refuses to include an incomplete or invalid scenario, and still records without one', async () => {
    const section = await openRecord();
    fillScenario(section, { allocation: '15' });
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(includeBox(section));
    fillDraft(section, { decision: 'Decided not to buy.', label: 'main' });
    fireEvent.click(reviewButton(section));
    expect(document.activeElement).toBe(includeBox(section));
    expect(includeBox(section)).toHaveAttribute('aria-invalid', 'true');
    expect(section).toHaveTextContent(
      'Complete Plan a hypothetical scenario with valid inputs first, or leave the scenario out of the record.',
    );
    expect(within(section).queryByRole('region', { name: 'Check before recording' })).toBeNull();

    // Invalid, not just incomplete: a stop above the entry.
    fillScenario(section, { maxLoss: '1', entry: '0.0000055', stop: '0.00000612' });
    fireEvent.click(reviewButton(section));
    expect(within(section).queryByRole('region', { name: 'Check before recording' })).toBeNull();
    expect(db.inserts).toEqual([]);

    fireEvent.click(includeBox(section));
    fireEvent.click(reviewButton(section));
    expect(scenarioRegion(section, 'Check before recording')).toHaveTextContent(
      'Not recorded: your scenario inputs and figures.',
    );
    db.insertResult.mockResolvedValue(RECORDED);
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.row).not.toHaveProperty('scenario_snapshot');
  });

  it('makes a review out of date when the scenario changes, and never sends the old copy', async () => {
    const section = await openRecord();
    fillScenario(section, SMALL_PLAN);
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(includeBox(section));
    fillDraft(section, { decision: 'Bought a small ZCT position.', label: 'main' });
    fireEvent.click(reviewButton(section));
    expect(within(section).queryByRole('alert')).toBeNull();

    fillScenario(section, { stop: '0.000005' });
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'The scenario, or the scan or pair it belongs to, changed after this review. Nothing was sent.',
    );
    expect(confirmButton(section)).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirmButton(section));
    fireEvent.keyDown(confirmButton(section), { key: 'Enter' });
    expect(db.inserts).toEqual([]);

    fireEvent.click(within(section).getByRole('button', { name: 'Edit' }));
    fireEvent.click(reviewButton(section));
    expect(
      fact(
        scenarioRegion(section, 'Scenario, included as a hypothetical planning record'),
        'Stop reference',
      ),
    ).toBe('0.000005 USDT per ZCTLONG');
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'new row violates row-level security policy' },
    });
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(within(section).getByRole('alert')).toHaveTextContent('Not recorded. Permission denied');
    // A refusal leaves Confirm available, for the same reviewed copy only.
    fillScenario(section, { maxLoss: '0.5' });
    expect(confirmButton(section)).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(confirmButton(section));
    fillScenario(section, { maxLoss: '1' });
    expect(confirmButton(section)).not.toHaveAttribute('aria-disabled');
    db.insertResult.mockResolvedValue(RECORDED);
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(db.inserts).toHaveLength(2);
    expect(db.inserts[1]?.row['scenario_snapshot']).toBe(db.inserts[0]?.row['scenario_snapshot']);
    expect(db.inserts[1]?.row['scenario_snapshot']).toMatchObject({
      inputs: { stop: '0.000005', maxLoss: '1' },
    });
  });

  it('locks a record with a scenario when no answer came back, as without one', async () => {
    const section = await openRecord();
    fillScenario(section, SMALL_PLAN);
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(includeBox(section));
    fillDraft(section, { decision: 'Bought a small ZCT position.', label: 'main' });
    fireEvent.click(reviewButton(section));
    db.insertResult.mockResolvedValue({
      data: null,
      error: { code: '', message: 'Failed to fetch' },
    });
    await act(async () => fireEvent.click(confirmButton(section)));
    expect(within(section).getByRole('alert')).toHaveTextContent(
      'No confirmation from the database (Failed to fetch). The experiment may or may not be stored',
    );
    expect(confirmButton(section)).toHaveAttribute('aria-disabled', 'true');
    fillScenario(section, { stop: '0.000005' });
    // Still the uncertain outcome, not a second warning: nothing may be sent either way.
    expect(within(section).getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(confirmButton(section));
    expect(db.inserts).toHaveLength(1);
  });

  it('makes a review out of date when the saved scan file behind it changes', async () => {
    const scan = cryptoScan();
    const page = (choice: { saved: TradingViewSavedScan }) =>
      wrap(
        <MarketScanSummary
          scan={scan}
          completedAt={NOW}
          scanning={false}
          failed={false}
          source={source}
          scanId={SCAN_ID}
          choice={choice}
        />,
      );
    const { rerender } = render(page({ saved }));
    fireEvent.click(screen.getByRole('button', { name: /^ZCTLONG-USDT, rank/ }));
    const section = screen.getByRole('region', { name: 'Manual Spot scenario' });
    await openDisclosure(section);
    await within(section).findByLabelText(/^Your decision/);
    fillDraft(section, { decision: 'Decided not to buy.', label: 'main' });
    fireEvent.click(reviewButton(section));
    expect(within(section).queryByRole('alert')).toBeNull();

    rerender(page({ saved: { ...saved, snapshotSha256: 'b2'.repeat(32) } }));
    const current = screen.getByRole('region', { name: 'Manual Spot scenario' });
    expect(within(current).getByRole('alert')).toHaveTextContent('changed after this review');
    fireEvent.click(confirmButton(current));
    expect(db.inserts).toEqual([]);
    fireEvent.click(within(current).getByRole('button', { name: 'Edit' }));
    fireEvent.click(reviewButton(current));
    expect(fact(current, 'Snapshot SHA-256')).toBe('b2'.repeat(32));
  });
});

describe('a recorded scenario in Account', () => {
  beforeEach(() => db.rpc.mockResolvedValue({ data: true, error: null }));

  async function openItem(record: SpotExperimentRecord) {
    db.listResult.mockResolvedValue({ data: [record], error: null });
    render(wrap(<SpotExperiments userId={OWNER} />));
    const item = (await screen.findByText(record.symbol)).closest('details');
    if (!item) throw new Error('item');
    fireEvent.click(within(item).getByText(record.symbol));
    return item;
  }

  it('says No scenario recorded for an experiment recorded without one, never zeros', async () => {
    const item = await openItem(experiment());
    const shown = scenarioRegion(item, 'Scenario, as recorded');
    expect(shown).toHaveTextContent(/^Scenario, as recordedNo scenario recorded$/);
    expect(fact(item, 'Decision')).toMatch(/^Bought a small ZCT position\. \(stated /);
  });

  it('shows the figures as stored, never worked out again, and decides no rule', async () => {
    // Figures no current arithmetic gives for these inputs: they must still show as stored.
    const item = await openItem(
      experiment({
        scenario_snapshot: {
          ...SMALL_SNAPSHOT,
          inputs: { ...SMALL_SNAPSHOT.inputs, feePercent: '0.1' },
          figures: {
            ...SMALL_SNAPSHOT.figures,
            quantity: '1,234',
            notional: '<0.01',
            fees: { entry: '<0.01', exit: '0.00', lossWithFees: '1.01' },
          },
        },
      }),
    );
    const shown = scenarioRegion(item, 'Scenario, as recorded');
    expect(fact(shown, 'Illustrative quantity')).toBe('1,234 ZCTLONG');
    expect(fact(shown, 'Position notional')).toBe('<0.01 USDT');
    expect(fact(shown, 'Fee assumption per fill')).toBe('0.1% of each fill, as stated');
    expect(fact(shown, 'Assumed fees')).toBe('<0.01 USDT at entry + 0.00 USDT at the stop');
    expect(shown).toHaveTextContent('Binance’s lot size, minimum notional and price filters');
    for (const rule of ['Allocation ceiling', 'Stop', 'Horizon', 'Target', 'Exit']) {
      expect(fact(item, rule)).toBe('Not decided');
    }
    expect(fact(item, 'Rules')).toMatch(/^Not decided: Allocation ceiling, Stop, Horizon/);
    expect(item).not.toHaveTextContent(/P&L|profit|remaining|order status/i);
  });

  it('names an unsupported or unreadable snapshot without hiding the rest of the experiment', async () => {
    let item = await openItem(experiment({ scenario_snapshot: { ...SMALL_SNAPSHOT, version: 2 } }));
    expect(scenarioRegion(item, 'Scenario, as recorded')).toHaveTextContent(
      'A scenario is stored in a format this view does not read (format 2, calculation spot-scenario-1), so none of it is shown.',
    );
    expect(fact(item, 'Decision')).toMatch(/^Bought a small ZCT position\. \(stated /);
    expect(fact(item, 'Technical rank')).toBe('#1 of 2');
    cleanup();
    item = await openItem(
      experiment({ scenario_snapshot: { ...SMALL_SNAPSHOT, inputs: ['15', '1'] } }),
    );
    const shown = scenarioRegion(item, 'Scenario, as recorded');
    expect(shown).toHaveTextContent(
      'A scenario is stored, but not in a form this view can read, so none of it is shown.',
    );
    expect(within(shown).queryByText('Illustrative quantity')).toBeNull();
    expect(fact(item, 'Close')).toBe('Not closed: no close recorded');
  });
});
