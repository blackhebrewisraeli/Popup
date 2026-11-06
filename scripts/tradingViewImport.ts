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
import { reproduceScan, saveScan, type ScanSnapshot } from './marketScanStore';

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
 * Resolved one by one with TradingView's `search_symbols` on 2026-10-29: each
 * ticker had exactly one listing on a US primary venue (NASDAQ, NYSE, AMEX =
 * NYSE Arca, CBOE = Cboe BZX). Off-exchange (BOATS, BCS, Pyth), CFD and foreign
 * listings were excluded. An exchange is never inferred from the ticker.
 */
export const TRADINGVIEW_SYMBOLS: Readonly<Record<string, string>> = Object.fromEntries(
  'NASDAQ:AAL NASDAQ:AAPL NYSE:ABBV NASDAQ:ABNB NYSE:ACN NASDAQ:AMD NASDAQ:AMZN CBOE:ARKK NYSE:AXP NYSE:BA NYSE:BAC NYSE:C NYSE:CAT NYSE:CRM NASDAQ:CSCO AMEX:GLD NYSE:GS NYSE:HD NASDAQ:HOOD NYSE:IBM NASDAQ:INTC AMEX:IWM NYSE:KO NASDAQ:META NYSE:MRK NYSE:MS NASDAQ:MSFT NYSE:NKE NASDAQ:NVDA NYSE:ORCL NYSE:PFE NYSE:PG NYSE:PINS NASDAQ:PLTR NASDAQ:RIVN NYSE:RTX NASDAQ:SHOP AMEX:SLV NYSE:SNAP AMEX:SPY NASDAQ:TSLA NYSE:UNH AMEX:VOO AMEX:VTI NYSE:VZ AMEX:XLB AMEX:XLE AMEX:XLP AMEX:XLU AMEX:XLY'
    .split(' ')
    .map((symbol) => [symbol.slice(symbol.indexOf(':') + 1), symbol]),
);

/** What the agent writes: one entry per selected ticker, the MCP response verbatim or its error. */
export interface TradingViewOhlcvExport {
  schemaVersion: '1';
  source: 'tradingview-mcp';
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
): void {
  if (typeof entry?.ticker !== 'string' || typeof entry.symbol !== 'string')
    invalid('every instrument needs ticker and symbol');
  if (!Object.hasOwn(TRADINGVIEW_SYMBOLS, entry.ticker))
    invalid(`${entry.ticker} is not in the dev-scan universe`);
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
  for (const entry of file.instruments) checkEntry(entry, seen, { from, to });
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
  return selectDevScanUniverse().map((ticker): ScanInput => {
    const input: ScanInput = { ticker, instrument: usEquityInstrument(ticker) };
    if (range === null) return { ...input, error: EQUITY_CALENDAR_ERROR };
    const equity = { provider: TRADINGVIEW_DEV_PROVIDER_ID, range };
    const exported = exportedSeries(entries.get(ticker), ticker, range.from);
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
  snapshot: ScanSnapshot;
  view: TradingViewDevScan;
}> {
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
      symbols: TRADINGVIEW_SYMBOLS,
      notice: [...new Set(notices)].join('\n') || 'No market-data notice was returned.',
      selectionRule: SELECTION_RULE,
      pineAlerts: file.pineAlerts ?? null,
    },
    scan: snapshot.scan,
  });
  const viewPath = await publishTradingViewDevScan(view, options.store);
  return {
    status: snapshotStatus === 'CREATED' ? 'IMPORTED' : 'ALREADY_IMPORTED',
    snapshotStatus,
    viewStatus: 'UPDATED',
    path,
    viewPath,
    snapshot,
    view,
  };
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
  };
  const startedAt = typeof manifest.startedAt === 'string' ? Date.parse(manifest.startedAt) : NaN;
  if (manifest.schemaVersion !== '1' || !Number.isFinite(startedAt)) {
    throw new Error(`${retrievalId}: unreadable ${MANIFEST}`);
  }
  const names = await readdir(dir);
  const records = new Map<string, CaptureRecord>();
  /** Digest prefixes of every differing response captured for a ticker. */
  const conflicts = new Map<string, string[]>();
  for (const ticker of selectDevScanUniverse()) {
    const record = await readJson<CaptureRecord>(join(dir, `${ticker}.json`));
    if (record) records.set(ticker, record);
    const others = names
      .filter((name) => name.startsWith(`${ticker}.conflict-`) && name.endsWith('.json'))
      .map((name) => name.slice(`${ticker}.conflict-`.length, -'.json'.length));
    if (others.length > 0 && isCaptured(record)) {
      conflicts.set(ticker, [record.sha256.slice(0, 12), ...others]);
    }
  }
  return { dir, startedAt, records, conflicts };
}

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
  const { startedAt, records, conflicts } = await readRetrieval(options.store, options.retrievalId);
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
  for (const ticker of selectDevScanUniverse()) {
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
    startedAt: iso(startedAt),
    requiredSession,
    validUntil: closes === null ? null : iso(closes),
    window: open ? 'OPEN' : 'CLOSED',
    requested: DEV_SCAN_SIZE,
    captured,
    missing,
    failed,
    conflicting,
    retry: open ? [...missing, ...failed.map(({ symbol }) => symbol)] : [],
  };
}

/** Opens a retrieval window: its start time is taken here, before the agent fetches anything. */
export async function startRetrieval(options: {
  store: string;
  now?: () => number;
}): Promise<RetrievalStatus> {
  const startedAt = (options.now ?? Date.now)();
  if (latestFinalSession(startedAt) === null) {
    throw new Error('The time is outside the published US equity calendar; nothing can be scored.');
  }
  const retrievalId = new Date(startedAt).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dir = retrievalDir(options.store, retrievalId);
  await mkdir(resolve(options.store), { recursive: true });
  await mkdir(dir);
  await writeFile(join(dir, MANIFEST), json({ schemaVersion: '1', startedAt: iso(startedAt) }), {
    flag: 'wx',
  });
  return retrievalStatus({ store: options.store, retrievalId, now: () => startedAt });
}

async function captureOne(
  dir: string,
  startedAt: number,
  symbol: string,
  file: string,
): Promise<{ outcome: CaptureOutcome; detail?: string }> {
  const rejected = (detail: string) => ({ outcome: 'REJECTED' as const, detail });
  const ticker = TICKER_BY_SYMBOL.get(symbol);
  if (ticker === undefined) return rejected(`${symbol} is not one of the 50 requested symbols`);
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
  const { dir, startedAt } = await readRetrieval(options.store, options.retrievalId);
  const results: Array<{ symbol: string; file: string; outcome: CaptureOutcome; detail?: string }> =
    [];
  for (const { symbol, file } of options.pairs) {
    results.push({ symbol, file, ...(await captureOne(dir, startedAt, symbol, file)) });
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
  const { dir } = await readRetrieval(options.store, options.retrievalId);
  const ticker = TICKER_BY_SYMBOL.get(options.symbol);
  if (ticker === undefined)
    throw new Error(`${options.symbol} is not one of the 50 requested symbols`);
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
 * Assembles the export from the captured files, imports it and reproduces the
 * scan offline. Missing, failed and conflicting symbols stay in the scan as
 * failures. The import's own refusal applies when a session became final
 * during retrieval. Success is never reported without a MATCH.
 */
export async function finishRetrieval(options: {
  store: string;
  scanStore: string;
  retrievalId: string;
  repositoryCommit: string;
  now?: () => number;
}): Promise<RetrievalReport> {
  const { dir, startedAt, records, conflicts } = await readRetrieval(
    options.store,
    options.retrievalId,
  );
  const alerts = await readJson<NonNullable<TradingViewOhlcvExport['pineAlerts']>>(
    join(dir, ALERTS),
  );
  let completedAt = startedAt;
  const instruments: TradingViewOhlcvExport['instruments'] = [];
  for (const ticker of selectDevScanUniverse()) {
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
    retrieval: { startedAt: iso(startedAt), completedAt: iso(completedAt) },
    pineAlerts: alerts ?? null,
    instruments,
  };
  const exportPath = join(resolve(options.store), `${options.retrievalId}.json`);
  await writeAtomic(exportPath, json(file));
  const report = {
    retrievalId: options.retrievalId,
    exportPath,
    retrieval: file.retrieval,
    requested: DEV_SCAN_SIZE,
    evaluated: null,
    failed: null,
    failures: [],
    evaluatedSession: null,
    scanId: null,
    importStatus: null,
    reproduction: null,
    research: null,
  };
  let imported: Awaited<ReturnType<typeof importTradingViewScan>>;
  try {
    imported = await importTradingViewScan({
      file: exportPath,
      store: options.scanStore,
      repositoryCommit: options.repositoryCommit,
      now: options.now ?? Date.now,
    });
  } catch (error) {
    return { ...report, outcome: 'REFUSED', refusal: message(error) };
  }
  const { scan, scanId } = imported.snapshot;
  const reproduced = await reproduceScan(scanId, options.scanStore);
  const matched = reproduced.status === 'MATCH';
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
