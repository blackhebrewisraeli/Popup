// @vitest-environment node

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BINANCE_CRYPTO_PROVIDER, type ScanInput } from '@/lib/marketScanner';
import {
  checkSavedScanFile,
  SAVED_SCAN_FILE_MAX_BYTES,
  SAVED_SCAN_FILE_MAX_CANDLES,
  SAVED_SCAN_FILE_MAX_PAIRS,
  type SavedScanFileCheck,
} from '@/lib/savedScanFile';
import { TRADINGVIEW_DEV_PROVIDER_ID, TRADINGVIEW_DEV_SCAN_KIND } from '@/lib/tradingViewDevScan';
import {
  arrayBufferOf,
  FIXTURE_COMMIT,
  FIXTURE_INPUTS,
  fixtureCandles,
  fixturePair,
  savedCryptoSnapshot,
} from '@/test/savedCryptoScanFixture';
import { bars, rising, split } from '@/test/usEquityFixtures';
import { readSavedScan } from './tradingViewSavedScans';

/**
 * The browser's file check against the scan store's own reader, on labeled synthetic snapshots
 * written by `saveScan`: same verdicts, same file hash, same view. Nothing here was fetched.
 */
const browser = (bytes: Uint8Array) => checkSavedScanFile(arrayBufferOf(bytes));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const bytesOf = (value: unknown, space?: number) => Buffer.from(JSON.stringify(value, null, space));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Writes an edited copy over the stored snapshot; returns the edited bytes. */
async function tampered(change: (raw: Json) => void) {
  const fixture = await savedCryptoSnapshot();
  const raw = JSON.parse(fixture.bytes.toString('utf8')) as Json;
  change(raw);
  const bytes = bytesOf(raw, 2);
  await writeFile(fixture.path, bytes);
  return { ...fixture, bytes };
}

describe('Node and browser read a crypto snapshot the same way', () => {
  it('verifies the same file with the same byte hash and the same snapshot-only view', async () => {
    const { store, bytes, snapshot } = await savedCryptoSnapshot();
    const node = await readSavedScan(store, snapshot.scanId);
    const web = await browser(bytes);
    expect(node?.state).toBe('VERIFIED');
    expect(web.state).toBe('VERIFIED');
    if (node?.state !== 'VERIFIED' || web.state !== 'VERIFIED') return;
    expect(web.view.saved?.snapshotSha256).toBe(sha256(bytes));
    expect(web.view.saved?.snapshotSha256).toBe(node.view.saved?.snapshotSha256);
    // The only difference: the browser says the file was opened, not read from the store.
    expect(web.view).toEqual({ ...node.view, saved: { ...node.view.saved, fromFile: true } });
    expect(web.view.saved).toEqual({
      repositoryCommit: FIXTURE_COMMIT,
      legacy: false,
      view: null,
      snapshotSha256: sha256(bytes),
      fromFile: true,
    });
    expect(web.view.source).toMatchObject({ snapshotOnly: true, retrieval: null, notice: null });
    // Results, rank, model and candle policy as recorded; no candle reaches the view.
    expect(web.view.scan).toEqual(snapshot.scan);
    expect(JSON.stringify(web.view)).not.toContain('"candles"');
  });

  it('hashes the bytes as given: other whitespace verifies under its own hash in both', async () => {
    const fixture = await savedCryptoSnapshot();
    const compact = Buffer.from(JSON.stringify(JSON.parse(fixture.bytes.toString('utf8'))));
    await writeFile(fixture.path, compact);
    const node = await readSavedScan(fixture.store, fixture.snapshot.scanId);
    const web = await browser(compact);
    expect(compact.equals(fixture.bytes)).toBe(false);
    expect(node?.state === 'VERIFIED' && node.view.saved?.snapshotSha256).toBe(sha256(compact));
    expect(web.state === 'VERIFIED' && web.view.saved?.snapshotSha256).toBe(sha256(compact));
    expect(sha256(compact)).not.toBe(sha256(fixture.bytes));
  });

  const tampering: Array<[string, (raw: Json) => void, string, string]> = [
    [
      'an input hash',
      (raw) => (raw['inputHashes']['ZCTLONG-USDT'] = '0'.repeat(64)),
      'NOT_REPRODUCED',
      'INPUT_HASH_MISMATCH',
    ],
    [
      'a candle',
      (raw) => (raw['inputs'][0].candles[150].close += 1),
      'NOT_REPRODUCED',
      'INPUT_HASH_MISMATCH',
    ],
    [
      'the universe',
      (raw) => raw['scan'].universe.members.push('ZCTNEW-USDT'),
      'NOT_REPRODUCED',
      'UNIVERSE_HASH_MISMATCH',
    ],
    [
      'the start time',
      (raw) => (raw['startedAt'] = '2026-10-28T17:00:01.000Z'),
      'NOT_REPRODUCED',
      'EVALUATION_TIME_MISMATCH',
    ],
    [
      'the evaluation time',
      (raw) => (raw['scan'].evaluationTime += 1000),
      'NOT_REPRODUCED',
      'EVALUATION_TIME_MISMATCH',
    ],
    [
      'a score',
      (raw) => (raw['scan'].results[0].model.signal_score += 1),
      'NOT_REPRODUCED',
      'OUTPUT_MISMATCH',
    ],
    ['a rank', (raw) => (raw['scan'].results[0].rank = 9), 'NOT_REPRODUCED', 'OUTPUT_MISMATCH'],
    [
      'the coverage',
      (raw) => (raw['scan'].coverage.evaluated -= 1),
      'NOT_REPRODUCED',
      'OUTPUT_MISMATCH',
    ],
    [
      'the repository commit',
      (raw) => delete raw['repositoryCommit'],
      'MALFORMED',
      'required snapshot fields are missing or invalid',
    ],
    [
      'the model version',
      (raw) => (raw['scan'].modelVersion = '0.9.0'),
      'INCOMPATIBLE',
      'model 0.9.0',
    ],
  ];

  it.each(tampering)(
    'refuses a file with an edited %s, as the scan store does',
    async (_, change, state, reason) => {
      const { store, bytes, snapshot } = await tampered(change);
      const node = await readSavedScan(store, snapshot.scanId);
      const web = await browser(bytes);
      expect(node).toEqual({
        state,
        scanId: snapshot.scanId,
        reason: expect.stringContaining(reason),
      });
      expect(web).toEqual({
        state,
        scanId: snapshot.scanId,
        reason: expect.stringContaining(reason),
      });
      if (state !== 'INCOMPATIBLE') expect(web).toEqual({ ...node });
    },
  );

  it('ignores claims in the file: a "VERIFIED", "saved" or "match" field verifies nothing', async () => {
    const claims = (raw: Json) => {
      raw['state'] = 'VERIFIED';
      raw['reproduction'] = 'match';
      raw['saved'] = { snapshotSha256: 'f'.repeat(64), view: 'published', fromFile: true };
    };
    const edited = await tampered((raw) => {
      claims(raw);
      raw['scan'].results[0].model.signal_score += 1;
    });
    expect(await browser(edited.bytes)).toMatchObject({ state: 'NOT_REPRODUCED' });
    const intact = await tampered(claims);
    const web = await browser(intact.bytes);
    expect(web.state === 'VERIFIED' && web.view.saved).toEqual({
      repositoryCommit: FIXTURE_COMMIT,
      legacy: false,
      view: null,
      snapshotSha256: sha256(intact.bytes),
      fromFile: true,
    });
  });

  it('refuses the dev route answer that wraps a verified view: it is not a snapshot', async () => {
    const { store, snapshot } = await savedCryptoSnapshot();
    const read = await readSavedScan(store, snapshot.scanId);
    expect(await browser(bytesOf(read))).toMatchObject({
      state: 'MALFORMED',
      reason: expect.stringContaining('not a market-scan snapshot'),
    });
  });
});

describe('what the production entry point refuses', () => {
  const refusal = (check: SavedScanFileCheck) => (check.state === 'VERIFIED' ? check.state : check);

  it('a published Research view, even of this exact scan', async () => {
    const { snapshot } = await savedCryptoSnapshot();
    const view = { kind: TRADINGVIEW_DEV_SCAN_KIND, scanId: snapshot.scanId, scan: snapshot.scan };
    expect(refusal(await browser(bytesOf(view)))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining('published Research view'),
      scanId: snapshot.scanId,
    });
  });

  it('a crypto scan from Binance klines, not TradingView', async () => {
    const { bytes } = await savedCryptoSnapshot(FIXTURE_INPUTS, {
      cryptoProvider: BINANCE_CRYPTO_PROVIDER,
    });
    expect(refusal(await browser(bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining('not TradingView'),
    });
  });

  it('a scan whose universe is not a TradingView import', async () => {
    const { bytes } = await savedCryptoSnapshot(FIXTURE_INPUTS, {
      universeSource: 'assets_status',
    });
    expect(refusal(await browser(bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining('not a TradingView import'),
    });
  });

  it('equity and mixed snapshots', async () => {
    const equity: ScanInput = {
      ticker: 'AAPL',
      instrument: 'US:AAPL',
      providerSymbol: { requested: 'NASDAQ:AAPL', validated: 'NASDAQ:AAPL' },
      equity: {
        provider: TRADINGVIEW_DEV_PROVIDER_ID,
        range: { from: '2026-01-12', to: '2026-10-27' },
        series: split(bars(rising, 200)),
        fetchedAt: 0,
        cached: false,
      },
    };
    for (const inputs of [[equity], [...FIXTURE_INPUTS, equity]]) {
      const { bytes } = await savedCryptoSnapshot(inputs);
      expect(refusal(await browser(bytes))).toMatchObject({
        state: 'UNSUPPORTED',
        reason: expect.stringContaining('only crypto-only scans'),
      });
    }
  });

  it('a legacy snapshot without exact provider symbols, and a symbol that is not its instrument', async () => {
    const legacy = FIXTURE_INPUTS.map(({ providerSymbol: _, ...input }) => input);
    expect(refusal(await browser((await savedCryptoSnapshot(legacy)).bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining('records no exact TradingView symbol'),
    });
    const moved = FIXTURE_INPUTS.map((input, index) =>
      index === 0
        ? {
            ...input,
            providerSymbol: { requested: 'BINANCE:ZCTUSDC', validated: 'BINANCE:ZCTUSDC' },
          }
        : input,
    );
    expect(refusal(await browser((await savedCryptoSnapshot(moved)).bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining('are not both its instrument'),
    });
  });

  it('a pair that is not a Binance Spot USDT pair', async () => {
    const { bytes } = await tampered((raw) => {
      const symbol = 'BINANCE:ZCTLONGBTC';
      raw['inputs'][0].instrument = symbol;
      raw['inputs'][0].providerSymbol = { requested: symbol, validated: symbol };
    });
    expect(refusal(await browser(bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining('not a Binance Spot USDT pair'),
    });
  });

  it('another schema, a missing field and an incompatible scanner', async () => {
    const schema = await tampered((raw) => (raw['schemaVersion'] = '2'));
    expect(refusal(await browser(schema.bytes))).toMatchObject({
      state: 'INCOMPATIBLE',
      reason: 'snapshot schema 2, not 1',
    });
    const scanner = await tampered((raw) => (raw['scan'].scannerVersion = 'market-scan-v1'));
    expect(refusal(await browser(scanner.bytes))).toMatchObject({
      state: 'INCOMPATIBLE',
      reason: expect.stringContaining('this version of Popup runs market-scan-v2'),
    });
    const inputs = await tampered((raw) => delete raw['inputs']);
    expect(refusal(await browser(inputs.bytes))).toMatchObject({ state: 'MALFORMED' });
  });

  it('text that is not UTF-8, not JSON or not an object', async () => {
    expect(refusal(await browser(new Uint8Array([0x7b, 0xff, 0x7d])))).toMatchObject({
      state: 'MALFORMED',
      reason: 'the file is not UTF-8 text',
      scanId: null,
    });
    expect(refusal(await browser(Buffer.from('{"schemaVersion": "1",')))).toMatchObject({
      state: 'MALFORMED',
      reason: 'the file is not valid JSON',
    });
    expect(refusal(await browser(Buffer.from('[1, 2]')))).toMatchObject({ state: 'MALFORMED' });
  });

  it('size and structure over their bounds, before anything is hashed or scored', async () => {
    const big = new Uint8Array(SAVED_SCAN_FILE_MAX_BYTES + 1);
    expect(refusal(await browser(big))).toMatchObject({ state: 'TOO_LARGE', scanId: null });
    const many = Array.from({ length: SAVED_SCAN_FILE_MAX_PAIRS + 1 }, (_, i) =>
      fixturePair(`ZCT${i}-USDT`, []),
    );
    expect(refusal(await browser((await savedCryptoSnapshot(many)).bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining(`over the limit of ${SAVED_SCAN_FILE_MAX_PAIRS}`),
    });
    const long = fixturePair(
      'ZCTLONG-USDT',
      fixtureCandles(() => 5, 0.01, SAVED_SCAN_FILE_MAX_CANDLES + 1),
    );
    expect(refusal(await browser((await savedCryptoSnapshot([long])).bytes))).toMatchObject({
      state: 'UNSUPPORTED',
      reason: expect.stringContaining(`over the limit of ${SAVED_SCAN_FILE_MAX_CANDLES}`),
    });
  });
});

describe('the file check reads only what it is handed', () => {
  it('fetches nothing', async () => {
    const calls: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error('no request expected'));
    }) as typeof fetch;
    try {
      const { bytes } = await savedCryptoSnapshot();
      expect((await browser(bytes)).state).toBe('VERIFIED');
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual([]);
  });

  it('runs in the store path from the same directory listing as before', async () => {
    const { store, snapshot } = await savedCryptoSnapshot();
    await writeFile(join(store, 'unrelated.txt'), 'not a snapshot');
    expect((await readSavedScan(store, snapshot.scanId))?.state).toBe('VERIFIED');
  });
});
