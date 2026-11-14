/**
 * Public facts about one fixed instrument: the Binance USDⓈ-M TRXUSDT perpetual. That is a
 * different instrument from Spot TRXUSDT, and this module shares nothing with the Spot price
 * source in binance.ts (docs/LEVERAGE_SIMULATION.md#public-contract-data).
 *
 * One read sends exactly one unsigned GET to each of four documented public endpoints. It sends
 * no key, cookie or custom header, and uses no proxy. It follows no redirect and does not retry.
 * Each request has its own timeout. Provider values keep their decimal strings; the only
 * arithmetic is an exact shift of the decimal point to turn a rate into a percentage.
 */

export const FAPI_ORIGIN = 'https://fapi.binance.com';

/** The only contract this module describes. Any other reported identity is unsupported. */
export const FIXED_CONTRACT = {
  symbol: 'TRXUSDT',
  pair: 'TRXUSDT',
  contractType: 'PERPETUAL',
  baseAsset: 'TRX',
  quoteAsset: 'USDT',
  marginAsset: 'USDT',
} as const;

export const SUPPORTED_STATUS = 'TRADING';
export const REQUEST_TIMEOUT_MS = 10_000;

export type FactsGroup = 'contract' | 'premium' | 'ticker' | 'funding';

/** Paths on FAPI_ORIGIN, in request order. */
export const ENDPOINTS: Readonly<Record<FactsGroup, string>> = {
  contract: '/fapi/v1/exchangeInfo',
  premium: `/fapi/v1/premiumIndex?symbol=${FIXED_CONTRACT.symbol}`,
  ticker: `/fapi/v2/ticker/price?symbol=${FIXED_CONTRACT.symbol}`,
  funding: '/fapi/v1/fundingInfo',
};

const REQUEST_INIT: RequestInit = {
  method: 'GET',
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
};

const UNSIGNED = /^\d+(?:\.\d+)?$/;
const SIGNED = /^-?\d+(?:\.\d+)?$/;
/** The largest millisecond value a Date can hold. */
const MAX_TIME_MS = 8.64e15;

export function isDecimalText(value: unknown, signed = false): value is string {
  return typeof value === 'string' && (signed ? SIGNED : UNSIGNED).test(value);
}

/**
 * A rate as a fraction, written as a percentage by moving the decimal point two places, so no
 * digit is lost or invented: "0.012500" → "1.2500", "-0.00058793" → "-0.058793".
 */
export function fractionToPercent(value: string): string {
  if (!SIGNED.test(value)) throw new RangeError(`Not a plain decimal: ${value}`);
  const negative = value.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const point = whole.length + 2;
  const digits = (whole + fraction).padEnd(point, '0');
  const integer = digits.slice(0, point).replace(/^0+(?=\d)/, '');
  const rest = digits.slice(point);
  const text = rest ? `${integer}.${rest}` : integer;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/** Milliseconds since the epoch, as "2026-11-15 00:00:00.000 UTC". */
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_TIME_MS
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPositiveDecimal = (value: unknown): value is string =>
  isDecimalText(value) && /[1-9]/.test(value);

export type ShapeFailure = { kind: 'malformed' | 'unsupported'; detail: string };
export type Parsed<T> = { ok: true; data: T } | { ok: false; failure: ShapeFailure };

const malformed = (detail: string): { ok: false; failure: ShapeFailure } => ({
  ok: false,
  failure: { kind: 'malformed', detail },
});
const unsupported = (detail: string): { ok: false; failure: ShapeFailure } => ({
  ok: false,
  failure: { kind: 'unsupported', detail },
});

/** Exactly one entry for the fixed symbol, or why not. */
function findFixedSymbol(
  list: unknown[],
): { found: Record<string, unknown> } | { none: true } | { duplicate: true } {
  const matches = list.filter(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry['symbol'] === FIXED_CONTRACT.symbol,
  );
  if (matches.length > 1) return { duplicate: true };
  if (matches.length === 0) return { none: true };
  const [found] = matches;
  return found ? { found } : { none: true };
}

// ---------------------------------------------------------------------------------------------
// exchangeInfo: identity, status, filters and the reported liquidation fee rate.
// ---------------------------------------------------------------------------------------------

export type FilterState<K extends string> =
  | { state: 'reported'; values: Record<K, string> }
  | { state: 'missing' }
  | { state: 'malformed'; field: string };

const FILTER_FIELDS = {
  PRICE_FILTER: ['tickSize', 'minPrice', 'maxPrice'],
  LOT_SIZE: ['stepSize', 'minQty', 'maxQty'],
  MARKET_LOT_SIZE: ['stepSize', 'minQty', 'maxQty'],
  MIN_NOTIONAL: ['notional'],
} as const;

type FilterType = keyof typeof FILTER_FIELDS;
type FieldsOf<T extends FilterType> = (typeof FILTER_FIELDS)[T][number];

export type IdentityField = Exclude<keyof typeof FIXED_CONTRACT, 'symbol'>;

export interface ContractFacts {
  symbol: string;
  pair: string;
  contractType: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  status: string;
  priceFilter: FilterState<FieldsOf<'PRICE_FILTER'>>;
  lotSize: FilterState<FieldsOf<'LOT_SIZE'>>;
  marketLotSize: FilterState<FieldsOf<'MARKET_LOT_SIZE'>>;
  minNotional: FilterState<FieldsOf<'MIN_NOTIONAL'>>;
  /** Reported context only; the simulation never reads it. */
  liquidationFee:
    | { state: 'reported'; value: string; percent: string }
    | { state: 'missing' }
    | { state: 'malformed' };
}

const IDENTITY_FIELDS: readonly IdentityField[] = [
  'pair',
  'contractType',
  'baseAsset',
  'quoteAsset',
  'marginAsset',
];

function readFilter<T extends FilterType>(
  filters: unknown[],
  type: T,
): FilterState<FieldsOf<T>> | 'duplicate' {
  const entries = filters.filter((entry) => isRecord(entry) && entry['filterType'] === type);
  if (entries.length > 1) return 'duplicate';
  const entry = entries[0];
  if (!isRecord(entry)) return { state: 'missing' };
  const values = {} as Record<FieldsOf<T>, string>;
  for (const field of FILTER_FIELDS[type] as readonly FieldsOf<T>[]) {
    const value = entry[field];
    if (!isDecimalText(value)) return { state: 'malformed', field };
    values[field] = value;
  }
  return { state: 'reported', values };
}

/**
 * The TRXUSDT entry of exchangeInfo. `maintMarginPercent` and `requiredMarginPercent`, which
 * Binance documents as "ignore", are never read.
 */
export function parseExchangeInfo(body: unknown): Parsed<ContractFacts> {
  const symbols = isRecord(body) ? body['symbols'] : undefined;
  if (!Array.isArray(symbols)) return malformed('symbols is not a list.');
  const lookup = findFixedSymbol(symbols);
  if ('duplicate' in lookup) return malformed(`${FIXED_CONTRACT.symbol} is listed more than once.`);
  if ('none' in lookup) return unsupported(`${FIXED_CONTRACT.symbol} is not listed.`);
  const entry = lookup.found;

  const text: Partial<Record<IdentityField | 'status', string>> = {};
  for (const field of [...IDENTITY_FIELDS, 'status'] as const) {
    const value = entry[field];
    if (typeof value !== 'string' || value === '') return malformed(`${field} is missing.`);
    text[field] = value;
  }
  const filters = entry['filters'];
  if (!Array.isArray(filters)) return malformed('filters is not a list.');

  const priceFilter = readFilter(filters, 'PRICE_FILTER');
  const lotSize = readFilter(filters, 'LOT_SIZE');
  const marketLotSize = readFilter(filters, 'MARKET_LOT_SIZE');
  const minNotional = readFilter(filters, 'MIN_NOTIONAL');
  for (const [type, state] of [
    ['PRICE_FILTER', priceFilter],
    ['LOT_SIZE', lotSize],
    ['MARKET_LOT_SIZE', marketLotSize],
    ['MIN_NOTIONAL', minNotional],
  ] as const) {
    if (state === 'duplicate') return malformed(`${type} is listed more than once.`);
  }

  const fee = entry['liquidationFee'];
  let liquidationFee: ContractFacts['liquidationFee'];
  if (fee === undefined) liquidationFee = { state: 'missing' };
  else if (isDecimalText(fee))
    liquidationFee = { state: 'reported', value: fee, percent: fractionToPercent(fee) };
  else liquidationFee = { state: 'malformed' };

  return {
    ok: true,
    data: {
      symbol: FIXED_CONTRACT.symbol,
      pair: text.pair as string,
      contractType: text.contractType as string,
      baseAsset: text.baseAsset as string,
      quoteAsset: text.quoteAsset as string,
      marginAsset: text.marginAsset as string,
      status: text.status as string,
      priceFilter: priceFilter as ContractFacts['priceFilter'],
      lotSize: lotSize as ContractFacts['lotSize'],
      marketLotSize: marketLotSize as ContractFacts['marketLotSize'],
      minNotional: minNotional as ContractFacts['minNotional'],
      liquidationFee,
    },
  };
}

/** Each way the reported contract differs from the fixed instrument or is not trading. */
export function contractProblems(facts: ContractFacts): string[] {
  const problems: string[] = [];
  for (const field of IDENTITY_FIELDS) {
    if (facts[field] !== FIXED_CONTRACT[field]) {
      problems.push(`${field} is ${facts[field]}, not ${FIXED_CONTRACT[field]}.`);
    }
  }
  if (facts.status !== SUPPORTED_STATUS) {
    problems.push(`status is ${facts.status}, not ${SUPPORTED_STATUS}.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// premiumIndex, ticker/price v2 and fundingInfo.
// ---------------------------------------------------------------------------------------------

export interface PremiumFacts {
  markPrice: string;
  /** Binance documents this field as the latest funding rate: reported, not settled. */
  lastFundingRate: string;
  lastFundingRatePercent: string;
  nextFundingTime: number;
  /** The provider's timestamp for this response. */
  time: number;
}

function checkSymbol(body: Record<string, unknown>): Parsed<never> | null {
  const symbol = body['symbol'];
  if (symbol === FIXED_CONTRACT.symbol) return null;
  return typeof symbol === 'string'
    ? unsupported(`The response is for ${symbol}, not ${FIXED_CONTRACT.symbol}.`)
    : malformed('symbol is missing.');
}

export function parsePremiumIndex(body: unknown): Parsed<PremiumFacts> {
  if (!isRecord(body)) return malformed('The response is not an object.');
  const symbolProblem = checkSymbol(body);
  if (symbolProblem) return symbolProblem;
  const markPrice = body['markPrice'];
  const lastFundingRate = body['lastFundingRate'];
  const nextFundingTime = body['nextFundingTime'];
  const time = body['time'];
  if (!isPositiveDecimal(markPrice)) return malformed('markPrice is not a positive decimal.');
  if (!isDecimalText(lastFundingRate, true))
    return malformed('lastFundingRate is not a plain decimal.');
  if (!isTimestamp(nextFundingTime)) return malformed('nextFundingTime is not a timestamp.');
  if (!isTimestamp(time)) return malformed('time is not a timestamp.');
  return {
    ok: true,
    data: {
      markPrice,
      lastFundingRate,
      lastFundingRatePercent: fractionToPercent(lastFundingRate),
      nextFundingTime,
      time,
    },
  };
}

export interface TickerFacts {
  /** The last traded price of the perpetual. */
  price: string;
  /** Documented as the transaction time. */
  time: number;
}

export function parseTickerPrice(body: unknown): Parsed<TickerFacts> {
  if (!isRecord(body)) return malformed('The response is not an object.');
  const symbolProblem = checkSymbol(body);
  if (symbolProblem) return symbolProblem;
  const price = body['price'];
  const time = body['time'];
  if (!isPositiveDecimal(price)) return malformed('price is not a positive decimal.');
  if (!isTimestamp(time)) return malformed('time is not a timestamp.');
  return { ok: true, data: { price, time } };
}

export type FundingFacts =
  | { published: false }
  | {
      published: true;
      fundingIntervalHours: number;
      cap: string;
      capPercent: string;
      floor: string;
      floorPercent: string;
    };

/**
 * fundingInfo lists only contracts whose funding cap, floor or interval was adjusted. A missing
 * TRXUSDT entry is reported as unpublished; no interval is inferred.
 */
export function parseFundingInfo(body: unknown): Parsed<FundingFacts> {
  if (!Array.isArray(body)) return malformed('The response is not a list.');
  const lookup = findFixedSymbol(body);
  if ('duplicate' in lookup) return malformed(`${FIXED_CONTRACT.symbol} is listed more than once.`);
  if ('none' in lookup) return { ok: true, data: { published: false } };
  const entry = lookup.found;
  const fundingIntervalHours = entry['fundingIntervalHours'];
  const adjustedFundingRateCap = entry['adjustedFundingRateCap'];
  const adjustedFundingRateFloor = entry['adjustedFundingRateFloor'];
  if (
    typeof fundingIntervalHours !== 'number' ||
    !Number.isSafeInteger(fundingIntervalHours) ||
    fundingIntervalHours <= 0
  ) {
    return malformed('fundingIntervalHours is not a positive whole number.');
  }
  if (!isDecimalText(adjustedFundingRateCap, true))
    return malformed('adjustedFundingRateCap is not a plain decimal.');
  if (!isDecimalText(adjustedFundingRateFloor, true))
    return malformed('adjustedFundingRateFloor is not a plain decimal.');
  return {
    ok: true,
    data: {
      published: true,
      fundingIntervalHours,
      cap: adjustedFundingRateCap,
      capPercent: fractionToPercent(adjustedFundingRateCap),
      floor: adjustedFundingRateFloor,
      floorPercent: fractionToPercent(adjustedFundingRateFloor),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------------------------

export type Failure =
  /** The browser returned no response: CORS, a regional or network block, or offline. */
  | { kind: 'network' }
  | { kind: 'timeout'; ms: number }
  | { kind: 'cancelled' }
  | { kind: 'http'; status: number }
  | ShapeFailure;

/** `receivedAt` is this device's clock when the response or failure arrived. */
export type GroupResult<T> =
  { ok: true; data: T; receivedAt: number } | { ok: false; failure: Failure; receivedAt: number };

export interface FactsSnapshot {
  contract: GroupResult<ContractFacts>;
  premium: GroupResult<PremiumFacts>;
  ticker: GroupResult<TickerFacts>;
  funding: GroupResult<FundingFacts>;
}

export interface ReadOptions {
  /** Aborting it stops every request of this read. */
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

async function readGroup<T>(
  path: string,
  parse: (body: unknown) => Parsed<T>,
  options: ReadOptions,
): Promise<GroupResult<T>> {
  const { signal, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel);
  if (signal.aborted) controller.abort();

  const fail = (failure: Failure): GroupResult<T> => ({ ok: false, failure, receivedAt: now() });
  const stopped = (): Failure | null => {
    if (timedOut) return { kind: 'timeout', ms: timeoutMs };
    if (signal.aborted) return { kind: 'cancelled' };
    return null;
  };

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${FAPI_ORIGIN}${path}`, {
        ...REQUEST_INIT,
        signal: controller.signal,
      });
    } catch {
      return fail(stopped() ?? { kind: 'network' });
    }
    if (!response.ok) return fail({ kind: 'http', status: response.status });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail(stopped() ?? { kind: 'malformed', detail: 'The body is not JSON.' });
    }
    const parsed = parse(body);
    return parsed.ok ? { ok: true, data: parsed.data, receivedAt: now() } : fail(parsed.failure);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}

/** One GET to each endpoint, concurrently. Never rejects: every outcome is a group result. */
export async function readPublicContractData(options: ReadOptions): Promise<FactsSnapshot> {
  const [contract, premium, ticker, funding] = await Promise.all([
    readGroup(ENDPOINTS.contract, parseExchangeInfo, options),
    readGroup(ENDPOINTS.premium, parsePremiumIndex, options),
    readGroup(ENDPOINTS.ticker, parseTickerPrice, options),
    readGroup(ENDPOINTS.funding, parseFundingInfo, options),
  ]);
  return { contract, premium, ticker, funding };
}

/** Whether the other groups may be shown as facts about the fixed contract. */
export type ContractGate = 'confirmed' | 'unsupported' | 'unconfirmed';

export function contractGate(contract: GroupResult<ContractFacts>): ContractGate {
  if (contract.ok)
    return contractProblems(contract.data).length === 0 ? 'confirmed' : 'unsupported';
  return contract.failure.kind === 'unsupported' ? 'unsupported' : 'unconfirmed';
}
