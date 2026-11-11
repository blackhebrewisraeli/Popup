import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateCandles } from '@/lib/canonicalModel';
import {
  evaluateScan,
  scanInstrument,
  SCAN_MIN_CLOSED_CANDLES,
  TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
  type MarketScan,
  type ScanAssetResult,
} from '@/lib/marketScanner';
import { compareScans } from '@/lib/scanChanges';
import {
  parseTradingViewDevScan,
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
} from '@/lib/tradingViewDevScan';
import { loadScan, reproduceScan } from './marketScanStore';
import {
  captureResponses,
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  finishRetrieval,
  importInputs,
  parseUniverse,
  recordFailure,
  retrievalStatus,
  startRetrieval,
  tradingViewCryptoCandles,
  universeSymbols,
  universeTickers,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Labeled fixtures, not market data: UTC days and synthetic price paths shaped like a
 * `get_ohlcv` 1D response for a Binance Spot USDT pair. Nothing here was fetched.
 */
const DAY = 86_400_000;
const COMMIT = 'c'.repeat(40);
/** The retrieval start, and so the frozen cutoff: Wednesday 11 Nov 2026, 18:40 UTC. */
const START = Date.UTC(2026, 10, 11, 18, 40);
const CUTOFF_DAY = Date.UTC(2026, 10, 11);
const LAST_CLOSED = CUTOFF_DAY - DAY; // 10 Nov, the day every pair must rest on.
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const SYMBOLS = universeSymbols(CRYPTO_UNIVERSE);

const wave = (i: number) => 100 + Math.sin(i / 6) * 8;
const rising = (i: number) => 50 + i * 0.4;
const falling = (i: number) => 400 - i * 0.5;
const PATHS = [wave, rising, falling];

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

/** `closed` daily bars ending on `lastClosed`, then `forming` later bars at a price no closed bar has. */
function bars(path = wave, { closed = 300, lastClosed = LAST_CLOSED, forming = 1 } = {}): Bar[] {
  const bar = (open: number, close: number): Bar => ({
    t: open / 1000,
    o: close,
    h: close * 1.01,
    l: close * 0.99,
    c: close,
    v: 1_000,
  });
  const first = lastClosed - (closed - 1) * DAY;
  return [
    ...Array.from({ length: closed }, (_, i) => bar(first + i * DAY, path(i))),
    ...Array.from({ length: forming }, (_, k) => bar(lastClosed + (k + 1) * DAY, 10_000)),
  ];
}

function response(symbol: string, rows: Bar[] = bars(), edit: Record<string, unknown> = {}) {
  return {
    success: true,
    symbol,
    interval: '1D',
    currency: 'USDT',
    description: 'Synthetic / TetherUS',
    notice: NOTICE,
    bars: rows,
    ...edit,
  };
}

let saves = 0;

async function retrieval(startedAt = START) {
  const root = await mkdtemp(join(tmpdir(), 'zerochart-tv-crypto-'));
  const store = join(root, 'tradingview');
  const scanStore = join(root, 'scans');
  const started = await startRetrieval({ store, universe: CRYPTO_UNIVERSE, now: () => startedAt });
  const ids = { store, retrievalId: started.retrievalId };
  /** A saved `get_ohlcv` result, written the way the agent's client writes one. */
  const saved = async (body: unknown, at: number) => {
    const file = join(root, `get-ohlcv-${(saves += 1)}.txt`);
    await writeFile(file, JSON.stringify(body));
    await utimes(file, new Date(at), new Date(at));
    return file;
  };
  const capture = async (
    symbols: readonly string[],
    at = startedAt + 60_000,
    body: (symbol: string, i: number) => unknown = (symbol, i) =>
      response(symbol, bars(PATHS[i % PATHS.length])),
  ) =>
    captureResponses({
      ...ids,
      now: () => at,
      pairs: await Promise.all(
        symbols.map(async (symbol, i) => ({ symbol, file: await saved(body(symbol, i), at) })),
      ),
    });
  const finish = (now = startedAt + 10 * 60_000) =>
    finishRetrieval({ ...ids, scanStore, repositoryCommit: COMMIT, now: () => now });
  return { root, store, scanStore, started, ids, saved, capture, finish };
}

const evaluated = (scan: MarketScan) =>
  scan.results.filter(
    (result): result is ScanAssetResult & { rank: number } => result.rank !== null,
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe('crypto-usdt-v1 universe', () => {
  it('freezes 25 distinct Binance Spot USDT pairs by their exact TradingView symbols', () => {
    const tickers = universeTickers(CRYPTO_UNIVERSE);
    expect(tickers).toHaveLength(25);
    expect(parseUniverse(CRYPTO_UNIVERSE)).toBe(CRYPTO_UNIVERSE);
    // The walk order recorded in docs/TRADINGVIEW_CRYPTO_SCAN.md.
    expect(Object.values(CRYPTO_TRADINGVIEW_SYMBOLS).join(' ')).toBe(
      'BINANCE:BTCUSDT BINANCE:ETHUSDT BINANCE:BNBUSDT BINANCE:XRPUSDT BINANCE:SOLUSDT BINANCE:TRXUSDT BINANCE:HYPEUSDT BINANCE:ZECUSDT BINANCE:DOGEUSDT BINANCE:LINKUSDT BINANCE:ADAUSDT BINANCE:XLMUSDT BINANCE:NEARUSDT BINANCE:BCHUSDT BINANCE:UNIUSDT BINANCE:LTCUSDT BINANCE:AVAXUSDT BINANCE:SUIUSDT BINANCE:GRAMUSDT BINANCE:HBARUSDT BINANCE:SHIBUSDT BINANCE:TAOUSDT BINANCE:QNTUSDT BINANCE:ENAUSDT BINANCE:PEPEUSDT',
    );
    const bases = new Set<string>();
    for (const [ticker, symbol] of Object.entries(CRYPTO_TRADINGVIEW_SYMBOLS)) {
      const base = /^([A-Z0-9]+)-USDT$/.exec(ticker)?.[1];
      expect(base).toBeDefined();
      // Exactly the spot pair: no perpetual (.P), no other venue, no other quote.
      expect(symbol).toBe(`BINANCE:${base}USDT`);
      expect(scanInstrument(ticker)).toBe(symbol);
      bases.add(base!);
    }
    expect(bases.size).toBe(25);
    // No stablecoin, wrapped or staked receipt, or leveraged token is a member.
    for (const base of bases) {
      expect(base).not.toMatch(
        /^(USD|DAI|W(BTC|ETH|BETH|STETH)|STETH|CBBTC|XAUT|PAXG)|(UP|DOWN|BULL|BEAR|[35][LS])$/,
      );
    }
  });

  it('keeps crypto out of both equity universes', () => {
    for (const universe of ['default', 'all'] as const) {
      expect(universeTickers(universe).some((ticker) => ticker.endsWith('-USDT'))).toBe(false);
    }
  });
});

describe('tradingViewCryptoCandles (tradingview-crypto-daily-v1)', () => {
  const symbol = 'BINANCE:BTCUSDT';

  it('reads t as the UTC-midnight opening time in seconds and closes the day 1 ms before the next', () => {
    const rows = bars(wave, { closed: 3 });
    const candles = tradingViewCryptoCandles(response(symbol, rows), { symbol, from: 0 });
    expect(candles).toHaveLength(4);
    expect(candles[2]).toMatchObject({
      timestamp: LAST_CLOSED,
      closeTime: LAST_CLOSED + DAY - 1,
      open: rows[2]!.o,
      close: rows[2]!.c,
    });
    expect(new Date(candles[3]!.timestamp).toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });

  it('refuses a perpetual, another venue, another quote or interval before reading a bar', () => {
    const read = (edit: Record<string, unknown>) => () =>
      tradingViewCryptoCandles(response(symbol, bars(), edit), { symbol, from: 0 });
    expect(read({ symbol: 'BINANCE:BTCUSDT.P' })).toThrow(/BINANCE:BTCUSDT.P, not BINANCE:BTCUSDT/);
    expect(read({ symbol: 'BINANCEUS:BTCUSDT' })).toThrow(/not BINANCE:BTCUSDT/);
    expect(read({ currency: 'USDC' })).toThrow(/quoted in USDC, not USDT/);
    expect(read({ interval: '1W' })).toThrow(/interval 1W/);
    expect(read({ success: false })).toThrow(/did not succeed/);
  });

  it('refuses millisecond or fractional stamps instead of treating them as forming bars', () => {
    const rows = bars(wave, { closed: 3 });
    const ms = rows.map((row) => ({ ...row, t: row.t * 1000 }));
    expect(() => tradingViewCryptoCandles(response(symbol, ms), { symbol, from: 0 })).toThrow(
      /not a Unix time in seconds/,
    );
    const half = rows.map((row, i) => (i === 1 ? { ...row, t: row.t + 0.5 } : row));
    expect(() => tradingViewCryptoCandles(response(symbol, half), { symbol, from: 0 })).toThrow(
      /not a Unix time in seconds/,
    );
  });
});

describe('TradingView crypto retrieval', () => {
  it('opens a window on the last completed UTC day, until the next UTC midnight', async () => {
    const { started } = await retrieval();
    expect(started).toMatchObject({
      universe: CRYPTO_UNIVERSE,
      requiredSession: '2026-11-10',
      validUntil: '2026-11-12T00:00:00.000Z',
      window: 'OPEN',
      requested: 25,
      captured: 0,
    });
    expect(started.retry).toEqual(SYMBOLS);
  });

  it(
    'scores every pair on the last 199 closed UTC days at the frozen cutoff and reproduces offline',
    { timeout: 60_000 },
    async () => {
      const { capture, finish, scanStore } = await retrieval();
      await capture(SYMBOLS);
      const network = vi.spyOn(globalThis, 'fetch');
      const report = await finish();
      expect(report).toMatchObject({
        universe: CRYPTO_UNIVERSE,
        outcome: 'COMPLETE',
        requested: 25,
        evaluated: 25,
        failed: 0,
        failures: [],
        evaluatedSession: '2026-11-10',
        reproduction: 'MATCH',
        viewStatus: 'PUBLISHED',
      });
      expect(network).not.toHaveBeenCalled();

      const snapshot = await loadScan(report.scanId!, scanStore);
      const { scan } = snapshot;
      expect(scan.evaluationTime).toBe(START);
      expect(scan.cohorts).toEqual([
        expect.objectContaining({
          assetClass: 'crypto',
          provider: TRADINGVIEW_DEV_PROVIDER_ID,
          candlePolicyVersion: TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION,
          calendar: 'UTC days, 24/7',
          minClosedCandles: SCAN_MIN_CLOSED_CANDLES,
          status: 'COMPLETE',
          dataAsOf: { oldest: LAST_CLOSED + DAY - 1, newest: LAST_CLOSED + DAY - 1 },
        }),
      ]);
      // 300 closed bars were returned; the score rests on the last 199, never the forming one.
      for (const result of evaluated(scan)) {
        expect(result.closedCandles).toBe(199);
        expect(result.instrument).toBe(CRYPTO_TRADINGVIEW_SYMBOLS[result.ticker]);
        expect(result.providerSymbol).toEqual({
          requested: CRYPTO_TRADINGVIEW_SYMBOLS[result.ticker],
          validated: CRYPTO_TRADINGVIEW_SYMBOLS[result.ticker],
        });
      }
      const btc = snapshot.inputs.find((input) => input.ticker === 'BTC-USDT')!;
      const closed = btc.candles!.filter((candle) => candle.closeTime <= START);
      expect(btc.candles!.length - closed.length).toBe(1); // the forming 11 Nov bar, kept as evidence
      const direct = evaluateCandles(closed.slice(-199));
      expect(evaluated(scan).find((result) => result.ticker === 'BTC-USDT')!.model).toEqual(direct);

      // Ranks: score descending, then ticker, and the same inputs always give the same order.
      const ranked = evaluated(scan);
      expect(ranked.map((result) => result.rank)).toEqual(ranked.map((_, i) => i + 1));
      const again = evaluateScan([...snapshot.inputs].reverse(), {
        evaluationTime: scan.evaluationTime,
        universeSource: scan.universe.source,
        cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
      });
      expect(again).toEqual(scan);
      expect(await reproduceScan(report.scanId!, scanStore)).toEqual({
        status: 'MATCH',
        scanId: report.scanId,
      });
      expect(network).not.toHaveBeenCalled();

      // Finishing again is idempotent: the same snapshot, a byte-identical view.
      const view = await readFile(join(scanStore, TRADINGVIEW_DEV_SCAN_FILE), 'utf8');
      expect(parseTradingViewDevScan(JSON.parse(view)).source.selectionRule).toMatch(
        /crypto-usdt-v1/,
      );
      await expect(finish(START + 20 * 60_000)).resolves.toMatchObject({
        importStatus: 'ALREADY_IMPORTED',
        scanId: report.scanId,
      });
      expect(await readFile(join(scanStore, TRADINGVIEW_DEV_SCAN_FILE), 'utf8')).toBe(view);
    },
  );

  it(
    'keeps one frozen cutoff when retrieval crosses UTC midnight, so the newer day never enters',
    { timeout: 60_000 },
    async () => {
      const lateStart = Date.UTC(2026, 10, 11, 23, 55);
      const crossing = await retrieval(lateStart);
      // Half before midnight (11 Nov forming), half after (11 Nov final, 12 Nov forming),
      // with different 11 Nov values: neither may reach the model.
      await crossing.capture(SYMBOLS.slice(0, 12), lateStart + 60_000);
      const after = Date.UTC(2026, 10, 12, 0, 5);
      const { status } = await crossing.capture(SYMBOLS.slice(12), after, (symbol, i) =>
        response(symbol, bars(PATHS[(i + 12) % PATHS.length], { forming: 2 })),
      );
      expect(status).toMatchObject({ window: 'CLOSED', captured: 25, retry: [] });
      const report = await crossing.finish(after + 60_000);
      expect(report).toMatchObject({
        outcome: 'COMPLETE',
        evaluated: 25,
        evaluatedSession: '2026-11-10',
        reproduction: 'MATCH',
      });

      // The same pairs retrieved entirely before midnight score identically.
      const control = await retrieval(lateStart);
      await control.capture(SYMBOLS, lateStart + 60_000);
      const baseline = await control.finish(lateStart + 120_000);
      const scores = async (scanId: string, store: string) =>
        evaluated((await loadScan(scanId, store)).scan).map((result) => [
          result.ticker,
          result.model?.signal_score,
          result.dataAsOf,
        ]);
      expect(await scores(report.scanId!, crossing.scanStore)).toEqual(
        await scores(baseline.scanId!, control.scanStore),
      );
    },
  );

  it(
    'accounts for every member: missing, failed and invalid pairs stay in the scan with reasons',
    { timeout: 60_000 },
    async () => {
      const { ids, capture, finish } = await retrieval();
      const [btc, eth, bnb, xrp, sol, trx, hype, zec] = [
        'BTC',
        'ETH',
        'BNB',
        'XRP',
        'SOL',
        'TRX',
        'HYPE',
        'ZEC',
      ].map((base) => `BINANCE:${base}USDT`);
      const bySymbol = (symbol: string) => SYMBOLS.indexOf(symbol);
      const special: Record<string, Bar[]> = {
        // A day missing inside the window.
        [btc!]: bars().filter((_, i) => i !== 250),
        // A duplicated day.
        [eth!]: [...bars().slice(0, 280), bars()[279]!, ...bars().slice(280)],
        // An opening time an hour after midnight.
        [bnb!]: bars().map((bar, i) => (i === 290 ? { ...bar, t: bar.t + 3600 } : bar)),
        // High below low.
        [xrp!]: bars().map((bar, i) => (i === 295 ? { ...bar, h: bar.l * 0.9 } : bar)),
        // The latest day (10 Nov) is missing: stale at the cutoff, never forward-filled.
        [sol!]: bars(wave, { lastClosed: LAST_CLOSED - DAY, forming: 0 }),
        // A young listing: 150 closed days.
        [trx!]: bars(wave, { closed: 150 }),
      };
      const others = SYMBOLS.filter((symbol) => symbol !== hype && symbol !== zec);
      await capture(others, START + 60_000, (symbol) =>
        response(symbol, special[symbol] ?? bars(PATHS[bySymbol(symbol) % PATHS.length])),
      );
      await recordFailure({
        ...ids,
        symbol: hype!,
        error: 'Symbol not found',
        now: () => START + 70_000,
      });
      const status = await retrievalStatus({ ...ids, now: () => START + 80_000 });
      expect(status).toMatchObject({ captured: 23, missing: [zec], retry: [zec, hype] });

      const report = await finish();
      expect(report).toMatchObject({
        outcome: 'PARTIAL',
        requested: 25,
        evaluated: 17,
        failed: 8,
        reproduction: 'MATCH',
      });
      const why = Object.fromEntries(
        report.failures.map(({ symbol, status: code, detail }) => [symbol, `${code} ${detail}`]),
      );
      expect(Object.keys(why).sort()).toEqual([btc, eth, bnb, xrp, sol, trx, hype, zec].sort());
      expect(why[btc!]).toMatch(/DATA_INVALID tradingview-crypto-daily-v1: MISSING_DAILY_INTERVAL/);
      expect(why[eth!]).toMatch(/DATA_INVALID .*DUPLICATE_TIMESTAMP/);
      expect(why[bnb!]).toMatch(/DATA_INVALID .*TIMESTAMP_NOT_UTC_DAY_ALIGNED/);
      expect(why[xrp!]).toMatch(/DATA_INVALID .*HIGH_BELOW_LOW/);
      expect(why[sol!]).toMatch(/STALE_DATA .*not on the last UTC day completed before the cutoff/);
      expect(why[trx!]).toMatch(/INSUFFICIENT_HISTORY 150 closed daily candles/);
      expect(why[hype!]).toMatch(/FETCH_FAILED .*Symbol not found/);
      expect(why[zec!]).toMatch(/FETCH_FAILED .*never retrieved/);
    },
  );

  it('rejects a wrong instrument at capture and fails a symbol with two differing responses', async () => {
    const { capture, finish } = await retrieval();
    const [btc, eth] = ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'];
    const { results } = await capture([btc!, eth!], START + 60_000, (symbol) =>
      response(symbol === btc ? 'BINANCE:BTCUSDT.P' : symbol),
    );
    expect(results.map(({ outcome }) => outcome)).toEqual(['REJECTED', 'CAPTURED']);
    expect(results[0]!.detail).toMatch(/holds BINANCE:BTCUSDT.P, not BINANCE:BTCUSDT/);

    const conflict = await capture([eth!], START + 90_000, (symbol) =>
      response(symbol, bars(rising)),
    );
    expect(conflict.results[0]!.outcome).toBe('CONFLICT');
    const report = await finish();
    expect(report.failures.find(({ symbol }) => symbol === eth)!.detail).toMatch(
      /conflicting get_ohlcv responses/,
    );
  });

  it('refuses a hand-built export whose entry names another venue', () => {
    const file: TradingViewOhlcvExport = {
      schemaVersion: '1',
      source: 'tradingview-mcp',
      universe: CRYPTO_UNIVERSE,
      retrieval: {
        startedAt: new Date(START).toISOString(),
        completedAt: new Date(START + 60_000).toISOString(),
      },
      instruments: [
        {
          ticker: 'BTC-USDT',
          symbol: 'BINANCEUS:BTCUSDT',
          receivedAt: new Date(START + 30_000).toISOString(),
          response: response('BINANCEUS:BTCUSDT'),
        },
      ],
    };
    const btc = importInputs(file, START).find((input) => input.ticker === 'BTC-USDT');
    expect(btc).toMatchObject({
      ticker: 'BTC-USDT',
      providerSymbol: { requested: 'BINANCEUS:BTCUSDT', validated: null },
      error: { code: 'DATA_INVALID' },
    });
    expect(btc!.candles).toBeUndefined();
  });
});

describe('comparing crypto scans', () => {
  const scanOn = (lastClosed: number, evaluationTime: number) =>
    evaluateScan(
      ['BTC-USDT', 'ETH-USDT'].map((ticker, i) => ({
        ticker,
        instrument: scanInstrument(ticker),
        providerSymbol: {
          requested: `BINANCE:${ticker.replace('-', '')}`,
          validated: `BINANCE:${ticker.replace('-', '')}`,
        },
        candles: tradingViewCryptoCandles(
          response(`BINANCE:${ticker.replace('-', '')}`, bars(PATHS[i], { lastClosed })),
          { symbol: `BINANCE:${ticker.replace('-', '')}`, from: 0 },
        ),
      })),
      {
        evaluationTime,
        universeSource: 'tradingview-dev-scan',
        cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
      },
    );

  it('counts the UTC days between two readings, weekends included', () => {
    const friday = Date.UTC(2026, 10, 6);
    const before = scanOn(friday, friday + DAY + 3_600_000);
    const after = scanOn(LAST_CLOSED, START);
    const comparison = compareScans(
      { scanId: 'after', scan: after },
      { scanId: 'before', scan: before },
    );
    expect(comparison).toMatchObject({
      status: 'COMPARED',
      before: { session: '2026-11-06', utcDays: true },
      after: { session: '2026-11-10', utcDays: true },
      gap: { kind: 'GAP', skipped: ['2026-11-07', '2026-11-08', '2026-11-09'] },
    });
  });

  it('never compares a crypto scan with an equity scan, or with the live Binance scan', () => {
    const crypto = scanOn(LAST_CLOSED, START);
    const equity = {
      ...crypto,
      cohorts: crypto.cohorts.map((cohort) => ({ ...cohort, assetClass: 'equity' as const })),
    };
    const vsEquity = compareScans({ scanId: 'b', scan: crypto }, { scanId: 'a', scan: equity });
    expect(vsEquity.status).toBe('INCOMPATIBLE');
    expect(
      vsEquity.status === 'INCOMPATIBLE' && vsEquity.differences.map((d) => d.field),
    ).toContain('Asset class');
    const live = {
      ...crypto,
      evaluationTime: START - DAY,
      cohorts: crypto.cohorts.map((cohort) => ({
        ...cohort,
        provider: 'binance-spot-klines',
        candlePolicyVersion: 'binance-daily-v1',
      })),
    };
    const vsLive = compareScans({ scanId: 'b', scan: crypto }, { scanId: 'a', scan: live });
    expect(vsLive.status === 'INCOMPATIBLE' && vsLive.differences.map((d) => d.field)).toEqual(
      expect.arrayContaining(['Source', 'Candle policy']),
    );
  });
});

describe('boundaries', () => {
  it('holds no account credential, reads no account endpoint and places no order', async () => {
    for (const file of ['tradingViewImport.ts', 'marketScanStore.ts', 'tradingViewSavedScans.ts']) {
      const source = await readFile(join(__dirname, file), 'utf8');
      expect(source).not.toMatch(
        /api\/v3\/(order|account|myTrades)|X-MBX-APIKEY|BINANCE_API|integrations\/supabase/i,
      );
    }
  });
});
