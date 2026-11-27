// Owner-approved Binance USDⓈ-M Futures Demo execution: handler.ts holds the logic and refusals.
// Deploy, set secrets and register the webhook and schedule only with the owner's go-ahead
// (docs/FUTURES_DEMO_EXECUTION.md).
import { createClient } from '@supabase/supabase-js';
import { handleFuturesDemo } from './handler.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((req) =>
  handleFuturesDemo(req, {
    env: (name) => Deno.env.get(name),
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    randomUUID: () => crypto.randomUUID(),
    log: console.log,
    createClient: (url, key) =>
      createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      }),
    background: (work) => EdgeRuntime.waitUntil(work),
  }),
);
