/**
 * Unattended daily discovery collector (docs/MARKET_SCANNER.md#daily-discovery-binance-spot-unattended).
 * Run by .github/workflows/daily-discovery.yml on a fresh runner: no browser, tab, agent session
 * or owner token. It signs in as the dedicated `discovery_automation` user, which can only add
 * and read discovery rows, reads Binance's public Spot market data, and records exactly one
 * batch per slot plus one attempt row per run. It never writes assets_status, a research
 * campaign or a notification. The lifecycle is shared with the daily-discovery Edge Function
 * (supabase/functions/_shared/dailyDiscoveryRun.ts); this file adds only the Node entry point.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import type { Database } from '@/integrations/supabase/types';
import {
  runDailyDiscovery,
  summaryLines,
  supabaseDiscoveryStore,
  SUCCESSFUL_RUNS,
} from '../supabase/functions/_shared/dailyDiscoveryRun';
import { writeSummary } from './campaignAutomation';

export * from '../supabase/functions/_shared/dailyDiscoveryRun';

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
