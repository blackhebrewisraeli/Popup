import { Link, Outlet, useMatch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import { LogOut } from 'lucide-react';
import { BrandLogo } from '@/components/Brand';
import { DailyCandidates } from '@/components/DailyCandidates';
import { MarketScanSummary } from '@/components/MarketScanSummary';
import { OpenSavedScanFile, SavedScanFileView } from '@/components/SavedScanFile';
import { Segmented } from '@/components/Segmented';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Button } from '@/components/ui/button';
import { useMarketScan } from '@/hooks/useMarketScan';
import { useSavedScanFile } from '@/hooks/useSavedScanFile';
import { fetchAssets } from '@/lib/assets';
import { useAuth } from '@/lib/authStore';
import { isSpotExperimentOwner } from '@/lib/spotExperiments';
import { isBinanceCrypto } from '@/lib/ticker';
import { cn } from '@/lib/utils';

const AuthModal = lazy(() =>
  import('@/components/AuthModal').then((m) => ({ default: m.AuthModal })),
);

export type ResearchPlace = 'daily' | 'scan';

function DailyModelScan({ active }: Readonly<{ active: boolean }>) {
  const universe = useQuery({
    queryKey: ['assets-status'],
    queryFn: fetchAssets,
    enabled: active,
    retry: 1,
  });
  const tickers = (universe.data ?? []).map((asset) => asset.ticker).filter(isBinanceCrypto);
  const scan = useMarketScan(tickers, 'assets_status', active);

  if (universe.isPending) {
    return <p role="status">Loading the scan universe…</p>;
  }
  return (
    <>
      {universe.isError && (
        <div role="alert" className="error-banner">
          <span>
            {universe.data
              ? 'Refresh failed. The scan uses the last loaded symbol list.'
              : 'Could not load the Binance Spot scan universe.'}
          </span>
          <Button variant="outline" size="sm" onClick={() => void universe.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {universe.isSuccess && tickers.length === 0 && (
        <p role="status">No Binance Spot pairs are configured for the daily model scan.</p>
      )}
      {tickers.length > 0 && (
        <MarketScanSummary
          scan={scan.data}
          completedAt={scan.dataUpdatedAt}
          scanning={scan.isFetching}
          failed={scan.isError}
          reviewByTicker
        />
      )}
      {scan.isError && (
        <Button variant="outline" size="sm" onClick={() => void scan.refetch()}>
          Retry scan
        </Button>
      )}
    </>
  );
}

export function ResearchZone({
  place,
  onPlace,
  daily,
  scan,
}: Readonly<{
  place: ResearchPlace;
  onPlace: (place: ResearchPlace) => void;
  daily: ReactNode;
  scan: (active: boolean) => ReactNode;
}>) {
  const { file, open, close } = useSavedScanFile();
  const openButton = useRef<HTMLButtonElement>(null);
  const closeFile = () => {
    close();
    openButton.current?.focus();
  };

  return (
    <div className="research">
      <div className="research-bar">
        <Segmented
          value={place}
          ariaLabel="Research"
          className="scan-views research-places"
          onChange={onPlace}
          options={[
            { value: 'daily', label: 'Daily candidates' },
            { value: 'scan', label: 'Model scan (1D)' },
          ]}
        />
        {place === 'scan' && <OpenSavedScanFile onOpen={open} buttonRef={openButton} />}
        {place === 'scan' && (
          <p className="markets-score-help research-place-note">
            Closed daily candles provide context for your review. Use the pair’s intraday chart to
            assess timing.
          </p>
        )}
      </div>
      <div hidden={place !== 'scan'}>
        {file && <SavedScanFileView file={file} onClose={closeFile} />}
        <div hidden={file !== null}>{scan(place === 'scan' && file === null)}</div>
      </div>
      {place === 'daily' && daily}
    </div>
  );
}

export function DailyResearch() {
  const [place, setPlace] = useState<ResearchPlace>('daily');
  return (
    <ResearchZone
      place={place}
      onPlace={setPlace}
      daily={<DailyCandidates />}
      scan={(active) => <DailyModelScan active={active} />}
    />
  );
}

function SignIn() {
  const [open, setOpen] = useState(false);
  return (
    <main className="page-width mx-auto flex min-h-screen flex-col items-start justify-center gap-5">
      <BrandLogo />
      <h1 className="text-3xl font-semibold">Private Spot workspace</h1>
      <p className="text-muted-foreground">
        Review Binance Spot candidates, inspect the chart and record your decisions.
      </p>
      <Button onClick={() => setOpen(true)}>Sign in</Button>
      {open && (
        <Suspense fallback={<p role="status">Loading sign-in…</p>}>
          <AuthModal open onOpenChange={setOpen} />
        </Suspense>
      )}
    </main>
  );
}

function PrivateWorkspace({ userId, signOut }: Readonly<{ userId: string; signOut: () => void }>) {
  const onAccount = useMatch({ from: '/_workspace/account', shouldThrow: false }) !== undefined;
  const owner = useQuery({
    queryKey: ['binance-spot-owner', userId],
    queryFn: isSpotExperimentOwner,
    retry: false,
  });
  const linkClass = (active: boolean) =>
    cn(
      'rounded-md px-3 py-2 text-sm font-medium hover:bg-muted',
      active ? 'bg-muted text-foreground' : 'text-muted-foreground',
    );

  return (
    <div className="min-h-screen text-foreground">
      <header className="terminal-header">
        <div className="page-width flex h-full items-center justify-between gap-2">
          <Link to="/" className="shrink-0" aria-label="Popup home">
            <BrandLogo />
          </Link>
          {owner.isSuccess && owner.data === true && (
            <nav aria-label="Workspace" className="flex items-center gap-1">
              <Link
                to="/"
                aria-current={onAccount ? undefined : 'page'}
                className={linkClass(!onAccount)}
              >
                Research
              </Link>
              <Link
                to="/account"
                aria-current={onAccount ? 'page' : undefined}
                className={linkClass(onAccount)}
              >
                Journal
              </Link>
            </nav>
          )}
          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />
            <Button variant="ghost" size="icon" aria-label="Log out" onClick={signOut}>
              <LogOut size={16} />
            </Button>
          </div>
        </div>
      </header>
      <main className="page-width mx-auto w-full pb-16 pt-8">
        {owner.isPending && <p role="status">Checking workspace access…</p>}
        {owner.isError && (
          <div role="alert" className="error-banner">
            <span>Could not check workspace access.</span>
            <Button variant="outline" size="sm" onClick={() => void owner.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {owner.isSuccess &&
          (owner.data ? <Outlet /> : <p>This sign-in does not have workspace access.</p>)}
      </main>
    </div>
  );
}

export function Workspace() {
  const { user, loading, signOut } = useAuth();
  if (loading) {
    return (
      <p className="page-width py-8" role="status">
        Loading your workspace…
      </p>
    );
  }
  if (!user) return <SignIn />;
  return <PrivateWorkspace key={user.id} userId={user.id} signOut={() => void signOut()} />;
}
