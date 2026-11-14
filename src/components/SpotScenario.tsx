import { useId, useState, type ReactNode } from 'react';
import { RecordSpotExperiment } from '@/components/RecordSpotExperiment';
import type { CanonicalScore, ModelSetups } from '@/lib/canonicalModel';
import type { MarketScan, ScanAssetResult, ScanCohort } from '@/lib/marketScanner';
import { resultAsOfLabel, riskLabel } from '@/lib/scanReview';
import {
  decimalInput,
  EMPTY_SCENARIO,
  planSpotScenario,
  type LimitedBy,
  type Scenario,
  type ScenarioCheck,
  type ScenarioErrors,
  type ScenarioField,
  type ScenarioInputs,
} from '@/lib/spotScenario';
import { candidateEvidence, riskReasons, type CandidateEvidence } from '@/lib/spotExperiments';
import type { TradingViewDevSource, TradingViewSavedScan } from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

const LABEL: Record<ScenarioField, string> = {
  allocation: 'Available allocation',
  maxLoss: 'Maximum planned loss',
  entry: 'Hypothetical entry',
  stop: 'Stop reference',
  feePercent: 'Fee assumption per fill',
};

const LIMITED_BY: Record<LimitedBy, string> = {
  allocation: 'Allocation',
  maxLoss: 'Planned-loss budget',
  both: 'Allocation and planned-loss budget equally',
};

/** One fact in a definition list, as the evidence shows them. */
function Fact({ name, value }: Readonly<{ name: string; value: ReactNode }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** What the recorded setups say about this pair, in one sentence that is never advice. */
function standingText(
  ticker: string,
  version: string,
  setups: ModelSetups,
  day: string,
  riskWhy: string,
): string {
  if (setups.long && setups.risk) {
    return `ZC LONG and ZC RISK both held on the ${day}: the Long condition comes with a Risk warning, ${riskWhy}. Neither is a forecast, a target or a recommendation.`;
  }
  if (setups.long) {
    return `ZC LONG held on the ${day}: a recorded technical condition, not a recommendation, target or forecast. The scenario below is yours.`;
  }
  return `Model ${version} did not qualify ${ticker} on the ${day}. A scenario here is your own hypothesis, not model-backed.`;
}

/** The scan's own record of this pair: what any scenario below rests on, read-only. */
function RecordedEvidence({
  evidence,
  result,
  model,
  setups,
  day,
}: Readonly<{
  /** The same facts an experiment record copies. */
  evidence: CandidateEvidence;
  result: ScanAssetResult;
  model: CanonicalScore;
  setups: ModelSetups;
  day: string;
}>) {
  const risk = riskLabel({ model, setups });
  const riskWhy = riskReasons(model, setups);
  const freshness = evidence.facts.find(([name]) => name === 'Freshness')?.[1];
  return (
    <>
      <h5 className="scan-effects-title">Recorded evidence it rests on</h5>
      <dl className="scan-facts">
        {evidence.facts.map(([name, value]) => (
          <Fact
            key={name}
            name={name}
            value={
              name === 'Freshness' ? (
                <span className={cn(evidence.stale && 'scan-stale')}>{value}</span>
              ) : (
                value
              )
            }
          />
        ))}
      </dl>
      <p className="spot-standing">
        {setups.long ? (
          <span className="market-scan-tag is-long">Long setup</span>
        ) : (
          <span className="market-scan-tag">No Long setup</span>
        )}
        {risk && <span className="market-scan-tag is-risk">{risk}</span>}
        {evidence.stale && <span className="market-scan-tag scan-stale">Stale</span>}
        <span>{standingText(result.ticker, model.version, setups, day, riskWhy)}</span>
      </p>
      {evidence.stale && (
        <p className="market-scan-fit scan-stale">
          {freshness}. The recorded close and setups describe that day, not the market now.
        </p>
      )}
    </>
  );
}

/** One labeled decimal input, with its note and its validation message tied to it. */
function ScenarioInput({
  id,
  name,
  unit,
  value,
  error,
  note,
  onChange,
}: Readonly<{
  id: string;
  name: ScenarioField;
  unit: string;
  value: string;
  error: string | undefined;
  note?: ReactNode;
  onChange: (value: string) => void;
}>) {
  const errorId = `${id}-${name}-error`;
  const noteId = `${id}-${name}-note`;
  const describedBy = [error && errorId, note && noteId].filter(Boolean).join(' ');
  return (
    <div className="spot-field">
      <label htmlFor={`${id}-${name}`}>
        {LABEL[name]} <span className="market-scan-rule">{unit}</span>
      </label>
      <input
        id={`${id}-${name}`}
        className="portfolio-cash-input"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        name={`spot-${name}`}
        placeholder={name === 'feePercent' ? 'Not specified' : undefined}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {note && (
        <span id={noteId} className="market-scan-fit">
          {note}
        </span>
      )}
      {error && (
        <span id={errorId} className="spot-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** The worked scenario and what it leaves out. */
function ScenarioFigures({
  scenario,
  base,
  symbol,
  modelBacked,
}: Readonly<{ scenario: Scenario; base: string; symbol: string; modelBacked: boolean }>) {
  const { fees } = scenario;
  const loss = fees
    ? `${fees.lossWithFees} USDT with assumed fees (${scenario.lossAtStop} price move)`
    : `${scenario.lossAtStop} USDT, price move only`;
  const assumed = fees
    ? `${fees.entry} USDT at entry + ${fees.exit} USDT at the stop`
    : 'Not specified: every figure excludes fees';
  return (
    <>
      <h5 className="scan-effects-title">Hypothetical scenario</h5>
      <dl className="scan-facts">
        <Fact name="Illustrative quantity" value={`${scenario.quantity} ${base}`} />
        <Fact name="Limited by" value={LIMITED_BY[scenario.limitedBy]} />
        <Fact name="Position notional" value={`${scenario.notional} USDT`} />
        <Fact name="Unallocated" value={`${scenario.unallocated} USDT`} />
        <Fact
          name="Entry to stop"
          value={`${scenario.stopDistance} USDT per ${base} (${scenario.stopDistancePercent} of entry)`}
        />
        <Fact name="Planned loss at the stop reference" value={loss} />
        <Fact name="Assumed fees" value={assumed} />
      </dl>
      <ul className="market-scan-notes">
        <li>
          Illustrative quantity, floored to 0.00000001 {base}. Binance&rsquo;s lot size, minimum
          notional and price filters for {symbol} were not checked, so this is not an executable
          order.
        </li>
        <li>
          The stop reference is a planning input, not a placed stop and not a guaranteed maximum: a
          gap, a fast market or execution costs can make the loss larger.
        </li>
        <li>
          Excludes slippage{fees ? '' : ' and fees'}. USDT amounts are rounded to the cent; the
          exact amounts stay within your allocation and loss budget
          {fees ? ', assumed fees included' : ''}.
        </li>
        <li>
          Hypothetical arithmetic only: no recommendation, target, forecast or expected return.
          {modelBacked ? '' : ' Not model-backed: this pair has no Long setup.'}
        </li>
      </ul>
    </>
  );
}

/** Why no figure is shown yet: what is missing, or that something needs correcting. */
function promptText(check: Extract<ScenarioCheck, { ok: false }>): string {
  if (check.errors.form) return check.errors.form;
  if (check.missing.length === 0) return 'Correct the inputs above to see the arithmetic.';
  const names = check.missing.map((name) => LABEL[name].toLowerCase()).join(', ');
  return `Enter ${names} to see the arithmetic.`;
}

/**
 * The owner's own hypothetical arithmetic for one evaluated Binance Spot USDT pair, beside
 * the evidence it was read from. In component memory only: it reads no balance, quote or
 * exchange filter and offers no order, and its inputs and figures are never sent or saved.
 * Record experiment stores only the owner's decision and this evidence, after review. The
 * caller keys it by scan and asset, so another selection never inherits these values.
 */
export function SpotScenario({
  result,
  model,
  setups,
  cohort,
  scan,
  scanId,
  source,
  saved,
}: Readonly<{
  result: ScanAssetResult;
  model: CanonicalScore;
  setups: ModelSetups;
  cohort: ScanCohort;
  scan: MarketScan;
  scanId: string | undefined;
  source: TradingViewDevSource;
  /** A saved scan's read-back record; absent for the published view. */
  saved: TradingViewSavedScan | undefined;
}>) {
  const id = useId();
  const [inputs, setInputs] = useState<ScenarioInputs>(EMPTY_SCENARIO);
  const [recording, setRecording] = useState(false);
  const evidenceAt = (now: number) =>
    candidateEvidence({ result, model, setups, cohort, scan, scanId, source, now });
  const check = planSpotScenario(inputs);
  const base = result.ticker.split('-')[0] ?? result.ticker;
  const symbol = result.instrument ?? result.ticker;
  const day = resultAsOfLabel(result);
  const close = decimalInput(model.close);
  const errors: ScenarioErrors = check.ok ? {} : check.errors;
  const input = (name: ScenarioField, unit: string, note?: ReactNode) => (
    <ScenarioInput
      id={id}
      name={name}
      unit={unit}
      value={inputs[name]}
      error={errors[name]}
      note={note}
      onChange={(value) => setInputs((current) => ({ ...current, [name]: value }))}
    />
  );

  return (
    <section aria-labelledby={`${id}-title`} className="spot-scenario">
      <h4 id={`${id}-title`} className="quant-breakdown-title">
        Manual Spot scenario
      </h4>
      <p className="market-scan-fit">
        Your own hypothetical arithmetic for {symbol} on Binance Spot. Popup reads no balance or
        quote and places no orders. The scenario is never saved; choosing another asset or scan
        clears it.
      </p>
      <details className="scan-guide-details">
        <summary>Plan a hypothetical scenario</summary>
        <RecordedEvidence
          evidence={evidenceAt(Date.now())}
          result={result}
          model={model}
          setups={setups}
          day={day}
        />

        <fieldset className="spot-inputs">
          <legend className="scan-effects-title">Your hypothetical inputs</legend>
          {input('allocation', 'USDT')}
          {input('maxLoss', 'USDT')}
          {input(
            'entry',
            `USDT per ${base}`,
            <>
              Recorded close of the {day}: {close} USDT. Historical, not a current or executable
              quote.{' '}
              <button
                type="button"
                className="scan-link-button"
                onClick={() => setInputs((current) => ({ ...current, entry: close }))}
              >
                Use it as the entry
              </button>
            </>,
          )}
          {input('stop', `USDT per ${base}, below entry`)}
          {input(
            'feePercent',
            '% of each fill',
            'Optional, charged at entry and at the stop. Empty leaves fees out of every figure.',
          )}
          <button
            type="button"
            className="portfolio-cash-btn"
            onClick={() => setInputs(EMPTY_SCENARIO)}
          >
            Clear scenario
          </button>
        </fieldset>

        <div className="spot-result" aria-live="polite">
          {check.ok ? (
            <ScenarioFigures
              scenario={check.scenario}
              base={base}
              symbol={symbol}
              modelBacked={setups.long}
            />
          ) : (
            <p className={cn('market-scan-fit', errors.form && 'spot-field-error')}>
              {promptText(check)} No figure is shown until every input is valid.
            </p>
          )}
        </div>
      </details>
      <details
        className="scan-guide-details"
        onToggle={(event) => setRecording(event.currentTarget.open)}
      >
        <summary>Record experiment</summary>
        {/* Mounted only while open: nothing asks the database anything until the owner looks. */}
        {recording && (
          <RecordSpotExperiment
            evidence={() => evidenceAt(Date.now())}
            scanId={scanId}
            saved={saved}
          />
        )}
      </details>
    </section>
  );
}
