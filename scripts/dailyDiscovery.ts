/**
 * Unattended daily discovery collector (docs/MARKET_SCANNER.md#daily-discovery-binance-spot-unattended).
 * Run by .github/workflows/daily-discovery.yml on a fresh runner: no browser, tab, agent session
 * or owner token. It signs in as the dedicated `discovery_automation` user, which can only add
 * and read discovery rows, reads Binance's public Spot market data, and records exactly one
 * batch per slot plus one attempt row per run. It never writes assets_status, a research
 * campaign or a notification.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { Database, Json } from '@/integrations/supabase/types';
import {
  DISCOVERY_POLICY,
  DISCOVERY_POLICY_ID,
  DISCOVERY_SCHEMA_VERSION,
  discoveryPolicySha256,
  dueSlot,
  eligibleSymbols,
  evidenceSha256,
  parseExchangeInfo,
  parseTickers,
  selectCandidates,
  type DiscoveryAttemptStatus,
  type DiscoveryEvidence,
  type DiscoveryFailureCode,
  type DiscoveryResult,
  type DiscoverySlot,
} from '@/lib/dailyDiscovery';
import { writeSummary } from './campaignAutomation';

export class CollectionFailure extends Error {
  constructor(
    readonly code: DiscoveryFailureCode,
    message: string,
  ) {
    super(message);
  }
}

export class DiscoveryStoreError extends Error {}

/** Bounds on every Binance request; a run makes two requests, each tried at most `attempts` times. */
export interface RequestBounds {
  timeoutMs: number;
  attempts: number;
  /** Pause before the 2nd, 3rd … try after a timeout, network error or 5xx. */
  backoffMs: readonly number[];
  /** A 429 is retried only when Binance names a Retry-After no longer than this. */
  maxRetryAfterMs: number;
}

export const REQUEST_BOUNDS: RequestBounds = {
  timeoutMs: 30_000,
  attempts: 3,
  backoffMs: [2_000, 8_000],
  maxRetryAfterMs: 60_000,
};

export interface CollectorDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  bounds?: RequestBounds;
}

const isTimeout = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

async function requestJson(
  url: string,
  deps: CollectorDeps,
): Promise<{ body: unknown; requestedAt: number; receivedAt: number }> {
  const bounds = deps.bounds ?? REQUEST_BOUNDS;
  const label = new URL(url).pathname;
  for (let attempt = 1; ; attempt += 1) {
    const retry = attempt < bounds.attempts;
    const pause = bounds.backoffMs[attempt - 1] ?? bounds.backoffMs.at(-1) ?? 0;
    const requestedAt = deps.now();
    let response: Response;
    try {
      response = await deps.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(bounds.timeoutMs),
      });
    } catch (error) {
      if (retry) {
        await deps.sleep(pause);
        continue;
      }
      throw isTimeout(error)
        ? new CollectionFailure('TIMEOUT', `${label} timed out ${attempt} times`)
        : new CollectionFailure('NETWORK_ERROR', `${label} unreachable after ${attempt} tries`);
    }
    // 418 means Binance banned the IP for ignoring 429s: never send another request.
    if (response.status === 418) throw new CollectionFailure('IP_BANNED', `${label}: HTTP 418`);
    if (response.status === 451) {
      throw new CollectionFailure('REGION_BLOCKED', `${label}: HTTP 451 from this runner's region`);
    }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
      if (retry && wait !== null && wait <= bounds.maxRetryAfterMs) {
        await deps.sleep(wait);
        continue;
      }
      throw new CollectionFailure(
        'RATE_LIMITED',
        `${label}: HTTP 429${wait === null ? '' : ` (Retry-After ${wait / 1000}s)`}`,
      );
    }
    if (response.status >= 500 && retry) {
      await deps.sleep(pause);
      continue;
    }
    if (!response.ok)
      throw new CollectionFailure('HTTP_ERROR', `${label}: HTTP ${response.status}`);
    try {
      const body: unknown = await response.json();
      return { body, requestedAt, receivedAt: deps.now() };
    } catch (error) {
      if (isTimeout(error)) throw new CollectionFailure('TIMEOUT', `${label} body timed out`);
      throw new CollectionFailure('RESPONSE_INVALID', `${label}: not JSON`);
    }
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One batch for `slot`: both responses are validated before anything is selected. A failed
 * or malformed response fails the whole collection: nothing is substituted, not a previous
 * batch, not sample assets, not assets_status.
 */
export async function collectDiscoveryEvidence(
  slot: DiscoverySlot,
  deps: CollectorDeps,
): Promise<DiscoveryEvidence> {
  const { source } = DISCOVERY_POLICY;
  const info = await requestJson(source.exchangeInfo, deps);
  const instruments = parseExchangeInfo(info.body);
  if (!instruments) {
    throw new CollectionFailure(
      'RESPONSE_INVALID',
      'exchangeInfo has no symbols list or serverTime',
    );
  }
  const ticker = await requestJson(source.ticker, deps);
  const figures = parseTickers(ticker.body, eligibleSymbols(instruments.usdtInstruments), ticker);
  if (!figures) throw new CollectionFailure('RESPONSE_INVALID', '24hr ticker is not a list');
  const inputs = {
    listedSymbols: instruments.listedSymbols,
    malformedInstruments: instruments.malformedInstruments,
    usdtInstruments: instruments.usdtInstruments,
    ...figures,
  };
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    policy: { id: DISCOVERY_POLICY_ID, sha256: await discoveryPolicySha256() },
    slot,
    collection: {
      exchangeInfo: {
        endpoint: source.exchangeInfo,
        requestedAt: iso(info.requestedAt),
        receivedAt: iso(info.receivedAt),
        serverTime: instruments.serverTime,
      },
      ticker: {
        endpoint: source.ticker,
        requestedAt: iso(ticker.requestedAt),
        receivedAt: iso(ticker.receivedAt),
      },
      cutoff: iso(ticker.requestedAt),
    },
    inputs,
    result: selectCandidates(inputs),
  };
}

// ── Storage ──────────────────────────────────────────────────────────────────

type Tables = Database['public']['Tables'];
export type DiscoveryBatchInsert = Tables['discovery_batches']['Insert'];
export type DiscoveryAttemptInsert = Tables['discovery_attempts']['Insert'];

/** Insert-only: a duplicate key is reported, never overwritten. */
export interface DiscoveryStore {
  findBatch(policyId: string, slotDate: string): Promise<{ evidence_sha256: string } | null>;
  insertBatch(row: DiscoveryBatchInsert): Promise<'created' | 'duplicate'>;
  insertAttempt(row: DiscoveryAttemptInsert): Promise<'created' | 'duplicate'>;
}

/** Postgres error codes only: messages can quote evidence, and the repository is public. */
function storeError(action: string, error: { code?: string }): DiscoveryStoreError {
  return new DiscoveryStoreError(`${action} failed (${error.code ?? 'no code'})`);
}

export function supabaseDiscoveryStore(client: SupabaseClient<Database>): DiscoveryStore {
  return {
    async findBatch(policyId, slotDate) {
      const { data, error } = await client
        .from('discovery_batches')
        .select('evidence_sha256')
        .eq('policy_id', policyId)
        .eq('slot_date', slotDate)
        .maybeSingle();
      if (error) throw storeError('Reading the slot’s batch', error);
      return data;
    },
    async insertBatch(row) {
      const { error } = await client.from('discovery_batches').insert(row);
      if (!error) return 'created';
      if (error.code === '23505') return 'duplicate';
      throw storeError('Recording the batch', error);
    },
    async insertAttempt(row) {
      const { error } = await client.from('discovery_attempts').insert(row);
      if (!error) return 'created';
      if (error.code === '23505') return 'duplicate';
      throw storeError('Recording the attempt', error);
    },
  };
}

// ── One run ──────────────────────────────────────────────────────────────────

export interface DiscoveryRunSummary {
  attemptId: string;
  slot: DiscoverySlot;
  status: DiscoveryAttemptStatus;
  failureCode: DiscoveryFailureCode | null;
  detail: string | null;
  startedAt: number;
  finishedAt: number;
  evidenceSha256: string | null;
  coverage: DiscoveryResult['coverage'] | null;
}

/** Exit 0 for these; anything else leaves the slot without a batch from this run. */
export const SUCCESSFUL_RUNS: ReadonlySet<DiscoveryAttemptStatus> = new Set([
  'complete',
  'partial',
  'empty',
  'already_collected',
  'unchanged',
]);

/**
 * Collects the due slot at most once. A slot with a stored batch is never fetched again; a
 * run that starts at or after the slot's 06:00 UTC deadline, or finishes after it, stores no
 * batch and is recorded as missed or failed, never backdated. Concurrent runs race on the
 * database's primary key: the loser compares hashes and records `unchanged` or `conflict`,
 * leaving the stored batch as it was. Every run ends with one immutable attempt row.
 */
export async function runDailyDiscovery(options: {
  store: DiscoveryStore;
  attemptId: string;
  deps: CollectorDeps;
}): Promise<DiscoveryRunSummary> {
  const { store, deps } = options;
  const startedAt = deps.now();
  const slot = dueSlot(startedAt);
  const deadline = Date.parse(slot.retryDeadline);
  let status: DiscoveryAttemptStatus;
  let failureCode: DiscoveryFailureCode | null = null;
  let detail: string | null = null;
  let sha: string | null = null;
  let coverage: DiscoveryResult['coverage'] | null = null;

  const existing = await store.findBatch(DISCOVERY_POLICY_ID, slot.date);
  if (existing) {
    status = 'already_collected';
    sha = existing.evidence_sha256;
  } else if (startedAt >= deadline) {
    status = 'missed';
    detail = `Started ${iso(startedAt)}, at or after the ${slot.retryDeadline} retry deadline.`;
  } else {
    try {
      const evidence = await collectDiscoveryEvidence(slot, deps);
      sha = await evidenceSha256(evidence);
      coverage = evidence.result.coverage;
      if (deps.now() >= deadline) {
        throw new CollectionFailure(
          'DEADLINE_PASSED',
          `Collection finished after the ${slot.retryDeadline} retry deadline.`,
        );
      }
      const outcome = await store.insertBatch({
        policy_id: DISCOVERY_POLICY_ID,
        slot_date: slot.date,
        scheduled_for: slot.scheduledFor,
        collected_at: evidence.collection.ticker.receivedAt,
        status: evidence.result.status.toLowerCase(),
        member_count: evidence.result.members.length,
        evidence: evidence as unknown as Json,
        evidence_sha256: sha,
      });
      if (outcome === 'created') status = evidence.result.status.toLowerCase() as typeof status;
      else {
        const stored = await store.findBatch(DISCOVERY_POLICY_ID, slot.date);
        status = stored?.evidence_sha256 === sha ? 'unchanged' : 'conflict';
        if (status === 'conflict') detail = 'Another run stored different evidence for this slot.';
      }
    } catch (error) {
      if (error instanceof CollectionFailure) {
        status = 'failed';
        failureCode = error.code;
        detail = error.message;
      } else if (error instanceof DiscoveryStoreError) {
        status = 'failed';
        failureCode = 'STORE_ERROR';
        detail = error.message;
      } else throw error;
    }
  }
  const finishedAt = deps.now();
  await store.insertAttempt({
    attempt_id: options.attemptId,
    policy_id: DISCOVERY_POLICY_ID,
    slot_date: slot.date,
    scheduled_for: slot.scheduledFor,
    started_at: iso(startedAt),
    finished_at: iso(finishedAt),
    status,
    failure_code: failureCode,
    detail,
    evidence_sha256: status === 'failed' || status === 'missed' ? null : sha,
  });
  return {
    attemptId: options.attemptId,
    slot,
    status,
    failureCode,
    detail,
    startedAt,
    finishedAt,
    evidenceSha256: sha,
    coverage,
  };
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** Counts, times and status only: the repository and its run logs are public. */
export function summaryLines(summary: DiscoveryRunSummary): string[] {
  const late = summary.startedAt - Date.parse(summary.slot.scheduledFor);
  const { coverage } = summary;
  return [
    '## Daily discovery',
    '',
    `- Policy: ${DISCOVERY_POLICY_ID}`,
    `- Slot: ${summary.slot.date} 00:30 UTC (retry deadline 06:00 UTC)`,
    `- Status: ${summary.status}${summary.failureCode ? ` (${summary.failureCode})` : ''}`,
    `- Started: ${iso(summary.startedAt)}, ${minutes(late)} after the scheduled slot`,
    `- Finished: ${iso(summary.finishedAt)}`,
    coverage
      ? `- Coverage: ${coverage.selected} selected of ${coverage.eligible} eligible; ${coverage.invalid} without a valid 24h figure; ${coverage.malformed} malformed instruments`
      : '- Coverage: no batch collected by this run',
    '- Pairs, volumes and evidence: omitted because this repository is public',
  ];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

/** GitHub's run ID and attempt identify a scheduled or re-run job; locally, a random ID. */
function attemptIdFromEnvironment(): string {
  const run = process.env['GITHUB_RUN_ID'];
  const attempt = process.env['GITHUB_RUN_ATTEMPT'] ?? '1';
  return run && /^\d+$/.test(run) && /^\d+$/.test(attempt)
    ? `gh-${run}-${attempt}`
    : `local-${randomUUID()}`;
}

export async function main(): Promise<void> {
  const [url, key, email, password] = [
    'SUPABASE_URL',
    'SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_DISCOVERY_EMAIL',
    'SUPABASE_DISCOVERY_PASSWORD',
  ].map(required) as [string, string, string, string];
  const client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error('Discovery storage sign-in failed');
  if (data.user.app_metadata['role'] !== 'discovery_automation') {
    throw new Error('The discovery sign-in lacks the discovery_automation role');
  }
  try {
    const summary = await runDailyDiscovery({
      store: supabaseDiscoveryStore(client),
      attemptId: attemptIdFromEnvironment(),
      deps: {
        fetch,
        now: Date.now,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    });
    const lines = summaryLines(summary);
    console.log(lines.join('\n'));
    await writeSummary(lines);
    if (!SUCCESSFUL_RUNS.has(summary.status)) process.exitCode = 1;
  } finally {
    // This session only: a global sign-out would end any other session of the user.
    await client.auth.signOut({ scope: 'local' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`::error title=Daily discovery::${message.replace(/[\r\n%]/g, ' ')}`);
    await writeSummary(['## Daily discovery', '', `- Status: stopped (${message})`]).catch(
      () => undefined,
    );
    process.exitCode = 1;
  }
}
