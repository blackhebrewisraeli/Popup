import type { ReactNode } from 'react';
import type { ScanComparison } from '@/lib/scanChanges';
import { ScanReview } from '@/components/ScanReview';
import {
  scanStatusLabel,
  type MarketScan,
  type ScanAssetResult,
  type ScanCohort,
  type ScanStatus,
} from '@/lib/marketScanner';
import {
  ageLabel,
  CLASS_LABEL,
  cohortFreshness,
  dataAsOfLabel,
  PROVIDER_LABEL,
  UTC_TIME,
} from '@/lib/scanReview';
import {
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  type TradingViewDevSource,
} from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<ScanStatus, string> = {
  COMPLETE: 'Complete',
  PARTIAL: 'Incomplete',
  FAILED: 'Failed',
};

const UTC_CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
});

/** "30 Oct, 17:54–17:55 UTC": when the agent session retrieved the bars. */
function retrievalLabel({ startedAt, completedAt }: TradingViewDevSource['retrieval']): string {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  const sameDay = startedAt.slice(0, 10) === completedAt.slice(0, 10);
  return `${UTC_TIME.format(start)}–${(sameDay ? UTC_CLOCK : UTC_TIME).format(end)} UTC`;
}

/** The candle sources this scan scored from, so two scans on one page cannot be mistaken. */
function sourcesLabel(scan: MarketScan): string {
  const providers = scan.cohorts.flatMap((cohort) =>
    cohort.status === 'UNSUPPORTED' || !cohort.provider
      ? []
      : [PROVIDER_LABEL[cohort.provider] ?? cohort.provider],
  );
  return [...new Set(providers)].join(' + ') || 'No candle source';
}

function universeLabel(source: string): string {
  if (source === TRADINGVIEW_DEV_UNIVERSE_SOURCE) return 'requested';
  return source === 'assets_status' ? 'in the Markets universe' : 'in the sample preview universe';
}

/** How a timeframe's days are cut, per scanned class. */
const DAY_BASIS: Record<ScanCohort['assetClass'], string> = {
  crypto: 'UTC days',
  equity: 'New York sessions',
  forex: 'not scanned',
};

/** One fact in the scan header: a label, its value, and an optional quieter line under it. */
function Fact({
  label,
  value,
  detail,
}: Readonly<{ label: string; value: ReactNode; detail?: ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail && <dd className="market-scan-sub">{detail}</dd>}
    </div>
  );
}

/** Where a development scan's bars came from, and what it does not establish. */
function DevSourceNotes({
  scan,
  source,
}: Readonly<{ scan: MarketScan; source: TradingViewDevSource }>) {
  const requested = new Set(Object.values(source.symbols));
  const asOfLabel = scan.cohorts[0] ? dataAsOfLabel(scan.cohorts[0]) : null;
  const alerted = source.pineAlerts?.symbols.filter((symbol) => requested.has(symbol)) ?? [];
  let alerts = 'TradingView alerts were not checked.';
  if (source.pineAlerts) {
    alerts =
      alerted.length === 0
        ? `No TradingView alert exists on any of these symbols (checked ${UTC_TIME.format(Date.parse(source.pineAlerts.checkedAt))} UTC), so none of these setups was emitted by Pine.`
        : `TradingView alerts exist on ${alerted.join(', ')}; a setup here is still Popup's calculation, not proof an alert fired.`;
  }
  return (
    <section className="market-scan-coverage" aria-label="Source and limitations">
      <h3 className="market-scan-label">Source and limitations</h3>
      <ul className="market-scan-list market-scan-notes">
        <li>
          Reloading this page re-reads this import; it does not fetch new TradingView bars, and
          nothing re-scans on a schedule. A new scan needs the owner&rsquo;s agent session to
          retrieve bars and run the import again (owner runbook in docs/MARKET_SCANNER.md). Its
          ranks, scores and coverage are never merged into the Market scan or the Markets directory.
        </li>
        <li>
          Daily bars retrieved by the owner&rsquo;s agent session through TradingView&rsquo;s MCP
          server ({source.tool}, {source.interval}) from{' '}
          {UTC_TIME.format(Date.parse(source.retrieval.startedAt))} to{' '}
          {UTC_TIME.format(Date.parse(source.retrieval.completedAt))} UTC, then imported and scored
          locally. The app has no TradingView connection; this is a development scan, not a licensed
          product feed, and it does not refresh.
        </li>
        <li>TradingView&rsquo;s notice: &ldquo;{source.notice}&rdquo;</li>
        <li>
          Split-adjusted only: dividends are not adjusted, and TradingView reports no split events,
          so an unadjusted split could not be cross-checked.
        </li>
        <li>
          The notice&rsquo;s &ldquo;still forming&rdquo; bar is never scored: a session counts only
          once final (9h after its close), and each score rests on the last{' '}
          {scan.cohorts[0]?.minClosedCandles} final sessions ({asOfLabel ?? 'none evaluated'}). Data
          may be delayed under the owner&rsquo;s plan.
        </li>
        <li>{alerts}</li>
        <li>Universe: {source.selectionRule}</li>
      </ul>
    </section>
  );
}

function unsupportedBreakdown(results: readonly ScanAssetResult[]): string {
  const count = (assetClass: ScanAssetResult['assetClass']) =>
    results.filter((result) => result.status === 'UNSUPPORTED' && result.assetClass === assetClass)
      .length;
  const equities = count('equity');
  const forex = count('forex');
  return [
    equities > 0 && `${equities} ${equities === 1 ? 'equity' : 'equities'}`,
    forex > 0 && `${forex} forex`,
  ]
    .filter(Boolean)
    .join(', ');
}

function CachedAge({ result, scan }: Readonly<{ result: ScanAssetResult; scan: MarketScan }>) {
  if (!result.cached || result.fetchedAt === null) return null;
  return (
    <span className="market-scan-fit">
      Cached data, fetched {ageLabel(scan.evaluationTime - result.fetchedAt)} before this scan
    </span>
  );
}

/** "2 from cache, fetched up to 3h 05m before this scan"; null when nothing was cached. */
function cacheLabel(members: readonly ScanAssetResult[], evaluationTime: number): string | null {
  const ages = members.flatMap((result) =>
    result.cached && result.fetchedAt !== null ? [evaluationTime - result.fetchedAt] : [],
  );
  if (ages.length === 0) return null;
  return `${ages.length} from cache, fetched up to ${ageLabel(Math.max(...ages))} before this scan`;
}

function CohortRow({ cohort, scan }: Readonly<{ cohort: ScanCohort; scan: MarketScan }>) {
  const { coverage } = cohort;
  const members = scan.results.filter((result) => result.assetClass === cohort.assetClass);
  const unsupported = cohort.status === 'UNSUPPORTED';
  // Source, policy and data time are the scan header's; only why a class was skipped is new here.
  const source = unsupported
    ? (members.find((result) => result.status === 'UNSUPPORTED')?.detail ??
      'No validated daily candle source.')
    : null;
  return (
    <li className="market-scan-cohort">
      <span className="market-scan-cohort-name">
        {CLASS_LABEL[cohort.assetClass]}{' '}
        <span className="market-scan-rule">{cohort.timeframe.toUpperCase()}</span>
      </span>
      <span className="market-scan-cohort-count">
        {unsupported
          ? `Not scanned · ${coverage.configured}`
          : `${coverage.evaluated} of ${coverage.supported} evaluated`}
      </span>
      {source && <span className="market-scan-rationale">{source}</span>}
    </li>
  );
}

/**
 * What a Markets scan covered and found: universe, coverage, freshness, and
 * every evaluated asset for review, each explainable from its recorded values.
 * Setups are chart conditions, not orders — there is nothing to execute here.
 */
export function MarketScanSummary({
  scan,
  completedAt,
  scanning,
  failed,
  source,
  changes,
}: Readonly<{
  scan: MarketScan | undefined;
  completedAt: number;
  scanning: boolean;
  failed: boolean;
  /** Set for the local TradingView development scan, which adds its provenance and full ranking. */
  source?: TradingViewDevSource;
  /** The TradingView import against the earlier one the owner named. */
  changes?: ScanComparison;
}>) {
  if (!scan) {
    return (
      <section className="market-scan" aria-label="Market scan" aria-busy={scanning}>
        <header className="market-scan-head">
          <h2 className="market-scan-title">Market scan</h2>
        </header>
        <p className="market-scan-empty" role={failed ? 'alert' : 'status'}>
          {failed ? 'The market scan could not run. Scores are unavailable.' : 'Scanning…'}
        </p>
      </section>
    );
  }
  const failures = scan.results.filter(
    (result) => result.status !== 'EVALUATED' && result.status !== 'UNSUPPORTED',
  );
  const { coverage } = scan;
  const title = source ? 'TradingView development scan' : 'Market scan';
  const scanned = scan.cohorts.filter((cohort) => cohort.status !== 'UNSUPPORTED');
  const now = Date.now();
  const freshness = scanned.flatMap((cohort) => cohortFreshness(cohort, now) ?? []);
  const stale = freshness.some((item) => item.stale);
  const policies = [...new Set(scanned.map((cohort) => cohort.candlePolicyVersion))];
  const cached = scanned.flatMap(
    (cohort) =>
      cacheLabel(
        scan.results.filter((result) => result.assetClass === cohort.assetClass),
        scan.evaluationTime,
      ) ?? [],
  );
  const coverageDetail = [
    `${coverage.configured} ${universeLabel(scan.universe.source)}`,
    coverage.notEvaluated > 0 && `${coverage.notEvaluated} failed`,
    coverage.unsupported > 0 &&
      `${coverage.unsupported} not scanned (${unsupportedBreakdown(scan.results)})`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section className={cn('market-scan', source && 'market-scan-devscan')} aria-label={title}>
      <header className="market-scan-head">
        <div className="market-scan-heading">
          <h2 className="market-scan-title">{title}</h2>
          <p className="market-scan-state">
            <span className={cn('market-scan-status', `market-scan-${scan.status.toLowerCase()}`)}>
              {STATUS_LABEL[scan.status]}
            </span>
            {stale && <span className="market-scan-status market-scan-partial">Stale</span>}
            {source && (
              <span className="market-scan-status market-scan-dev">Historical dev import</span>
            )}
            <span>
              {scanning ? 'Re-scanning… · ' : ''}
              {source ? 'Imported' : 'Completed'} {UTC_TIME.format(completedAt)} UTC
            </span>
          </p>
        </div>
        <dl className="market-scan-stats">
          <Fact
            label="Source"
            value={sourcesLabel(scan)}
            detail={[`model ${scan.modelVersion}`, ...policies].filter(Boolean).join(' · ')}
          />
          <Fact
            label="Timeframe"
            value={scan.timeframe.toUpperCase()}
            detail={scanned.map((cohort) => DAY_BASIS[cohort.assetClass]).join(' · ') || null}
          />
          <Fact
            label="Data as of"
            value={scanned.map(dataAsOfLabel).filter(Boolean).join('; ') || 'None evaluated'}
            detail={
              (freshness.length > 0 || cached.length > 0) && (
                <>
                  <span className={cn(stale && 'scan-stale')}>
                    {freshness.map((item) => item.detail).join('; ')}
                  </span>
                  {cached.length > 0 && <span className="block">{cached.join('; ')}</span>}
                </>
              )
            }
          />
          <Fact
            label="Coverage"
            value={`${coverage.evaluated} of ${coverage.supported} evaluated`}
            detail={coverageDetail}
          />
          {source && (
            <Fact
              label="Retrieved"
              value={retrievalLabel(source.retrieval)}
              detail="Owner's agent session; does not refresh"
            />
          )}
        </dl>
      </header>
      {scanned.length > 0 && <ScanReview scan={scan} source={source} changes={changes} />}
      {failures.length > 0 && (
        <section className="market-scan-failures" aria-label="Not evaluated this scan">
          <h3 className="market-scan-label">Not evaluated this scan</h3>
          <ul className="market-scan-list">
            {failures.map((result) => (
              <li key={result.ticker} className="market-scan-failure">
                <span className="market-scan-ticker">{result.ticker}</span>
                <span className="market-scan-fail-code">{scanStatusLabel(result)}</span>
                <span className="market-scan-rationale">{result.detail}</span>
                <CachedAge result={result} scan={scan} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {scan.cohorts.length > 1 && (
        <section className="market-scan-coverage" aria-label="Coverage by asset class">
          <h3 className="market-scan-label">Coverage by asset class and timeframe</h3>
          <ul className="market-scan-list">
            {scan.cohorts.map((cohort) => (
              <CohortRow key={cohort.assetClass} cohort={cohort} scan={scan} />
            ))}
          </ul>
        </section>
      )}
      {source && <DevSourceNotes scan={scan} source={source} />}
    </section>
  );
}
