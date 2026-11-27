// @vitest-environment node
/**
 * The futures-execution Edge Function end to end, through its handler, against a SYNTHETIC local
 * USDⓈ-M Futures account, a recording Telegram Bot API and an in-memory stand-in for its tables
 * (src/test/futuresFakes.ts). No request leaves a test and no order reaches Binance. The synthetic
 * entry rule below exists only in this file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FUTURES_ORIGIN,
  SPOT_API_ORIGIN,
} from '../../supabase/functions/futures-execution/binance';
import { ENTRY_RULES } from '../../supabase/functions/futures-execution/engine';
import {
  handleFutures,
  SECRET_HEADER,
  type FuturesDeps,
} from '../../supabase/functions/futures-execution/handler';
import {
  API_KEY,
  API_SECRET,
  binanceFake,
  BOT_TOKEN,
  fakeSupabase,
  RISK,
  SYMBOL,
  telegram,
  testClock,
} from './futuresFakes';

const SECRET_KEY = 'sb_secret_synthetic_for_tests';
const WEBHOOK_SECRET = 'synthetic_webhook_secret';
const OWNER = 4242;
const RULE = 'test-synthetic';
const NEW_ORDER = 'POST /fapi/v1/order';
const NEW_ALGO = 'POST /fapi/v1/algoOrder';
const STOP_REFUSED = {
  status: 400,
  body: { code: -2021, msg: 'Order would immediately trigger.' },
};

let candidates = true;
beforeAll(() => {
  ENTRY_RULES[RULE] = async () =>
    candidates
      ? { symbol: SYMBOL, rule: RULE, signalReason: 'SYNTHETIC test candidate (local tests only)' }
      : null;
});
afterAll(() => {
  delete ENTRY_RULES[RULE];
});

function world(env: Record<string, string | undefined> = {}) {
  candidates = true;
  const clock = testClock();
  const binance = binanceFake(clock.now);
  const tg = telegram();
  const db = fakeSupabase(clock);
  const settings: Record<string, string | undefined> = {
    SB_REGION: 'eu-west-1',
    SUPABASE_URL: 'https://synthetic.invalid',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
    BINANCE_FUTURES_API_KEY: API_KEY,
    BINANCE_FUTURES_API_SECRET: API_SECRET,
    BINANCE_SPOT_API_KEY: 'synthetic-read-only-spot-key',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    TELEGRAM_OWNER_CHAT_ID: String(OWNER),
    FUTURES_LIVE_ENABLED: 'true',
    FUTURES_ENTRY_RULE: RULE,
    FUTURES_RISK_LIMITS: JSON.stringify(RISK),
    ...env,
  };
  const work: Promise<unknown>[] = [];
  let ids = 0;
  const deps: FuturesDeps = {
    env: (name) => settings[name],
    fetch: (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.origin === FUTURES_ORIGIN || url.origin === SPOT_API_ORIGIN) {
        return binance.binanceFetch(url, init);
      }
      if (url.origin === 'https://api.telegram.org') return tg.telegramFetch(url, init);
      throw new Error(`unexpected request to ${url.origin}`);
    }) as unknown as typeof fetch,
    now: clock.now,
    sleep: clock.sleep,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    log: () => undefined,
    createClient: () => db.client,
    background: (promise) => work.push(promise),
  };
  let updates = 0;
  async function post(headers: Record<string, string>, body: unknown = {}, method = 'POST') {
    const res = await handleFutures(
      new Request('https://synthetic.invalid/functions/v1/futures-execution', {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }),
      deps,
    );
    while (work.length > 0) await work.shift();
    return res;
  }
  const telegramPost = (update: Record<string, unknown>) =>
    post({ [SECRET_HEADER]: WEBHOOK_SECRET }, { update_id: ++updates, ...update });
  const privateChat = { id: OWNER, type: 'private' };
  const tick = async () =>
    (await (await post({ apikey: SECRET_KEY })).json()) as Record<string, unknown>;

  return {
    clock,
    binance,
    tg,
    db,
    settings,
    post,
    tick,
    message: (text: string) =>
      telegramPost({ message: { message_id: 1, from: { id: OWNER }, chat: privateChat, text } }),
    /** Press a button on the latest proposal message, as the owner unless told otherwise. */
    press(
      action: 'a' | 'r',
      options: { from?: number; chat?: Record<string, unknown>; data?: string } = {},
    ) {
      const message = [...tg.calls]
        .reverse()
        .find((c) => c.method === 'sendMessage' && c.body['reply_markup'] !== undefined);
      if (!message) throw new Error('no proposal message');
      const buttons = (
        message.body['reply_markup'] as { inline_keyboard: { callback_data: string }[][] }
      ).inline_keyboard[0];
      const data =
        options.data ??
        buttons?.find((b) => b.callback_data.startsWith(`${action}:`))?.callback_data;
      return telegramPost({
        callback_query: {
          id: `cb-${updates}`,
          from: { id: options.from ?? OWNER },
          message: { message_id: message.messageId, chat: options.chat ?? privateChat },
          data,
        },
      });
    },
    execution: () => db.rows('futures_executions').at(-1),
    proposal: () => db.rows('futures_proposals').at(-1),
    text: () => tg.sent().join('\n---\n'),
  };
}

describe('futures-execution: off by default and gated', () => {
  it('proposes nothing and calls no Binance account endpoint until live is enabled', async () => {
    const w = world({ FUTURES_LIVE_ENABLED: undefined });
    expect((await w.tick())['rule']).toBe('live entries disabled (FUTURES_LIVE_ENABLED)');
    expect(w.binance.calls).toEqual([]);
    expect(w.db.rows('futures_proposals')).toEqual([]);
  });

  it('requires an approved entry rule and the owner risk limits', async () => {
    expect((await world({ FUTURES_ENTRY_RULE: undefined }).tick())['rule']).toBe(
      'no entry rule configured',
    );
    const unknown = world({ FUTURES_ENTRY_RULE: 'spot-liquidity-rank' });
    expect((await unknown.tick())['rule']).toBe(
      'spot-liquidity-rank is not an approved entry rule; nothing detected',
    );
    const unset = world({ FUTURES_RISK_LIMITS: undefined });
    expect((await unset.tick())['rule']).toBe('No proposal: FUTURES_RISK_LIMITS is not set.');
    const quiet = world();
    candidates = false;
    expect((await quiet.tick())['rule']).toBe(`${RULE}: no candidate`);
    for (const w of [unknown, unset, quiet]) expect(w.db.rows('futures_proposals')).toEqual([]);
  });

  it('ignores Telegram commands: synthetic candidates exist only in local tests', async () => {
    const w = world();
    await w.message('/synthetic');
    expect(w.tg.calls).toEqual([]);
    expect(w.db.rows('futures_proposals')).toEqual([]);
  });

  it('refuses approval once live is switched off after the proposal', async () => {
    const w = world();
    await w.tick();
    w.settings['FUTURES_LIVE_ENABLED'] = 'false';
    await w.press('a');
    expect(w.tg.answers()).toEqual(['Live Futures entries are disabled. Nothing was done.']);
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });

  it('refuses a Futures key equal to the Spot key, before any request', async () => {
    const w = world({ BINANCE_SPOT_API_KEY: API_KEY });
    const res = await w.post({ apikey: SECRET_KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Not configured',
      missing: ['BINANCE_FUTURES_API_KEY (must differ from the Spot key)'],
    });
    expect(w.binance.calls).toEqual([]);
  });
});

describe('futures-execution: proposal and approval', () => {
  it('runs owner approval → 5× isolated limit entry → close-all stop and reduce-only targets', async () => {
    const w = world();
    await w.tick();
    const proposal = String(w.tg.calls.find((c) => c.method === 'sendMessage')?.body['text']);
    for (const term of [
      'LIVE Binance USDⓈ-M Futures proposal · rule test-synthetic',
      'Entry bound: limit buy, immediate-or-cancel, at most 100.1 (ask 100)',
      'Size: 1.667 ZCTA · notional ≤ 166.8667 USDT',
      'Collateral: 33.37334 USDT (isolated margin)',
      'Stop trigger: 99',
      'Estimated loss at stop: 1.99964985 USDT (taker fees included',
      'Targets (reduce-only): 101 (1R), 102 (2R)',
      'cumulative loss 0 USDT before this trade · budget 44 USDT',
    ]) {
      expect(proposal).toContain(term);
    }
    expect(w.proposal()).toMatchObject({
      status: 'pending',
      symbol: SYMBOL,
      telegram_message_id: 500,
    });
    expect(w.binance.count(NEW_ORDER)).toBe(0);

    await w.press('a');
    expect(w.tg.answers()).toContain('Approved. Rechecking, then executing on Binance Futures.');
    expect(w.binance.count('GET /sapi/v1/account/apiRestrictions')).toBe(1);
    expect(w.binance.state).toMatchObject({ marginType: 'ISOLATED', leverage: 5, position: 1.667 });
    expect(w.binance.calls.find((c) => c.route === NEW_ORDER)?.params).toMatchObject({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: '1.667',
      price: '100.1',
      newClientOrderId: 'pf-0000000000004000800000000000',
    });
    const algos = w.binance.calls.filter((c) => c.route === NEW_ALGO).map((c) => c.params);
    expect(algos).toEqual([
      expect.objectContaining({
        type: 'STOP_MARKET',
        side: 'SELL',
        triggerPrice: '99',
        closePosition: 'true',
        workingType: 'MARK_PRICE',
      }),
      expect.objectContaining({
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: '101',
        quantity: '0.833',
        reduceOnly: 'true',
      }),
      expect.objectContaining({
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: '102',
        quantity: '0.834',
        reduceOnly: 'true',
      }),
    ]);
    // Exits can only shrink the long.
    expect(algos.every((a) => a['closePosition'] === 'true' || a['reduceOnly'] === 'true')).toBe(
      true,
    );
    expect(w.execution()).toMatchObject({
      state: 'protected',
      filled_qty: '1.667',
      lease_until: null,
    });
    expect(w.text()).toContain('ENTRY FILLED: 1.667 of 1.667 at avg 100.1');
    expect(w.text()).toContain('Stop 99 (close-all, mark price): NEW');
    expect(w.text()).toContain('Target 2: NEW');
  });

  it('places nothing on rejection', async () => {
    const w = world();
    await w.tick();
    const before = w.binance.calls.length;
    await w.press('r');
    expect(w.proposal()?.['status']).toBe('rejected');
    expect(w.binance.calls).toHaveLength(before);
    expect(w.tg.edits().at(-1)).toContain('REJECTED — no order placed.');
    expect(w.db.rows('futures_executions')).toEqual([]);
  });

  it('refuses an expired proposal and the tick marks it expired', async () => {
    const w = world();
    await w.tick();
    w.clock.advance(300_000);
    await w.press('a');
    expect(w.tg.answers().at(-1)).toBe('Not approved: the proposal is expired. Nothing was done.');
    candidates = false;
    await w.tick();
    expect(w.proposal()?.['status']).toBe('expired');
    expect(w.tg.edits().at(-1)).toContain('EXPIRED — no order placed.');
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });

  it('executes a duplicate approval only once', async () => {
    const w = world();
    await w.tick();
    await w.press('a');
    await w.press('a');
    await w.press('r');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
    expect(w.tg.answers().slice(-2)).toEqual([
      'Not approved: the proposal is already approved. Nothing was done.',
      'Not rejected: the proposal is already approved. Nothing was done.',
    ]);
  });

  it('acts only for the configured owner, in their private chat, on that exact proposal', async () => {
    const w = world();
    await w.tick();
    await w.press('a', { from: 99 });
    await w.press('a', { chat: { id: OWNER, type: 'group' } });
    expect(w.tg.answers()).toEqual(['Not authorized.', 'Not authorized.']);
    const id = String(w.proposal()?.['id']);
    await w.press('a', { data: `a:${id}:00000000` });
    expect(w.tg.answers().at(-1)).toBe(
      'This button does not match the stored proposal. Nothing was done.',
    );
    expect(w.proposal()?.['status']).toBe('pending');
    expect((await w.post({ [SECRET_HEADER]: 'wrong' }, {})).status).toBe(401);
    expect((await w.post({}, {})).status).toBe(401);
    expect((await w.post({ apikey: 'sb_publishable_x' }, {})).status).toBe(401);
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });

  it('refuses an approval whose price or limits changed, sending no order', async () => {
    const moved = world();
    await moved.tick();
    moved.binance.state.ask = '99.50';
    await moved.press('a');
    expect(moved.text()).toContain(
      'NOT EXECUTED: The ask moved 50 bps from 100 (limit 20 bps). No order was sent.',
    );
    expect(moved.execution()?.['state']).toBe('refused');

    const changed = world();
    await changed.tick();
    changed.settings['FUTURES_RISK_LIMITS'] = JSON.stringify({ ...RISK, maxLossPerTradeUsdt: '1' });
    await changed.press('a');
    expect(changed.text()).toContain(
      'NOT EXECUTED: The owner risk limits changed since the proposal.',
    );
    expect(moved.binance.count(NEW_ORDER) + changed.binance.count(NEW_ORDER)).toBe(0);
  });

  type Fake = ReturnType<typeof binanceFake>;
  it.each([
    ['hedge mode', (b: Fake) => (b.state.dualSidePosition = true), 'not in one-way position mode'],
    ['Multi-Assets mode', (b: Fake) => (b.state.multiAssetsMargin = true), 'Multi-Assets mode'],
    ['auto-add margin', (b: Fake) => (b.state.isAutoAddMargin = true), 'Auto-add margin is on'],
    ['an existing position', (b: Fake) => (b.state.position = 1), 'already has a position'],
    ['low available margin', (b: Fake) => (b.state.available = '10'), 'below the collateral'],
    [
      'a key that can withdraw',
      (b: Fake) => (b.state.permissions['enableWithdrawals'] = true),
      'must not have enableWithdrawals',
    ],
    [
      'a key without Futures',
      (b: Fake) => (b.state.permissions['enableFutures'] = false),
      'lacks enableFutures',
    ],
  ])('refuses to execute with %s', async (_label, arrange, reason) => {
    const w = world();
    await w.tick();
    arrange(w.binance);
    await w.press('a');
    expect(w.text()).toContain(reason);
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });

  it('refuses when an account setting cannot be read', async () => {
    const w = world();
    await w.tick();
    w.binance.script('GET /fapi/v1/accountConfig', 'timeout');
    await w.press('a');
    expect(w.text()).toContain('NOT EXECUTED: Could not verify the account configuration');
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });

  it('skips the trade when the smallest valid order exceeds the loss limit', async () => {
    const w = world({
      FUTURES_RISK_LIMITS: JSON.stringify({ ...RISK, maxLossPerTradeUsdt: '0.01' }),
    });
    expect((await w.tick())['rule']).toBe(
      'No proposal: Skipped: the smallest valid order (0.05, 5.005 USDT notional, 1.001 USDT collateral, 0.0599775 USDT estimated loss) exceeds the limits (0.01 USDT loss, 44 USDT collateral left).',
    );
    expect(w.db.rows('futures_proposals')).toEqual([]);
  });
});

describe('futures-execution: fills, unknown results, failures and results', () => {
  it('protects exactly the partially filled quantity', async () => {
    const w = world();
    w.binance.state.fillRatio = 0.4;
    await w.tick();
    await w.press('a');
    expect(w.execution()).toMatchObject({ state: 'protected', filled_qty: '0.667' });
    const targets = w.binance.calls.filter(
      (c) => c.route === NEW_ALGO && c.params['type'] === 'TAKE_PROFIT_MARKET',
    );
    expect(targets.map((t) => t.params['quantity'])).toEqual(['0.333', '0.334']);
    expect(w.text()).toContain('ENTRY EXPIRED: 0.667 of 1.667');
  });

  it('reconciles an unknown entry answer by client order ID instead of resending', async () => {
    const w = world();
    w.binance.script(NEW_ORDER, 'apply-then-timeout');
    await w.tick();
    await w.press('a');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
    expect(w.binance.count('GET /fapi/v1/order')).toBeGreaterThan(0);
    expect(w.execution()?.['state']).toBe('protected');
  });

  it('records an unanswered entry Binance never accepted as not placed, without a retry', async () => {
    const w = world();
    w.binance.script(NEW_ORDER, 'timeout');
    await w.tick();
    await w.press('a');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
    expect(w.execution()).toMatchObject({ state: 'not_filled' });
    expect(w.text()).toContain('ENTRY NOT PLACED');
  });

  it('closes reduce-only and verifies flat when the stop cannot be placed', async () => {
    const w = world();
    w.binance.script(NEW_ALGO, STOP_REFUSED);
    await w.tick();
    await w.press('a');
    const close = w.binance.calls.filter((c) => c.route === NEW_ORDER)[1]?.params;
    expect(close).toMatchObject({
      side: 'SELL',
      type: 'MARKET',
      reduceOnly: 'true',
      quantity: '1.667',
    });
    expect(w.binance.state.position).toBe(0);
    expect(w.execution()).toMatchObject({ state: 'closed', close_attempts: 1 });
    expect(w.text()).toContain('PROTECTION FAILED: The stop could not be placed: rejected -2021');
    expect(w.text()).toContain('RESOLVED: position verified flat');
  });

  it('blocks new entries while a failed close is unresolved, and resolves on a later tick', async () => {
    const w = world();
    const refusal = { status: 400, body: { code: -2019, msg: 'Margin is insufficient.' } };
    w.binance.script(NEW_ALGO, STOP_REFUSED);
    w.binance.script(NEW_ORDER, 'apply-then-timeout', refusal, refusal, refusal);
    w.binance.script('GET /fapi/v1/order', {
      status: 200,
      body: { status: 'FILLED', executedQty: '1.667', avgPrice: '100.1', orderId: 1 },
    });
    await w.tick();
    await w.press('a');
    expect(w.execution()).toMatchObject({ state: 'unresolved' });
    expect(w.text()).toContain('UNRESOLVED: position 1.667 ZCTAUSDT');

    // The tick's close attempt fails again, and its rule may not propose meanwhile.
    expect((await w.tick())['rule']).toBe(
      'No proposal: a Futures execution is still open or unresolved.',
    );
    expect(w.db.rows('futures_proposals')).toHaveLength(1);

    candidates = false;
    await w.tick();
    expect(w.binance.state.position).toBe(0);
    expect(w.execution()).toMatchObject({ state: 'closed', close_attempts: 4 });
    expect(w.text()).toContain('New entries are unblocked.');
  });

  it('reconciles after a restart: an entry left unknown is found and protected by the tick', async () => {
    const w = world();
    w.binance.script(NEW_ORDER, 'apply-then-timeout');
    w.binance.script('GET /fapi/v1/order', 'timeout', 'timeout', 'timeout', 'timeout');
    await w.tick();
    await w.press('a');
    expect(w.execution()).toMatchObject({ state: 'entry_unknown', lease_until: null });
    expect(w.text()).toContain('Entry status UNKNOWN');
    await w.tick();
    expect(w.execution()?.['state']).toBe('protected');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
  });

  it('abandons an execution found claimed after a restart, once its lease lapses', async () => {
    const w = world();
    await w.tick();
    candidates = false;
    // The invocation claimed the approval and died before writing the entry state.
    const id = w.proposal()?.['id'];
    await w.db.client
      .from('futures_proposals')
      .update({ status: 'approved', decided_by: OWNER })
      .eq('id', id);
    await w.db.client.from('futures_executions').insert({
      proposal_id: id,
      state: 'claimed',
      entry_client_order_id: 'pf-0000000000004000800000000000',
      lease_until: new Date(w.clock.now() + 150_000).toISOString(),
    });
    expect((await w.tick())['skipped']).toEqual([id]);
    w.clock.advance(151_000);
    await w.tick();
    expect(w.execution()?.['state']).toBe('abandoned');
    expect(w.binance.count(NEW_ORDER)).toBe(0);
    expect(w.text()).toContain('ABANDONED after a restart before any order was sent.');
  });

  it('after the stop fires: cancels sibling exits, records the loss, and counts it next time', async () => {
    const w = world();
    await w.tick();
    await w.press('a');
    candidates = false;
    await w.tick();
    expect(w.execution()?.['state']).toBe('protected');
    w.binance.triggerStop(99);
    await w.tick();
    expect(w.execution()).toMatchObject({ state: 'closed' });
    expect([...w.binance.state.algos.values()].filter((a) => a['algoStatus'] === 'NEW')).toEqual(
      [],
    );
    expect(w.text()).toContain('CLOSED: position is flat');
    // (99 − 100.1) × 1.667 − 0.05% taker fees on 166.8667 and 165.033: the estimate, exactly
    expect(w.execution()?.['realized_pnl']).toBe('-1.99964985');
    expect(w.text()).toContain('RESULT: net -1.99964985 USDT');

    candidates = true;
    await w.tick();
    expect(w.text()).toContain('cumulative loss 1.99964985 USDT before this trade');
    expect(w.proposal()?.['plan']).toMatchObject({ cumulativeLossBefore: '1.99964985' });
  });

  it('stops proposing once the cumulative loss limit is reached', async () => {
    const w = world({
      FUTURES_RISK_LIMITS: JSON.stringify({ ...RISK, maxCumulativeLossUsdt: '2' }),
    });
    await w.tick();
    await w.press('a');
    w.binance.triggerStop(98);
    candidates = false;
    await w.tick();
    expect(Number(w.execution()?.['realized_pnl'])).toBeLessThan(-2);
    candidates = true;
    expect((await w.tick())['rule']).toMatch(
      /^No proposal: The cumulative loss limit is reached \(3\.\d+ USDT\)\.$/,
    );
  });

  it('stops proposing while a closed trade’s result cannot be verified', async () => {
    const w = world();
    w.binance.state.commissionAsset = 'BNB';
    await w.tick();
    await w.press('a');
    w.binance.triggerStop(99);
    candidates = false;
    await w.tick();
    expect(w.execution()).toMatchObject({ state: 'closed', realized_pnl: null });
    candidates = true;
    expect((await w.tick())['rule']).toBe(
      'No proposal: The realized result of 00000000 is not verified yet.',
    );
  });

  it('replaces a stop that disappeared while the position is open', async () => {
    const w = world();
    await w.tick();
    await w.press('a');
    candidates = false;
    const stop = [...w.binance.state.algos.values()].find((a) => a['type'] === 'STOP_MARKET');
    if (stop) stop['algoStatus'] = 'CANCELED';
    await w.tick();
    expect(
      w.binance.calls.filter((c) => c.route === NEW_ALGO && c.params['type'] === 'STOP_MARKET'),
    ).toHaveLength(2);
    expect(w.binance.state.algos.get(String(stop?.['clientAlgoId']))?.['algoStatus']).toBe('NEW');
    expect(w.execution()?.['state']).toBe('protected');
  });

  it('closes a long the finished stop left open', async () => {
    const w = world();
    await w.tick();
    await w.press('a');
    candidates = false;
    const stop = [...w.binance.state.algos.values()].find((a) => a['type'] === 'STOP_MARKET');
    if (stop) stop['algoStatus'] = 'FINISHED';
    await w.tick();
    expect(w.text()).toContain('PROTECTION FAILED: The stop finished but a long position remains');
    expect(w.binance.state.position).toBe(0);
    expect(w.execution()?.['state']).toBe('closed');
  });
});

describe('futures-execution: handler refusals', () => {
  it('refuses wrong method, region and missing configuration without touching Binance', async () => {
    const w = world();
    expect((await w.post({ apikey: SECRET_KEY }, undefined, 'GET')).status).toBe(405);
    w.settings['SB_REGION'] = 'us-east-1';
    expect((await w.post({ apikey: SECRET_KEY })).status).toBe(421);
    w.settings['SB_REGION'] = 'eu-west-1';
    w.settings['BINANCE_FUTURES_API_SECRET'] = undefined;
    const res = await w.post({ apikey: SECRET_KEY });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Not configured',
      missing: ['BINANCE_FUTURES_API_SECRET'],
    });
    expect(w.binance.calls).toEqual([]);
  });
});
