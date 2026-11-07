// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScanInput } from '@/lib/marketScanner';
import {
  parseSavedScanList,
  parseSavedScanRead,
  parseTradingViewDevScan,
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevScan,
} from '@/lib/tradingViewDevScan';
import { bars, EQUITY_NOW, rising, split, wave } from '@/test/usEquityFixtures';
import { saveScan, type ScanSnapshot } from './marketScanStore';
import { TRADINGVIEW_SYMBOLS } from './tradingViewImport';
import { listSavedScans, readSavedScan } from './tradingViewSavedScans';

/**
 * Labeled fixtures, not market data: synthetic AAPL and MSFT series saved as
 * TradingView development snapshots with the app's own `saveScan`. A one-member
 * and a two-member universe stand in for the 50 and the 90.
 */
const COMMIT = 'f'.repeat(40);
const DAY = 86_400_000;

function input(ticker: string, symbol: string | null, time: number): ScanInput {
  return {
    ticker,
    instrument: `US:${ticker}`,
    ...(symbol && { providerSymbol: { requested: symbol, validated: symbol } }),
    equity: {
      provider: TRADINGVIEW_DEV_PROVIDER_ID,
      range: { from: '2026-01-12', to: '2026-10-27' },
      series: split(bars(ticker === 'AAPL' ? wave : rising, 200)),
      fetchedAt: time,
      cached: false,
    },
  };
}

async function save(
  store: string,
  time: number,
  tickers: readonly string[],
  legacy = false,
): Promise<ScanSnapshot> {
  const { snapshot } = await saveScan({
    inputs: tickers.map((ticker) => input(ticker, legacy ? null : `NASDAQ:${ticker}`, time)),
    evaluationTime: time,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    repositoryCommit: COMMIT,
    store,
    completedAt: time + 60_000,
  });
  return snapshot;
}

function viewOf(snapshot: ScanSnapshot, extra: Partial<TradingViewDevScan> = {}) {
  return parseTradingViewDevScan({
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: snapshot.scanId,
    importedAt: snapshot.completedAt,
    source: {
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: { startedAt: '2026-10-28T16:58:00.000Z', completedAt: snapshot.startedAt },
      symbols: { AAPL: 'NASDAQ:AAPL' },
      notice: 'Labeled fixture notice.',
      selectionRule: 'Labeled fixture universe.',
      pineAlerts: null,
    },
    scan: snapshot.scan,
    ...extra,
  });
}

const write = (store: string, name: string, value: unknown) =>
  writeFile(join(store, name), typeof value === 'string' ? value : JSON.stringify(value));

/** A stored snapshot as raw JSON, so a test can write what the types forbid. */
interface Raw {
  schemaVersion: string;
  scanId: string;
  inputs: Array<{ equity: { series: { bars: Array<{ close: number }> } } }>;
  scan: { modelVersion: string; results?: Array<{ model: { signal_score: number } }> };
}

async function edit(store: string, scanId: string, change: (raw: Raw) => void) {
  const path = join(store, `${scanId}.json`);
  const raw = JSON.parse(await readFile(path, 'utf8')) as Raw;
  change(raw);
  await writeFile(path, JSON.stringify(raw));
}

/** Every file's bytes, by name: the routes must leave the store exactly as they found it. */
async function fingerprint(dir: string) {
  const names = (await readdir(dir)).sort();
  return Promise.all(
    names.map(async (name) => {
      const bytes = await readFile(join(dir, name)).catch(() => Buffer.from('<link>'));
      return [name, createHash('sha256').update(bytes).digest('hex')];
    }),
  );
}

async function store() {
  const root = await mkdtemp(join(tmpdir(), 'zerochart-saved-'));
  const dir = join(root, 'scans');
  const small = await save(dir, EQUITY_NOW, ['AAPL']);
  const large = await save(dir, EQUITY_NOW + 2 * 3_600_000, ['AAPL', 'MSFT']);
  const legacy = await save(dir, EQUITY_NOW - DAY, ['AAPL'], true);
  return { root, dir, small, large, legacy };
}

describe('listSavedScans', () => {
  it('lists every TradingView snapshot, newest first, and nothing else in the store', async () => {
    const { root, dir, small, large, legacy } = await store();
    // The crypto Market scan, a view, a preserved view, a temporary file, a link and a stray.
    await write(dir, '20261028T202528Z-f4bed32e.json', {
      schemaVersion: '1',
      evidenceType: 'market-scan',
      scanId: '20261028T202528Z-f4bed32e',
      scan: { universe: { source: 'assets_status', members: ['BTC'] } },
    });
    await write(dir, TRADINGVIEW_DEV_SCAN_FILE, viewOf(large));
    await write(dir, `tradingview-dev-scan.${small.scanId}.0123456789ab.json`, viewOf(small));
    await write(dir, `${small.scanId}.json.tmp-1-x`, '{');
    await write(dir, '20261101T000000Z-0000000a.json', '{"truncated":');
    const outside = await save(join(root, 'elsewhere'), EQUITY_NOW + DAY, ['AAPL']);
    await symlink(
      join(root, 'elsewhere', `${outside.scanId}.json`),
      join(dir, `${outside.scanId}.json`),
    );
    await write(dir, 'notes.txt', 'unrelated');

    const list = parseSavedScanList(await listSavedScans(dir));
    expect(list.unreadable).toBe(1);
    expect(list.scans).toEqual([
      {
        scanId: large.scanId,
        session: '2026-10-27',
        members: 2,
        evaluated: 2,
        supported: 2,
        legacy: false,
      },
      {
        scanId: small.scanId,
        session: '2026-10-27',
        members: 1,
        evaluated: 1,
        supported: 1,
        legacy: false,
      },
      {
        scanId: legacy.scanId,
        session: '2026-10-26',
        members: 1,
        evaluated: 1,
        supported: 1,
        legacy: true,
      },
    ]);
  });

  it('lists an empty or absent store as empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zerochart-saved-'));
    expect(await listSavedScans(join(root, 'missing'))).toEqual({ scans: [], unreadable: 0 });
  });
});

describe('readSavedScan', () => {
  it('shows a snapshot alone with only what it records, never today’s map', async () => {
    const { dir, small, legacy } = await store();
    const read = parseSavedScanRead(await readSavedScan(dir, small.scanId));
    if (read.state !== 'VERIFIED') throw new Error(read.state);
    expect(read.view.scan).toEqual(small.scan);
    expect(read.view.importedAt).toBe(small.completedAt);
    expect(read.view.saved).toEqual({ repositoryCommit: COMMIT, legacy: false, view: null });
    expect(read.view.source).toEqual({
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: null,
      symbols: { AAPL: 'NASDAQ:AAPL' },
      notice: null,
      selectionRule: null,
      pineAlerts: null,
      snapshotOnly: true,
    });
    expect(read.view.baseline).toBeUndefined();
    expect(read.view.baselineSearch).toBeUndefined();
    // Results only: never the stored candles or their hashes.
    expect(read.view).not.toHaveProperty('inputs');
    expect(JSON.stringify(read)).not.toMatch(/"series"|"bars"|"inputHashes"/);

    // Today's map knows AAPL; a legacy snapshot recorded no symbol, so none is shown.
    expect(TRADINGVIEW_SYMBOLS['AAPL']).toBeDefined();
    const old = parseSavedScanRead(await readSavedScan(dir, legacy.scanId));
    if (old.state !== 'VERIFIED') throw new Error(old.state);
    expect(old.view.saved?.legacy).toBe(true);
    expect(old.view.source.symbols).toEqual({});
  });

  it('takes source and comparison from a recorded view of exactly that scan', async () => {
    const { dir, small, large, legacy } = await store();
    const baseline = {
      scanId: legacy.scanId,
      importedAt: legacy.completedAt,
      scan: legacy.scan,
      chosenBy: 'tradingview-finish' as const,
    };
    const search = { reason: null, skipped: [{ scanId: large.scanId, reason: 'labeled' }] };
    await write(dir, TRADINGVIEW_DEV_SCAN_FILE, viewOf(large));
    const older = `tradingview-dev-scan.${small.scanId}.aaaaaaaaaaaa.json`;
    const newer = `tradingview-dev-scan.${small.scanId}.bbbbbbbbbbbb.json`;
    await write(dir, older, viewOf(small, { source: { ...viewOf(small).source, notice: 'old' } }));
    await write(dir, newer, viewOf(small, { baseline, baselineSearch: search }));
    await utimes(join(dir, older), new Date(EQUITY_NOW - DAY), new Date(EQUITY_NOW - DAY));

    const published = parseSavedScanRead(await readSavedScan(dir, large.scanId));
    if (published.state !== 'VERIFIED') throw new Error(published.state);
    expect(published.view.saved?.view).toBe('published');
    expect(published.view.source).toEqual(viewOf(large).source);

    const preserved = parseSavedScanRead(await readSavedScan(dir, small.scanId));
    if (preserved.state !== 'VERIFIED') throw new Error(preserved.state);
    expect(preserved.view.saved?.view).toBe('preserved');
    expect(preserved.view.source.notice).toBe('Labeled fixture notice.');
    expect(preserved.view.baseline).toEqual(baseline);
    expect(preserved.view.baselineSearch).toEqual(search);
  });

  it('never borrows from a view of an edited scan or through a link', async () => {
    const { root, dir, small } = await store();
    const edited = viewOf(small);
    edited.scan = { ...edited.scan, status: 'PARTIAL' };
    await write(dir, `tradingview-dev-scan.${small.scanId}.cccccccccccc.json`, edited);
    await write(join(root), 'view.json', viewOf(small));
    await symlink(join(root, 'view.json'), join(dir, TRADINGVIEW_DEV_SCAN_FILE));
    const read = parseSavedScanRead(await readSavedScan(dir, small.scanId));
    if (read.state !== 'VERIFIED') throw new Error(read.state);
    expect(read.view.saved?.view).toBeNull();
    expect(read.view.source.snapshotOnly).toBe(true);
  });

  it('drops a recorded baseline that no longer reproduces, and says so', async () => {
    const { dir, small, legacy } = await store();
    const baseline = { scanId: legacy.scanId, importedAt: legacy.completedAt, scan: legacy.scan };
    await write(dir, TRADINGVIEW_DEV_SCAN_FILE, viewOf(small, { baseline }));
    await edit(dir, legacy.scanId, (raw) => (raw.scan.results![0]!.model.signal_score += 1));
    const read = parseSavedScanRead(await readSavedScan(dir, small.scanId));
    if (read.state !== 'VERIFIED') throw new Error(read.state);
    expect(read.view.baseline).toBeUndefined();
    expect(read.view.baselineSearch).toEqual({
      reason: `the baseline recorded with this scan, ${legacy.scanId}, does not reproduce (OUTPUT_MISMATCH)`,
      skipped: [],
    });
  });

  it.each([
    [
      'an edited score',
      (raw: Raw) => (raw.scan.results![0]!.model.signal_score += 1),
      { state: 'NOT_REPRODUCED', reason: 'OUTPUT_MISMATCH' },
    ],
    [
      'edited inputs',
      (raw: Raw) => (raw.inputs[0]!.equity.series.bars[0]!.close += 1),
      { state: 'NOT_REPRODUCED', reason: 'INPUT_HASH_MISMATCH' },
    ],
    [
      'another model version',
      (raw: Raw) => (raw.scan.modelVersion = '0.9.0'),
      { state: 'INCOMPATIBLE', reason: expect.stringContaining('model 0.9.0; this checkout runs') },
    ],
    [
      'another schema',
      (raw: Raw) => (raw.schemaVersion = '2'),
      { state: 'INCOMPATIBLE', reason: 'snapshot schema 2, not 1' },
    ],
    [
      'missing results',
      (raw: Raw) => delete raw.scan.results,
      { state: 'MALFORMED', reason: 'required snapshot fields are missing or invalid' },
    ],
    [
      'another scan ID inside',
      (raw: Raw) => (raw.scanId = '20261028T000000Z-00000000'),
      { state: 'MALFORMED', reason: expect.stringContaining('does not record this scan') },
    ],
  ])('names %s instead of showing it', async (_, change, expected) => {
    const { dir, small } = await store();
    await edit(dir, small.scanId, change);
    expect(parseSavedScanRead(await readSavedScan(dir, small.scanId))).toEqual({
      scanId: small.scanId,
      ...expected,
    });
  });

  it('names a file that is not JSON as malformed', async () => {
    const { dir, small } = await store();
    await write(dir, `${small.scanId}.json`, '{"schemaVersion":"1",');
    expect(await readSavedScan(dir, small.scanId)).toEqual({
      state: 'MALFORMED',
      scanId: small.scanId,
      reason: 'the file is not valid JSON',
    });
  });

  it('holds nothing for a missing, linked, non-TradingView or invalid scan ID', async () => {
    const { root, dir } = await store();
    const outside = await save(join(root, 'elsewhere'), EQUITY_NOW + DAY, ['AAPL']);
    await symlink(
      join(root, 'elsewhere', `${outside.scanId}.json`),
      join(dir, `${outside.scanId}.json`),
    );
    await write(dir, '20261028T202528Z-f4bed32e.json', {
      scan: { universe: { source: 'assets_status' } },
    });
    for (const scanId of [
      '20261101T000000Z-00000000',
      outside.scanId,
      '20261028T202528Z-f4bed32e',
      '../elsewhere/x',
      `../elsewhere/${outside.scanId}`,
      TRADINGVIEW_DEV_SCAN_FILE,
    ]) {
      expect(await readSavedScan(dir, scanId), scanId).toBeNull();
    }
  });

  it('leaves every file in the store byte for byte as it was', async () => {
    const { dir, small, large, legacy } = await store();
    await write(dir, TRADINGVIEW_DEV_SCAN_FILE, viewOf(large));
    await write(dir, `tradingview-dev-scan.${small.scanId}.0123456789ab.json`, viewOf(small));
    const before = await fingerprint(dir);
    await listSavedScans(dir);
    for (const { scanId } of [small, large, legacy, small, large]) await readSavedScan(dir, scanId);
    expect(await fingerprint(dir)).toEqual(before);
  });
});
