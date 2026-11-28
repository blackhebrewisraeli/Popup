/**
 * The perpetual breakout scan command (docs/PERP_BREAKOUT_SCAN.md). Public Binance USDⓈ-M market
 * data only: no key, account, order, database, Telegram or schedule. It fetches and records; every
 * decision is perpBreakoutScan.ts's, so a saved snapshot replays offline to the same report.
 *
 *   npx tsx scripts/perpBreakoutScanRun.ts [--save] [--json] [--min-quote-volume 20000000]
 *     [--max-spread-bps 10] [--weight-budget 1000] [--deadline-ms 60000] [--concurrency 8]
 *     [--quote-window-start-ms 180000] [--quote-window-end-ms 300000] [--max-quote-age-ms 15000]
 *     [--taker-fee-bps 5] [--slippage-bps 5] [--min-net-reward-risk 1.5]
 *   npx tsx scripts/perpBreakoutScanRun.ts --replay <snapshot.json> [--json]
 */
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { stableSerialize } from '../supabase/functions/_shared/stableSerialize';
import {
  CANDLES,
  cryptoPerpetuals,
  DEFAULT_SETTINGS,
  errorName,
  evaluateScan,
  INTERVAL_MS,
  INVALID_SNAPSHOT,
  normalizeSnapshot,
  type QuoteRecord,
  REFERENCE,
  reportText,
  RULE,
  type ScanReport,
  type ScanSettings,
  screenUniverse,
  settingsRefusal,
  type Snapshot,
  SNAPSHOT_SCHEMA,
} from './perpBreakoutScan';

/** The normalized view every live decision reads: the same one a replay builds from the file. */
function view(snapshot: Snapshot): Snapshot {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) throw new Error('The scan produced a snapshot its own replay would refuse');
  return normalized;
}

export const ORIGIN = 'https://fapi.binance.com';
/** Binance's documented request weight of each public request the scan makes. */
export const WEIGHTS = {
  time: 1,
  exchangeInfo: 1,
  tickers24h: 40,
  bookTickers: 5,
  klines: 1, // limit 98 (< 100)
  bookTicker: 2,
  premiumIndex: 1,
} as const;
const PATHS: Record<keyof typeof WEIGHTS, string> = {
  time: '/fapi/v1/time',
  exchangeInfo: '/fapi/v1/exchangeInfo',
  tickers24h: '/fapi/v1/ticker/24hr',
  bookTickers: '/fapi/v1/ticker/bookTicker',
  klines: '/fapi/v1/klines',
  bookTicker: '/fapi/v1/ticker/bookTicker',
  premiumIndex: '/fapi/v1/premiumIndex',
};
const TIMEOUT_MS = 10_000;
export const SNAPSHOT_DIR = '.zerochart-scans/perp-breakout';

type Answer = { ok: true; body: unknown } | { ok: false; reason: string };
export interface ScanDeps {
  fetch: typeof fetch;
  now: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Up to `limit` workers take items in order, so whatever a budget cuts off is the tail. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async (): Promise<void> => {
    if (next >= items.length) return;
    await work(items[next++] as T);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The scan's Binance access: request weight, Binance's used-weight header, a rate-limit halt. */
interface Api {
  get(request: keyof typeof WEIGHTS, params?: Record<string, string>): Promise<Answer>;
  /** Why a request of this weight must not be sent now (halt, deadline, budget), or null. */
  skip(weight: number): string | null;
  serverNow(): number;
  setClock(serverTime: number): void;
}

function binanceApi(deps: ScanDeps, snapshot: Snapshot, started: number): Api {
  let halted: string | null = null;
  let offset = 0;
  const get: Api['get'] = async (request, params = {}) => {
    if (halted) return { ok: false, reason: halted };
    snapshot.requestWeight += WEIGHTS[request];
    const query = new URLSearchParams(params).toString();
    try {
      const url = ORIGIN + PATHS[request] + (query ? '?' + query : '');
      const res = await deps.fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const used = Number(res.headers.get('x-mbx-used-weight-1m'));
      if (used > 0) snapshot.usedWeight1m = Math.max(snapshot.usedWeight1m ?? 0, used);
      if (res.status === 429 || res.status === 418) halted = `rate limited (HTTP ${res.status})`;
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true, body: await res.json() };
    } catch (error) {
      return { ok: false, reason: errorReason(error) };
    }
  };
  const skip = (weight: number) => {
    if (halted) return halted;
    if (deps.now() - started > snapshot.settings.deadlineMs) return 'deadline';
    if (snapshot.requestWeight + weight > snapshot.settings.weightBudget) return 'weight budget';
    return null;
  };
  return {
    get,
    skip,
    serverNow: () => deps.now() + offset,
    setClock: (serverTime) => {
      offset = serverTime - deps.now();
    },
  };
}

const failure = (answer: Answer) => (answer.ok ? 'unreadable answer' : answer.reason);

/** A thrown fetch error with its network cause (Node reports DNS and socket failures as TypeError). */
export function errorReason(error: unknown): string {
  if (!(error instanceof Error)) return 'network error';
  const cause: unknown = error.cause;
  const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
  return errorName(error.name, code) ?? 'network error';
}

/**
 * Server time, exchangeInfo, bulk 24h tickers and bulk best bid/ask; false if any is missing.
 * The decision timestamp comes from GET /fapi/v1/time: exchangeInfo's own serverTime can be hours
 * old (observed 2026-11-28, about 4 h behind on a CDN cache miss).
 */
async function discover(api: Api, snapshot: Snapshot): Promise<boolean> {
  const [clock, info] = await Promise.all([api.get('time'), api.get('exchangeInfo')]);
  const serverTime = clock.ok && isRecord(clock.body) ? clock.body['serverTime'] : undefined;
  const symbols = info.ok && isRecord(info.body) ? info.body['symbols'] : undefined;
  if (!Number.isSafeInteger(serverTime)) snapshot.failures['time'] = failure(clock);
  if (!Array.isArray(symbols)) snapshot.failures['exchangeInfo'] = failure(info);
  if (!Number.isSafeInteger(serverTime) || !Array.isArray(symbols)) return false;
  api.setClock(serverTime as number);
  snapshot.decisionTime = serverTime as number;
  snapshot.boundary = Math.floor(snapshot.decisionTime / INTERVAL_MS) * INTERVAL_MS;
  snapshot.exchangeSymbols = symbols;
  const [tickers, books] = await Promise.all([api.get('tickers24h'), api.get('bookTickers')]);
  if (tickers.ok) snapshot.tickers24h = tickers.body;
  else snapshot.failures['tickers24h'] = tickers.reason;
  if (books.ok) snapshot.bookTickers = books.body;
  else snapshot.failures['bookTickers'] = books.reason;
  return tickers.ok && books.ok;
}

/**
 * Candles for the reference basket first (whether or not it passes the screen), then for every
 * eligible contract in descending 24h quote volume, until the weight budget or the deadline.
 */
async function fetchCandles(api: Api, snapshot: Snapshot): Promise<void> {
  const seen = view(snapshot);
  const { perpetuals } = cryptoPerpetuals(seen.exchangeSymbols ?? []);
  const { eligible } = screenUniverse(perpetuals, seen.tickers24h, seen.bookTickers, seen.settings);
  const universe = new Set(eligible.map((e) => e.symbol));
  const params = {
    interval: '15m',
    startTime: String(snapshot.boundary - CANDLES * INTERVAL_MS),
    endTime: String(snapshot.boundary - 1),
    limit: String(CANDLES),
  };
  await pool(
    [...new Set([...REFERENCE, ...universe])],
    snapshot.settings.concurrency,
    async (symbol) => {
      const skip = api.skip(WEIGHTS.klines);
      if (skip && universe.has(symbol)) snapshot.notEvaluated[symbol] = skip;
      else if (skip) snapshot.failures[`klines ${symbol}`] = skip;
      if (skip) return;
      const answer = await api.get('klines', { symbol, ...params });
      if (answer.ok) snapshot.candles[symbol] = answer.body;
      else snapshot.failures[`klines ${symbol}`] = answer.reason;
    },
  );
}

/** A fresh book ticker and mark price for one signal, only inside its quote window. */
async function fetchQuote(api: Api, snapshot: Snapshot, symbol: string): Promise<void> {
  const { boundary, settings } = snapshot;
  const record: QuoteRecord = { requestedAt: api.serverNow() };
  snapshot.quotes[symbol] = record;
  const inWindow =
    record.requestedAt >= boundary + settings.quoteWindowStartMs &&
    record.requestedAt <= boundary + settings.quoteWindowEndMs;
  if (!inWindow) return;
  const skip = api.skip(WEIGHTS.bookTicker + WEIGHTS.premiumIndex);
  if (skip) {
    record.failure = skip;
    return;
  }
  const [book, premium] = await Promise.all([
    api.get('bookTicker', { symbol }),
    api.get('premiumIndex', { symbol }),
  ]);
  record.receivedAt = api.serverNow();
  if (book.ok) record.bookTicker = book.body;
  if (premium.ok) record.premiumIndex = premium.body;
  const failed = [book, premium].flatMap((a) => (a.ok ? [] : [a.reason]));
  if (failed.length > 0) record.failure = failed.join('; ');
}

/** One scan against Binance: discovery, the screen, candles within budget, then quotes. */
export async function scan(deps: ScanDeps, settings: ScanSettings): Promise<Snapshot> {
  const started = deps.now();
  const snapshot: Snapshot = {
    schema: SNAPSHOT_SCHEMA,
    schemaVersion: 1,
    rule: RULE,
    settings,
    decisionTime: started,
    boundary: Math.floor(started / INTERVAL_MS) * INTERVAL_MS,
    exchangeSymbols: null,
    tickers24h: null,
    bookTickers: null,
    candles: {},
    notEvaluated: {},
    quotes: {},
    failures: {},
    requestWeight: 0,
    usedWeight1m: null,
    elapsedMs: 0,
  };
  const api = binanceApi(deps, snapshot, started);
  if (await discover(api, snapshot)) {
    await fetchCandles(api, snapshot);
    // Quotes only for the signals the same evaluation finds in the candles.
    const signals = evaluateScan(view(snapshot)).signals;
    await pool(signals, settings.concurrency, (signal) => fetchQuote(api, snapshot, signal.symbol));
  }
  snapshot.elapsedMs = deps.now() - started;
  snapshot.report = evaluateScan(view(snapshot));
  return snapshot;
}

/** The saved snapshot through the same evaluation, offline, compared with its recorded report. */
export function replay(raw: unknown): { report: ScanReport; match: boolean | null } {
  const snapshot = normalizeSnapshot(raw);
  if (!snapshot) throw new Error(INVALID_SNAPSHOT);
  const report = evaluateScan(snapshot);
  // The recorded report is only compared, never printed.
  const recorded: unknown = (raw as { report?: unknown }).report;
  return {
    report,
    match: recorded === undefined ? null : stableSerialize(report) === stableSerialize(recorded),
  };
}

const FLAGS = {
  'min-quote-volume': 'minQuoteVolumeUsdt',
  'max-spread-bps': 'maxSpreadBps',
  'weight-budget': 'weightBudget',
  'deadline-ms': 'deadlineMs',
  concurrency: 'concurrency',
  'quote-window-start-ms': 'quoteWindowStartMs',
  'quote-window-end-ms': 'quoteWindowEndMs',
  'max-quote-age-ms': 'maxQuoteAgeMs',
  'taker-fee-bps': 'takerFeeBps',
  'slippage-bps': 'slippageBps',
  'min-net-reward-risk': 'minNetRewardRisk',
} as const satisfies Record<string, keyof ScanSettings>;

/** Settings from command-line flags over the research defaults. */
export function settingsFrom(values: Record<string, unknown>): ScanSettings {
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const [flag, key] of Object.entries(FLAGS)) {
    const value = values[flag];
    if (typeof value !== 'string') continue;
    settings[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : value;
  }
  const refusal = settingsRefusal(settings as unknown as ScanSettings);
  if (refusal) throw new Error(refusal);
  return settings as unknown as ScanSettings;
}

/**
 * The snapshot file a replay may read: a .json file in SNAPSHOT_DIR, named alone or by a path that
 * resolves there. Replay reads nothing else.
 */
export const OUTSIDE_SNAPSHOT_DIR = `Replay reads only regular .json snapshot files in ${SNAPSHOT_DIR}/`;

export async function snapshotFile(argument: string, dir = SNAPSHOT_DIR): Promise<string> {
  const name = basename(argument);
  const candidate = join(dir, name);
  const elsewhere = argument !== name && resolve(argument) !== resolve(candidate);
  if (!name.endsWith('.json') || elsewhere) throw new Error(OUTSIDE_SNAPSHOT_DIR);
  // Symlinks are followed before the check: the real file must be a regular file whose real
  // parent is the real snapshot directory.
  const real = await Promise.all([realpath(dir), realpath(candidate)]).catch(() => null);
  const file = real && dirname(real[1]) === real[0] ? real[1] : null;
  const regular = file
    ? await stat(file).then(
        (s) => s.isFile(),
        () => false,
      )
    : false;
  if (!file || !regular) throw new Error(OUTSIDE_SNAPSHOT_DIR);
  return file;
}

/**
 * Replay one saved snapshot offline and print its report (text, or JSON with `json`) and the
 * verdict. Unreadable JSON and any snapshot normalizeSnapshot refuses end in INVALID_SNAPSHOT,
 * before anything is printed. Returns the exit code.
 */
export async function replayCommand(
  argument: string,
  json: boolean,
  log: (text: string) => void,
  dir = SNAPSHOT_DIR,
): Promise<number> {
  const file = await snapshotFile(argument, dir);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // JSON.parse messages quote the input; report a fixed message instead.
    throw new Error(INVALID_SNAPSHOT);
  }
  const { report, match } = replay(raw);
  log(json ? JSON.stringify(report, null, 2) : reportText(report));
  const verdict = { true: 'MATCH', false: 'MISMATCH', null: 'no recorded report to compare' }[
    String(match)
  ];
  log(`Replay (offline): ${verdict}`);
  return match === false ? 1 : 0;
}

async function main() {
  const options = Object.fromEntries(
    Object.keys(FLAGS).map((flag) => [flag, { type: 'string' as const }]),
  );
  const { values } = parseArgs({
    options: {
      ...options,
      save: { type: 'boolean' },
      json: { type: 'boolean' },
      replay: { type: 'string' },
    },
  });
  if (typeof values.replay === 'string') {
    process.exitCode = await replayCommand(values.replay, values.json === true, (text) =>
      console.log(text),
    );
    return;
  }
  const snapshot = await scan({ fetch, now: Date.now }, settingsFrom(values));
  const report = snapshot.report as ScanReport;
  console.log(values.json ? JSON.stringify(report, null, 2) : reportText(report));
  if (values.save) {
    const stamp = new Date(snapshot.decisionTime).toISOString().replace(/[:.]/g, '-');
    const file = join(SNAPSHOT_DIR, `perp-breakout-${stamp}.json`);
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(file, `${JSON.stringify(snapshot)}\n`, { flag: 'wx' });
    console.log(`Snapshot: ${file}`);
  }
  process.exitCode = snapshot.report?.status === 'failed' ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
