// The policy, verification and freshness rules live in one runtime-neutral module that the
// board, the Node collector and the daily-discovery Edge Function all load.
export * from '../../supabase/functions/_shared/dailyDiscovery';
