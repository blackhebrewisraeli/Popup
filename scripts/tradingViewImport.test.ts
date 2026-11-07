import { mkdir, mkdtemp, readFile, readdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CandleProviderDataError } from '@/lib/binance';
import { parseTradingViewDevScan, TRADINGVIEW_DEV_SCAN_FILE } from '@/lib/tradingViewDevScan';
import { latestFinalSession, sessionOpen, US_EQUITY_INSTRUMENTS } from '@/lib/usEquityDaily';
import { bars, EQUITY_NOW, falling, rising, wave } from '@/test/usEquityFixtures';
import { reproduceScan, saveScan, ScanSnapshotConflictError } from './marketScanStore';
import {
  attachBaseline,
  captureResponses,
  finishRetrieval,
  importInputs,
  importTradingViewScan,
  parseExport,
  publishTradingViewDevScan,
  recordFailure,
  retrievalStatus,
  selectDevScanUniverse,
  startRetrieval,
  TRADINGVIEW_SYMBOLS,
  tradingViewSeries,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Labeled fixtures, not market data: sessions from the NYSE calendar, prices
 * from synthetic paths, shaped like a `get_ohlcv` 1D response. Nothing here
 * was fetched from TradingView.
 */
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const COMMIT = 'c'.repeat(40);
const PATHS = [wave, rising, falling];

function response(symbol: string, path = wave, last?: string) {
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

function exportOf(
  edit: (entries: TradingViewOhlcvExport['instruments']) => void = () => {},
  at = EQUITY_NOW,
): TradingViewOhlcvExport {
  const last = latestFinalSession(at)!;
  const instruments = selectDevScanUniverse().map((ticker, i) => ({
    ticker,
    symbol: TRADINGVIEW_SYMBOLS[ticker]!,
    receivedAt: new Date(at - 60_000).toISOString(),
    response: response(TRADINGVIEW_SYMBOLS[ticker]!, PATHS[i % PATHS.length], last),
  }));
  edit(instruments);
  return {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    retrieval: {
      startedAt: new Date(at - 120_000).toISOString(),
      completedAt: new Date(at).toISOString(),
    },
    pineAlerts: { checkedAt: new Date(at).toISOString(), symbols: ['BINANCE:BTCUSDT'] },
    instruments,
  };
}

async function importInto(
  file: TradingViewOhlcvExport,
  options: { store?: string; now?: number; name?: string } = {},
) {
  const store = options.store ?? (await mkdtemp(join(tmpdir(), 'zerochart-tv-')));
  const path = join(store, options.name ?? 'export.json');
  await writeFile(path, JSON.stringify(file));
  const result = await importTradingViewScan({
    file: path,
    store,
    repositoryCommit: COMMIT,
    now: () => options.now ?? EQUITY_NOW + 5 * 60_000,
  });
  return { store, ...result };
}

async function temporaryArtifacts(store: string): Promise<string[]> {
  return (await readdir(store)).filter((name) => name.includes('.tmp-'));
}

describe('TradingView development universe', () => {
  it('picks 50 configured tickers by digest alone, whatever order they arrive in', () => {
    const picked = selectDevScanUniverse();
    expect(picked).toHaveLength(50);
    expect(picked.every((ticker) => Object.hasOwn(US_EQUITY_INSTRUMENTS, ticker))).toBe(true);
    expect(selectDevScanUniverse([...Object.keys(US_EQUITY_INSTRUMENTS)].reverse())).toEqual(
      picked,
    );
    expect(selectDevScanUniverse(['AAPL', 'BTC-USD', 'EURUSD=X'])).toEqual(['AAPL']);
  });

  it('names one exchange-qualified primary listing for exactly the selected tickers', () => {
    expect(Object.keys(TRADINGVIEW_SYMBOLS).sort()).toEqual(selectDevScanUniverse());
    for (const [ticker, symbol] of Object.entries(TRADINGVIEW_SYMBOLS)) {
      expect(symbol).toMatch(new RegExp(`^(NASDAQ|NYSE|AMEX|CBOE):${ticker}$`));
    }
  });
});

describe('tradingViewSeries', () => {
  const from = '2026-01-13';

  it('keys bars by their 09:30 New York session, across the DST change', () => {
    const series = tradingViewSeries(response('NYSE:BAC'), { symbol: 'NYSE:BAC', from });
    expect(series.adjustment).toBe('SPLIT');
    expect(series.bars.at(-1)?.session).toBe('2026-10-27');
    const march = series.bars.find((bar) => bar.session === '2026-03-06');
    expect(march).toBeDefined();
    expect(series.bars.every((bar) => bar.session >= from)).toBe(true);
  });

  it('rejects a bar stamped anything but the session open, rather than re-dating it', () => {
    const body = response('NYSE:BAC');
    body.bars[150]!.t = Date.UTC(2026, 7, 20) / 1000;
    expect(() => tradingViewSeries(body, { symbol: 'NYSE:BAC', from })).toThrow(
      /not the 09:30 America\/New_York open of 2026-08-19/,
    );
  });

  it('refuses another instrument, interval, an unstated adjustment or a non-numeric bar', () => {
    const check = (edit: (body: ReturnType<typeof response>) => void) => {
      const body = response('NYSE:BAC');
      edit(body);
      return () => tradingViewSeries(body, { symbol: 'NYSE:BAC', from });
    };
    expect(check((body) => (body.symbol = 'BOATS:BAC'))).toThrow(CandleProviderDataError);
    expect(check((body) => (body.interval = '1W'))).toThrow(/not 1D/);
    expect(check((body) => (body.notice = 'regular session only'))).toThrow(
      /adjustment basis is unresolved/,
    );
    expect(check((body) => ((body.bars[3] as { c: unknown }).c = null))).toThrow(/non-numeric/);
    expect(check((body) => (body.success = false))).toThrow(/did not succeed/);
  });
});

describe('importTradingViewScan', () => {
  it('scores every selected ticker with the canonical engine and reproduces offline', async () => {
    const { store, snapshot, view, status, snapshotStatus, viewStatus } =
      await importInto(exportOf());
    expect({ status, snapshotStatus, viewStatus }).toEqual({
      status: 'IMPORTED',
      snapshotStatus: 'CREATED',
      viewStatus: 'UPDATED',
    });
    expect(snapshot.scan.status).toBe('COMPLETE');
    expect(snapshot.scan.coverage).toMatchObject({ configured: 50, evaluated: 50 });
    expect(snapshot.scan.cohorts[0]).toMatchObject({
      assetClass: 'equity',
      provider: 'tradingview-mcp-get_ohlcv',
      candlePolicyVersion: 'us-equity-daily-v1',
      minClosedCandles: 199,
    });
    const first = snapshot.scan.results[0]!;
    expect(first).toMatchObject({ rank: 1, closedCandles: 199, cached: false });
    expect(first.fetchedAt).toBe(EQUITY_NOW - 60_000);
    expect(snapshot.startedAt).toBe(new Date(EQUITY_NOW).toISOString());
    expect(await reproduceScan(snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: snapshot.scanId,
    });
    const written = parseTradingViewDevScan(
      JSON.parse(await readFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
    );
    expect(written).toEqual(view);
    expect(view.source).toMatchObject({ notice: NOTICE, symbols: TRADINGVIEW_SYMBOLS });
  });

  it('reuses an equivalent snapshot despite a later import completion and republishes the view', async () => {
    const file = exportOf();
    const first = await importInto(file);
    const snapshotPath = join(first.store, `${first.snapshot.scanId}.json`);
    const snapshotBytes = await readFile(snapshotPath, 'utf8');

    const repeated = await importInto(file, {
      store: first.store,
      now: EQUITY_NOW + 30 * 60_000,
    });

    expect(repeated).toMatchObject({
      status: 'ALREADY_IMPORTED',
      snapshotStatus: 'REUSED',
      viewStatus: 'UPDATED',
    });
    expect(repeated.snapshot).toEqual(first.snapshot);
    expect(repeated.snapshot.completedAt).toBe(first.snapshot.completedAt);
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotBytes);
    expect(
      parseTradingViewDevScan(
        JSON.parse(await readFile(join(first.store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
      ),
    ).toEqual(repeated.view);
    expect(await reproduceScan(first.snapshot.scanId, first.store)).toEqual({
      status: 'MATCH',
      scanId: first.snapshot.scanId,
    });
  });

  it('rejects changed inputs for the same target without changing the snapshot or view', async () => {
    const original = exportOf();
    const first = await importInto(original);
    const snapshotPath = join(first.store, `${first.snapshot.scanId}.json`);
    const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
    const snapshotBytes = await readFile(snapshotPath, 'utf8');
    const viewBytes = await readFile(viewPath, 'utf8');
    const changed = exportOf((entries) => {
      const body = entries[0]!.response as ReturnType<typeof response>;
      body.bars[150]!.c *= 1.001;
    });

    const error = await importInto(changed, {
      store: first.store,
      name: 'changed-export.json',
    }).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ScanSnapshotConflictError);
    expect(error).toMatchObject({
      code: 'SCAN_SNAPSHOT_CONFLICT',
      scanId: first.snapshot.scanId,
      differences: expect.arrayContaining(['INPUTS']),
    });
    expect(await readFile(snapshotPath, 'utf8')).toBe(snapshotBytes);
    expect(await readFile(viewPath, 'utf8')).toBe(viewBytes);
  });

  it.each([
    {
      label: 'calculated outputs',
      difference: 'OUTPUTS',
      edit: (stored: unknown) => {
        const snapshot = stored as { scan: { results: Array<{ rank: number | null }> } };
        snapshot.scan.results[0]!.rank = 999;
      },
    },
    {
      label: 'model attribution',
      difference: 'ATTRIBUTION',
      edit: (stored: unknown) => {
        const snapshot = stored as { scan: { modelVersion: string } };
        snapshot.scan.modelVersion = 'unexpected-model-version';
      },
    },
  ])(
    'validates existing $label before reuse and overwrites nothing',
    async ({ difference, edit }) => {
      const file = exportOf();
      const first = await importInto(file);
      const snapshotPath = join(first.store, `${first.snapshot.scanId}.json`);
      const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
      const stored: unknown = JSON.parse(await readFile(snapshotPath, 'utf8'));
      edit(stored);
      await writeFile(snapshotPath, `${JSON.stringify(stored, null, 2)}\n`);
      const invalidSnapshotBytes = await readFile(snapshotPath, 'utf8');
      const viewBytes = await readFile(viewPath, 'utf8');

      const error = await importInto(file, { store: first.store }).then(
        () => null,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(ScanSnapshotConflictError);
      expect(error).toMatchObject({
        code: 'SCAN_SNAPSHOT_CONFLICT',
        scanId: first.snapshot.scanId,
        differences: expect.arrayContaining([difference]),
      });
      expect(await readFile(snapshotPath, 'utf8')).toBe(invalidSnapshotBytes);
      expect(await readFile(viewPath, 'utf8')).toBe(viewBytes);
    },
  );

  it('recreates a missing development view from a verified saved snapshot', async () => {
    const file = exportOf();
    const first = await importInto(file);
    const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
    await unlink(viewPath);

    const repeated = await importInto(file, { store: first.store });

    expect(repeated).toMatchObject({
      status: 'ALREADY_IMPORTED',
      snapshotStatus: 'REUSED',
      viewStatus: 'UPDATED',
    });
    expect(parseTradingViewDevScan(JSON.parse(await readFile(viewPath, 'utf8')))).toEqual(
      repeated.view,
    );
  });

  it('keeps the previous complete view when atomic publication is interrupted and recovers on retry', async () => {
    const file = exportOf();
    const first = await importInto(file);
    const viewPath = join(first.store, TRADINGVIEW_DEV_SCAN_FILE);
    const staleView = { ...first.view, importedAt: '2000-01-01T00:00:00.000Z' };
    await writeFile(viewPath, `${JSON.stringify(staleView, null, 2)}\n`);
    const staleBytes = await readFile(viewPath, 'utf8');

    await expect(
      publishTradingViewDevScan(first.view, first.store, {
        writeFile,
        rename: async () => {
          throw new Error('simulated interruption before atomic rename');
        },
        unlink,
      }),
    ).rejects.toThrow(/simulated interruption/);
    expect(await readFile(viewPath, 'utf8')).toBe(staleBytes);
    expect(await temporaryArtifacts(first.store)).toEqual([]);

    const recovered = await importInto(file, { store: first.store });
    expect(recovered).toMatchObject({
      status: 'ALREADY_IMPORTED',
      snapshotStatus: 'REUSED',
      viewStatus: 'UPDATED',
    });
    expect(await readFile(viewPath, 'utf8')).not.toBe(staleBytes);
    expect(parseTradingViewDevScan(JSON.parse(await readFile(viewPath, 'utf8')))).toEqual(
      recovered.view,
    );
  });

  it('keeps concurrent identical imports idempotent and leaves no partial files', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-tv-'));
    const file = exportOf();

    const results = await Promise.all([
      importInto(file, { store, name: 'first-export.json' }),
      importInto(file, { store, name: 'second-export.json', now: EQUITY_NOW + 10 * 60_000 }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['ALREADY_IMPORTED', 'IMPORTED']);
    expect(results.map((result) => result.snapshotStatus).sort()).toEqual(['CREATED', 'REUSED']);
    expect(results.every((result) => result.viewStatus === 'UPDATED')).toBe(true);
    expect(results[0]!.snapshot).toEqual(results[1]!.snapshot);
    expect(await reproduceScan(results[0]!.snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: results[0]!.snapshot.scanId,
    });
    expect(await temporaryArtifacts(store)).toEqual([]);
  });

  it('keeps one immutable winner when conflicting imports race', async () => {
    const store = await mkdtemp(join(tmpdir(), 'zerochart-tv-'));
    const original = exportOf();
    const changed = exportOf((entries) => {
      const body = entries[0]!.response as ReturnType<typeof response>;
      body.bars[150]!.c *= 1.001;
    });

    const results = await Promise.allSettled([
      importInto(original, { store, name: 'original-export.json' }),
      importInto(changed, { store, name: 'changed-export.json' }),
    ]);
    const successes = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof importInto>>> =>
        result.status === 'fulfilled',
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0]!.value).toMatchObject({ status: 'IMPORTED', snapshotStatus: 'CREATED' });
    expect(failures[0]!.reason).toBeInstanceOf(ScanSnapshotConflictError);
    expect(failures[0]!.reason).toMatchObject({
      code: 'SCAN_SNAPSHOT_CONFLICT',
      differences: expect.arrayContaining(['INPUTS']),
    });
    const winner = successes[0]!.value;
    expect(await reproduceScan(winner.snapshot.scanId, store)).toEqual({
      status: 'MATCH',
      scanId: winner.snapshot.scanId,
    });
    const view = parseTradingViewDevScan(
      JSON.parse(await readFile(join(store, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
    );
    expect(view.scan).toEqual(winner.snapshot.scan);
    expect(await temporaryArtifacts(store)).toEqual([]);
  });

  it('keeps every failure, with its reason, instead of dropping the ticker', async () => {
    const [a, b, c, d, e] = selectDevScanUniverse();
    const { snapshot } = await importInto(
      exportOf((entries) => {
        entries[0] = { ticker: a!, symbol: TRADINGVIEW_SYMBOLS[a!]!, error: 'HTTP 429' };
        entries.splice(1, 1);
        entries[1]!.symbol = 'BOATS:X';
        (entries[2]!.response as { notice: string }).notice = 'delayed';
        (entries[3]!.response as { success: boolean }).success = false;
      }),
    );
    const byTicker = new Map(snapshot.scan.results.map((result) => [result.ticker, result]));
    expect(snapshot.scan.status).toBe('PARTIAL');
    expect(snapshot.scan.coverage).toMatchObject({ configured: 50, evaluated: 45 });
    expect(byTicker.get(a!)).toMatchObject({ status: 'FETCH_FAILED' });
    expect(byTicker.get(a!)?.detail).toMatch(/HTTP 429/);
    expect(byTicker.get(b!)?.detail).toMatch(/was never retrieved/);
    expect(byTicker.get(c!)).toMatchObject({ status: 'DATA_INVALID' });
    expect(byTicker.get(d!)?.detail).toMatch(/adjustment basis is unresolved/);
    expect(byTicker.get(e!)).toMatchObject({ status: 'FETCH_FAILED' });
    expect(byTicker.get(e!)?.detail).toMatch(/did not succeed/);
  });

  it('refuses a retrieval that a session close interrupted, and files it does not recognise', async () => {
    const straddle = exportOf();
    // 04:00 UTC on 28 Oct: 27 Oct turns final at 05:00 UTC, inside the window.
    straddle.retrieval.startedAt = new Date(EQUITY_NOW - 13 * 3_600_000).toISOString();
    await expect(importInto(straddle)).rejects.toThrow(/became final during retrieval/);

    const foreign = exportOf((entries) => entries.push({ ...entries[0]!, ticker: 'XOM' }));
    expect(() => parseExport(foreign)).toThrow(/XOM is not in the dev-scan universe/);
    const late = exportOf((entries) => (entries[0]!.receivedAt = '2027-01-01T00:00:00Z'));
    expect(() => parseExport(late)).toThrow(/inside the retrieval window/);
    expect(() => parseTradingViewDevScan({ kind: 'tradingview-dev-scan' })).toThrow();
  });

  it('rejects a malformed export at the boundary', () => {
    const file = exportOf();
    expect(() => parseExport({ schemaVersion: '2' })).toThrow(/schemaVersion 1/);
    expect(() =>
      parseExport({
        ...file,
        retrieval: { startedAt: file.retrieval.completedAt, completedAt: 'x' },
      }),
    ).toThrow(/not ordered ISO times/);
    expect(() => parseExport({ ...file, instruments: {} })).toThrow(/must be an array/);
    const unnamed = exportOf((entries) => Object.assign(entries[0]!, { symbol: 7 }));
    expect(() => parseExport(unnamed)).toThrow(/needs ticker and symbol/);
    expect(() => parseExport(exportOf((entries) => entries.push({ ...entries[0]! })))).toThrow(
      /appears twice/,
    );
    expect(() =>
      parseExport({
        ...file,
        pineAlerts: { checkedAt: 'not-a-time', symbols: ['BINANCE:BTCUSDT', 7] },
      }),
    ).toThrow(/pineAlerts/);
    const noBars = { ...response('NYSE:BAC'), bars: undefined };
    expect(() => tradingViewSeries(noBars, { symbol: 'NYSE:BAC', from: '2026-01-13' })).toThrow(
      /no bars array/,
    );
  });

  it('reports a scan outside the published calendar rather than guessing sessions', () => {
    const inputs = importInputs(exportOf(), Date.UTC(2029, 0, 10));
    expect(inputs).toHaveLength(50);
    expect(inputs.every((input) => input.error?.detail.startsWith('CALENDAR_OUT_OF_RANGE'))).toBe(
      true,
    );
  });

  it('records a retrieval in which every call failed as a failed scan, with no notice to quote', async () => {
    const { snapshot, view } = await importInto(
      exportOf((entries) =>
        entries.forEach((entry) => {
          delete entry.response;
          entry.error = 'HTTP 500';
        }),
      ),
    );
    expect(snapshot.scan.status).toBe('FAILED');
    expect(snapshot.scan.coverage.byStatus.FETCH_FAILED).toBe(50);
    expect(view.source.notice).toBe('No market-data notice was returned.');
  });
});

describe('TradingView retrieval capture', () => {
  const SYMBOLS = selectDevScanUniverse().map((ticker) => TRADINGVIEW_SYMBOLS[ticker]!);
  const RECEIVED = EQUITY_NOW - 60_000;
  let saves = 0;

  /** A labeled synthetic `get_ohlcv` result saved the way the agent's client saves one. */
  async function saved(root: string, symbol: string, path = wave, at = RECEIVED) {
    const file = join(root, `get-ohlcv-${(saves += 1)}.txt`);
    await writeFile(file, JSON.stringify(response(symbol, path)));
    await utimes(file, new Date(at), new Date(at));
    return file;
  }

  async function retrieval(startedAt = EQUITY_NOW - 120_000) {
    const root = await mkdtemp(join(tmpdir(), 'zerochart-tv-capture-'));
    const options = { store: join(root, 'tradingview'), now: () => EQUITY_NOW };
    const started = await startRetrieval({ ...options, now: () => startedAt });
    const ids = { ...options, retrievalId: started.retrievalId };
    const capture = async (symbols: readonly string[], at = RECEIVED) =>
      captureResponses({
        ...ids,
        pairs: await Promise.all(
          symbols.map(async (symbol, i) => ({
            symbol,
            file: await saved(root, symbol, PATHS[i % PATHS.length], at),
          })),
        ),
      });
    const finish = () =>
      finishRetrieval({
        ...ids,
        scanStore: join(root, 'scans'),
        repositoryCommit: COMMIT,
        now: () => EQUITY_NOW + 5 * 60_000,
      });
    return { root, started, ids, capture, finish };
  }

  it('binds each saved result to the symbol requested for it, never to a file name', async () => {
    const { root, started, ids } = await retrieval();
    expect(started).toMatchObject({ requiredSession: '2026-10-27', window: 'OPEN', captured: 0 });
    expect(started.retry).toEqual(SYMBOLS);

    // Two parallel calls saved to one name: the file holds only the later response.
    const overwritten = await saved(root, SYMBOLS[1]!);
    const earlier = await saved(root, SYMBOLS[2]!, wave, EQUITY_NOW - 10 * 60_000);
    const { results, status } = await captureResponses({
      ...ids,
      pairs: [
        { symbol: SYMBOLS[0]!, file: overwritten },
        { symbol: SYMBOLS[1]!, file: overwritten },
        { symbol: SYMBOLS[2]!, file: earlier },
        { symbol: 'NYSE:XOM', file: overwritten },
        { symbol: SYMBOLS[3]!, file: join(root, 'absent.txt') },
      ],
    });
    expect(results.map(({ outcome }) => outcome)).toEqual([
      'REJECTED',
      'CAPTURED',
      'REJECTED',
      'REJECTED',
      'REJECTED',
    ]);
    expect(results[0]!.detail).toMatch(`holds ${SYMBOLS[1]}, not ${SYMBOLS[0]}`);
    expect(results[2]!.detail).toMatch(/before this retrieval started/);
    expect(results[3]!.detail).toMatch(/not one of the 50 requested symbols/);
    expect(status).toMatchObject({ captured: 1, window: 'OPEN', conflicting: [] });
    expect(status.retry).toEqual(SYMBOLS.filter((symbol) => symbol !== SYMBOLS[1]));
  });

  it('retries only missing or failed symbols, then imports a complete scan that reproduces', async () => {
    const { root, ids, capture, finish } = await retrieval();
    const [first, second, , fourth] = SYMBOLS as [string, string, string, string];
    await capture(SYMBOLS.slice(2));
    await recordFailure({ ...ids, symbol: first, error: 'HTTP 429' });
    const unsuccessful = join(root, 'unsuccessful.txt');
    await writeFile(unsuccessful, JSON.stringify({ ...response(second), success: false }));
    await utimes(unsuccessful, new Date(RECEIVED), new Date(RECEIVED));
    const failed = await captureResponses({
      ...ids,
      pairs: [{ symbol: second, file: unsuccessful }],
    });
    expect(failed.results[0]!.outcome).toBe('FAILED');
    expect(failed.status.failed).toEqual([
      { symbol: first, reason: 'HTTP 429' },
      { symbol: second, reason: 'get_ohlcv did not succeed' },
    ]);
    expect(failed.status.retry).toEqual([first, second]);

    const retried = await capture([first, second]);
    expect(retried.results.map(({ outcome }) => outcome)).toEqual(['RETRIED', 'RETRIED']);
    const ignored = await recordFailure({ ...ids, symbol: fourth, error: 'late timeout' });
    expect(ignored.outcome).toBe('IGNORED');
    expect(ignored.status).toMatchObject({ captured: 50, retry: [], failed: [], missing: [] });

    const report = await finish();
    expect(report).toMatchObject({
      outcome: 'COMPLETE',
      requested: 50,
      evaluated: 50,
      failed: 0,
      failures: [],
      evaluatedSession: '2026-10-27',
      importStatus: 'IMPORTED',
      reproduction: 'MATCH',
      retrieval: { completedAt: new Date(RECEIVED).toISOString() },
    });
    expect(report.research).toContain(report.scanId);

    // Importing the same retrieval again changes nothing.
    const exported = await readFile(report.exportPath, 'utf8');
    const viewPath = join(root, 'scans', TRADINGVIEW_DEV_SCAN_FILE);
    const view = await readFile(viewPath, 'utf8');
    const duplicate = await finish();
    expect(duplicate).toMatchObject({ importStatus: 'ALREADY_IMPORTED', scanId: report.scanId });
    expect(await readFile(report.exportPath, 'utf8')).toBe(exported);
    expect(await readFile(viewPath, 'utf8')).toBe(view);
  });

  it('keeps missing and failed symbols visible as failures in a partial scan', async () => {
    const { root, ids, capture, finish } = await retrieval();
    await capture(SYMBOLS.slice(2));
    await recordFailure({ ...ids, symbol: SYMBOLS[1]!, error: 'HTTP 429' });
    await captureResponses({ ...ids, pairs: [], alerts: ['BINANCE:BTCUSDT'] });
    const report = await finish();
    expect(report).toMatchObject({ outcome: 'PARTIAL', evaluated: 48, failed: 2 });
    expect(report.reproduction).toBe('MATCH');
    expect(report.failures).toEqual([
      expect.objectContaining({ symbol: SYMBOLS[0], status: 'FETCH_FAILED' }),
      expect.objectContaining({ symbol: SYMBOLS[1], status: 'FETCH_FAILED' }),
    ]);
    expect(report.failures[0]!.detail).toMatch(/never retrieved/);
    expect(report.failures[1]!.detail).toMatch(/HTTP 429/);
    const view = parseTradingViewDevScan(
      JSON.parse(await readFile(join(root, 'scans', TRADINGVIEW_DEV_SCAN_FILE), 'utf8')),
    );
    expect(view.source.pineAlerts).toEqual({
      checkedAt: new Date(EQUITY_NOW).toISOString(),
      symbols: ['BINANCE:BTCUSDT'],
    });
  });

  it('rejects malformed input at the boundary instead of guessing', async () => {
    const { root, ids } = await retrieval();
    const notJson = join(root, 'not-json.txt');
    await writeFile(notJson, 'Error: result exceeds maximum allowed tokens');
    const { results } = await captureResponses({
      ...ids,
      pairs: [{ symbol: SYMBOLS[0]!, file: notJson }],
    });
    expect(results[0]).toMatchObject({ outcome: 'REJECTED' });
    expect(results[0]!.detail).toMatch(/not a JSON get_ohlcv response/);
    await expect(recordFailure({ ...ids, symbol: 'NYSE:XOM', error: 'x' })).rejects.toThrow(
      /not one of the 50 requested symbols/,
    );
    await expect(recordFailure({ ...ids, symbol: SYMBOLS[0]!, error: ' ' })).rejects.toThrow(
      /Record the error/,
    );
    await expect(retrievalStatus({ ...ids, retrievalId: '../elsewhere' })).rejects.toThrow(
      /not a retrieval ID/,
    );
    // A capture path that cannot be read as a file is an error, not an absent record.
    const ticker = selectDevScanUniverse()[0]!;
    await mkdir(join(ids.store, ids.retrievalId, `${ticker}.json`));
    await expect(retrievalStatus(ids)).rejects.toThrow(/EISDIR/);

    await writeFile(join(ids.store, ids.retrievalId, 'retrieval.json'), '{"schemaVersion":"2"}');
    await expect(retrievalStatus(ids)).rejects.toThrow(/unreadable retrieval.json/);
    await expect(
      startRetrieval({ store: ids.store, now: () => Date.UTC(2100, 0, 1) }),
    ).rejects.toThrow(/outside the published US equity calendar/);
  });

  it('fails a symbol with two differing responses rather than choosing one', async () => {
    const { root, ids, capture, finish } = await retrieval();
    await capture(SYMBOLS);
    const identical = await saved(root, SYMBOLS[0]!, PATHS[0]);
    const different = await saved(root, SYMBOLS[0]!, falling);
    const { results, status } = await captureResponses({
      ...ids,
      pairs: [
        { symbol: SYMBOLS[0]!, file: identical },
        { symbol: SYMBOLS[0]!, file: different },
      ],
    });
    expect(results.map(({ outcome }) => outcome)).toEqual(['DUPLICATE', 'CONFLICT']);
    expect(status).toMatchObject({ captured: 49, conflicting: [SYMBOLS[0]], retry: [] });
    const report = await finish();
    expect(report).toMatchObject({ outcome: 'PARTIAL', evaluated: 49, reproduction: 'MATCH' });
    expect(report.failures[0]!.detail).toMatch(/conflicting get_ohlcv responses/);
  });

  it('stops offering retries once a session becomes final, and the import refuses the retrieval', async () => {
    // 04:00 UTC on 28 Oct: 27 Oct turns final at 05:00 UTC, before the responses arrive.
    const { ids, capture, finish } = await retrieval(EQUITY_NOW - 13 * 3_600_000);
    const early = await retrievalStatus({ ...ids, now: () => EQUITY_NOW - 12.5 * 3_600_000 });
    expect(early).toMatchObject({ requiredSession: '2026-10-26', window: 'OPEN' });
    expect(early.validUntil).toBe('2026-10-28T05:00:00.000Z');
    const { status } = await capture(SYMBOLS);
    expect(status).toMatchObject({ window: 'CLOSED', captured: 50, retry: [] });
    const report = await finish();
    expect(report).toMatchObject({ outcome: 'REFUSED', scanId: null, reproduction: null });
    expect(report.refusal).toMatch(/became final during retrieval/);
  });
});

describe('attachBaseline', () => {
  const DAY = 86_400_000;
  /** An earlier import (26 Oct session), then the displayed one (27 Oct), in one store. */
  async function twoImports() {
    const earlier = await importInto(exportOf(undefined, EQUITY_NOW - DAY), {
      name: 'earlier.json',
      now: EQUITY_NOW - DAY + 5 * 60_000,
    });
    const displayed = await importInto(exportOf(), { store: earlier.store });
    const viewPath = join(earlier.store, TRADINGVIEW_DEV_SCAN_FILE);
    const readView = async () =>
      parseTradingViewDevScan(JSON.parse(await readFile(viewPath, 'utf8')));
    return { store: earlier.store, earlier, displayed, viewPath, readView };
  }

  it('attaches a verified earlier import, and a new import drops it', async () => {
    const { store, earlier, displayed, readView } = await twoImports();
    const { comparison } = await attachBaseline({ store, baselineId: earlier.snapshot.scanId });
    expect(comparison).toMatchObject({
      status: 'COMPARED',
      gap: { kind: 'NEXT' },
      before: { scanId: earlier.snapshot.scanId, session: '2026-10-26', evaluated: 50 },
      after: { scanId: displayed.snapshot.scanId, session: '2026-10-27', evaluated: 50 },
      onlyAfter: [],
      onlyBefore: [],
    });
    const view = await readView();
    expect(view.scan).toEqual(displayed.snapshot.scan);
    expect(view.baseline).toEqual({
      scanId: earlier.snapshot.scanId,
      importedAt: earlier.snapshot.completedAt,
      scan: earlier.snapshot.scan,
    });

    await importInto(exportOf(), { store });
    expect((await readView()).baseline).toBeUndefined();
  });

  it('refuses the displayed scan, another source, an unverified baseline or a stale view', async () => {
    const { store, earlier, displayed, viewPath, readView } = await twoImports();
    const attach = (baselineId: string) => attachBaseline({ store, baselineId });
    await expect(attach(displayed.snapshot.scanId)).rejects.toThrow(/is the displayed scan/);

    const market = await saveScan({
      inputs: [
        {
          ticker: 'BTC-USD',
          instrument: 'BINANCE:BTCUSDT',
          error: { code: 'FETCH_FAILED', detail: 'fixture' },
        },
      ],
      evaluationTime: EQUITY_NOW - DAY,
      universeSource: 'assets_status',
      equityProvider: null,
      repositoryCommit: COMMIT,
      store,
      completedAt: EQUITY_NOW - DAY,
    });
    await expect(attach(market.snapshot.scanId)).rejects.toThrow(
      /not a TradingView development import/,
    );

    const earlierPath = join(store, `${earlier.snapshot.scanId}.json`);
    const original = await readFile(earlierPath, 'utf8');
    const tampered = JSON.parse(original);
    tampered.scan.results[0].model.signal_score += 1;
    await writeFile(earlierPath, JSON.stringify(tampered));
    await expect(attach(earlier.snapshot.scanId)).rejects.toThrow(
      /does not reproduce \(OUTPUT_MISMATCH\)/,
    );
    await writeFile(earlierPath, original);

    const view = await readView();
    await writeFile(
      viewPath,
      JSON.stringify({ ...view, scan: { ...view.scan, status: 'FAILED' } }),
    );
    await expect(attach(earlier.snapshot.scanId)).rejects.toThrow(/is not snapshot/);
    expect((await readView()).baseline).toBeUndefined();
  });

  it('attaches an incompatible baseline only to say what differs', async () => {
    const { store, earlier, readView } = await twoImports();
    const earlierPath = join(store, `${earlier.snapshot.scanId}.json`);
    const older = JSON.parse(await readFile(earlierPath, 'utf8'));
    older.scan.modelVersion = '0.9.0';
    await writeFile(earlierPath, JSON.stringify(older));
    // This checkout cannot re-derive model 0.9.0; that does not matter, since nothing is compared.
    expect(await reproduceScan(earlier.snapshot.scanId, store)).toMatchObject({
      status: 'MISMATCH',
      reason: 'UNSUPPORTED_VERSION',
    });
    const { comparison } = await attachBaseline({ store, baselineId: earlier.snapshot.scanId });
    expect(comparison).toMatchObject({
      status: 'INCOMPATIBLE',
      differences: [{ field: 'Model', before: '0.9.0', after: '1.0.0' }],
    });
    expect((await readView()).baseline?.scanId).toBe(earlier.snapshot.scanId);
  });
});
