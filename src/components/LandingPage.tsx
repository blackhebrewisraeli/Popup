import { useId, useRef, useState } from 'react';
import { ArrowRight, Zap } from 'lucide-react';
import { BrandLogo } from '@/components/Brand';
import { ClauseList } from '@/components/ScanReview';
import {
  CANONICAL_MODEL_VERSION,
  FLAT_MOMENTUM,
  LONG_SETUP_MIN_SCORE,
  modelSetups,
  REGIME_HIGH_VOLATILITY,
  REGIME_LABELS,
  RISK_SETUP_MAX_SCORE,
  scoreFactors,
  type CanonicalScore,
  type FactorInputs,
  type ModelSetups,
} from '@/lib/canonicalModel';
import { explainResult, percent, ratio, riskLabel, rowReason } from '@/lib/scanReview';
import { cn } from '@/lib/utils';

/**
 * Made-up readings for five made-up assets. They run through the real model and
 * setup rules, so each score, reason and condition is what Research would show
 * for these readings. Nothing here is market data, and nothing is fetched.
 */
const DEMO_READINGS: readonly { ticker: string; inputs: FactorInputs }[] = [
  { ticker: 'DEMO1', inputs: { rsi: 52, momentumPercent: 0.0012, volatilityPercent: 0.018 } },
  { ticker: 'DEMO2', inputs: { rsi: 74, momentumPercent: -0.0042, volatilityPercent: 0.034 } },
  { ticker: 'DEMO3', inputs: { rsi: 32, momentumPercent: 0.0035, volatilityPercent: 0.012 } },
  { ticker: 'DEMO4', inputs: { rsi: 48, momentumPercent: 0.0008, volatilityPercent: 0.046 } },
  { ticker: 'DEMO5', inputs: { rsi: 26, momentumPercent: -0.0004, volatilityPercent: 0.01 } },
];

const DEMO_SCAN = DEMO_READINGS.map(({ ticker, inputs }) => {
  // A close of 100 makes ATR in price units read straight off ATR / price.
  const model: CanonicalScore = {
    status: 'OK',
    version: CANONICAL_MODEL_VERSION,
    inputs,
    close: 100,
    atr: 100 * inputs.volatilityPercent,
    ...scoreFactors(inputs),
  };
  const setups = modelSetups(model);
  return { ticker, model, setups, explanation: explainResult(model, setups) };
})
  .sort((a, b) => b.model.signal_score - a.model.signal_score)
  .map((asset, index) => ({ ...asset, rank: index + 1 }));

/** Opens on the high score that still meets no setup: the case a score alone hides. */
const FIRST_SELECTED = 'DEMO5';

/** Below this width the explanation sits under the list. Matches `.landing-demo-desk` in styles.css. */
const STACKED = '(max-width: 1023px)';

type Demo = Readonly<{ model: CanonicalScore; setups: ModelSetups }>;

function setupWords(asset: Demo): string {
  const words = [asset.setups.long && 'Long setup', riskLabel(asset)];
  return words.filter(Boolean).join(', ') || 'No setup';
}

function SetupTag({ asset }: Readonly<{ asset: Demo }>) {
  const risk = riskLabel(asset);
  if (!asset.setups.long && !risk) return <span className="market-scan-tag">No setup</span>;
  return (
    <>
      {asset.setups.long && <span className="market-scan-tag is-long">Long setup</span>}
      {risk && <span className="market-scan-tag is-risk">{risk}</span>}
    </>
  );
}

/** Research's list and evidence, on synthetic readings, for a visitor who is not signed in. */
function ScanDemo() {
  const [selected, setSelected] = useState(FIRST_SELECTED);
  const detailRef = useRef<HTMLElement>(null);
  const id = useId();
  const asset = DEMO_SCAN.find((item) => item.ticker === selected);

  const select = (ticker: string) => {
    setSelected(ticker);
    if (window.matchMedia(STACKED).matches) {
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      detailRef.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }
  };

  return (
    <section className="landing-demo" aria-labelledby={`${id}-title`}>
      <div className="market-scan-head">
        <div className="market-scan-heading">
          <h2 id={`${id}-title`} className="market-scan-title">
            Example scan
          </h2>
          <p className="market-scan-state">
            <span className="market-scan-status market-scan-dev">Illustrative</span>
            <span>Synthetic readings for five made-up assets · daily candles</span>
          </p>
        </div>
      </div>

      <div className="landing-demo-desk">
        <div>
          <div className="scan-list-head" aria-hidden="true">
            <span className="scan-list-cols">
              <span>#</span>
              <span>Asset</span>
              <span>Score</span>
              <span>Setup</span>
              <span>Reason</span>
            </span>
          </div>
          <ul className="market-scan-list scan-results">
            {DEMO_SCAN.map((item) => (
              <li
                key={item.ticker}
                className={cn('scan-row', item.ticker === selected && 'is-selected')}
              >
                <button
                  type="button"
                  className="scan-row-main"
                  aria-label={`${item.ticker}, rank ${item.rank}, score ${item.model.signal_score}, ${setupWords(item)}`}
                  aria-describedby={`${id}-${item.ticker}`}
                  aria-current={item.ticker === selected ? 'true' : undefined}
                  aria-controls={`${id}-detail`}
                  onClick={() => select(item.ticker)}
                >
                  <span className="market-scan-rank">#{item.rank}</span>
                  <span className="scan-row-asset">
                    <span className="market-scan-ticker">{item.ticker}</span>
                  </span>
                  <span className="market-scan-score">
                    <span className="scan-score-label">Score </span>
                    {item.model.signal_score}
                  </span>
                  <span className="scan-row-setup">
                    <SetupTag asset={item} />
                  </span>
                  <span id={`${id}-${item.ticker}`} className="scan-row-reason">
                    {rowReason(item.explanation)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {asset && (
          <section
            id={`${id}-detail`}
            ref={detailRef}
            className="landing-demo-detail"
            aria-label={`${asset.ticker} explanation`}
          >
            <output className="sr-only">{`Showing ${asset.ticker}`}</output>
            <header className="scan-evidence-head">
              <span className="asset-details-eyebrow">
                Synthetic · 1D · #{asset.rank} of {DEMO_SCAN.length}
              </span>
              <h3 className="asset-details-name">{asset.ticker}</h3>
            </header>
            <div className="scan-explain-body">
              <div className="quant-insight-summary">
                <span className="quant-breakdown-score" title="Signal Score (0–100)">
                  {asset.model.signal_score}
                </span>
                <span className="regime-badge" data-regime={asset.model.regime}>
                  {REGIME_LABELS[asset.model.regime]}
                </span>
                <SetupTag asset={asset} />
              </div>
              <p className="quant-rationale">{asset.model.rationale}</p>
              <section aria-labelledby={`${id}-conditions`}>
                <h4 id={`${id}-conditions`} className="quant-breakdown-title">
                  Conditions on the last closed bar
                </h4>
                <ClauseList check={asset.explanation.long} />
                <ClauseList check={asset.explanation.risk} />
              </section>
              <p className="market-scan-fit">
                A setup is a standing condition on that bar, not an order or a forecast.
              </p>
            </div>
          </section>
        )}
      </div>

      <p className="landing-demo-note">
        Illustrative only: these readings are made up, then scored with Popup&rsquo;s own model{' '}
        {CANONICAL_MODEL_VERSION} and setup rules. Signed in, Research applies the same rules to
        crypto daily candles from Binance.
      </p>
    </section>
  );
}

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
          <button type="button" className="landing-ghost-button" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      </header>

      <main className="page-width">
        <section className="landing-intro">
          <h1 className="landing-headline">A market scanner that explains every result.</h1>
          <p className="landing-subheadline">
            Popup scores assets on RSI, MACD and ATR readings, ranks them, and shows which setup
            conditions each one meets or misses, and by how much.
          </p>
          <button type="button" className="landing-cta-button" onClick={onGetStarted}>
            Get started free <ArrowRight size={16} aria-hidden="true" />
          </button>
        </section>

        <ScanDemo />

        <dl className="scan-guide landing-guide">
          <div>
            <dt>Rank</dt>
            <dd>Order by score within one asset class. Relative only: #1 is not a buy.</dd>
          </div>
          <div>
            <dt>Score</dt>
            <dd>A 0–100 blend of RSI, MACD and ATR factors. Not a probability or a return.</dd>
          </div>
          <div>
            <dt>Long setup</dt>
            <dd>
              Score ≥ {LONG_SETUP_MIN_SCORE} and MACD momentum ≥ {percent(FLAT_MOMENTUM)} of price.
            </dd>
          </div>
          <div>
            <dt>Risk warning</dt>
            <dd>
              High volatility (ATR ≥ {ratio(REGIME_HIGH_VOLATILITY)} of price), a low score (≤{' '}
              {RISK_SETUP_MAX_SCORE}), or both. Each warning names its clause.
            </dd>
          </div>
        </dl>

        <p className="landing-secondary">
          Want to test an idea afterwards? Paper Desk tracks simulated trades with simulated money.
          Popup places no real orders.
        </p>
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
