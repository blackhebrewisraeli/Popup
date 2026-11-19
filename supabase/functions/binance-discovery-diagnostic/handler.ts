const BINANCE_ORIGIN = 'https://api.binance.com';

export const ENDPOINTS = {
  exchangeInfo: '/api/v3/exchangeInfo?permissions=SPOT',
  ticker24hr: '/api/v3/ticker/24hr?type=MINI',
} as const;

type EndpointName = keyof typeof ENDPOINTS;

interface Dependencies {
  env: (name: string) => string | undefined;
  fetch: typeof fetch;
  now: () => number;
}

interface ProbeSuccess {
  endpoint: EndpointName;
  ok: true;
  status: 200;
  durationMs: number;
  counts: Record<string, number>;
}

interface ProbeFailure {
  endpoint: EndpointName;
  ok: false;
  status: number | null;
  durationMs: number;
  error: 'UPSTREAM_HTTP' | 'TIMEOUT' | 'NETWORK_ERROR' | 'MALFORMED_RESPONSE';
}

type ProbeResult = ProbeSuccess | ProbeFailure;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const DECIMAL = /^\d{1,30}(\.\d{1,30})?$/;

function exchangeInfoCounts(body: unknown): Record<string, number> | null {
  if (
    !isRecord(body) ||
    !isPositiveSafeInteger(body['serverTime']) ||
    !Array.isArray(body['symbols'])
  ) {
    return null;
  }
  const structurallyValidSymbols = body['symbols'].filter(
    (entry) =>
      isRecord(entry) &&
      isText(entry['symbol']) &&
      isText(entry['baseAsset']) &&
      isText(entry['quoteAsset']) &&
      isText(entry['status']) &&
      typeof entry['isSpotTradingAllowed'] === 'boolean',
  );
  if (body['symbols'].length === 0 || structurallyValidSymbols.length !== body['symbols'].length) {
    return null;
  }
  return {
    listedSymbols: body['symbols'].length,
    usdtSymbols: structurallyValidSymbols.filter((entry) => entry['quoteAsset'] === 'USDT').length,
  };
}

function tickerCounts(body: unknown): Record<string, number> | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const valid = body.filter(
    (entry) =>
      isRecord(entry) &&
      isText(entry['symbol']) &&
      typeof entry['quoteVolume'] === 'string' &&
      DECIMAL.test(entry['quoteVolume']) &&
      isPositiveSafeInteger(entry['openTime']) &&
      isPositiveSafeInteger(entry['closeTime']) &&
      entry['closeTime'] > entry['openTime'],
  );
  if (valid.length !== body.length) return null;
  return { entries: body.length };
}

function secretKeys(raw: string | undefined): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return isRecord(parsed) ? Object.values(parsed) : [];
  } catch {
    return [];
  }
}

async function probe(endpoint: EndpointName, deps: Dependencies): Promise<ProbeResult> {
  const started = deps.now();
  const duration = () => Math.max(0, Math.round(deps.now() - started));
  try {
    const response = await deps.fetch(`${BINANCE_ORIGIN}${ENDPOINTS[endpoint]}`, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      return {
        endpoint,
        ok: false,
        status: response.status,
        durationMs: duration(),
        error: 'UPSTREAM_HTTP',
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        endpoint,
        ok: false,
        status: response.status,
        durationMs: duration(),
        error: 'MALFORMED_RESPONSE',
      };
    }
    const counts = endpoint === 'exchangeInfo' ? exchangeInfoCounts(body) : tickerCounts(body);
    if (counts === null) {
      return {
        endpoint,
        ok: false,
        status: response.status,
        durationMs: duration(),
        error: 'MALFORMED_RESPONSE',
      };
    }
    return { endpoint, ok: true, status: 200, durationMs: duration(), counts };
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      endpoint,
      ok: false,
      status: null,
      durationMs: duration(),
      error: timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
    };
  }
}

/**
 * Read-only, fixed-origin reachability check for Daily Discovery's two public Binance inputs.
 * It has no Supabase client and returns only timing, status, region and aggregate shape counts.
 */
export async function handleDiagnostic(req: Request, deps: Dependencies): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !secretKeys(deps.env('SUPABASE_SECRET_KEYS')).includes(apikey)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const probes = await Promise.all([probe('exchangeInfo', deps), probe('ticker24hr', deps)]);
  const ok = probes.every((result) => result.ok);
  const timedOut = probes.some((result) => !result.ok && result.error === 'TIMEOUT');
  return json(
    {
      ok,
      region: deps.env('SB_REGION') ?? null,
      probes,
    },
    ok ? 200 : timedOut ? 504 : 502,
  );
}
