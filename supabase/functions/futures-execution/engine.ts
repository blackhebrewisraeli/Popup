// The live Binance USDⓈ-M Futures state machine (docs/FUTURES_EXECUTION.md). Storage, Binance and Telegram
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
// Nothing proposes or executes unless FUTURES_LIVE_ENABLED is exactly "true", the owner's risk
// limits are set, and FUTURES_ENTRY_RULE names a rule in ENTRY_RULES. Reconciliation always runs.

import { type FuturesClient, describe, isAbsent, type Outcome, RECV_WINDOW_MS } from './binance.ts';
import {
  callbackData,
  type Candidate,
  dec,
  ENVIRONMENT,
  fmt,
  LEVERAGE,
  riskDrift,
  signedDec,
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
  /** Net USDT from Binance income (realized PnL, commission, funding) once closed; else null. */
  realized_pnl: string | null;
}

export interface Store {
  pendingProposal(): Promise<ProposalRow | null>;
  openExecutions(): Promise<ExecutionRow[]>;
  /** Closed executions that had a fill: the experiment's realized results. */
  closedExecutions(): Promise<ExecutionRow[]>;
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
  binance: FuturesClient;
  telegram: Telegram;
  ownerChatId: number;
  /** Null when the owner's limits are unset or invalid: no proposal or approval then. */
  risk: { limits: RiskLimits; sha256: string } | { error: string };
  /** FUTURES_LIVE_ENABLED: off (the default) stops proposals and approvals, never reconciliation. */
  liveEnabled: boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  randomUUID: () => string;
  log: (line: string) => void;
}

/**
 * Owner-approved candidate detection, by rule id. Empty: no Futures entry rule has been approved,
 * so nothing is proposed. A rule lands here only through a reviewed PR, and runs only when the
 * owner also names it in FUTURES_ENTRY_RULE. Synthetic candidates exist only in local tests.
 */
export const ENTRY_RULES: Record<string, (deps: EngineDeps) => Promise<Candidate | null>> = {};

/** Hosted Edge Functions stop at 150 s wall clock; a lapsed lease hands the row to the tick. */
export const LEASE_MS = 150_000;
const RECONCILE_GRACE_MS = 5_000;
const MAX_CLOSE_ATTEMPTS = 10;
const INCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hex = (id: string) => id.replaceAll('-', '').slice(0, 28);
/** Binance client order IDs: ^[.A-Z:/a-z0-9_-]{1,36}$. */
export const entryOrderId = (id: string) => `pf-${hex(id)}`;
const stopAlgoId = (id: string) => `pf-${hex(id)}-s`;
const targetAlgoId = (id: string, i: number) => `pf-${hex(id)}-t${i + 1}`;
const closeOrderId = (id: string, attempt: number) => `pf-${hex(id)}-x${attempt}`;

async function okBody(
  deps: EngineDeps,
  route: Parameters<FuturesClient['call']>[0],
  params?: Record<string, string>,
) {
  const outcome = await deps.binance.call(route, params);
  return outcome.kind === 'ok' ? outcome.body : null;
}

// ---------------------------------------------------------------- proposals

/** Propose one Long for this candidate and send it to the owner, or say why not. */
export async function propose(deps: EngineDeps, candidate: Candidate): Promise<string> {
  if (!deps.liveEnabled) return 'Live Futures entries are disabled (FUTURES_LIVE_ENABLED).';
  if (!ENTRY_RULES[candidate.rule])
    return `No proposal: ${candidate.rule} is not an approved rule.`;
  if ('error' in deps.risk) return `No proposal: ${deps.risk.error}.`;
  if ((await deps.store.openExecutions()).length > 0) {
    return 'No proposal: a Futures execution is still open or unresolved.';
  }
  if (await deps.store.pendingProposal()) return 'No proposal: another proposal is still pending.';
  const symbol = candidate.symbol;
  const loss = await cumulativeLoss(deps);
  if (typeof loss === 'string') return `No proposal: ${loss}.`;
  const [info, book, premium, commission] = await Promise.all([
    okBody(deps, 'exchangeInfo'),
    okBody(deps, 'bookTicker', { symbol }),
    okBody(deps, 'premiumIndex', { symbol }),
    okBody(deps, 'commissionRate', { symbol }),
  ]);
  const rules = parseSymbolRules(info, symbol);
  if (typeof rules === 'string') return `No proposal: ${rules}.`;
  if (!isRecord(book) || !isRecord(premium) || !isRecord(commission)) {
    return 'No proposal: Binance prices or the fee rate are unavailable.';
  }
  const id = deps.randomUUID();
  const plan = planLong({
    candidate,
    limits: deps.risk.limits,
    limitsSha256: deps.risk.sha256,
    rules,
    ask: String(book['askPrice']),
    mark: String(premium['markPrice']),
    takerFeeRate: String(commission['takerCommissionRate']),
    cumulativeLoss: loss,
    expiresAt: iso(deps.now() + deps.risk.limits.proposalTtlSeconds * 1000),
  });
  if (typeof plan === 'string') return `No proposal: ${plan}.`;
  const sha256 = await planSha256(id, plan);
  const stored = await deps.store.insertProposal({
    id,
    environment: ENVIRONMENT,
    expires_at: plan.expiresAt,
    symbol,
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
  await deps.store.event(id, 'proposed', { sha256, rule: plan.rule });
  return `Proposed ${id}.`;
}

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
  if (parsed.action === 'approve' && !deps.liveEnabled) {
    return answer('Live Futures entries are disabled. Nothing was done.');
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
  await answer('Approved. Rechecking, then executing on Binance Futures.');
  await deps.telegram.edit(
    proposal.telegram_chat_id,
    messageId,
    `${header}\n\nAPPROVED — rechecking and executing; status follows.`,
  );
  await execute(deps, proposal);
}

// ---------------------------------------------------------------- execution

const report = (deps: EngineDeps, p: ProposalRow, text: string) =>
  deps.telegram.send(p.telegram_chat_id, `Futures ${p.symbol} · ${p.id.slice(0, 8)}\n${text}`);

async function setState(deps: EngineDeps, ex: ExecutionRow, patch: Partial<ExecutionRow>) {
  Object.assign(ex, patch);
  await deps.store.updateExecution(ex.proposal_id, patch);
  if (patch.state)
    await deps.store.event(ex.proposal_id, `state_${patch.state}`, { detail: ex.detail });
}

/**
 * Everything that must hold right before the entry, in this order. Account-wide settings are
 * verified, never changed; the symbol is set to isolated and 5× and then read back. Any value that
 * can't be read refuses the entry.
 */
async function preflight(deps: EngineDeps, p: ProposalRow): Promise<string | null> {
  for (const check of [riskRefusal, accountRefusal, symbolRefusal, marginRefusal]) {
    const refusal = await check(deps, p); // NOSONAR(S9382): checks run in order, first refusal wins
    if (refusal) return refusal;
  }
  return null;
}

/** The proposal is still within its time, the owner's limits, the budget, the key and the price. */
async function riskRefusal(deps: EngineDeps, p: ProposalRow): Promise<string | null> {
  const { plan, symbol } = p;
  if ('error' in deps.risk) return deps.risk.error;
  if (deps.risk.sha256 !== plan.riskLimitsSha256) {
    return 'The owner risk limits changed since the proposal';
  }
  if (deps.now() >= Date.parse(p.expires_at)) return 'The proposal expired';
  if (!deps.risk.limits.symbols.includes(symbol)) return `${symbol} is no longer an allowed symbol`;
  const loss = await cumulativeLoss(deps);
  if (typeof loss === 'string') return loss;
  const overRisk = riskDrift(plan, deps.risk.limits, loss);
  if (overRisk) return overRisk;
  const keyRefusal = keyPermissionRefusal(await okBody(deps, 'apiRestrictions'));
  if (keyRefusal) return keyRefusal;
  const book = await okBody(deps, 'bookTicker', { symbol });
  if (!isRecord(book)) return 'Could not read the current ask';
  return priceDrift(plan, String(book['askPrice']));
}

/** One-way, single-asset, able to trade, and nothing already open on the symbol. */
async function accountRefusal(deps: EngineDeps, p: ProposalRow): Promise<string | null> {
  const { symbol } = p;
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
  return null;
}

/** Isolated margin at 5×, set if needed and read back; auto-add margin off; bracket large enough. */
async function symbolRefusal(deps: EngineDeps, p: ProposalRow): Promise<string | null> {
  const { symbol } = p;
  const before = await readSymbolConfig(deps, symbol);
  if (!before) return 'Could not read the symbol configuration';
  if (before.marginType !== 'ISOLATED') {
    const set = await deps.binance.call('setMarginType', { symbol, marginType: 'ISOLATED' });
    if (set.kind === 'rejected' && set.code !== -4046) {
      return `Isolated margin not set: ${describe(set)}`;
    }
  }
  if (before.leverage !== LEVERAGE) {
    const set = await deps.binance.call('setLeverage', { symbol, leverage: String(LEVERAGE) });
    if (set.kind === 'rejected') return `Leverage not set: ${describe(set)}`;
  }
  const after = await readSymbolConfig(deps, symbol);
  if (after?.marginType !== 'ISOLATED' || after.leverage !== LEVERAGE) {
    return 'Could not verify isolated margin at 5×';
  }
  if (after.isAutoAddMargin !== false) return 'Auto-add margin is on for this symbol';
  const cap = dec(after.maxNotionalValue);
  if (!cap || cap < (dec(p.plan.notional) as bigint)) {
    return 'The notional exceeds the 5× bracket cap';
  }
  return null;
}

/** Available USDT covers the collateral. */
async function marginRefusal(deps: EngineDeps, p: ProposalRow): Promise<string | null> {
  const balances = await okBody(deps, 'balance');
  const usdt = Array.isArray(balances)
    ? balances.find((b: unknown) => isRecord(b) && b['asset'] === 'USDT')
    : undefined;
  const available = isRecord(usdt) ? dec(usdt['availableBalance']) : null;
  if (available === null) return 'Could not read the available USDT balance';
  if (available < (dec(p.plan.collateral) as bigint))
    return 'Available USDT is below the collateral';
  return null;
}

const KEY_MUST_BE_ON = ['enableReading', 'enableFutures'];
const KEY_MUST_BE_OFF = [
  'enableWithdrawals',
  'enableInternalTransfer',
  'permitsUniversalTransfer',
  'enableSpotAndMarginTrading',
  'enableMargin',
  'enableVanillaOptions',
  'enablePortfolioMarginTrading',
];

/** The trading key may read and trade USDⓈ-M Futures only: no withdrawal, transfer or other market. */
export function keyPermissionRefusal(body: unknown): string | null {
  if (!isRecord(body)) return 'Could not verify the API key permissions';
  const missing = KEY_MUST_BE_ON.filter((name) => body[name] !== true);
  if (missing.length > 0) return `The API key lacks ${missing.join(', ')}`;
  const extra = KEY_MUST_BE_OFF.filter((name) => body[name] !== false);
  if (extra.length > 0) return `The API key must not have ${extra.join(', ')}`;
  return null;
}

/**
 * The experiment's cumulative loss: the sum of every losing closed trade's net result (wins do
 * not offset it). A closed trade whose result is not yet verified stops new entries.
 */
async function cumulativeLoss(deps: EngineDeps): Promise<bigint | string> {
  let loss = 0n;
  for (const ex of await deps.store.closedExecutions()) {
    const pnl = signedDec(ex.realized_pnl);
    if (pnl === null)
      return `The realized result of ${ex.proposal_id.slice(0, 8)} is not verified yet`;
    if (pnl < 0n) loss -= pnl;
  }
  return loss;
}

const INCOME_TYPES = new Set(['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']);

/**
 * One income row's contribution: skipped when it is another symbol or type, null when it can't be
 * counted (not USDT, or unreadable).
 */
function incomeAmount(
  row: unknown,
  symbol: string,
): 'skip' | { amount: bigint; realized: boolean } | null {
  if (!isRecord(row) || row['symbol'] !== symbol || !INCOME_TYPES.has(String(row['incomeType']))) {
    return 'skip';
  }
  const amount = signedDec(row['income']);
  if (row['asset'] !== 'USDT' || amount === null) return null;
  return { amount, realized: row['incomeType'] === 'REALIZED_PNL' };
}

/**
 * Net USDT for the symbol since the entry, from Binance income: realized PnL, commissions and
 * funding. Null when any of them is in another asset, a page could be truncated, or no realized
 * PnL is recorded yet. Assumes no other trading on this symbol meanwhile (preflight requires it
 * flat with no orders before the entry).
 */
async function incomeSinceEntry(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow) {
  const start = Date.parse(ex.entry_submitted_at ?? '') - 1000;
  if (!Number.isFinite(start)) return null;
  let total = 0n;
  let realized = false;
  for (let from = start; from <= deps.now(); from += INCOME_WINDOW_MS) {
    const range = {
      symbol: p.symbol,
      startTime: String(from),
      endTime: String(Math.min(from + INCOME_WINDOW_MS - 1, deps.now())),
      limit: '1000',
    };
    // 7-day windows, one request at a time.
    const rows = await okBody(deps, 'income', range); // NOSONAR(S9382)
    if (!Array.isArray(rows) || rows.length >= 1000) return null;
    for (const row of rows) {
      const counted = incomeAmount(row, p.symbol);
      if (counted === null) return null;
      if (counted === 'skip') continue;
      realized ||= counted.realized;
      total += counted.amount;
    }
  }
  return realized ? fmt(total) : null;
}

/** Record a closed trade's net result once Binance shows it; the tick retries until it does. */
async function recordResult(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow) {
  if (ex.realized_pnl !== null || ex.filled_qty === null) return;
  const pnl = await incomeSinceEntry(deps, p, ex);
  if (pnl === null) return;
  await setState(deps, ex, { realized_pnl: pnl });
  await report(deps, p, `RESULT: net ${pnl} USDT (realized PnL, fees and funding from Binance).`);
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
    realized_pnl: null,
  };
  const { proposal_id, state, entry_client_order_id, lease_until } = ex;
  const claim = { proposal_id, state, entry_client_order_id, lease_until };
  if ((await deps.store.insertExecution(claim)) === 'blocked') {
    await report(deps, p, 'NOT EXECUTED: another Futures execution is still open or unresolved.');
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
    const sent = await deps.binance.call('newOrder', {
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
      await report(deps, p, `ENTRY REJECTED by Binance: ${describe(sent)}. No position.`);
      return;
    }
    if (sent.kind === 'ok') await applyEntry(deps, p, ex, sent.body);
    // Unknown: query the client order ID a few times before leaving it to the scheduled reconcile.
    for (let attempt = 0; ex.state === 'entry_unknown' && attempt < 4; attempt++) {
      await deps.sleep(1500 * (attempt + 1)); // NOSONAR(S9382): back off between queries
      await reconcileEntry(deps, p, ex); // NOSONAR(S9382): each query depends on the last
    }
    if (ex.state === 'entry_unknown') {
      await alertOnce(
        deps,
        p,
        ex,
        'Entry status UNKNOWN at Binance. Reconciling every minute; new entries blocked.',
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
    avgPrice: typeof body['avgPrice'] === 'string' ? body['avgPrice'] : '0',
    orderId: String(body['orderId']),
  };
}

const LIVE = new Set(['NEW', 'PARTIALLY_FILLED']);

async function queryEntry(deps: EngineDeps, p: ProposalRow, ex: ExecutionRow) {
  return deps.binance.call('queryOrder', {
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
      await report(deps, p, 'ENTRY NOT PLACED: Binance has no such order. No position.');
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
    await deps.binance.call('cancelOrder', {
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
    // Query, then submit only if absent, then back off: strictly one at a time.
    const found = await deps.binance.call('queryAlgoOrder', { clientAlgoId }); // NOSONAR(S9382)
    if (found.kind === 'ok' && isRecord(found.body)) {
      const status = String(found.body['algoStatus']);
      if (status === 'NEW' || status === 'TRIGGERED' || status === 'FINISHED')
        return { clientAlgoId, status };
    } else if (!isAbsent(found)) {
      last = `query ${describe(found)}`;
      await deps.sleep(1000 * (attempt + 1)); // NOSONAR(S9382)
      continue;
    }
    const sent = await deps.binance.call('newAlgoOrder', { algoType: 'CONDITIONAL', ...spec }); // NOSONAR(S9382)
    last = describe(sent);
    if (sent.kind === 'rejected' && !isDuplicate(sent))
      return { clientAlgoId, status: 'FAILED', detail: last };
    if (sent.kind === 'ok' && isRecord(sent.body) && sent.body['algoStatus'] === 'NEW') {
      return { clientAlgoId, status: 'NEW' };
    }
    await deps.sleep(1000 * (attempt + 1)); // NOSONAR(S9382)
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
    const spec = {
      symbol: p.symbol,
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      triggerPrice: target.price,
      quantity: target.quantity,
      workingType: 'MARK_PRICE',
      // Reduce-only: can only shrink the long, never reverse it.
      reduceOnly: 'true',
      clientAlgoId: targetAlgoId(p.id, i),
    };
    // One exit at a time, in target order.
    targets.push(await ensureAlgo(deps, spec)); // NOSONAR(S9382)
  }
  await setState(deps, ex, { state: 'protected', protection: { stop, targets } });
  const lines = [
    `PROTECTED ${ex.filled_qty} ${p.symbol}:`,
    `Stop ${p.plan.stopTrigger} (close-all, mark price): ${stop.status}`,
    ...targets.map((t, i) =>
      [`Target ${i + 1}: ${t.status}`, t.detail && `(${t.detail})`].filter(Boolean).join(' '),
    ),
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
      await recordResult(deps, p, ex);
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
  await deps.binance.call('cancelAllAlgoOpenOrders', { symbol });
  await deps.binance.call('cancelAllOpenOrders', { symbol });
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
  await deps.binance.call('cancelOrder', {
    symbol: p.symbol,
    origClientOrderId: ex.entry_client_order_id,
  });
  let amount = await readPosition(deps, p.symbol);
  if (amount !== null && amount > 0n && ex.close_attempts < MAX_CLOSE_ATTEMPTS) {
    const attempt = ex.close_attempts + 1;
    await setState(deps, ex, { close_attempts: attempt });
    const sent = await deps.binance.call('newOrder', {
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
    await recordResult(deps, p, ex);
    return;
  }
  const where = amount === null ? 'unreadable' : fmt(amount);
  await alertOnce(
    deps,
    p,
    ex,
    `UNRESOLVED: position ${where} ${p.symbol} or orders still open after the close attempt. Retrying every minute; new entries blocked. Check Binance.`,
  );
}

// ---------------------------------------------------------------- scheduled tick

export interface TickSummary {
  expired: number;
  reconciled: { id: string; from: string; to: string }[];
  skipped: string[];
  results: number;
  rule: string;
}

async function expireProposals(deps: EngineDeps, summary: TickSummary) {
  for (const p of await deps.store.expireDue(iso(deps.now()))) {
    summary.expired++;
    await deps.store.event(p.id, 'expired', {}); // NOSONAR(S9382): few rows, in order
    if (p.telegram_message_id === null) continue;
    const text = `${proposalText(p.id, p.plan_sha256, p.plan)}\n\nEXPIRED — no order placed.`;
    await deps.telegram.edit(p.telegram_chat_id, p.telegram_message_id, text); // NOSONAR(S9382)
  }
}

/** Drive every open execution whose lease is free; at most one exists (database constraint). */
async function reconcileOpen(deps: EngineDeps, summary: TickSummary) {
  for (const ex of await deps.store.openExecutions()) {
    const p = await deps.store.getProposal(ex.proposal_id); // NOSONAR(S9382): one at a time
    const until = iso(deps.now() + LEASE_MS);
    if (!p || !(await deps.store.lease(ex.proposal_id, iso(deps.now()), until))) {
      summary.skipped.push(ex.proposal_id);
      continue;
    }
    const from = ex.state;
    try {
      await drive(deps, p, ex); // NOSONAR(S9382): an execution is never driven concurrently
    } finally {
      await deps.store.updateExecution(ex.proposal_id, { lease_until: null }); // NOSONAR(S9382)
    }
    summary.reconciled.push({ id: ex.proposal_id, from, to: ex.state });
  }
}

async function recordPendingResults(deps: EngineDeps, summary: TickSummary) {
  for (const ex of await deps.store.closedExecutions()) {
    if (ex.realized_pnl !== null) continue;
    const p = await deps.store.getProposal(ex.proposal_id); // NOSONAR(S9382): one at a time
    if (p) await recordResult(deps, p, ex); // NOSONAR(S9382)
    if (ex.realized_pnl !== null) summary.results++;
  }
}

async function runRule(deps: EngineDeps, rule: string | undefined): Promise<string> {
  const detect = rule ? ENTRY_RULES[rule] : undefined;
  if (!rule) return 'no entry rule configured';
  if (!detect) return `${rule} is not an approved entry rule; nothing detected`;
  if (!deps.liveEnabled) return 'live entries disabled (FUTURES_LIVE_ENABLED)';
  const candidate = await detect(deps);
  return candidate ? propose(deps, candidate) : `${rule}: no candidate`;
}

/** Expire stale proposals, reconcile every open execution (also after a restart), run the rule. */
export async function tick(deps: EngineDeps, rule: string | undefined): Promise<TickSummary> {
  const summary: TickSummary = { expired: 0, reconciled: [], skipped: [], results: 0, rule: '' };
  await expireProposals(deps, summary);
  await reconcileOpen(deps, summary);
  await recordPendingResults(deps, summary);
  summary.rule = await runRule(deps, rule);
  return summary;
}
