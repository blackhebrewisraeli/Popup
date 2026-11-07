import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TradingViewDevScan } from '@/components/TradingViewDevScan';
import type { ScanInput } from '@/lib/marketScanner';
import {
  parseTradingViewDevScan,
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
} from '@/lib/tradingViewDevScan';
import { latestFinalSession, sessionOpen } from '@/lib/usEquityDaily';
import { reproduceScan, saveScan, type ScanSnapshot } from '../../scripts/marketScanStore';
import {
  attachBaseline,
  captureResponses,
  finishRetrieval,
  selectDevScanUniverse,
  startRetrieval,
  TRADINGVIEW_SYMBOLS,
} from '../../scripts/tradingViewImport';
import { bars, EQUITY_NOW, falling, rising, wave } from './usEquityFixtures';

/**
 * The owner's refresh from `tradingview-finish` to Research, end to end, in a
 * throwaway store. Labeled fixtures, not market data: NYSE sessions, synthetic
 * price paths shaped like `get_ohlcv` 1D responses. Nothing was fetched.
 */
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const COMMIT = 'c'.repeat(40);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TICKERS = selectDevScanUniverse();
type Path = (i: number) => number;

function response(symbol: string, path: Path, last: string) {
  return {
    success: true,
    symbol,
    interval: '1D',
    notice: NOTICE,
    bars: bars(path, 200, last).map((bar) => ({
      t: sessionOpen(bar.session) / 1000,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
    })),
  };
}

/** One owner refresh retrieved at `at`: start, capture every ticker but `skip`, finish. */
async function refresh(
  root: string,
  at: number,
  options: {
    paths?: readonly Path[];
    skip?: readonly string[];
    reproduce?: Parameters<typeof finishRetrieval>[0]['reproduce'];
  } = {},
) {
  const store = join(root, 'tradingview');
  const { retrievalId } = await startRetrieval({ store, now: () => at - 2 * 60_000 });
  const last = latestFinalSession(at)!;
  const paths = options.paths ?? [wave, rising, falling];
  const pairs = await Promise.all(
    TICKERS.filter((ticker) => !options.skip?.includes(ticker)).map(async (ticker, i) => {
      const symbol = TRADINGVIEW_SYMBOLS[ticker]!;
      const file = join(root, `${retrievalId}-${ticker}.txt`);
      await writeFile(file, JSON.stringify(response(symbol, paths[i % paths.length]!, last)));
      await utimes(file, new Date(at - 60_000), new Date(at - 60_000));
      return { symbol, file };
    }),
  );
  await captureResponses({ store, retrievalId, pairs, now: () => at });
  const finish = () =>
    finishRetrieval({
      store,
      scanStore: join(root, 'scans'),
      retrievalId,
      repositoryCommit: COMMIT,
      now: () => at + 5 * 60_000,
      ...(options.reproduce ? { reproduce: options.reproduce } : {}),
    });
  const report = await finish();
  return { ...report, scanId: report.scanId!, finish };
}

const viewPath = (root: string) => join(root, 'scans', TRADINGVIEW_DEV_SCAN_FILE);
const readView = async (root: string) =>
  parseTradingViewDevScan(JSON.parse(await readFile(viewPath(root), 'utf8')));

/** Edits one stored snapshot by hand, as tampering or an older model would leave it. */
/** A stored snapshot as raw JSON, so a test can write what the types forbid. */
interface RawSnapshot {
  scan: { modelVersion: string; results: Array<{ model: { signal_score: number } }> };
}

async function edit(root: string, scanId: string, change: (snapshot: RawSnapshot) => void) {
  const path = join(root, 'scans', `${scanId}.json`);
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as RawSnapshot;
  change(snapshot);
  await writeFile(path, JSON.stringify(snapshot));
}

/**
 * Re-records a stored snapshot from changed inputs, as another checkout or instrument
 * map would have written it: hashes and outputs are derived again, so it still
 * reproduces, and its scan ID (evaluation time and universe) is the same.
 */
async function rerecord(
  root: string,
  scanId: string,
  change: (inputs: readonly ScanInput[]) => ScanInput[],
) {
  const path = join(root, 'scans', `${scanId}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8')) as ScanSnapshot;
  const elsewhere = await mkdtemp(join(tmpdir(), 'zerochart-tv-rerecord-'));
  const written = await saveScan({
    inputs: change(stored.inputs),
    evaluationTime: stored.scan.evaluationTime,
    universeSource: stored.scan.universe.source,
    equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    repositoryCommit: stored.repositoryCommit,
    store: elsewhere,
    completedAt: Date.parse(stored.completedAt),
  });
  expect(written.snapshot.scanId).toBe(scanId);
  await writeFile(path, await readFile(written.path, 'utf8'));
}

/** Research → TradingView import, served the view file exactly as the dev route would. */
async function research(root: string) {
  const body = await readFile(viewPath(root), 'utf8');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body)),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TradingViewDevScan />
    </QueryClientProvider>,
  );
  return screen.findByRole('region', { name: /Changes since previous scan/ });
}

const store = () => mkdtemp(join(tmpdir(), 'zerochart-tv-finish-'));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('tradingview-finish to Research', { timeout: 60_000 }, () => {
  it('compares with the most recent earlier session, passing over same-session revisions', async () => {
    const root = await store();
    await refresh(root, EQUITY_NOW - 2 * DAY); // 23 Oct: older, never reported
    const previous = await refresh(root, EQUITY_NOW - DAY); // 26 Oct
    const revision = await refresh(root, EQUITY_NOW - 2 * HOUR, { paths: [falling] }); // 27 Oct
    // A Market data snapshot is never a candidate, so it is not even listed.
    await saveScan({
      inputs: [
        {
          ticker: 'BTC-USD',
          instrument: 'BINANCE:BTCUSDT',
          error: { code: 'FETCH_FAILED', detail: 'Labeled fixture.' },
        },
      ],
      evaluationTime: EQUITY_NOW - HOUR,
      universeSource: 'assets_status',
      equityProvider: null,
      repositoryCommit: COMMIT,
      store: join(root, 'scans'),
      completedAt: EQUITY_NOW - HOUR,
    });
    const displayed = await refresh(root, EQUITY_NOW); // 27 Oct again

    expect(displayed).toMatchObject({
      outcome: 'COMPLETE',
      reproduction: 'MATCH',
      viewStatus: 'PUBLISHED',
      baseline: {
        status: 'COMPARED',
        chosenBy: 'tradingview-finish',
        before: { scanId: previous.scanId, session: '2026-10-26' },
        after: { scanId: displayed.scanId, session: '2026-10-27' },
        gap: { kind: 'NEXT' },
        compared: 50,
        reason: null,
      },
    });
    expect(displayed.baseline?.skipped).toEqual([
      {
        scanId: revision.scanId,
        reason: expect.stringMatching(/^a revision of the displayed scan's session \(2026-10-27\)/),
      },
    ]);
    // The revision itself, finished earlier, also compared with 26 Oct.
    expect(revision.baseline).toMatchObject({ before: { scanId: previous.scanId }, skipped: [] });

    const changes = await research(root);
    expect(changes).toHaveTextContent(`Baseline${previous.scanId}26 Oct session (New York)`);
    expect(changes).toHaveTextContent(`Displayed${displayed.scanId}27 Oct session (New York)`);
    expect(changes).toHaveTextContent('Chosen by tradingview-finish');
    expect(changes).toHaveTextContent(`Passed over: ${revision.scanId} (a revision`);
    expect(changes).toHaveTextContent('Consecutive sessions.');

    // A later re-retrieval of the same session is a revision too: 26 Oct stays the baseline.
    const later = await refresh(root, EQUITY_NOW + 2 * HOUR, { paths: [rising] });
    expect(later.baseline).toMatchObject({ before: { scanId: previous.scanId } });
    expect(later.baseline?.skipped.map(({ scanId }) => scanId)).toEqual([
      displayed.scanId,
      revision.scanId,
    ]);
  });

  it('keeps partial coverage apart instead of reading missing data as a change', async () => {
    const root = await store();
    const [onlyNow, onlyBefore] = [TICKERS[3]!, TICKERS[7]!];
    const previous = await refresh(root, EQUITY_NOW - DAY, { skip: [onlyNow] });
    const displayed = await refresh(root, EQUITY_NOW, { skip: [onlyBefore] });
    expect(displayed).toMatchObject({ outcome: 'PARTIAL', evaluated: 49, reproduction: 'MATCH' });
    const summary = displayed.baseline!;
    expect(summary).toMatchObject({
      status: 'COMPARED',
      before: { scanId: previous.scanId, evaluated: 49, status: 'PARTIAL' },
      compared: 48,
      onlyAfter: [onlyNow],
      onlyBefore: [onlyBefore],
      neither: [],
    });
    if (summary.status !== 'COMPARED') throw new Error('unreachable');
    // Neither unevaluated asset is counted as a setup that appeared or cleared.
    for (const counts of [summary.long, summary.risk]) {
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(48);
    }
    expect(summary.changed.map(({ ticker }) => ticker)).not.toContain(onlyNow);
    expect(summary.changed.map(({ ticker }) => ticker)).not.toContain(onlyBefore);

    const changes = await research(root);
    expect(changes).toHaveTextContent(
      `Evaluated only in the displayed scan, so there is no earlier reading: ${onlyNow}.`,
    );
    expect(changes).toHaveTextContent(
      `Not evaluated in the displayed scan, so their earlier setups are neither confirmed nor cleared: ${onlyBefore}.`,
    );
  });

  it('passes over an incompatible or tampered import and says why', async () => {
    const root = await store();
    const oldest = await refresh(root, EQUITY_NOW - 2 * DAY); // 23 Oct
    const tampered = await refresh(root, EQUITY_NOW - DAY); // 26 Oct
    const older = await refresh(root, EQUITY_NOW - DAY + HOUR); // 26 Oct, later revision
    await edit(root, tampered.scanId, (snapshot) => {
      snapshot.scan.results[0]!.model.signal_score += 1;
    });
    await edit(root, older.scanId, (snapshot) => {
      snapshot.scan.modelVersion = '0.9.0';
    });
    const displayed = await refresh(root, EQUITY_NOW);
    expect(displayed.baseline).toMatchObject({
      status: 'COMPARED',
      chosenBy: 'tradingview-finish',
      before: { scanId: oldest.scanId, session: '2026-10-23' },
      gap: { kind: 'GAP', skipped: ['2026-10-26'] },
      skipped: [
        { scanId: older.scanId, reason: 'not comparable: Model 0.9.0 → 1.0.0' },
        { scanId: tampered.scanId, reason: 'does not reproduce (OUTPUT_MISMATCH)' },
      ],
    });

    const changes = await research(root);
    expect(changes).toHaveTextContent(`Baseline${oldest.scanId}23 Oct session`);
    expect(changes).toHaveTextContent(
      `Passed over: ${older.scanId} (not comparable: Model 0.9.0 → 1.0.0); ${tampered.scanId} (does not reproduce (OUTPUT_MISMATCH)).`,
    );
    expect(changes).toHaveTextContent('1 session between them (26 Oct) was never evaluated');
  });

  it('compares only on the same exact symbols, whether the baseline is chosen or named', async () => {
    const root = await store();
    const scans = join(root, 'scans');
    const oldest = await refresh(root, EQUITY_NOW - 2 * DAY); // 23 Oct, exact symbols recorded
    const legacy = await refresh(root, EQUITY_NOW - DAY); // 26 Oct
    const relisted = await refresh(root, EQUITY_NOW - DAY + HOUR); // 26 Oct, later revision
    // As written before exact symbols were kept: the same evidence without them.
    await rerecord(root, legacy.scanId, (inputs) =>
      inputs.map(({ providerSymbol: _recorded, ...input }) => input),
    );
    // As if the instrument map had named another listing of AAPL then.
    await rerecord(root, relisted.scanId, (inputs) =>
      inputs.map((input) =>
        input.ticker === 'AAPL'
          ? { ...input, providerSymbol: { requested: 'NYSE:AAPL', validated: 'NYSE:AAPL' } }
          : input,
      ),
    );
    // Both are consistent evidence: they are passed over for identity, not for tampering.
    for (const { scanId } of [legacy, relisted]) {
      expect(await reproduceScan(scanId, scans)).toEqual({ status: 'MATCH', scanId });
    }
    const listing = 'TradingView symbol AAPL NYSE:AAPL → AAPL NASDAQ:AAPL';
    const unrecorded =
      'Exact symbol Not recorded or not confirmed for any of the 50 evaluated in both → Recorded and confirmed';

    const displayed = await refresh(root, EQUITY_NOW);
    expect(displayed.baseline).toMatchObject({
      status: 'COMPARED',
      chosenBy: 'tradingview-finish',
      before: { scanId: oldest.scanId, session: '2026-10-23' },
      skipped: [
        { scanId: relisted.scanId, reason: `not comparable: ${listing}` },
        { scanId: legacy.scanId, reason: `not comparable: ${unrecorded}` },
      ],
    });
    let changes = await research(root);
    expect(changes).toHaveTextContent(`Baseline${oldest.scanId}23 Oct session`);
    expect(changes).toHaveTextContent(
      `Passed over: ${relisted.scanId} (not comparable: ${listing})`,
    );
    cleanup();

    // The owner names the relisted import: attached only to say why nothing is compared.
    const named = await attachBaseline({ store: scans, baselineId: relisted.scanId });
    expect(named.comparison).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [
        { field: 'TradingView symbol', before: 'AAPL NYSE:AAPL', after: 'AAPL NASDAQ:AAPL' },
      ],
    });
    expect((await readView(root)).baseline).toMatchObject({
      scanId: relisted.scanId,
      chosenBy: 'tradingview-baseline',
    });
    changes = await research(root);
    expect(changes).toHaveTextContent('Not comparable');
    expect(
      within(changes).getByRole('row', {
        name: 'TradingView symbol AAPL NYSE:AAPL AAPL NASDAQ:AAPL',
      }),
    ).toBeInTheDocument();
    expect(within(changes).queryByRole('list', { name: 'Setups that changed' })).toBeNull();
    cleanup();

    // A legacy baseline is refused the same way, never matched up through today's map.
    const old = await attachBaseline({ store: scans, baselineId: legacy.scanId });
    expect(old.comparison).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [{ field: 'Exact symbol' }],
    });
    // And a baseline on the same exact symbols is compared.
    const same = await attachBaseline({ store: scans, baselineId: oldest.scanId });
    expect(same.comparison).toMatchObject({
      status: 'COMPARED',
      before: { scanId: oldest.scanId },
    });
  });

  it('shows the verified scan with the reason when there is no usable baseline', async () => {
    const root = await store();
    const revision = await refresh(root, EQUITY_NOW - 2 * HOUR);
    expect(revision.baseline).toEqual({
      status: 'NO_BASELINE',
      chosenBy: null,
      reason: 'the scan store holds no other TradingView import',
      skipped: [],
    });
    const displayed = await refresh(root, EQUITY_NOW, { paths: [falling] });
    expect(displayed).toMatchObject({ outcome: 'COMPLETE', viewStatus: 'PUBLISHED' });
    expect(displayed.baseline).toMatchObject({
      status: 'NO_BASELINE',
      reason: 'no TradingView import of an earlier session is comparable and reproduces',
      skipped: [{ scanId: revision.scanId }],
    });
    const view = await readView(root);
    expect(view.scanId).toBe(displayed.scanId);
    expect(view.baseline).toBeUndefined();

    const changes = await research(root);
    expect(changes).toHaveTextContent(
      'No comparison is shown: no TradingView import of an earlier session is comparable and reproduces.',
    );
    expect(changes).toHaveTextContent(`Passed over: ${revision.scanId} (a revision`);
    // The verified scan itself is still reviewed in full.
    expect(document.querySelectorAll('[data-scan-row]')).toHaveLength(50);
  });

  it('lists an unreadable snapshot file, and compares nothing when nothing was evaluated', async () => {
    const root = await store();
    const previous = await refresh(root, EQUITY_NOW - DAY);
    const unreadable = '20261027T000000Z-deadbeef';
    await writeFile(join(root, 'scans', `${unreadable}.json`), 'not a snapshot');
    const displayed = await refresh(root, EQUITY_NOW);
    expect(displayed.baseline).toMatchObject({ before: { scanId: previous.scanId } });
    expect(displayed.baseline?.skipped).toEqual([
      { scanId: unreadable, reason: expect.stringMatching(/^unreadable: /) },
    ]);

    // Every call failed: the scan reproduces as a FAILED scan, with no session to compare.
    const empty = await refresh(root, EQUITY_NOW + 2 * HOUR, { skip: TICKERS });
    expect(empty).toMatchObject({ outcome: 'FAILED', evaluated: 0, reproduction: 'MATCH' });
    expect(empty.baseline).toEqual({
      status: 'NO_BASELINE',
      chosenBy: null,
      reason: 'the displayed scan evaluated no asset, so it rests on no session',
      skipped: [],
    });
  });

  it('keeps the last published view when the new scan fails reproduction', async () => {
    const root = await store();
    await refresh(root, EQUITY_NOW - DAY);
    const published = await refresh(root, EQUITY_NOW);
    const before = await readFile(viewPath(root), 'utf8');
    const failed = await refresh(root, EQUITY_NOW + 2 * HOUR, {
      paths: [falling],
      reproduce: async (scanId) => ({ status: 'MISMATCH', scanId, reason: 'OUTPUT_MISMATCH' }),
    });
    expect(failed).toMatchObject({
      outcome: 'NOT_REPRODUCED',
      reproduction: 'MISMATCH (OUTPUT_MISMATCH)',
      viewStatus: 'UNCHANGED',
      baseline: null,
      research: null,
    });
    expect(failed.scanId).not.toBe(published.scanId);
    expect(await readFile(viewPath(root), 'utf8')).toBe(before);

    const changes = await research(root);
    expect(changes).toHaveTextContent(`Displayed${published.scanId}`);
    expect(changes).not.toHaveTextContent(failed.scanId);
  });

  it('re-finishes byte-identically and keeps the owner’s override until it stops verifying', async () => {
    const root = await store();
    const previous = await refresh(root, EQUITY_NOW - DAY);
    const revision = await refresh(root, EQUITY_NOW - 2 * HOUR, { paths: [falling] });
    const displayed = await refresh(root, EQUITY_NOW);
    const automatic = await readFile(viewPath(root), 'utf8');
    const again = await displayed.finish();
    expect(again).toMatchObject({
      importStatus: 'ALREADY_IMPORTED',
      baseline: { before: { scanId: previous.scanId }, skipped: [{ scanId: revision.scanId }] },
    });
    expect(await readFile(viewPath(root), 'utf8')).toBe(automatic);

    // The owner names the same-session revision: never chosen automatically, but allowed.
    await attachBaseline({ store: join(root, 'scans'), baselineId: revision.scanId });
    const named = await readFile(viewPath(root), 'utf8');
    expect((await readView(root)).baselineSearch).toBeUndefined();
    const kept = await displayed.finish();
    expect(kept.baseline).toMatchObject({
      status: 'COMPARED',
      chosenBy: 'tradingview-baseline',
      before: { scanId: revision.scanId, session: '2026-10-27' },
      gap: { kind: 'SAME' },
      skipped: [],
    });
    expect(await readFile(viewPath(root), 'utf8')).toBe(named);
    let changes = await research(root);
    expect(changes).toHaveTextContent('Named by the owner with tradingview-baseline.');
    expect(changes).toHaveTextContent('Both rest on the same session');
    cleanup();

    // Once the named baseline no longer reproduces, finish says so and chooses again.
    await edit(root, revision.scanId, (snapshot) => {
      snapshot.scan.results[0]!.model.signal_score += 1;
    });
    const replaced = await displayed.finish();
    expect(replaced.baseline).toMatchObject({
      chosenBy: 'tradingview-finish',
      before: { scanId: previous.scanId },
    });
    expect(replaced.baseline?.skipped[0]).toEqual({
      scanId: revision.scanId,
      reason: `named with tradingview-baseline, no longer usable: ${revision.scanId} does not reproduce (OUTPUT_MISMATCH)`,
    });
    changes = await research(root);
    expect(changes).toHaveTextContent('Chosen by tradingview-finish');
    expect(changes).toHaveTextContent(
      `Passed over: ${revision.scanId} (named with tradingview-baseline, no longer usable`,
    );
  });
});
