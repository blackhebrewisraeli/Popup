import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Radar, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { Segmented } from '@/components/Segmented';
import { Button } from '@/components/ui/button';
import { compareScans } from '@/lib/scanChanges';
import { UTC_TIME } from '@/lib/scanReview';
import {
  parseTradingViewDevScan,
  TRADINGVIEW_DEV_SCAN_ROUTE,
  type TradingViewDevScan as DevScan,
} from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

type DevScanQuery = UseQueryResult<DevScan | null>;

const READ_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The section's frame while there is no scan to show, so it is never mistaken for the Market scan. */
function DevScanState({
  busy = false,
  alert = false,
  children,
}: Readonly<{ busy?: boolean; alert?: boolean; children: ReactNode }>) {
  return (
    <section
      className="market-scan market-scan-devscan"
      aria-label="TradingView development scan"
      aria-busy={busy}
    >
      <div className="market-scan-head">
        <span className="market-scan-title">
          <Radar size={14} /> TradingView development scan
        </span>
      </div>
      <p role={alert ? 'alert' : undefined} className="market-scan-empty">
        {children}
      </p>
    </section>
  );
}

/**
 * The local import, shared by the picker and the review: entering the review never
 * re-reads it, so both always show the same state. Only "Reload local scan" (or a page
 * reload) re-reads the file; nothing here fetches bars or polls.
 */
function useTradingViewDevScan() {
  return useQuery({
    queryKey: ['tradingview-dev-scan'],
    queryFn: async () => {
      const response = await fetch(TRADINGVIEW_DEV_SCAN_ROUTE, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw: unknown = await response.json().catch(() => {
        throw new Error('The file is not valid JSON.');
      });
      return parseTradingViewDevScan(raw);
    },
    enabled: import.meta.env.DEV,
    // Not Infinity: a failed reload marks the kept snapshot invalidated, and an invalidated
    // query re-reads on focus, reconnect or remount. 'static' never re-reads by itself.
    staleTime: 'static',
    retryOnMount: false,
    retry: false,
  });
}

/**
 * Re-reads the file the dev route serves, on request only: never TradingView, an agent or
 * a scan. A click during a read joins it instead of starting another. After a failed read
 * the earlier snapshot stays on screen, named, and never presented as the published one.
 */
function ReloadLocalScan({ query }: Readonly<{ query: DevScanQuery }>) {
  const reading = query.isFetching;
  const shown = query.data;
  let status: ReactNode = null;
  // The first read has its own message in the panel below.
  if (reading) status = query.isPending ? null : 'Reading the local file…';
  else if (shown && !query.isError) {
    status = (
      <>
        Scan <code>{shown.scanId}</code> · local file read {READ_TIME.format(query.dataUpdatedAt)}{' '}
        UTC
      </>
    );
  }
  return (
    <div className="devscan-reload">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled={reading}
        onClick={() => void query.refetch({ cancelRefetch: false })}
      >
        <RefreshCw className={cn(reading && 'animate-spin')} aria-hidden="true" />
        Reload local scan
      </Button>
      <p className="devscan-reload-status" role="status">
        {status}
      </p>
      {!reading && query.isError && shown && (
        <p className="devscan-reload-failed" role="alert">
          Reload failed ({query.error.message}). Still showing scan <code>{shown.scanId}</code>,
          imported {UTC_TIME.format(Date.parse(shown.importedAt))} UTC; it may not be the published
          scan.
        </p>
      )}
    </div>
  );
}

function DevScanContent({ query }: Readonly<{ query: DevScanQuery }>) {
  if (query.isPending) {
    return <DevScanState busy>Reading the local TradingView import…</DevScanState>;
  }
  const view = query.data;
  if (view) {
    const { scanId, importedAt, scan, source, baseline } = view;
    // A different snapshot starts the review over: no selection, comparison or open
    // evidence carries across. An identical reload keeps the same key and the review.
    return (
      <MarketScanSummary
        key={`${scanId}|${importedAt}|${baseline?.scanId ?? ''}`}
        scan={scan}
        completedAt={Date.parse(importedAt)}
        scanning={false}
        failed={false}
        source={source}
        changes={compareScans(view, baseline)}
        choice={view}
      />
    );
  }
  if (query.isError) {
    return (
      <DevScanState alert>
        The TradingView development scan could not be read ({query.error.message}). Re-run{' '}
        <code>npm run evaluate -- tradingview-import</code>.
      </DevScanState>
    );
  }
  return (
    <DevScanState>
      No TradingView scan is published on this machine (the local view file is missing), and the
      Market scan does not include one. The owner&rsquo;s agent session retrieves the bars; then{' '}
      <code>npm run evaluate -- tradingview-import</code> scores them (owner runbook in
      docs/MARKET_SCANNER.md).
    </DevScanState>
  );
}

/**
 * The local TradingView development scan, under `vite dev` only. Loading,
 * nothing published and an unreadable file each say so; a partial scan is
 * never shown from a malformed file.
 */
export function TradingViewDevScan() {
  const query = useTradingViewDevScan();
  return (
    <>
      <ReloadLocalScan query={query} />
      <DevScanContent query={query} />
    </>
  );
}

export type MarketsSource = 'market-data' | 'tradingview';

/**
 * Which source the scan reviews, under `vite dev` only. Research renders one
 * source's review at a time; switching unmounts the other, so no selection,
 * explanation or comparison carries across.
 */
export function MarketsSourcePicker({
  source,
  onSource,
}: Readonly<{ source: MarketsSource; onSource: (source: MarketsSource) => void }>) {
  const query = useTradingViewDevScan();
  let state = 'None';
  if (query.isPending) state = 'Loading';
  else if (query.isFetching) state = 'Reloading';
  // Short enough for the picker at phone width; the alert above the review names the failure.
  else if (query.isError) state = query.data ? 'Failed' : 'Unreadable';
  else if (query.data) state = String(query.data.scan.coverage.evaluated);
  return (
    <Segmented
      value={source}
      ariaLabel="Markets source"
      className="scan-views markets-source"
      onChange={onSource}
      options={[
        { value: 'market-data', label: 'Market data' },
        {
          value: 'tradingview',
          label: (
            <>
              TradingView import <span className="segment-tag">{state}</span>
            </>
          ),
        },
      ]}
    />
  );
}
