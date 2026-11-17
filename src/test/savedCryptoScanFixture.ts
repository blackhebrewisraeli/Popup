import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candle } from '@/lib/binance';
import type { ScanInput } from '@/lib/marketScanner';
import type { ScanSnapshot } from '@/lib/scanSnapshot';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { saveScan } from '../../scripts/marketScanStore';

/**
 * Labeled synthetic data, not market data: two invented ZCT pairs on UTC days, saved as a
 * TradingView crypto snapshot by the scan store's own `saveScan`, exactly as an import writes it.
 * Nothing here was fetched.
 */
export const DAY = 86_400_000;
export const FIXTURE_TODAY = Date.UTC(2026, 9, 28);
/** The frozen cutoff: 28 Oct 2026, 17:00 UTC. */
export const FIXTURE_NOW = FIXTURE_TODAY + 17 * 60 * 60_000;
export const FIXTURE_COMMIT = 'c0de'.repeat(10);

export function fixtureCandles(path: (i: number) => number, spread: number, count = 201): Candle[] {
  const first = FIXTURE_TODAY - count * DAY;
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

export function fixturePair(ticker: string, rows: Candle[]): ScanInput {
  const symbol = `BINANCE:${ticker.replace('-', '')}`;
  return {
    ticker,
    instrument: symbol,
    providerSymbol: { requested: symbol, validated: symbol },
    candles: rows,
  };
}

export const FIXTURE_INPUTS: readonly ScanInput[] = [
  fixturePair(
    'ZCTLONG-USDT',
    fixtureCandles((i) => 100 * Math.pow(0.995, Math.min(i, 192)), 0.005),
  ),
  fixturePair(
    'ZCTWAVE-USDT',
    fixtureCandles((i) => 100 + Math.sin(i / 6) * 8, 0.01),
  ),
];

/** Saves the inputs as a TradingView crypto snapshot in a fresh store; the file's bytes as written. */
export async function savedCryptoSnapshot(
  inputs: readonly ScanInput[] = FIXTURE_INPUTS,
  options: { cryptoProvider?: string; universeSource?: string } = {},
): Promise<{ store: string; path: string; bytes: Buffer; snapshot: ScanSnapshot }> {
  const store = join(await mkdtemp(join(tmpdir(), 'zerochart-file-')), 'scans');
  const { path, snapshot } = await saveScan({
    inputs,
    evaluationTime: FIXTURE_NOW,
    universeSource: options.universeSource ?? TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    equityProvider: null,
    cryptoProvider: options.cryptoProvider ?? TRADINGVIEW_DEV_PROVIDER_ID,
    repositoryCommit: FIXTURE_COMMIT,
    store,
    completedAt: FIXTURE_NOW + 60_000,
  });
  return { store, path, bytes: await readFile(path), snapshot };
}

/** A Node Buffer's own bytes as an ArrayBuffer, as `File.arrayBuffer()` hands them over. */
export const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
