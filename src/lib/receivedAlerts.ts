// The owner's most recent received TradingView alerts, read from the existing
// trading_signals table (rows the tv-webhook function recorded). Owner-only
// SELECT RLS applies to the query and to the Realtime channel alike; this
// module never writes.
import type { QueryClient } from '@tanstack/react-query';
import { clearSpotBalanceSession } from '@/lib/spotBalanceSession';
import { supabase } from '@/lib/supabaseClient';

export const RECEIVED_ALERT_LIMIT = 5;

export interface ReceivedAlert {
  id: string;
  ticker: string;
  action: string;
  /** When the server recorded the alert. */
  created_at: string;
}

export const receivedAlertsKey = (userId: string) => ['received-alerts', userId] as const;

/** The newest RECEIVED_ALERT_LIMIT alerts recorded for `userId`, newest first. */
export async function fetchReceivedAlerts(userId: string): Promise<ReceivedAlert[]> {
  const { data, error } = await supabase
    .from('trading_signals')
    .select('id, ticker, action, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(RECEIVED_ALERT_LIMIT);
  if (error) throw new Error(error.message);
  return data;
}

export type LiveStatus = 'connecting' | 'live' | 'unavailable';

/**
 * Listens for alerts inserted for `userId`. `onChange` runs for each insert
 * and after every (re)connect, so anything missed while disconnected is
 * reconciled by a fresh read. Returns the unsubscribe.
 */
export function watchReceivedAlerts(
  userId: string,
  onChange: () => void,
  onStatus: (status: LiveStatus) => void,
): () => void {
  const channel = supabase
    .channel(`received-alerts-${userId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'trading_signals',
        filter: `user_id=eq.${userId}`,
      },
      onChange,
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        onStatus('live');
        onChange();
      } else {
        onStatus('unavailable');
      }
    });
  return () => void supabase.removeChannel(channel);
}

/**
 * Forgets owner summary data that does not belong to `keep`: the shared
 * balance read and any cached received alerts. Runs on logout, a session
 * change and loss of owner access.
 */
export function forgetOwnerSummary(queryClient: QueryClient, keep: string | null): void {
  clearSpotBalanceSession(keep);
  queryClient.removeQueries({
    queryKey: ['received-alerts'],
    predicate: (query) => query.queryKey[1] !== keep,
  });
}
