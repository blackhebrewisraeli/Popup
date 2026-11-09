// Owner-only, read-only Binance Spot balances for the Account view.
// verify_jwt stays on (supabase/config.toml); handler.ts then asks Supabase
// Auth who the caller is and serves only BINANCE_SPOT_OWNER_USER_ID.
// Setup and boundaries: docs/BINANCE_SPOT_ACCOUNT.md.
import { handleSpotAccount } from './handler.ts';

Deno.serve((req) =>
  handleSpotAccount(req, { env: (name) => Deno.env.get(name), fetch, log: console.log }),
);
