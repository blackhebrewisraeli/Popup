// Read-only Binance reachability preflight for daily discovery: no database client, no writes.
// verify_jwt is off (supabase/config.toml), as for the feeds; handler.ts requires a project secret
// key and eu-west-1. Deploy and invoke only with the owner's go-ahead: docs/MARKET_SCANNER.md#activation.
import { handleDiscoveryPreflight } from './handler.ts';

Deno.serve((req) =>
  handleDiscoveryPreflight(req, {
    env: (name) => Deno.env.get(name),
    fetch,
    now: Date.now,
    log: console.log,
  }),
);
