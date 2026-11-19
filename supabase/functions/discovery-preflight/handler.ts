// Read-only Binance reachability preflight for daily discovery (docs/MARKET_SCANNER.md#activation),
// run in the Supabase Edge runtime and region the scheduled feeds use. It requests the policy's two
// public endpoints once each and answers with status, timing, region and aggregate structure
// counts only: never a symbol, volume or response body.
//
// It holds no database client, so it cannot write anything. Callers need a project secret key,
// as for the scheduled feeds. It requests only the two fixed URLs, whatever the request carries,
// so it is not a proxy. Pure: no Deno or Supabase imports, so vitest covers it.

/** Exactly `DISCOVERY_POLICY.source`'s two endpoints, pinned by a test. */
export const PREFLIGHT_ENDPOINTS = {
  exchangeInfo: 'https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT',
  ticker: 'https://api.binance.com/api/v3/ticker/24hr?type=MINI',
} as const;

/** Where the scheduled feeds run (x-region), next to the database. Anywhere else is refused. */
export const PREFLIGHT_REGION = 'eu-west-1';

/** The collector's per-request bound; one try each, so a failure is reported, not retried away. */
export const PREFLIGHT_TIMEOUT_MS = 30_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DECIMAL = /^\d{1,30}(\.\d{1,30})?$/;
const SYMBOL_TEXT = /^[^\p{Cc}\p{Cf}\p{Z}]{1,40}$/u;

export type PreflightOutcome =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'not_json'
  | 'invalid_structure'
  | 'not_requested';

export interface EndpointResult {
  status: number | null;
  durationMs: number | null;
  outcome: PreflightOutcome;
}

export interface ExchangeInfoResult extends EndpointResult {
  listedSymbols: number | null;
  /** Readable USDT-quoted instruments. */
  usdtInstruments: number | null;
  /** Of those, TRADING with spot trading allowed. */
  tradingSpotUsdt: number | null;
  /** Unreadable entries, as the collector counts them (duplicates aside). */
  malformedInstruments: number | null;
}

export interface TickerResult extends EndpointResult {
  entries: number | null;
  /** TRADING spot USDT pairs with exactly one decimal quoteVolume over a current 24-hour window. */
  validFigures: number | null;
  /** TRADING spot USDT pairs without one. */
  invalidFigures: number | null;
}

export interface PreflightReport {
  region: string;
  checkedAt: string;
  /** Both answered HTTP 200 with the expected structure. */
  reachable: boolean;
  exchangeInfo: ExchangeInfoResult;
  ticker: TickerResult;
}

export interface PreflightDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
  log: (line: string) => void;
  timeoutMs?: number;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSymbolText = (value: unknown): value is string =>
  typeof value === 'string' && SYMBOL_TEXT.test(value);

/** By name: AbortSignal.timeout rejects with a DOMException, not always an Error instance. */
const isTimeout = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  ['TimeoutError', 'AbortError'].includes(String((error as { name?: unknown }).name));

function secretKeys(env: PreflightDeps['env']): unknown[] {
  try {
    const keys: unknown = JSON.parse(env('SUPABASE_SECRET_KEYS') ?? '{}');
    return isRecord(keys) ? Object.values(keys) : [];
  } catch {
    return [];
  }
}

interface Fetched {
  result: EndpointResult;
  body?: unknown;
  requestedAt: number;
  receivedAt: number;
}

/** One GET, never retried. Only a 200 with a JSON body is `ok`. */
async function request(url: string, deps: PreflightDeps): Promise<Fetched> {
  const requestedAt = deps.now();
  const done = (outcome: PreflightOutcome, status: number | null, body?: unknown): Fetched => {
    const receivedAt = deps.now();
    return {
      result: { status, durationMs: receivedAt - requestedAt, outcome },
      body,
      requestedAt,
      receivedAt,
    };
  };
  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? PREFLIGHT_TIMEOUT_MS),
    });
  } catch (error) {
    return done(isTimeout(error) ? 'timeout' : 'network_error', null);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return done('http_error', response.status);
  }
  try {
    return done('ok', 200, (await response.json()) as unknown);
  } catch (error) {
    return done(isTimeout(error) ? 'timeout' : 'not_json', 200);
  }
}

/** exchangeInfo counts, and the TRADING spot USDT symbols the ticker check needs; null if not one. */
export function summarizeExchangeInfo(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body['symbols'])) return null;
  const serverTime = body['serverTime'];
  if (typeof serverTime !== 'number' || !Number.isSafeInteger(serverTime) || serverTime <= 0) {
    return null;
  }
  let usdtInstruments = 0;
  let malformedInstruments = 0;
  const tradable: string[] = [];
  for (const entry of body['symbols']) {
    if (
      !isRecord(entry) ||
      !isSymbolText(entry['symbol']) ||
      typeof entry['quoteAsset'] !== 'string'
    ) {
      malformedInstruments += 1;
      continue;
    }
    if (entry['quoteAsset'] !== 'USDT') continue;
    const { baseAsset, status, isSpotTradingAllowed } = entry;
    if (!isSymbolText(baseAsset) || typeof status !== 'string' || status === '') {
      malformedInstruments += 1;
      continue;
    }
    if (typeof isSpotTradingAllowed !== 'boolean') {
      malformedInstruments += 1;
      continue;
    }
    usdtInstruments += 1;
    if (status === 'TRADING' && isSpotTradingAllowed) tradable.push(entry['symbol']);
  }
  return {
    listedSymbols: body['symbols'].length,
    usdtInstruments,
    tradingSpotUsdt: tradable.length,
    malformedInstruments,
    tradable,
  };
}

/** The collector's figure rules: decimal quoteVolume, an exact 24-hour window, current at receipt. */
function figureValid(
  raw: Record<string, unknown>,
  at: { requestedAt: number; receivedAt: number },
) {
  const { quoteVolume, openTime, closeTime } = raw;
  return (
    typeof quoteVolume === 'string' &&
    DECIMAL.test(quoteVolume) &&
    typeof openTime === 'number' &&
    typeof closeTime === 'number' &&
    Number.isSafeInteger(openTime) &&
    Number.isSafeInteger(closeTime) &&
    openTime > 0 &&
    closeTime - openTime === DAY &&
    closeTime <= at.receivedAt + MINUTE &&
    closeTime >= at.requestedAt - HOUR
  );
}

/** Ticker counts for `symbols`; null when the body is not a list. */
export function summarizeTickers(
  body: unknown,
  symbols: readonly string[],
  at: { requestedAt: number; receivedAt: number },
) {
  if (!Array.isArray(body)) return null;
  const wanted = new Set(symbols);
  const found = new Map<string, Record<string, unknown>[]>();
  for (const entry of body) {
    if (!isRecord(entry) || typeof entry['symbol'] !== 'string' || !wanted.has(entry['symbol'])) {
      continue;
    }
    found.set(entry['symbol'], [...(found.get(entry['symbol']) ?? []), entry]);
  }
  let validFigures = 0;
  for (const symbol of wanted) {
    const entries = found.get(symbol) ?? [];
    if (entries.length === 1 && entries[0] && figureValid(entries[0], at)) validFigures += 1;
  }
  return { entries: body.length, validFigures, invalidFigures: wanted.size - validFigures };
}

/** exchangeInfo's result, and its TRADING spot USDT pairs when it passed. */
async function checkExchangeInfo(
  deps: PreflightDeps,
): Promise<{ result: ExchangeInfoResult; tradable: string[] | null }> {
  const info = await request(PREFLIGHT_ENDPOINTS.exchangeInfo, deps);
  const parsed = info.result.outcome === 'ok' ? summarizeExchangeInfo(info.body) : null;
  // No TRADING spot USDT pair at all would leave nothing for the ticker check to judge.
  const passed = parsed !== null && parsed.tradingSpotUsdt > 0;
  return {
    result: {
      ...info.result,
      outcome: info.result.outcome === 'ok' && !passed ? 'invalid_structure' : info.result.outcome,
      listedSymbols: parsed?.listedSymbols ?? null,
      usdtInstruments: parsed?.usdtInstruments ?? null,
      tradingSpotUsdt: parsed?.tradingSpotUsdt ?? null,
      malformedInstruments: parsed?.malformedInstruments ?? null,
    },
    tradable: passed ? parsed.tradable : null,
  };
}

/** The ticker's result, judged against exchangeInfo's pairs; not requested without them. */
async function checkTicker(deps: PreflightDeps, tradable: string[] | null): Promise<TickerResult> {
  if (!tradable) {
    return {
      status: null,
      durationMs: null,
      outcome: 'not_requested',
      entries: null,
      validFigures: null,
      invalidFigures: null,
    };
  }
  const fetched = await request(PREFLIGHT_ENDPOINTS.ticker, deps);
  const summary =
    fetched.result.outcome === 'ok' ? summarizeTickers(fetched.body, tradable, fetched) : null;
  const valid = summary !== null && summary.validFigures > 0;
  return {
    ...fetched.result,
    outcome:
      fetched.result.outcome === 'ok' && !valid ? 'invalid_structure' : fetched.result.outcome,
    entries: summary?.entries ?? null,
    validFigures: summary?.validFigures ?? null,
    invalidFigures: summary?.invalidFigures ?? null,
  };
}

/**
 * POST with a project secret key, in eu-west-1: requests both endpoints, exchangeInfo first like
 * the collector, and answers 200 when both pass, 502 otherwise. Anything else is refused before
 * Binance is asked.
 */
export async function handleDiscoveryPreflight(
  req: Request,
  deps: PreflightDeps,
): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !secretKeys(deps.env).includes(apikey))
    return json({ error: 'Unauthorized' }, 401);
  const region = deps.env('SB_REGION') ?? null;
  if (region !== PREFLIGHT_REGION) {
    // 421: this request reached a function instance in the wrong region.
    return json({ error: 'Wrong region', region, expected: PREFLIGHT_REGION }, 421);
  }

  const checkedAt = new Date(deps.now()).toISOString();
  const { result: exchangeInfo, tradable } = await checkExchangeInfo(deps);
  const ticker = await checkTicker(deps, tradable);
  const reachable = exchangeInfo.outcome === 'ok' && ticker.outcome === 'ok';
  const report: PreflightReport = { region, checkedAt, reachable, exchangeInfo, ticker };
  deps.log(JSON.stringify({ fn: 'discovery-preflight', event: 'preflight', ...report }));
  return json(report, reachable ? 200 : 502);
}
