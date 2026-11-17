import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Labeled synthetic data only: ZCT pairs and invented candles saved by the scan store's own
 * `saveScan`, opened through Research's file input. The Supabase client is replaced below, so no
 * request leaves the test; every other request goes to a stub that counts it.
 */
const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  insertResult: vi.fn(),
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: db.rpc,
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        db.inserts.push({ table, row });
        return { select: () => ({ single: () => db.insertResult() }) };
      },
    }),
  },
}));
const auth = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('@/lib/authStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authStore')>()),
  useAuth: () => ({ user: auth.userId ? { id: auth.userId } : null }),
}));
vi.mock('@/lib/financeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/financeClient')>();
  return { ...actual, checkSavedScanFileAsync: vi.fn(actual.checkSavedScanFileAsync) };
});
vi.mock('@/components/RoboAdvisor', () => ({ RoboAdvisor: () => null }));

import { ResearchZone, type ResearchPlace } from '@/components/Workspace';
import type { MarketsSource } from '@/hooks/useResearchSelection';
import { checkSavedScanFileAsync } from '@/lib/financeClient';
import { SAVED_SCAN_FILE_MAX_BYTES, type SavedScanFileCheck } from '@/lib/savedScanFile';
import { arrayBufferOf, FIXTURE_NOW, savedCryptoSnapshot } from './savedCryptoScanFixture';

const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const check = vi.mocked(checkSavedScanFileAsync);
let fixture: Awaited<ReturnType<typeof savedCryptoSnapshot>>;
let other: Awaited<ReturnType<typeof savedCryptoSnapshot>>;
let requests: string[];

beforeAll(async () => {
  fixture = await savedCryptoSnapshot();
  // The same pairs with one candle moved: another scan, another hash.
  const [first, second] = (await import('./savedCryptoScanFixture')).FIXTURE_INPUTS;
  if (!first?.candles || !second) throw new Error('fixture');
  const moved = { ...first, candles: first.candles.map((c) => ({ ...c, close: c.close * 1.01 })) };
  other = await savedCryptoSnapshot([moved, second]);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW + 3_600_000);
  sessionStorage.clear();
  auth.userId = OWNER;
  db.inserts = [];
  requests = [];
  vi.stubGlobal('fetch', (url: string) => {
    requests.push(String(url));
    return Promise.resolve(new Response(null, { status: 404 }));
  });
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  check.mockClear();
  db.rpc.mockReset();
  db.insertResult.mockReset();
});

/** A chosen file with the bytes a browser would hand over (jsdom's File cannot read itself). */
function fileOf(bytes: Uint8Array, name = 'scan.json', size = bytes.byteLength) {
  const file = new File([], name);
  const read = vi.fn(() => Promise.resolve(arrayBufferOf(bytes)));
  Object.defineProperty(file, 'size', { value: size });
  Object.assign(file, { arrayBuffer: read });
  return { file, read };
}

function Research() {
  const [place, setPlace] = useState<ResearchPlace>('scan');
  const [source, setSource] = useState<MarketsSource>('market-data');
  return (
    <ResearchZone
      pending={false}
      failed={false}
      empty={false}
      onPreview={() => {}}
      scan={<section aria-label="Market scan">The normal scan</section>}
      markets={null}
      alerts={null}
      source={source}
      onSource={setSource}
      place={place}
      onPlace={setPlace}
    />
  );
}

function renderResearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Research />
    </QueryClientProvider>,
  );
}

const fileInput = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  return input;
};
const choose = (file: File) => fireEvent.change(fileInput(), { target: { files: [file] } });
const fileRegion = () => screen.queryByRole('region', { name: 'Saved crypto scan file' });
const marketScan = () => screen.getByRole('region', { name: 'Market scan', hidden: true });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** A check the test answers when it chooses. */
function deferred() {
  let resolve: (value: SavedScanFileCheck) => void = () => {};
  const promise = new Promise<SavedScanFileCheck>((done) => (resolve = done));
  return { promise, resolve };
}

describe('Open saved crypto scan in Research', () => {
  it('states the limit before anything is chosen, and reads no file until one is', () => {
    renderResearch();
    const open = screen.getByRole('button', { name: 'Open saved crypto scan' });
    expect(open).toHaveAccessibleDescription(
      /^One TradingView crypto snapshot \(.*<scan ID>\.json.*, up to 4 MB\), checked in this browser\. Nothing is uploaded or fetched\.$/,
    );
    expect(fileInput()).toHaveAttribute('accept', '.json,application/json');
    expect(fileRegion()).toBeNull();
    expect(check).not.toHaveBeenCalled();
    expect(marketScan()).toBeVisible();
  });

  it('verifies the file, shows the existing review in the scan’s place, and closes back to the scan', async () => {
    renderResearch();
    const before = requests.length;
    choose(fileOf(fixture.bytes, 'snapshot.json').file);
    const region = await waitFor(() => {
      const found = fileRegion();
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(marketScan()).not.toBeVisible();
    expect(screen.queryByText('Dev source')).toBeNull();
    const review = await within(region).findByRole('region', {
      name: 'TradingView development scan',
    });
    expect(region).toHaveTextContent('Historical file you opened, not a live scan: snapshot.json');
    expect(region).toHaveTextContent(`Scan ${fixture.snapshot.scanId}, recorded at commit c0dec0d`);
    expect(region).toHaveTextContent('not that it is authentic: nothing signs it');
    expect(within(region).getByTitle(sha256(fixture.bytes))).toBeInTheDocument();
    expect(review).toHaveTextContent('Opened from a file you chose');
    expect(review).toHaveTextContent(
      'Opened from a file you chose, held in this tab’s memory only',
    );
    expect(review).not.toHaveTextContent('Reloading this page re-reads this import');
    expect(review).toHaveTextContent('No TradingView alert check is recorded with this snapshot.');
    expect(within(review).getByText('Retrieved').nextElementSibling).toHaveTextContent(
      'Not recorded',
    );
    expect(review).toHaveTextContent('model 1.0.0');
    expect(review).toHaveTextContent('tradingview-crypto-daily-v1');
    // Reading and reviewing asked nothing of the network or the database.
    expect(requests.slice(before)).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([]);
    expect(sessionStorage).toHaveLength(0);
    expect(localStorage).toHaveLength(0);

    fireEvent.click(within(region).getByRole('button', { name: 'Close file' }));
    expect(fileRegion()).toBeNull();
    expect(marketScan()).toBeVisible();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open saved crypto scan' }),
    );
  });

  it('refuses an oversized file from its size alone, without reading it', async () => {
    renderResearch();
    const { file, read } = fileOf(new Uint8Array(1), 'huge.json', SAVED_SCAN_FILE_MAX_BYTES + 1);
    choose(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'huge.json is too large to open: 4.0 MB, over the 4 MB limit for one crypto snapshot. Nothing from it is shown, and nothing can be recorded from it.',
    );
    expect(read).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(screen.queryByText('Record experiment (saves to Account)')).toBeNull();
  });

  it('says so when the browser cannot read the chosen file', async () => {
    renderResearch();
    const { file, read } = fileOf(new Uint8Array(1), 'moved.json');
    read.mockRejectedValue(new Error('The file could not be read'));
    choose(file);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'moved.json could not be checked (The file could not be read). Nothing from it is shown.',
    );
    expect(check).not.toHaveBeenCalled();
  });

  it('names a refused file, and a refused replacement never shows the earlier file', async () => {
    renderResearch();
    choose(fileOf(fixture.bytes, 'good.json').file);
    await screen.findByRole('region', { name: 'TradingView development scan' });
    const edited = JSON.parse(fixture.bytes.toString('utf8')) as {
      scan: { results: { rank: number }[] };
    };
    edited.scan.results[0]!.rank = 9;
    choose(fileOf(Buffer.from(JSON.stringify(edited)), 'edited.json').file);
    // At once, before the check answers: the earlier review is gone.
    expect(screen.queryByRole('region', { name: 'TradingView development scan' })).toBeNull();
    expect(fileRegion()).toHaveTextContent('edited.json');
    expect(fileRegion()).not.toHaveTextContent('good.json');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      `edited.json does not reproduce from its own inputs (scan ${fixture.snapshot.scanId}): OUTPUT_MISMATCH.`,
    );
    expect(screen.queryByRole('region', { name: 'TradingView development scan' })).toBeNull();
    expect(screen.queryByText('Record experiment (saves to Account)')).toBeNull();
  });

  it('drops a late answer for a file that was replaced or closed', async () => {
    renderResearch();
    const first = deferred();
    check.mockImplementationOnce(() => first.promise);
    choose(fileOf(fixture.bytes, 'first.json').file);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    choose(fileOf(other.bytes, 'second.json').file);
    const second = await screen.findByRole('region', { name: 'TradingView development scan' });
    expect(fileRegion()).toHaveTextContent('second.json');
    const actual = await vi
      .importActual<typeof import('@/lib/financeClient')>('@/lib/financeClient')
      .then((client) => client.checkSavedScanFileAsync(arrayBufferOf(fixture.bytes)));
    await act(async () => first.resolve(actual));
    expect(fileRegion()).toHaveTextContent('second.json');
    expect(fileRegion()).not.toHaveTextContent('first.json');
    expect(within(fileRegion() as HTMLElement).getByTitle(sha256(other.bytes))).toBeInTheDocument();
    expect(second).toBeInTheDocument();

    const late = deferred();
    check.mockImplementationOnce(() => late.promise);
    choose(fileOf(fixture.bytes, 'third.json').file);
    await waitFor(() => expect(check).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    await act(async () => late.resolve(actual));
    expect(fileRegion()).toBeNull();
    expect(marketScan()).toBeVisible();
  });

  it('starts the review over when another file replaces it: no selection or scenario carries', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    renderResearch();
    choose(fileOf(fixture.bytes, 'a.json').file);
    await screen.findByRole('region', { name: 'TradingView development scan' });
    fireEvent.click(screen.getByRole('button', { name: /^ZCTLONG-USDT, rank/ }));
    const scenario = screen.getByRole('region', { name: 'Manual Spot scenario' });
    fireEvent.change(within(scenario).getByLabelText(/^Available allocation/), {
      target: { value: '777' },
    });
    choose(fileOf(fixture.bytes, 'a.json').file);
    await screen.findByRole('region', { name: 'TradingView development scan' });
    fireEvent.click(screen.getByRole('button', { name: /^ZCTLONG-USDT, rank/ }));
    expect(
      within(screen.getByRole('region', { name: 'Manual Spot scenario' })).getByLabelText(
        /^Available allocation/,
      ),
    ).toHaveValue('');
  });
});

describe('recording from an opened file', () => {
  async function openRecord() {
    renderResearch();
    choose(fileOf(fixture.bytes, 'snapshot.json').file);
    await screen.findByRole('region', { name: 'TradingView development scan' });
    fireEvent.click(screen.getByRole('button', { name: /^ZCTLONG-USDT, rank/ }));
    const section = screen.getByRole('region', { name: 'Manual Spot scenario' });
    fireEvent.click(within(section).getByText('Record experiment (saves to Account)'));
    await waitFor(() => expect(section.querySelector('.spot-record')).not.toBeNull());
    return section;
  }

  it('offers non-owners no form and stores nothing', async () => {
    db.rpc.mockResolvedValue({ data: false, error: null });
    const section = await openRecord();
    expect(await within(section).findByText(/^Recording unavailable/)).toBeInTheDocument();
    expect(db.rpc).toHaveBeenCalledWith('is_binance_spot_owner');
    expect(within(section).queryByLabelText(/^Your decision/)).toBeNull();
    expect(db.inserts).toEqual([]);
  });

  it('asks nothing of a signed-out visitor', async () => {
    auth.userId = null;
    const section = await openRecord();
    expect(section).toHaveTextContent('Sign in to record an experiment.');
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('stores the reviewed file hash, scan, match and the included scenario, once, for the owner', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const section = await openRecord();
    const label = (name: RegExp) => within(section).getByLabelText(name);
    fireEvent.change(label(/^Available allocation/), { target: { value: '100' } });
    fireEvent.change(label(/^Maximum planned loss/), { target: { value: '2' } });
    fireEvent.change(label(/^Hypothetical entry/), { target: { value: '50' } });
    fireEvent.change(label(/^Stop reference/), { target: { value: '45' } });
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.click(
      within(section).getByRole('checkbox', { name: 'Include this scenario in the record' }),
    );
    fireEvent.change(label(/^Your decision/), { target: { value: 'Decided not to buy.' } });
    fireEvent.change(label(/^Account label/), { target: { value: 'main' } });
    fireEvent.click(within(section).getByRole('button', { name: 'Review record' }));
    const review = within(section).getByRole('region', { name: 'Check before recording' });
    expect(review).toHaveTextContent(sha256(fixture.bytes));
    expect(review).toHaveTextContent('Match: this snapshot reproduced offline from its own inputs');
    expect(db.inserts).toEqual([]);
    db.insertResult.mockResolvedValue({
      data: {
        id: 'e0000000-0000-4000-8000-00000000000f',
        recorded_at: '2026-10-28T18:00:00+00:00',
      },
      error: null,
    });
    await act(async () =>
      fireEvent.click(within(section).getByRole('button', { name: 'Confirm and record' })),
    );
    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0]?.row ?? {};
    expect(db.inserts[0]?.table).toBe('spot_experiments');
    expect(row).toMatchObject({
      symbol: 'ZCTLONGUSDT',
      source_scan_id: fixture.snapshot.scanId,
      source_snapshot_sha256: sha256(fixture.bytes),
      source_reproduction: 'match',
      scenario_snapshot: { version: 1, calculationVersion: 'spot-scenario-1' },
    });
    // The record carries copied evidence, never the file or its candles.
    expect(JSON.stringify(row)).not.toContain('"candles"');
    expect(JSON.stringify(row).length).toBeLessThan(fixture.bytes.length / 10);
  });

  it('locks a reviewed record when the file is replaced by another', async () => {
    db.rpc.mockResolvedValue({ data: true, error: null });
    const section = await openRecord();
    await within(section).findByLabelText(/^Your decision/);
    fireEvent.change(within(section).getByLabelText(/^Your decision/), {
      target: { value: 'Decided not to buy.' },
    });
    fireEvent.change(within(section).getByLabelText(/^Account label/), {
      target: { value: 'main' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Review record' }));
    choose(fileOf(other.bytes, 'other.json').file);
    // The old review, its form and its Confirm are gone with the file they were taken from.
    expect(section).not.toBeInTheDocument();
    await screen.findByRole('region', { name: 'TradingView development scan' });
    expect(screen.queryByRole('region', { name: 'Check before recording' })).toBeNull();
    expect(db.inserts).toEqual([]);
  });
});
