import { useId, useState } from 'react';
import {
  EMPTY_PERPETUAL,
  simulatePerpetualLong,
  type LiquidationReference,
  type PerpetualCheck,
  type PerpetualField,
  type PerpetualInputs,
  type PerpetualScenario,
} from '@/lib/perpetualScenario';
import { cn } from '@/lib/utils';

type Sizing = PerpetualInputs['sizing'];
type Unavailable = Exclude<LiquidationReference, { status: 'reference' }>;
type ReferenceKey = keyof PerpetualScenario['liquidation'];

interface FieldCopy {
  label: string;
  unit: string;
  note: string;
}

const FIELDS: Record<Exclude<PerpetualField, 'size'>, FieldCopy> = {
  collateral: {
    label: 'Starting collateral',
    unit: 'USDT',
    note: 'The isolated collateral you assume for this scenario. Not read from any balance.',
  },
  entry: {
    label: 'Entry fill',
    unit: 'USDT per unit',
    note: 'The hypothetical price the long opens at.',
  },
  exit: {
    label: 'Exit fill',
    unit: 'USDT per unit',
    note: 'The hypothetical price the long closes at. Every result below uses this fill.',
  },
  stopTrigger: {
    label: 'Stop trigger',
    unit: 'USDT per unit · optional',
    note: 'Below entry. Only compared with the fill and the references, never used as the fill. Leave empty to skip.',
  },
  entryFeePercent: {
    label: 'Entry fee rate',
    unit: '% of entry notional',
    note: 'A percent of that fill’s notional, up to 4 decimals. Enter 0 for no fee.',
  },
  exitFeePercent: {
    label: 'Exit fee rate',
    unit: '% of exit notional',
    note: 'A percent of that fill’s notional, up to 4 decimals. Enter 0 for no fee.',
  },
  carryingCost: {
    label: 'Carrying cost',
    unit: 'USDT, signed',
    note: 'One amount for the whole holding period, such as funding. Positive is paid and lowers equity; negative, with a leading minus, is received and raises it. Enter 0 for none.',
  },
  maintenanceRatePercent: {
    label: 'Maintenance margin rate',
    unit: '% of notional',
    note: 'The rate of the bracket you believe applies: a percent, not a leverage multiple. Up to 4 decimals.',
  },
  maintenanceAmount: {
    label: 'Maintenance amount',
    unit: 'USDT',
    note: 'That bracket’s maintenance amount. Enter 0 if it has none.',
  },
  bracketFloor: {
    label: 'Bracket floor',
    unit: 'USDT notional',
    note: 'The lowest notional that bracket covers, inclusive.',
  },
  bracketCap: {
    label: 'Bracket cap',
    unit: 'USDT notional',
    note: 'The highest notional that bracket covers, inclusive. Above the floor.',
  },
};

const SIZE: Record<Sizing, FieldCopy & { option: string }> = {
  notional: {
    option: 'Target notional (USDT)',
    label: 'Target notional',
    unit: 'USDT',
    note: 'The position value at entry. Quantity is floored to 0.00000001, so the simulated notional can sit just below it.',
  },
  leverage: {
    option: 'Leverage (× collateral)',
    label: 'Leverage',
    unit: '× collateral',
    note: 'A multiple, not a percent: target notional = collateral × leverage. Quantity is floored, so the simulated notional can sit just below it.',
  },
};

const REFERENCES: { key: ReferenceKey; title: string; name: string; assumption: string }[] = [
  {
    key: 'zeroCost',
    title: 'Zero-cost reference',
    name: 'zero-cost',
    assumption: 'Starts from the full starting collateral. Fees and carrying cost are left out.',
  },
  {
    key: 'afterCosts',
    title: 'After-cost reference',
    name: 'after-cost',
    assumption:
      'Starts from the collateral minus the entry fee and the whole carrying cost, as if both were charged against the isolated collateral before the price move. The exit fee and any liquidation fee are not included; a carrying credit adds to the collateral.',
  },
];

const fieldLabel = (name: PerpetualField, sizing: Sizing) =>
  name === 'size' ? SIZE[sizing].label : FIELDS[name].label;

/** Picks a word by the sign of an engine decimal, which writes zero as "0" and negatives with "-". */
function bySign(value: string, negative: string, zero: string, positive: string): string {
  if (value.startsWith('-')) return negative;
  return value === '0' ? zero : positive;
}

/** One labeled decimal input, with its unit note and its validation message tied to it. */
function Field({
  id,
  name,
  copy,
  value,
  error,
  onChange,
}: Readonly<{
  id: string;
  name: PerpetualField;
  copy: FieldCopy;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}>) {
  const inputId = `${id}-${name}`;
  const errorId = `${inputId}-error`;
  const noteId = `${inputId}-note`;
  return (
    <div className="spot-field">
      <label htmlFor={inputId}>
        {copy.label} <span className="market-scan-rule">{copy.unit}</span>
      </label>
      <input
        id={inputId}
        className="portfolio-cash-input"
        type="text"
        // A decimal keypad has no minus sign, and the carrying cost can be negative.
        inputMode={name === 'carryingCost' ? 'text' : 'decimal'}
        autoComplete="off"
        spellCheck={false}
        name={`leverage-${name}`}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${errorId} ${noteId}` : noteId}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={noteId} className="market-scan-fit">
        {copy.note}
      </span>
      {error && (
        <span id={errorId} className="spot-field-error">
          {error}
        </span>
      )}
    </div>
  );
}

function Fact({ name, value }: Readonly<{ name: string; value: string }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Why no reference price is given, in plain words. Never a price of its own. */
function unavailableText(reference: Unavailable): string {
  switch (reference.status) {
    case 'collateral_exhausted':
      return 'The costs use up the collateral before any price move, so there is no price to solve for.';
    case 'no_positive_solution':
      return 'The equation has no price above 0: the collateral and the maintenance amount cover the whole entry notional. This does not mean the position cannot be liquidated.';
    case 'not_below_entry':
      return 'The equation solves at or above the entry price: on these inputs, equity at entry is already at or below the maintenance requirement.';
    case 'negative_requirement':
      return 'Where the equation solves, the maintenance requirement would be below zero: the maintenance amount is larger than the rate times the notional there. Equity would already have reached zero at a higher price, so that point is not a liquidation reference.';
    case 'bracket_mismatch':
      return 'The equation solves at a notional outside the bracket floor and cap you entered, so that bracket’s rate and amount do not apply there.';
  }
}

const sideText = (side: 'above_reference' | 'at_or_below_reference') =>
  side === 'above_reference' ? 'Above the reference' : 'At or below the reference';

function Reference({
  id,
  title,
  assumption,
  reference,
}: Readonly<{ id: string; title: string; assumption: string; reference: LiquidationReference }>) {
  return (
    <section className="leverage-reference" aria-labelledby={id}>
      <h5 id={id} className="scan-effects-title">
        {title}
      </h5>
      <p className="market-scan-fit">{assumption}</p>
      <dl className="scan-facts">
        <Fact name="Collateral before the move" value={`${reference.collateralBeforeMove} USDT`} />
        {reference.status === 'reference' && (
          <>
            <Fact
              name="Reference price"
              value={`${reference.price} USDT per unit, rounded up (exactly ${reference.exact.numerator}/${reference.exact.denominator})`}
            />
            <Fact
              name="Notional at the reference"
              value={`${reference.notionalAtReference} USDT, rounded up`}
            />
            <Fact name="Exit fill" value={sideText(reference.exitFill)} />
            <Fact
              name="Stop trigger"
              value={reference.stopTrigger ? sideText(reference.stopTrigger) : 'Not entered'}
            />
          </>
        )}
        {reference.status === 'bracket_mismatch' && (
          <Fact
            name="Notional where it solves"
            value={`${reference.notionalAtReference} USDT, rounded up`}
          />
        )}
      </dl>
      {reference.status === 'reference' ? (
        <p className="market-scan-fit">{reference.note}</p>
      ) : (
        <p className="leverage-unavailable">
          <strong>No reference price.</strong> {unavailableText(reference)}
        </p>
      )}
    </section>
  );
}

/** The conditions that change how the figures should be read, each stated once. */
function warningsOf(scenario: PerpetualScenario): { key: string; text: string; note?: string }[] {
  const list: { key: string; text: string; note?: string }[] = [];
  if (scenario.collateralExhausted) {
    list.push({
      key: 'exhausted',
      text: `Collateral exhausted: equity at the exit fill is ${scenario.equityAtExit} USDT, zero or below. The arithmetic is not clamped, and it does not say what Binance would do before or at that point.`,
    });
  }
  for (const { key, name } of REFERENCES) {
    const reference = scenario.liquidation[key];
    if (reference.status !== 'reference') continue;
    if (reference.exitFill === 'at_or_below_reference') {
      list.push({
        key: `${key}-exit`,
        text: `The exit fill (${scenario.exitFill.price}) is at or below the ${name} liquidation reference (${reference.price}). On these assumptions the position could be liquidated before that fill, so the result may never be reached.`,
        note: reference.note,
      });
    }
    if (reference.stopTrigger === 'at_or_below_reference') {
      list.push({
        key: `${key}-stop`,
        text: `The stop trigger (${scenario.exitFill.stopTrigger}) is at or below the ${name} liquidation reference (${reference.price}). On these assumptions the reference could be reached before the stop triggers.`,
        note: reference.note,
      });
    }
  }
  return list;
}

type Warning = ReturnType<typeof warningsOf>[number];

function Results({
  id,
  scenario,
  sizing,
  warnings,
}: Readonly<{ id: string; scenario: PerpetualScenario; sizing: Sizing; warnings: Warning[] }>) {
  const carry = bySign(
    scenario.carryingCost,
    'Received: raises equity',
    'None',
    'Paid: lowers equity',
  );
  const net = bySign(scenario.netResult, 'Loss', 'No change', 'Gain');
  const { exitFill } = scenario;
  return (
    <>
      {warnings.length > 0 && (
        <div className="leverage-warnings">
          <h4 className="scan-effects-title">Warnings</h4>
          <ul>
            {warnings.map((warning) => (
              <li key={warning.key}>
                {warning.text}
                {warning.note && <span className="leverage-warning-note"> {warning.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <h4 className="scan-effects-title">Hypothetical result</h4>
      <dl className="scan-facts">
        <Fact
          name={
            sizing === 'notional' ? 'Target notional' : 'Target notional (collateral × leverage)'
          }
          value={`${scenario.targetNotional} USDT`}
        />
        <Fact name="Simulated entry notional" value={`${scenario.entryNotional} USDT`} />
        <Fact name="Quantity" value={`${scenario.quantity} units, floored to 0.00000001`} />
        <Fact name="Exit notional" value={`${scenario.exitNotional} USDT`} />
        <Fact name="Entry fee" value={`${scenario.fees.entry} USDT`} />
        <Fact name="Exit fee" value={`${scenario.fees.exit} USDT`} />
        <Fact name="Total fees" value={`${scenario.fees.total} USDT`} />
        <Fact name="Carrying cost" value={`${scenario.carryingCost} USDT · ${carry}`} />
        <Fact name="Price move" value={`${scenario.priceMove} USDT`} />
        <Fact name="Equity at the exit fill" value={`${scenario.equityAtExit} USDT`} />
        <Fact name="Net result" value={`${scenario.netResult} USDT · ${net}`} />
        <Fact
          name="Change against starting collateral"
          value={`${scenario.collateralChangePercent} %`}
        />
      </dl>

      <h4 className="scan-effects-title">Exit fill and stop trigger</h4>
      <dl className="scan-facts">
        <Fact name="Exit fill · used for the result" value={`${exitFill.price} USDT per unit`} />
        <Fact
          name="Stop trigger · compared only"
          value={exitFill.stopTrigger ? `${exitFill.stopTrigger} USDT per unit` : 'Not entered'}
        />
        {exitFill.priceMinusTrigger && (
          <Fact
            name="Exit fill minus stop trigger"
            value={`${exitFill.priceMinusTrigger} USDT per unit`}
          />
        )}
      </dl>
      <p className="market-scan-fit">
        The stop trigger is never used as the fill. A market stop can fill away from its trigger;
        the result uses only the exit fill you entered.
      </p>

      <h4 className="scan-effects-title">Simplified liquidation references</h4>
      <p className="market-scan-fit">
        Where equity would equal the maintenance requirement of the bracket you entered: collateral
        + quantity × (price − entry) = quantity × price × rate − amount. Each is given only when the
        inputs hold together; otherwise it says why.
      </p>
      <div className="leverage-references">
        {REFERENCES.map(({ key, title, assumption }) => (
          <Reference
            key={key}
            id={`${id}-${key}`}
            title={title}
            assumption={assumption}
            reference={scenario.liquidation[key]}
          />
        ))}
      </div>

      <ul className="market-scan-notes">
        <li>
          Hypothetical arithmetic on the numbers above. It is not an executable order, a
          Binance-verified price or liquidation level, an eligibility check or a guaranteed maximum
          loss.
        </li>
        <li>
          Not modelled: the mark price, funding timing, partial liquidation and its fee, which
          wallet pays fees and funding, other brackets along the way, other positions, lot size,
          minimum notional, tick size and slippage.
        </li>
        <li>
          USDT figures are exact. The percentage is rounded half away from zero to 4 decimals;
          reference prices and notionals are rounded up to 0.00000001.
        </li>
      </ul>
    </>
  );
}

/** Says what is missing or needs correcting before any figure is shown. */
function promptText(check: Extract<PerpetualCheck, { ok: false }>, sizing: Sizing): string {
  if (check.errors.form) return check.errors.form;
  const parts: string[] = [];
  const invalid = Object.keys(check.errors).length;
  if (invalid > 0) {
    parts.push(
      invalid === 1 ? 'Correct the marked input.' : `Correct the ${invalid} marked inputs.`,
    );
  }
  if (check.missing.length > 0) {
    const names = check.missing.map((name) => fieldLabel(name, sizing).toLowerCase());
    parts.push(`Enter ${names.join(', ')}.`);
  }
  parts.push('No figure is shown until every input is valid.');
  return parts.join(' ');
}

/**
 * Offline arithmetic for one isolated, USDT-margined perpetual long, from numbers the owner
 * types (docs/LEVERAGE_SIMULATION.md). Every figure comes from simulatePerpetualLong. Inputs
 * live in component memory only: no balance, quote, rate, scan or setting prefills them, and
 * nothing is saved or sent. Results are derived on every render, so an invalid edit removes
 * them at once.
 */
export function LeverageSimulation() {
  const id = useId();
  const [inputs, setInputs] = useState<PerpetualInputs>(EMPTY_PERPETUAL);
  const check = simulatePerpetualLong(inputs);
  const errors = check.ok ? {} : check.errors;
  const field = (name: PerpetualField) => (
    <Field
      id={id}
      name={name}
      copy={name === 'size' ? SIZE[inputs.sizing] : FIELDS[name]}
      value={inputs[name]}
      error={errors[name]}
      onChange={(value) => setInputs((current) => ({ ...current, [name]: value }))}
    />
  );
  // The size number means something else under the other sizing, so it is not carried over.
  const setSizing = (sizing: Sizing) =>
    setInputs((current) =>
      current.sizing === sizing ? current : { ...current, sizing, size: '' },
    );
  const warnings = check.ok ? warningsOf(check.scenario) : [];
  let status = 'Hypothetical result below.';
  if (!check.ok) status = promptText(check, inputs.sizing);
  else if (warnings.length === 1) status = 'Hypothetical result below, with 1 warning.';
  else if (warnings.length > 1)
    status = `Hypothetical result below, with ${warnings.length} warnings.`;

  return (
    <section className="portfolio-workspace-card leverage-card" aria-labelledby={`${id}-title`}>
      <div>
        <h3 id={`${id}-title`} className="portfolio-section-title">
          Leverage simulation <span className="spot-chip">Offline</span>
        </h3>
        <p className="spot-note">
          Hypothetical arithmetic for one isolated, USDT-margined perpetual long, from numbers you
          type. This simulation reads no balance, price, rate or account setting, and it suggests no
          leverage and rates no risk. Nothing here is saved or sent; reloading the page clears it.
        </p>
      </div>

      <fieldset className="spot-inputs">
        <legend className="scan-effects-title">Position</legend>
        {field('collateral')}
        <fieldset className="leverage-sizing">
          <legend>Size the position by</legend>
          {(['notional', 'leverage'] as const).map((sizing) => (
            <label key={sizing}>
              <input
                type="radio"
                name={`${id}-sizing`}
                value={sizing}
                checked={inputs.sizing === sizing}
                onChange={() => setSizing(sizing)}
              />
              {SIZE[sizing].option}
            </label>
          ))}
        </fieldset>
        {field('size')}
        {field('entry')}
        {field('exit')}
        {field('stopTrigger')}
      </fieldset>

      <fieldset className="spot-inputs">
        <legend className="scan-effects-title">Costs</legend>
        {field('entryFeePercent')}
        {field('exitFeePercent')}
        {field('carryingCost')}
      </fieldset>

      <fieldset className="spot-inputs">
        <legend className="scan-effects-title">Maintenance assumptions</legend>
        <p className="market-scan-fit leverage-group-note">
          The one bracket you believe applies where the reference solves. Popup holds no rate,
          amount or bracket of its own.
        </p>
        {field('maintenanceRatePercent')}
        {field('maintenanceAmount')}
        {field('bracketFloor')}
        {field('bracketCap')}
      </fieldset>

      <div className="account-actions">
        <button
          type="button"
          className="portfolio-cash-btn"
          onClick={() => setInputs(EMPTY_PERPETUAL)}
        >
          Clear simulation
        </button>
      </div>

      <div className="spot-result">
        <output
          className={cn(
            'market-scan-fit spot-record-status',
            !check.ok && errors.form && 'spot-field-error',
          )}
        >
          {status}
        </output>
        {check.ok && (
          <Results id={id} scenario={check.scenario} sizing={inputs.sizing} warnings={warnings} />
        )}
      </div>
    </section>
  );
}
