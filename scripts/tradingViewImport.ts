import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CandleProviderDataError } from '@/lib/binance';
import {
  compareTickers,
  EQUITY_CALENDAR_ERROR,
  equityRequestRange,
  type ScanFetchError,
  type ScanInput,
} from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_SCAN_FILE,
  TRADINGVIEW_DEV_SCAN_KIND,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  parseTradingViewDevScan,
  type BaselineChooser,
  type TradingViewDevBaseline,
  type TradingViewDevBaselineSearch,
  type TradingViewDevScan,
} from '@/lib/tradingViewDevScan';
import {
  latestFinalSession,
  sessionFinalAt,
  sessionOpen,
  tradingSessions,
  US_EQUITY_INSTRUMENTS,
  usEquityInstrument,
  type EquityDailyBar,
  type EquityDailySeries,
} from '@/lib/usEquityDaily';
import {
  compareScans,
  latestSession,
  scoreCounts,
  setupCounts,
  setupMoved,
  type ScanComparison,
} from '@/lib/scanChanges';
import { stableSerialize } from './evaluationStore';
import { loadScan, reproduceScan, saveScan, type ScanSnapshot } from './marketScanStore';

/**
 * The local handoff between the owner's agent session and the scanner. The
 * agent calls TradingView's MCP `get_ohlcv` and writes each response verbatim
 * into one export file (git-ignored `.zerochart-tradingview/`); this module
 * maps it into the us-equity-daily-v1 seam, scores it with the canonical
 * engine and writes an ordinary scan snapshot plus the file the Markets page
 * shows in development. Nothing here calls TradingView.
 */

export const DEV_SCAN_SIZE = 50;
export const SELECTION_RULE =
  'The 50 configured US equities and ETFs (US_EQUITY_INSTRUMENTS, the 90 equity rows of assets_status) with the lowest sha256(ticker) hex digests, fixed before any data was fetched or scored.';

/** Deterministic and blind to outcomes: the digest of the ticker alone orders the universe. */
export function selectDevScanUniverse(
  tickers: readonly string[] = Object.keys(US_EQUITY_INSTRUMENTS),
): string[] {
  const digest = (ticker: string) => createHash('sha256').update(ticker).digest('hex');
  return tickers
    .filter((ticker) => Object.hasOwn(US_EQUITY_INSTRUMENTS, ticker))
    .map((ticker) => [digest(ticker), ticker] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(0, DEV_SCAN_SIZE)
    .map(([, ticker]) => ticker)
    .sort(compareTickers);
}

/**
 * Which configured tickers a retrieval requests. `default` is the 50 above and
 * stays the default; `all` (opt-in) is every configured US equity and ETF.
 * Neither depends on a score or an outcome, and a retrieval freezes its universe
 * and members when it starts.
 */
export type DevScanUniverse = 'default' | 'all';
export const DEV_SCAN_UNIVERSES: readonly DevScanUniverse[] = ['default', 'all'];

export function universeTickers(universe: DevScanUniverse = 'default'): string[] {
  return universe === 'all'
    ? Object.keys(US_EQUITY_INSTRUMENTS).sort(compareTickers)
    : selectDevScanUniverse();
}

export function selectionRule(universe: DevScanUniverse = 'default'): string {
  if (universe === 'default') return SELECTION_RULE;
  const count = Object.keys(US_EQUITY_INSTRUMENTS).length;
  return `All ${count} configured US equities and ETFs (US_EQUITY_INSTRUMENTS, the equity rows of assets_status), requested in full by opt-in, fixed before any data was fetched or scored. Ranks are among these ${count}, so this scan is never compared with a 50-member one.`;
}

export function parseUniverse(value: string | undefined): DevScanUniverse {
  if (value === undefined) return 'default';
  if (DEV_SCAN_UNIVERSES.includes(value as DevScanUniverse)) return value as DevScanUniverse;
  throw new Error(`Unknown universe ${value}: expected ${DEV_SCAN_UNIVERSES.join(' or ')}`);
}

/**
 * Resolved one by one with TradingView's `search_symbols`: the default 50 on
 * 2026-10-29, the other 40 configured tickers on 2026-11-08. Each ticker had
 * exactly one listing on a US primary venue (NASDAQ, NYSE, AMEX = NYSE Arca,
 * CBOE = Cboe BZX). Off-exchange (BOATS, BCS, Pyth), CFD (CFI, FXCM,
 * ThinkMarkets …) and foreign listings were excluded. An exchange is never
 * inferred from the ticker: WMT, for one, now lists on NASDAQ.
 */
export const TRADINGVIEW_SYMBOLS: Readonly<Record<string, string>> = Object.fromEntries(
  [
    'NASDAQ:AAL NASDAQ:AAPL NYSE:ABBV NASDAQ:ABNB NYSE:ACN NASDAQ:AMD NASDAQ:AMZN CBOE:ARKK NYSE:AXP NYSE:BA NYSE:BAC NYSE:C NYSE:CAT NYSE:CRM NASDAQ:CSCO AMEX:GLD NYSE:GS NYSE:HD NASDAQ:HOOD NYSE:IBM NASDAQ:INTC AMEX:IWM NYSE:KO NASDAQ:META NYSE:MRK NYSE:MS NASDAQ:MSFT NYSE:NKE NASDAQ:NVDA NYSE:ORCL NYSE:PFE NYSE:PG NYSE:PINS NASDAQ:PLTR NASDAQ:RIVN NYSE:RTX NASDAQ:SHOP AMEX:SLV NYSE:SNAP AMEX:SPY NASDAQ:TSLA NYSE:UNH AMEX:VOO AMEX:VTI NYSE:VZ AMEX:XLB AMEX:XLE AMEX:XLP AMEX:XLU AMEX:XLY',
    'NASDAQ:ADBE NASDAQ:AFRM NASDAQ:AVGO NASDAQ:COIN NASDAQ:COST NYSE:CVX NYSE:DIS NASDAQ:DKNG NYSE:F NYSE:GE NYSE:GM NASDAQ:GOOGL NASDAQ:HON NYSE:JNJ NYSE:JPM NASDAQ:LCID NYSE:LMT NYSE:MA NYSE:MCD NASDAQ:MRNA NASDAQ:NFLX NASDAQ:PEP NASDAQ:PYPL NASDAQ:QCOM NYSE:RBLX NASDAQ:SOFI NASDAQ:TXN NYSE:UBER NYSE:V NYSE:WFC NASDAQ:WMT NYSE:XOM NYSE:XYZ AMEX:DIA NASDAQ:QQQ NASDAQ:SMH AMEX:XLF AMEX:XLI AMEX:XLK AMEX:XLV',
  ]
    .join(' ')
    .split(' ')
    .map((symbol) => [symbol.slice(symbol.indexOf(':') + 1), symbol]),
);

/** A universe's exact symbols; a member without a resolved symbol stops the retrieval, never drops out. */
export function universeSymbols(universe: DevScanUniverse = 'default'): string[] {
  return universeTickers(universe).map((ticker) => {
    const symbol = TRADINGVIEW_SYMBOLS[ticker];
    if (symbol === undefined) {
      throw new Error(
        `${ticker} has no resolved TradingView symbol; resolve it with search_symbols before scanning the ${universe} universe`,
      );
    }
    return symbol;
  });
}

/** What the agent writes: one entry per selected ticker, the MCP response verbatim or its error. */
export interface TradingViewOhlcvExport {
  schemaVersion: '1';
  source: 'tradingview-mcp';
  /** Absent in every export before 2026-11-08, and in default ones still: the 50. */
  universe?: DevScanUniverse;
  retrieval: { startedAt: string; completedAt: string };
  pineAlerts?: { checkedAt: string; symbols: string[] } | null;
  instruments: Array<{
    ticker: string;
    symbol: string;
    /** When the agent received the response. */
    receivedAt?: string;
    response?: unknown;
    error?: string;
  }>;
}

export interface DevViewPublicationOperations {
  writeFile(path: string, data: string, options: { flag: 'wx' }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const DEV_VIEW_FILE_OPERATIONS: DevViewPublicationOperations = {
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename,
  unlink,
};

interface OhlcvResponse {
  success?: unknown;
  symbol?: unknown;
  interval?: unknown;
  notice?: unknown;
  bars?: unknown;
}

const NEW_YORK_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

function iso(time: number): string {
  return new Date(time).toISOString();
}

/**
 * Maps one `get_ohlcv` 1D response into the us-equity-daily-v1 seam. The
 * adjustment basis comes only from TradingView's notice. A daily bar's `t` must
 * be its session's 09:30 New York open (observed on 2026-10-29), so a bar keyed
 * any other way is rejected, never re-dated. Bars before `from` are dropped;
 * later ones are kept for the validator to exclude and count.
 */
export function tradingViewSeries(
  response: unknown,
  expected: { symbol: string; from: string },
): EquityDailySeries {
  const body = (response ?? {}) as OhlcvResponse;
  if (body.success !== true) throw new Error(`get_ohlcv did not succeed for ${expected.symbol}`);
  if (body.symbol !== expected.symbol) {
    throw new CandleProviderDataError(
      `the response is for ${String(body.symbol)}, not ${expected.symbol}`,
    );
  }
  if (body.interval !== '1D') {
    throw new CandleProviderDataError(`interval ${String(body.interval)}, not 1D`);
  }
  const notice = typeof body.notice === 'string' ? body.notice : '';
  if (!/split-adjusted only/i.test(notice) || !/regular session only/i.test(notice)) {
    throw new CandleProviderDataError(
      'TradingView did not state split-adjusted, regular-session bars, so the adjustment basis is unresolved',
    );
  }
  if (!Array.isArray(body.bars)) throw new CandleProviderDataError('no bars array');
  const bars: EquityDailyBar[] = [];
  for (const row of body.bars as Array<Record<string, unknown> | null>) {
    const values = [row?.['t'], row?.['o'], row?.['h'], row?.['l'], row?.['c'], row?.['v']];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new CandleProviderDataError(`non-numeric bar ${JSON.stringify(row)}`);
    }
    const [t, open, high, low, close, volume] = values as number[];
    const time = t! * 1000;
    const session = NEW_YORK_DATE.format(time);
    if (session < expected.from) continue;
    if (sessionOpen(session) !== time) {
      throw new CandleProviderDataError(
        `bar t=${t} (${iso(time)}) is not the 09:30 America/New_York open of ${session}`,
      );
    }
    bars.push({ session, open: open!, high: high!, low: low!, close: close!, volume: volume! });
  }
  // TradingView's OHLCV reports no split events, so UNADJUSTED_SPLIT cannot be checked.
  return { adjustment: 'SPLIT', bars, splits: [] };
}

function invalid(message: string): never {
  throw new Error(`Invalid TradingView export: ${message}`);
}

/** NaN-safe: an unparseable time is never inside the window. */
function within(time: number, from: number, to: number): boolean {
  return Number.isFinite(time) && time >= from && time <= to;
}

function checkEntry(
  entry: TradingViewOhlcvExport['instruments'][number] | null,
  seen: Set<string>,
  window: { from: number; to: number },
  members: ReadonlySet<string>,
): void {
  if (typeof entry?.ticker !== 'string' || typeof entry.symbol !== 'string')
    invalid('every instrument needs ticker and symbol');
  if (!members.has(entry.ticker)) invalid(`${entry.ticker} is not in the dev-scan universe`);
  if (seen.has(entry.ticker)) invalid(`${entry.ticker} appears twice`);
  seen.add(entry.ticker);
  if (
    entry.response !== undefined &&
    !within(Date.parse(entry.receivedAt ?? ''), window.from, window.to)
  )
    invalid(`${entry.ticker}: receivedAt must fall inside the retrieval window`);
}

/** Trust-boundary check on the agent's file; the bars themselves are checked per instrument. */
export function parseExport(raw: unknown): TradingViewOhlcvExport {
  const file = raw as Partial<TradingViewOhlcvExport> | null;
  if (file?.schemaVersion !== '1' || file.source !== 'tradingview-mcp')
    invalid('schemaVersion 1, source tradingview-mcp expected');
  if (file.universe !== undefined && !DEV_SCAN_UNIVERSES.includes(file.universe))
    invalid(`universe must be ${DEV_SCAN_UNIVERSES.join(' or ')}, or absent for the default`);
  if (
    typeof file.retrieval?.startedAt !== 'string' ||
    typeof file.retrieval.completedAt !== 'string'
  ) {
    invalid('retrieval.startedAt/completedAt are not ordered ISO times');
  }
  const from = Date.parse(file.retrieval.startedAt);
  const to = Date.parse(file.retrieval.completedAt);
  if (!within(from, from, to)) invalid('retrieval.startedAt/completedAt are not ordered ISO times');
  if (!Array.isArray(file.instruments)) invalid('instruments must be an array');
  if (file.pineAlerts !== undefined && file.pineAlerts !== null) {
    if (
      typeof file.pineAlerts !== 'object' ||
      typeof file.pineAlerts.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(file.pineAlerts.checkedAt)) ||
      !Array.isArray(file.pineAlerts.symbols) ||
      file.pineAlerts.symbols.some((symbol) => typeof symbol !== 'string')
    ) {
      invalid('pineAlerts needs a parseable checkedAt and string symbols');
    }
  }
  const seen = new Set<string>();
  const members = new Set(universeTickers(file.universe));
  for (const entry of file.instruments) checkEntry(entry, seen, { from, to }, members);
  return file as TradingViewOhlcvExport;
}

function failure(error: unknown): ScanFetchError {
  if (error instanceof CandleProviderDataError) {
    return { code: 'DATA_INVALID', detail: `MALFORMED_PROVIDER_ROW: ${error.message}` };
  }
  return { code: 'FETCH_FAILED', detail: error instanceof Error ? error.message : String(error) };
}

/** A selected ticker's bars from `from` on, as exported, or why the export has none. */
export function exportedSeries(
  entry: TradingViewOhlcvExport['instruments'][number] | undefined,
  ticker: string,
  from: string,
): { series: EquityDailySeries; receivedAt: number } | { error: ScanFetchError } {
  const symbol = TRADINGVIEW_SYMBOLS[ticker]!;
  if (!entry) return { error: { code: 'FETCH_FAILED', detail: `${symbol} was never retrieved.` } };
  if (entry.symbol !== symbol) {
    const detail = `${entry.symbol} was retrieved; the instrument map names ${symbol}.`;
    return { error: { code: 'DATA_INVALID', detail } };
  }
  if (entry.response === undefined) {
    const detail = `TradingView get_ohlcv (${symbol}): ${entry.error ?? 'no response recorded'}`;
    return { error: { code: 'FETCH_FAILED', detail } };
  }
  try {
    const series = tradingViewSeries(entry.response, { symbol, from });
    return { series, receivedAt: Date.parse(entry.receivedAt!) };
  } catch (error) {
    return { error: failure(error) };
  }
}

/** One scan input per selected ticker: a series, or the reason there is none. Never drops one. */
export function importInputs(file: TradingViewOhlcvExport, evaluationTime: number): ScanInput[] {
  const range = equityRequestRange(evaluationTime);
  const entries = new Map(file.instruments.map((entry) => [entry.ticker, entry]));
  return universeTickers(file.universe).map((ticker): ScanInput => {
    const entry = entries.get(ticker);
    const exported = range && exportedSeries(entry, ticker, range.from);
    const input: ScanInput = {
      ticker,
      instrument: usEquityInstrument(ticker),
      // The symbol the agent asked for, validated only when tradingViewSeries accepted the
      // response, which requires the response's own `symbol` to equal it. Nothing
      // requested, nothing recorded.
      ...(entry && {
        providerSymbol: {
          requested: entry.symbol,
          validated: exported && 'series' in exported ? entry.symbol : null,
        },
      }),
    };
    if (range === null || exported === null) return { ...input, error: EQUITY_CALENDAR_ERROR };
    const equity = { provider: TRADINGVIEW_DEV_PROVIDER_ID, range };
    if ('error' in exported) return { ...input, equity, error: exported.error };
    const { series, receivedAt } = exported;
    return { ...input, equity: { ...equity, series, fetchedAt: receivedAt, cached: false } };
  });
}

/**
 * Scores an export and records it. The evaluation time is when retrieval
 * ended; a retrieval during which another session became final is refused, so
 * every symbol rests on the same required session.
 */
export async function importTradingViewScan(options: {
  file: string;
  store: string;
  repositoryCommit: string;
  now?: () => number;
}): Promise<{
  status: 'IMPORTED' | 'ALREADY_IMPORTED';
  snapshotStatus: 'CREATED' | 'REUSED';
  viewStatus: 'UPDATED';
  path: string;
  viewPath: string;
  preservedView: string | null;
  snapshot: ScanSnapshot;
  view: TradingViewDevScan;
}> {
  const recorded = await recordTradingViewScan(options);
  const preservedView = await preserveOtherUniverseView(recorded.view, options.store);
  const viewPath = await publishTradingViewDevScan(recorded.view, options.store);
  return { ...recorded, viewStatus: 'UPDATED', viewPath, preservedView };
}

/** The import without publishing: the snapshot is written, the view only built. */
async function recordTradingViewScan(options: {
  file: string;
  store: string;
  repositoryCommit: string;
  now?: () => number;
}) {
  const file = parseExport(JSON.parse(await readFile(options.file, 'utf8')));
  const startedAt = Date.parse(file.retrieval.startedAt);
  const evaluationTime = Date.parse(file.retrieval.completedAt);
  if (latestFinalSession(startedAt) !== latestFinalSession(evaluationTime)) {
    throw new Error(
      `A session became final during retrieval (${file.retrieval.startedAt} → ${file.retrieval.completedAt}); retrieve again.`,
    );
  }
  const inputs = importInputs(file, evaluationTime);
  const { path, snapshot, snapshotStatus } = await saveScan({
    inputs,
    evaluationTime,
    universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
    equityProvider: TRADINGVIEW_DEV_PROVIDER_ID,
    repositoryCommit: options.repositoryCommit,
    store: options.store,
    completedAt: (options.now ?? Date.now)(),
    onExisting: 'REUSE_EQUIVALENT',
  });
  const notices = file.instruments.flatMap((entry) => {
    const notice = (entry.response as OhlcvResponse | undefined)?.notice;
    return typeof notice === 'string' ? [notice] : [];
  });
  const view = parseTradingViewDevScan({
    kind: TRADINGVIEW_DEV_SCAN_KIND,
    scanId: snapshot.scanId,
    importedAt: snapshot.completedAt,
    source: {
      tool: 'get_ohlcv',
      interval: '1D',
      retrieval: file.retrieval,
      // What this scan's evidence recorded as requested, not today's instrument map.
      symbols: Object.fromEntries(
        snapshot.inputs.flatMap(({ ticker, providerSymbol }) =>
          providerSymbol ? [[ticker, providerSymbol.requested]] : [],
        ),
      ),
      notice: [...new Set(notices)].join('\n') || 'No market-data notice was returned.',
      selectionRule: selectionRule(file.universe),
      pineAlerts: file.pineAlerts ?? null,
    },
    scan: snapshot.scan,
  });
  const status: 'IMPORTED' | 'ALREADY_IMPORTED' =
    snapshotStatus === 'CREATED' ? 'IMPORTED' : 'ALREADY_IMPORTED';
  return { status, snapshotStatus, path, snapshot, view };
}

/**
 * Before a view of another universe replaces the published one, copies the published one,
 * baseline and all, to `tradingview-dev-scan.<scanId>.<sha256 prefix>.json` beside it.
 * Copying that file back over `tradingview-dev-scan.json` returns to it. Returns the copy's
 * path, or null when the published view is absent, unreadable or of the same universe.
 */
export async function preserveOtherUniverseView(
  view: TradingViewDevScan,
  store: string,
): Promise<string | null> {
  const root = resolve(store);
  let text: string;
  let current: TradingViewDevScan;
  try {
    text = await readFile(join(root, TRADINGVIEW_DEV_SCAN_FILE), 'utf8');
    current = parseTradingViewDevScan(JSON.parse(text));
  } catch {
    return null; // Absent or unreadable: publication replaces it, as before.
  }
  const members = (scan: TradingViewDevScan) => stableSerialize(scan.scan.universe.members);
  if (members(current) === members(view)) return null;
  const name = TRADINGVIEW_DEV_SCAN_FILE.replace(/\.json$/, '');
  const copy = join(root, `${name}.${current.scanId}.${sha256(text).slice(0, 12)}.json`);
  await writeAtomic(copy, text); // Named by its content: a second copy is the same bytes.
  return copy;
}

/** Writes a complete same-directory temporary file, then atomically replaces the local view. */
export async function publishTradingViewDevScan(
  view: TradingViewDevScan,
  store: string,
  operations: DevViewPublicationOperations = DEV_VIEW_FILE_OPERATIONS,
): Promise<string> {
  const root = resolve(store);
  const path = join(root, TRADINGVIEW_DEV_SCAN_FILE);
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const content = `${JSON.stringify(parseTradingViewDevScan(view), null, 2)}\n`;
  await mkdir(root, { recursive: true });
  try {
    await operations.writeFile(temporary, content, { flag: 'wx' });
    await operations.rename(temporary, path);
    return path;
  } finally {
    await operations.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/**
 * The owner's override: names the earlier snapshot that "Changes since
 * previous scan" compares the displayed import with, in place of the one
 * `tradingview-finish` chose. Both come from the scan store. The displayed view must
 * be the stored snapshot it names, and it and a comparable baseline must
 * reproduce, so no change is read off unverified evidence. An incomparable
 * baseline is attached only to say why nothing is compared; none of its results
 * is shown. Only TradingView development imports qualify: the review never
 * compares across sources.
 */
export async function attachBaseline(options: {
  store: string;
  baselineId: string;
}): Promise<{ viewPath: string; comparison: ScanComparison }> {
  const path = join(resolve(options.store), TRADINGVIEW_DEV_SCAN_FILE);
  const { baselineSearch: _automatic, ...view } = parseTradingViewDevScan(
    JSON.parse(await readFile(path, 'utf8')),
  );
  const displayed = await loadScan(view.scanId, options.store);
  if (stableSerialize(displayed.scan) !== stableSerialize(view.scan)) {
    throw new Error(`The displayed view is not snapshot ${view.scanId}; import it again.`);
  }
  await assertReproduces(view.scanId, options.store, reproduceScan);
  const { baseline, comparison } = await namedBaseline(view, options.baselineId, options.store);
  const viewPath = await publishTradingViewDevScan({ ...view, baseline }, options.store);
  return { viewPath, comparison };
}

type Reproduce = typeof reproduceScan;
export type SkippedBaseline = TradingViewDevBaselineSearch['skipped'][number];

async function assertReproduces(scanId: string, store: string, reproduce: Reproduce) {
  const result = await reproduce(scanId, store);
  if (result.status !== 'MATCH') throw new Error(`${scanId} does not reproduce (${result.reason})`);
}

const asBaseline = (snapshot: ScanSnapshot, chosenBy: BaselineChooser): TradingViewDevBaseline => ({
  scanId: snapshot.scanId,
  importedAt: snapshot.completedAt,
  scan: snapshot.scan,
  chosenBy,
});

/**
 * The owner's named baseline, checked as `tradingview-baseline` checks it. It
 * may be any other TradingView import, a same-session revision included.
 */
async function namedBaseline(
  view: TradingViewDevScan,
  baselineId: string,
  store: string,
  reproduce: Reproduce = reproduceScan,
) {
  if (baselineId === view.scanId) {
    throw new Error(`${view.scanId} is the displayed scan; name an earlier TradingView import.`);
  }
  const earlier = await loadScan(baselineId, store);
  if (earlier.scan.universe.source !== TRADINGVIEW_DEV_UNIVERSE_SOURCE) {
    throw new Error(
      `${earlier.scanId} is not a TradingView development import; the review compares only its own imports.`,
    );
  }
  const baseline = asBaseline(earlier, 'tradingview-baseline');
  const comparison = compareScans(view, baseline);
  if (comparison.status === 'COMPARED') await assertReproduces(baselineId, store, reproduce);
  return { baseline, comparison };
}

const SNAPSHOT_FILE = /^(\d{8}T\d{6}Z-[0-9a-f]{8})\.json$/;

interface Candidate {
  snapshot: ScanSnapshot;
  session: string | null;
  comparison: ScanComparison;
}

/** Latest evaluated session first, then the later evaluation (the newer revision), then the scan ID. */
function newestFirst(a: Candidate, b: Candidate): number {
  const key = ({ session, snapshot }: Candidate) => [
    session ?? '',
    new Date(snapshot.scan.evaluationTime).toISOString(),
    snapshot.scanId,
  ];
  const [x, y] = [key(a), key(b)];
  const at = x.findIndex((value, index) => value !== y[index]);
  if (at === -1) return 0;
  return x[at]! < y[at]! ? 1 : -1;
}

/** Why a TradingView import cannot be the automatic baseline, short of reproducing it. */
function passedOver(candidate: Candidate, displayed: string): string | null {
  const { session, comparison } = candidate;
  if (session === null) return 'evaluated no asset, so it rests on no session';
  const incomparable =
    comparison.status === 'INCOMPATIBLE'
      ? `not comparable: ${comparison.differences
          .map(({ field, before, after }) => `${field} ${before} → ${after}`)
          .join('; ')}`
      : null;
  if (session === displayed) {
    // Naming a same-session scan of another universe would only show what differs.
    const next = incomparable ?? 'name it with tradingview-baseline to compare it';
    return `a revision of the displayed scan's session (${session}), never chosen automatically; ${next}`;
  }
  if (session > displayed) return `evaluated a later session (${session}) than the displayed scan`;
  return incomparable;
}

/**
 * The most recent TradingView import from a strictly earlier evaluated session
 * that is comparable with the displayed scan and reproduces offline. A
 * same-session revision is never chosen; the owner can name one.
 */
async function automaticBaseline(
  view: TradingViewDevScan,
  store: string,
  reproduce: Reproduce,
  skipped: SkippedBaseline[],
): Promise<{
  baseline?: TradingViewDevBaseline;
  comparison: ScanComparison;
  reason: string | null;
}> {
  const none = (reason: string) => ({ comparison: { status: 'NO_BASELINE' as const }, reason });
  const displayed = latestSession(view.scan);
  if (displayed === null)
    return none('the displayed scan evaluated no asset, so it rests on no session');
  const ids = (await readdir(resolve(store)))
    .flatMap((name) => SNAPSHOT_FILE.exec(name)?.[1] ?? [])
    .filter((scanId) => scanId !== view.scanId);
  // ponytail: reads every snapshot in the store; keep an index by session once it holds hundreds.
  const loaded = await Promise.all(
    ids.map((scanId) =>
      loadScan(scanId, store).then(
        (snapshot) => ({ scanId, snapshot }),
        (error: unknown) => ({ scanId, error: message(error) }),
      ),
    ),
  );
  const unreadable: SkippedBaseline[] = [];
  const candidates: Candidate[] = [];
  for (const item of loaded) {
    if ('error' in item)
      unreadable.push({ scanId: item.scanId, reason: `unreadable: ${item.error}` });
    else if (item.snapshot.scan?.universe?.source === TRADINGVIEW_DEV_UNIVERSE_SOURCE) {
      const { snapshot } = item;
      const comparison = compareScans(view, { scanId: snapshot.scanId, scan: snapshot.scan });
      candidates.push({ snapshot, session: latestSession(snapshot.scan), comparison });
    }
  }
  const check = (scanId: string) =>
    reproduce(scanId, store).catch((error: unknown) => ({
      status: 'MISMATCH' as const,
      reason: message(error),
    }));
  for (const candidate of candidates.sort(newestFirst)) {
    const { scanId } = candidate.snapshot;
    const reason = passedOver(candidate, displayed);
    if (reason !== null) {
      skipped.push({ scanId, reason });
      continue;
    }
    // Sequential on purpose: reproduction re-scores a whole scan, so stop at the first match.
    const reproduced = await check(scanId); // NOSONAR(S9382)
    if (reproduced.status === 'MATCH') {
      skipped.push(...unreadable);
      const baseline = asBaseline(candidate.snapshot, 'tradingview-finish');
      return { baseline, comparison: candidate.comparison, reason: null };
    }
    skipped.push({ scanId, reason: `does not reproduce (${reproduced.reason})` });
  }
  skipped.push(...unreadable);
  return none(
    candidates.length === 0 && unreadable.length === 0
      ? 'the scan store holds no other TradingView import'
      : 'no TradingView import of an earlier session is comparable and reproduces',
  );
}

/**
 * The baseline a finished scan is published with. A valid baseline the owner
 * named for this same scan is kept; one no longer usable is reported, never
 * dropped silently. Otherwise `automaticBaseline` chooses.
 */
async function chooseBaseline(
  view: TradingViewDevScan,
  store: string,
  previous: TradingViewDevScan | undefined,
  reproduce: Reproduce,
) {
  const skipped: SkippedBaseline[] = [];
  const named = previous?.scanId === view.scanId ? previous.baseline : undefined;
  if (named && named.chosenBy !== 'tradingview-finish') {
    try {
      return { ...(await namedBaseline(view, named.scanId, store, reproduce)), search: undefined };
    } catch (error) {
      const reason = `named with tradingview-baseline, no longer usable: ${message(error)}`;
      skipped.push({ scanId: named.scanId, reason });
    }
  }
  const { reason, ...chosen } = await automaticBaseline(view, store, reproduce, skipped);
  return { ...chosen, search: { reason, skipped } };
}

async function publishedView(store: string): Promise<TradingViewDevScan | undefined> {
  try {
    const path = join(resolve(store), TRADINGVIEW_DEV_SCAN_FILE);
    return parseTradingViewDevScan(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return undefined; // Absent or unreadable: nothing to keep, and the new view replaces it.
  }
}

/** Publishes a reproduced scan with its baseline and returns what the report says about it. */
async function publishWithBaseline(
  view: TradingViewDevScan,
  store: string,
  reproduce: Reproduce,
): Promise<NonNullable<RetrievalReport['baseline']>> {
  const previous = await publishedView(store);
  const { baseline, comparison, search } = await chooseBaseline(view, store, previous, reproduce);
  await publishTradingViewDevScan(
    {
      ...view,
      ...(baseline ? { baseline } : {}),
      ...(search ? { baselineSearch: search } : {}),
    },
    store,
  );
  return {
    chosenBy: baseline?.chosenBy ?? null,
    ...comparisonSummary(comparison),
    reason: search?.reason ?? null,
    skipped: [...(search?.skipped ?? [])],
  };
}

/** What both CLI commands print about a comparison: counts and the moved setups, not every row. */
export function comparisonSummary(comparison: ScanComparison) {
  if (comparison.status !== 'COMPARED') return comparison;
  const { changes, ...rest } = comparison;
  return {
    ...rest,
    compared: changes.length,
    long: setupCounts(changes, 'long'),
    risk: setupCounts(changes, 'risk'),
    scores: scoreCounts(changes),
    changed: changes.filter(setupMoved),
  };
}

/*
 * Capture: from the agent's saved `get_ohlcv` results to an export, without
 * retyping a byte. Claude Code names a saved tool result by the millisecond,
 * and parallel calls can land on the same name and overwrite each other, so a
 * file name proves nothing. Each file is bound to the symbol the agent
 * requested it for: the response's own symbol and interval must match, and the
 * file must have been written after the retrieval started. The agent stays
 * responsible for retrieval; nothing here calls TradingView or sees a credential.
 */

export const RETRIEVAL_STORE = '.zerochart-tradingview';
const RETRIEVAL_ID = /^\d{8}T\d{6}Z$/;
const MANIFEST = 'retrieval.json';
const ALERTS = 'alerts.json';
const TICKER_BY_SYMBOL = new Map(
  Object.entries(TRADINGVIEW_SYMBOLS).map(([ticker, symbol]) => [symbol, ticker]),
);

interface CapturedResponse {
  symbol: string;
  /** The saved file's modification time: when the agent's client wrote the response. */
  receivedAt: string;
  source: string;
  sha256: string;
  response: unknown;
}
type CaptureRecord = CapturedResponse | { symbol: string; recordedAt: string; error: string };

export type CaptureOutcome =
  'CAPTURED' | 'RETRIED' | 'FAILED' | 'DUPLICATE' | 'CONFLICT' | 'IGNORED' | 'REJECTED';

export interface RetrievalStatus {
  retrievalId: string;
  /** Frozen at start with its members; every later step requests and scores exactly those. */
  universe: DevScanUniverse;
  startedAt: string;
  /** The session every symbol must rest on. */
  requiredSession: string | null;
  /** When the next session becomes final; a retrieval that reaches it is refused at import. */
  validUntil: string | null;
  window: 'OPEN' | 'CLOSED';
  requested: number;
  captured: number;
  missing: string[];
  failed: Array<{ symbol: string; reason: string }>;
  conflicting: string[];
  /** Missing and failed symbols, while the window is open; nothing once it has closed. */
  retry: string[];
}

export interface RetrievalReport {
  outcome: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'REFUSED' | 'NOT_REPRODUCED';
  retrievalId: string;
  universe: DevScanUniverse;
  exportPath: string;
  retrieval: TradingViewOhlcvExport['retrieval'];
  requested: number;
  evaluated: number | null;
  failed: number | null;
  failures: Array<{ ticker: string; symbol: string; status: string; detail: string | null }>;
  evaluatedSession: string | null;
  scanId: string | null;
  importStatus: 'IMPORTED' | 'ALREADY_IMPORTED' | null;
  reproduction: string | null;
  refusal?: string;
  /** UNCHANGED unless the scan reproduced: Research keeps the last published view. */
  viewStatus: 'PUBLISHED' | 'UNCHANGED';
  /** The copy of a replaced view of another universe (`preserveOtherUniverseView`), if any. */
  preservedView: string | null;
  /** What "Changes since previous scan" shows, once published; `before` is the baseline. */
  baseline:
    | (ReturnType<typeof comparisonSummary> & {
        chosenBy: BaselineChooser | null;
        /** Why nothing is compared; null when a baseline is attached. */
        reason: string | null;
        skipped: SkippedBaseline[];
      })
    | null;
  research: string | null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const json = (value: unknown) => `${JSON.stringify(value)}\n`;
const isCaptured = (record: CaptureRecord | undefined): record is CapturedResponse =>
  record !== undefined &&
  'response' in record &&
  (record.response as OhlcvResponse | null)?.success === true;

function retrievalDir(store: string, retrievalId: string): string {
  if (!RETRIEVAL_ID.test(retrievalId)) {
    throw new Error(`${retrievalId} is not a retrieval ID (YYYYMMDDTHHMMSSZ)`);
  }
  return join(resolve(store), retrievalId);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readRetrieval(store: string, retrievalId: string) {
  const dir = retrievalDir(store, retrievalId);
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as {
    schemaVersion?: unknown;
    startedAt?: unknown;
    universe?: unknown;
    symbols?: unknown;
  };
  const startedAt =
    typeof manifest.startedAt === 'string' ? Date.parse(manifest.startedAt) : Number.NaN;
  const known =
    manifest.universe === undefined ||
    DEV_SCAN_UNIVERSES.includes(manifest.universe as DevScanUniverse);
  if (manifest.schemaVersion !== '1' || !Number.isFinite(startedAt) || !known) {
    throw new Error(`${retrievalId}: unreadable ${MANIFEST}`);
  }
  // Retrievals started before 2026-11-08 recorded neither: they are the default 50.
  const universe = parseUniverse(manifest.universe as DevScanUniverse | undefined);
  const symbols = universeSymbols(universe);
  if (
    manifest.symbols !== undefined &&
    stableSerialize(manifest.symbols) !== stableSerialize(symbols)
  ) {
    throw new Error(
      `${retrievalId}: the ${universe} universe's members or symbols changed since this retrieval started; start a new retrieval`,
    );
  }
  const names = await readdir(dir);
  const records = new Map<string, CaptureRecord>();
  /** Digest prefixes of every differing response captured for a ticker. */
  const conflicts = new Map<string, string[]>();
  const tickers = universeTickers(universe);
  const read = await Promise.all(
    tickers.map((ticker) => readJson<CaptureRecord>(join(dir, `${ticker}.json`))),
  );
  for (const [index, ticker] of tickers.entries()) {
    const record = read[index];
    if (record) records.set(ticker, record);
    const others = names
      .filter((name) => name.startsWith(`${ticker}.conflict-`) && name.endsWith('.json'))
      .map((name) => name.slice(`${ticker}.conflict-`.length, -'.json'.length));
    if (others.length > 0 && isCaptured(record)) {
      conflicts.set(ticker, [record.sha256.slice(0, 12), ...others]);
    }
  }
  return { dir, startedAt, records, conflicts, universe, tickers };
}

/** The ticker a symbol was requested for in this retrieval; undefined outside its universe. */
function memberTicker(tickers: readonly string[], symbol: string): string | undefined {
  const ticker = TICKER_BY_SYMBOL.get(symbol);
  return ticker !== undefined && tickers.includes(ticker) ? ticker : undefined;
}

const notRequested = (symbol: string, tickers: readonly string[]) =>
  `${symbol} is not one of the ${tickers.length} requested symbols`;

/** When the session after `required` becomes final, so the required session changes. */
function windowCloses(required: string): number | null {
  const next = tradingSessions(required, '9999-12-31')[1];
  return next === undefined ? null : sessionFinalAt(next);
}

export async function retrievalStatus(options: {
  store: string;
  retrievalId: string;
  now?: () => number;
}): Promise<RetrievalStatus> {
  const { startedAt, records, conflicts, universe, tickers } = await readRetrieval(
    options.store,
    options.retrievalId,
  );
  const requiredSession = latestFinalSession(startedAt);
  const closes = requiredSession === null ? null : windowCloses(requiredSession);
  const received = [...records.values()].flatMap((record) =>
    'receivedAt' in record ? [Date.parse(record.receivedAt)] : [],
  );
  const latest = Math.max((options.now ?? Date.now)(), ...received);
  const open = closes === null || latest < closes;
  const missing: string[] = [];
  const failed: RetrievalStatus['failed'] = [];
  const conflicting: string[] = [];
  let captured = 0;
  for (const ticker of tickers) {
    const symbol = TRADINGVIEW_SYMBOLS[ticker]!;
    const record = records.get(ticker);
    if (conflicts.has(ticker)) conflicting.push(symbol);
    else if (isCaptured(record)) captured += 1;
    else if (record === undefined) missing.push(symbol);
    else
      failed.push({
        symbol,
        reason: 'error' in record ? record.error : 'get_ohlcv did not succeed',
      });
  }
  return {
    retrievalId: options.retrievalId,
    universe,
    startedAt: iso(startedAt),
    requiredSession,
    validUntil: closes === null ? null : iso(closes),
    window: open ? 'OPEN' : 'CLOSED',
    requested: tickers.length,
    captured,
    missing,
    failed,
    conflicting,
    retry: open ? [...missing, ...failed.map(({ symbol }) => symbol)] : [],
  };
}

/**
 * Opens a retrieval window: its start time, universe and exact symbols are fixed here,
 * before the agent fetches anything.
 */
export async function startRetrieval(options: {
  store: string;
  universe?: DevScanUniverse;
  now?: () => number;
}): Promise<RetrievalStatus> {
  const startedAt = (options.now ?? Date.now)();
  if (latestFinalSession(startedAt) === null) {
    throw new Error('The time is outside the published US equity calendar; nothing can be scored.');
  }
  const universe = options.universe ?? 'default';
  const symbols = universeSymbols(universe);
  const retrievalId = new Date(startedAt).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dir = retrievalDir(options.store, retrievalId);
  await mkdir(resolve(options.store), { recursive: true });
  await mkdir(dir);
  const manifest = { schemaVersion: '1', startedAt: iso(startedAt), universe, symbols };
  await writeFile(join(dir, MANIFEST), json(manifest), { flag: 'wx' });
  return retrievalStatus({ store: options.store, retrievalId, now: () => startedAt });
}

async function captureOne(
  retrieval: { dir: string; startedAt: number; tickers: readonly string[] },
  symbol: string,
  file: string,
): Promise<{ outcome: CaptureOutcome; detail?: string }> {
  const { dir, startedAt, tickers } = retrieval;
  const rejected = (detail: string) => ({ outcome: 'REJECTED' as const, detail });
  const ticker = memberTicker(tickers, symbol);
  if (ticker === undefined) return rejected(notRequested(symbol, tickers));
  let text: string;
  let receivedAt: number;
  try {
    [text, receivedAt] = await Promise.all([
      readFile(file, 'utf8'),
      stat(file).then(({ mtimeMs }) => Math.floor(mtimeMs)),
    ]);
  } catch (error) {
    return rejected(`cannot read ${file}: ${message(error)}`);
  }
  let body: OhlcvResponse | null;
  try {
    body = JSON.parse(text) as OhlcvResponse | null;
  } catch {
    return rejected(`${file} is not a JSON get_ohlcv response`);
  }
  if (body?.symbol !== symbol) {
    return rejected(
      `${file} holds ${String(body?.symbol)}, not ${symbol}: another call's result or the wrong path`,
    );
  }
  if (body.interval !== '1D') return rejected(`${file} holds interval ${String(body.interval)}`);
  if (receivedAt < startedAt) {
    return rejected(`${file} was written at ${iso(receivedAt)}, before this retrieval started`);
  }
  const record: CapturedResponse = {
    symbol,
    receivedAt: iso(receivedAt),
    source: resolve(file),
    sha256: sha256(text),
    response: body,
  };
  const path = join(dir, `${ticker}.json`);
  const existing = await readJson<CaptureRecord>(path);
  const succeeded = body.success === true;
  if (isCaptured(existing)) {
    if (!succeeded) return { outcome: 'IGNORED', detail: 'a response is already captured' };
    if (existing.sha256 === record.sha256) return { outcome: 'DUPLICATE' };
    await writeAtomic(
      join(dir, `${ticker}.conflict-${record.sha256.slice(0, 12)}.json`),
      json(record),
    );
    return {
      outcome: 'CONFLICT',
      detail: `${symbol} already has a different response; neither will be scored`,
    };
  }
  await writeAtomic(path, json(record));
  if (!succeeded) return { outcome: 'FAILED', detail: 'get_ohlcv did not succeed' };
  return { outcome: existing ? 'RETRIED' : 'CAPTURED' };
}

/**
 * Binds saved responses to the symbols they were requested for, and records
 * the agent's read-only alert check when given. A rejected file changes nothing.
 */
export async function captureResponses(options: {
  store: string;
  retrievalId: string;
  pairs: ReadonlyArray<{ symbol: string; file: string }>;
  alerts?: readonly string[];
  now?: () => number;
}) {
  const retrieval = await readRetrieval(options.store, options.retrievalId);
  const { dir } = retrieval;
  const results: Array<{ symbol: string; file: string; outcome: CaptureOutcome; detail?: string }> =
    [];
  for (const { symbol, file } of options.pairs) {
    // Sequential on purpose: a second file for the same symbol must see the first one's record.
    const captured = await captureOne(retrieval, symbol, file); // NOSONAR(S9382)
    results.push({ symbol, file, ...captured });
  }
  if (options.alerts) {
    const checkedAt = iso((options.now ?? Date.now)());
    await writeAtomic(join(dir, ALERTS), json({ checkedAt, symbols: options.alerts }));
  }
  return { results, status: await retrievalStatus(options) };
}

/** Records the error a `get_ohlcv` call returned; a captured response always wins. */
export async function recordFailure(options: {
  store: string;
  retrievalId: string;
  symbol: string;
  error: string;
  now?: () => number;
}) {
  const { dir, tickers } = await readRetrieval(options.store, options.retrievalId);
  const ticker = memberTicker(tickers, options.symbol);
  if (ticker === undefined) throw new Error(notRequested(options.symbol, tickers));
  if (!options.error.trim()) throw new Error('Record the error the call returned');
  const path = join(dir, `${ticker}.json`);
  const outcome: CaptureOutcome = isCaptured(await readJson<CaptureRecord>(path))
    ? 'IGNORED'
    : 'FAILED';
  if (outcome === 'FAILED') {
    const recordedAt = iso((options.now ?? Date.now)());
    await writeAtomic(path, json({ symbol: options.symbol, recordedAt, error: options.error }));
  }
  return { symbol: options.symbol, outcome, status: await retrievalStatus(options) };
}

/**
 * Assembles the export from the captured files, records the scan and
 * reproduces it offline, then publishes it with its baseline (`chooseBaseline`).
 * Missing, failed and conflicting symbols stay in the scan as failures. The
 * import's own refusal applies when a session became final during retrieval.
 * Nothing is published, and success is never reported, without a MATCH.
 */
export async function finishRetrieval(options: {
  store: string;
  scanStore: string;
  retrievalId: string;
  repositoryCommit: string;
  now?: () => number;
  /** The offline check; replaced only by tests that need a scan which fails it. */
  reproduce?: Reproduce;
}): Promise<RetrievalReport> {
  const { dir, startedAt, records, conflicts, universe, tickers } = await readRetrieval(
    options.store,
    options.retrievalId,
  );
  const alerts = await readJson<NonNullable<TradingViewOhlcvExport['pineAlerts']>>(
    join(dir, ALERTS),
  );
  let completedAt = startedAt;
  const instruments: TradingViewOhlcvExport['instruments'] = [];
  for (const ticker of tickers) {
    const symbol = TRADINGVIEW_SYMBOLS[ticker]!;
    const record = records.get(ticker);
    const digests = conflicts.get(ticker);
    if (digests) {
      const error = `conflicting get_ohlcv responses were captured (${digests.join(', ')}); none is scored`;
      instruments.push({ ticker, symbol, error });
    } else if (record && 'response' in record) {
      completedAt = Math.max(completedAt, Date.parse(record.receivedAt));
      instruments.push({
        ticker,
        symbol,
        receivedAt: record.receivedAt,
        response: record.response,
      });
    } else if (record) {
      instruments.push({ ticker, symbol, error: record.error });
    }
  }
  const file: TradingViewOhlcvExport = {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    // Omitted for the default, so a default export stays byte-identical to earlier ones.
    ...(universe === 'default' ? {} : { universe }),
    retrieval: { startedAt: iso(startedAt), completedAt: iso(completedAt) },
    pineAlerts: alerts ?? null,
    instruments,
  };
  const exportPath = join(resolve(options.store), `${options.retrievalId}.json`);
  await writeAtomic(exportPath, json(file));
  const report: Omit<RetrievalReport, 'outcome'> = {
    retrievalId: options.retrievalId,
    universe,
    exportPath,
    retrieval: file.retrieval,
    requested: tickers.length,
    evaluated: null,
    failed: null,
    failures: [],
    evaluatedSession: null,
    scanId: null,
    importStatus: null,
    reproduction: null,
    viewStatus: 'UNCHANGED',
    preservedView: null,
    baseline: null,
    research: null,
  };
  let imported: Awaited<ReturnType<typeof recordTradingViewScan>>;
  try {
    imported = await recordTradingViewScan({
      file: exportPath,
      store: options.scanStore,
      repositoryCommit: options.repositoryCommit,
      now: options.now ?? Date.now,
    });
  } catch (error) {
    return { ...report, outcome: 'REFUSED', refusal: message(error) };
  }
  const { scan, scanId } = imported.snapshot;
  const reproduce = options.reproduce ?? reproduceScan;
  const reproduced = await reproduce(scanId, options.scanStore);
  const matched = reproduced.status === 'MATCH';
  if (matched) {
    report.preservedView = await preserveOtherUniverseView(imported.view, options.scanStore);
    report.baseline = await publishWithBaseline(imported.view, options.scanStore, reproduce);
    report.viewStatus = 'PUBLISHED';
  }
  const newest = scan.cohorts.find((cohort) => cohort.assetClass === 'equity')?.dataAsOf.newest;
  return {
    ...report,
    outcome: matched ? scan.status : 'NOT_REPRODUCED',
    evaluated: scan.coverage.evaluated,
    failed: scan.coverage.notEvaluated,
    failures: scan.results
      .filter((result) => result.status !== 'EVALUATED')
      .map((result) => ({
        ticker: result.ticker,
        symbol: TRADINGVIEW_SYMBOLS[result.ticker]!,
        status: result.status,
        detail: result.detail ?? null,
      })),
    evaluatedSession: newest == null ? null : NEW_YORK_DATE.format(newest),
    scanId,
    importStatus: imported.status,
    reproduction: matched ? 'MATCH' : `MISMATCH (${reproduced.reason})`,
    research: matched
      ? `npm run dev, open http://localhost:8080/?devAuth=1, Research, TradingView import (scan ${scanId})`
      : null,
  };
}
