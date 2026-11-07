import { vi } from 'vitest';
import { TRADINGVIEW_SAVED_SCANS_ROUTE } from '@/lib/tradingViewDevScan';

type Respond = (url: string, init?: RequestInit) => Promise<Response>;

/** An empty scan store, as the saved-scan list route answers it. */
export const noSavedScans: Respond = async () =>
  new Response(JSON.stringify({ scans: [], unreadable: 0 }));

/**
 * Stubs `fetch`: the saved-scan routes go to `saved` (an empty store by default), every
 * other read to `published`, so a test's `published` mock counts only its own reads.
 */
export function stubLocalRoutes(published: Respond, saved: Respond = noSavedScans) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url.startsWith(TRADINGVIEW_SAVED_SCANS_ROUTE) ? saved(url, init) : published(url, init),
  );
}
