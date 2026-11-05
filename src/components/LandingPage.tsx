import {
  Activity,
  ArrowRight,
  Bot,
  Cloud,
  History,
  ShieldCheck,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { BrandLogo } from '@/components/Brand';

interface Feature {
  icon: LucideIcon;
  title: string;
  description: string;
}

const FEATURES: Feature[] = [
  {
    icon: Bot,
    title: 'Quant Analyzer',
    description:
      'A deterministic multi-factor engine ranks assets by RSI, MACD and ATR and drafts a risk-weighted portfolio you can simulate.',
  },
  {
    icon: Activity,
    title: 'Live Binance Data',
    description:
      'Stream real-time crypto prices over WebSockets with deterministic green/red flashes.',
  },
  {
    icon: History,
    title: '1-Year Backtesting',
    description:
      'Replay an allocation against a year of daily history, with fees, slippage and trailing stops.',
  },
  {
    icon: Cloud,
    title: 'Cloud Sync',
    description:
      'Save your portfolio to Supabase and pick up right where you left off on any device.',
  },
];

const STATS = [
  { value: '3', label: 'Asset classes' },
  { value: '365d', label: 'Backtest window' },
  { value: 'Live', label: 'Binance feed' },
  { value: 'Cloud', label: 'Synced portfolios' },
];

export function LandingPage({
  onSignIn,
  onGetStarted,
}: Readonly<{
  onSignIn: () => void;
  onGetStarted: () => void;
}>) {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="page-width landing-nav">
          <a href="/" className="shrink-0" aria-label="Popup home">
            <BrandLogo />
          </a>
          <div className="landing-nav-actions">
            <button type="button" className="landing-ghost-button" onClick={onSignIn}>
              Sign In
            </button>
            <button type="button" className="landing-cta-button" onClick={onGetStarted}>
              Get Started <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-hero-glow" aria-hidden="true" />
          <div className="page-width landing-hero-inner">
            <span className="landing-badge">
              <Sparkles size={14} /> Signals worth opening
            </span>
            <h1 className="landing-headline">
              {'See what matters.'}
              <span className="landing-headline-accent"> Test what follows.</span>
            </h1>
            <p className="landing-subheadline">
              Popup surfaces explainable market signals, then gives you the tools to investigate,
              backtest, and simulate them before you make a real-world decision.
            </p>
            <div className="landing-cta">
              <button
                type="button"
                className="landing-cta-button landing-cta-button-lg"
                onClick={onGetStarted}
              >
                Get Started Free <ArrowRight size={16} />
              </button>
              <a href="#features" className="landing-ghost-button landing-ghost-button-lg">
                Explore Features
              </a>
            </div>
            <div className="landing-stats">
              {STATS.map((stat) => (
                <div key={stat.label} className="landing-stat">
                  <span className="landing-stat-value">{stat.value}</span>
                  <span className="landing-stat-label">{stat.label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="landing-features">
          <div className="page-width">
            <div className="landing-section-head">
              <h2 className="landing-section-title">From signal to simulation</h2>
              <p className="landing-section-sub">
                Open the setup, understand the factors, and test the idea with simulated money.
              </p>
            </div>
            <div className="landing-grid">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div key={title} className="landing-card">
                  <span className="landing-card-icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="landing-card-title">{title}</h3>
                  <p className="landing-card-desc">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-final-cta">
          <div className="page-width">
            <div className="landing-final-card">
              <ShieldCheck size={22} className="landing-final-icon" />
              <h2 className="landing-final-title">Open your first signal</h2>
              <p className="landing-final-sub">
                Create a free account and start simulating your first portfolio in seconds.
              </p>
              <button
                type="button"
                className="landing-cta-button landing-cta-button-lg"
                onClick={onGetStarted}
              >
                Get Started Free <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div className="page-width landing-footer-inner">
          <div className="flex items-center gap-2">
            <Zap size={13} />
            <span>Signals worth opening.</span>
          </div>
          <span>Quantitative analysis is informational. Not financial advice.</span>
          <span className="font-mono text-[10px]">POPUP</span>
        </div>
      </footer>
    </div>
  );
}
