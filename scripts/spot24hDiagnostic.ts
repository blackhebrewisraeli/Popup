/**
 * Diagnostics of protocol v1's recorded run (docs/SPOT_24H_V1_DIAGNOSTIC.md). Pure functions over
 * observations rebuilt by the run commit's own code: where the gross return goes, which outcomes
 * carry the mean, and how each fixed indicator cell compares with the base rate. Nothing here
 * fits, tunes, selects or ranks; every rule and level is protocol v1's.
 */
import {
  CATEGORIES,
  CELLS,
  PROTOCOL,
  quantile,
  type Category,
  type Protocol,
  type ScenarioFit,
} from './spot24h';

export interface DiagnosticRow {
  symbol: string;
  time: number;
  day: number;
  cell: string;
  v: number;
  /** Open of the candle opening at the decision time. */
  entry: number;
  /** Close of the 24th forward candle: the same entry held for the whole horizon (context only). */
  holdClose: number;
  /** One per protocol scenario: the fill v1 resolved and v1's net return for it. */
  outcomes: { category: Category; exit: number; net: number }[];
}

/**
 * costs.netReturn split in trade order: buy at the slipped price, pay the fee in the asset, sell
 * at the slipped price, pay the fee on the proceeds. Each component is the change it makes to the
 * return, so gross + the four components telescope exactly to net.
 */
export function decompose(
  entry: number,
  exit: number,
  category: Category,
  protocol: Protocol = PROTOCOL,
) {
  const { feePerFill: fee, slippagePerMarketFill: slip } = protocol.costs;
  const exitSlip = category === 'TARGET' ? 0 : slip;
  const r0 = exit / entry;
  const r1 = r0 / (1 + slip);
  const r2 = r1 * (1 - fee);
  const r3 = r2 * (1 - exitSlip);
  const r4 = r3 * (1 - fee);
  return {
    gross: r0 - 1,
    entrySlippage: r1 - r0,
    entryFee: r2 - r1,
    exitSlippage: r3 - r2,
    exitFee: r4 - r3,
    net: r4 - 1,
  };
}

const PARTS = ['gross', 'entrySlippage', 'entryFee', 'exitSlippage', 'exitFee', 'net'] as const;
type Part = (typeof PARTS)[number];

/**
 * Mean of each component for one scenario. `recordedNet` is the mean of v1's own net returns, and
 * `residual` is recordedNet − (gross + fees + slippage): the arithmetic reconciliation.
 */
export function returnDecomposition(
  rows: readonly DiagnosticRow[],
  s: number,
  protocol: Protocol = PROTOCOL,
) {
  const sums = Object.fromEntries(PARTS.map((p) => [p, 0])) as Record<Part, number>;
  let recorded = 0;
  let maxRowResidual = 0;
  for (const row of rows) {
    const { category, exit, net } = row.outcomes[s]!;
    const d = decompose(row.entry, exit, category, protocol);
    for (const p of PARTS) sums[p] += d[p];
    recorded += net;
    const rebuilt = d.gross + d.entrySlippage + d.entryFee + d.exitSlippage + d.exitFee;
    maxRowResidual = Math.max(maxRowResidual, Math.abs(rebuilt - net));
  }
  const n = rows.length;
  const mean = (x: number) => (n ? x / n : null);
  const fees = mean(sums.entryFee + sums.exitFee);
  const slippage = mean(sums.entrySlippage + sums.exitSlippage);
  const gross = mean(sums.gross);
  const recordedNet = mean(recorded);
  return {
    observations: n,
    gross,
    entryFee: mean(sums.entryFee),
    exitFee: mean(sums.exitFee),
    entrySlippage: mean(sums.entrySlippage),
    exitSlippage: mean(sums.exitSlippage),
    fees,
    slippage,
    net: mean(sums.net),
    recordedNet,
    residual:
      recordedNet === null || gross === null || fees === null || slippage === null
        ? null
        : recordedNet - (gross + fees + slippage),
    maxRowResidual,
  };
}

/**
 * Each outcome's count, share, mean returns and contribution to the scenario's mean return.
 * `afterExit` is the move from the exit fill to the 24th close, per unit of entry: the
 * contributions add up to (same entries held to the 24th close) − (mean gross). Context only;
 * holding is not an evaluated rule.
 */
export function outcomeAttribution(
  rows: readonly DiagnosticRow[],
  s: number,
  protocol: Protocol = PROTOCOL,
) {
  const n = rows.length;
  const by = Object.fromEntries(
    CATEGORIES.map((c) => [c, { count: 0, gross: 0, net: 0, after: 0 }]),
  );
  let gross = 0;
  let net = 0;
  let hold = 0;
  for (const row of rows) {
    const outcome = row.outcomes[s]!;
    const g = decompose(row.entry, outcome.exit, outcome.category, protocol).gross;
    const cell = by[outcome.category]!;
    cell.count += 1;
    cell.gross += g;
    cell.net += outcome.net;
    cell.after += (row.holdClose - outcome.exit) / row.entry;
    gross += g;
    net += outcome.net;
    hold += row.holdClose / row.entry - 1;
  }
  return {
    observations: n,
    meanGross: n ? gross / n : null,
    meanNet: n ? net / n : null,
    meanHoldGross: n ? hold / n : null,
    categories: CATEGORIES.map((category) => {
      const c = by[category]!;
      return {
        category,
        count: c.count,
        share: n ? c.count / n : null,
        meanGross: c.count ? c.gross / c.count : null,
        meanNet: c.count ? c.net / c.count : null,
        /** share × category mean: these add up to the scenario's mean. */
        contributionGross: n ? c.gross / n : null,
        contributionNet: n ? c.net / n : null,
        meanAfterExit: c.count ? c.after / c.count : null,
        contributionAfterExit: n ? c.after / n : null,
      };
    }),
  };
}

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
export const quantiles = (values: readonly number[]) =>
  values.length ? LEVELS.map((q) => quantile(values, q)) : null;

/**
 * The original level distances against the assumed costs, for one scenario. Cost shares are of a
 * fill exactly at the level; the break-even is the TARGET share, among trades decided at a level,
 * at which net returns of a target and a stop fill cancel. Describes v1's levels; searches nothing.
 */
export function levelDistances(
  rows: readonly DiagnosticRow[],
  s: number,
  protocol: Protocol = PROTOCOL,
) {
  const { targetV, stopV } = protocol.scenarios[s]!;
  const target: number[] = [];
  const stop: number[] = [];
  const targetCostShare: number[] = [];
  const stopCostShare: number[] = [];
  const breakEvenNet: number[] = [];
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const row of rows) {
    const atTarget = decompose(1, 1 + targetV * row.v, 'TARGET', protocol);
    const atStop = decompose(1, 1 - stopV * row.v, 'STOP', protocol);
    target.push(atTarget.gross);
    stop.push(-atStop.gross);
    targetCostShare.push((atTarget.gross - atTarget.net) / atTarget.gross);
    stopCostShare.push((atStop.gross - atStop.net) / -atStop.gross);
    breakEvenNet.push(-atStop.net / (atTarget.net - atStop.net));
    counts[row.outcomes[s]!.category] += 1;
  }
  const decided = counts.TARGET + counts.STOP + counts.AMBIGUOUS;
  return {
    targetDistance: quantiles(target),
    stopDistance: quantiles(stop),
    targetCostShare: quantiles(targetCostShare),
    stopCostShare: quantiles(stopCostShare),
    breakEvenGross: stopV / (targetV + stopV),
    breakEvenNet: quantiles(breakEvenNet),
    decidedTargetShare: decided ? counts.TARGET / decided : null,
  };
}

/** Scores of one fit on rows, grouped by `keyOf`; group contributions add up to the totals. */
export function groupQuality(
  fit: ScenarioFit,
  rows: readonly DiagnosticRow[],
  s: number,
  keyOf: (row: DiagnosticRow) => string,
  protocol: Protocol = PROTOCOL,
) {
  const groups = new Map<
    string,
    { n: number; evaluated: number; wins: number; gross: number; net: number; diff: number }
  >();
  let grossSum = 0;
  let grossSquares = 0;
  let winSum = 0;
  const base = fit.base.p;
  let evaluated = 0;
  let wins = 0;
  let predicted = 0;
  let methodSum = 0;
  let baseSum = 0;
  for (const row of rows) {
    const outcome = row.outcomes[s]!;
    const key = keyOf(row);
    const g = groups.get(key) ?? { n: 0, evaluated: 0, wins: 0, gross: 0, net: 0, diff: 0 };
    groups.set(key, g);
    const y = outcome.category === 'TARGET' ? 1 : 0;
    const gross = decompose(row.entry, outcome.exit, outcome.category, protocol).gross;
    g.n += 1;
    g.wins += y;
    g.gross += gross;
    g.net += outcome.net;
    grossSum += gross;
    grossSquares += gross ** 2;
    winSum += y;
    const p = fit.cells[row.cell]?.p ?? null;
    // metrics.brier: only observations whose cell has a probability are scored.
    if (p === null || base === null) continue;
    const method = (p - y) ** 2;
    const benchmark = (base - y) ** 2;
    g.evaluated += 1;
    g.diff += method - benchmark;
    evaluated += 1;
    wins += y;
    predicted += p;
    methodSum += method;
    baseSum += benchmark;
  }
  const method = evaluated ? methodSum / evaluated : null;
  const benchmark = evaluated ? baseSum / evaluated : null;
  const n = rows.length;
  const parts = [...groups.values()];
  // Between-group sum of squares ÷ total: the share of the outcome's variance the grouping
  // describes in-sample. With no structure it averages (groups − 1) ÷ (n − 1).
  const share = (sum: number, squares: number, of: (g: (typeof parts)[number]) => number) => {
    const total = squares - sum ** 2 / n;
    return total > 0
      ? (parts.reduce((a, g) => a + of(g) ** 2 / g.n, 0) - sum ** 2 / n) / total
      : null;
  };
  return {
    varianceShare: {
      target: n ? share(winSum, winSum, (g) => g.wins) : null,
      gross: n ? share(grossSum, grossSquares, (g) => g.gross) : null,
      noStructure: n > 1 ? (parts.length - 1) / (n - 1) : null,
    },
    totals: {
      observations: rows.length,
      evaluated,
      baseRate: base,
      observedRate: evaluated ? wins / evaluated : null,
      brierMethod: method,
      brierBase: benchmark,
      deltaBrier: method === null || benchmark === null ? null : method - benchmark,
      skillScore: method === null || !benchmark ? null : 1 - method / benchmark,
      inTheLarge: evaluated ? Math.abs(predicted / evaluated - wins / evaluated) : null,
    },
    groups: [...groups.entries()]
      .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
      .map(([key, g]) => ({
        key,
        observations: g.n,
        evaluated: g.evaluated,
        targetRate: g.wins / g.n,
        meanGross: g.gross / g.n,
        meanNet: g.net / g.n,
        deltaBrier: g.evaluated ? g.diff / g.evaluated : null,
        /** The group's share of the total ΔBrier: Σ over the group ÷ all scored observations. */
        deltaBrierContribution: evaluated ? g.diff / evaluated : null,
      })),
  };
}

/** The six fixed cells against the fit's base rate, with the protocol's calibration measures. */
export function cellQuality(
  fit: ScenarioFit,
  rows: readonly DiagnosticRow[],
  s: number,
  protocol: Protocol = PROTOCOL,
) {
  const { varianceShare, totals, groups } = groupQuality(fit, rows, s, (row) => row.cell, protocol);
  const cells = CELLS.map((cell) => {
    const g = groups.find((group) => group.key === cell);
    const predicted = fit.cells[cell]?.p ?? null;
    return {
      cell,
      observations: g?.observations ?? 0,
      share: g && rows.length ? g.observations / rows.length : 0,
      predicted,
      observed: g ? g.targetRate : null,
      observedMinusBase: g && totals.baseRate !== null ? g.targetRate - totals.baseRate : null,
      absError: g && predicted !== null ? Math.abs(predicted - g.targetRate) : null,
      deltaBrier: g?.deltaBrier ?? null,
      deltaBrierContribution: g?.deltaBrierContribution ?? null,
      meanGross: g?.meanGross ?? null,
      meanNet: g?.meanNet ?? null,
    };
  });
  const weighted = cells.reduce(
    (sum, c) => (c.absError === null ? sum : sum + c.observations * c.absError),
    0,
  );
  return {
    ...totals,
    weightedCellError: totals.evaluated ? weighted / totals.evaluated : null,
    varianceShare,
    cells,
  };
}

export const pairOf = (row: DiagnosticRow) => row.symbol;
/** UTC calendar month of the decision: contiguous periods, partial at each split's ends. */
export const monthOf = (row: DiagnosticRow) => new Date(row.time).toISOString().slice(0, 7);
