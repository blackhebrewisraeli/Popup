// Synthetic fixtures only: every account, time, ID and amount below is invented.
// Expected figures are calculated by hand, digit by digit, not by the code under test.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpotExecution, SpotExecutionRead } from '@/lib/binanceSpotAccount';
import { nextExecutionEvidence, type SpotExecutionEvidence } from '@/lib/binanceSpotEvidence';
import {
  MAX_BALANCE_INTERVAL_MS,
  QUANTITY_LIMITS,
  RECONCILIATION_GUARD_MS,
  reconcileSpotQuantity,
  type QuantityReconciliation,
  type QuantityReconciliationInput,
  type SpotBalanceObservation,
} from '@/lib/binanceSpotReconciliation';

const OWNER = 'synthetic-owner';
const G = RECONCILIATION_GUARD_MS;
const HOUR = 60 * 60 * 1000;
/** Opening and closing balance reads (O and C), twelve hours apart. */
const O = Date.parse('2026-11-10T08:00:00.000Z');
const C = O + 12 * HOUR;
const MID = O + 6 * HOUR;
const WINDOW = { startTime: O - G, endTime: C + G };
const READ_AT = new Date(C + G + 5000).toISOString();

type Row = [asset: string, free: string, locked?: string];

function observed(readAt: number, rows: Row[], accountContext = OWNER): SpotBalanceObservation {
  return {
    accountContext,
    read: {
      state: 'connected',
      readAt: new Date(readAt).toISOString(),
      balances: rows.map(([asset, free, locked = '0']) => ({ asset, free, locked })),
    },
  };
}

const opening = (...rows: Row[]) => observed(O, rows);
const closing = (...rows: Row[]) => observed(C, rows);

function fill(
  tradeId: string,
  side: SpotExecution['side'],
  quantity: string,
  fee: [amount: string, asset: string] = ['0', 'USDT'],
  overrides: Partial<SpotExecution> = {},
): SpotExecution {
  return {
    symbol: 'BTCUSDT',
    tradeId,
    orderId: '77',
    time: MID + Number(tradeId),
    side,
    quantity,
    price: '100.00000000',
    quoteQuantity: '10.00000000',
    commission: fee[0],
    commissionAsset: fee[1],
    ...overrides,
  };
}

interface PageOptions {
  continuation?: string;
  failures?: Extract<SpotExecutionRead, { state: 'executions' }>['coverage']['failures'];
  completedSymbols?: string[];
  symbols?: string[];
  retrievedAt?: string;
  window?: { startTime: number; endTime: number };
}

/** One execution page as the edge function answers it, after parseSpotExecutionRead. */
function page(executions: SpotExecution[], options: PageOptions = {}): SpotExecutionRead {
  const failures = options.failures ?? [];
  const symbols = options.symbols ?? ['BTCUSDT'];
  return {
    state: 'executions',
    executions,
    conflicts: [],
    coverage: {
      symbols,
      ...(options.window ?? WINDOW),
      returned: executions.length,
      retrievedAt: options.retrievedAt ?? READ_AT,
      hasMore: options.continuation !== undefined,
      partial: failures.length > 0,
      failures,
      completedSymbols:
        options.completedSymbols ??
        (options.continuation
          ? []
          : symbols.filter((symbol) => !failures.some((item) => item.symbol === symbol))),
      limitation: 'selected_pairs_and_24h_window',
    },
    ...(options.continuation ? { continuation: options.continuation } : {}),
  };
}

/** Folds one retrieval's answers exactly as the execution view does: first fresh, then continued. */
function retrieve(...answers: SpotExecutionRead[]): SpotExecutionEvidence {
  let evidence: SpotExecutionEvidence | null = null;
  for (const [index, answer] of answers.entries()) {
    evidence = nextExecutionEvidence(evidence, answer, index > 0);
  }
  if (evidence === null) throw new Error('fixture produced no evidence');
  return evidence;
}

function input(
  open: SpotBalanceObservation,
  close: SpotBalanceObservation,
  evidence: SpotExecutionEvidence,
  subject = 'BTC',
): QuantityReconciliationInput {
  return {
    subject,
    opening: open,
    closing: close,
    executions: { accountContext: OWNER, evidence },
  };
}

const reconcile = (...args: Parameters<typeof input>) => reconcileSpotQuantity(input(...args));

function reasonCodes(result: QuantityReconciliation): string[] {
  return result.status === 'INDETERMINATE' ? result.reasons.map((reason) => reason.code) : [];
}

describe('quantity portions of the specification examples (synthetic)', () => {
  it('E1: buys and sells with USDT fees reconcile exactly; USDT fees stay a separate amount', () => {
    const result = reconcile(
      opening(['USDT', '100.00000000']),
      closing(['BTC', '0.30000000'], ['USDT', '73.92600000']),
      retrieve(
        page([
          fill('1001', 'buy', '0.50000000', ['0.05000000', 'USDT']),
          fill('1002', 'sell', '0.20000000', ['0.02400000', 'USDT']),
        ]),
      ),
    );
    expect(result).toEqual({
      subject: 'BTC',
      symbol: 'BTCUSDT',
      limits: QUANTITY_LIMITS,
      status: 'CONSISTENT',
      opening: '0.00000000',
      buys: '0.50000000',
      sells: '0.20000000',
      subjectFees: '0.00000000',
      movement: '0.30000000',
      expected: '0.30000000',
      closing: '0.30000000',
      difference: '0.00000000',
      countedTradeIds: ['1001', '1002'],
      // 0.05 + 0.024, never converted and never reconciled against the USDT balance.
      feesInOtherAssets: [{ asset: 'USDT', amount: '0.07400000' }],
    });
  });

  it('E2: a fee in the subject reduces it; the same closing without the fee is a discrepancy', () => {
    const evidence = retrieve(page([fill('2001', 'buy', '1.00000000', ['0.00100000', 'BTC'])]));
    const result = reconcile(opening(), closing(['BTC', '0.99900000']), evidence);
    expect(result).toMatchObject({
      status: 'CONSISTENT',
      subjectFees: '0.00100000',
      movement: '0.99900000',
      difference: '0.00000000',
      feesInOtherAssets: [],
    });
    // 1.00000000 − (0 + 1 − 0.001) = +0.00100000: the fill, not the closing, explains 0.999.
    expect(reconcile(opening(), closing(['BTC', '1.00000000']), evidence)).toMatchObject({
      status: 'DISCREPANCY',
      expected: '0.99900000',
      difference: '0.00100000',
    });
  });

  it('E3: a BNB fee neither reduces the subject nor makes BNB reconciled', () => {
    const result = reconcile(
      opening(['BNB', '2.00000000']),
      closing(['BNB', '1.99500000'], ['BTC', '0.10000000']),
      retrieve(page([fill('3001', 'buy', '0.10000000', ['0.00500000', 'BNB'])])),
    );
    expect(result).toMatchObject({
      status: 'CONSISTENT',
      movement: '0.10000000',
      difference: '0.00000000',
      feesInOtherAssets: [{ asset: 'BNB', amount: '0.00500000' }],
    });
  });

  describe('E4: several fills, overlapping pages and one trade ID on two pairs', () => {
    const btc4001 = fill('4001', 'buy', '0.10000000', ['0.01000000', 'USDT']);
    const btc4002 = fill('4002', 'buy', '0.20000000', ['0.02000000', 'USDT']);
    const eth4001 = fill('4001', 'buy', '1.00000000', ['0.00500000', 'USDT'], {
      symbol: 'ETHUSDT',
      orderId: '91',
    });
    const symbols = ['BTCUSDT', 'ETHUSDT'];

    it('collapses the identical repeat and keeps BTCUSDT 4001 apart from ETHUSDT 4001', () => {
      const evidence = retrieve(
        page([btc4001, btc4002, eth4001], {
          symbols,
          continuation: 'synthetic-cursor',
          completedSymbols: ['ETHUSDT'],
        }),
        page([btc4002], { symbols, completedSymbols: ['BTCUSDT'] }),
      );
      expect(reconcile(opening(), closing(['BTC', '0.30000000']), evidence)).toMatchObject({
        status: 'CONSISTENT',
        buys: '0.30000000',
        countedTradeIds: ['4001', '4002'],
        feesInOtherAssets: [{ asset: 'USDT', amount: '0.03000000' }],
      });
    });

    it('E4b: a differing repeat is a conflict and blocks the conclusion', () => {
      const evidence = retrieve(
        page([btc4001, btc4002], { continuation: 'synthetic-cursor' }),
        page([{ ...btc4002, quantity: '0.25000000' }]),
      );
      const result = reconcile(opening(), closing(['BTC', '0.30000000']), evidence);
      expect(result.status).toBe('INDETERMINATE');
      expect(result).toMatchObject({ reasons: [{ code: 'conflicting_fills', items: ['4002'] }] });
    });

    it('treats 1.0 and 1.00 under one identity as conflicting evidence, not as equal', () => {
      const evidence = retrieve(
        page([fill('4100', 'buy', '1.0')], { continuation: 'synthetic-cursor' }),
        page([fill('4100', 'buy', '1.00')]),
      );
      expect(reasonCodes(reconcile(opening(), closing(['BTC', '1']), evidence))).toEqual([
        'conflicting_fills',
      ]);
    });

    it('is not changed by a failure or conflict on another selected pair', () => {
      const evidence = retrieve(
        page([btc4001, btc4002], {
          symbols,
          failures: [{ symbol: 'ETHUSDT', error: 'timeout' }],
        }),
      );
      expect(evidence.partialFailures).toHaveLength(1);
      expect(reconcile(opening(), closing(['BTC', '0.30000000']), evidence).status).toBe(
        'CONSISTENT',
      );
    });
  });

  it('E5: opening inventory reconciles by quantity and leaves acquisition cost unevaluated', () => {
    const result = reconcile(
      opening(['BTC', '0.40000000']),
      closing(['BTC', '0.30000000']),
      retrieve(
        page([
          fill('5001', 'buy', '0.10000000', ['0.01200000', 'USDT']),
          fill('5002', 'sell', '0.20000000', ['0.02600000', 'USDT']),
        ]),
      ),
    );
    expect(result).toMatchObject({ status: 'CONSISTENT', opening: '0.40000000' });
    expect(result.limits.acquisitionCost).toBe('not_evaluated');
  });

  it('6a: an unseen increase is a signed, unattributed discrepancy', () => {
    const result = reconcile(
      opening(),
      closing(['BTC', '0.15000000']),
      retrieve(page([fill('6001', 'buy', '0.10000000', ['0.01000000', 'USDT'])])),
    );
    expect(result).toMatchObject({ status: 'DISCREPANCY', difference: '0.05000000' });
  });

  it('6a, reversed: an unseen decrease is a negative difference', () => {
    const result = reconcile(
      opening(['BTC', '0.50000000']),
      closing(['BTC', '0.35000000']),
      retrieve(page([fill('6002', 'sell', '0.10000000')])),
    );
    expect(result).toMatchObject({
      status: 'DISCREPANCY',
      expected: '0.40000000',
      difference: '-0.05000000',
    });
  });

  it('6b: offsetting unseen events still add up, which is numerical consistency only', () => {
    // A withdrawal of 0.1 and a deposit of 0.1 happened too; nothing in the evidence shows them.
    const result = reconcile(
      opening(),
      closing(['BTC', '0.10000000']),
      retrieve(page([fill('6001', 'buy', '0.10000000', ['0.01000000', 'USDT'])])),
    );
    expect(result.status).toBe('CONSISTENT');
    expect(result.limits).toEqual({
      meaning: 'numerical_consistency_only',
      accountHistory: 'not_established',
      unseenEvents: 'not_excluded',
      acquisitionCost: 'not_evaluated',
      commissionCoverage: 'unverified',
      boundaryGuard: 'provisional_policy',
    });
  });

  it('6c: a failed page is indeterminate even when the received fills add up', () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      fill(String(7000 + index), 'buy', '0.00100000'),
    );
    const evidence = retrieve(
      page(first, { continuation: 'synthetic-cursor' }),
      page([], { failures: [{ symbol: 'BTCUSDT', error: 'timeout' }], completedSymbols: [] }),
    );
    expect(evidence.continuation).toBeNull();
    // 100 × 0.001 = 0.1 matches the closing exactly; the conclusion is still blocked.
    const result = reconcile(opening(), closing(['BTC', '0.10000000']), evidence);
    expect(result).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'pair_failed', items: ['timeout'] }],
    });
    expect(result).not.toHaveProperty('difference');
  });

  it('6d: a fill ten seconds after the opening read is indeterminate', () => {
    const result = reconcile(
      opening(),
      closing(['BTC', '0.10000000']),
      retrieve(page([fill('6400', 'buy', '0.10000000', ['0', 'USDT'], { time: O + 10_000 })])),
    );
    expect(result).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'fill_near_boundary', items: ['6400'] }],
    });
  });
});

describe('exact decimal arithmetic', () => {
  it('keeps more than eight decimal places at the widest recorded scale', () => {
    // 0.000000000000000001 + 0.12345678901234567 − 0.000000000000000002 = 0.123456789012345669
    const evidence = retrieve(
      page([fill('8001', 'buy', '0.12345678901234567', ['0.000000000000000002', 'BTC'])]),
    );
    const open = opening(['BTC', '0.000000000000000001']);
    expect(reconcile(open, closing(['BTC', '0.123456789012345669']), evidence)).toMatchObject({
      status: 'CONSISTENT',
      expected: '0.123456789012345669',
      difference: '0.000000000000000000',
    });
    // One unit at the 18th place is a discrepancy: there is no epsilon.
    expect(reconcile(open, closing(['BTC', '0.12345678901234567']), evidence)).toMatchObject({
      status: 'DISCREPANCY',
      difference: '0.000000000000000001',
    });
  });

  it('handles quantities beyond safe float precision without rounding', () => {
    // 2^53 + 1.5 has no exact double; 9007199254740993.5 + 1.25 − 0.75 = 9007199254740994.00
    const evidence = retrieve(page([fill('8101', 'buy', '1.25'), fill('8102', 'sell', '0.75')]));
    const open = opening(['BTC', '9007199254740993', '0.5']);
    expect(reconcile(open, closing(['BTC', '9007199254740994']), evidence)).toMatchObject({
      status: 'CONSISTENT',
      opening: '9007199254740993.50',
      expected: '9007199254740994.00',
    });
    expect(reconcile(open, closing(['BTC', '9007199254740994.01']), evidence)).toMatchObject({
      status: 'DISCREPANCY',
      difference: '0.01',
    });
  });

  it('compares balance values numerically: 1.0 and 1.00 are the same quantity', () => {
    expect(
      reconcile(opening(['BTC', '1.0']), closing(['BTC', '1.00']), retrieve(page([]))),
    ).toMatchObject({ status: 'CONSISTENT', opening: '1.00', closing: '1.00' });
  });

  it('reconciles free + locked, so moving units between them is no movement', () => {
    expect(
      reconcile(
        opening(['BTC', '0.40000000', '0.10000000']),
        closing(['BTC', '0.20000000', '0.30000000']),
        retrieve(page([])),
      ),
    ).toMatchObject({ status: 'CONSISTENT', opening: '0.50000000', movement: '0.00000000' });
  });
});

describe('execution evidence and coverage', () => {
  it('a successful empty window concludes; incomplete empty evidence does not', () => {
    const same = [opening(['BTC', '0.5']), closing(['BTC', '0.5'])] as const;
    expect(reconcile(...same, retrieve(page([]))).status).toBe('CONSISTENT');

    // No continuation and no records, but the pair never reached a successful terminal page.
    const failedEmpty = retrieve(
      page([], { failures: [{ symbol: 'BTCUSDT', error: 'rate_limited', retryAfterSeconds: 60 }] }),
    );
    expect(failedEmpty.continuation).toBeNull();
    expect(reconcile(...same, failedEmpty)).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'pair_failed', items: ['rate_limited'] }],
    });
  });

  it('a page never loaded leaves the pair incomplete', () => {
    const evidence = retrieve(page([fill('9001', 'buy', '0.1')], { continuation: 'cursor' }));
    expect(reasonCodes(reconcile(opening(), closing(['BTC', '0.1']), evidence))).toEqual([
      'pair_incomplete',
    ]);
  });

  it('no continuation without explicit terminal success is not completion', () => {
    const evidence = retrieve(page([], { completedSymbols: [] }));
    expect(evidence.continuation).toBeNull();
    expect(reasonCodes(reconcile(opening(), closing(), evidence))).toEqual(['pair_incomplete']);
  });

  it('an earlier pair failure survives a later page that reports no failure', () => {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const evidence = retrieve(
      page([], {
        symbols,
        failures: [{ symbol: 'BTCUSDT', error: 'malformed_response' }],
        continuation: 'cursor',
        completedSymbols: [],
      }),
      page([], { symbols, completedSymbols: ['ETHUSDT'] }),
    );
    expect(reasonCodes(reconcile(opening(), closing(), evidence))).toEqual(['pair_failed']);
  });

  it('a failed continuation stays recorded after a successful retry', () => {
    const evidence = retrieve(
      page([fill('9101', 'buy', '0.1')], { continuation: 'cursor' }),
      { state: 'error', error: 'timeout' },
      page([fill('9102', 'buy', '0.2')]),
    );
    expect(evidence.completedSymbols).toEqual(['BTCUSDT']);
    expect(reconcile(opening(), closing(['BTC', '0.3']), evidence)).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'continuation_failed', items: ['timeout'] }],
    });
  });

  it('a fresh retrieval starts a new evidence state, earlier failures included', () => {
    const failed = page([], { failures: [{ symbol: 'BTCUSDT', error: 'timeout' }] });
    const fresh = nextExecutionEvidence(retrieve(failed), page([fill('9201', 'buy', '1')]), false);
    if (fresh === null) throw new Error('expected evidence');
    expect(fresh.partialFailures).toEqual([]);
    expect(reconcile(opening(), closing(['BTC', '1']), fresh).status).toBe('CONSISTENT');
  });

  it('requires the subject pair in the selection', () => {
    const evidence = retrieve(page([], { symbols: ['ETHUSDT'] }));
    expect(reasonCodes(reconcile(opening(), closing(), evidence))).toEqual(['pair_not_selected']);
  });

  it('a fill on another pair that pays its fee in the subject blocks the conclusion', () => {
    const evidence = retrieve(
      page([fill('9301', 'buy', '1', ['0.0001', 'BTC'], { symbol: 'ETHUSDT' })], {
        symbols: ['BTCUSDT', 'ETHUSDT'],
      }),
    );
    expect(reconcile(opening(), closing(), evidence)).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'subject_fee_on_other_pair', items: ['ETHUSDT:9301'] }],
    });
  });

  it.each([
    ['an invalid quantity', { quantity: '1e-8' }],
    ['a negative commission', { commission: '-0.1' }],
    ['a time before the declared window', { time: WINDOW.startTime - 1 }],
    ['a time after the declared window', { time: WINDOW.endTime + 1 }],
    ['a pair outside the declared selection', { symbol: 'ETHUSDT' }],
    ['a non-integer trade ID', { tradeId: '12.5' }],
  ])('rejects evidence holding %s', (_, overrides) => {
    const evidence = retrieve(page([]));
    const bad = { ...fill('9401', 'buy', '0.1'), ...overrides };
    const result = reconcile(opening(), closing(), { ...evidence, executions: [bad] });
    expect(result.status).toBe('INDETERMINATE');
    expect(reasonCodes(result)).toContain('execution_evidence_invalid');
  });

  it('rejects a hand-made record that lists one identity twice', () => {
    const one = fill('9501', 'buy', '0.1');
    const evidence = { ...retrieve(page([])), executions: [one, one] };
    expect(reconcile(opening(), closing(['BTC', '0.2']), evidence)).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'execution_evidence_invalid', items: ['duplicate_identity'] }],
    });
  });
});

describe('balance reads and windows', () => {
  const evidence = retrieve(page([]));

  it.each([
    [{ state: 'error', error: 'timeout' } as const, 'timeout'],
    [{ state: 'not_configured' } as const, 'not_configured'],
    [{ state: 'unavailable' } as const, 'unavailable'],
  ])('a failed opening or closing read is indeterminate (%o)', (read, item) => {
    const failed = { accountContext: OWNER, read };
    expect(reconcile(failed, closing(), evidence)).toMatchObject({
      reasons: [{ code: 'opening_unavailable', items: [item] }],
    });
    expect(reconcile(opening(), failed, evidence)).toMatchObject({
      reasons: [{ code: 'closing_unavailable', items: [item] }],
    });
  });

  it('an absent asset is zero only in a valid successful read', () => {
    expect(reconcile(opening(['ETH', '1']), closing(), evidence)).toMatchObject({
      status: 'CONSISTENT',
      opening: '0',
      closing: '0',
    });
    // A repeated asset invalidates the read, so BTC's absence proves nothing.
    expect(
      reasonCodes(reconcile(opening(['ETH', '1'], ['ETH', '1']), closing(), evidence)),
    ).toEqual(['opening_invalid']);
  });

  it.each([
    ['an exponent', ['BTC', '1e-8']],
    ['a sign', ['BTC', '-0.1']],
    ['a bare point', ['BTC', '.5']],
    ['an invalid locked amount', ['BTC', '1', '1,000']],
    ['an empty asset', ['', '1']],
  ] satisfies [string, Row][])('rejects a balance with %s', (_, row) => {
    expect(reasonCodes(reconcile(opening(), closing(row), evidence))).toEqual(['closing_invalid']);
  });

  it('rejects a read time that cannot be parsed', () => {
    const bad = {
      accountContext: OWNER,
      read: { state: 'connected' as const, readAt: 'later', balances: [] },
    };
    expect(reasonCodes(reconcile(bad, closing(), evidence))).toEqual(['opening_invalid']);
  });

  it('requires one account context across both reads and the executions', () => {
    const other = observed(C, [], 'another-owner');
    expect(reasonCodes(reconcile(opening(), other, evidence))).toEqual([
      'account_context_mismatch',
    ]);
    const executions = { accountContext: 'another-owner', evidence };
    expect(
      reasonCodes(reconcileSpotQuantity({ ...input(opening(), closing(), evidence), executions })),
    ).toEqual(['account_context_mismatch']);
    const blank = (at: number) => observed(at, [], '');
    expect(
      reasonCodes(
        reconcileSpotQuantity({
          subject: 'BTC',
          opening: blank(O),
          closing: blank(C),
          executions: { accountContext: '', evidence },
        }),
      ),
    ).toEqual(['account_context_mismatch']);
  });

  it('requires the closing read after the opening read', () => {
    const swapped = reconcile(observed(C, []), observed(O, []), evidence);
    expect(reasonCodes(swapped)).toContain('balance_order_invalid');
    expect(reasonCodes(reconcile(observed(O, []), observed(O, []), evidence))).toContain(
      'balance_order_invalid',
    );
  });

  it('allows at most 24 hours minus both guards between the reads', () => {
    const longest = O + MAX_BALANCE_INTERVAL_MS;
    const window = { startTime: O - G, endTime: longest + G };
    const fits = retrieve(page([], { window, retrievedAt: new Date(longest + G).toISOString() }));
    expect(reconcile(opening(), observed(longest, []), fits).status).toBe('CONSISTENT');
    expect(reasonCodes(reconcile(opening(), observed(longest + 1, []), fits))).toContain(
      'balance_interval_too_long',
    );
  });

  it('requires the execution window to cover both guards', () => {
    const late = retrieve(page([], { window: { startTime: O - G + 1, endTime: C + G } }));
    const early = retrieve(page([], { window: { startTime: O - G, endTime: C + G - 1 } }));
    for (const short of [late, early]) {
      expect(reasonCodes(reconcile(opening(), closing(), short))).toEqual([
        'execution_window_not_covering',
      ]);
    }
  });

  it('requires the first execution page to be read after C + g, not just the latest one', () => {
    const tooEarly = new Date(C + G - 1).toISOString();
    expect(
      reasonCodes(reconcile(opening(), closing(), retrieve(page([], { retrievedAt: tooEarly })))),
    ).toEqual(['executions_read_too_early']);
    const evidence2 = retrieve(
      page([], { retrievedAt: tooEarly, continuation: 'cursor' }),
      page([], { retrievedAt: READ_AT }),
    );
    expect(evidence2.retrievedAt).toBe(READ_AT);
    expect(reasonCodes(reconcile(opening(), closing(), evidence2))).toEqual([
      'executions_read_too_early',
    ]);
  });

  it('rejects an execution window longer than 24 hours', () => {
    const wide = retrieve(
      page([], { window: { startTime: C + G - 24 * HOUR - 1, endTime: C + G } }),
    );
    expect(reconcile(opening(), closing(), wide)).toMatchObject({
      reasons: [{ code: 'execution_evidence_invalid', items: ['window'] }],
    });
  });

  it.each([['USDT'], ['BNB'], ['PEPE'], ['btc']])('refuses %s as the subject', (subject) => {
    expect(reasonCodes(reconcile(opening(), closing(), evidence, subject))).toContain(
      'unsupported_subject',
    );
  });

  it('lists every reason it finds, not only the first', () => {
    const result = reconcileSpotQuantity({
      subject: 'BNB',
      opening: { accountContext: OWNER, read: { state: 'error', error: 'timeout' } },
      closing: observed(C, [['BTC', 'x']], 'another-owner'),
      executions: { accountContext: OWNER, evidence: retrieve(page([], { symbols: ['ETHUSDT'] })) },
    });
    expect(reasonCodes(result)).toEqual([
      'unsupported_subject',
      'opening_unavailable',
      'closing_invalid',
      'account_context_mismatch',
      'pair_not_selected',
    ]);
  });
});

describe('boundary guard (provisional 60 s policy)', () => {
  // A wider selection, so fills beyond the guard bands can be present at all.
  const window = { startTime: O - 2 * G, endTime: C + 2 * G };
  const at = (time: number) =>
    retrieve(page([fill('9601', 'buy', '0.1', ['0', 'USDT'], { time })], { window }));
  const run = (time: number, closingBtc = '0.1') =>
    reconcile(opening(), closing(['BTC', closingBtc]), at(time));

  it.each([
    ['the outer guard band before O', O - G],
    ['just before O', O - 1],
    ['exactly O', O],
    ['exactly O + g', O + G],
    ['exactly C − g', C - G],
    ['exactly C', C],
    ['just after C', C + 1],
    ['the outer guard band after C', C + G],
  ])('a fill at %s is near a read and never summed', (_, time) => {
    const result = run(time);
    expect(result).toMatchObject({
      status: 'INDETERMINATE',
      reasons: [{ code: 'fill_near_boundary', items: ['9601'] }],
    });
    expect(result).not.toHaveProperty('movement');
  });

  it('counts a fill one millisecond inside either guard', () => {
    expect(run(O + G + 1).status).toBe('CONSISTENT');
    expect(run(C - G - 1).status).toBe('CONSISTENT');
  });

  it('ignores fills beyond both guard bands: the reads already hold or cannot hold them', () => {
    expect(run(O - G - 1, '0')).toMatchObject({ status: 'CONSISTENT', countedTradeIds: [] });
    expect(run(C + G + 1, '0')).toMatchObject({ status: 'CONSISTENT', countedTradeIds: [] });
  });

  it('two reads closer than 2g leave no interval where a fill can be counted', () => {
    const close = observed(O + G, [['BTC', '0.1']]);
    const evidence = retrieve(
      page([fill('9701', 'buy', '0.1', ['0', 'USDT'], { time: O + G / 2 })], {
        window: { startTime: O - G, endTime: O + 2 * G },
      }),
    );
    expect(reasonCodes(reconcile(opening(), close, evidence))).toEqual(['fill_near_boundary']);
  });
});

describe('purity', () => {
  afterEach(() => vi.restoreAllMocks());

  function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  }

  const fills = [
    fill('1001', 'buy', '0.50000000', ['0.05000000', 'USDT']),
    fill('1002', 'sell', '0.20000000', ['0.00010000', 'BTC']),
    fill('1003', 'buy', '0.01', ['0.001', 'BNB'], { time: MID + 1001 }),
  ];

  it('is deterministic and independent of record order', () => {
    const forward = input(opening(), closing(['BTC', '0.3099']), retrieve(page(fills)));
    const reverse = input(
      opening(),
      closing(['BTC', '0.3099']),
      retrieve(page([...fills].reverse())),
    );
    const first = reconcileSpotQuantity(forward);
    expect(first).toMatchObject({
      status: 'CONSISTENT',
      countedTradeIds: ['1001', '1003', '1002'],
    });
    expect(reconcileSpotQuantity(forward)).toEqual(first);
    expect(reconcileSpotQuantity(reverse)).toEqual(first);
  });

  it('never mutates its input', () => {
    const frozen = deepFreeze(input(opening(), closing(['BTC', '0.3099']), retrieve(page(fills))));
    const before = JSON.stringify(frozen);
    expect(() => reconcileSpotQuantity(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it('makes no network or storage call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    reconcileSpotQuantity(input(opening(), closing(['BTC', '0.3099']), retrieve(page(fills))));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it('imports only pure modules at runtime and nothing from ledgers or storage', () => {
    for (const file of ['src/lib/binanceSpotReconciliation.ts', 'src/lib/binanceSpotEvidence.ts']) {
      const source = readFileSync(file, 'utf8');
      const runtime = [...source.matchAll(/^import (?!type )[\s\S]*?from '([^']+)'/gm)].map(
        (match) => match[1],
      );
      for (const path of runtime) {
        expect(['@/lib/binanceSpotEvidence', '@/lib/spotScenario']).toContain(path);
      }
      expect(source).not.toMatch(
        /portfolio|ledger|supabaseClient|fetch\(|localStorage|sessionStorage|indexedDB|Date\.now/,
      );
    }
  });
});
