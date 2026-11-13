// Quantity reconciliation of one Binance Spot subject asset between two balance reads
// (docs/BINANCE_SPOT_RECONCILIATION.md, sections 3 and 9). Pure and offline: it reads no
// provider, clock or storage and writes nothing. It never values, costs or attributes a
// movement; a zero difference is numerical consistency only.
import type { SpotBalance, SpotRead } from '@/lib/binanceSpotAccount';
import {
  executionIdentity,
  sameExecution,
  SPOT_EXECUTION_SYMBOLS,
  type SpotExecutionEvidence,
} from '@/lib/binanceSpotEvidence';
import { parseDecimal } from '@/lib/spotScenario';
import type { SpotExecution } from '../../supabase/functions/binance-spot-account/handler';

/**
 * Provisional Popup policy (D6), set above the client's 20 s read limit. Not a Binance figure,
 * not a measured bound on clock skew, and passing it does not make either read an atomic or
 * synchronized account snapshot.
 */
export const RECONCILIATION_GUARD_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Opening to closing read, so the guarded execution window fits one 24-hour selection. */
export const MAX_BALANCE_INTERVAL_MS = DAY_MS - 2 * RECONCILIATION_GUARD_MS;

const DECIMAL = /^\d+(\.\d+)?$/;
const INTEGER = /^\d+$/;
const SUPPORTED_SYMBOLS = new Set<string>(SPOT_EXECUTION_SYMBOLS);
/** USDT moves on every pair; BNB pays fees on pairs that are not read. */
export const EXCLUDED_SUBJECTS: ReadonlySet<string> = new Set(['USDT', 'BNB']);

/** One balance read and the account it was made for (e.g. the signed-in owner's user ID). */
export interface SpotBalanceObservation {
  accountContext: string;
  read: SpotRead;
}

/** The accumulated evidence of one execution retrieval, as the execution view folds it. */
export interface SpotExecutionObservation {
  accountContext: string;
  evidence: SpotExecutionEvidence;
}

export interface QuantityReconciliationInput {
  /** The base asset of one supported USDT pair; never USDT or BNB. */
  subject: string;
  opening: SpotBalanceObservation;
  closing: SpotBalanceObservation;
  executions: SpotExecutionObservation;
}

export type IndeterminateCode =
  | 'unsupported_subject'
  | 'opening_unavailable'
  | 'closing_unavailable'
  | 'opening_invalid'
  | 'closing_invalid'
  | 'account_context_mismatch'
  | 'balance_order_invalid'
  | 'balance_interval_too_long'
  | 'execution_window_not_covering'
  | 'executions_read_too_early'
  | 'execution_evidence_invalid'
  | 'pair_not_selected'
  | 'pair_failed'
  | 'pair_incomplete'
  | 'continuation_failed'
  | 'conflicting_fills'
  | 'subject_fee_on_other_pair'
  | 'fill_near_boundary';

export interface IndeterminateReason {
  code: IndeterminateCode;
  /** Trade IDs, error codes or the evidence problems behind the reason. */
  items?: string[];
}

/** Fixed statements carried by every result, whatever its status. */
export const QUANTITY_LIMITS = Object.freeze({
  meaning: 'numerical_consistency_only',
  accountHistory: 'not_established',
  unseenEvents: 'not_excluded',
  acquisitionCost: 'not_evaluated',
  /** D3: whether `commission` is the whole amount debited for a fill. */
  commissionCoverage: 'unverified',
  /** D6: see RECONCILIATION_GUARD_MS. */
  boundaryGuard: 'provisional_policy',
} as const);

interface ResultBase {
  subject: string;
  symbol: string;
  limits: typeof QUANTITY_LIMITS;
}

/** Exact decimals at the widest scale recorded among the amounts that enter each figure. */
export interface QuantityFigures {
  opening: string;
  buys: string;
  sells: string;
  subjectFees: string;
  movement: string;
  expected: string;
  closing: string;
  /** closing − expected, signed and unattributed. */
  difference: string;
  /** The subject-pair fills summed, by time then trade ID. */
  countedTradeIds: string[];
  /** Fees of counted fills paid in another asset: kept in that asset, never converted or reconciled. */
  feesInOtherAssets: { asset: string; amount: string }[];
}

export type QuantityReconciliation =
  | (ResultBase & { status: 'CONSISTENT' | 'DISCREPANCY' } & QuantityFigures)
  | (ResultBase & { status: 'INDETERMINATE'; reasons: IndeterminateReason[] });

const scaleOf = (value: string): number => value.split('.')[1]?.length ?? 0;

/** value × 10^scale. Every amount here already matched DECIMAL with at most `scale` places. */
function units(value: string, scale: number): bigint {
  const parsed = parseDecimal(value, scale);
  if (typeof parsed !== 'bigint') throw new Error('Unvalidated decimal reached reconciliation');
  return parsed;
}

/** value / 10^scale as a plain signed decimal with exactly `scale` places. */
function format(value: bigint, scale: number): string {
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return value < 0n ? `-${text}` : text;
}

function sum(values: string[], scale: number): bigint {
  return values.reduce((total, value) => total + units(value, scale), 0n);
}

type AddReason = (code: IndeterminateCode, items?: string[]) => void;

/** A successful, well-formed read's time and rows; otherwise null, with the reason added. */
function usableRead(
  read: SpotRead,
  which: 'opening' | 'closing',
  add: AddReason,
): { at: number; balances: SpotBalance[] } | null {
  if (read.state !== 'connected') {
    add(`${which}_unavailable`, [read.state === 'error' ? read.error : read.state]);
    return null;
  }
  const at = Date.parse(read.readAt);
  const assets = new Set(read.balances.map((balance) => balance.asset));
  const valid =
    Number.isFinite(at) &&
    assets.size === read.balances.length &&
    read.balances.every(
      (row) => row.asset.length > 0 && DECIMAL.test(row.free) && DECIMAL.test(row.locked),
    );
  if (!valid) add(`${which}_invalid`);
  return valid ? { at, balances: read.balances } : null;
}

function validFill(fill: SpotExecution, evidence: SpotExecutionEvidence): boolean {
  return (
    evidence.symbols.includes(fill.symbol) &&
    INTEGER.test(fill.tradeId) &&
    INTEGER.test(fill.orderId) &&
    Number.isSafeInteger(fill.time) &&
    fill.time >= evidence.startTime &&
    fill.time <= evidence.endTime &&
    (fill.side === 'buy' || fill.side === 'sell') &&
    [fill.quantity, fill.price, fill.quoteQuantity, fill.commission].every((value) =>
      DECIMAL.test(value),
    ) &&
    fill.commissionAsset.length > 0
  );
}

/** Structural problems that make the evidence unusable; empty when it is well formed. */
function evidenceProblems(evidence: SpotExecutionEvidence): string[] {
  const problems: string[] = [];
  const { startTime, endTime, symbols } = evidence;
  if (
    !Number.isSafeInteger(startTime) ||
    !Number.isSafeInteger(endTime) ||
    startTime <= 0 ||
    endTime <= startTime ||
    endTime - startTime > DAY_MS
  ) {
    problems.push('window');
  }
  const first = Date.parse(evidence.firstRetrievedAt);
  const latest = Date.parse(evidence.retrievedAt);
  if (!Number.isFinite(first) || !Number.isFinite(latest) || latest < first) {
    problems.push('retrieval_time');
  }
  if (
    symbols.length === 0 ||
    new Set(symbols).size !== symbols.length ||
    !symbols.every((symbol) => SUPPORTED_SYMBOLS.has(symbol))
  ) {
    problems.push('symbols');
  }
  if (
    !evidence.completedSymbols.every((symbol) => symbols.includes(symbol)) ||
    !evidence.partialFailures.every((failure) => symbols.includes(failure.symbol))
  ) {
    problems.push('coverage');
  }
  const variants = evidence.conflicts.flatMap((conflict) => conflict.variants);
  for (const fill of [...evidence.executions, ...variants]) {
    if (!validFill(fill, evidence)) problems.push(`fill ${executionIdentity(fill)}`);
  }
  const identities = evidence.executions.map(executionIdentity);
  const conflicted = evidence.conflicts.map((conflict) => `${conflict.symbol}:${conflict.tradeId}`);
  if (new Set([...identities, ...conflicted]).size !== identities.length + conflicted.length) {
    problems.push('duplicate_identity');
  }
  for (const conflict of evidence.conflicts) {
    const distinct = conflict.variants.every(
      (variant, index) =>
        variant.symbol === conflict.symbol &&
        variant.tradeId === conflict.tradeId &&
        !conflict.variants.slice(0, index).some((earlier) => sameExecution(earlier, variant)),
    );
    if (conflict.variants.length < 2 || !distinct) {
      problems.push(`conflict ${conflict.symbol}:${conflict.tradeId}`);
    }
  }
  return problems;
}

function byTimeThenTradeId(left: SpotExecution, right: SpotExecution): number {
  if (left.time !== right.time) return left.time - right.time;
  const difference = BigInt(left.tradeId) - BigInt(right.tradeId);
  if (difference === 0n) return 0;
  return difference < 0n ? -1 : 1;
}

function measure(
  subject: string,
  opening: SpotBalance | undefined,
  closing: SpotBalance | undefined,
  counted: SpotExecution[],
): QuantityFigures & { status: 'CONSISTENT' | 'DISCREPANCY' } {
  const quantities = (side: SpotExecution['side']) =>
    counted.filter((fill) => fill.side === side).map((fill) => fill.quantity);
  const buys = quantities('buy');
  const sells = quantities('sell');
  const fees = counted
    .filter((fill) => fill.commissionAsset === subject)
    .map((fill) => fill.commission);
  // free + locked: an order that is placed or cancelled but not filled moves neither.
  const openingParts = opening ? [opening.free, opening.locked] : [];
  const closingParts = closing ? [closing.free, closing.locked] : [];
  const scale = Math.max(
    0,
    ...[...openingParts, ...closingParts, ...buys, ...sells, ...fees].map(scaleOf),
  );
  const total = (values: string[]) => sum(values, scale);
  const open = total(openingParts);
  const movement = total(buys) - total(sells) - total(fees);
  const close = total(closingParts);
  const difference = close - (open + movement);

  const otherFees = new Map<string, string[]>();
  for (const fill of counted) {
    if (fill.commissionAsset === subject) continue;
    otherFees.set(fill.commissionAsset, [
      ...(otherFees.get(fill.commissionAsset) ?? []),
      fill.commission,
    ]);
  }
  return {
    status: difference === 0n ? 'CONSISTENT' : 'DISCREPANCY',
    opening: format(open, scale),
    buys: format(total(buys), scale),
    sells: format(total(sells), scale),
    subjectFees: format(total(fees), scale),
    movement: format(movement, scale),
    expected: format(open + movement, scale),
    closing: format(close, scale),
    difference: format(difference, scale),
    countedTradeIds: [...counted].sort(byTimeThenTradeId).map((fill) => fill.tradeId),
    feesInOtherAssets: [...otherFees.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([asset, amounts]) => {
        const assetScale = Math.max(...amounts.map(scaleOf));
        return { asset, amount: format(sum(amounts, assetScale), assetScale) };
      }),
  };
}

/** The subject pair's coverage within the accumulated retrieval. */
function coverageReasons(evidence: SpotExecutionEvidence, symbol: string, add: AddReason): void {
  if (evidence.symbols.includes(symbol)) {
    const failed = evidence.partialFailures.filter((failure) => failure.symbol === symbol);
    if (failed.length > 0) add('pair_failed', [...new Set(failed.map((failure) => failure.error))]);
    // No continuation is not completion: only an explicit terminal success counts.
    else if (!evidence.completedSymbols.includes(symbol)) add('pair_incomplete');
  } else {
    add('pair_not_selected');
  }
  // A continuation is opaque, so its failure cannot be confined to one pair.
  if (evidence.continuationFailures.length > 0) {
    add('continuation_failed', [
      ...new Set(evidence.continuationFailures.map((failure) => failure.error)),
    ]);
  }
  const conflicted = evidence.conflicts.filter((conflict) => conflict.symbol === symbol);
  if (conflicted.length > 0) {
    add(
      'conflicting_fills',
      conflicted.map((item) => item.tradeId),
    );
  }
}

/** Ordering, interval length, window coverage and when the retrieval began, against O and C. */
function timingReasons(
  evidence: SpotExecutionEvidence,
  o: number,
  c: number,
  add: AddReason,
): void {
  const g = RECONCILIATION_GUARD_MS;
  if (c <= o) add('balance_order_invalid');
  else if (c - o > MAX_BALANCE_INTERVAL_MS) add('balance_interval_too_long');
  if (evidence.startTime > o - g || evidence.endTime < c + g) add('execution_window_not_covering');
  const firstRead = Date.parse(evidence.firstRetrievedAt);
  if (!Number.isFinite(firstRead) || firstRead < c + g) add('executions_read_too_early');
}

/**
 * The subject-pair fills strictly inside (O + g, C − g). Fills before O − g are already in the
 * opening read and fills after C + g cannot be in the closing one, so both are ignored. A subject
 * fill within g of either read could be in either, so it blocks the conclusion and is never
 * summed. Conflict variants are scanned too; a subject conflict has already blocked the result.
 */
function countedFills(
  evidence: SpotExecutionEvidence,
  subject: string,
  o: number,
  c: number,
  add: AddReason,
): SpotExecution[] {
  const g = RECONCILIATION_GUARD_MS;
  const symbol = `${subject}USDT`;
  const variants = evidence.conflicts.flatMap((conflict) => conflict.variants);
  const relevant = [...evidence.executions, ...variants].filter(
    (fill) => fill.time >= o - g && fill.time <= c + g,
  );
  const own = relevant.filter((fill) => fill.symbol === symbol);
  const near = own.filter((fill) => fill.time <= o + g || fill.time >= c - g);
  const foreignFees = relevant.filter(
    (fill) => fill.symbol !== symbol && fill.commissionAsset === subject,
  );
  if (near.length > 0) add('fill_near_boundary', [...new Set(near.map((fill) => fill.tradeId))]);
  if (foreignFees.length > 0) add('subject_fee_on_other_pair', foreignFees.map(executionIdentity));
  return own.filter((fill) => fill.time > o + g && fill.time < c - g);
}

/**
 * Reconciles the subject's `free + locked` quantity from the opening to the closing read
 * against the subject pair's fills strictly inside the guarded interval. INDETERMINATE
 * lists every reason found; only well-formed, complete, conflict-free evidence with no fill
 * near either read reaches CONSISTENT or DISCREPANCY.
 */
export function reconcileSpotQuantity(input: QuantityReconciliationInput): QuantityReconciliation {
  const { subject, opening, closing, executions } = input;
  const { evidence } = executions;
  const symbol = `${subject}USDT`;
  const base: ResultBase = { subject, symbol, limits: QUANTITY_LIMITS };
  const reasons: IndeterminateReason[] = [];
  const add: AddReason = (code, items) => {
    reasons.push(items === undefined ? { code } : { code, items });
  };

  if (!SUPPORTED_SYMBOLS.has(symbol) || EXCLUDED_SUBJECTS.has(subject)) add('unsupported_subject');
  const open = usableRead(opening.read, 'opening', add);
  const close = usableRead(closing.read, 'closing', add);
  const contexts = new Set([
    opening.accountContext,
    closing.accountContext,
    executions.accountContext,
  ]);
  if (contexts.size !== 1 || opening.accountContext === '') add('account_context_mismatch');
  const problems = evidenceProblems(evidence);
  if (problems.length > 0) add('execution_evidence_invalid', problems);
  coverageReasons(evidence, symbol, add);
  if (open === null || close === null) return { ...base, status: 'INDETERMINATE', reasons };

  timingReasons(evidence, open.at, close.at, add);
  const counted = countedFills(evidence, subject, open.at, close.at, add);
  if (reasons.length > 0) return { ...base, status: 'INDETERMINATE', reasons };

  // An absent asset holds zero only because this read succeeded and is well formed.
  return {
    ...base,
    ...measure(
      subject,
      open.balances.find((row) => row.asset === subject),
      close.balances.find((row) => row.asset === subject),
      counted,
    ),
  };
}
