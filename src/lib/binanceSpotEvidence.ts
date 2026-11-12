// Accumulated Binance Spot execution evidence for one manual retrieval
// (docs/BINANCE_SPOT_RECONCILIATION.md, section 8). Pure: the execution view
// folds each page answer through `nextExecutionEvidence`, and quantity
// reconciliation reads the same folded record, so the two share one set of
// identity, conflict, failure and coverage rules.
import type { SpotExecutionRead, SpotFailure } from '@/lib/binanceSpotAccount';
import type {
  SpotExecution,
  SpotExecutionConflict,
  SpotExecutionCoverage,
  SpotExecutionFailure,
} from '../../supabase/functions/binance-spot-account/handler';

/** Mirrors the explicit server allowlist, sourced from the app's known crypto set. */
export const SPOT_EXECUTION_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'DOTUSDT',
  'MATICUSDT',
  'LTCUSDT',
] as const;

export interface SpotExecutionEvidence {
  executions: SpotExecution[];
  conflicts: SpotExecutionConflict[];
  symbols: string[];
  startTime: number;
  endTime: number;
  /** The function's clock when this retrieval's first page was read. */
  firstRetrievedAt: string;
  /** The function's clock when the latest page was read. */
  retrievedAt: string;
  lastPageReturned: number;
  continuation: string | null;
  partialFailures: SpotExecutionFailure[];
  completedSymbols: string[];
  continuationFailures: SpotFailure[];
}

export function executionIdentity(execution: SpotExecution): string {
  return `${execution.symbol}:${execution.tradeId}`;
}

/** Every recorded field must match exactly; decimal strings are never normalized. */
export function sameExecution(left: SpotExecution, right: SpotExecution): boolean {
  return (
    left.symbol === right.symbol &&
    left.tradeId === right.tradeId &&
    left.orderId === right.orderId &&
    left.time === right.time &&
    left.side === right.side &&
    left.quantity === right.quantity &&
    left.price === right.price &&
    left.quoteQuantity === right.quoteQuantity &&
    left.commission === right.commission &&
    left.commissionAsset === right.commissionAsset
  );
}

function mergeEvidence(
  current: Pick<SpotExecutionEvidence, 'executions' | 'conflicts'> | null,
  executions: SpotExecution[],
  conflicts: SpotExecutionConflict[],
): Pick<SpotExecutionEvidence, 'executions' | 'conflicts'> {
  const variantsByIdentity = new Map<string, SpotExecution[]>();
  const add = (execution: SpotExecution) => {
    const identity = executionIdentity(execution);
    const variants = variantsByIdentity.get(identity);
    if (variants === undefined) variantsByIdentity.set(identity, [execution]);
    else if (!variants.some((variant) => sameExecution(variant, execution))) {
      variants.push(execution);
    }
  };
  current?.executions.forEach(add);
  current?.conflicts.forEach((conflict) => conflict.variants.forEach(add));
  executions.forEach(add);
  conflicts.forEach((conflict) => conflict.variants.forEach(add));

  const consistent: SpotExecution[] = [];
  const inconsistent: SpotExecutionConflict[] = [];
  for (const variants of variantsByIdentity.values()) {
    const first = variants[0] as SpotExecution;
    if (variants.length === 1) consistent.push(first);
    else inconsistent.push({ symbol: first.symbol, tradeId: first.tradeId, variants });
  }
  return { executions: consistent, conflicts: inconsistent };
}

function uniqueFailures(failures: SpotExecutionFailure[]): SpotExecutionFailure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.symbol}:${failure.error}:${failure.retryAfterSeconds ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A continued answer belongs to a retrieval only if it names the same pairs and window. */
function sameSelection(evidence: SpotExecutionEvidence, coverage: SpotExecutionCoverage): boolean {
  return (
    coverage.startTime === evidence.startTime &&
    coverage.endTime === evidence.endTime &&
    coverage.symbols.length === evidence.symbols.length &&
    coverage.symbols.every((symbol, index) => symbol === evidence.symbols[index])
  );
}

/**
 * The evidence after one answer. `continued` is true when the answer is to a continuation
 * of `current`; otherwise a successful answer starts a new retrieval. A failed answer keeps
 * the earlier evidence unless access was lost, and a failed continuation stays recorded. A
 * continued answer for other pairs or another window, or with nothing to continue, is never
 * merged.
 */
export function nextExecutionEvidence(
  current: SpotExecutionEvidence | null,
  result: SpotExecutionRead,
  continued: boolean,
): SpotExecutionEvidence | null {
  if (result.state === 'error') {
    if (result.error === 'unauthenticated' || result.error === 'forbidden') return null;
    return continued && current
      ? { ...current, continuationFailures: [...current.continuationFailures, result] }
      : current;
  }
  if (result.state !== 'executions') return null;
  if (continued && (current === null || !sameSelection(current, result.coverage))) {
    // Merging would claim pages this retrieval never read. Like any failed continuation it
    // is kept as evidence, with the cursor, and the retrieval stays unresolved.
    return (
      current && {
        ...current,
        continuationFailures: [
          ...current.continuationFailures,
          { state: 'error', error: 'invalid_request' },
        ],
      }
    );
  }
  const accumulated = continued ? current : null;
  const evidence = mergeEvidence(accumulated, result.executions, result.conflicts);
  return {
    ...evidence,
    symbols: result.coverage.symbols,
    startTime: result.coverage.startTime,
    endTime: result.coverage.endTime,
    firstRetrievedAt: accumulated?.firstRetrievedAt ?? result.coverage.retrievedAt,
    retrievedAt: result.coverage.retrievedAt,
    lastPageReturned: result.coverage.returned,
    continuation: result.continuation ?? null,
    partialFailures: uniqueFailures([
      ...(accumulated?.partialFailures ?? []),
      ...result.coverage.failures,
    ]),
    completedSymbols: [
      ...new Set([...(accumulated?.completedSymbols ?? []), ...result.coverage.completedSymbols]),
    ],
    continuationFailures: accumulated?.continuationFailures ?? [],
  };
}

/** Complete for the requested pairs and window only; never lifetime history. */
export function requestedCoverageComplete(evidence: SpotExecutionEvidence): boolean {
  return (
    evidence.continuation === null &&
    evidence.partialFailures.length === 0 &&
    evidence.continuationFailures.length === 0 &&
    evidence.conflicts.length === 0 &&
    evidence.symbols.every((symbol) => evidence.completedSymbols.includes(symbol))
  );
}
