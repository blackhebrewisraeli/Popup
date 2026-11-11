/**
 * What changed between two TradingView development scans: the displayed one
 * and one earlier snapshot, chosen by `tradingview-finish` or named by the
 * owner (`npm run evaluate -- tradingview-baseline SCAN_ID`). Pure: it reads only what both scans
 * recorded. Nothing is re-scored, and no rule, threshold or ranking is defined
 * here.
 *
 * Each scan rests on one evaluated US equity session. A setup that "appeared"
 * holds on the later reading and did not on the earlier one, nothing more:
 * across sessions that were never evaluated it could have turned on any of
 * them, so a change here is never a timed transition or an alert.
 */
import type { CanonicalScore, ModelSetups } from '@/lib/canonicalModel';
import {
  compareTickers,
  type MarketScan,
  type ScanAssetResult,
  type ScanStatus,
} from '@/lib/marketScanner';
import type { TickerKind } from '@/lib/ticker';
import { tradingSessions } from '@/lib/usEquityDaily';

/** One setup across the two readings. */
export type SetupChange = 'APPEARED' | 'CLEARED' | 'HELD' | 'NONE';

/** An asset evaluated in both scans. */
export interface AssetChange {
  ticker: string;
  long: SetupChange;
  risk: SetupChange;
  score: { before: number; after: number };
  /** The New York session each reading rests on. Equal sessions make the pair a revision. */
  sessions: { before: string; after: string };
}

export interface ScanSide {
  scanId: string;
  /**
   * The latest session any asset was evaluated on: a New York session for equities, a UTC
   * day for crypto. Null when none was.
   */
  session: string | null;
  status: ScanStatus;
  evaluated: number;
  supported: number;
  /** Set for a crypto scan: its `session` is a UTC day. */
  utcDays?: true;
}

export type SessionGap =
  /** The same session scored twice: every difference is a revision of its data. */
  | { kind: 'SAME' }
  | { kind: 'NEXT' }
  /** Sessions between the two that neither scan evaluated. */
  | { kind: 'GAP'; skipped: readonly string[] }
  /** One scan evaluated nothing, so there is no session pair. */
  | { kind: 'NONE' };

/** A recorded attribute the two scans do not share. */
export interface Difference {
  field: string;
  before: string;
  after: string;
}

export type ScanComparison =
  | { status: 'NO_BASELINE' }
  | {
      status: 'INCOMPATIBLE';
      before: ScanSide;
      after: ScanSide;
      differences: readonly Difference[];
    }
  | {
      status: 'COMPARED';
      before: ScanSide;
      after: ScanSide;
      gap: SessionGap;
      /** Evaluated in both, in ticker order. */
      changes: readonly AssetChange[];
      /** Evaluated now only: there is no earlier reading, so nothing "appeared". */
      onlyAfter: readonly string[];
      /** Evaluated earlier only: their earlier setups are neither confirmed nor cleared. */
      onlyBefore: readonly string[];
      neither: readonly string[];
    };

export interface NamedScan {
  scanId: string;
  scan: MarketScan;
}

const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** The day a close belongs to: its New York session for equities, its UTC day for crypto. */
function sessionOf(time: number | null, assetClass: TickerKind = 'equity'): string | null {
  if (time === null) return null;
  return assetClass === 'crypto'
    ? new Date(time).toISOString().slice(0, 10)
    : NEW_YORK_DATE.format(time);
}

/** The latest session (UTC day, for crypto) any asset was evaluated on; null when none was. */
export function latestSession(scan: MarketScan): string | null {
  const days = scan.cohorts.flatMap(({ assetClass, dataAsOf }) =>
    dataAsOf.newest === null ? [] : [sessionOf(dataAsOf.newest, assetClass)!],
  );
  return days.length > 0 ? days.sort().at(-1)! : null;
}

/** Every crypto scan rests on UTC days; anything else on New York sessions. */
function onUtcDays(scan: MarketScan): boolean {
  return scan.cohorts.length > 0 && scan.cohorts.every(({ assetClass }) => assetClass === 'crypto');
}

function side({ scanId, scan }: NamedScan): ScanSide {
  return {
    scanId,
    session: latestSession(scan),
    status: scan.status,
    evaluated: scan.coverage.evaluated,
    supported: scan.coverage.supported,
    ...(onUtcDays(scan) && { utcDays: true as const }),
  };
}

/** What makes two readings of one ticker the same measurement; any difference makes them incomparable. */
const ATTRIBUTION: ReadonlyArray<[string, (scan: MarketScan) => string]> = [
  ['Asset class', (scan) => scan.cohorts.map((cohort) => cohort.assetClass).join(' · ')],
  [
    'Source',
    (scan) =>
      [scan.universe.source, ...scan.cohorts.map((cohort) => cohort.provider ?? 'none')].join(
        ' · ',
      ),
  ],
  ['Timeframe', (scan) => scan.timeframe],
  ['Scanner', (scan) => scan.scannerVersion],
  ['Model', (scan) => scan.modelVersion],
  [
    'Candle policy',
    (scan) =>
      scan.cohorts
        .map((cohort) =>
          [
            cohort.candlePolicyVersion ?? 'none',
            cohort.calendar,
            `${cohort.minClosedCandles} closed`,
            cohort.freshness,
          ].join(' · '),
        )
        .join('; '),
  ],
];

/**
 * The exact provider symbol a result rests on: the one requested, once the provider's
 * response confirmed it. Null when the scan did not record one (snapshots from before
 * it was kept) or the response did not confirm it: the reading's identity is unknown.
 */
export function exactSymbol(result: ScanAssetResult): string | null {
  const recorded = result.providerSymbol;
  return recorded && recorded.validated === recorded.requested ? recorded.requested : null;
}

/**
 * Two readings of a ticker are one measurement only on the same exact symbol. A
 * different requested symbol is another listing; an asset evaluated in both without a
 * confirmed symbol on each side cannot be shown to be the same one. Either way nothing
 * is compared: a changed listing must never read as a setup that appeared or cleared.
 */
function symbolDifferences(before: MarketScan, after: MarketScan): Difference[] {
  const earlier = new Map(before.results.map((result) => [result.ticker, result]));
  const pairs = after.results.flatMap((now) => {
    const prior = earlier.get(now.ticker);
    return prior ? [{ prior, now }] : [];
  });
  const found: Difference[] = [];
  const moved = pairs.filter(({ prior, now }) => {
    const [was, is] = [prior.providerSymbol?.requested, now.providerSymbol?.requested];
    return was !== undefined && is !== undefined && was !== is;
  });
  if (moved.length > 0) {
    const list = (side: 'prior' | 'now') =>
      moved.map((pair) => `${pair.now.ticker} ${pair[side].providerSymbol?.requested}`).join(', ');
    found.push({ field: 'TradingView symbol', before: list('prior'), after: list('now') });
  }
  const both = pairs.filter(
    (pair) => !moved.includes(pair) && evaluated(pair.prior) && evaluated(pair.now),
  );
  const unknown = (side: 'prior' | 'now') =>
    both.filter((pair) => exactSymbol(pair[side]) === null).map((pair) => pair.now.ticker);
  const [was, is] = [unknown('prior'), unknown('now')];
  if (was.length > 0 || is.length > 0) {
    const evidence = (tickers: string[]) => {
      if (tickers.length === 0) return 'Recorded and confirmed';
      const which =
        tickers.length === both.length
          ? `any of the ${both.length} evaluated in both`
          : tickers.join(', ');
      return `Not recorded or not confirmed for ${which}`;
    };
    found.push({ field: 'Exact symbol', before: evidence(was), after: evidence(is) });
  }
  return found;
}

function differences(before: MarketScan, after: MarketScan): Difference[] {
  const found = ATTRIBUTION.flatMap(([field, value]) =>
    value(before) === value(after) ? [] : [{ field, before: value(before), after: value(after) }],
  );
  found.push(...symbolDifferences(before, after));
  const was = new Map(before.results.map((result) => [result.ticker, result.instrument]));
  const is = new Map(after.results.map((result) => [result.ticker, result.instrument]));
  const added = [...is.keys()].filter((ticker) => !was.has(ticker));
  const removed = [...was.keys()].filter((ticker) => !is.has(ticker));
  if (added.length > 0 || removed.length > 0) {
    found.push({
      field: 'Universe',
      before: `${was.size} tickers, ${removed.length} not in the displayed scan`,
      after: `${is.size} tickers, ${added.length} not in the baseline`,
    });
  }
  const moved = [...is.keys()].filter(
    (ticker) => was.has(ticker) && was.get(ticker) !== is.get(ticker),
  );
  if (moved.length > 0) {
    const list = (map: Map<string, string | null>) =>
      moved.map((ticker) => `${ticker} ${map.get(ticker) ?? 'none'}`).join(', ');
    found.push({ field: 'Instrument', before: list(was), after: list(is) });
  }
  if (before.evaluationTime >= after.evaluationTime) {
    const iso = (time: number) => new Date(time).toISOString();
    found.push({
      field: 'Evaluated',
      before: iso(before.evaluationTime),
      after: `${iso(after.evaluationTime)}, not later than the baseline`,
    });
  }
  return found;
}

/** Every UTC day from `from` to `to`, both included. */
function utcDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let day = Date.parse(`${from}T00:00:00Z`);
    day <= Date.parse(`${to}T00:00:00Z`);
    day += 86_400_000
  ) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}

function gapBetween(before: string | null, after: string | null, utc: boolean): SessionGap {
  if (before === null || after === null) return { kind: 'NONE' };
  if (before === after) return { kind: 'SAME' };
  const skipped = (utc ? utcDays(before, after) : tradingSessions(before, after)).slice(1, -1);
  return skipped.length === 0 ? { kind: 'NEXT' } : { kind: 'GAP', skipped };
}

function setupChange(before: boolean, after: boolean): SetupChange {
  if (before && after) return 'HELD';
  if (after) return 'APPEARED';
  return before ? 'CLEARED' : 'NONE';
}

type Evaluated = ScanAssetResult & { model: CanonicalScore; setups: ModelSetups };

function evaluated(result: ScanAssetResult | undefined): result is Evaluated {
  return result?.status === 'EVALUATED' && result.model !== null && result.setups !== null;
}

/**
 * The displayed scan against its named baseline. Incomparable scans report
 * every attribute they differ in and nothing else; comparable ones split the
 * universe into assets evaluated in both, in one only, or in neither.
 */
export function compareScans(after: NamedScan, before: NamedScan | undefined): ScanComparison {
  if (!before) return { status: 'NO_BASELINE' };
  const sides = { before: side(before), after: side(after) };
  const found = differences(before.scan, after.scan);
  if (sides.before.session && sides.after.session && sides.after.session < sides.before.session) {
    found.push({
      field: 'Evaluated session',
      before: sides.before.session,
      after: `${sides.after.session}, earlier than the baseline's`,
    });
  }
  if (found.length > 0) return { status: 'INCOMPATIBLE', ...sides, differences: found };

  const earlier = new Map(before.scan.results.map((result) => [result.ticker, result]));
  const changes: AssetChange[] = [];
  const onlyAfter: string[] = [];
  const onlyBefore: string[] = [];
  const neither: string[] = [];
  for (const now of [...after.scan.results].sort((a, b) => compareTickers(a.ticker, b.ticker))) {
    const then = earlier.get(now.ticker);
    if (evaluated(then) && evaluated(now)) {
      changes.push({
        ticker: now.ticker,
        long: setupChange(then.setups.long, now.setups.long),
        risk: setupChange(then.setups.risk, now.setups.risk),
        score: { before: then.model.signal_score, after: now.model.signal_score },
        sessions: {
          before: sessionOf(then.dataAsOf, then.assetClass) ?? '',
          after: sessionOf(now.dataAsOf, now.assetClass) ?? '',
        },
      });
    } else if (evaluated(now)) onlyAfter.push(now.ticker);
    else if (evaluated(then)) onlyBefore.push(now.ticker);
    else neither.push(now.ticker);
  }
  return {
    status: 'COMPARED',
    ...sides,
    gap: gapBetween(sides.before.session, sides.after.session, onUtcDays(after.scan)),
    changes,
    onlyAfter,
    onlyBefore,
    neither,
  };
}

/** A Long setup or Risk warning appeared or cleared. */
export function setupMoved(change: AssetChange): boolean {
  return [change.long, change.risk].some((setup) => setup === 'APPEARED' || setup === 'CLEARED');
}

/** How many compared assets a setup appeared, cleared or held for. */
export function setupCounts(
  changes: readonly AssetChange[],
  setup: 'long' | 'risk',
): Record<SetupChange, number> {
  const counts: Record<SetupChange, number> = { APPEARED: 0, CLEARED: 0, HELD: 0, NONE: 0 };
  for (const change of changes) counts[change[setup]] += 1;
  return counts;
}

/** Compared assets whose score rose, fell or stayed: descriptive counts, not a signal. */
export function scoreCounts(changes: readonly AssetChange[]) {
  const moved = changes.map(({ score }) => score.after - score.before);
  return {
    higher: moved.filter((delta) => delta > 0).length,
    lower: moved.filter((delta) => delta < 0).length,
    same: moved.filter((delta) => delta === 0).length,
  };
}
