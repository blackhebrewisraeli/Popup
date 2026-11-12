import { useMatch, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { lazy, memo, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUpRight,
  CandlestickChart,
  LogOut,
  Radio,
  RefreshCw,
  Search,
  TrendingDown,
  TrendingUp,
  UserRound,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { AssetIcon } from '@/components/AssetIcon';
import { BrokerModal } from '@/components/BrokerModal';
import { PriceAlerts } from '@/components/PriceAlerts';
import { LandingPage } from '@/components/LandingPage';
import { TourGuide } from '@/components/TourGuide';
import { Segmented } from '@/components/Segmented';
import { SetAlertButton } from '@/components/SetAlertModal';
import { FreshnessBadge } from '@/components/FreshnessBadge';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import {
  MarketsSourcePicker,
  TradingViewDevScan,
  type MarketsSource,
} from '@/components/TradingViewDevScan';
import {
  fetchAssets,
  formatChange,
  formatPrice,
  generateTrendData,
  getAssetClass,
  sampleAssets,
  type Asset,
  type AssetClass,
} from '@/lib/assets';
import { cn } from '@/lib/utils';
import { toBinanceSymbol } from '@/lib/binance';
import {
  compareTickers,
  scanStatusLabel,
  type MarketScan,
  type ScanAssetResult,
} from '@/lib/marketScanner';
import { useMarketScan } from '@/hooks/useMarketScan';
import { useResearchSource } from '@/hooks/useResearchSelection';
import { assetFreshness } from '@/lib/freshness';
import { useConnectionState, useLivePrice } from '@/lib/livePriceStore';
import type { User } from '@supabase/supabase-js';
import { useAuth } from '@/lib/authStore';
import { usePortfolio } from '@/lib/portfolioStore';
import { useHydrationState } from '@/lib/hydrationStore';
import { CLOSED_BETA } from '@/lib/closedBeta';
import { recordWalkForward } from '@/lib/engine/walkForwardLogger';
import { computePortfolioValuation } from '@/lib/portfolioAccounting';
import { useBinanceWebSocket } from '@/hooks/useBinanceWebSocket';
import { useAlertEngine } from '@/hooks/useAlertEngine';
import { usePriceFlash } from '@/hooks/usePriceFlash';
import { AssetsStatusContext } from '@/hooks/usePaperRisk';
import { BrandLogo } from '@/components/Brand';

// Loaded on demand so the zone panels, modals, recharts and lightweight-charts stay out of
// the Workspace chunk. SSR is unaffected: the server always renders the auth-loading shell.
const AssetDetailsModal = lazy(() =>
  import('@/components/AssetDetailsModal').then((m) => ({ default: m.AssetDetailsModal })),
);
const AuthModal = lazy(() =>
  import('@/components/AuthModal').then((m) => ({ default: m.AuthModal })),
);
const RoboAdvisor = lazy(() =>
  import('@/components/RoboAdvisor').then((m) => ({ default: m.RoboAdvisor })),
);
const PortfolioDashboard = lazy(() =>
  import('@/components/PortfolioDashboard').then((m) => ({ default: m.PortfolioDashboard })),
);
const PaperTradingTerminal = lazy(() =>
  import('@/components/PaperTradingTerminal').then((m) => ({ default: m.PaperTradingTerminal })),
);
const AccountPanel = lazy(() =>
  import('@/components/AccountPanel').then((m) => ({ default: m.AccountPanel })),
);
const Sparkline = lazy(() =>
  import('@/components/Sparkline').then((m) => ({ default: m.Sparkline })),
);

/** Holds the sparkline's grid cell while recharts loads. */
const sparklineFallback = <div className="sparkline" style={{ height: 30 }} aria-hidden="true" />;
const zoneFallback = <div aria-busy="true" className="skeleton h-96 w-full" />;

/** Canonical score from the Markets scan; null while scanning or when the scan could not score it. */
function scanScore(result: ScanAssetResult | undefined): number | null {
  return result?.model?.signal_score ?? null;
}

/** Why the scan has no score for an asset: muted, never a red "0". */
function NotScoredBadge({
  result,
  compact = false,
}: Readonly<{ result: ScanAssetResult; compact?: boolean }>) {
  return (
    <span
      className={cn('insufficient-data-badge', compact && 'is-compact')}
      title={result.detail ?? undefined}
    >
      {scanStatusLabel(result)}
    </span>
  );
}

type MarketView = 'signals' | 'gainers' | 'losers';
type AssetClassFilter = 'All' | AssetClass;

const MARKET_VIEWS: { id: MarketView; label: ReactNode }[] = [
  {
    id: 'signals',
    // The scan's own order: each asset class's ranking in turn, never a recommendation.
    label: 'Scan rank',
  },
  {
    id: 'gainers',
    label: (
      <>
        <TrendingUp size={14} /> Top Gainers
      </>
    ),
  },
  {
    id: 'losers',
    label: (
      <>
        <TrendingDown size={14} /> Top Losers
      </>
    ),
  },
];

// Crypto spot (Binance) leads: the closed beta evaluates it first.
const ASSET_CLASS_FILTERS: AssetClassFilter[] = ['Crypto', 'Stocks', 'Forex', 'All'];

type ScanResults = ReadonlyMap<string, ScanAssetResult>;

const CLASS_ORDER = { crypto: 0, equity: 1, forex: 2 } as const;

/**
 * Scan rank order: each asset class's own ranking in turn, crypto first, never
 * interleaved — the same score does not compare across classes. Unscored
 * assets (scanning, unsupported or failed) sink last, by ticker.
 */
function compareByScan(scores: ScanResults, a: Asset, b: Asset): number {
  const key = (asset: Asset) => {
    const result = scores.get(asset.ticker);
    return result?.rank == null ? [3, 0] : [CLASS_ORDER[result.assetClass], result.rank];
  };
  const [classA = 3, rankA = 0] = key(a);
  const [classB = 3, rankB = 0] = key(b);
  return classA - classB || rankA - rankB || compareTickers(a.ticker, b.ticker);
}

function sortMarkets(assets: Asset[], view: MarketView, scores: ScanResults): Asset[] {
  const list = [...assets];
  if (view === 'signals') return list.sort((a, b) => compareByScan(scores, a, b));
  if (view === 'gainers')
    return list.sort((a, b) => (b.change_24h ?? -Infinity) - (a.change_24h ?? -Infinity));
  return list.sort((a, b) => (a.change_24h ?? Infinity) - (b.change_24h ?? Infinity));
}

function MarketScore({ result }: Readonly<{ result: ScanAssetResult | undefined }>) {
  const score = scanScore(result);
  if (score !== null) {
    return <span className="markets-score">{score}</span>;
  }
  if (result && result.status !== 'EVALUATED') return <NotScoredBadge result={result} compact />;
  return (
    <span className="markets-score score-none" aria-label="Signal score loading">
      —
    </span>
  );
}

const MarketRow = memo(function MarketRow({
  asset,
  result,
  rank,
  onSelect,
}: {
  asset: Asset;
  result: ScanAssetResult | undefined;
  /** Null for an unranked row, so it never reads as a placing. */
  rank: number | null;
  onSelect: (asset: Asset) => void;
}) {
  const live = useLivePrice(toBinanceSymbol(asset.ticker));
  const currentPrice = live?.price ?? asset.current_price;
  const change = live?.change ?? asset.change_24h ?? null;
  const priceFlash = usePriceFlash(currentPrice);
  const streamConnected = useConnectionState() === 'connected';
  const freshness = assetFreshness(asset, live, { streamConnected });
  return (
    <div // NOSONAR(S6819): the row holds its own Trade and alert buttons, which a <button> cannot contain
      className="markets-row markets-row-clickable"
      role="button"
      tabIndex={0}
      aria-label={`View ${asset.ticker} details`}
      onClick={() => onSelect(asset)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(asset);
        }
      }}
    >
      <span className="markets-rank">{rank === null ? '—' : `#${rank}`}</span>
      <span className="markets-ticker" title={asset.name || asset.ticker}>
        <AssetIcon symbol={asset.ticker} name={asset.name} size="sm" />
        <span className="markets-ticker-label">{asset.ticker}</span>
        <SetAlertButton asset={asset} />
      </span>
      <span className="markets-price-cell">
        <span className={cn('markets-price', priceFlash)}>{formatPrice(currentPrice)}</span>
        <FreshnessBadge state={freshness} />
      </span>
      <Suspense fallback={sparklineFallback}>
        <Sparkline data={generateTrendData(currentPrice, change)} change={change} />
      </Suspense>
      <span
        className={cn(
          'markets-change',
          change != null && change > 0 && 'markets-change-up',
          change != null && change < 0 && 'markets-change-down',
        )}
      >
        {change != null && change > 0 && <TrendingUp size={13} />}
        {change != null && change < 0 && <TrendingDown size={13} />}
        {formatChange(change)}
      </span>
      <span className="markets-score-cell">
        <MarketScore result={result} />
      </span>
      <span // NOSONAR(S6819): keeps Trade clicks (and its modal's) from selecting the row
        role="presentation"
        className="markets-trade"
        onClick={(e) => e.stopPropagation()}
      >
        <BrokerModal asset={asset} />
      </span>
    </div>
  );
});

type WorkspaceView = 'research' | 'paper' | 'account';

const VIEW_PATHS = {
  research: '/',
  paper: '/paper-trading',
  account: '/account',
} as const satisfies Record<WorkspaceView, string>;

/** The feed status pill: the connection first, then where the prices come from. */
function feedStatusLabel(
  reconnecting: boolean,
  preview: boolean,
  query: { isPending: boolean; isError: boolean },
): string {
  if (reconnecting) return 'Reconnecting…';
  if (preview) return 'Sample data';
  if (query.isPending) return 'Connecting';
  if (query.isError) return 'Offline';
  return 'Live';
}

function HeaderProfile({ user, onSignOut }: Readonly<{ user: User; onSignOut: () => void }>) {
  return (
    <>
      <span className="header-divider" aria-hidden="true" />
      <div className="header-profile flex items-center gap-1.5">
        <Avatar className="header-avatar h-8 w-8 border border-border">
          <AvatarFallback className="text-[11px] font-semibold">
            {(user.email ?? '?').slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <Button
          variant="ghost"
          size="icon"
          className="header-logout h-9 w-9 flex-shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Log out"
          title="Log out"
          onClick={onSignOut}
        >
          <LogOut size={15} />
        </Button>
      </div>
    </>
  );
}

/** Holds the scan's place while the market universe loads: a header and a few rows. */
function MarketsSkeleton() {
  return (
    <div className="market-scan" aria-busy="true" aria-label="Loading market data">
      <div className="skeleton h-6 w-40" />
      <div className="skeleton mt-4 h-10 w-full" />
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="skeleton mt-3 h-8 w-full" />
      ))}
    </div>
  );
}

function NoSignals({ onPreview }: Readonly<{ onPreview: () => void }>) {
  return (
    <div className="empty-state">
      <CandlestickChart size={32} className="mx-auto mb-4 text-muted-foreground" />
      <h3>No signals yet</h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Your watchlist is empty. Check back soon, or preview sample data.
      </p>
      <Button variant="outline" className="mt-5" onClick={onPreview}>
        View sample data
      </Button>
    </div>
  );
}

/** Every asset in the universe with its price and 24h move; opening a row shows its details. */
export function MarketsSection({
  rows,
  scores,
  assets,
  marketView,
  onMarketView,
  assetClass,
  onAssetClass,
  onSelect,
  onInvest,
}: Readonly<{
  rows: Asset[];
  scores: ScanResults;
  assets: Asset[];
  marketView: MarketView;
  onMarketView: (view: MarketView) => void;
  assetClass: AssetClassFilter;
  onAssetClass: (filter: AssetClassFilter) => void;
  onSelect: (asset: Asset) => void;
  onInvest: () => void;
}>) {
  return (
    <section className="markets" data-tour="markets" aria-label="Markets directory">
      <div className="markets-head">
        <div>
          <h2 className="markets-title">Markets directory</h2>
          <p className="markets-score-help">
            Every asset in the universe with its price, 24h move, alerts and broker links. Signal
            repeats the scan&rsquo;s 0–100 model score, not a probability or a performance forecast;
            its evidence is under Scan.
          </p>
        </div>
        <div className="markets-head-actions">
          <span className="markets-count font-mono">
            {rows.length} ASSET{rows.length === 1 ? '' : 'S'}
          </span>
          <Suspense fallback={null}>
            <RoboAdvisor assets={assets} onInvest={onInvest} />
          </Suspense>
        </div>
      </div>
      <div className="markets-controls">
        <fieldset className="markets-pills" aria-label="Market view">
          {MARKET_VIEWS.map((view) => (
            <button
              key={view.id}
              type="button"
              className={cn('markets-pill', marketView === view.id && 'markets-pill-active')}
              aria-pressed={marketView === view.id}
              onClick={() => onMarketView(view.id)}
            >
              {view.label}
            </button>
          ))}
        </fieldset>
        <fieldset className="markets-pills" aria-label="Asset class">
          {ASSET_CLASS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={cn('markets-pill', assetClass === filter && 'markets-pill-active')}
              aria-pressed={assetClass === filter}
              onClick={() => onAssetClass(filter)}
            >
              {filter}
            </button>
          ))}
        </fieldset>
      </div>
      {rows.length === 0 ? (
        <div className="markets-empty">No assets match this filter.</div>
      ) : (
        <div className="markets-table">
          <div className="markets-row markets-row-head" aria-hidden="true">
            <span className="markets-head-cell markets-rank-head">#</span>
            <span className="markets-head-cell">Asset</span>
            <span className="markets-head-cell">Price</span>
            <span />
            <span className="markets-head-cell">24h %</span>
            <span className="markets-head-cell">Signal</span>
            <span />
          </div>
          {rows.map((asset, index) => (
            <MarketRow
              key={asset.ticker}
              asset={asset}
              result={scores.get(asset.ticker)}
              // Scan rank shows only what the scan scored; the movers views rank by 24h change.
              rank={marketView === 'signals' ? (scores.get(asset.ticker)?.rank ?? null) : index + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export type ResearchPlace = 'scan' | 'directory';

/**
 * Research has two places: the ranked scan with its evidence, and the Markets
 * directory (prices, alerts, broker links and the portfolio builder), so the
 * directory never reads as a second scanner. Both stay mounted, so switching keeps
 * the scan's filters, selection and comparison. Under `vite dev` the scan's source
 * is picked above the live-data gate: the local TradingView import never waits on,
 * or disappears with, the market-data query, and the two never render together.
 */
export function ResearchZone({
  pending,
  failed,
  empty,
  onPreview,
  scan,
  markets,
  alerts,
  source,
  onSource,
  place,
  onPlace,
}: Readonly<{
  /** The market universe is still loading. */
  pending: boolean;
  failed: boolean;
  /** The market universe loaded with no assets. */
  empty: boolean;
  onPreview: () => void;
  scan: ReactNode;
  markets: ReactNode;
  alerts: ReactNode;
  source: MarketsSource;
  onSource: (source: MarketsSource) => void;
  place: ResearchPlace;
  onPlace: (place: ResearchPlace) => void;
}>) {
  const gate = (content: ReactNode) => {
    if (pending) return <MarketsSkeleton />;
    // A failed load already shows its error banner above, with Retry.
    if (empty) return failed ? null : <NoSignals onPreview={onPreview} />;
    return content;
  };
  const tradingView = import.meta.env.DEV && source === 'tradingview';
  return (
    <div className="research">
      <div className="research-bar">
        <Segmented
          value={place}
          ariaLabel="Research"
          className="scan-views research-places"
          onChange={onPlace}
          options={[
            { value: 'scan', label: 'Scan' },
            { value: 'directory', label: 'Markets directory' },
          ]}
        />
        {import.meta.env.DEV && place === 'scan' && (
          <div className="research-source">
            Dev source
            <MarketsSourcePicker source={source} onSource={onSource} />
          </div>
        )}
      </div>
      <div hidden={place !== 'scan'}>
        {tradingView ? <TradingViewDevScan key="tradingview" /> : gate(scan)}
      </div>
      <div hidden={place !== 'directory'}>
        {gate(
          <>
            {markets}
            {alerts}
          </>,
        )}
      </div>
    </div>
  );
}

function Terminal() {
  const [source, setSource] = useState<'auto' | 'live' | 'sample'>('auto');
  const [marketView, setMarketView] = useState<MarketView>('signals');
  const [assetClass, setAssetClass] = useState<AssetClassFilter>('Crypto');
  // Restored after a full page reload under `vite dev`; market data on a tab's first visit.
  const [marketsSource, setMarketsSource] = useResearchSource();
  const [researchPlace, setResearchPlace] = useState<ResearchPlace>('scan');
  // The URL is the source of truth: / (Research), /paper-trading, /account.
  const navigate = useNavigate();
  const onPaper = useMatch({ from: '/_workspace/paper-trading', shouldThrow: false }) !== undefined;
  const onAccount = useMatch({ from: '/_workspace/account', shouldThrow: false }) !== undefined;
  let view: WorkspaceView = 'research';
  if (onPaper) view = 'paper';
  else if (onAccount) view = 'account';
  const setView = (next: WorkspaceView) => void navigate({ to: VIEW_PATHS[next] });
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const { user, signOut } = useAuth();
  const { portfolios, activePortfolioType } = usePortfolio();
  const query = useQuery({
    queryKey: ['assets-status'],
    queryFn: fetchAssets,
    refetchInterval: 60000,
    retry: 1,
  });
  const preview =
    source === 'sample' || (source === 'auto' && query.isSuccess && query.data.length === 0);
  const baseAssets = preview ? sampleAssets : query.data || [];
  useBinanceWebSocket(baseAssets);
  // Single unified alert pipeline (M1-T4, F-5.1) — session + cloud alerts.
  useAlertEngine(baseAssets, user);
  // Walk-forward log: today's paper snapshot, once the server ledger has
  // replayed and live prices are in (never sample prices or a half-loaded account).
  const hydration = useHydrationState();
  const paper = portfolios.paper_trading;
  const liveAssets = query.isSuccess && !preview ? query.data : null;
  useEffect(() => {
    if (!user || !liveAssets || hydration.status !== 'ready' || hydration.userId !== user.id)
      return;
    const prices = Object.fromEntries(
      liveAssets.map((asset) => [asset.ticker.toUpperCase(), asset.current_price]),
    );
    recordWalkForward(user.id, paper, prices);
  }, [user, liveAssets, hydration, paper]);
  const connectionState = useConnectionState();
  const reconnecting = connectionState === 'reconnecting';
  const scanQuery = useMarketScan(
    baseAssets.map((asset) => asset.ticker),
    preview ? 'sample-preview' : 'assets_status',
  );
  const scan: MarketScan | undefined = scanQuery.data;
  const scores: ScanResults = new Map(scan?.results.map((result) => [result.ticker, result]));
  const filtered =
    assetClass === 'All'
      ? baseAssets
      : baseAssets.filter((a) => getAssetClass(a.ticker) === assetClass);
  const rows = sortMarkets(filtered, marketView, scores);
  // The header's refresh re-reads market data only; the TradingView review reloads its own file.
  const reviewingImport =
    import.meta.env.DEV &&
    view === 'research' &&
    researchPlace === 'scan' &&
    marketsSource === 'tradingview';

  const page = (
    <div className="min-h-screen text-foreground">
      {CLOSED_BETA && (
        <p className="beta-banner">
          <strong>Closed Beta: Paper Evaluation Period</strong> · Every system runs in simulated
          execution. No real orders, no real money.
        </p>
      )}
      <header className="terminal-header">
        <div className="page-width flex h-full items-center justify-between gap-3 sm:gap-4">
          <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Popup home">
            <BrandLogo />
            <span className="terminal-tag">SIGNALS</span>
          </a>
          <Segmented
            value={view}
            ariaLabel="Workspace"
            onChange={setView}
            options={[
              {
                value: 'research',
                label: (
                  <>
                    <Search size={14} /> Research
                  </>
                ),
              },
              {
                value: 'paper',
                label: (
                  <>
                    <Activity size={14} /> Paper Desk <span className="segment-tag">Sim</span>
                  </>
                ),
              },
              {
                value: 'account',
                label: (
                  <>
                    <UserRound size={14} /> Account
                  </>
                ),
              },
            ]}
          />
          <div className="header-actions flex shrink-0 items-center gap-3">
            <div className="header-utilities flex items-center gap-2.5">
              <span className="connection-status">
                <span
                  className={cn(
                    'status-dot',
                    reconnecting && 'status-reconnecting',
                    !reconnecting && query.isError && !preview && 'status-error',
                  )}
                />
                {feedStatusLabel(reconnecting, preview, query)}
              </span>
              {!reviewingImport && (
                <Button
                  variant="outline"
                  size="icon"
                  className="header-refresh h-9 w-9 flex-shrink-0"
                  aria-label="Refresh signals"
                  title="Refresh signals"
                  disabled={query.isFetching}
                  onClick={() => query.refetch()}
                >
                  <RefreshCw size={14} className={cn(query.isFetching && 'animate-spin')} />
                </Button>
              )}
              <ThemeToggle />
            </div>
            {user && <HeaderProfile user={user} onSignOut={() => void signOut()} />}
            <TourGuide
              onViewChange={(next) => {
                // The tour's Research steps point at the directory and its portfolio builder.
                if (next === 'research') setResearchPlace('directory');
                setView(next);
              }}
            />
          </div>
        </div>
      </header>
      <main className="page-width w-full mx-auto pb-16 pt-8">
        {preview && (
          <div className="preview-note">
            <span className="flex items-center gap-2">
              <Radio size={13} />
              Sample data · Illustrative prices and signals, not live market data.
            </span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setSource('live')}
            >
              View live data <ArrowUpRight size={12} />
            </Button>
          </div>
        )}
        {query.isError && !preview && (
          <div role="alert" className="error-banner">
            <span>
              {query.data
                ? 'Refresh failed. Showing the last available snapshot.'
                : 'Unable to load signals. Check your connection.'}
            </span>
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {view === 'paper' && (
          <Suspense fallback={zoneFallback}>
            <PaperTradingTerminal assets={baseAssets} />
            <hr className="zone-divider" />
            <PortfolioDashboard assets={baseAssets} portfolioType="long_term_sim" />
          </Suspense>
        )}
        {view === 'account' && (
          <Suspense fallback={zoneFallback}>
            <AccountPanel assets={baseAssets} />
          </Suspense>
        )}
        {view === 'research' && (
          <ResearchZone
            pending={query.isPending && !preview}
            failed={query.isError}
            empty={baseAssets.length === 0}
            onPreview={() => setSource('sample')}
            scan={
              <MarketScanSummary
                scan={scan}
                completedAt={scanQuery.dataUpdatedAt}
                scanning={scanQuery.isFetching}
                failed={scanQuery.isError}
              />
            }
            markets={
              <MarketsSection
                rows={rows}
                scores={scores}
                assets={baseAssets}
                marketView={marketView}
                onMarketView={setMarketView}
                assetClass={assetClass}
                onAssetClass={setAssetClass}
                onSelect={setSelectedAsset}
                onInvest={() => setView('paper')}
              />
            }
            alerts={
              <section className="portfolio-section" aria-label="Price alerts">
                <PriceAlerts assets={baseAssets} user={user} />
              </section>
            }
            source={marketsSource}
            onSource={setMarketsSource}
            place={researchPlace}
            onPlace={setResearchPlace}
          />
        )}
      </main>
      <footer className="terminal-footer page-width">
        <div className="flex items-center gap-2">
          <Zap size={13} />
          <span>Signals worth opening.</span>
        </div>
        <span>Quantitative analysis is informational. Not financial advice.</span>
        <span className="font-mono text-[10px]">
          POPUP
          <ArrowDown size={10} className="ml-1 inline" />
        </span>
      </footer>

      {selectedAsset && (
        <Suspense fallback={null}>
          <AssetDetailsModal
            asset={selectedAsset}
            onClose={() => setSelectedAsset(null)}
            portfolioCapital={
              computePortfolioValuation(
                portfolios[activePortfolioType],
                Object.fromEntries(
                  baseAssets.map((a) => [a.ticker.toUpperCase(), a.current_price]),
                ),
              ).totalEquity
            }
          />
        </Suspense>
      )}
    </div>
  );
  // The server's ATR(14) for usePaperRisk: positions with no browser candles.
  return <AssetsStatusContext value={query.data ?? []}>{page}</AssetsStatusContext>;
}

/** Auth-gated app shell shared by `/` (Research), `/paper-trading` and `/account`. */
export function Workspace() {
  const { user, loading } = useAuth();
  const [authOpen, setAuthOpen] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen text-foreground">
        <div className="page-width mx-auto flex min-h-screen w-full items-center justify-center">
          <div aria-busy="true" className="landing-loading">
            <span className="landing-loading-cursor" />
            {'Loading your workspace…'}
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LandingPage onSignIn={() => setAuthOpen(true)} onGetStarted={() => setAuthOpen(true)} />
        <Suspense fallback={null}>
          <AuthModal open={authOpen} onOpenChange={setAuthOpen} />
        </Suspense>
      </>
    );
  }

  return <Terminal />;
}
