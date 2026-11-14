import { vi } from 'vitest';
import { ENDPOINTS, FAPI_ORIGIN, type FactsGroup } from '@/lib/perpetualContractFacts';

/**
 * Response shapes for the four public USDⓈ-M endpoints, modelled on bodies read on 2026-11-14
 * and trimmed. They are fixtures for tests and browser checks, not quotes: no figure here is a
 * current price, rate or parameter.
 */
export const TRX_PERPETUAL = {
  symbol: 'TRXUSDT',
  pair: 'TRXUSDT',
  contractType: 'PERPETUAL',
  deliveryDate: 4133404800000,
  onboardDate: 1579075500000,
  status: 'TRADING',
  // Documented as "ignore": the panel must never show these.
  maintMarginPercent: '2.5000',
  requiredMarginPercent: '5.0000',
  baseAsset: 'TRX',
  quoteAsset: 'USDT',
  marginAsset: 'USDT',
  pricePrecision: 5,
  quantityPrecision: 0,
  underlyingType: 'COIN',
  triggerProtect: '0.0500',
  liquidationFee: '0.012500',
  marketTakeBound: '0.05',
  filters: [
    { minPrice: '0.00132', maxPrice: '20000', filterType: 'PRICE_FILTER', tickSize: '0.00001' },
    { stepSize: '1', filterType: 'LOT_SIZE', maxQty: '20000000', minQty: '1' },
    { filterType: 'MARKET_LOT_SIZE', maxQty: '5000000', stepSize: '1', minQty: '1' },
    { limit: 200, filterType: 'MAX_NUM_ORDERS' },
    { notional: '5', filterType: 'MIN_NOTIONAL' },
    {
      multiplierDown: '0.9500',
      filterType: 'PERCENT_PRICE',
      multiplierDecimal: '4',
      multiplierUp: '1.0500',
    },
  ],
  orderTypes: ['LIMIT', 'MARKET', 'STOP', 'STOP_MARKET'],
};

export function exchangeInfoBody(entry: Record<string, unknown> = TRX_PERPETUAL) {
  return {
    timezone: 'UTC',
    serverTime: 1794690979000,
    exchangeFilters: [],
    assets: [{ asset: 'USDT', marginAvailable: true, autoAssetExchange: '-10000' }],
    symbols: [
      {
        ...TRX_PERPETUAL,
        symbol: 'TRXUSDC',
        pair: 'TRXUSDC',
        quoteAsset: 'USDC',
        marginAsset: 'USDC',
        status: 'PENDING_TRADING',
      },
      entry,
      { ...TRX_PERPETUAL, symbol: 'BTCUSDT', pair: 'BTCUSDT', baseAsset: 'BTC' },
    ],
  };
}

export const PREMIUM_INDEX = {
  symbol: 'TRXUSDT',
  markPrice: '0.30707000',
  indexPrice: '0.30742824',
  estimatedSettlePrice: '0.30789728',
  lastFundingRate: '-0.00058793',
  interestRate: '0.00010000',
  nextFundingTime: 1794700800000,
  time: 1794690980003,
};

export const TICKER_PRICE = { symbol: 'TRXUSDT', price: '0.30712', time: 1794690982309 };

export const TRX_FUNDING = {
  symbol: 'TRXUSDT',
  adjustedFundingRateCap: '0.004875',
  adjustedFundingRateFloor: '-0.004875',
  fundingIntervalHours: 8,
  disclaimer: true,
};

export function fundingInfoBody(entries: unknown[] = [TRX_FUNDING]) {
  return [
    {
      symbol: 'BTCUSDT',
      adjustedFundingRateCap: '0.02',
      adjustedFundingRateFloor: '-0.02',
      fundingIntervalHours: 4,
      disclaimer: false,
    },
    ...entries,
  ];
}

export const URLS: Record<FactsGroup, string> = {
  contract: `${FAPI_ORIGIN}${ENDPOINTS.contract}`,
  premium: `${FAPI_ORIGIN}${ENDPOINTS.premium}`,
  ticker: `${FAPI_ORIGIN}${ENDPOINTS.ticker}`,
  funding: `${FAPI_ORIGIN}${ENDPOINTS.funding}`,
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export type Reply = Response | Error | 'hang' | (() => Response | Promise<Response>);

export const OK_REPLIES: Record<FactsGroup, Reply> = {
  contract: () => json(exchangeInfoBody()),
  premium: () => json(PREMIUM_INDEX),
  ticker: () => json(TICKER_PRICE),
  funding: () => json(fundingInfoBody()),
};

const groupOf = (url: string): FactsGroup => {
  const entry = Object.entries(URLS).find(([, value]) => value === url);
  if (!entry) throw new Error(`Unexpected request: ${url}`);
  return entry[0] as FactsGroup;
};

/**
 * A fetch stand-in keyed by endpoint. 'hang' never answers until the request is aborted, then
 * rejects the way a browser does.
 */
export function mockFetch(replies: Partial<Record<FactsGroup, Reply>> = {}) {
  const table = { ...OK_REPLIES, ...replies };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const reply = table[groupOf(String(input))];
    if (reply === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return reply();
  });
}
