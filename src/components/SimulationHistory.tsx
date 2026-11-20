import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { DecisionJournal } from '@/components/DecisionJournal';
import { TradeLedger } from '@/components/PortfolioDashboard';
import { Shares } from '@/components/Shares';
import { formatPrice } from '@/lib/assets';
import {
  LEDGER_NAMES,
  type PortfolioContainer,
  type PortfolioType,
} from '@/lib/portfolioAccounting';
import { usePortfolio } from '@/lib/portfolioStore';

/** The paused simulated ledgers, exported under the filenames they always had. */
const SIMULATED_LEDGERS = [
  { type: 'paper_trading', filename: 'popup-ledger-paper.csv' },
  { type: 'long_term_sim', filename: 'popup-ledger-simulation.csv' },
] as const satisfies readonly { type: PortfolioType; filename: string }[];

/** Cash and open lots as the ledger left them. No live price, so no value or P&L is implied. */
function LastRecord({ ledger }: Readonly<{ ledger: PortfolioContainer }>) {
  const { positions } = ledger;
  return (
    <p className="portfolio-subtitle">
      At the last record: {formatPrice(ledger.cashBalance)} simulated cash and {positions.length}{' '}
      open simulated {positions.length === 1 ? 'position' : 'positions'}
      {positions.map((position, index) => (
        <span key={position.id}>
          {index === 0 ? ': ' : ', '}
          {position.ticker} <Shares value={position.shares} />
        </span>
      ))}
      .
    </p>
  );
}

/**
 * The paused Paper Desk and Build Portfolio's records, read-only, at their old URL. It reads the
 * ledgers the workspace already loaded and the Signal Journal; it books, resets and saves nothing.
 */
export function SimulationHistory() {
  const { portfolios } = usePortfolio();
  return (
    <section className="portfolio" aria-labelledby="simulation-history-title">
      <header className="portfolio-head">
        <div>
          <span className="paper-eyebrow">
            <span className="paper-eyebrow-dot" aria-hidden="true" /> Paused · Read-only
          </span>
          <h2 id="simulation-history-title" className="portfolio-title">
            Simulation history
          </h2>
          <p className="portfolio-subtitle">
            Paper Desk and Build Portfolio are paused. Their simulated records stay here to read and
            export; nothing on this page places, changes or resets a trade. Simulated money is kept
            apart from your tracked holdings and Manual Spot experiments in Account.
          </p>
        </div>
        <Link to="/" className="portfolio-cash-btn">
          <ArrowLeft size={13} aria-hidden="true" /> Back to Research
        </Link>
      </header>
      {SIMULATED_LEDGERS.map(({ type, filename }) => (
        <TradeLedger
          key={type}
          title={`${LEDGER_NAMES[type]} ledger`}
          transactions={portfolios[type].transactions}
          filename={filename}
          summary={<LastRecord ledger={portfolios[type]} />}
        />
      ))}
      <section className="portfolio-section" aria-labelledby="history-journal-title">
        <div className="portfolio-section-head">
          <h3 id="history-journal-title" className="portfolio-section-title">
            Signal Journal
          </h3>
        </div>
        <DecisionJournal />
      </section>
    </section>
  );
}
