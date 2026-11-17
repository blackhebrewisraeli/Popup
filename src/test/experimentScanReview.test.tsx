import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review another saved scan, inside a Manual Spot experiment in Account. Labeled synthetic data
 * only: invented ZCT pairs and candles saved by the scan store's own `saveScan`, invented records,
 * IDs and hashes. The Supabase client is replaced below and every other request goes to a stub
 * that counts it. The file check is Research's own (useSavedScanFile and the finance client);
 * savedScanFileReview.test.tsx and financeWorker.test.ts already cover its refusals one by one.
 */
const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  listResult: vi.fn(),
  listed: [] as string[],
}));
vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    rpc: db.rpc,
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        db.inserts.push({ table, row });
        return { select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) };
      },
      select: () => {
        db.listed.push(table);
        const chain = { eq: () => chain, order: () => chain, limit: () => db.listResult() };
        return chain;
      },
    }),
  },
}));
vi.mock('@/lib/financeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/financeClient')>();
  return { ...actual, checkSavedScanFileAsync: vi.fn(actual.checkSavedScanFileAsync) };
});

import { SpotExperiments } from '@/components/SpotExperiments';
import type { Json } from '@/integrations/supabase/types';
import { checkSavedScanFileAsync } from '@/lib/financeClient';
import type { ScanInput } from '@/lib/marketScanner';
import type { SavedScanFileCheck } from '@/lib/savedScanFile';
import type { CandidateEvidence, SpotExperimentRecord } from '@/lib/spotExperiments';
import {
  arrayBufferOf,
  DAY,
  FIXTURE_INPUTS,
  FIXTURE_NOW,
  fixtureCandles,
  fixturePair,
  savedCryptoSnapshot,
} from './savedCryptoScanFixture';

const OWNER = 'aaaaaaaa-0000-4000-8000-00000000000a';
const check = vi.mocked(checkSavedScanFileAsync);
type Saved = Awaited<ReturnType<typeof savedCryptoSnapshot>>;
let original: Saved;
let sameCandle: Saved;
let later: Saved;
let failures: Saved;
let requests: string[];

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const shift = (input: ScanInput): ScanInput => ({
  ...input,
  candles: (input.candles ?? []).map((c) => ({
    ...c,
    timestamp: c.timestamp + DAY,
    closeTime: c.closeTime + DAY,
  })),
});
const exact = (ticker: string) => {
  const symbol = `BINANCE:${ticker.replace('-', '')}`;
  return { ticker, instrument: symbol, providerSymbol: { requested: symbol, validated: symbol } };
};

beforeAll(async () => {
  original = await savedCryptoSnapshot();
  const [first, second] = FIXTURE_INPUTS;
  if (!first?.candles || !second) throw new Error('fixture');
  // The same pairs and candle days with other closes: another scan of the same candle.
  sameCandle = await savedCryptoSnapshot([
    {
      ...first,
      candles: first.candles.map((c) => ({
        ...c,
        open: c.open * 1.01,
        high: c.high * 1.01,
        low: c.low * 1.01,
        close: c.close * 1.01,
      })),
    },
    second,
  ]);
  later = await savedCryptoSnapshot(FIXTURE_INPUTS.map(shift), {
    evaluationTime: FIXTURE_NOW + DAY,
  });
  failures = await savedCryptoSnapshot([
    ...FIXTURE_INPUTS,
    fixturePair(
      'ZCTSHORT-USDT',
      fixtureCandles(() => 50, 0.01, 20),
    ),
    fixturePair('ZCTSTALE-USDT', fixtureCandles(() => 50, 0.01).slice(0, -4)),
    {
      ...exact('ZCTFAIL-USDT'),
      error: { code: 'FETCH_FAILED', detail: 'Synthetic fetch failure.' },
    },
  ]);
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIXTURE_NOW + 3_600_000);
  db.inserts = [];
  db.listed = [];
  db.rpc.mockResolvedValue({ data: true, error: null });
  requests = [];
  vi.stubGlobal('fetch', (url: string) => {
    requests.push(String(url));
    return Promise.resolve(new Response(null, { status: 404 }));
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  check.mockClear();
  db.rpc.mockReset();
  db.listResult.mockReset();
});

/** A full copy as candidateEvidence words it, ZC LONG and ZC RISK both holding. */
const ENTRY: CandidateEvidence = {
  version: 1,
  instrument: 'BINANCE:ZCTLONGUSDT',
  facts: [
    ['Instrument', 'BINANCE:ZCTLONGUSDT · requested, and named by TradingView’s response'],
    ['Venue', 'Binance Spot, USDT pair'],
    ['Scan', '20261027T170000Z-0000c0de'],
    ['Model · timeframe', '1.0.0 · 1D'],
    ['Evaluated', '27 Oct candle (UTC)'],
    ['Technical rank', '#4 of 25'],
    ['ZC LONG', 'Holds'],
    ['ZC RISK', 'Holds: High volatility (ATR 4.10%)'],
    ['Freshness', 'Latest candle closed 17h 00m ago; no newer UTC day has closed'],
    ['Data quality', 'Evaluated on 199 closed UTC days; scan complete'],
  ],
  rank: 4,
  evaluated: 25,
  long: true,
  risk: true,
  stale: false,
};

const withFact = (name: string, value: string | null): CandidateEvidence => ({
  ...ENTRY,
  facts: ENTRY.facts.flatMap(([key, text]) =>
    key === name ? (value === null ? [] : [[key, value] as [string, string]]) : [[key, text]],
  ),
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function experiment(overrides: Partial<SpotExperimentRecord> = {}): SpotExperimentRecord {
  return {
    id: 'e0000000-0000-4000-8000-000000000001',
    recorded_at: '2026-10-28T17:30:00+00:00',
    account_label: 'main',
    symbol: 'ZCTLONGUSDT',
    source_scan_id: '20261027T170000Z-0000c0de',
    source_snapshot_sha256: 'a1'.repeat(32),
    source_reproduction: 'match',
    source_evidence: ENTRY as unknown as Json,
    decision: 'Bought a small ZCT position.',
    decision_stated_at: null,
    scenario_snapshot: null,
    spot_experiment_entries: [],
    spot_experiment_fills: [],
    ...overrides,
  };
}

/** A chosen file with the bytes a browser would hand over (jsdom's File cannot read itself). */
function fileOf(bytes: Uint8Array, name: string) {
  const file = new File([], name);
  Object.defineProperty(file, 'size', { value: bytes.byteLength });
  Object.assign(file, { arrayBuffer: () => Promise.resolve(arrayBufferOf(bytes)) });
  return file;
}

function wrap(records: SpotExperimentRecord[]) {
  db.listResult.mockResolvedValue({ data: records, error: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SpotExperiments userId={OWNER} />
    </QueryClientProvider>,
  );
}

/** Opens the experiment, then its Review another saved scan disclosure. */
async function openReview(item: HTMLElement) {
  fireEvent.click(within(item).getAllByText(/^ZCT\w+USDT$/)[0] as HTMLElement);
  const review = within(item)
    .getByText('Review another saved scan', { selector: 'summary' })
    .closest('details');
  if (!review) throw new Error('review');
  expect(review).not.toHaveAttribute('open');
  fireEvent.click(within(review).getByText('Review another saved scan'));
  await waitFor(() => expect(review).toHaveAttribute('open'));
  return review;
}

async function review(record = experiment()) {
  wrap([record]);
  const item = (await screen.findByText(record.symbol)).closest('details');
  if (!item) throw new Error('item');
  return { item, review: await openReview(item) };
}

const choose = (scope: HTMLElement, file: File) => {
  const input = scope.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  fireEvent.change(input, { target: { files: [file] } });
};
const comparison = (scope: HTMLElement) =>
  within(scope).queryByRole('region', { name: 'Selected scan comparison' });
const side = (scope: HTMLElement, name: string) => within(scope).getByRole('region', { name });
const fact = (scope: HTMLElement, name: string) =>
  within(scope).getAllByText(name, { selector: 'dt' })[0]?.nextElementSibling?.textContent;

/** Chooses a file that verifies and waits for its pair's evidence. */
async function compare(scope: HTMLElement, saved: Saved, name = 'scan.json') {
  choose(scope, fileOf(saved.bytes, name));
  return within(scope).findByRole('region', { name: 'Selected scan evidence' });
}

function deferred() {
  let resolve: (value: SavedScanFileCheck) => void = () => {};
  const promise = new Promise<SavedScanFileCheck>((done) => (resolve = done));
  return { promise, resolve };
}
const actualCheck = (saved: Saved) =>
  vi
    .importActual<typeof import('@/lib/financeClient')>('@/lib/financeClient')
    .then((client) => client.checkSavedScanFileAsync(arrayBufferOf(saved.bytes)));

describe('Review another saved scan', () => {
  it('is closed and reads nothing until a file is chosen; then shows the exact pair beside the stored copy, both unchanged', async () => {
    const record = experiment();
    deepFreeze(record);
    const stored = JSON.stringify(record);
    const { item, review: scope } = await review(record);
    const reads = { listed: db.listed.length, rpc: db.rpc.mock.calls.length };
    expect(scope).toHaveTextContent(
      'It is a historical file you select by hand, not a live or automatically refreshed assessment.',
    );
    expect(comparison(scope)).toBeNull();
    expect(check).not.toHaveBeenCalled();

    const selected = await compare(scope, later, 'later.json');
    const entry = side(scope, 'Entry evidence, as recorded');
    const region = comparison(scope) as HTMLElement;
    expect(region).toHaveTextContent('Historical file you chose: later.json');
    expect(region).toHaveTextContent(
      `Scan ${later.snapshot.scanId}. It reproduced in this browser from its own inputs, which shows it is internally consistent, not that it is authentic: nothing signs it.`,
    );
    expect(within(region).getByTitle(sha256(later.bytes))).toBeInTheDocument();

    // The stored copy as stored; what it does not keep is named, never filled in.
    for (const [name, value] of ENTRY.facts) {
      if (name !== 'Venue') expect(fact(entry, name)).toBe(value);
    }
    expect(fact(entry, 'Score')).toBe('Not stored in this copy');
    expect(fact(entry, 'Scan evaluated')).toBe('Not stored in this copy');
    expect(fact(entry, 'Freshness judged')).toBe(
      'When the evidence was copied, before this record was stored at 2026-10-28 17:30:00 UTC; the copy keeps no exact time',
    );
    // Long and Risk both hold in the copy, side by side with no precedence.
    expect(fact(entry, 'ZC LONG')).toBe('Holds');
    expect(fact(entry, 'ZC RISK')).toBe('Holds: High volatility (ATR 4.10%)');

    // Only the experiment's exact pair, worded as a copy would be.
    expect(fact(selected, 'Instrument')).toBe(
      'BINANCE:ZCTLONGUSDT · requested, and named by TradingView’s response',
    );
    expect(selected).not.toHaveTextContent('ZCTWAVE');
    expect(fact(selected, 'Scan')).toBe(later.snapshot.scanId);
    expect(fact(selected, 'Evaluated')).toBe('28 Oct candle (UTC)');
    expect(fact(selected, 'Scan evaluated')).toBe('2026-10-29 17:00:00 UTC, the scan’s cutoff');
    expect(fact(selected, 'Score')).toMatch(/^\d+$/);
    expect(fact(selected, 'ZC LONG')).toMatch(/^(Holds|Does not hold)$/);
    expect(fact(selected, 'ZC RISK')).toMatch(/^(Holds: .+|Does not hold)$/);
    expect(fact(selected, 'Technical rank')).toMatch(/^#[12] of 2$/);
    expect(fact(selected, 'Freshness')).toMatch(/^Latest candle closed .* ago/);
    expect(fact(selected, 'Freshness judged')).toBe(
      '2026-10-28 18:00:00 UTC, this browser’s clock, when the file was checked',
    );
    expect(fact(selected, 'Data quality')).toMatch(
      /^Evaluated on \d+ closed UTC days; scan complete$/,
    );

    expect(fact(region, 'This file')).toBe(
      `Another scan, ${later.snapshot.scanId}. The record’s scan is 20261027T170000Z-0000c0de.`,
    );
    expect(fact(region, 'Candle order')).toMatch(
      /^The selected candle is later than the entry candle \(entry 2026-10-27, selected 2026-10-28 \(UTC days\)\)\. Two observations: nothing here says when or whether anything changed between them\./,
    );
    expect(fact(region, 'Model and timeframe')).toBe(
      'Same model and timeframe as the entry evidence (1.0.0 · 1D).',
    );
    expect(fact(region, 'Reading the two')).toMatch(
      /no onset, recovery or alert\. ZC LONG and ZC RISK are separate facts, and both can hold\. Each rank is relative to its own scan’s universe, so the two ranks are not compared\./,
    );
    expect(region).not.toHaveTextContent(/\b(BUY|SELL|HOLD)\b|improv|deteriorat|P&L|profit/);

    // The overview above still shows the stored copy, and nothing was read, written or kept.
    const overview = within(item).getByRole('region', { name: 'Experiment overview' });
    expect(fact(overview, 'ZC RISK')).toBe('Holds: High volatility (ATR 4.10%)');
    expect(JSON.stringify(record)).toBe(stored);
    expect(db.listed).toHaveLength(reads.listed);
    expect(db.rpc).toHaveBeenCalledTimes(reads.rpc);
    expect(db.inserts).toEqual([]);
    expect(requests).toEqual([]);
    expect(localStorage).toHaveLength(0);
    expect(sessionStorage).toHaveLength(0);
    expect(window.location.href).not.toContain(later.snapshot.scanId);
  });

  it('calls the record’s own snapshot the same evidence, never new', async () => {
    const { review: scope } = await review(
      experiment({
        source_snapshot_sha256: sha256(original.bytes),
        source_scan_id: original.snapshot.scanId,
      }),
    );
    await compare(scope, original, 'original.json');
    const region = comparison(scope) as HTMLElement;
    expect(fact(region, 'This file')).toBe(
      'The exact bytes this experiment was recorded from (the SHA-256 matches): the same scan and the same evidence, not new evidence.',
    );
    expect(fact(region, 'Candle order')).toBe(
      'Same candle: this is the snapshot the experiment was recorded from. Not new evidence or a new signal.',
    );
  });

  it('calls another scan of the entry candle the same candle, and an older one earlier', async () => {
    const { review: scope } = await review();
    await compare(scope, sameCandle, 'same.json');
    expect(fact(comparison(scope) as HTMLElement, 'Candle order')).toMatch(
      /^Same candle as the entry evidence \(entry 2026-10-27, selected 2026-10-27 \(UTC days\)\): another scan of it, not new evidence or a new signal\. The copy keeps the entry candle’s day and month only; its year is the latest at or before the record time\.$/,
    );
    cleanup();

    const { review: earlier } = await review(
      experiment({
        recorded_at: '2026-10-29T17:30:00+00:00',
        source_evidence: withFact('Evaluated', '28 Oct candle (UTC)') as unknown as Json,
      }),
    );
    await compare(earlier, original, 'older.json');
    expect(fact(comparison(earlier) as HTMLElement, 'Candle order')).toMatch(
      /^The selected candle is earlier than the entry candle \(entry 2026-10-28, selected 2026-10-27 \(UTC days\)\): older than the evidence the experiment was recorded from, not new evidence\./,
    );
  });

  it('names a missing pair and each failed one, never showing another pair in its place', async () => {
    const cases: [string, string, RegExp][] = [
      ['ZCTGONEUSDT', 'missing', /ZCTGONEUSDT is not in this scan\. No other pair is shown/],
      [
        'ZCTSHORTUSDT',
        'short',
        /ZCTSHORTUSDT was not evaluated in this scan: Short history\. 20 closed daily candles;/,
      ],
      [
        'ZCTSTALEUSDT',
        'stale',
        /ZCTSTALEUSDT was not evaluated in this scan: Stale data\. Latest closed candle closed /,
      ],
      [
        'ZCTFAILUSDT',
        'failed',
        /ZCTFAILUSDT was not evaluated in this scan: Fetch failed\. Synthetic fetch failure\. No evidence for it is shown, and no other pair is shown in its place\./,
      ],
    ];
    for (const [symbol, name, reason] of cases) {
      const { review: scope } = await review(
        experiment({
          symbol,
          source_evidence: { ...ENTRY, instrument: `BINANCE:${symbol}` } as unknown as Json,
        }),
      );
      choose(scope, fileOf(failures.bytes, `${name}.json`));
      const region = await waitFor(() => {
        const found = within(scope).getByRole('region', { name: 'Selected scan evidence' });
        expect(found).toHaveTextContent(reason);
        return found;
      });
      expect(region.querySelector('dl')).toBeNull();
      expect(region).not.toHaveTextContent(/ZCTLONG|ZCTWAVE/);
      expect(fact(comparison(scope) as HTMLElement, 'Candle order')).toBe(
        'Unknown: the pair has no evaluated candle in the selected scan.',
      );
      // The stored copy is still shown as stored.
      expect(fact(side(scope, 'Entry evidence, as recorded'), 'ZC LONG')).toBe('Holds');
      cleanup();
    }
  });

  it('keeps an unreadable copy unknown, and compares model and timeframe only when the copy states them', async () => {
    const { review: unreadable } = await review(
      experiment({ source_evidence: { facts: 'not a list' } }),
    );
    const selected = await compare(unreadable, later);
    expect(side(unreadable, 'Entry evidence, as recorded')).toHaveTextContent(
      'Unknown: the copied evidence is not in a form this view can read, so none of it is shown.',
    );
    expect(fact(selected, 'ZC LONG')).toMatch(/^(Holds|Does not hold)$/);
    const region = comparison(unreadable) as HTMLElement;
    expect(fact(region, 'Candle order')).toMatch(/^Unknown: the stored copy does not give/);
    expect(fact(region, 'Model and timeframe')).toMatch(
      /^Unknown: the stored copy does not establish its model and timeframe/,
    );
    cleanup();

    const { review: other } = await review(
      experiment({
        source_evidence: withFact('Model · timeframe', '0.9.0 · 4H') as unknown as Json,
      }),
    );
    await compare(other, later);
    expect(fact(comparison(other) as HTMLElement, 'Model and timeframe')).toBe(
      'Different: entry 0.9.0 · 4H, selected 1.0.0 · 1D. The two are not comparable as one measurement.',
    );
    cleanup();

    const { review: missing } = await review(
      experiment({ source_evidence: withFact('Model · timeframe', null) as unknown as Json }),
    );
    await compare(missing, later);
    const entry = side(missing, 'Entry evidence, as recorded');
    expect(fact(entry, 'Model · timeframe')).toBe('Unknown: not in this copy');
    expect(fact(comparison(missing) as HTMLElement, 'Model and timeframe')).toMatch(
      /^Unknown: the stored copy does not establish/,
    );
  });

  it('drops the comparison at once when a replacement is chosen, and shows nothing from a refused one', async () => {
    const { review: scope } = await review();
    await compare(scope, later, 'good.json');
    const edited = JSON.parse(later.bytes.toString('utf8')) as {
      scan: { results: { rank: number }[] };
    };
    edited.scan.results[0]!.rank = 9;
    choose(scope, fileOf(Buffer.from(JSON.stringify(edited)), 'edited.json'));
    // Before the check answers, the earlier evidence is gone.
    expect(within(scope).queryByRole('region', { name: 'Selected scan evidence' })).toBeNull();
    expect(comparison(scope)).toHaveTextContent('edited.json');
    expect(comparison(scope)).not.toHaveTextContent('good.json');
    expect(await within(scope).findByRole('alert')).toHaveTextContent(
      'edited.json does not reproduce from its own inputs',
    );
    expect(within(scope).queryByRole('region', { name: 'Selected scan evidence' })).toBeNull();
    expect(within(scope).queryByRole('region', { name: 'Entry evidence, as recorded' })).toBeNull();
  });

  it('ignores a late answer for a closed or replaced file', async () => {
    const { review: scope } = await review();
    const first = deferred();
    check.mockImplementationOnce(() => first.promise);
    choose(scope, fileOf(later.bytes, 'first.json'));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(comparison(scope)).toHaveTextContent('Checking in this browser');
    // Closed before the check answered: the answer restores nothing, and focus returns.
    fireEvent.click(within(scope).getByRole('button', { name: 'Close comparison' }));
    expect(comparison(scope)).toBeNull();
    expect(document.activeElement).toBe(
      within(scope).getByRole('button', { name: 'Choose a saved scan file' }),
    );
    const answer = await actualCheck(later);
    await act(async () => first.resolve(answer));
    expect(comparison(scope)).toBeNull();

    // Replaced while the first check was out: the late answer never replaces the newer file.
    const slow = deferred();
    check.mockImplementationOnce(() => slow.promise);
    choose(scope, fileOf(later.bytes, 'slow.json'));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    const second = await compare(scope, sameCandle, 'second.json');
    await act(async () => slow.resolve(answer));
    expect(comparison(scope)).toHaveTextContent('second.json');
    expect(comparison(scope)).not.toHaveTextContent('slow.json');
    expect(fact(second, 'Scan')).toBe(sameCandle.snapshot.scanId);
  });

  it('clears when its disclosure closes, and stays under the one experiment it was opened in', async () => {
    wrap([
      experiment(),
      experiment({ id: 'e0000000-0000-4000-8000-000000000002', symbol: 'ZCTWAVEUSDT' }),
    ]);
    await screen.findByText('ZCTWAVEUSDT');
    const [first, second] = screen
      .getAllByRole('listitem')
      .map((li) => li.querySelector<HTMLElement>('details.experiment-item'));
    if (!first || !second) throw new Error('items');
    const scope = await openReview(first);
    const other = await openReview(second);
    await compare(scope, later);
    expect(comparison(other)).toBeNull();
    expect(second).not.toHaveTextContent(later.snapshot.scanId);

    fireEvent.click(within(scope).getByText('Review another saved scan'));
    await waitFor(() => expect(scope).not.toHaveAttribute('open'));
    expect(comparison(scope)).toBeNull();
    fireEvent.click(within(scope).getByText('Review another saved scan'));
    await waitFor(() => expect(scope).toHaveAttribute('open'));
    expect(comparison(scope)).toBeNull();
  });
});
