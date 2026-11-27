/**
 * SYNTHETIC local stand-ins for the futures-execution function's three dependencies. Nothing here
 * reaches a network or Binance, and no production value is used.
 *
 * - binanceFake: a stateful USDⓈ-M Futures account at the HTTP level (orders, algo orders, one-way
 *   position, account and symbol settings, key permissions, fees, income). It checks the signature,
 *   and a route can be scripted to time out, apply-then-time-out (the order is accepted but the
 *   answer is lost) or answer a canned error.
 * - telegram: records Bot API calls and numbers sent messages.
 * - fakeSupabase: the PostgREST surface supabaseStore uses, holding rows as JSON (like jsonb) and
 *   enforcing what the migration enforces: one pending proposal, decided once, approval refused at
 *   expiry, one open execution, execution only for an approved proposal, final states kept.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { hmacSha256Hex } from '../../supabase/functions/binance-spot-account/handler';

export const SYMBOL = 'ZCTAUSDT';
export const API_KEY = 'synthetic-futures-key';
export const API_SECRET = 'synthetic-futures-secret';
export const BOT_TOKEN = '123456:synthetic-token';
/** SYNTHETIC owner limits for tests; production has none until the owner sets them. */
export const RISK = {
  symbols: [SYMBOL],
  maxLossPerTradeUsdt: '2',
  maxCumulativeLossUsdt: '10',
  stopDistancePercent: '1',
  takeProfitR: ['1', '2'],
  entrySlippageBps: 10,
  maxPriceMoveBps: 20,
  proposalTtlSeconds: 300,
};

type Row = Record<string, unknown>;
type Scripted = 'timeout' | 'apply-then-timeout' | { status: number; body: unknown };

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
}

export function testClock(start = Date.parse('2026-11-27T12:00:00.000Z')): Clock {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

const timeout = () => Promise.reject(new DOMException('synthetic timeout', 'TimeoutError'));
const respond = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

export function binanceFake(now: () => number) {
  const state = {
    ask: '100.00',
    mark: '100.00',
    marginType: 'CROSSED',
    leverage: 20,
    isAutoAddMargin: false,
    dualSidePosition: false,
    multiAssetsMargin: false,
    available: '1000',
    position: 0,
    /** Share of an IOC entry that fills. */
    fillRatio: 1,
    takerRate: '0.0005',
    commissionAsset: 'USDT',
    permissions: {
      enableReading: true,
      enableFutures: true,
      enableWithdrawals: false,
      enableInternalTransfer: false,
      permitsUniversalTransfer: false,
      enableSpotAndMarginTrading: false,
      enableMargin: false,
      enableVanillaOptions: false,
      enablePortfolioMarginTrading: false,
      ipRestrict: false,
    } as Row,
    entryPrice: 0,
    income: [] as Row[],
    orders: new Map<string, Row>(),
    algos: new Map<string, Row>(),
  };
  const money = (n: number) => n.toFixed(8);
  /** Income Binance would write for one fill: commission always, realized PnL when reducing. */
  function fillIncome(side: string, filled: number, price: number) {
    const time = now();
    state.income.push({
      symbol: SYMBOL,
      incomeType: 'COMMISSION',
      income: money(-filled * price * Number(state.takerRate)),
      asset: state.commissionAsset,
      time,
    });
    if (side === 'SELL') {
      state.income.push({
        symbol: SYMBOL,
        incomeType: 'REALIZED_PNL',
        income: money((price - state.entryPrice) * filled),
        asset: 'USDT',
        time,
      });
    }
  }
  const calls: { route: string; params: Record<string, string> }[] = [];
  const script = new Map<string, Scripted[]>();
  let nextId = 1000;

  const live = (o: Row) => o['status'] === 'NEW' || o['status'] === 'PARTIALLY_FILLED';
  const absent = () => ({ status: 400, body: { code: -2013, msg: 'Order does not exist.' } });
  const qty = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

  function handle(route: string, p: Record<string, string>): { status: number; body: unknown } {
    switch (route) {
      case 'GET /fapi/v1/exchangeInfo':
        return {
          status: 200,
          body: {
            symbols: [
              {
                symbol: SYMBOL,
                status: 'TRADING',
                contractType: 'PERPETUAL',
                quoteAsset: 'USDT',
                marginAsset: 'USDT',
                filters: [
                  {
                    filterType: 'PRICE_FILTER',
                    tickSize: '0.01',
                    minPrice: '0.01',
                    maxPrice: '1000000',
                  },
                  { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
                  {
                    filterType: 'MARKET_LOT_SIZE',
                    stepSize: '0.001',
                    minQty: '0.001',
                    maxQty: '100',
                  },
                  { filterType: 'MIN_NOTIONAL', notional: '5' },
                  { filterType: 'PERCENT_PRICE', multiplierUp: '1.0500', multiplierDown: '0.9500' },
                ],
              },
            ],
          },
        };
      case 'GET /fapi/v1/ticker/bookTicker':
        return { status: 200, body: { symbol: SYMBOL, askPrice: state.ask, bidPrice: state.ask } };
      case 'GET /fapi/v1/premiumIndex':
        return { status: 200, body: { symbol: SYMBOL, markPrice: state.mark } };
      case 'GET /fapi/v1/accountConfig':
        return {
          status: 200,
          body: {
            canTrade: true,
            dualSidePosition: state.dualSidePosition,
            multiAssetsMargin: state.multiAssetsMargin,
          },
        };
      case 'GET /fapi/v1/symbolConfig':
        return {
          status: 200,
          body: [
            {
              symbol: SYMBOL,
              marginType: state.marginType,
              isAutoAddMargin: state.isAutoAddMargin,
              leverage: state.leverage,
              maxNotionalValue: '1000000',
            },
          ],
        };
      case 'POST /fapi/v1/marginType':
        if (state.marginType === p['marginType']) {
          return { status: 400, body: { code: -4046, msg: 'No need to change margin type.' } };
        }
        state.marginType = String(p['marginType']);
        return { status: 200, body: { code: 200, msg: 'success' } };
      case 'POST /fapi/v1/leverage':
        state.leverage = Number(p['leverage']);
        return {
          status: 200,
          body: { symbol: SYMBOL, leverage: state.leverage, maxNotionalValue: '1000000' },
        };
      case 'GET /fapi/v3/balance':
        return { status: 200, body: [{ asset: 'USDT', availableBalance: state.available }] };
      case 'GET /fapi/v3/positionRisk':
        return {
          status: 200,
          body:
            state.position === 0
              ? []
              : [{ symbol: SYMBOL, positionSide: 'BOTH', positionAmt: qty(state.position) }],
        };
      case 'GET /fapi/v1/openOrders':
        return { status: 200, body: [...state.orders.values()].filter(live) };
      case 'GET /fapi/v1/openAlgoOrders':
        return {
          status: 200,
          body: [...state.algos.values()].filter((a) => a['algoStatus'] === 'NEW'),
        };
      case 'POST /fapi/v1/order': {
        const id = String(p['newClientOrderId']);
        const existing = state.orders.get(id);
        if (existing && live(existing))
          return { status: 400, body: { code: -4116, msg: 'clientOrderId is duplicated' } };
        const requested = Number(p['quantity']);
        let filled: number;
        let status: string;
        if (p['type'] === 'MARKET') {
          filled = p['reduceOnly'] === 'true' ? Math.min(requested, state.position) : requested;
          state.position = Number(qty(state.position - filled));
          status = 'FILLED';
          fillIncome('SELL', filled, Number(state.mark));
        } else {
          filled = Number(qty(requested * state.fillRatio));
          state.position = Number(qty(state.position + filled));
          status = filled === requested ? 'FILLED' : 'EXPIRED';
          if (filled > 0) {
            state.entryPrice = Number(p['price']);
            fillIncome('BUY', filled, Number(p['price']));
          }
        }
        const order = {
          orderId: nextId++,
          clientOrderId: id,
          status,
          executedQty: qty(filled),
          avgPrice: filled > 0 ? (p['price'] ?? state.mark) : '0.00',
          origQty: p['quantity'],
          type: p['type'],
          side: p['side'],
          reduceOnly: p['reduceOnly'] === 'true',
        };
        state.orders.set(id, order);
        return { status: 200, body: order };
      }
      case 'GET /fapi/v1/order': {
        const order = state.orders.get(String(p['origClientOrderId']));
        return order ? { status: 200, body: order } : absent();
      }
      case 'DELETE /fapi/v1/order': {
        const order = state.orders.get(String(p['origClientOrderId']));
        if (!order || !live(order))
          return { status: 400, body: { code: -2011, msg: 'Unknown order sent.' } };
        order['status'] = 'CANCELED';
        return { status: 200, body: order };
      }
      case 'POST /fapi/v1/algoOrder': {
        const id = String(p['clientAlgoId']);
        if (state.algos.get(id)?.['algoStatus'] === 'NEW') {
          return { status: 400, body: { code: -4116, msg: 'clientOrderId is duplicated' } };
        }
        const algo = { algoId: nextId++, clientAlgoId: id, algoStatus: 'NEW', ...p };
        state.algos.set(id, algo);
        return { status: 200, body: algo };
      }
      case 'GET /fapi/v1/algoOrder': {
        const algo = state.algos.get(String(p['clientAlgoId']));
        return algo ? { status: 200, body: algo } : absent();
      }
      case 'DELETE /fapi/v1/algoOpenOrders':
        for (const algo of state.algos.values())
          if (algo['algoStatus'] === 'NEW') algo['algoStatus'] = 'CANCELED';
        return {
          status: 200,
          body: { code: 200, msg: 'The operation of cancel all open order is done.' },
        };
      case 'DELETE /fapi/v1/allOpenOrders':
        for (const order of state.orders.values()) if (live(order)) order['status'] = 'CANCELED';
        return {
          status: 200,
          body: { code: 200, msg: 'The operation of cancel all open order is done.' },
        };
      case 'GET /sapi/v1/account/apiRestrictions':
        return { status: 200, body: state.permissions };
      case 'GET /fapi/v1/commissionRate':
        return {
          status: 200,
          body: {
            symbol: SYMBOL,
            makerCommissionRate: '0.0002',
            takerCommissionRate: state.takerRate,
          },
        };
      case 'GET /fapi/v1/income': {
        const from = Number(p['startTime']);
        const to = Number(p['endTime']);
        return {
          status: 200,
          body: state.income.filter((r) => Number(r['time']) >= from && Number(r['time']) <= to),
        };
      }
      default:
        throw new Error(`unexpected Binance route ${route}`);
    }
  }

  async function binanceFetch(url: URL, init?: RequestInit): Promise<Response> {
    const route = `${init?.method ?? 'GET'} ${url.pathname}`;
    const params = Object.fromEntries(url.searchParams);
    if ('signature' in params) {
      const headers = new Headers(init?.headers);
      const unsigned = url.search.slice(1).replace(/&signature=[0-9a-f]+$/, '');
      if (
        headers.get('X-MBX-APIKEY') !== API_KEY ||
        params['signature'] !== (await hmacSha256Hex(API_SECRET, unsigned))
      ) {
        return respond(401, { code: -1022, msg: 'Signature for this request is not valid.' });
      }
    }
    calls.push({ route, params });
    const next = script.get(route)?.shift();
    if (next === 'timeout') return timeout();
    if (next === 'apply-then-timeout') {
      handle(route, params);
      return timeout();
    }
    const { status, body } = next ?? handle(route, params);
    return respond(status, body);
  }

  return {
    state,
    calls,
    /** Queue scripted answers for one route, e.g. 'POST /fapi/v1/order'. */
    script(route: string, ...answers: Scripted[]) {
      script.set(route, [...(script.get(route) ?? []), ...answers]);
    },
    count: (route: string) => calls.filter((c) => c.route === route).length,
    /** The stop fired at Binance at its trigger: the long is closed and the stop is finished. */
    triggerStop(price: number) {
      fillIncome('SELL', state.position, price);
      state.position = 0;
      for (const algo of state.algos.values()) {
        if (algo['type'] === 'STOP_MARKET' && algo['algoStatus'] === 'NEW')
          algo['algoStatus'] = 'FINISHED';
      }
    },
    binanceFetch,
  };
}

export function telegram() {
  const calls: { method: string; body: Row; messageId?: number }[] = [];
  let nextMessage = 500;
  let webhookUrl = '';
  return {
    calls,
    sent: () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body['text'])),
    answers: () =>
      calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => String(c.body['text'])),
    edits: () =>
      calls.filter((c) => c.method === 'editMessageText').map((c) => String(c.body['text'])),
    async telegramFetch(url: URL, init?: RequestInit): Promise<Response> {
      if (!url.pathname.startsWith(`/bot${BOT_TOKEN}/`)) return respond(401, { ok: false });
      const method = url.pathname.split('/').pop() as string;
      const body = JSON.parse(String(init?.body)) as Row;
      if (method === 'setWebhook') webhookUrl = String(body['url']);
      if (method !== 'sendMessage') {
        calls.push({ method, body });
        const results: Record<string, unknown> = {
          getMe: { id: 1, is_bot: true, username: 'PopupFuturesBot' },
          getWebhookInfo: { url: webhookUrl, pending_update_count: 0 },
        };
        return respond(200, { ok: true, result: results[method] ?? true });
      }
      const messageId = nextMessage++;
      calls.push({ method, body, messageId });
      return respond(200, { ok: true, result: { message_id: messageId } });
    },
  };
}

// ---------------------------------------------------------------- PostgREST stand-in

const FINAL = ['refused', 'not_filled', 'closed', 'abandoned'];
/** The migration's column grants to service_role and its NOT NULL columns without defaults. */
const INSERTABLE: Record<string, string[]> = {
  futures_proposals: [
    'id',
    'expires_at',
    'environment',
    'symbol',
    'plan',
    'plan_sha256',
    'telegram_chat_id',
  ],
  futures_executions: ['proposal_id', 'state', 'entry_client_order_id', 'lease_until'],
  futures_events: ['proposal_id', 'kind', 'detail'],
  futures_telegram_tests: ['id', 'expires_at', 'telegram_chat_id'],
};
const UPDATABLE: Record<string, string[]> = {
  futures_proposals: ['telegram_message_id', 'status', 'decided_by'],
  futures_executions: [
    'state',
    'entry_submitted_at',
    'filled_qty',
    'avg_price',
    'protection',
    'close_attempts',
    'detail',
    'alerted',
    'lease_until',
    'realized_pnl',
  ],
  futures_events: [],
  futures_telegram_tests: ['telegram_message_id', 'status', 'decided_by'],
};
const REQUIRED_ON_INSERT: Record<string, string[]> = {
  futures_proposals: [
    'id',
    'expires_at',
    'environment',
    'symbol',
    'plan',
    'plan_sha256',
    'telegram_chat_id',
  ],
  futures_executions: ['proposal_id', 'state', 'entry_client_order_id'],
  futures_events: ['kind'],
  futures_telegram_tests: ['id', 'expires_at', 'telegram_chat_id'],
};
type Result = { data: unknown; error: { code: string; message: string } | null };
const failure = (code: string, message: string): Result => ({
  data: null,
  error: { code, message },
});

export function fakeSupabase(clock: Clock) {
  const tables: Record<string, string[]> = {
    futures_proposals: [],
    futures_executions: [],
    futures_events: [],
    futures_telegram_tests: [],
  };
  const rows = (table: string) =>
    (tables[table] as string[]).map((text) => JSON.parse(text) as Row);
  const save = (table: string, list: Row[]) => {
    tables[table] = list.map((row) => JSON.stringify(row));
  };
  const nowIso = () => new Date(clock.now()).toISOString();

  function insert(table: string, input: Row): Result {
    const list = rows(table);
    const row = JSON.parse(JSON.stringify(input)) as Row;
    const denied = Object.keys(row).filter((column) => !INSERTABLE[table]?.includes(column));
    if (denied.length > 0) return failure('42501', `permission denied for ${denied.join(', ')}`);
    const missing = (REQUIRED_ON_INSERT[table] ?? []).filter((column) => row[column] == null);
    if (missing.length > 0) return failure('23502', `null value in ${missing.join(', ')}`);
    if (table === 'futures_proposals' || table === 'futures_telegram_tests') {
      if (list.some((r) => r['id'] === row['id'] || r['status'] === 'pending'))
        return failure('23505', 'duplicate');
      Object.assign(row, {
        status: 'pending',
        telegram_message_id: null,
        decided_at: null,
        decided_by: null,
        created_at: nowIso(),
      });
    } else if (table === 'futures_executions') {
      if (row['state'] !== 'claimed') return failure('42501', 'futures_execution_starts_claimed');
      const proposal = rows('futures_proposals').find((p) => p['id'] === row['proposal_id']);
      if (proposal?.['status'] !== 'approved')
        return failure('42501', 'futures_execution_not_approved');
      if (
        list.some(
          (r) => r['proposal_id'] === row['proposal_id'] || !FINAL.includes(String(r['state'])),
        )
      ) {
        return failure('23505', 'duplicate');
      }
      Object.assign(row, {
        entry_submitted_at: null,
        filled_qty: null,
        avg_price: null,
        protection: {},
        close_attempts: 0,
        detail: null,
        alerted: null,
        realized_pnl: null,
      });
    }
    save(table, [...list, row]);
    return { data: null, error: null };
  }

  function update(table: string, patch: Row, match: (row: Row) => boolean): Result {
    const denied = Object.keys(patch).filter((column) => !UPDATABLE[table]?.includes(column));
    if (denied.length > 0) return failure('42501', `permission denied for ${denied.join(', ')}`);
    const list = rows(table);
    const changed: Row[] = [];
    for (const row of list.filter(match)) {
      if (table === 'futures_proposals' || table === 'futures_telegram_tests') {
        const name = table === 'futures_proposals' ? 'futures_proposal' : 'futures_telegram_test';
        if ('telegram_message_id' in patch && row['telegram_message_id'] !== null) {
          return failure('42501', `${name}_immutable`);
        }
        if ('status' in patch && patch['status'] !== row['status']) {
          if (row['status'] !== 'pending') return failure('42501', `${name}_decided`);
          // Proposals refuse a late approval; TESTs refuse any late decision.
          const late = clock.now() >= Date.parse(String(row['expires_at']));
          const decision =
            patch['status'] === 'approved' ||
            (table === 'futures_telegram_tests' && patch['status'] === 'rejected');
          if (late && decision) return failure('P0001', `${name}_expired`);
          row['decided_at'] = nowIso();
        }
      }
      if (
        table === 'futures_executions' &&
        FINAL.includes(String(row['state'])) &&
        'state' in patch &&
        patch['state'] !== row['state']
      ) {
        return failure('42501', 'futures_execution_final');
      }
      if ('realized_pnl' in patch && row['realized_pnl'] != null) {
        return failure('42501', 'futures_execution_result_recorded');
      }
      Object.assign(row, JSON.parse(JSON.stringify(patch)));
      if (row['realized_pnl'] != null && (row['state'] !== 'closed' || row['filled_qty'] == null)) {
        return failure('23514', 'futures_executions_check');
      }
      changed.push(row);
    }
    save(table, list);
    return { data: changed, error: null };
  }

  class Query implements PromiseLike<Result> {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Row = {};
    private filters: ((row: Row) => boolean)[] = [];
    private single = false;
    constructor(private readonly table: string) {}
    select() {
      return this;
    }
    insert(row: Row) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    update(patch: Row) {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    is(column: string, value: null) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    lte(column: string, value: string) {
      this.filters.push(
        (row) => row[column] !== null && Date.parse(String(row[column])) <= Date.parse(value),
      );
      return this;
    }
    not(column: string, operator: 'in' | 'is', value: string | null) {
      if (operator === 'is') {
        this.filters.push((row) => row[column] !== value);
        return this;
      }
      const values = String(value).slice(1, -1).split(',');
      this.filters.push((row) => !values.includes(String(row[column])));
      return this;
    }
    or(expression: string) {
      // Only the lease form supabaseStore sends: `<col>.is.null,<col>.lt.<iso>`.
      const match = /^(\w+)\.is\.null,\1\.lt\.(.+)$/.exec(expression);
      if (!match) throw new Error(`unsupported or(): ${expression}`);
      const [, column, iso] = match as unknown as [string, string, string];
      this.filters.push(
        (row) => row[column] === null || Date.parse(String(row[column])) < Date.parse(iso),
      );
      return this;
    }
    maybeSingle() {
      this.single = true;
      return this;
    }
    private run(): Result {
      const match = (row: Row) => this.filters.every((f) => f(row));
      if (this.op === 'insert') return insert(this.table, this.payload);
      if (this.op === 'update') return update(this.table, this.payload, match);
      const found = rows(this.table).filter(match);
      return { data: this.single ? (found[0] ?? null) : found, error: null };
    }
    then<A = Result, B = never>(
      onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
      onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    }
  }

  return {
    rows,
    client: { from: (table: string) => new Query(table) } as unknown as SupabaseClient,
  };
}
