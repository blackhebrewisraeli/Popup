// The Futures Demo state machine (docs/FUTURES_DEMO_EXECUTION.md). Storage, Binance and Telegram
// are injected, so vitest drives it against stubs. Every Binance write uses a client order ID
// derived from the proposal, and an ambiguous answer is reconciled by querying that ID before any
// retry.
//
// Execution states:
//   claimed        approval accepted, checks running, nothing sent (state written before the entry)
//   refused        a check failed before the entry; nothing was sent                       [final]
//   entry_unknown  entry sent, outcome not yet confirmed
//   not_filled     entry confirmed absent, rejected or expired with no fill                [final]
//   protecting     fill confirmed, exits being placed for the filled quantity
//   protected      stop confirmed active at Binance; watched until the position is flat
//   unresolved     protection or cleanup failed: closing and verifying; blocks new entries
//   closed         position verified flat and no exit order left open                       [final]
//   abandoned      found claimed after a restart: no entry had been sent                    [final]
// Any state that is not final blocks new proposals and entries (also a database constraint).

import { type DemoClient, describe, isAbsent, type Outcome, RECV_WINDOW_MS } from './binance.ts';
import {
  callbackData,
  type Candidate,
  dec,
  ENVIRONMENT,
  fmt,
  LEVERAGE,
  parseCallbackData,
  parseSymbolRules,
  type Plan,
  planLong,
  planSha256,
  priceDrift,
  proposalText,
  type RiskLimits,
  targetQuantities,
} from './plan.ts';

export const FINAL_STATES = ['refused', 'not_filled', 'closed', 'abandoned'] as const;
export type ExecutionState =
  | 'claimed'
  | 'entry_unknown'
  | 'protecting'
  | 'protected'
  | 'unresolved'
  | (typeof FINAL_STATES)[number];

export interface ProposalRow {
  id: string;
  expires_at: string;
  symbol: string;
  synthetic: boolean;
  plan: Plan;
  plan_sha256: string;
  telegram_chat_id: number;
  telegram_message_id: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
}

export interface AlgoStatus {
  clientAlgoId: string;
  status: string;
  detail?: string;
}

export interface ExecutionRow {
  proposal_id: string;
  state: ExecutionState;
  entry_client_order_id: string;
  entry_submitted_at: string | null;
  filled_qty: string | null;
  avg_price: string | null;
  protection: { stop?: AlgoStatus; targets?: AlgoStatus[] };
  close_attempts: number;
  detail: string | null;
  alerted: string | null;
  lease_until: string | null;
}

export interface Store {
  pendingProposal(): Promise<ProposalRow | null>;
  openExecutions(): Promise<ExecutionRow[]>;
  /** 'conflict' when another proposal is pending (one at a time). */
  insertProposal(
    row: Omit<ProposalRow, 'status' | 'telegram_message_id'> & { environment: typeof ENVIRONMENT },
  ): Promise<'ok' | 'conflict'>;
  setTelegramMessage(id: string, messageId: number): Promise<void>;
  getProposal(id: string): Promise<ProposalRow | null>;
  /** Atomic: only a pending proposal changes; the database clock refuses approval at expiry. */
  decide(
    id: string,
    status: 'approved' | 'rejected',
    by: number,
  ): Promise<'ok' | 'not_pending' | 'expired'>;
  expireDue(nowIso: string): Promise<ProposalRow[]>;
  /** 'blocked' when another execution is not final. */
  insertExecution(
    row: Pick<ExecutionRow, 'proposal_id' | 'state' | 'entry_client_order_id' | 'lease_until'>,
  ): Promise<'ok' | 'blocked'>;
  updateExecution(id: string, patch: Partial<ExecutionRow>): Promise<void>;
  /** Atomic: true when the lease was free or lapsed and is now held until `untilIso`. */
  lease(id: string, nowIso: string, untilIso: string): Promise<boolean>;
  event(proposalId: string | null, kind: string, detail: Record<string, unknown>): Promise<void>;
}

export interface Telegram {
  send(
    chatId: number,
    text: string,
    buttons?: { text: string; data: string }[],
  ): Promise<number | null>;
  edit(chatId: number, messageId: number, text: string): Promise<void>;
  answer(callbackQueryId: string, text: string): Promise<void>;
}

export interface EngineDeps {
  store: Store;
  demo: DemoClient;
  telegram: Telegram;
  ownerChatId: number;
  /** Null when the owner's limits are unset or invalid: no proposal or approval then. */
  risk: { limits: RiskLimits; sha256: string } | { error: string };
  /** FUTURES_DEMO_ENABLED: off stops proposals and approvals, never reconciliation. */
  entriesEnabled: boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomUUID: () => string;
  log: (line: string) => void;
}

/** Candidate detection. Empty until the owner approves a Futures entry rule (see the docs). */
export const ENTRY_RULES: Record<string, (deps: EngineDeps) => Promise<Candidate | null>> = {};

/** Hosted Edge Functions stop at 150 s wall clock; a lapsed lease hands the row to the tick. */
export const LEASE_MS = 150_000;
const RECONCILE_GRACE_MS = 5_000;
const MAX_CLOSE_ATTEMPTS = 10;
const SYNTHETIC_REASON =
  'SYNTHETIC demonstration candidate requested by the owner. No entry rule produced it.';

const iso = (ms: number) => new Date(ms).toISOString();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hex = (id: string) => id.replaceAll('-', '').slice(0, 28);
/** Binance client order IDs: ^[.A-Z:/a-z0-9_-]{1,36}$. */
export const entryOrderId = (id: string) => `pd-${hex(id)}`;
const stopAlgoId = (id: string) => `pd-${hex(id)}-s`;
const targetAlgoId = (id: string, i: number) => `pd-${hex(id)}-t${i + 1}`;
const closeOrderId = (id: string, attempt: number) => `pd-${hex(id)}-x${attempt}`;

async function okBody(
  deps: EngineDeps,
  route: Parameters<DemoClient['call']>[0],
  params?: Record<string, string>,
) {
  const outcome = await deps.demo.call(route, params);
  return outcome.kind === 'ok' ? outcome.body : null;
}

// ---------------------------------------------------------------- proposals

/** Propose one Long for this candidate and send it to the owner, or say why not. */
export async function propose(deps: EngineDeps, candidate: Candidate): Promise<string> {
  if (!deps.entriesEnabled) return 'Futures Demo entries are disabled (FUTURES_DEMO_ENABLED).';
  if ('error' in deps.risk) return `No proposal: ${deps.risk.error}.`;
  if ((await deps.store.openExecutions()).length > 0) {
    return 'No proposal: a Demo execution is still open or unresolved.';
  }
  if (await deps.store.pendingProposal()) return 'No proposal: another proposal is still pending.';
  const symbol = candidate.symbol;
  const [info, book, premium] = await Promise.all([
    okBody(deps, 'exchangeInfo'),
    okBody(deps, 'bookTicker', { symbol }),
    okBody(deps, 'premiumIndex', { symbol }),
  ]);
  const rules = parseSymbolRules(info, symbol);
  if (typeof rules === 'string') return `No proposal: ${rules}.`;
  if (!isRecord(book) || !isRecord(premium)) return 'No proposal: Binance prices are unavailable.';
  const id = deps.randomUUID();
  const plan = planLong({
    candidate,
    limits: deps.risk.limits,
    limitsSha256: deps.risk.sha256,
    rules,
    ask: String(book['askPrice']),
    mark: String(premium['markPrice']),
    expiresAt: iso(deps.now() + deps.risk.limits.proposalTtlSeconds * 1000),
  });
  if (typeof plan === 'string') return `No proposal: ${plan}.`;
  const sha256 = await planSha256(id, plan);
  const stored = await deps.store.insertProposal({
    id,
    environment: ENVIRONMENT,
    expires_at: plan.expiresAt,
    symbol,
    synthetic: plan.synthetic,
    plan,
    plan_sha256: sha256,
    telegram_chat_id: deps.ownerChatId,
  });
  if (stored === 'conflict') return 'No proposal: another proposal is still pending.';
  const messageId = await deps.telegram.send(deps.ownerChatId, proposalText(id, sha256, plan), [
    { text: '✅ Approve', data: callbackData('a', id, sha256) },
    { text: '✖ Reject', data: callbackData('r', id, sha256) },
  ]);
  if (messageId === null) {
    // Without the message there is no button to press; the proposal simply expires.
    await deps.store.event(id, 'telegram_send_failed', {});
    return 'Proposal stored but the Telegram message failed; it will expire unapproved.';
  }
  await deps.store.setTelegramMessage(id, messageId);
  await deps.store.event(id, 'proposed', { sha256, synthetic: plan.synthetic, rule: plan.rule });
  return `Proposed ${id}.`;
}

export const syntheticCandidate = (symbol: string): Candidate => ({
  symbol,
  rule: 'synthetic',
  synthetic: true,
  signalReason: SYNTHETIC_REASON,
});

// ---------------------------------------------------------------- decisions

export interface CallbackQuery {
  id: string;
  fromId: number;
  messageId: number | null;
  data: unknown;
}

/** One Approve or Reject press, already authenticated as the owner in their private chat. */
export async function decide(deps: EngineDeps, query: CallbackQuery): Promise<void> {
  const answer = (text: string) => deps.telegram.answer(query.id, text);
  const parsed = parseCallbackData(query.data);
  const proposal = parsed ? await deps.store.getProposal(parsed.id) : null;
  if (!parsed || !proposal) return answer('Unknown proposal.');
  // Bound to the exact stored terms and to the message that showed them.
  const sha256 = await planSha256(proposal.id, proposal.plan);
  const messageId = proposal.telegram_message_id;
  if (
    sha256 !== proposal.plan_sha256 ||
    !sha256.startsWith(parsed.sha8) ||
    messageId === null ||
    messageId !== query.messageId
  ) {
    await deps.store.event(proposal.id, 'decision_refused', { reason: 'binding' });
    return answer('This button does not match the stored proposal. Nothing was done.');
  }
  if (parsed.action === 'approve' && !deps.entriesEnabled) {
    return answer('Futures Demo entries are disabled. Nothing was done.');
  }
  const status = parsed.action === 'approve' ? 'approved' : 'rejected';
  const result = await deps.store.decide(proposal.id, status, query.fromId);
  if (result !== 'ok') {
    const current = await deps.store.getProposal(proposal.id);
    const why = result === 'expired' ? 'expired' : `already ${current?.status ?? 'handled'}`;
    await deps.store.event(proposal.id, 'decision_refused', { reason: why, pressed: status });
    return answer(`Not ${status}: the proposal is ${why}. Nothing was done.`);
  }
  await deps.store.event(proposal.id, status, { by: query.fromId });
  const header = proposalText(proposal.id, sha256, proposal.plan);
  if (status === 'rejected') {
    await answer('Rejected. No order will be placed.');
    await deps.telegram.edit(
      proposal.telegram_chat_id,
      messageId,
      `${header}\n\nREJECTED — no order placed.`,
    );
    return;
  }
  await answer('Approved. Rechecking, then executing in Binance Demo.');
  await deps.telegram.edit(
    proposal.telegram_chat_id,
    messageId,
    `${header}\n\nAPPROVED — executing in Demo; status follows.`,
  );
  await execute(deps, proposal);
}

// ---------------------------------------------------------------- execution

const report = (deps: EngineDeps, p: ProposalRow, text: string) =>
  deps.telegram.send(p.telegram_chat_id, `Futures DEMO ${p.symbol} · ${p.id.slice(0, 8)}\n${text}`);

async function setState(deps: EngineDeps, ex: ExecutionRow, patch: Partial<ExecutionRow>) {
  Object.assign(ex, patch);
  await deps.store.updateExecution(ex.proposal_id, patch);
  if (patch.state)
    await deps.store.event(ex.proposal_id, `state_${patch.state}`, { detail: ex.detail });
}

/**
 * Everything that must hold right before the entry. Account-wide settings are verified, never
 * changed; the symbol is set to isolated and 5× and then read back. Any value that can't be read
 * refuses the entry.
 */
async function preflight(deps: EngineDeps, p: ProposalRow): Promise<string | null> {
  const { plan, symbol } = p;
  if ('error' in deps.risk) return deps.risk.error;
  if (deps.risk.sha256 !== plan.riskLimitsSha256)
    return 'The owner risk limits changed since the proposal';
  if (deps.now() >= Date.parse(p.expires_at)) return 'The proposal expired';
  if (!deps.risk.limits.symbols.includes(symbol)) return `${symbol} is no longer an allowed symbol`;

  const book = await okBody(deps, 'bookTicker', { symbol });
  if (!isRecord(book)) return 'Could not read the current ask';
  const drift = priceDrift(plan, String(book['askPrice']));
  if (drift) return drift;

  const config = await okBody(deps, 'accountConfig');
  if (!isRecord(config)) return 'Could not verify the account configuration';
  if (config['dualSidePosition'] !== false) return 'The account is not in one-way position mode';
  if (config['multiAssetsMargin'] !== false) return 'The account is in Multi-Assets mode';
  if (config['canTrade'] !== true) return 'The account cannot trade';

  const [positions, orders, algos] = await Promise.all([
    okBody(deps, 'positionRisk', { symbol }),
    okBody(deps, 'openOrders', { symbol }),
    okBody(deps, 'openAlgoOrders', { symbol }),
  ]);
  const amount = positionAmount(positions, symbol);
  if (amount === null) return 'Could not verify the current position';
  if (amount !== 0n) return `${symbol} already has a position`;
  if (!Array.isArray(orders) || !Array.isArray(algos)) return 'Could not verify open orders';
  if (orders.length > 0 || algos.length > 0) return `${symbol} already has open orders`;

  let symbolConfig = await readSymbolConfig(deps, symbol);
  if (!symbolConfig) return 'Could not read the symbol configuration';
  if (symbolConfig.marginType !== 'ISOLATED') {
    const set = await deps.demo.call('setMarginType', { symbol, marginType: 'ISOLATED' });
    if (set.kind === 'rejected' && set.code !== -4046)
      return `Isolated margin not set: ${describe(set)}`;
  }
  if (symbolConfig.leverage !== LEVERAGE) {
    const set = await deps.demo.call('setLeverage', { symbol, leverage: String(LEVERAGE) });
    if (set.kind === 'rejected') return `Leverage not set: ${describe(set)}`;
  }
  symbolConfig = await readSymbolConfig(deps, symbol);
  if (
    !symbolConfig ||
    symbolConfig.marginType !== 'ISOLATED' ||
    symbolConfig.leverage !== LEVERAGE
  ) {
    return 'Could not verify isolated margin at 5×';
  }
  if (symbolConfig.isAutoAddMargin !== false) return 'Auto-add margin is on for this symbol';
  const cap = dec(symbolConfig.maxNotionalValue);
  if (!cap || cap < (dec(plan.notional) as bigint))
    return 'The notional exceeds the 5× bracket cap';

  const balances = await okBody(deps, 'balance');
  const usdt = Array.isArray(balances)
    ? balances.find((b: unknown) => isRecord(b) && b['asset'] === 'USDT')
    : undefined;
  const available = isRecord(usdt) ? dec(usdt['availableBalance']) : null;
  if (available === null) return 'Could not read the available USDT balance';
  if (available < (dec(plan.initialMargin) as bigint))
    return 'Available USDT is below the initial margin';
  return null;
}

async function readSymbolConfig(deps: EngineDeps, symbol: string) {
  const body = await okBody(deps, 'symbolConfig', { symbol });
  const row = Array.isArray(body)
    ? body.find((r: unknown) => isRecord(r) && r['symbol'] === symbol)
    : null;
  if (!isRecord(row)) return null;
  return {
    marginType: String(row['marginType']).toUpperCase(),
    leverage: Number(row['leverage']),
    isAutoAddMargin: row['isAutoAddMargin'],
    maxNotionalValue: row['maxNotionalValue'],
  };
}

/** One-way mode: the symbol's BOTH position amount; an empty list is flat. Null when unreadable. */
function positionAmount(body: unknown, symbol: string): bigint | null {
  if (!Array.isArray(body)) return null;
  let total = 0n;
  for (const row of body) {
    if (!isRecord(row) || row['symbol'] !== symbol) continue;
    const text = String(row['positionAmt']);
    const value = dec(text.replace(/^-/, ''));
    if (value === null) return null;
    total += text.startsWith('-') ? -value : value;
  }
  return total;
}

async function readPosition(deps: EngineDeps, symbol: string) {
  return positionAmount(await okBody(deps, 'positionRisk', { symbol }), symbol);
}

/** Claim, recheck, write the entry state, send one limit-IOC buy, then drive it to a stable state. */
async function execute(deps: EngineDeps, p: ProposalRow): Promise<void> {
  const ex: ExecutionRow = {
    proposal_id: p.id,
    state: 'claimed',
    entry_client_order_id: entryOrderId(p.id),
    entry_submitted_at: null,
    filled_qty: null,
    avg_price: null,
    protection: {},
    close_attempts: 0,
    detail: null,
    alerted: null,
    lease_until: iso(deps.now() + LEASE_MS),
  };
  const { proposal_id, state, entry_client_order_id, lease_until } = ex;
  const claim = { proposal_id, state, entry_client_order_id, lease_until };
  if ((await deps.store.insertExecution(claim)) === 'blocked') {
    await report(deps, p, 'NOT EXECUTED: another Demo execution is still open or unresolved.');
    return;
  }
  try {
    const refusal = await preflight(deps, p);
    if (refusal) {
      await setState(deps, ex, { state: 'refused', detail: refusal });
      await report(deps, p, `NOT EXECUTED: ${refusal}. No order was sent.`);
      return;
    }
    await setState(deps, ex, { state: 'entry_unknown', entry_submitted_at: iso(deps.now()) });
    const sent = await deps.demo.call('newOrder', {
      symbol: p.symbol,
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: p.plan.quantity,
      price: p.plan.entryLimit,
      newClientOrderId: ex.entry_client_order_id,
      newOrderRespType: 'RESULT',
    });
    await deps.store.event(p.id, 'entry_sent', { outcome: describe(sent) });
    if (sent.kind === 'rejected' && !isDuplicate(sent)) {
      await setState(deps, ex, {
        state: 'not_filled',
        detail: `Entry rejected: ${describe(sent)}`,
      });
      await report(deps, p, `ENTRY REJECTED by Binance Demo: ${describe(sent)}. No position.`);
      return;
    }
    if (sent.kind === 'ok') await applyEntry(deps, p, ex, sent.body);
    // Unknown: query the client order ID a few times before leaving it to the scheduled reconcile.
    for (let attempt = 0; ex.state === 'entry_unknown' && attempt < 4; attempt++) {
      await deps.sleep(1500 * (attempt + 1));
      await reconcileEntry(deps, p, ex);
    }
    if (ex.state === 'entry_unknown') {
      await alertOnce(
        deps,
        p,
        ex,
        'Entry status UNKNOWN at Binance Demo. Reconciling every minute; new entries blocked.',
      );
      return;
    }
    await drive(deps, p, ex);
  } finally {
    await deps.store.updateExecution(p.id, { lease_until: null });
  }
}

const isDuplicate = (outcome: Outcome) => outcome.kind === 'rejected' && outcome.code === -4116;

/** Advance until the state stops changing (bounded). Used inline and by the scheduled tick. */
async function drive(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow): Promise<void> {
  for (let step = 0; step < 4; step++) {
    const before = ex.state;
    if (before === 'claimed') {
      // Seen only after a restart: the entry state is written before the order is sent.
      await setState(deps, ex, {
        state: 'abandoned',
        detail: 'Found claimed after a restart; no entry was sent',
      });
      await report(deps, p, 'ABANDONED after a restart before any order was sent. No position.');
    } else if (before === 'entry_unknown') await reconcileEntry(deps, p, ex);
    else if (before === 'protecting') await protect(deps, p, ex);
    else if (before === 'protected') await watch(deps, p, ex);
    else if (before === 'unresolved') await flatten(deps, p, ex);
    if (ex.state === before) return;
  }
}

interface OrderView {
  status: string;
  executedQty: string;
  avgPrice: string;
  orderId: string;
}

function parseOrder(body: unknown): OrderView | null {
  if (!isRecord(body) || typeof body['status'] !== 'string') return null;
  const executedQty = String(body['executedQty']);
  if (dec(executedQty) === null) return null;
  return {
    status: body['status'],
    executedQty,
    avgPrice: String(body['avgPrice'] ?? '0'),
    orderId: String(body['orderId']),
  };
}

const LIVE = new Set(['NEW', 'PARTIALLY_FILLED']);

async function queryEntry(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow) {
  return deps.demo.call('queryOrder', {
    symbol: p.symbol,
    origClientOrderId: ex.entry_client_order_id,
  });
}

async function reconcileEntry(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow): Promise<void> {
  const found = await queryEntry(deps, p, ex);
  if (isAbsent(found)) {
    const sentAt = Date.parse(ex.entry_submitted_at ?? '') || 0;
    // Past recvWindow Binance can no longer accept that request, so absent means never placed.
    if (deps.now() >= sentAt + RECV_WINDOW_MS + RECONCILE_GRACE_MS) {
      await setState(deps, ex, {
        state: 'not_filled',
        detail: 'Entry order not found at Binance; it was never placed',
      });
      await report(deps, p, 'ENTRY NOT PLACED: Binance Demo has no such order. No position.');
    }
    return;
  }
  if (found.kind === 'ok') await applyEntry(deps, p, ex, found.body);
}

async function applyEntry(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow, body: unknown) {
  let order = parseOrder(body);
  if (!order) return;
  if (LIVE.has(order.status)) {
    // IOC should never rest; if it does, cancel the remainder and read the final fill.
    await deps.demo.call('cancelOrder', {
      symbol: p.symbol,
      origClientOrderId: ex.entry_client_order_id,
    });
    const again = await queryEntry(deps, p, ex);
    order = again.kind === 'ok' ? parseOrder(again.body) : null;
    if (!order || LIVE.has(order.status)) {
      await emergency(deps, p, ex, 'The entry remainder could not be confirmed cancelled');
      return;
    }
  }
  if (dec(order.executedQty) === 0n) {
    await setState(deps, ex, { state: 'not_filled', detail: `Entry ${order.status} with no fill` });
    await report(
      deps,
      p,
      `ENTRY ${order.status}, nothing filled (order ${order.orderId}). No position.`,
    );
    return;
  }
  await setState(deps, ex, {
    state: 'protecting',
    filled_qty: order.executedQty,
    avg_price: order.avgPrice,
  });
  await report(
    deps,
    p,
    `ENTRY ${order.status}: ${order.executedQty} of ${p.plan.quantity} at avg ${order.avgPrice} (order ${order.orderId}). Placing protection.`,
  );
}

type AlgoSpec = Record<string, string> & { clientAlgoId: string };

/**
 * Make sure this algo order is active at Binance. The ID is queried first, so a retry after an
 * unknown answer never doubles an order. A fired stop (TRIGGERED/FINISHED) is not resubmitted.
 */
async function ensureAlgo(deps: EngineDeps, spec: AlgoSpec): Promise<AlgoStatus> {
  const { clientAlgoId } = spec;
  let last = 'not attempted';
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await deps.demo.call('queryAlgoOrder', { clientAlgoId });
    if (found.kind === 'ok' && isRecord(found.body)) {
      const status = String(found.body['algoStatus']);
      if (status === 'NEW' || status === 'TRIGGERED' || status === 'FINISHED')
        return { clientAlgoId, status };
    } else if (!isAbsent(found)) {
      last = `query ${describe(found)}`;
      await deps.sleep(1000 * (attempt + 1));
      continue;
    }
    const sent = await deps.demo.call('newAlgoOrder', { algoType: 'CONDITIONAL', ...spec });
    last = describe(sent);
    if (sent.kind === 'rejected' && !isDuplicate(sent))
      return { clientAlgoId, status: 'FAILED', detail: last };
    if (sent.kind === 'ok' && isRecord(sent.body) && sent.body['algoStatus'] === 'NEW') {
      return { clientAlgoId, status: 'NEW' };
    }
    await deps.sleep(1000 * (attempt + 1));
  }
  return { clientAlgoId, status: 'UNVERIFIED', detail: last };
}

const stopSpec = (p: ProposalRow): AlgoSpec => ({
  symbol: p.symbol,
  side: 'SELL',
  type: 'STOP_MARKET',
  triggerPrice: p.plan.stopTrigger,
  workingType: 'MARK_PRICE',
  // Close-All: closes whatever long exists and can't open a short.
  closePosition: 'true',
  clientAlgoId: stopAlgoId(p.id),
});

async function protect(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow): Promise<void> {
  const stop = await ensureAlgo(deps, stopSpec(p));
  if (stop.status !== 'NEW' && stop.status !== 'TRIGGERED' && stop.status !== 'FINISHED') {
    ex.protection = { stop };
    await emergency(deps, p, ex, `The stop could not be placed: ${stop.detail ?? stop.status}`);
    return;
  }
  const targets: AlgoStatus[] = [];
  for (const [i, target] of targetQuantities(ex.filled_qty as string, p.plan).entries()) {
    targets.push(
      await ensureAlgo(deps, {
        symbol: p.symbol,
        side: 'SELL',
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: target.price,
        quantity: target.quantity,
        workingType: 'MARK_PRICE',
        // Reduce-only: can only shrink the long, never reverse it.
        reduceOnly: 'true',
        clientAlgoId: targetAlgoId(p.id, i),
      }),
    );
  }
  await setState(deps, ex, { state: 'protected', protection: { stop, targets } });
  const lines = [
    `PROTECTED ${ex.filled_qty} ${p.symbol}:`,
    `Stop ${p.plan.stopTrigger} (close-all, mark price): ${stop.status}`,
    ...targets.map((t, i) => `Target ${i + 1}: ${t.status}${t.detail ? ` (${t.detail})` : ''}`),
  ];
  if (targets.length === 0)
    lines.push('No take-profit: the filled quantity is below the minimum per target.');
  await report(deps, p, lines.join('\n'));
}

/** While the position is open the stop must stay active; once flat, no exit order may remain. */
async function watch(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow): Promise<void> {
  const amount = await readPosition(deps, p.symbol);
  if (amount === null) return;
  if (amount < 0n) return emergency(deps, p, ex, 'An unexpected short position exists');
  if (amount === 0n) {
    if (await cancelSiblings(deps, p)) {
      await setState(deps, ex, {
        state: 'closed',
        detail: 'Position flat; no exit order left open',
      });
      await report(
        deps,
        p,
        'CLOSED: position is flat and every remaining exit order was cancelled and verified gone.',
      );
    } else {
      await emergency(
        deps,
        p,
        ex,
        'The position is flat but exit orders could not be verified cancelled',
      );
    }
    return;
  }
  const stop = await ensureAlgo(deps, stopSpec(p));
  if (stop.status === 'FAILED' || stop.status === 'UNVERIFIED') {
    return emergency(
      deps,
      p,
      ex,
      `The stop is no longer active and could not be replaced: ${stop.detail ?? stop.status}`,
    );
  }
  // TRIGGERED is the close in flight; FINISHED with a long still open leaves it unprotected.
  if (stop.status === 'FINISHED') {
    return emergency(deps, p, ex, 'The stop finished but a long position remains');
  }
}

/** Cancel every open order and algo order on the symbol, then confirm none is left. */
async function cancelSiblings(deps: EngineDeps, p: ProposalRow): Promise<boolean> {
  const symbol = p.symbol;
  await deps.demo.call('cancelAllAlgoOpenOrders', { symbol });
  await deps.demo.call('cancelAllOpenOrders', { symbol });
  const [orders, algos] = await Promise.all([
    okBody(deps, 'openOrders', { symbol }),
    okBody(deps, 'openAlgoOrders', { symbol }),
  ]);
  return Array.isArray(orders) && Array.isArray(algos) && orders.length === 0 && algos.length === 0;
}

async function alertOnce(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow, text: string) {
  const key = text.slice(0, 200);
  if (ex.alerted === key) return;
  await report(deps, p, text);
  await setState(deps, ex, { alerted: key });
}

async function emergency(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow, reason: string) {
  await setState(deps, ex, { state: 'unresolved', detail: reason, protection: ex.protection });
  await alertOnce(
    deps,
    p,
    ex,
    `PROTECTION FAILED: ${reason}. Cancelling the entry remainder and closing with a reduce-only market order. New entries are blocked until this resolves.`,
  );
  await flatten(deps, p, ex);
}

/** Exposure-reducing close: cancel, sell the long reduce-only, confirm flat and no orders left. */
async function flatten(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow): Promise<void> {
  await deps.demo.call('cancelOrder', {
    symbol: p.symbol,
    origClientOrderId: ex.entry_client_order_id,
  });
  let amount = await readPosition(deps, p.symbol);
  if (amount !== null && amount > 0n && ex.close_attempts < MAX_CLOSE_ATTEMPTS) {
    const attempt = ex.close_attempts + 1;
    await setState(deps, ex, { close_attempts: attempt });
    const sent = await deps.demo.call('newOrder', {
      symbol: p.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: fmt(amount),
      reduceOnly: 'true',
      newClientOrderId: closeOrderId(p.id, attempt),
      newOrderRespType: 'RESULT',
    });
    await deps.store.event(p.id, 'close_sent', { attempt, outcome: describe(sent) });
    await deps.sleep(1000);
    amount = await readPosition(deps, p.symbol);
  }
  if (amount === 0n && (await cancelSiblings(deps, p))) {
    await setState(deps, ex, {
      state: 'closed',
      detail: `Closed after: ${ex.detail ?? 'unresolved state'}`,
    });
    await report(
      deps,
      p,
      'RESOLVED: position verified flat and no order left open. New entries are unblocked.',
    );
    return;
  }
  const where = amount === null ? 'unreadable' : fmt(amount);
  await alertOnce(
    deps,
    p,
    ex,
    `UNRESOLVED: position ${where} ${p.symbol} or orders still open after the close attempt. Retrying every minute; new entries blocked. Check Binance Demo.`,
  );
}

// ---------------------------------------------------------------- scheduled tick

export interface TickSummary {
  expired: number;
  reconciled: { id: string; from: string; to: string }[];
  skipped: string[];
  rule: string;
}

/** Expire stale proposals, reconcile every open execution (also after a restart), run the rule. */
export async function tick(deps: EngineDeps, rule: string | undefined): Promise<TickSummary> {
  const summary: TickSummary = { expired: 0, reconciled: [], skipped: [], rule: 'none configured' };
  for (const p of await deps.store.expireDue(iso(deps.now()))) {
    summary.expired++;
    await deps.store.event(p.id, 'expired', {});
    if (p.telegram_message_id !== null) {
      await deps.telegram.edit(
        p.telegram_chat_id,
        p.telegram_message_id,
        `${proposalText(p.id, p.plan_sha256, p.plan)}\n\nEXPIRED — no order placed.`,
      );
    }
  }
  for (const ex of await deps.store.openExecutions()) {
    const p = await deps.store.getProposal(ex.proposal_id);
    if (
      !p ||
      !(await deps.store.lease(ex.proposal_id, iso(deps.now()), iso(deps.now() + LEASE_MS)))
    ) {
      summary.skipped.push(ex.proposal_id);
      continue;
    }
    const from = ex.state;
    try {
      await drive(deps, p, ex);
    } finally {
      await deps.store.updateExecution(ex.proposal_id, { lease_until: null });
    }
    summary.reconciled.push({ id: ex.proposal_id, from, to: ex.state });
  }
  if (rule) {
    const detect = ENTRY_RULES[rule];
    if (!detect) summary.rule = `${rule} is not an approved entry rule; nothing detected`;
    else {
      const candidate = await detect(deps);
      summary.rule = candidate ? await propose(deps, candidate) : `${rule}: no candidate`;
    }
  }
  return summary;
}
