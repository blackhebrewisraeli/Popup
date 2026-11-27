// @vitest-environment node
/**
 * Pure parts of the futures-demo function: owner risk limits, the plan's exact arithmetic, the
 * callback binding and the Demo-only Binance client. SYNTHETIC values only.
 */
import { describe, expect, it } from 'vitest';
import { DEMO_ORIGIN, demoClient, ROUTES } from '../../supabase/functions/futures-demo/binance';
import {
  callbackData,
  parseCallbackData,
  parseRiskLimits,
  parseSymbolRules,
  planLong,
  planSha256,
  priceDrift,
  proposalText,
  targetQuantities,
  type Plan,
} from '../../supabase/functions/futures-demo/plan';
import { RISK } from './futuresDemoFakes';

const RULES = {
  tickSize: '0.01',
  minPrice: '0.01',
  maxPrice: '1000000',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '1000',
  marketStepSize: '0.001',
  marketMinQty: '0.001',
  marketMaxQty: '100',
  minNotional: '5',
  percentUp: '1.05',
};

async function limits(overrides: Record<string, unknown> = {}) {
  const parsed = await parseRiskLimits(JSON.stringify({ ...RISK, ...overrides }));
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

async function plan(overrides: Record<string, unknown> = {}, ask = '100.00', mark = '100.00') {
  const { limits: l, sha256 } = await limits(overrides);
  return planLong({
    candidate: {
      symbol: 'ZCTAUSDT',
      rule: 'synthetic',
      synthetic: true,
      signalReason: 'SYNTHETIC',
    },
    limits: l,
    limitsSha256: sha256,
    rules: RULES,
    ask,
    mark,
    expiresAt: '2026-11-27T12:05:00.000Z',
  });
}

describe('owner risk limits', () => {
  it('stay unset until the owner supplies every one, with no defaults', async () => {
    expect(await parseRiskLimits(undefined)).toEqual({
      error: 'FUTURES_DEMO_RISK_LIMITS is not set',
    });
    expect(await parseRiskLimits('{')).toEqual({ error: 'FUTURES_DEMO_RISK_LIMITS is not JSON' });
    expect(await parseRiskLimits('[]')).toEqual({
      error: 'FUTURES_DEMO_RISK_LIMITS must be an object',
    });
    const { maxLossUsdt: _, ...missing } = RISK;
    expect(await parseRiskLimits(JSON.stringify(missing))).toMatchObject({
      error: expect.stringContaining('exactly'),
    });
    expect(await parseRiskLimits(JSON.stringify({ ...RISK, leverage: 10 }))).toMatchObject({
      error: expect.stringContaining('exactly'),
    });
  });

  it('refuse values out of bounds by name', async () => {
    const parsed = await parseRiskLimits(
      JSON.stringify({
        symbols: ['btc'],
        maxLossUsdt: '0',
        maxNotionalUsdt: '-1',
        stopDistancePercent: '25',
        takeProfitR: ['2', '1'],
        entrySlippageBps: 1.5,
        maxPriceMoveBps: 0,
        proposalTtlSeconds: 10,
      }),
    );
    expect(parsed).toEqual({
      error:
        'FUTURES_DEMO_RISK_LIMITS has invalid symbols, maxLossUsdt, maxNotionalUsdt, stopDistancePercent, takeProfitR, entrySlippageBps, maxPriceMoveBps, proposalTtlSeconds',
    });
  });

  it('hash the same limits identically whatever the key order', async () => {
    const reordered = Object.fromEntries(Object.entries(RISK).reverse());
    const a = await limits();
    const b = await parseRiskLimits(JSON.stringify(reordered));
    expect('sha256' in b && b.sha256).toBe(a.sha256);
    expect((await limits({ maxLossUsdt: '3' })).sha256).not.toBe(a.sha256);
  });
});

describe('the Long plan', () => {
  it('sizes by the loss cap and the notional cap with exact, grid-rounded decimals', async () => {
    const p = (await plan()) as Plan;
    expect(p).toMatchObject({
      symbol: 'ZCTAUSDT',
      side: 'LONG',
      leverage: 5,
      marginType: 'ISOLATED',
      referenceAsk: '100',
      entryLimit: '100.1',
      stopTrigger: '99',
      // min(2 / 1.10 = 1.818…, 100 / 100.10 = 0.999…) → 0.999 on the 0.001 grid
      quantity: '0.999',
      notional: '99.9999',
      initialMargin: '19.99998',
      estimatedLossAtStop: '1.0989',
      targets: [
        { r: '1', price: '101' },
        { r: '2', price: '102' },
      ],
    });
    const lossBound = (await plan({ maxNotionalUsdt: '10000' })) as Plan;
    expect(lossBound.quantity).toBe('1.818');
    expect(Number(lossBound.estimatedLossAtStop)).toBeLessThanOrEqual(2);
  });

  it('refuses what the owner or Binance filters do not allow', async () => {
    expect(await plan({ symbols: ['OTHERUSDT'] })).toBe(
      "ZCTAUSDT is not in the owner's allowed symbols",
    );
    expect(await plan({ maxNotionalUsdt: '4' })).toBe(
      'The risk limits allow less than the minimum notional',
    );
    expect(await plan({ maxLossUsdt: '0.0001' })).toBe(
      'The risk limits allow less than the minimum quantity',
    );
    expect(await plan({}, '100.00', '90.00')).toBe('The entry limit breaks PERCENT_PRICE');
    expect(await plan({}, 'abc')).toBe('The ask or mark price is unreadable');
  });

  it('reads only TRADING USDT perpetual filters', () => {
    const entry = {
      symbol: 'ZCTAUSDT',
      status: 'TRADING',
      contractType: 'PERPETUAL',
      quoteAsset: 'USDT',
      marginAsset: 'USDT',
      filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '1' }],
    };
    expect(parseSymbolRules({ symbols: [] }, 'ZCTAUSDT')).toBe(
      'ZCTAUSDT is not listed on Binance Futures Demo',
    );
    expect(parseSymbolRules({ symbols: [{ ...entry, status: 'SETTLING' }] }, 'ZCTAUSDT')).toBe(
      'ZCTAUSDT is not TRADING',
    );
    expect(
      parseSymbolRules({ symbols: [{ ...entry, contractType: 'CURRENT_QUARTER' }] }, 'ZCTAUSDT'),
    ).toBe('ZCTAUSDT is not a perpetual');
    expect(parseSymbolRules({ symbols: [{ ...entry, marginAsset: 'BTC' }] }, 'ZCTAUSDT')).toBe(
      'ZCTAUSDT is not USDT-margined',
    );
    expect(parseSymbolRules({ symbols: [entry] }, 'ZCTAUSDT')).toMatch(
      /^ZCTAUSDT filters unreadable: stepSize/,
    );
  });

  it('sizes take-profits from the filled quantity, so a partial fill is fully covered', async () => {
    const p = (await plan()) as Plan;
    expect(targetQuantities('0.999', p)).toEqual([
      { price: '101', quantity: '0.499' },
      { price: '102', quantity: '0.5' },
    ]);
    expect(targetQuantities('0.003', p)).toEqual([
      { price: '101', quantity: '0.001' },
      { price: '102', quantity: '0.002' },
    ]);
    expect(targetQuantities('0.001', p)).toEqual([{ price: '101', quantity: '0.001' }]);
  });

  it('detects a materially changed market on approval', async () => {
    const p = (await plan()) as Plan;
    expect(priceDrift(p, '100.10')).toBeNull();
    expect(priceDrift(p, '100.11')).toBe('The ask 100.11 is above the approved limit 100.1');
    expect(priceDrift(p, '99.70')).toBe('The ask moved 30 bps from 100 (limit 20 bps)');
    expect(priceDrift(p, 'x')).toBe('The current ask is unreadable');
  });
});

describe('the Telegram proposal', () => {
  it('shows every approved term and binds buttons to the proposal hash within 64 bytes', async () => {
    const p = (await plan()) as Plan;
    const id = '00000000-0000-4000-8000-000000000001';
    const sha = await planSha256(id, p);
    const text = proposalText(id, sha, p);
    for (const term of [
      'SYNTHETIC CANDIDATE — not a trading signal',
      'Binance Futures DEMO',
      'ZCTAUSDT USDⓈ-M perpetual · LONG · isolated · 5×',
      'Signal: SYNTHETIC',
      'at most 100.1 (ask 100)',
      'Size: 0.999 ZCTA',
      'Stop trigger: 99',
      'Estimated loss at stop: 1.0989 USDT',
      'Targets (reduce-only): 101 (1R), 102 (2R)',
      'Expires: 2026-11-27 12:05 UTC',
    ]) {
      expect(text).toContain(term);
    }
    const data = callbackData('a', id, sha);
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(parseCallbackData(data)).toEqual({ action: 'approve', id, sha8: sha.slice(0, 8) });
    expect(parseCallbackData(callbackData('r', id, sha))?.action).toBe('reject');
    expect(parseCallbackData('a:not-a-proposal')).toBeNull();
    expect(parseCallbackData(42)).toBeNull();
    // Any change to the terms changes the hash the buttons carry.
    expect(await planSha256(id, { ...p, quantity: '0.998' })).not.toBe(sha);
  });
});

describe('the Binance Demo client', () => {
  it('signs exactly like Binance’s documented HMAC example', async () => {
    let seen = '';
    const client = demoClient({
      fetch: (async (input: string) => {
        seen = input;
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
      now: () => 1591702613943,
      apiKey: 'dbefbc809e3e83c283a984c3a1459732ea7db1360ca80c5c2c8867408d28cc83',
      apiSecret: '2b5eb11e18796d12d88f13dc27dbbd02c2cc51ff7059765ed9821957d82bb4d9',
    });
    await client.call('newOrder', {
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '1',
      price: '9000',
      timeInForce: 'GTC',
    });
    expect(seen).toBe(
      `${DEMO_ORIGIN}/fapi/v1/order?symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943&signature=3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9`,
    );
  });

  it('reaches only the Demo host and separates unknown outcomes from rejections', async () => {
    expect(DEMO_ORIGIN).toBe('https://demo-fapi.binance.com');
    expect(Object.values(ROUTES).every(([, path]) => path.startsWith('/fapi/'))).toBe(true);
    const answer = (status: number, body: unknown) =>
      demoClient({
        fetch: (async () =>
          new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
        now: () => 0,
        apiKey: 'k',
        apiSecret: 's',
      }).call('newOrder');
    expect(await answer(200, { status: 'NEW' })).toEqual({ kind: 'ok', body: { status: 'NEW' } });
    expect(
      (
        await answer(503, {
          code: -1000,
          msg: 'Unknown error, please check your request or try again later.',
        })
      ).kind,
    ).toBe('unknown');
    expect((await answer(503, { code: -1001, msg: 'Service Unavailable.' })).kind).toBe('rejected');
    expect(
      (await answer(400, { code: -1007, msg: 'Timeout waiting for response from backend server.' }))
        .kind,
    ).toBe('unknown');
    expect((await answer(408, {})).kind).toBe('unknown');
    expect((await answer(502, {})).kind).toBe('unknown');
    expect(await answer(400, { code: -2019, msg: 'Margin is insufficient.' })).toEqual({
      kind: 'rejected',
      status: 400,
      code: -2019,
      msg: 'Margin is insufficient.',
    });
    const thrown = demoClient({
      fetch: (async () => {
        throw new DOMException('slow', 'TimeoutError');
      }) as unknown as typeof fetch,
      now: () => 0,
      apiKey: 'k',
      apiSecret: 's',
    });
    expect(await thrown.call('queryOrder')).toEqual({ kind: 'unknown', reason: 'TimeoutError' });
    const unreadable = demoClient({
      fetch: (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch,
      now: () => 0,
      apiKey: 'k',
      apiSecret: 's',
    });
    expect(await unreadable.call('newOrder')).toEqual({
      kind: 'unknown',
      reason: 'unreadable 2xx',
    });
  });
});
