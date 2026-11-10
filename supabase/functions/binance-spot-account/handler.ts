// Owner-only, read-only Binance Spot account records (docs/BINANCE_SPOT_ACCOUNT.md).
// Free of Deno globals so vitest covers it from src/test; index.ts wires the env.
//
// The whole Binance surface of this integration is the four GET requests in
// ENDPOINTS. There is no order, cancel, withdrawal or transfer call, and
// `binanceGet` cannot send another method or reach another host or path.
//
// Binance references (read 2026-11-10):
//   Signing, timestamp, recvWindow:
//     https://developers.binance.com/docs/binance-spot-api-docs/rest-api/request-security
//   GET /api/v3/account:
//     https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints
//   GET /api/v3/time:
//     https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-endpoints
//   429 / 418 / Retry-After:
//     https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
//   GET /sapi/v1/account/apiRestrictions:
//     https://developers.binance.com/docs/wallet/account/api-key-permission
//   GET /api/v3/myTrades:
//     https://developers.binance.com/docs/binance-spot-api-docs/rest-api/account-endpoints

const BINANCE_ORIGIN = 'https://api.binance.com';

/** Every Binance request this function can make. All are GET. */
export const ENDPOINTS = {
  time: '/api/v3/time',
  keyPermissions: '/sapi/v1/account/apiRestrictions',
  account: '/api/v3/account',
  trades: '/api/v3/myTrades',
} as const;

/** Binance's default, and the value it recommends not exceeding. Never widened. */
export const RECV_WINDOW_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;

/**
 * The account-history surface is deliberately smaller than Binance's symbol
 * catalogue. This is the app's existing explicitly-known crypto set, mapped
 * through src/lib/ticker.ts to Spot USDT pairs. It is not complete account
 * coverage and must never be described that way.
 */
export const SUPPORTED_EXECUTION_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'LTCUSDT',
] as const;
const SUPPORTED_EXECUTION_SYMBOL_SET = new Set<string>(SUPPORTED_EXECUTION_SYMBOLS);
export const EXECUTION_PAGE_LIMIT = 100;
export const MAX_EXECUTION_RANGE_MS = 24 * 60 * 60 * 1000;
const MAX_SELECTED_EXECUTION_SYMBOLS = 4;
const CONTINUATION_VERSION = 1;

/** Documented key capabilities that must all be reported, and reported off. */
const MUST_BE_OFF = [
  'enableSpotAndMarginTrading',
  'enableWithdrawals',
  'enableInternalTransfer',
  'permitsUniversalTransfer',
  'enableMargin',
  'enableFutures',
  'enableVanillaOptions',
  'enablePortfolioMarginTrading',
  'enableFixApiTrade',
] as const;
/** Flags that may be on. Any other flag that is on refuses the key, including ones added later. */
const MAY_BE_ON = new Set(['enableReading', 'enableFixReadOnly', 'ipRestrict']);

export interface SpotBalance {
  asset: string;
  /** Decimal strings exactly as Binance sent them; never parsed to a float. */
  free: string;
  locked: string;
}

export interface SpotExecution {
  symbol: string;
  /** Decimal integer strings avoid losing 64-bit Binance identifiers in JSON clients. */
  tradeId: string;
  orderId: string;
  time: number;
  side: 'buy' | 'sell';
  /** Decimal strings exactly as Binance sent them; never parsed to a float. */
  quantity: string;
  price: string;
  quoteQuantity: string;
  commission: string;
  commissionAsset: string;
}

export interface SpotExecutionFailure {
  symbol: string;
  error: Exclude<SpotErrorCode, 'unauthenticated' | 'forbidden'>;
  retryAfterSeconds?: number;
}

export interface SpotExecutionCoverage {
  symbols: string[];
  startTime: number;
  endTime: number;
  returned: number;
  retrievedAt: string;
  hasMore: boolean;
  partial: boolean;
  failures: SpotExecutionFailure[];
  /** Binance documents symbol-scoped, finite requests, not lifetime completeness. */
  limitation: 'selected_pairs_and_24h_window';
}

export type SpotErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  | 'binance_auth'
  | 'permissions_refused'
  | 'permissions_unverified'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'malformed_response'
  | 'provider_error';

export type SpotAccountResponse =
  | { state: 'connected'; readAt: string; balances: SpotBalance[] }
  | {
      state: 'executions';
      executions: SpotExecution[];
      coverage: SpotExecutionCoverage;
      continuation?: string;
    }
  | { state: 'not_configured' }
  | {
      state: 'error';
      error: SpotErrorCode;
      retryAfterSeconds?: number;
      /** For permissions_refused: the capability names Binance reports as enabled. */
      enabled?: string[];
    };

export interface AccountDeps {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  /** One JSON line per request. Never given a key, secret, token, signature or balance. */
  log: (line: string) => void;
  now?: () => number;
}

interface ExecutionRequest {
  action: 'executions';
  symbols?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  continuation?: unknown;
}

interface ContinuationState {
  v: number;
  symbols: string[];
  startTime: number;
  endTime: number;
  nextBySymbol: Record<string, string>;
}

class Failure extends Error {
  constructor(
    readonly code: SpotErrorCode,
    readonly extra: { retryAfterSeconds?: number; enabled?: string[]; providerCode?: number } = {},
  ) {
    super(code);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STATUS: Record<SpotErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  rate_limited: 429,
  timeout: 504,
  binance_auth: 502,
  permissions_refused: 502,
  permissions_unverified: 502,
  network: 502,
  malformed_response: 502,
  provider_error: 502,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 'read_only' only when Binance reports reading on and every documented trading,
 * withdrawal and transfer capability off. The account's own `canTrade` flag
 * describes the account, not the key, and is never consulted.
 */
export function checkKeyPermissions(
  body: unknown,
):
  { verdict: 'read_only' } | { verdict: 'refused'; enabled: string[] } | { verdict: 'unverified' } {
  if (!isRecord(body)) return { verdict: 'unverified' };
  const enabled = Object.keys(body)
    .filter((name) => body[name] === true && !MAY_BE_ON.has(name))
    .sort((a, b) => a.localeCompare(b));
  if (enabled.length > 0) return { verdict: 'refused', enabled };
  if (body['enableReading'] !== true) return { verdict: 'unverified' };
  if (MUST_BE_OFF.some((name) => body[name] !== false)) return { verdict: 'unverified' };
  return { verdict: 'read_only' };
}

const DECIMAL = /^\d+(\.\d+)?$/;
const ZERO = /^0+(\.0+)?$/;
const DECIMAL_INTEGER = /^\d+$/;

function isSafeId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const isDecimal = (value: unknown): value is string =>
  typeof value === 'string' && DECIMAL.test(value);

/** One documented myTrades row, exactly as Binance wrote it, or null when it is not that shape. */
function parseExecutionRow(row: unknown, expectedSymbol: string): SpotExecution | null {
  if (!isRecord(row)) return null;
  const { symbol, id, orderId, time, isBuyer, qty, price, quoteQty, commission, commissionAsset } =
    row;
  if (symbol !== expectedSymbol || !SUPPORTED_EXECUTION_SYMBOL_SET.has(symbol)) return null;
  if (!isSafeId(id) || !isSafeId(orderId)) return null;
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0) return null;
  if (typeof isBuyer !== 'boolean') return null;
  if (!isDecimal(qty) || !isDecimal(price) || !isDecimal(quoteQty) || !isDecimal(commission)) {
    return null;
  }
  if (
    typeof commissionAsset !== 'string' ||
    commissionAsset.length === 0 ||
    commissionAsset.length > 32
  ) {
    return null;
  }
  return {
    symbol,
    tradeId: String(id),
    orderId: String(orderId),
    time,
    side: isBuyer ? 'buy' : 'sell',
    quantity: qty,
    price,
    quoteQuantity: quoteQty,
    commission,
    commissionAsset,
  };
}

/** Parse one documented myTrades page without rounding or merging fills. */
export function parseExecutions(
  body: unknown,
  expectedSymbol: string,
  startTime: number,
  endTime: number,
): { executions: SpotExecution[]; lastTradeId: string | null; crossedEnd: boolean } | null {
  if (!Array.isArray(body)) return null;
  const executions: SpotExecution[] = [];
  const seen = new Set<string>();
  let lastTradeId: string | null = null;
  let crossedEnd = false;
  for (const row of body) {
    const execution = parseExecutionRow(row, expectedSymbol);
    if (execution === null) return null;
    const { tradeId, time } = execution;
    if (lastTradeId !== null && BigInt(tradeId) < BigInt(lastTradeId)) return null;
    lastTradeId = tradeId;
    crossedEnd ||= time > endTime;
    if (time > endTime || time < startTime || seen.has(tradeId)) continue;
    seen.add(tradeId);
    executions.push(execution);
  }
  return { executions, lastTradeId, crossedEnd };
}

function base64UrlEncode(value: string): string {
  // A continuation is a few hundred bytes, well inside the argument limit of a spread.
  const binary = String.fromCodePoint(...new TextEncoder().encode(value));
  // '=' occurs in base64 only as trailing padding.
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) return null;
  try {
    const padded = value
      .replaceAll('-', '+')
      .replaceAll('_', '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= (left.codePointAt(index) ?? 0) ^ (right.codePointAt(index) ?? 0);
  }
  return difference === 0;
}

async function encodeContinuation(state: ContinuationState, secret: string): Promise<string> {
  const payload = base64UrlEncode(JSON.stringify(state));
  return `${payload}.${await hmacSha256Hex(secret, payload)}`;
}

async function decodeContinuation(
  token: unknown,
  secret: string,
): Promise<ContinuationState | null> {
  if (typeof token !== 'string' || token.length > 5000) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^[a-f0-9]{64}$/.test(signature))
    return null;
  const expected = await hmacSha256Hex(secret, payload);
  if (!constantTimeEqual(signature, expected)) return null;
  const decoded = base64UrlDecode(payload);
  if (decoded === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['v'] !== CONTINUATION_VERSION) return null;
  const symbols = value['symbols'];
  const startTime = value['startTime'];
  const endTime = value['endTime'];
  const nextBySymbol = value['nextBySymbol'];
  if (!validSymbols(symbols) || !validRange(startTime, endTime) || !isRecord(nextBySymbol))
    return null;
  if (Object.keys(nextBySymbol).some((symbol) => !symbols.includes(symbol))) return null;
  const parsedNext: Record<string, string> = {};
  for (const [symbol, id] of Object.entries(nextBySymbol)) {
    if (typeof id !== 'string' || !DECIMAL_INTEGER.test(id)) return null;
    parsedNext[symbol] = id;
  }
  if (Object.keys(parsedNext).length === 0) return null;
  return {
    v: CONTINUATION_VERSION,
    symbols,
    startTime: startTime as number,
    endTime: endTime as number,
    nextBySymbol: parsedNext,
  };
}

function validSymbols(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SELECTED_EXECUTION_SYMBOLS &&
    value.every(
      (symbol) => typeof symbol === 'string' && SUPPORTED_EXECUTION_SYMBOL_SET.has(symbol),
    ) &&
    new Set(value).size === value.length
  );
}

function validRange(startTime: unknown, endTime: unknown): boolean {
  return (
    typeof startTime === 'number' &&
    typeof endTime === 'number' &&
    Number.isSafeInteger(startTime) &&
    Number.isSafeInteger(endTime) &&
    startTime > 0 &&
    endTime > startTime &&
    endTime - startTime <= MAX_EXECUTION_RANGE_MS
  );
}

/** Non-zero balances sorted by asset, or null when the body is not the documented shape. */
export function parseBalances(body: unknown): SpotBalance[] | null {
  if (!isRecord(body) || !Array.isArray(body['balances'])) return null;
  const balances: SpotBalance[] = [];
  const seen = new Set<string>();
  for (const row of body['balances'] as unknown[]) {
    if (!isRecord(row)) return null;
    const { asset, free, locked } = row;
    if (typeof asset !== 'string' || asset.length === 0 || asset.length > 32) return null;
    if (typeof free !== 'string' || !DECIMAL.test(free)) return null;
    if (typeof locked !== 'string' || !DECIMAL.test(locked)) return null;
    if (seen.has(asset)) return null;
    seen.add(asset);
    if (ZERO.test(free) && ZERO.test(locked)) continue;
    balances.push({ asset, free, locked });
  }
  return balances.sort((a, b) => a.asset.localeCompare(b.asset));
}

function retryAfterSeconds(res: Response): number | undefined {
  const seconds = Number(res.headers.get('Retry-After'));
  // Binance bans run from 2 minutes to 3 days; anything else is not a usable hint.
  return Number.isInteger(seconds) && seconds > 0 && seconds <= 3 * 24 * 60 * 60
    ? seconds
    : undefined;
}

/** The only way this function talks to Binance: GET, fixed origin, allowlisted path. */
async function binanceGet(
  deps: AccountDeps,
  endpoint: keyof typeof ENDPOINTS,
  signed?: { apiKey: string; query: string },
): Promise<unknown> {
  const url = `${BINANCE_ORIGIN}${ENDPOINTS[endpoint]}${signed ? `?${signed.query}` : ''}`;
  let res: Response;
  let body: unknown;
  try {
    res = await deps.fetch(url, {
      method: 'GET',
      headers: signed ? { 'X-MBX-APIKEY': signed.apiKey } : {},
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 429 || res.status === 418) {
      const retry = retryAfterSeconds(res);
      throw new Failure('rate_limited', retry === undefined ? {} : { retryAfterSeconds: retry });
    }
    body = await res.json().catch((error: unknown) => {
      if (isTimeout(error)) throw error;
      return undefined;
    });
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw new Failure(isTimeout(error) ? 'timeout' : 'network');
  }
  if (res.ok) {
    if (body === undefined) throw new Failure('malformed_response');
    return body;
  }
  const providerCode = isRecord(body) && typeof body['code'] === 'number' ? body['code'] : 0;
  const extra = providerCode === 0 ? {} : { providerCode };
  // -2014 bad key format, -2015 invalid key/IP/permissions, -1022 bad signature, -1002 unauthorized.
  if (res.status === 401 || [-2014, -2015, -1022, -1002].includes(providerCode)) {
    throw new Failure('binance_auth', extra);
  }
  throw new Failure('provider_error', extra);
}

async function verifiedSignedQuery(
  deps: AccountDeps,
  apiKey: string,
  apiSecret: string,
): Promise<(params: string) => Promise<string>> {
  const now = deps.now ?? Date.now;

  const time = await binanceGet(deps, 'time');
  const receivedAt = now();
  const serverTime = isRecord(time) ? time['serverTime'] : undefined;
  if (typeof serverTime !== 'number' || !Number.isSafeInteger(serverTime) || serverTime <= 0) {
    throw new Failure('malformed_response');
  }
  // Binance's clock plus the time since it answered: the local clock only
  // measures elapsed time, so its skew cannot matter. The result trails
  // Binance's clock by the response latency and is never ahead of it; anything
  // older than recvWindow is rejected by Binance, not retried here.
  const signedQuery = async (params: string) => {
    const timestamp = serverTime + Math.max(0, now() - receivedAt);
    const payload = `${params}recvWindow=${RECV_WINDOW_MS}&timestamp=${timestamp}`;
    return `${payload}&signature=${await hmacSha256Hex(apiSecret, payload)}`;
  };

  let permissions: unknown;
  try {
    permissions = await binanceGet(deps, 'keyPermissions', {
      apiKey,
      query: await signedQuery(''),
    });
  } catch (error) {
    // A rejected key is an authentication failure. Anything else leaves the
    // permissions unknown, which is not a verified read-only connection.
    if (error instanceof Failure && error.code !== 'binance_auth') {
      throw error.code === 'malformed_response' || error.code === 'provider_error'
        ? new Failure('permissions_unverified', error.extra)
        : error;
    }
    throw error;
  }
  const check = checkKeyPermissions(permissions);
  if (check.verdict === 'refused') {
    throw new Failure('permissions_refused', { enabled: check.enabled });
  }
  if (check.verdict === 'unverified') throw new Failure('permissions_unverified');

  return signedQuery;
}

async function readBalances(
  deps: AccountDeps,
  apiKey: string,
  apiSecret: string,
): Promise<SpotBalance[]> {
  const signedQuery = await verifiedSignedQuery(deps, apiKey, apiSecret);

  const account = await binanceGet(deps, 'account', {
    apiKey,
    query: await signedQuery('omitZeroBalances=true&'),
  });
  const balances = parseBalances(account);
  if (balances === null) throw new Failure('malformed_response');
  return balances;
}

function failureForSymbol(symbol: string, failure: Failure): SpotExecutionFailure {
  return {
    symbol,
    error:
      failure.code === 'unauthenticated' || failure.code === 'forbidden'
        ? 'provider_error'
        : failure.code,
    ...(failure.extra.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.extra.retryAfterSeconds }),
  };
}

/** The pairs, window and per-pair cursors a request asks for: a fresh selection or a signed continuation. */
async function executionSelection(
  request: ExecutionRequest,
  apiSecret: string,
): Promise<Omit<ContinuationState, 'v'>> {
  const { symbols, startTime, endTime } = request;
  if (request.continuation === undefined) {
    if (!validSymbols(symbols) || !validRange(startTime, endTime)) {
      throw new Failure('invalid_request');
    }
    return {
      symbols,
      startTime: startTime as number,
      endTime: endTime as number,
      nextBySymbol: Object.fromEntries(symbols.map((symbol) => [symbol, ''])),
    };
  }
  if (symbols !== undefined || startTime !== undefined || endTime !== undefined) {
    throw new Failure('invalid_request');
  }
  const continuation = await decodeContinuation(request.continuation, apiSecret);
  if (continuation === null) throw new Failure('invalid_request');
  return continuation;
}

/** One myTrades page for one pair, and the trade ID the next page starts from (null: no more). */
async function readSymbolPage(
  deps: AccountDeps,
  signed: { apiKey: string; query: (params: string) => Promise<string> },
  symbol: string,
  fromId: string,
  range: { startTime: number; endTime: number },
): Promise<{ executions: SpotExecution[]; next: string | null }> {
  const { startTime, endTime } = range;
  const params =
    fromId === ''
      ? `symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=${EXECUTION_PAGE_LIMIT}&`
      : `symbol=${symbol}&fromId=${fromId}&limit=${EXECUTION_PAGE_LIMIT}&`;
  const body = await binanceGet(deps, 'trades', {
    apiKey: signed.apiKey,
    query: await signed.query(params),
  });
  const parsed = parseExecutions(body, symbol, startTime, endTime);
  if (parsed === null) throw new Failure('malformed_response');
  const fullPage = Array.isArray(body) && body.length === EXECUTION_PAGE_LIMIT;
  const more = fullPage && parsed.lastTradeId !== null && !parsed.crossedEnd;
  return {
    executions: parsed.executions,
    next: more ? (BigInt(parsed.lastTradeId as string) + 1n).toString() : null,
  };
}

/** Time, then pair, then trade ID compared as the integer it is (it can exceed 2^53). */
function compareExecutions(left: SpotExecution, right: SpotExecution): number {
  const byTimeAndPair = left.time - right.time || left.symbol.localeCompare(right.symbol);
  if (byTimeAndPair !== 0) return byTimeAndPair;
  const difference = BigInt(left.tradeId) - BigInt(right.tradeId);
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
}

async function readExecutions(
  deps: AccountDeps,
  apiKey: string,
  apiSecret: string,
  request: ExecutionRequest,
): Promise<Extract<SpotAccountResponse, { state: 'executions' }>> {
  const { symbols, startTime, endTime, nextBySymbol } = await executionSelection(
    request,
    apiSecret,
  );
  const signed = { apiKey, query: await verifiedSignedQuery(deps, apiKey, apiSecret) };
  // Each pair is read once and its page holds only its own, already distinct, trades.
  const executions: SpotExecution[] = [];
  const failures: SpotExecutionFailure[] = [];
  const next: Record<string, string> = {};
  // A pair with no cursor completed on an earlier page.
  const pending = symbols.filter((symbol) => nextBySymbol[symbol] !== undefined);

  for (const [index, symbol] of pending.entries()) {
    try {
      const page = await readSymbolPage(deps, signed, symbol, nextBySymbol[symbol] as string, {
        startTime,
        endTime,
      });
      executions.push(...page.executions);
      if (page.next !== null) next[symbol] = page.next;
    } catch (error) {
      const failure = error instanceof Failure ? error : new Failure('provider_error');
      // A rate limit is IP-wide. Stop rather than spend more provider requests;
      // untouched symbols are explicitly reported as failed for this page.
      const failed = failure.code === 'rate_limited' ? pending.slice(index) : [symbol];
      failures.push(...failed.map((each) => failureForSymbol(each, failure)));
      if (failure.code === 'rate_limited') break;
    }
  }

  executions.sort(compareExecutions);
  const retrievedAt = new Date((deps.now ?? Date.now)()).toISOString();
  const hasMore = Object.keys(next).length > 0;
  return {
    state: 'executions',
    executions,
    coverage: {
      symbols,
      startTime,
      endTime,
      returned: executions.length,
      retrievedAt,
      hasMore,
      partial: failures.length > 0,
      failures,
      limitation: 'selected_pairs_and_24h_window',
    },
    ...(hasMore
      ? {
          continuation: await encodeContinuation(
            { v: CONTINUATION_VERSION, symbols, startTime, endTime, nextBySymbol: next },
            apiSecret,
          ),
        }
      : {}),
  };
}

/** The signed-in user's id according to Supabase Auth, or null. */
async function authenticatedUserId(req: Request, deps: AccountDeps): Promise<string | null> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!/^Bearer \S+$/.test(authorization)) return null;
  try {
    const res = await deps.fetch(`${deps.env('SUPABASE_URL') ?? ''}/auth/v1/user`, {
      method: 'GET',
      headers: { apikey: deps.env('SUPABASE_ANON_KEY') ?? '', Authorization: authorization },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const user: unknown = await res.json();
    return isRecord(user) && typeof user['id'] === 'string' && user['id'] !== ''
      ? user['id']
      : null;
  } catch {
    return null; // Fail closed: an unverifiable caller is not the owner.
  }
}

async function requestedOperation(req: Request): Promise<'balances' | ExecutionRequest | null> {
  const text = await req.text().catch(() => '');
  if (text === '') return 'balances';
  if (text.length > 6000) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(body) || body['action'] !== 'executions') return null;
  const allowed = new Set(['action', 'symbols', 'startTime', 'endTime', 'continuation']);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;
  return body as unknown as ExecutionRequest;
}

export async function handleSpotAccount(req: Request, deps: AccountDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const started = now();
  const respond = (status: number, body: SpotAccountResponse | { error: string }, detail = {}) => {
    const outcome = 'state' in body && body.state !== 'error' ? body.state : body.error;
    deps.log(
      JSON.stringify({
        fn: 'binance-spot-account',
        outcome,
        status,
        ms: now() - started,
        ...detail,
      }),
    );
    const retry = 'retryAfterSeconds' in body ? body.retryAfterSeconds : undefined;
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json',
        // The balances belong to one person; nothing between here and them may keep a copy.
        'Cache-Control': 'no-store',
        ...(retry === undefined ? {} : { 'Retry-After': String(retry) }),
      },
    });
  };
  const fail = (failure: Failure) =>
    respond(
      STATUS[failure.code],
      {
        state: 'error',
        error: failure.code,
        ...(failure.extra.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: failure.extra.retryAfterSeconds }),
        ...(failure.extra.enabled ? { enabled: failure.extra.enabled } : {}),
      },
      failure.extra.providerCode === undefined ? {} : { providerCode: failure.extra.providerCode },
    );

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return respond(405, { error: 'method_not_allowed' });

  // Who is asking comes first. Until the caller is the configured owner,
  // nothing below runs: no credential is read and Binance is not contacted.
  const userId = await authenticatedUserId(req, deps);
  if (userId === null) return fail(new Failure('unauthenticated'));
  const ownerId = deps.env('BINANCE_SPOT_OWNER_USER_ID') ?? '';
  // No owner configured means nobody is authorized.
  if (ownerId === '' || userId !== ownerId) return fail(new Failure('forbidden'));

  const apiKey = deps.env('BINANCE_SPOT_API_KEY') ?? '';
  const apiSecret = deps.env('BINANCE_SPOT_API_SECRET') ?? '';
  if (deps.env('BINANCE_SPOT_READONLY_ENABLED') !== 'true' || apiKey === '' || apiSecret === '') {
    return respond(200, { state: 'not_configured' });
  }

  try {
    const operation = await requestedOperation(req);
    if (operation === null) return fail(new Failure('invalid_request'));
    if (operation !== 'balances') {
      const result = await readExecutions(deps, apiKey, apiSecret, operation);
      return respond(200, result, {
        records: result.executions.length,
        symbols: result.coverage.symbols.length,
        partial: result.coverage.partial,
        hasMore: result.coverage.hasMore,
      });
    }
    const balances = await readBalances(deps, apiKey, apiSecret);
    return respond(
      200,
      { state: 'connected', readAt: new Date(now()).toISOString(), balances },
      { assets: balances.length },
    );
  } catch (error) {
    if (error instanceof Failure) return fail(error);
    return fail(new Failure('provider_error'));
  }
}
