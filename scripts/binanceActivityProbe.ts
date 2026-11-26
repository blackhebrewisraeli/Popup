/**
 * One bounded probe of the activity fields in Binance Spot's public 1h klines, as recorded in
 * docs/binance-activity-probe.plan.json before any request. Public market data only: no
 * credentials, account, Supabase or production store. At most 60 requests (rate-limit retries
 * excluded), written once to a new git-ignored directory. v1's saved candles are opened read-only
 * for an OHLC parity check and never written. Computes no return, outcome, model or strategy.
 *
 *   npx tsx scripts/binanceActivityProbe.ts             fetch, then validate
 *   npx tsx scripts/binanceActivityProbe.ts --validate  validate saved responses only
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MAX_REQUESTS = 60;
const MAX_USED_WEIGHT = 3000;
const MAX_RETRY_AFTER_S = 120;
const PAUSE_MS = 250;
/** Relative slack for implied mean prices; the strings carry 8 decimals, so this is generous. */
const PRICE_TOLERANCE = 1e-6;
const PLAN_PATH = 'docs/binance-activity-probe.plan.json';
const OUT_DIR = '.zerochart-market-data/binance-activity-probe-2026-11-26';
const V1_KLINES = '.zerochart-market-data/spot-24h-v1/klines';
const DECIMAL = /^\d+(\.\d+)?$/;

export interface ProbeRequest {
  symbol: string;
  date: string;
  startTime: number;
  endTime: number;
  url: string;
}

/** The plan's requests in its order: pairs, then dates. Refuses anything beyond the plan's bound. */
export function probeRequests(plan: { pairs: string[]; dates: string[] }): ProbeRequest[] {
  const requests = plan.pairs.flatMap((symbol) =>
    plan.dates.map((date) => {
      if (!/^[A-Z0-9]{2,20}$/.test(symbol)) throw new Error(`Unexpected symbol ${symbol}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Unexpected date ${date}`);
      const startTime = Date.parse(`${date}T00:00:00.000Z`);
      const endTime = startTime + DAY_MS - 1;
      const url =
        'https://api.binance.com/api/v3/klines' +
        `?symbol=${symbol}&interval=1h&startTime=${startTime}&endTime=${endTime}&limit=24`;
      return { symbol, date, startTime, endTime, url };
    }),
  );
  if (requests.length > MAX_REQUESTS) {
    throw new Error(`${requests.length} requests exceed the authorized ${MAX_REQUESTS}`);
  }
  return requests;
}

/** Exact comparison of two nonnegative decimal strings. */
export function compareDecimal(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  const width = Math.max(af.length, bf.length);
  const x = BigInt(ai + af.padEnd(width, '0'));
  const y = BigInt(bi + bf.padEnd(width, '0'));
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

const isZero = (value: string) => compareDecimal(value, '0') === 0;

export type HourStatus = 'VALID' | 'VALID_ZERO' | 'MISSING' | 'INVALID';

export interface HourCheck {
  openTime: number;
  status: HourStatus;
  issues: string[];
  /** Taker-buy quote volume ÷ quote volume, when quote volume is positive. */
  takerBuyShare: number | null;
  ohlc: [number, number, number, number] | null;
  closeTime: number | null;
  ignoreField: unknown;
}

const DECIMAL_FIELDS = [
  ['open', 1],
  ['high', 2],
  ['low', 3],
  ['close', 4],
  ['base volume', 5],
  ['quote volume', 7],
  ['taker-buy base', 9],
  ['taker-buy quote', 10],
] as const;

/** Types and timing: every field present and of its documented kind, and the candle closed. */
function typeIssues(row: unknown[], openTime: number, sentAt: number): string[] {
  const issues: string[] = [];
  if (row.length !== 12) issues.push('row does not have exactly 12 fields');
  const closeTime = row[6];
  if (!Number.isSafeInteger(closeTime) || closeTime !== openTime + HOUR_MS - 1) {
    issues.push('close time is not open time + 3,599,999');
  } else if ((closeTime as number) >= sentAt) {
    issues.push('candle had not closed when the request was sent');
  }
  for (const [name, index] of DECIMAL_FIELDS) {
    const value = row[index];
    if (typeof value !== 'string' || !DECIMAL.test(value)) {
      issues.push(`${name} is not a nonnegative decimal string`);
    }
  }
  const trades = row[8];
  if (!Number.isSafeInteger(trades) || (trades as number) < 0) {
    issues.push('number of trades is not a nonnegative integer');
  }
  return issues;
}

/** Ranges, inequalities and zero consistency, on a row whose types already passed. */
function consistencyIssues(row: unknown[]): string[] {
  const field = (index: number) => row[index] as string;
  const [open, high, low, close, volume] = [field(1), field(2), field(3), field(4), field(5)];
  const [quote, takerBase, takerQuote] = [field(7), field(9), field(10)];
  const trades = row[8] as number;
  const issues: string[] = [];
  if (isZero(low)) issues.push('low price is zero');
  if ([open, close, low].some((price) => compareDecimal(high, price) < 0)) {
    issues.push('high below open, close or low');
  }
  if ([open, close].some((price) => compareDecimal(low, price) > 0)) {
    issues.push('low above open or close');
  }
  if (compareDecimal(takerBase, volume) > 0) issues.push('taker-buy base above base volume');
  if (compareDecimal(takerQuote, quote) > 0) issues.push('taker-buy quote above quote volume');
  const noVolume = isZero(volume);
  if ((trades === 0) !== noVolume) issues.push('number of trades and base volume disagree on zero');
  if (noVolume && ![quote, takerBase, takerQuote].every(isZero)) {
    issues.push('zero base volume with nonzero quote or taker-buy volume');
  }
  const lower = Number(low) * (1 - PRICE_TOLERANCE);
  const upper = Number(high) * (1 + PRICE_TOLERANCE);
  const inRange = (q: string, b: string) => {
    const price = Number(q) / Number(b);
    return price >= lower && price <= upper;
  };
  if (!noVolume && !inRange(quote, volume)) issues.push('quote ÷ base outside [low, high]');
  if (!isZero(takerBase) && !inRange(takerQuote, takerBase)) {
    issues.push('taker-buy quote ÷ taker-buy base outside [low, high]');
  }
  return issues;
}

/** One kline row checked against its expected open time. Nothing is repaired. */
export function checkRow(row: unknown[], openTime: number, sentAt: number): HourCheck {
  const base = { openTime, takerBuyShare: null, ohlc: null, closeTime: null, ignoreField: row[11] };
  if (row.length < 12 || row.slice(0, 11).some((value) => value === null || value === undefined)) {
    return { ...base, status: 'MISSING', issues: ['row is shorter than 12 fields or has a null'] };
  }
  const typed = typeIssues(row, openTime, sentAt);
  if (typed.length > 0) return { ...base, status: 'INVALID', issues: typed };
  const issues = consistencyIssues(row);
  const quote = row[7] as string;
  const prices = [1, 2, 3, 4].map((i) => Number.parseFloat(row[i] as string));
  let status: HourStatus = 'VALID';
  if (issues.length > 0) status = 'INVALID';
  else if (isZero(row[5] as string)) status = 'VALID_ZERO';
  return {
    ...base,
    status,
    issues,
    takerBuyShare: isZero(quote) ? null : Number(row[10]) / Number(quote),
    ohlc: prices as [number, number, number, number],
    closeTime: row[6] as number,
  };
}

/** A whole response: 24 hourly rows from startTime, in order, without duplicates. */
export function checkResponse(body: unknown, startTime: number, sentAt: number) {
  const expected = Array.from({ length: 24 }, (_, i) => startTime + i * HOUR_MS);
  const rows = new Map<number, unknown[]>();
  const duplicates = new Set<number>();
  const issues: string[] = [];
  if (Array.isArray(body)) {
    if (body.length !== 24) issues.push(`${body.length} rows, expected 24`);
    let previous = Number.NEGATIVE_INFINITY;
    for (const [index, row] of body.entries()) {
      const openTime: unknown = Array.isArray(row) ? row[0] : undefined;
      if (!Number.isSafeInteger(openTime)) {
        issues.push(`row ${index}: open time is not an integer`);
        continue;
      }
      const time = openTime as number;
      if (!expected.includes(time))
        issues.push(`row ${index}: open time outside the requested hours`);
      if (time <= previous) issues.push(`row ${index}: open time not increasing`);
      if (rows.has(time)) duplicates.add(time);
      previous = time;
      rows.set(time, row as unknown[]);
    }
  } else {
    issues.push('response is not an array');
  }
  const hours = expected.map((openTime): HourCheck => {
    const row = rows.get(openTime);
    if (row === undefined) {
      const none = { takerBuyShare: null, ohlc: null, closeTime: null, ignoreField: undefined };
      return { openTime, status: 'MISSING', issues: ['no row for this hour'], ...none };
    }
    const check = checkRow(row, openTime, sentAt);
    if (!duplicates.has(openTime)) return check;
    return { ...check, status: 'INVALID', issues: [...check.issues, 'duplicate open time'] };
  });
  return { issues, hours };
}

interface SavedCandle {
  timestamp: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Probe OHLC against v1's saved candle for the same open time (parsed the same way). */
export function ohlcParity(hours: HourCheck[], v1: Map<number, SavedCandle>) {
  const mismatches: { openTime: number; field: string; probe: number; v1: number }[] = [];
  let compared = 0;
  let absent = 0;
  for (const hour of hours) {
    if (!hour.ohlc) continue;
    const saved = v1.get(hour.openTime);
    if (!saved) {
      absent += 1;
      continue;
    }
    compared += 1;
    const pairs: [string, number, number][] = [
      ['open', hour.ohlc[0], saved.open],
      ['high', hour.ohlc[1], saved.high],
      ['low', hour.ohlc[2], saved.low],
      ['close', hour.ohlc[3], saved.close],
      ['closeTime', hour.closeTime ?? Number.NaN, saved.closeTime],
    ];
    for (const [field, probe, kept] of pairs) {
      if (probe !== kept) mismatches.push({ openTime: hour.openTime, field, probe, v1: kept });
    }
  }
  return { compared, absent, mismatches };
}

export interface RequestLog {
  symbol: string;
  date: string;
  url: string;
  counted: boolean;
  status: number | null;
  sentAt: string;
  retrievedAt: string;
  usedWeight1m: number | null;
  bytes: number | null;
  sha256: string | null;
  error?: string;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

interface ProbeIo {
  fetchImpl: (url: string) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  save: (name: string, bytes: Buffer) => Promise<void>;
}

/** Requests in order under the plan's stop rules. Returns the log and why it stopped early, if it did. */
export async function runProbe(requests: ProbeRequest[], io: ProbeIo) {
  const log: RequestLog[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const request of requests) {
    const { symbol, date, url } = request;
    for (let attempt = 0; ; attempt += 1) {
      const sentAt = io.now();
      const entry = { symbol, date, url, sentAt: iso(sentAt) };
      let response: Response;
      try {
        response = await io.fetchImpl(url); // NOSONAR(S9382): one request at a time
      } catch (error) {
        const failed = { usedWeight1m: null, bytes: null, sha256: null, error: String(error) };
        log.push({ ...entry, counted: true, status: null, retrievedAt: iso(io.now()), ...failed });
        break;
      }
      const weight = Number(response.headers.get('x-mbx-used-weight-1m'));
      const usedWeight1m = Number.isFinite(weight) && weight > 0 ? weight : null;
      const bytes = Buffer.from(await response.arrayBuffer()); // NOSONAR(S9382)
      const retry = response.status === 429 && attempt === 0;
      log.push({
        ...entry,
        counted: !retry,
        status: response.status,
        retrievedAt: iso(io.now()),
        usedWeight1m,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
      if (retry) {
        const seconds = Number(response.headers.get('retry-after'));
        if (!(seconds > 0 && seconds <= MAX_RETRY_AFTER_S)) {
          return { log, stopped: `429 with Retry-After ${response.headers.get('retry-after')}` };
        }
        await io.sleep(seconds * 1000); // NOSONAR(S9382): back off as Binance requires
        continue;
      }
      if ([429, 418, 403, 451].includes(response.status)) {
        return { log, stopped: `HTTP ${response.status} on ${symbol} ${date}` };
      }
      if (response.status === 200) await io.save(`raw/${symbol}-${date}.json`, bytes); // NOSONAR(S9382)
      if (usedWeight1m !== null && usedWeight1m > MAX_USED_WEIGHT) {
        return { log, stopped: `X-MBX-USED-WEIGHT-1M ${usedWeight1m} above ${MAX_USED_WEIGHT}` };
      }
      break;
    }
    await io.sleep(PAUSE_MS); // NOSONAR(S9382): pacing
  }
  return { log, stopped: null };
}

interface HourRecord extends HourCheck {
  symbol: string;
  date: string;
}

/** Counts across every checked hour; only the taker-buy share range is summarized beyond counts. */
export function summarize(hours: HourRecord[]) {
  const status: Record<HourStatus, number> = { VALID: 0, VALID_ZERO: 0, MISSING: 0, INVALID: 0 };
  const issues: Record<string, number> = {};
  const ignoreValues = new Set<string>();
  const shares: number[] = [];
  for (const hour of hours) {
    status[hour.status] += 1;
    for (const issue of hour.issues) issues[issue] = (issues[issue] ?? 0) + 1;
    if (hour.ignoreField !== undefined) ignoreValues.add(JSON.stringify(hour.ignoreField));
    if (hour.takerBuyShare !== null) shares.push(hour.takerBuyShare);
  }
  return {
    hours: hours.length,
    status,
    issues,
    ignoreFieldValues: [...ignoreValues].sort((a, b) => a.localeCompare(b)),
    takerBuyShareOfQuote: {
      hours: shares.length,
      min: shares.length ? Math.min(...shares) : null,
      max: shares.length ? Math.max(...shares) : null,
      exactlyZero: shares.filter((share) => share === 0).length,
      exactlyOne: shares.filter((share) => share === 1).length,
    },
  };
}

const repositoryRoot = () => fileURLToPath(new URL('..', import.meta.url));

async function readV1(root: string, symbol: string): Promise<Map<number, SavedCandle>> {
  const file = JSON.parse(
    await readFile(join(root, V1_KLINES, `${symbol}-1h.json`), 'utf8'), // NOSONAR(S9382)
  ) as { candles: SavedCandle[] };
  return new Map(file.candles.map((candle) => [candle.timestamp, candle]));
}

/** Offline: checks every saved 200 response named in the manifest and writes validation.json once. */
export async function validateProbe(root = repositoryRoot()) {
  const out = join(root, OUT_DIR);
  const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as {
    log: RequestLog[];
  };
  const perRequest = [];
  const hours: HourRecord[] = [];
  const parity = { compared: 0, absent: 0, mismatches: [] as unknown[] };
  for (const entry of manifest.log.filter((item) => item.counted && item.status === 200)) {
    const bytes = await readFile(join(out, 'raw', `${entry.symbol}-${entry.date}.json`)); // NOSONAR(S9382)
    if (sha256(bytes) !== entry.sha256)
      throw new Error(`${entry.symbol} ${entry.date} hash changed`);
    const startTime = Date.parse(`${entry.date}T00:00:00.000Z`);
    const result = checkResponse(
      JSON.parse(bytes.toString('utf8')),
      startTime,
      Date.parse(entry.sentAt),
    );
    const match = ohlcParity(result.hours, await readV1(root, entry.symbol)); // NOSONAR(S9382)
    parity.compared += match.compared;
    parity.absent += match.absent;
    parity.mismatches.push(...match.mismatches.map((m) => ({ symbol: entry.symbol, ...m })));
    hours.push(
      ...result.hours.map((hour) => ({ ...hour, symbol: entry.symbol, date: entry.date })),
    );
    const invalidOrMissing = result.hours.filter(
      (hour) => hour.status === 'INVALID' || hour.status === 'MISSING',
    );
    perRequest.push({
      symbol: entry.symbol,
      date: entry.date,
      responseIssues: result.issues,
      notValid: invalidOrMissing.map(({ openTime, status, issues }) => ({
        openTime,
        status,
        issues,
      })),
    });
  }
  const validation = {
    requestsValidated: perRequest.length,
    summary: summarize(hours),
    ohlcParityWithV1: parity,
    perRequest,
  };
  await writeFile(join(out, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`, {
    flag: 'wx',
  });
  return validation;
}

/** Online: refuses a dirty tree or an existing output directory, then runs the plan once. */
async function fetchProbe(root: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root }).toString().trim();
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Refusing: tracked files differ from HEAD.');
  }
  const planBytes = await readFile(join(root, PLAN_PATH));
  const plan = JSON.parse(planBytes.toString('utf8')) as {
    probeId: string;
    pairs: string[];
    dates: string[];
  };
  const requests = probeRequests(plan);
  const out = join(root, OUT_DIR);
  await mkdir(join(root, '.zerochart-market-data'), { recursive: true });
  await mkdir(out); // EEXIST: the probe already ran
  await mkdir(join(out, 'raw'));
  const startedAt = new Date().toISOString();
  const { log, stopped } = await runProbe(requests, {
    fetchImpl: (url) => fetch(url, { signal: AbortSignal.timeout(12_000) }),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: Date.now,
    save: (name, bytes) => writeFile(join(out, name), bytes, { flag: 'wx' }),
  });
  const manifest = {
    probeId: plan.probeId,
    plan: { path: PLAN_PATH, sha256: sha256(planBytes) },
    commit: git('rev-parse', 'HEAD'),
    startedAt,
    finishedAt: new Date().toISOString(),
    requestsCounted: log.filter((entry) => entry.counted).length,
    rateLimitRetries: log.filter((entry) => !entry.counted).length,
    stopped,
    log,
  };
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = repositoryRoot();
  const validateOnly = process.argv.includes('--validate');
  (validateOnly ? Promise.resolve(null) : fetchProbe(root))
    .then(async (manifest) => {
      if (manifest) {
        const { requestsCounted, rateLimitRetries, stopped } = manifest;
        console.log(JSON.stringify({ requestsCounted, rateLimitRetries, stopped }));
      }
      const { summary, ohlcParityWithV1 } = await validateProbe(root);
      console.log(JSON.stringify({ summary, ohlcParity: ohlcParityWithV1 }, null, 2));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
