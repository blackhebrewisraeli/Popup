import { atr, macd, rsi, sma, type MacdResult } from './indicators';
import { computeBacktest, type BacktestOptions, type BacktestResult } from './backtestManager';
import { evaluateCandles, type CanonicalResult, type EngineCandle } from './canonicalModel';
import { evaluateScan, type MarketScan, type ScanInput } from './marketScanner';
import { checkSavedScanFile, type SavedScanFileCheck } from './savedScanFile';

/** Requests with a synchronous, cacheable answer. */
type ComputeRequest =
  | { kind: 'sma'; values: number[]; period: number }
  | { kind: 'rsi'; values: number[]; period: number }
  | { kind: 'macd'; values: number[]; fast: number; slow: number; signalPeriod: number }
  | { kind: 'atr'; highs: number[]; lows: number[]; closes: number[]; period: number }
  | ({ kind: 'backtest' } & BacktestOptions)
  | { kind: 'canonical'; candles: readonly EngineCandle[] }
  | {
      kind: 'marketScan';
      inputs: readonly ScanInput[];
      options: Parameters<typeof evaluateScan>[1];
    };

/** A saved crypto scan file's original bytes, hashed and reproduced offline (src/lib/savedScanFile.ts). */
type SavedScanFileRequest = { kind: 'savedScanFile'; bytes: ArrayBuffer };

export type FinanceRequest = ComputeRequest | SavedScanFileRequest;

type ComputeResult = Float64Array | MacdResult | BacktestResult | CanonicalResult | MarketScan;

export type FinanceResult = ComputeResult | SavedScanFileCheck;

/** Dispatches a request to the matching pure core function. */
export function computeFinance(request: ComputeRequest): ComputeResult {
  switch (request.kind) {
    case 'sma':
      return sma(request.values, request.period);
    case 'rsi':
      return rsi(request.values, request.period);
    case 'macd':
      return macd(request.values, request.fast, request.slow, request.signalPeriod);
    case 'atr':
      return atr(request.highs, request.lows, request.closes, request.period);
    case 'backtest':
      return computeBacktest(request);
    case 'canonical':
      return evaluateCandles(request.candles);
    case 'marketScan':
      return evaluateScan(request.inputs, request.options);
  }
}

/** Deterministic cache key for a request (enables O(1) Map lookups). */
export function cacheKey(request: ComputeRequest): string {
  return JSON.stringify(request);
}

/** In-memory request cache used inside the Web Worker. */
export class FinanceCache {
  private readonly store = new Map<string, ComputeResult>();

  get(key: string): ComputeResult | undefined {
    return this.store.get(key);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  set(key: string, value: ComputeResult): void {
    this.store.set(key, value);
  }

  get size(): number {
    return this.store.size;
  }
}

/** Computes a result, returning the cached value when the inputs are identical. */
export function computeWithCache(
  request: ComputeRequest,
  cache: FinanceCache,
): { value: ComputeResult; cached: boolean } {
  const key = cacheKey(request);
  const cached = cache.get(key);
  if (cached !== undefined) return { value: cached, cached: true };

  const value = computeFinance(request);
  cache.set(key, value);
  return { value, cached: false };
}

/**
 * One request as the worker (or, without one, the main thread) answers it. A saved-file check is
 * asynchronous (Web Crypto) and never cached: its key would keep the file's bytes alive after the
 * owner closes it.
 */
export async function handleFinanceRequest(
  request: FinanceRequest,
  cache: FinanceCache | null,
): Promise<FinanceResult> {
  if (request.kind === 'savedScanFile') return checkSavedScanFile(request.bytes);
  // Async, so a synchronous throw here rejects and the worker still answers with its ID.
  return cache ? computeWithCache(request, cache).value : computeFinance(request);
}
