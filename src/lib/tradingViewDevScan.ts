/**
 * The TradingView development scan as the Markets page shows it: one local,
 * owner-initiated scan whose daily bars the owner's agent session retrieved
 * through TradingView's MCP server (`get_ohlcv`), scored here by the canonical
 * engine (`npm run evaluate -- tradingview-import`, scripts/tradingViewImport.ts).
 *
 * The app never calls TradingView. The Vite dev server alone serves this file
 * from the git-ignored scan store to the local machine
 * (scripts/tradingViewDevRoute.ts, loaded by vite.config.ts); a
 * production build has neither the route nor the file.
 */
import type { MarketScan } from '@/lib/marketScanner';

export const TRADINGVIEW_DEV_SCAN_KIND = 'tradingview-dev-scan' as const;
export const TRADINGVIEW_DEV_PROVIDER_ID = 'tradingview-mcp-get_ohlcv';
export const TRADINGVIEW_DEV_UNIVERSE_SOURCE = 'tradingview-dev-scan';
/** The dev-server route, and the file it serves from `.zerochart-scans/`. */
export const TRADINGVIEW_DEV_SCAN_ROUTE = '/__zerochart/tradingview-dev-scan';
export const TRADINGVIEW_DEV_SCAN_FILE = 'tradingview-dev-scan.json';

/** Where the bars came from, as the agent recorded it. Times are ISO strings. */
export interface TradingViewDevSource {
  tool: 'get_ohlcv';
  interval: '1D';
  retrieval: { startedAt: string; completedAt: string };
  /**
   * Ticker → exact exchange-qualified TradingView symbol requested, as the scan's inputs
   * recorded it. Views written before inputs recorded it hold the instrument map at import
   * time: unverified, and never the evidence (each result's `providerSymbol` is).
   */
  symbols: Readonly<Record<string, string>>;
  /** TradingView's own market-data notice, verbatim (adjustment, session, delay). */
  notice: string;
  /** How the 50 were chosen, before any score was seen. */
  selectionRule: string;
  /** Symbols holding any TradingView alert when the agent checked; null when not checked. */
  pineAlerts: { checkedAt: string; symbols: readonly string[] } | null;
}

export type BaselineChooser = 'tradingview-finish' | 'tradingview-baseline';

/**
 * The earlier snapshot "Changes since previous scan" compares with: a
 * TradingView development import from the same scan store. `tradingview-finish`
 * chooses one; the owner can name another (`npm run evaluate --
 * tradingview-baseline SCAN_ID`). Importing a scan replaces the view and drops it.
 */
export interface TradingViewDevBaseline {
  scanId: string;
  importedAt: string;
  scan: MarketScan;
  /** Absent in files written before `tradingview-finish` chose baselines: the owner named those. */
  chosenBy?: BaselineChooser;
}

/** How `tradingview-finish` looked for a baseline. */
export interface TradingViewDevBaselineSearch {
  /** Why nothing is compared; null when a baseline was chosen. */
  reason: string | null;
  /** Imports passed over before the choice, most recent first, and why. */
  skipped: ReadonlyArray<{ scanId: string; reason: string }>;
}

export interface TradingViewDevScan {
  kind: typeof TRADINGVIEW_DEV_SCAN_KIND;
  scanId: string;
  importedAt: string;
  source: TradingViewDevSource;
  scan: MarketScan;
  baseline?: TradingViewDevBaseline;
  baselineSearch?: TradingViewDevBaselineSearch;
}

function isScan(scan: Partial<MarketScan> | undefined): boolean {
  return Array.isArray(scan?.results) && Array.isArray(scan.cohorts);
}

function isBaseline(baseline: Partial<TradingViewDevBaseline> | undefined): boolean {
  return (
    baseline === undefined ||
    (typeof baseline?.scanId === 'string' &&
      typeof baseline.importedAt === 'string' &&
      isScan(baseline.scan) &&
      [undefined, 'tradingview-finish', 'tradingview-baseline'].includes(baseline.chosenBy))
  );
}

function isSearch(search: Partial<TradingViewDevBaselineSearch> | undefined): boolean {
  return (
    search === undefined ||
    ((search?.reason === null || typeof search?.reason === 'string') &&
      Array.isArray(search.skipped) &&
      search.skipped.every(
        (item) => typeof item?.scanId === 'string' && typeof item.reason === 'string',
      ))
  );
}

/** Shape check at the dev-server boundary: a malformed file is an error, never a partial panel. */
export function parseTradingViewDevScan(raw: unknown): TradingViewDevScan {
  const value = raw as Partial<TradingViewDevScan> | null;
  const source = value?.source;
  if (
    value?.kind !== TRADINGVIEW_DEV_SCAN_KIND ||
    typeof value.scanId !== 'string' ||
    typeof value.importedAt !== 'string' ||
    !source ||
    typeof source.notice !== 'string' ||
    typeof source.symbols !== 'object' ||
    !isScan(value.scan) ||
    !isBaseline(value.baseline) ||
    !isSearch(value.baselineSearch)
  ) {
    throw new Error('Not a TradingView development scan file.');
  }
  return value as TradingViewDevScan;
}
