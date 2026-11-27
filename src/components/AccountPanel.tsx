import { useLocation } from '@tanstack/react-router';
import { BinanceSpotBalances } from '@/components/BinanceSpotBalances';
import { SpotExperiments } from '@/components/SpotExperiments';
import { useAuth } from '@/lib/authStore';
import { SPOT_EXPERIMENTS_ANCHOR } from '@/lib/spotExperiments';

export function AccountPanel() {
  const { user } = useAuth();
  const reveal = useLocation({ select: (location) => location.hash === SPOT_EXPERIMENTS_ANCHOR });
  return (
    <section className="portfolio" aria-label="Spot journal">
      <header className="portfolio-head">
        <h1 className="portfolio-title">Spot journal</h1>
      </header>
      {user && (
        <>
          <SpotExperiments userId={user.id} reveal={reveal} />
          <BinanceSpotBalances accountContext={user.id} />
        </>
      )}
    </section>
  );
}
