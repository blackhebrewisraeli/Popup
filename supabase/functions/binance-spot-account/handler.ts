// Owner-only, read-only Binance Spot balances (docs/BINANCE_SPOT_ACCOUNT.md).
// Free of Deno globals so vitest covers it from src/test; index.ts wires the env.
//
// The whole Binance surface of this integration is the three GET requests in
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

const BINANCE_ORIGIN = 'https://api.binance.com';

/** Every Binance request this function can make. All are GET. */
export const ENDPOINTS = {
  time: '/api/v3/time',
  keyPermissions: '/sapi/v1/account/apiRestrictions',
  account: '/api/v3/account',
} as const;

/** Binance's default, and the value it recommends not exceeding. Never widened. */
export const RECV_WINDOW_MS = 5000;
const REQUEST_TIMEOUT_MS = 4000;

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

export type SpotErrorCode =
  | 'unauthenticated'
  | 'forbidden'
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

async function readBalances(
  deps: AccountDeps,
  apiKey: string,
  apiSecret: string,
): Promise<SpotBalance[]> {
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

  const account = await binanceGet(deps, 'account', {
    apiKey,
    query: await signedQuery('omitZeroBalances=true&'),
  });
  const balances = parseBalances(account);
  if (balances === null) throw new Failure('malformed_response');
  return balances;
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
