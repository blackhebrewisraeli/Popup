import type { ReactNode } from 'react';
import { SCENARIO_FIELD_LABEL, type LimitedBy } from '@/lib/spotScenario';
import type { ScenarioSnapshot, ScenarioSnapshotFigures } from '@/lib/spotScenarioSnapshot';

const LIMITED_BY: Record<LimitedBy, string> = {
  allocation: 'Allocation',
  maxLoss: 'Planned-loss budget',
  both: 'Allocation and planned-loss budget equally',
};

function Fact({ name, value }: Readonly<{ name: string; value: ReactNode }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** The worked scenario and what it leaves out: the planner's figures, or a snapshot's as stored. */
export function ScenarioFigures({
  scenario,
  base,
  symbol,
  modelBacked,
}: Readonly<{
  scenario: ScenarioSnapshotFigures;
  base: string;
  symbol: string;
  modelBacked: boolean;
}>) {
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

/**
 * A scenario snapshot exactly as stored: the owner's input strings, then the figures as they were
 * shown. Nothing is worked out again, so a later change to the planner never alters it.
 */
export function ScenarioSnapshotFacts({
  snapshot,
  base,
  symbol,
  modelBacked,
}: Readonly<{ snapshot: ScenarioSnapshot; base: string; symbol: string; modelBacked: boolean }>) {
  const { inputs } = snapshot;
  return (
    <>
      <h5 className="scan-effects-title">Scenario inputs, as typed</h5>
      <dl className="scan-facts">
        <Fact name={SCENARIO_FIELD_LABEL.allocation} value={`${inputs.allocation} USDT`} />
        <Fact name={SCENARIO_FIELD_LABEL.maxLoss} value={`${inputs.maxLoss} USDT`} />
        <Fact name={SCENARIO_FIELD_LABEL.entry} value={`${inputs.entry} USDT per ${base}`} />
        <Fact name={SCENARIO_FIELD_LABEL.stop} value={`${inputs.stop} USDT per ${base}`} />
        <Fact
          name={SCENARIO_FIELD_LABEL.feePercent}
          value={
            inputs.feePercent === null
              ? 'Not specified'
              : `${inputs.feePercent}% of each fill, as stated`
          }
        />
        <Fact name="Calculation" value={`${snapshot.calculationVersion}, in the browser`} />
      </dl>
      <ScenarioFigures
        scenario={snapshot.figures}
        base={base}
        symbol={symbol}
        modelBacked={modelBacked}
      />
      <ul className="market-scan-notes">
        <li>
          A planning record, not a rule: it sets or approves no allocation, stop, horizon, target or
          exit. Only rule entries do.
        </li>
        <li>
          Client-submitted: the browser worked these figures out, and the database checks their
          shape, not their arithmetic. They are hypothetical, not a placed order, a verified balance
          or an actual fill, and say nothing about performance.
        </li>
      </ul>
    </>
  );
}
