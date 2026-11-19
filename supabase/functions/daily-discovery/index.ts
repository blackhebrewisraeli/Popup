// Daily discovery from the Edge runtime: handler.ts holds the logic and its refusals. Deploy and
// schedule only with the owner's go-ahead (docs/MARKET_SCANNER.md#edge-collector-not-deployed).
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../src/integrations/supabase/types.ts';
import { handleDailyDiscovery } from './handler.ts';

Deno.serve((req) =>
  handleDailyDiscovery(req, {
    env: (name) => Deno.env.get(name),
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    createClient: (url, key, options) => createClient<Database>(url, key, options),
    randomUUID: () => crypto.randomUUID(),
    log: console.log,
  }),
);
