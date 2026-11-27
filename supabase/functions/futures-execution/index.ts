// Owner-approved Binance USDⓈ-M Futures execution: handler.ts holds the logic and refusals. Off by
// default. Deploy, set secrets, register the webhook and schedule, and activate only on the owner's
// own decision (docs/FUTURES_EXECUTION.md).
import { createClient } from '@supabase/supabase-js';
import { handleFutures } from './handler.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

Deno.serve((req) =>
  handleFutures(req, {
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
