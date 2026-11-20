import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Download, History, KeyRound } from 'lucide-react';
import type { Asset } from '@/lib/assets';
import { useAuth } from '@/lib/authStore';
import { usePortfolio } from '@/lib/portfolioStore';
import { LEDGER_NAMES, type PortfolioType } from '@/lib/portfolioAccounting';
import { downloadCsv, tradeLedgerCsv } from '@/lib/tradeLedger';
import { loadWalkForward, walkForwardCsv } from '@/lib/engine/walkForwardLogger';
import { BinanceSpotBalances } from '@/components/BinanceSpotBalances';
import { PineScriptModal } from '@/components/PineScriptModal';
import { PortfolioDashboard } from '@/components/PortfolioDashboard';
import { SpotExperiments } from '@/components/SpotExperiments';

/** Same filenames Simulation history and Tracked Holdings export under. */
const EXPORTS: { type: PortfolioType; filename: string }[] = [
  { type: 'paper_trading', filename: 'popup-ledger-paper.csv' },
  { type: 'long_term_sim', filename: 'popup-ledger-simulation.csv' },
  { type: 'real_tracking', filename: 'popup-ledger-live.csv' },
];

/**
 * Account zone, ordered for the Manual Spot prototype: the owner's read-only Binance card with its
 * Manual Spot experiments first, then holdings tracked by hand, then data export and the
 * TradingView webhook in one closed disclosure.
 */
export function AccountPanel({
  assets,
  revealSpotExperiments = false,
}: Readonly<{
  assets: Asset[];
  /** Followed the workspace link to Manual Spot experiments; the Binance card still gates them. */
  revealSpotExperiments?: boolean;
}>) {
  const { user } = useAuth();
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pineOpen, setPineOpen] = useState(false);

  return (
    <section className="portfolio" aria-label="Account">
      <header className="portfolio-head">
        <div>
          <h2 className="portfolio-title">Account</h2>
          <p className="portfolio-subtitle">{user?.email}</p>
        </div>
      </header>

      {/* Keyed by user so one account's snapshot can never render for another. */}
      {user && (
        <BinanceSpotBalances
          key={user.id}
          accountContext={user.id}
          requested={revealSpotExperiments}
        >
          <SpotExperiments userId={user.id} reveal={revealSpotExperiments} />
        </BinanceSpotBalances>
      )}

      <hr className="zone-divider" />
      <PortfolioDashboard assets={assets} portfolioType="real_tracking" />

      <details
        className="scan-guide-details account-secondary"
        onToggle={(event) => setToolsOpen(event.currentTarget.open)}
      >
        <summary>Data export and TradingView webhook</summary>
        {/* Mounted only while open. */}
        {toolsOpen && <SecondaryTools onManageWebhook={() => setPineOpen(true)} />}
      </details>

      {pineOpen && <PineScriptModal open onOpenChange={setPineOpen} />}
    </section>
  );
}

function SecondaryTools({ onManageWebhook }: Readonly<{ onManageWebhook: () => void }>) {
  const { user } = useAuth();
  const { portfolios } = usePortfolio();
  return (
    <div className="account-grid">
      <section
        className="portfolio-workspace-card account-card"
        aria-labelledby="account-export-title"
      >
        <h3 id="account-export-title" className="portfolio-section-title">
          Data Export
        </h3>
        <p>
          Download any ledger as CSV: fills, fees, cash movements and realized P&amp;L. Paper
          Trading and Simulation are simulated money; Live Tracking is the holdings you track by
          hand.
        </p>
        <div className="account-actions">
          {EXPORTS.map(({ type, filename }) => (
            <button
              key={type}
              type="button"
              className="portfolio-cash-btn"
              disabled={portfolios[type].transactions.length === 0}
              onClick={() => downloadCsv(filename, tradeLedgerCsv(portfolios[type].transactions))}
            >
              <Download size={13} /> {LEDGER_NAMES[type]}
            </button>
          ))}
          {user && (
            <button
              type="button"
              className="portfolio-cash-btn"
              onClick={() =>
                downloadCsv('popup-beta-audit.csv', walkForwardCsv(loadWalkForward(user.id)))
              }
            >
              <Download size={13} /> Export Beta Audit CSV
            </button>
          )}
          <Link to="/paper-trading" className="portfolio-cash-btn">
            <History size={13} aria-hidden="true" /> Simulation history (read-only)
          </Link>
        </div>
      </section>

      <section
        className="portfolio-workspace-card account-card"
        aria-labelledby="account-webhook-title"
      >
        <h3 id="account-webhook-title" className="portfolio-section-title">
          TradingView Webhook
        </h3>
        <p>
          Generate a webhook token and a Pine Script with it baked in. Alerts are recorded in the
          Signal Journal under Simulation history; the Paper Desk that executed them is paused.
        </p>
        <button type="button" className="portfolio-cash-btn" onClick={onManageWebhook}>
          <KeyRound size={13} /> Manage webhook keys
        </button>
      </section>
    </div>
  );
}
