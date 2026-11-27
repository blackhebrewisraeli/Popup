// @vitest-environment node
/**
 * The futures-demo Edge Function end to end, through its handler, against a SYNTHETIC stateful
 * Binance Futures Demo, a recording Telegram Bot API and an in-memory stand-in for its tables
 * (src/test/futuresDemoFakes.ts). No request leaves a test; the clock is a test clock.
 */
import { describe, expect, it } from 'vitest';
import { DEMO_ORIGIN } from '../../supabase/functions/futures-demo/binance';
import {
  handleFuturesDemo,
  SECRET_HEADER,
  type FuturesDemoDeps,
} from '../../supabase/functions/futures-demo/handler';
import {
  API_KEY,
  API_SECRET,
  binanceDemo,
  BOT_TOKEN,
  fakeSupabase,
  RISK,
  SYMBOL,
  telegram,
  testClock,
} from './futuresDemoFakes';

const SECRET_KEY = 'sb_secret_synthetic_for_tests';
const WEBHOOK_SECRET = 'synthetic_webhook_secret';
const OWNER = 4242;
const NEW_ORDER = 'POST /fapi/v1/order';
const NEW_ALGO = 'POST /fapi/v1/algoOrder';

function world(env: Record<string, string | undefined> = {}) {
  const clock = testClock();
  const binance = binanceDemo();
  const tg = telegram();
  const db = fakeSupabase(clock);
  const settings: Record<string, string | undefined> = {
    SB_REGION: 'eu-west-1',
    SUPABASE_URL: 'https://synthetic.invalid',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET_KEY }),
    BINANCE_FUTURES_DEMO_API_KEY: API_KEY,
    BINANCE_FUTURES_DEMO_API_SECRET: API_SECRET,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    TELEGRAM_OWNER_CHAT_ID: String(OWNER),
    FUTURES_DEMO_ENABLED: 'true',
    FUTURES_DEMO_RISK_LIMITS: JSON.stringify(RISK),
    ...env,
  };
  const work: Promise<unknown>[] = [];
  const logs: string[] = [];
  let ids = 0;
  const deps: FuturesDemoDeps = {
    env: (name) => settings[name],
    fetch: (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.origin === DEMO_ORIGIN) return binance.demoFetch(url, init);
      if (url.origin === 'https://api.telegram.org') return tg.telegramFetch(url, init);
      throw new Error(`unexpected request to ${url.origin}`);
    }) as unknown as typeof fetch,
    now: clock.now,
    sleep: clock.sleep,
    randomUUID: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    log: (line) => logs.push(line),
    createClient: () => db.client,
    background: (promise) => work.push(promise),
  };
  let updates = 0;
  async function post(headers: Record<string, string>, body: unknown = {}, method = 'POST') {
    const res = await handleFuturesDemo(
      new Request('https://synthetic.invalid/functions/v1/futures-demo', {
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

  return {
    clock,
    binance,
    tg,
    db,
    settings,
    logs,
    post,
    command: (text: string, from = OWNER, chat: Record<string, unknown> = privateChat) =>
      telegramPost({ message: { message_id: 1, from: { id: from }, chat, text } }),
    /** Press a button on the latest proposal message, as the owner unless told otherwise. */
    press(
      action: 'a' | 'r',
      options: { from?: number; chat?: Record<string, unknown>; data?: string } = {},
    ) {
      const message = [...tg.calls]
        .reverse()
        .find((c) => c.body['reply_markup'] !== undefined && c.method === 'sendMessage');
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
    tick: () => post({ apikey: SECRET_KEY }),
    execution: () => db.rows('futures_demo_executions')[0],
    proposal: () => db.rows('futures_demo_proposals').at(-1),
    text: () => tg.sent().join('\n---\n'),
  };
}

describe('futures-demo: proposal and approval', () => {
  it('runs Telegram approval → 5× isolated limit entry → close-all stop and reduce-only targets', async () => {
    const w = world();
    await w.command('/synthetic');
    const proposal = w.tg.calls.find((c) => c.method === 'sendMessage');
    expect(proposal?.body['chat_id']).toBe(OWNER);
    expect(String(proposal?.body['text'])).toContain('SYNTHETIC CANDIDATE — not a trading signal');
    expect(w.proposal()).toMatchObject({
      status: 'pending',
      synthetic: true,
      symbol: SYMBOL,
      telegram_message_id: 500,
    });
    expect(w.binance.count(NEW_ORDER)).toBe(0);

    await w.press('a');
    expect(w.tg.answers()).toContain('Approved. Rechecking, then executing in Binance Demo.');
    expect(w.binance.state).toMatchObject({ marginType: 'ISOLATED', leverage: 5, position: 0.999 });
    const entry = w.binance.calls.find((c) => c.route === NEW_ORDER)?.params;
    expect(entry).toMatchObject({
      symbol: SYMBOL,
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: '0.999',
      price: '100.1',
      newClientOrderId: 'pd-0000000000004000800000000000',
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
        side: 'SELL',
        triggerPrice: '101',
        quantity: '0.499',
        reduceOnly: 'true',
      }),
      expect.objectContaining({
        type: 'TAKE_PROFIT_MARKET',
        side: 'SELL',
        triggerPrice: '102',
        quantity: '0.5',
        reduceOnly: 'true',
      }),
    ]);
    // Exits can only shrink the long: no exit carries both a quantity and no reduce-only/close-all flag.
    expect(algos.every((a) => a['closePosition'] === 'true' || a['reduceOnly'] === 'true')).toBe(
      true,
    );
    expect(w.execution()).toMatchObject({
      state: 'protected',
      filled_qty: '0.999',
      lease_until: null,
    });
    expect(w.text()).toContain('ENTRY FILLED: 0.999 of 0.999 at avg 100.1');
    expect(w.text()).toContain('Stop 99 (close-all, mark price): NEW');
    expect(w.text()).toContain('Target 2: NEW');
    expect(w.tg.edits().at(-1)).toContain('APPROVED — executing in Demo');
  });

  it('places nothing on rejection', async () => {
    const w = world();
    await w.command('/synthetic');
    await w.press('r');
    expect(w.proposal()?.['status']).toBe('rejected');
    expect(
      w.binance.calls.filter(
        (c) =>
          c.route !== 'GET /fapi/v1/exchangeInfo' &&
          !c.route.includes('ticker') &&
          !c.route.includes('premium'),
      ),
    ).toEqual([]);
    expect(w.tg.edits().at(-1)).toContain('REJECTED — no order placed.');
    expect(w.db.rows('futures_demo_executions')).toEqual([]);
  });

  it('refuses an expired proposal and the tick marks it expired', async () => {
    const w = world();
    await w.command('/synthetic');
    w.clock.advance(300_000);
    await w.press('a');
    expect(w.tg.answers().at(-1)).toBe('Not approved: the proposal is expired. Nothing was done.');
    expect(w.binance.count(NEW_ORDER)).toBe(0);
    await w.tick();
    expect(w.proposal()?.['status']).toBe('expired');
    expect(w.tg.edits().at(-1)).toContain('EXPIRED — no order placed.');
  });

  it('executes a duplicate approval only once', async () => {
    const w = world();
    await w.command('/synthetic');
    await w.press('a');
    await w.press('a');
    await w.press('r');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
    expect(w.tg.answers().slice(-2)).toEqual([
      'Not approved: the proposal is already approved. Nothing was done.',
      'Not rejected: the proposal is already approved. Nothing was done.',
    ]);
  });

  it('serves only the configured owner in their private chat, with the webhook secret', async () => {
    const w = world();
    await w.command('/synthetic', 99);
    await w.command('/synthetic', OWNER, { id: -100, type: 'group' });
    expect(w.db.rows('futures_demo_proposals')).toEqual([]);
    await w.command('/synthetic');
    await w.press('a', { from: 99 });
    await w.press('a', { chat: { id: OWNER, type: 'group' } });
    expect(w.tg.answers()).toEqual(['Not authorized.', 'Not authorized.']);
    // A button not matching the stored proposal hash is refused.
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

  it('keeps every entry off until the owner supplies risk limits and enables entries', async () => {
    const unset = world({ FUTURES_DEMO_RISK_LIMITS: undefined });
    await unset.command('/synthetic');
    expect(unset.tg.sent()).toEqual(['No proposal: FUTURES_DEMO_RISK_LIMITS is not set.']);
    const disabled = world({ FUTURES_DEMO_ENABLED: undefined });
    await disabled.command('/synthetic');
    expect(disabled.tg.sent()).toEqual([
      'Futures Demo entries are disabled (FUTURES_DEMO_ENABLED).',
    ]);
    const other = world();
    await other.command('/synthetic BTCUSDT');
    expect(other.tg.sent()).toEqual([
      'No proposal: BTCUSDT is not listed on Binance Futures Demo.',
    ]);
  });

  it('refuses an approval whose market or limits changed, sending no order', async () => {
    const moved = world();
    await moved.command('/synthetic');
    moved.binance.state.ask = '99.50';
    await moved.press('a');
    expect(moved.text()).toContain(
      'NOT EXECUTED: The ask moved 50 bps from 100 (limit 20 bps). No order was sent.',
    );
    expect(moved.execution()?.['state']).toBe('refused');

    const changed = world();
    await changed.command('/synthetic');
    changed.settings['FUTURES_DEMO_RISK_LIMITS'] = JSON.stringify({ ...RISK, maxLossUsdt: '5' });
    await changed.press('a');
    expect(changed.text()).toContain(
      'NOT EXECUTED: The owner risk limits changed since the proposal.',
    );
    expect(moved.binance.count(NEW_ORDER) + changed.binance.count(NEW_ORDER)).toBe(0);
  });

  it.each([
    [
      'hedge mode',
      (b: ReturnType<typeof binanceDemo>) => (b.state.dualSidePosition = true),
      'not in one-way position mode',
    ],
    [
      'Multi-Assets mode',
      (b: ReturnType<typeof binanceDemo>) => (b.state.multiAssetsMargin = true),
      'Multi-Assets mode',
    ],
    [
      'auto-add margin',
      (b: ReturnType<typeof binanceDemo>) => (b.state.isAutoAddMargin = true),
      'Auto-add margin is on',
    ],
    [
      'an existing position',
      (b: ReturnType<typeof binanceDemo>) => (b.state.position = 1),
      'already has a position',
    ],
    [
      'low balance',
      (b: ReturnType<typeof binanceDemo>) => (b.state.available = '10'),
      'below the initial margin',
    ],
  ])('refuses to execute with %s', async (_label, arrange, reason) => {
    const w = world();
    await w.command('/synthetic');
    arrange(w.binance);
    await w.press('a');
    expect(w.text()).toContain(reason);
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });

  it('refuses when an account setting cannot be read', async () => {
    const w = world();
    await w.command('/synthetic');
    w.binance.script('GET /fapi/v1/accountConfig', 'timeout');
    await w.press('a');
    expect(w.text()).toContain('NOT EXECUTED: Could not verify the account configuration');
    expect(w.binance.count(NEW_ORDER)).toBe(0);
  });
});

describe('futures-demo: fills, unknown results and failures', () => {
  it('protects exactly the partially filled quantity', async () => {
    const w = world();
    w.binance.state.fillRatio = 0.4;
    await w.command('/synthetic');
    await w.press('a');
    expect(w.execution()).toMatchObject({ state: 'protected', filled_qty: '0.400' });
    const targets = w.binance.calls.filter(
      (c) => c.route === NEW_ALGO && c.params['type'] === 'TAKE_PROFIT_MARKET',
    );
    expect(targets.map((t) => t.params['quantity'])).toEqual(['0.2', '0.2']);
    expect(w.text()).toContain('ENTRY EXPIRED: 0.400 of 0.999');
  });

  it('reconciles an unknown entry answer by client order ID instead of resending', async () => {
    const w = world();
    w.binance.script(NEW_ORDER, 'apply-then-timeout');
    await w.command('/synthetic');
    await w.press('a');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
    expect(w.binance.count('GET /fapi/v1/order')).toBeGreaterThan(0);
    expect(w.execution()?.['state']).toBe('protected');
  });

  it('records an unanswered entry Binance never accepted as not placed, without a retry', async () => {
    const w = world();
    w.binance.script(NEW_ORDER, 'timeout');
    await w.command('/synthetic');
    await w.press('a');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
    expect(w.execution()).toMatchObject({ state: 'not_filled' });
    expect(w.text()).toContain('ENTRY NOT PLACED');
  });

  it('closes reduce-only and verifies flat when the stop cannot be placed', async () => {
    const w = world();
    w.binance.script(NEW_ALGO, {
      status: 400,
      body: { code: -2021, msg: 'Order would immediately trigger.' },
    });
    await w.command('/synthetic');
    await w.press('a');
    const close = w.binance.calls.filter((c) => c.route === NEW_ORDER)[1]?.params;
    expect(close).toMatchObject({
      side: 'SELL',
      type: 'MARKET',
      reduceOnly: 'true',
      quantity: '0.999',
    });
    expect(w.binance.state.position).toBe(0);
    expect(w.execution()).toMatchObject({ state: 'closed', close_attempts: 1 });
    expect(w.text()).toContain('PROTECTION FAILED: The stop could not be placed: rejected -2021');
    expect(w.text()).toContain('RESOLVED: position verified flat');
  });

  it('blocks new entries while a failed close is unresolved, and resolves on a later tick', async () => {
    const w = world();
    w.binance.script(NEW_ALGO, {
      status: 400,
      body: { code: -2021, msg: 'Order would immediately trigger.' },
    });
    w.binance.script(NEW_ORDER, 'apply-then-timeout');
    w.binance.script('GET /fapi/v1/order', {
      status: 200,
      body: { status: 'FILLED', executedQty: '0.999', avgPrice: '100.1', orderId: 1 },
    });
    // Both immediate close attempts fail; the scheduled tick makes the third.
    const refusal = { status: 400, body: { code: -2019, msg: 'Margin is insufficient.' } };
    w.binance.script(NEW_ORDER, refusal, refusal);
    await w.command('/synthetic');
    await w.press('a');
    expect(w.execution()).toMatchObject({ state: 'unresolved' });
    expect(w.text()).toContain('UNRESOLVED: position 0.999 ZCTAUSDT');

    await w.command('/synthetic');
    expect(w.tg.sent().at(-1)).toBe('No proposal: a Demo execution is still open or unresolved.');

    await w.tick();
    expect(w.binance.state.position).toBe(0);
    expect(w.execution()).toMatchObject({ state: 'closed', close_attempts: 3 });
    expect(w.text()).toContain('New entries are unblocked.');
  });

  it('reconciles after a restart: an entry left unknown is found and protected by the tick', async () => {
    const w = world();
    w.binance.script(NEW_ORDER, 'apply-then-timeout');
    w.binance.script('GET /fapi/v1/order', 'timeout', 'timeout', 'timeout', 'timeout');
    await w.command('/synthetic');
    await w.press('a');
    expect(w.execution()).toMatchObject({ state: 'entry_unknown', lease_until: null });
    expect(w.text()).toContain('Entry status UNKNOWN');
    await w.tick();
    expect(w.execution()?.['state']).toBe('protected');
    expect(w.binance.count(NEW_ORDER)).toBe(1);
  });

  it('abandons an execution found claimed after a restart, once its lease lapses', async () => {
    const w = world();
    await w.command('/synthetic');
    // The invocation claimed the approval and died before writing the entry state.
    const id = w.proposal()?.['id'];
    await w.db.client
      .from('futures_demo_proposals')
      .update({ status: 'approved', decided_by: OWNER })
      .eq('id', id);
    await w.db.client.from('futures_demo_executions').insert({
      proposal_id: id,
      state: 'claimed',
      entry_client_order_id: 'pd-0000000000004000800000000000',
      lease_until: new Date(w.clock.now() + 150_000).toISOString(),
    });
    const leased = (await (await w.tick()).json()) as { skipped: string[] };
    expect(leased.skipped).toEqual([id]);
    w.clock.advance(151_000);
    await w.tick();
    expect(w.execution()?.['state']).toBe('abandoned');
    expect(w.binance.count(NEW_ORDER)).toBe(0);
    expect(w.text()).toContain('ABANDONED after a restart before any order was sent.');
  });

  it('cancels and verifies sibling exits once the position is closed', async () => {
    const w = world();
    await w.command('/synthetic');
    await w.press('a');
    await w.tick();
    expect(w.execution()?.['state']).toBe('protected');
    w.binance.triggerStop();
    await w.tick();
    expect(w.execution()?.['state']).toBe('closed');
    expect([...w.binance.state.algos.values()].filter((a) => a['algoStatus'] === 'NEW')).toEqual(
      [],
    );
    expect(w.text()).toContain('CLOSED: position is flat');
  });

  it('replaces a stop that disappeared while the position is open', async () => {
    const w = world();
    await w.command('/synthetic');
    await w.press('a');
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
    await w.command('/synthetic');
    await w.press('a');
    const stop = [...w.binance.state.algos.values()].find((a) => a['type'] === 'STOP_MARKET');
    if (stop) stop['algoStatus'] = 'FINISHED';
    await w.tick();
    expect(w.text()).toContain('PROTECTION FAILED: The stop finished but a long position remains');
    expect(w.binance.state.position).toBe(0);
    expect(w.execution()?.['state']).toBe('closed');
  });
});

describe('futures-demo: handler refusals', () => {
  it('refuses wrong method, region and missing configuration without touching Binance', async () => {
    const w = world();
    expect((await w.post({ apikey: SECRET_KEY }, undefined, 'GET')).status).toBe(405);
    w.settings['SB_REGION'] = 'us-east-1';
    expect((await w.tick()).status).toBe(421);
    w.settings['SB_REGION'] = 'eu-west-1';
    w.settings['BINANCE_FUTURES_DEMO_API_SECRET'] = undefined;
    const res = await w.tick();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Not configured',
      missing: ['BINANCE_FUTURES_DEMO_API_SECRET'],
    });
    expect(w.binance.calls).toEqual([]);
  });

  it('reports that no Futures entry rule is approved', async () => {
    const none = world();
    expect(await (await none.tick()).json()).toEqual({
      expired: 0,
      reconciled: [],
      skipped: [],
      rule: 'none configured',
    });
    const unknown = world({ FUTURES_DEMO_RULE: 'spot-liquidity-rank' });
    expect(((await (await unknown.tick()).json()) as { rule: string }).rule).toBe(
      'spot-liquidity-rank is not an approved entry rule; nothing detected',
    );
    expect(unknown.db.rows('futures_demo_proposals')).toEqual([]);
  });
});
