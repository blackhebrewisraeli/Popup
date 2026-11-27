// @vitest-environment node
/**
 * Pure parts of the futures-execution function: the owner's risk limits and 44 USDT budget, the
 * plan's exact arithmetic, the callback binding and the Binance client. SYNTHETIC values only;
 * no request leaves a test.
 */
import { describe, expect, it } from 'vitest';
import {
  FUTURES_ORIGIN,
  futuresClient,
  ROUTES,
  SPOT_API_ORIGIN,
} from '../../supabase/functions/futures-execution/binance';
import { keyPermissionRefusal } from '../../supabase/functions/futures-execution/engine';
import {
  callbackData,
  parseCallbackData,
  parseRiskLimits,
  parseSymbolRules,
  planLong,
  planSha256,
  priceDrift,
  proposalText,
  riskDrift,
  signedDec,
  targetQuantities,
  type Plan,
} from '../../supabase/functions/futures-execution/plan';
import { RISK } from './futuresFakes';

const RULES = {
  tickSize: '0.01',
  minPrice: '0.01',
  maxPrice: '1000000',
  stepSize: '0.001',
  minQty: '0.001',
  maxQty: '1000',
  marketMaxQty: '100',
  minNotional: '5',
  percentUp: '1.05',
};
const E18 = 10n ** 18n;

async function limits(overrides: Record<string, unknown> = {}) {
  const parsed = await parseRiskLimits(JSON.stringify({ ...RISK, ...overrides }));
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

async function plan(
  overrides: Record<string, unknown> = {},
  market: { ask?: string; mark?: string; fee?: string; cumulativeLoss?: bigint } = {},
) {
  const { limits: l, sha256 } = await limits(overrides);
  return planLong({
    candidate: { symbol: 'ZCTAUSDT', rule: 'test-synthetic', signalReason: 'SYNTHETIC' },
    limits: l,
    limitsSha256: sha256,
    rules: RULES,
    ask: market.ask ?? '100.00',
    mark: market.mark ?? '100.00',
    takerFeeRate: market.fee ?? '0.0005',
    cumulativeLoss: market.cumulativeLoss ?? 0n,
    expiresAt: '2026-11-27T12:05:00.000Z',
  });
}

describe('owner risk limits', () => {
  it('stay unset until the owner supplies every one, with no defaults', async () => {
    expect(await parseRiskLimits(undefined)).toEqual({ error: 'FUTURES_RISK_LIMITS is not set' });
    expect(await parseRiskLimits('{')).toEqual({ error: 'FUTURES_RISK_LIMITS is not JSON' });
    expect(await parseRiskLimits('[]')).toEqual({ error: 'FUTURES_RISK_LIMITS must be an object' });
    const { maxLossPerTradeUsdt: _, ...missing } = RISK;
    expect(await parseRiskLimits(JSON.stringify(missing))).toMatchObject({
      error: expect.stringContaining('exactly'),
    });
    expect(await parseRiskLimits(JSON.stringify({ ...RISK, leverage: 10 }))).toMatchObject({
      error: expect.stringContaining('exactly'),
    });
  });

  it('refuse values out of bounds by name, and a cumulative cap above the 44 USDT budget', async () => {
    const parsed = await parseRiskLimits(
      JSON.stringify({
        symbols: ['btc'],
        maxLossPerTradeUsdt: '0',
        maxCumulativeLossUsdt: '45',
        stopDistancePercent: '25',
        takeProfitR: ['2', '1'],
        entrySlippageBps: 1.5,
        maxPriceMoveBps: 0,
        proposalTtlSeconds: 10,
      }),
    );
    expect(parsed).toEqual({
      error:
        'FUTURES_RISK_LIMITS has invalid symbols, maxLossPerTradeUsdt, maxCumulativeLossUsdt, stopDistancePercent, takeProfitR, entrySlippageBps, maxPriceMoveBps, proposalTtlSeconds',
    });
    expect(await parseRiskLimits(JSON.stringify({ ...RISK, maxLossPerTradeUsdt: '11' }))).toEqual({
      error: 'FUTURES_RISK_LIMITS has invalid maxLossPerTradeUsdt',
    });
  });

  it('hash the same limits identically whatever the key order', async () => {
    const reordered = Object.fromEntries(Object.entries(RISK).reverse());
    const a = await limits();
    const b = await parseRiskLimits(JSON.stringify(reordered));
    expect('sha256' in b && b.sha256).toBe(a.sha256);
    expect((await limits({ maxLossPerTradeUsdt: '3' })).sha256).not.toBe(a.sha256);
  });
});

describe('the Long plan', () => {
  it('sizes by the fee-inclusive loss cap and the budget, with exact grid-rounded decimals', async () => {
    const p = (await plan()) as Plan;
    expect(p).toMatchObject({
      symbol: 'ZCTAUSDT',
      side: 'LONG',
      leverage: 5,
      marginType: 'ISOLATED',
      referenceAsk: '100',
      entryLimit: '100.1',
      stopTrigger: '99',
      // loss per unit 1.1 + (100.1 + 99) × 0.0005 = 1.19955; 2 / 1.19955 = 1.6672… → 1.667
      quantity: '1.667',
      notional: '166.8667',
      collateral: '33.37334',
      estimatedLossAtStop: '1.99964985',
      budgetUsdt: '44',
      cumulativeLossBefore: '0',
      targets: [
        { r: '1', price: '101' },
        { r: '2', price: '102' },
      ],
    });
    // The collateral left of the budget binds: 4 USDT × 5 / 100.1 → 0.199.
    const budgetBound = (await plan({}, { cumulativeLoss: 40n * E18 })) as Plan;
    expect(budgetBound).toBe('The cumulative loss limit is reached (40 USDT)');
    const near = (await plan(
      { maxCumulativeLossUsdt: '44' },
      { cumulativeLoss: 40n * E18 },
    )) as Plan;
    expect(near).toMatchObject({
      quantity: '0.199',
      collateral: '3.98398',
      cumulativeLossBefore: '40',
    });
    // What is left of the cumulative cap binds: 0.5 / 1.19955 → 0.416.
    const capBound = (await plan({}, { cumulativeLoss: (95n * E18) / 10n })) as Plan;
    expect(capBound.quantity).toBe('0.416');
  });

  it('skips when even the smallest valid order breaks a limit', async () => {
    expect(await plan({ maxLossPerTradeUsdt: '0.01' })).toBe(
      'Skipped: the smallest valid order (0.05, 5.005 USDT notional, 1.001 USDT collateral, 0.0599775 USDT estimated loss) exceeds the limits (0.01 USDT loss, 44 USDT collateral left)',
    );
    expect(
      await plan({ maxCumulativeLossUsdt: '44' }, { cumulativeLoss: (4395n * E18) / 100n }),
    ).toMatch(/^Skipped: the smallest valid order .* 0\.05 USDT collateral left\)$/);
  });

  it('refuses what the owner or Binance filters do not allow', async () => {
    expect(await plan({ symbols: ['OTHERUSDT'] })).toBe(
      "ZCTAUSDT is not in the owner's allowed symbols",
    );
    expect(await plan({}, { mark: '90.00' })).toBe('The entry limit breaks PERCENT_PRICE');
    expect(await plan({}, { ask: 'abc' })).toBe('The ask, mark price or fee rate is unreadable');
    expect(await plan({}, { fee: '-1' })).toBe('The ask, mark price or fee rate is unreadable');
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
      'ZCTAUSDT is not listed on Binance USDⓈ-M Futures',
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
    expect(targetQuantities('1.667', p)).toEqual([
      { price: '101', quantity: '0.833' },
      { price: '102', quantity: '0.834' },
    ]);
    expect(targetQuantities('0.001', p)).toEqual([{ price: '101', quantity: '0.001' }]);
  });

  it('detects a materially changed market or risk room on approval', async () => {
    const p = (await plan()) as Plan;
    expect(priceDrift(p, '100.10')).toBeNull();
    expect(priceDrift(p, '100.11')).toBe('The ask 100.11 is above the approved limit 100.1');
    expect(priceDrift(p, '99.70')).toBe('The ask moved 30 bps from 100 (limit 20 bps)');
    expect(priceDrift(p, 'x')).toBe('The current ask is unreadable');
    const { limits: l } = await limits();
    expect(riskDrift(p, l, 0n)).toBeNull();
    expect(riskDrift(p, l, 9n * E18)).toBe(
      'The estimated loss 1.99964985 USDT exceeds the 1 USDT left',
    );
    const { limits: wide } = await limits({ maxCumulativeLossUsdt: '44' });
    expect(riskDrift(p, wide, 12n * E18)).toBe(
      'The collateral 33.37334 USDT exceeds what is left of the budget',
    );
  });

  it('reads signed Binance amounts exactly', () => {
    expect(signedDec('-1.5')).toBe((-15n * E18) / 10n);
    expect(signedDec('2')).toBe(2n * E18);
    expect(signedDec('1e3')).toBeNull();
    expect(signedDec(3)).toBeNull();
  });
});

describe('the Telegram proposal', () => {
  it('shows every approved term and binds buttons to the proposal hash within 64 bytes', async () => {
    const p = (await plan()) as Plan;
    const id = '00000000-0000-4000-8000-000000000001';
    const sha = await planSha256(id, p);
    const text = proposalText(id, sha, p);
    for (const term of [
      'LIVE Binance USDⓈ-M Futures proposal · rule test-synthetic',
      'ZCTAUSDT perpetual · LONG · isolated · 5×',
      'Signal: SYNTHETIC',
      'Entry bound: limit buy, immediate-or-cancel, at most 100.1 (ask 100)',
      'Size: 1.667 ZCTA · notional ≤ 166.8667 USDT',
      'Collateral: 33.37334 USDT',
      'Stop trigger: 99',
      'Estimated loss at stop: 1.99964985 USDT',
      'Targets (reduce-only): 101 (1R), 102 (2R)',
      'budget 44 USDT',
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
    expect(await planSha256(id, { ...p, quantity: '1.666' })).not.toBe(sha);
  });
});

describe('the Binance client and key', () => {
  it('signs exactly like Binance’s documented HMAC example', async () => {
    let seen = '';
    const client = futuresClient({
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
      `${FUTURES_ORIGIN}/fapi/v1/order?symbol=BTCUSDT&side=BUY&type=LIMIT&quantity=1&price=9000&timeInForce=GTC&recvWindow=5000&timestamp=1591702613943&signature=3c661234138461fcc7a7d8746c6558c9842d4e10870d2ecbedf7777cad694af9`,
    );
  });

  it('reaches only its fixed routes and separates unknown outcomes from rejections', async () => {
    expect(FUTURES_ORIGIN).toBe('https://fapi.binance.com');
    for (const route of Object.values(ROUTES)) {
      const [, path, , origin] = route as readonly [string, string, boolean, string?];
      expect(origin === undefined ? path.startsWith('/fapi/') : origin === SPOT_API_ORIGIN).toBe(
        true,
      );
    }
    const answer = (status: number, body: unknown) =>
      futuresClient({
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
    expect((await answer(400, { code: -1007, msg: 'Timeout waiting for response.' })).kind).toBe(
      'unknown',
    );
    expect((await answer(408, {})).kind).toBe('unknown');
    expect((await answer(502, {})).kind).toBe('unknown');
    expect(await answer(400, { code: -2019, msg: 'Margin is insufficient.' })).toEqual({
      kind: 'rejected',
      status: 400,
      code: -2019,
      msg: 'Margin is insufficient.',
    });
    const thrown = futuresClient({
      fetch: (async () => {
        throw new DOMException('slow', 'TimeoutError');
      }) as unknown as typeof fetch,
      now: () => 0,
      apiKey: 'k',
      apiSecret: 's',
    });
    expect(await thrown.call('queryOrder')).toEqual({ kind: 'unknown', reason: 'TimeoutError' });
    const unreadable = futuresClient({
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

  it('accepts only a Futures-trading key with no withdrawal, transfer or other market', () => {
    const key = {
      enableReading: true,
      enableFutures: true,
      enableWithdrawals: false,
      enableInternalTransfer: false,
      permitsUniversalTransfer: false,
      enableSpotAndMarginTrading: false,
      enableMargin: false,
      enableVanillaOptions: false,
      enablePortfolioMarginTrading: false,
    };
    expect(keyPermissionRefusal(key)).toBeNull();
    expect(keyPermissionRefusal(null)).toBe('Could not verify the API key permissions');
    expect(keyPermissionRefusal({ ...key, enableFutures: false })).toBe(
      'The API key lacks enableFutures',
    );
    expect(keyPermissionRefusal({ ...key, permitsUniversalTransfer: undefined })).toBe(
      'The API key must not have permitsUniversalTransfer',
    );
    expect(keyPermissionRefusal({ ...key, enableSpotAndMarginTrading: true })).toBe(
      'The API key must not have enableSpotAndMarginTrading',
    );
  });
});
