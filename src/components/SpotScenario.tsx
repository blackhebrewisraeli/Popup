import { useId, useState, type ReactNode } from 'react';
import { RecordSpotNoEntry } from '@/components/RecordSpotNoEntry';
import { RecordSpotExperiment } from '@/components/RecordSpotExperiment';
import { ScenarioFigures } from '@/components/ScenarioFacts';
import type { CanonicalScore, ModelSetups } from '@/lib/canonicalModel';
import type { MarketScan, ScanAssetResult, ScanCohort } from '@/lib/marketScanner';
import { resultAsOfLabel, riskLabel } from '@/lib/scanReview';
import {
  decimalInput,
  EMPTY_SCENARIO,
  planSpotScenario,
  SCENARIO_FIELD_LABEL as LABEL,
  type ScenarioCheck,
  type ScenarioErrors,
  type ScenarioField,
  type ScenarioInputs,
} from '@/lib/spotScenario';
import { candidateEvidence, riskReasons, type CandidateEvidence } from '@/lib/spotExperiments';
import type { TradingViewDevSource, TradingViewSavedScan } from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

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

/** Why no figure is shown yet: what is missing, or that something needs correcting. */
function promptText(check: Extract<ScenarioCheck, { ok: false }>): string {
  if (check.errors.form) return check.errors.form;
  if (check.missing.length === 0) return 'Correct the inputs above to see the arithmetic.';
  const names = check.missing.map((name) => LABEL[name].toLowerCase()).join(', ');
  return `Enter ${names} to see the arithmetic.`;
}

/**
 * The owner's own hypothetical arithmetic for one evaluated Binance Spot USDT pair, beside
 * the evidence it was read from. In component memory: it reads no balance, quote or exchange
 * filter and offers no order. Record experiment stores the owner's decision and this evidence,
 * and these inputs and figures only when the owner includes them and confirms the review. The
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
        Optional, and separate from reviewing the evidence above: a review is not a trading
        decision. The scenario is your own hypothetical arithmetic for {symbol} on Binance Spot.
        Popup reads no balance or quote and places no orders. The scenario is saved only if you
        include it when you record an experiment; choosing another asset or scan clears it.
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
      {saved && scanId && (
        <RecordSpotNoEntry
          key={saved.snapshotSha256}
          scanId={scanId}
          snapshotSha256={saved.snapshotSha256}
          evidence={() => evidenceAt(Date.now())}
        />
      )}
      <details
        className="scan-guide-details"
        onToggle={(event) => setRecording(event.currentTarget.open)}
      >
        <summary>Record experiment (saves to Account)</summary>
        {/* Mounted only while open: nothing asks the database anything until the owner looks. */}
        {recording && (
          <RecordSpotExperiment
            evidence={() => evidenceAt(Date.now())}
            scanId={scanId}
            saved={saved}
            scenario={inputs}
            context={[scanId, scan.evaluationTime, saved?.snapshotSha256, symbol].join('|')}
          />
        )}
      </details>
    </section>
  );
}
