// Daily discovery from the Supabase Edge runtime, where GitHub-hosted runners get HTTP 451 from
// Binance (docs/MARKET_SCANNER.md#edge-collector-not-deployed). It runs the Node collector's own
// lifecycle (_shared/dailyDiscoveryRun.ts): same policy, endpoints, evidence and storage.
//
// Refusals come first and touch nothing: POST only, a project secret key (as for the scheduled
// feeds), SB_REGION exactly eu-west-1, DISCOVERY_EDGE_ENABLED exactly "true", and every setting
// present. Only then does it sign in, as the discovery_automation user, through the publishable key
// with no stored session, so RLS and the insert-only grants decide what it may write. It never
// reads a secret key for storage. The caller can't choose the slot, clock, endpoint or policy.
import type { SupabaseClient, SupabaseClientOptions } from '@supabase/supabase-js';
import type { Database } from '../../../src/integrations/supabase/types.ts';
import {
  runDailyDiscovery,
  SUCCESSFUL_RUNS,
  summaryLines,
  supabaseDiscoveryStore,
  type DiscoveryRunSummary,
} from '../_shared/dailyDiscoveryRun.ts';

/** Where the scheduled feeds run (x-region), next to the database, and where Binance answered. */
export const DISCOVERY_EDGE_REGION = 'eu-west-1';
/** Off unless this function secret is exactly "true". */
export const ENABLE_FLAG = 'DISCOVERY_EDGE_ENABLED';
/** Function secrets for the dedicated automation user; SUPABASE_ is reserved by the platform. */
export const EMAIL_SECRET = 'DISCOVERY_AUTOMATION_EMAIL';
export const PASSWORD_SECRET = 'DISCOVERY_AUTOMATION_PASSWORD';

/** The whole invocation, under hosted Edge Functions' 150 s wall-clock limit. */
export const INVOCATION_BUDGET_MS = 140_000;
/** Kept back from collection for the batch insert, a duplicate check, the attempt row, sign-out. */
export const PERSISTENCE_RESERVE_MS = 35_000;
/** Any one Supabase request: sign-in, read, insert or sign-out. */
export const STORAGE_REQUEST_TIMEOUT_MS = 10_000;

export interface DailyDiscoveryDeps {
  env: (name: string) => string | undefined;
  /** Binance, and (bounded) Supabase. */
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  createClient: (
    url: string,
    key: string,
    options: SupabaseClientOptions<'public'>,
  ) => SupabaseClient<Database>;
  randomUUID: () => string;
  log: (line: string) => void;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** A JSON object of named keys, as the platform sets them; empty when unset or unreadable. */
function namedKeys(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function settings(env: DailyDiscoveryDeps['env']) {
  const publishable = namedKeys(env('SUPABASE_PUBLISHABLE_KEYS'))['default'];
  const values = {
    SUPABASE_URL: env('SUPABASE_URL'),
    'SUPABASE_PUBLISHABLE_KEYS.default': typeof publishable === 'string' ? publishable : undefined,
    [EMAIL_SECRET]: env(EMAIL_SECRET),
    [PASSWORD_SECRET]: env(PASSWORD_SECRET),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  return { values, missing };
}

/**
 * Supabase requests through `fetch`, each ending by STORAGE_REQUEST_TIMEOUT_MS and by the
 * invocation's deadline, whichever is first. Past the deadline it refuses without a request.
 */
export function boundedFetch(deps: Pick<DailyDiscoveryDeps, 'fetch' | 'now'>, deadline: number) {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      return Promise.reject(new DOMException('Invocation budget exhausted', 'TimeoutError'));
    }
    const timeout = AbortSignal.timeout(Math.min(STORAGE_REQUEST_TIMEOUT_MS, remaining));
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return deps.fetch(input, { ...init, signal });
  }) as typeof fetch;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Counts, times and status: no pair, volume or evidence. */
function answer(summary: DiscoveryRunSummary) {
  return {
    slot: summary.slot.date,
    status: summary.status,
    failureCode: summary.failureCode,
    detail: summary.detail,
    startedAt: iso(summary.startedAt),
    finishedAt: iso(summary.finishedAt),
    evidenceSha256: summary.evidenceSha256,
    coverage: summary.coverage,
  };
}

/** One invocation: refuse, or sign in, run the due slot's lifecycle once and sign out. */
export async function handleDailyDiscovery(
  req: Request,
  deps: DailyDiscoveryDeps,
): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const apikey = req.headers.get('apikey');
  if (!apikey || !Object.values(namedKeys(deps.env('SUPABASE_SECRET_KEYS'))).includes(apikey)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const region = deps.env('SB_REGION') ?? null;
  if (region !== DISCOVERY_EDGE_REGION) {
    return json({ error: 'Wrong region', region, expected: DISCOVERY_EDGE_REGION }, 421);
  }
  if (deps.env(ENABLE_FLAG) !== 'true') {
    return json({ error: 'Daily discovery is disabled here', flag: ENABLE_FLAG }, 503);
  }
  const { values, missing } = settings(deps.env);
  if (missing.length > 0) return json({ error: 'Not configured', missing }, 500);

  const startedAt = deps.now();
  const deadline = startedAt + INVOCATION_BUDGET_MS;
  const client = deps.createClient(
    values.SUPABASE_URL as string,
    values['SUPABASE_PUBLISHABLE_KEYS.default'] as string,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedFetch(deps, deadline) },
    },
  );
  const signIn = await client.auth
    .signInWithPassword({
      email: values[EMAIL_SECRET] as string,
      password: values[PASSWORD_SECRET] as string,
    })
    .catch(() => null);
  if (!signIn || signIn.error || !signIn.data.user) {
    deps.log(JSON.stringify({ fn: 'daily-discovery', event: 'stopped', reason: 'sign-in' }));
    return json({ status: 'stopped', reason: 'Discovery storage sign-in failed' }, 502);
  }
  try {
    if (signIn.data.user.app_metadata['role'] !== 'discovery_automation') {
      return json(
        { status: 'stopped', reason: 'The sign-in lacks the discovery_automation role' },
        500,
      );
    }
    const summary = await runDailyDiscovery({
      store: supabaseDiscoveryStore(client),
      attemptId: `edge-${deps.randomUUID()}`,
      deps: {
        fetch: deps.fetch,
        now: deps.now,
        sleep: deps.sleep,
        collectBy: deadline - PERSISTENCE_RESERVE_MS,
      },
    });
    deps.log(summaryLines(summary).join('\n'));
    return json(answer(summary), SUCCESSFUL_RUNS.has(summary.status) ? 200 : 502);
  } catch (error) {
    // The attempt row itself could not be recorded: the slot keeps whatever it had.
    const reason = error instanceof Error ? error.message : String(error);
    deps.log(JSON.stringify({ fn: 'daily-discovery', event: 'stopped', reason }));
    return json({ status: 'stopped', reason }, 500);
  } finally {
    // This session only: a global sign-out would end any other session of the user.
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
  }
}
