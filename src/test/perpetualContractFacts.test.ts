import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENDPOINTS,
  FAPI_ORIGIN,
  REQUEST_TIMEOUT_MS,
  contractGate,
  contractProblems,
  formatUtc,
  fractionToPercent,
  isDecimalText,
  parseExchangeInfo,
  parseFundingInfo,
  parsePremiumIndex,
  parseTickerPrice,
  readPublicContractData,
  type ContractFacts,
  type GroupResult,
} from '@/lib/perpetualContractFacts';
import {
  PREMIUM_INDEX,
  TICKER_PRICE,
  TRX_FUNDING,
  TRX_PERPETUAL,
  URLS,
  exchangeInfoBody,
  fundingInfoBody,
  json,
  mockFetch,
} from './perpetualFactsFixtures';

const contractOf = (entry: Record<string, unknown>) => {
  const parsed = parseExchangeInfo(exchangeInfoBody(entry));
  if (!parsed.ok) throw new Error(parsed.failure.detail);
  return parsed.data;
};

const withFilters = (filters: unknown[]) => contractOf({ ...TRX_PERPETUAL, filters });

describe('fractionToPercent', () => {
  it.each([
    ['0.012500', '1.2500'],
    ['-0.00058793', '-0.058793'],
    ['0.004875', '0.4875'],
    ['-0.004875', '-0.4875'],
    ['0.00010000', '0.010000'],
    ['0.0001', '0.01'],
    ['0.5', '50'],
    ['1', '100'],
    ['12.3', '1230'],
    ['0', '0'],
    ['-0.000', '0.0'],
    ['-0.00000001', '-0.000001'],
    ['0.123456789012345678901234567890', '12.3456789012345678901234567890'],
  ])('%s → %s exactly', (fraction, percent) => {
    expect(fractionToPercent(fraction)).toBe(percent);
  });

  it.each(['', '1e-5', '.5', '5.', '+0.1', ' 0.1', '0,1', '--1', 'NaN'])('refuses %j', (text) => {
    expect(() => fractionToPercent(text)).toThrow(RangeError);
  });

  it('keeps digits a float would lose', () => {
    expect(fractionToPercent('0.1')).toBe('10');
    expect(fractionToPercent('0.07')).toBe('7');
    expect(String(0.07 * 100)).not.toBe('7');
  });
});

describe('isDecimalText and formatUtc', () => {
  it('accepts plain decimals only', () => {
    expect(isDecimalText('0.30707000')).toBe(true);
    expect(isDecimalText('-0.1')).toBe(false);
    expect(isDecimalText('-0.1', true)).toBe(true);
    expect(isDecimalText(0.3)).toBe(false);
    expect(isDecimalText('3e-1')).toBe(false);
  });

  it('writes milliseconds as UTC with millisecond precision', () => {
    expect(formatUtc(1794700800000)).toBe('2026-11-15 00:00:00.000 UTC');
    expect(formatUtc(1794690980003)).toBe('2026-11-14 21:16:20.003 UTC');
  });
});

describe('parseExchangeInfo', () => {
  it('reads identity, status, the four filters and the liquidation fee rate as strings', () => {
    const facts = contractOf(TRX_PERPETUAL);
    expect(facts).toEqual({
      symbol: 'TRXUSDT',
      pair: 'TRXUSDT',
      contractType: 'PERPETUAL',
      baseAsset: 'TRX',
      quoteAsset: 'USDT',
      marginAsset: 'USDT',
      status: 'TRADING',
      priceFilter: {
        state: 'reported',
        values: { tickSize: '0.00001', minPrice: '0.00132', maxPrice: '20000' },
      },
      lotSize: { state: 'reported', values: { stepSize: '1', minQty: '1', maxQty: '20000000' } },
      marketLotSize: {
        state: 'reported',
        values: { stepSize: '1', minQty: '1', maxQty: '5000000' },
      },
      minNotional: { state: 'reported', values: { notional: '5' } },
      liquidationFee: { state: 'reported', value: '0.012500', percent: '1.2500' },
    });
    expect(contractProblems(facts)).toEqual([]);
  });

  it('never carries the ignored margin fields', () => {
    const text = JSON.stringify(contractOf(TRX_PERPETUAL));
    expect(text).not.toMatch(/maintMarginPercent|requiredMarginPercent|2\.5000|5\.0000/);
  });

  it('picks TRXUSDT by symbol, not TRXUSDC or position', () => {
    expect(contractOf(TRX_PERPETUAL).marginAsset).toBe('USDT');
  });

  it.each([
    [{ contractType: 'CURRENT_QUARTER' }, 'contractType is CURRENT_QUARTER, not PERPETUAL.'],
    [{ pair: 'TRXUSDC' }, 'pair is TRXUSDC, not TRXUSDT.'],
    [{ baseAsset: 'TRON' }, 'baseAsset is TRON, not TRX.'],
    [{ quoteAsset: 'USDC' }, 'quoteAsset is USDC, not USDT.'],
    [{ marginAsset: 'BNFCR' }, 'marginAsset is BNFCR, not USDT.'],
    [{ status: 'SETTLING' }, 'status is SETTLING, not TRADING.'],
    [{ status: 'PENDING_TRADING' }, 'status is PENDING_TRADING, not TRADING.'],
  ])('flags %j as unsupported', (change, problem) => {
    const facts = contractOf({ ...TRX_PERPETUAL, ...change });
    expect(contractProblems(facts)).toEqual([problem]);
    expect(contractGate({ ok: true, data: facts, receivedAt: 1 })).toBe('unsupported');
  });

  it('lists every mismatch at once', () => {
    const facts = contractOf({
      ...TRX_PERPETUAL,
      quoteAsset: 'USDC',
      marginAsset: 'USDC',
      status: 'CLOSE',
    });
    expect(contractProblems(facts)).toHaveLength(3);
  });

  it('reports an unlisted symbol as unsupported, a duplicate as malformed', () => {
    const body = exchangeInfoBody();
    expect(
      parseExchangeInfo({
        ...body,
        symbols: body.symbols.filter((s) => s['symbol'] !== 'TRXUSDT'),
      }),
    ).toEqual({
      ok: false,
      failure: { kind: 'unsupported', detail: 'TRXUSDT is not listed.' },
    });
    expect(parseExchangeInfo({ ...body, symbols: [...body.symbols, TRX_PERPETUAL] })).toEqual({
      ok: false,
      failure: { kind: 'malformed', detail: 'TRXUSDT is listed more than once.' },
    });
  });

  it.each([
    [null, 'symbols is not a list.'],
    [[], 'symbols is not a list.'],
    [{ symbols: 'TRXUSDT' }, 'symbols is not a list.'],
    [exchangeInfoBody({ ...TRX_PERPETUAL, status: 7 }), 'status is missing.'],
    [exchangeInfoBody({ ...TRX_PERPETUAL, marginAsset: '' }), 'marginAsset is missing.'],
    [exchangeInfoBody({ ...TRX_PERPETUAL, filters: {} }), 'filters is not a list.'],
    [
      exchangeInfoBody({
        ...TRX_PERPETUAL,
        filters: [...TRX_PERPETUAL.filters, { notional: '10', filterType: 'MIN_NOTIONAL' }],
      }),
      'MIN_NOTIONAL is listed more than once.',
    ],
  ])('rejects malformed body %#', (body, detail) => {
    expect(parseExchangeInfo(body)).toEqual({ ok: false, failure: { kind: 'malformed', detail } });
  });

  it('marks a missing or malformed filter without dropping the others', () => {
    const facts = withFilters([
      { minPrice: '0.00132', maxPrice: '20000', filterType: 'PRICE_FILTER', tickSize: 1e-5 },
      { stepSize: '1', filterType: 'LOT_SIZE', maxQty: '20000000', minQty: '1' },
      { notional: '5', filterType: 'MIN_NOTIONAL' },
    ]);
    expect(facts.priceFilter).toEqual({ state: 'malformed', field: 'tickSize' });
    expect(facts.marketLotSize).toEqual({ state: 'missing' });
    expect(facts.lotSize.state).toBe('reported');
    expect(facts.minNotional.state).toBe('reported');
  });

  it('marks a missing or malformed liquidation fee rate', () => {
    const { liquidationFee: _, ...rest } = TRX_PERPETUAL;
    expect(contractOf(rest).liquidationFee).toEqual({ state: 'missing' });
    expect(contractOf({ ...TRX_PERPETUAL, liquidationFee: 0.0125 }).liquidationFee).toEqual({
      state: 'malformed',
    });
  });
});

describe('parsePremiumIndex', () => {
  it('keeps mark price and the reported funding rate as strings', () => {
    expect(parsePremiumIndex(PREMIUM_INDEX)).toEqual({
      ok: true,
      data: {
        markPrice: '0.30707000',
        lastFundingRate: '-0.00058793',
        lastFundingRatePercent: '-0.058793',
        nextFundingTime: 1794700800000,
        time: 1794690980003,
      },
    });
  });

  it.each([
    [{ symbol: 'TRXUSDC' }, 'unsupported', 'The response is for TRXUSDC, not TRXUSDT.'],
    [{ symbol: undefined }, 'malformed', 'symbol is missing.'],
    [{ markPrice: '0' }, 'malformed', 'markPrice is not a positive decimal.'],
    [{ markPrice: 0.30707 }, 'malformed', 'markPrice is not a positive decimal.'],
    [{ lastFundingRate: '-5.8793e-4' }, 'malformed', 'lastFundingRate is not a plain decimal.'],
    [{ nextFundingTime: '1794700800000' }, 'malformed', 'nextFundingTime is not a timestamp.'],
    [{ nextFundingTime: 0 }, 'malformed', 'nextFundingTime is not a timestamp.'],
    [{ time: 1.5 }, 'malformed', 'time is not a timestamp.'],
    [{ time: 9e15 }, 'malformed', 'time is not a timestamp.'],
  ])('refuses %j', (change, kind, detail) => {
    expect(parsePremiumIndex({ ...PREMIUM_INDEX, ...change })).toEqual({
      ok: false,
      failure: { kind, detail },
    });
  });

  it('refuses a list', () => {
    expect(parsePremiumIndex([PREMIUM_INDEX]).ok).toBe(false);
  });
});

describe('parseTickerPrice', () => {
  it('keeps the last price and its transaction time', () => {
    expect(parseTickerPrice(TICKER_PRICE)).toEqual({
      ok: true,
      data: { price: '0.30712', time: 1794690982309 },
    });
  });

  it.each([
    [[TICKER_PRICE], 'The response is not an object.'],
    [{ ...TICKER_PRICE, price: '-1' }, 'price is not a positive decimal.'],
    [{ ...TICKER_PRICE, time: null }, 'time is not a timestamp.'],
  ])('refuses %#', (body, detail) => {
    expect(parseTickerPrice(body)).toEqual({ ok: false, failure: { kind: 'malformed', detail } });
  });

  it('refuses another symbol', () => {
    expect(parseTickerPrice({ ...TICKER_PRICE, symbol: 'TRXUSDT_260327' })).toMatchObject({
      ok: false,
      failure: { kind: 'unsupported' },
    });
  });
});

describe('parseFundingInfo', () => {
  it('reads the published interval, cap and floor exactly', () => {
    expect(parseFundingInfo(fundingInfoBody())).toEqual({
      ok: true,
      data: {
        published: true,
        fundingIntervalHours: 8,
        cap: '0.004875',
        capPercent: '0.4875',
        floor: '-0.004875',
        floorPercent: '-0.4875',
      },
    });
  });

  it('reports an omitted symbol as unpublished, with no interval', () => {
    const parsed = parseFundingInfo(fundingInfoBody([]));
    expect(parsed).toEqual({ ok: true, data: { published: false } });
    expect(JSON.stringify(parsed)).not.toMatch(/8|Interval/);
  });

  it.each([
    [{ fundingIntervalHours: '8' }, 'fundingIntervalHours is not a positive whole number.'],
    [{ fundingIntervalHours: 0 }, 'fundingIntervalHours is not a positive whole number.'],
    [{ fundingIntervalHours: 7.5 }, 'fundingIntervalHours is not a positive whole number.'],
    [{ adjustedFundingRateCap: null }, 'adjustedFundingRateCap is not a plain decimal.'],
    [{ adjustedFundingRateFloor: '-4.875e-3' }, 'adjustedFundingRateFloor is not a plain decimal.'],
  ])('refuses %j', (change, detail) => {
    expect(parseFundingInfo(fundingInfoBody([{ ...TRX_FUNDING, ...change }]))).toEqual({
      ok: false,
      failure: { kind: 'malformed', detail },
    });
  });

  it('refuses a non-list body and a duplicate entry', () => {
    expect(parseFundingInfo({ symbol: 'TRXUSDT' }).ok).toBe(false);
    expect(parseFundingInfo(fundingInfoBody([TRX_FUNDING, TRX_FUNDING]))).toEqual({
      ok: false,
      failure: { kind: 'malformed', detail: 'TRXUSDT is listed more than once.' },
    });
  });
});

describe('contractGate', () => {
  const failed = (kind: 'network' | 'unsupported'): GroupResult<ContractFacts> => ({
    ok: false,
    failure: kind === 'network' ? { kind } : { kind, detail: 'TRXUSDT is not listed.' },
    receivedAt: 1,
  });

  it('confirms only a supported contract', () => {
    expect(contractGate({ ok: true, data: contractOf(TRX_PERPETUAL), receivedAt: 1 })).toBe(
      'confirmed',
    );
    expect(contractGate(failed('unsupported'))).toBe('unsupported');
    expect(contractGate(failed('network'))).toBe('unconfirmed');
  });
});

describe('readPublicContractData', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends exactly one unsigned GET to each documented endpoint', async () => {
    const fetchImpl = mockFetch();
    let clock = 1000;
    const snapshot = await readPublicContractData({
      signal: new AbortController().signal,
      fetchImpl,
      now: () => (clock += 5),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
      'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=TRXUSDT',
      'https://fapi.binance.com/fapi/v2/ticker/price?symbol=TRXUSDT',
      'https://fapi.binance.com/fapi/v1/fundingInfo',
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      expect(init).not.toHaveProperty('headers');
      expect(init).not.toHaveProperty('body');
    }
    expect(
      snapshot.contract.ok && snapshot.premium.ok && snapshot.ticker.ok && snapshot.funding.ok,
    ).toBe(true);
    // Local receipt times come from this device's clock, apart from the provider's own times.
    const received = [snapshot.contract, snapshot.premium, snapshot.ticker, snapshot.funding].map(
      (group) => group.receivedAt,
    );
    expect(new Set(received).size).toBe(4);
    expect(snapshot.premium.ok && snapshot.premium.data.time).toBe(1794690980003);
  });

  it('only talks to the public futures origin', () => {
    expect(FAPI_ORIGIN).toBe('https://fapi.binance.com');
    for (const path of Object.values(ENDPOINTS)) expect(path.startsWith('/fapi/')).toBe(true);
    expect(Object.values(URLS).every((url) => !url.includes('api.binance.com/api/'))).toBe(true);
  });

  it('keeps each failure to its own group', async () => {
    const fetchImpl = mockFetch({
      contract: () => json({ code: 0, msg: 'Service unavailable from a restricted location' }, 451),
      premium: new TypeError('Failed to fetch'),
      ticker: () => new Response('<html>', { status: 200 }),
    });
    const snapshot = await readPublicContractData({
      signal: new AbortController().signal,
      fetchImpl,
      now: () => 7,
    });
    expect(snapshot.contract).toEqual({
      ok: false,
      failure: { kind: 'http', status: 451 },
      receivedAt: 7,
    });
    expect(snapshot.premium).toEqual({ ok: false, failure: { kind: 'network' }, receivedAt: 7 });
    expect(snapshot.ticker).toEqual({
      ok: false,
      failure: { kind: 'malformed', detail: 'The body is not JSON.' },
      receivedAt: 7,
    });
    expect(snapshot.funding.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('stops a slow request at the timeout and does not retry', async () => {
    vi.useFakeTimers();
    const fetchImpl = mockFetch({ funding: 'hang' });
    const pending = readPublicContractData({ signal: new AbortController().signal, fetchImpl });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const snapshot = await pending;
    expect(snapshot.funding).toMatchObject({
      ok: false,
      failure: { kind: 'timeout', ms: REQUEST_TIMEOUT_MS },
    });
    expect(snapshot.contract.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a request stopped by its caller as cancelled', async () => {
    const controller = new AbortController();
    const fetchImpl = mockFetch({
      contract: 'hang',
      premium: 'hang',
      ticker: 'hang',
      funding: 'hang',
    });
    const pending = readPublicContractData({ signal: controller.signal, fetchImpl });
    controller.abort();
    const snapshot = await pending;
    for (const group of [snapshot.contract, snapshot.premium, snapshot.ticker, snapshot.funding]) {
      expect(group).toMatchObject({ ok: false, failure: { kind: 'cancelled' } });
    }
  });

  it('sends nothing usable when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return json({});
    });
    const snapshot = await readPublicContractData({ signal: controller.signal, fetchImpl });
    expect(snapshot.ticker).toMatchObject({ ok: false, failure: { kind: 'cancelled' } });
  });

  it('passes shape failures through with their kind', async () => {
    const fetchImpl = mockFetch({
      contract: () => json(exchangeInfoBody({ ...TRX_PERPETUAL, symbol: 'TRXUSDT_X' })),
      funding: () => json({}),
    });
    const snapshot = await readPublicContractData({
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(snapshot.contract).toMatchObject({ ok: false, failure: { kind: 'unsupported' } });
    expect(snapshot.funding).toMatchObject({ ok: false, failure: { kind: 'malformed' } });
  });
});
