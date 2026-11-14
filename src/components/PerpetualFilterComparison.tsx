import { useEffect, useId, useReducer, useState } from 'react';
import { LeverageSimulation } from '@/components/LeverageSimulation';
import { PerpetualContractFacts, type FactsView } from '@/components/PerpetualContractFacts';
import {
  FIXED_CONTRACT,
  contractGate,
  formatUtc,
  type ContractFacts,
  type FactsSnapshot,
} from '@/lib/perpetualContractFacts';
import {
  STALE_AFTER_MS,
  compareWithFilters,
  isStale,
  type CheckGroup,
  type FilterCheck,
  type Outcome,
} from '@/lib/perpetualFilterComparison';
import {
  EMPTY_PERPETUAL,
  simulatePerpetualLong,
  type PerpetualInputs,
} from '@/lib/perpetualScenario';
import { cn } from '@/lib/utils';

/** One explicit press: these inputs, this snapshot, these checks. */
interface Comparison {
  inputs: PerpetualInputs;
  snapshot: FactsSnapshot;
  receivedAt: number;
  boundAt: number;
  groups: CheckGroup[];
}

interface Validated {
  snapshot: FactsSnapshot;
  facts: ContractFacts;
  receivedAt: number;
}

const OUTCOME_TEXT: Record<Outcome, string> = {
  within: 'within this constraint',
  outside: 'outside this constraint',
  not_checked: 'not checked',
};

const POLICY = `Popup policy: a contract snapshot older than ${STALE_AFTER_MS / 1000} seconds is stale, and no conclusion is shown from it.`;
const WITHHELD = `Withheld: the snapshot is older than ${STALE_AFTER_MS / 1000} seconds (Popup policy). Read public contract data again, then compare again.`;

const GROUP_NOTES: Record<CheckGroup['filter'], string> = {
  LOT_SIZE:
    'Binance defines LOT_SIZE as the symbol’s quantity rule and MARKET_LOT_SIZE for MARKET orders. The simulation has no order type, so both are shown and neither is chosen.',
  MARKET_LOT_SIZE:
    'Binance defines MARKET_LOT_SIZE for MARKET orders. It is checked on its own, never merged with LOT_SIZE.',
  PRICE_FILTER:
    'Your hypothetical fill against PRICE_FILTER only. PERCENT_PRICE, the band around the mark price, is not checked, and the stop trigger is not compared.',
  MIN_NOTIONAL:
    'Arithmetic only: quantity × your entry fill against the reported minimum. Binance values a MARKET order at the mark price, which is not read here, so this does not validate a Market order’s exchange reference-price calculation.',
};

/** The contract group of a finished read, only when it passed the fixed-contract check. */
function validated(view: FactsView): Validated | null {
  if (view.phase !== 'done') return null;
  const { contract } = view.snapshot;
  if (!contract.ok || contractGate(contract) !== 'confirmed') return null;
  return { snapshot: view.snapshot, facts: contract.data, receivedAt: contract.receivedAt };
}

function Fact({
  name,
  value,
  className,
}: Readonly<{ name: string; value: string; className?: string }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd className={className}>{value}</dd>
    </div>
  );
}

function Check({ id, check }: Readonly<{ id: string; check: FilterCheck }>) {
  const result = OUTCOME_TEXT[check.outcome] + (check.detail ? `. ${check.detail}` : '');
  return (
    <li>
      <h5 id={id} className="perp-compare-rule">
        {check.rule}
      </h5>
      <dl className="scan-facts perp-compare-check">
        <Fact name="Compared value" value={check.compared} />
        <Fact name="Reported constraint" value={check.constraint} />
        <Fact
          name="Result"
          value={result}
          className={cn(
            check.outcome === 'outside' && 'perp-compare-outside',
            check.outcome === 'not_checked' && 'perp-compare-unchecked',
          )}
        />
      </dl>
    </li>
  );
}

function Groups({
  id,
  groups,
  stale,
}: Readonly<{ id: string; groups: CheckGroup[]; stale: boolean }>) {
  return (
    <div className="perp-facts-groups">
      {groups.map((group, g) => (
        <section
          key={`${group.subject}-${group.filter}`}
          className="perp-facts-group"
          aria-labelledby={`${id}-g${g}`}
        >
          <h4 id={`${id}-g${g}`} className="scan-effects-title">
            {group.subject} · {group.filter}
          </h4>
          <ul className="perp-compare-checks">
            {group.checks.map((check, c) => (
              <Check
                key={check.rule}
                id={`${id}-g${g}-c${c}`}
                check={stale ? { ...check, outcome: 'not_checked', detail: WITHHELD } : check}
              />
            ))}
          </ul>
          <p className="market-scan-fit">{GROUP_NOTES[group.filter]}</p>
        </section>
      ))}
    </div>
  );
}

/** What the press still needs, in the order the owner would fix it. */
function needs(simulationValid: boolean, view: FactsView, fresh: Validated | null): string[] {
  const list: string[] = [];
  if (!simulationValid) list.push('a valid result in Leverage simulation');
  if (view.phase === 'idle') list.push('a public contract read (Read public contract data)');
  else if (view.phase === 'reading') list.push('the public read in progress to finish');
  else if (!validated(view))
    list.push('a contract snapshot that passed the TRXUSDT contract check; the last read did not');
  else if (!fresh)
    list.push(
      `a snapshot no older than ${STALE_AFTER_MS / 1000} seconds: read public contract data again`,
    );
  return list;
}

function clearedBecause(comparison: Comparison, view: FactsView): string {
  if (view.phase === 'reading') return 'a new public read began';
  if (view.phase !== 'done' || view.snapshot !== comparison.snapshot) {
    return validated(view)
      ? 'the public data was read again'
      : 'the new public read did not return a usable contract';
  }
  return 'the simulation inputs changed';
}

function count(groups: CheckGroup[], outcome: Outcome): number {
  return groups.flatMap((group) => group.checks).filter((check) => check.outcome === outcome)
    .length;
}

/**
 * Arithmetic checks of the current simulation against the TRXUSDT perpetual filters the public
 * read reported (docs/LEVERAGE_SIMULATION.md#filter-comparison). Only an explicit press binds the
 * scenario to that contract. It sends no request, never changes an input, and clears itself when
 * the inputs change or a new read begins.
 */
export function PerpetualFilterComparison({
  inputs,
  facts,
}: Readonly<{ inputs: PerpetualInputs; facts: FactsView }>) {
  const id = useId();
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const check = simulatePerpetualLong(inputs);
  const snapshot = validated(facts);
  const receivedAt = snapshot?.receivedAt ?? null;
  const stale = receivedAt !== null && isStale(receivedAt, Date.now());

  // Re-render once the snapshot turns stale. A timer only: nothing is requested.
  useEffect(() => {
    if (receivedAt === null || stale) return;
    const timer = setTimeout(rerender, receivedAt + STALE_AFTER_MS + 1 - Date.now());
    return () => clearTimeout(timer);
  }, [receivedAt, stale]);

  const current =
    comparison && comparison.inputs === inputs && comparison.snapshot === snapshot?.snapshot
      ? comparison
      : null;
  const missing = needs(check.ok, facts, stale ? null : snapshot);

  const compare = () => {
    if (!check.ok || !snapshot || missing.length > 0) return;
    // The age is checked again at the press, not only at the last render.
    if (isStale(snapshot.receivedAt, Date.now())) {
      rerender();
      return;
    }
    setComparison({
      inputs,
      snapshot: snapshot.snapshot,
      receivedAt: snapshot.receivedAt,
      boundAt: Date.now(),
      groups: compareWithFilters(check.scenario, snapshot.facts),
    });
  };

  let status: string;
  if (current && stale) {
    status = `Conclusions withheld: the contract snapshot is older than ${STALE_AFTER_MS / 1000} seconds (Popup policy). Read public contract data again, then compare again.`;
  } else if (current) {
    const total = current.groups.flatMap((group) => group.checks).length;
    status = `Compared: of ${total} separate checks, ${count(current.groups, 'within')} within, ${count(current.groups, 'outside')} outside and ${count(current.groups, 'not_checked')} not checked. There is no overall verdict.`;
  } else {
    const parts: string[] = [];
    if (comparison) {
      parts.push(
        `The earlier comparison was cleared because ${clearedBecause(comparison, facts)}. Nothing is compared again until you press the button.`,
      );
    }
    parts.push(missing.length > 0 ? `Needs ${missing.join('; ')}.` : 'Not compared yet.');
    status = parts.join(' ');
  }

  return (
    <section
      className="portfolio-workspace-card leverage-card perp-compare-card"
      aria-labelledby={`${id}-title`}
    >
      <div>
        <h3 id={`${id}-title`} className="portfolio-section-title">
          Scenario against TRXUSDT perpetual filters <span className="spot-chip">Arithmetic</span>
        </h3>
        <p className="spot-note">
          The simulation does not name an instrument. Pressing the button states that you are
          comparing this hypothetical scenario with the Binance USDⓈ-M {FIXED_CONTRACT.symbol}{' '}
          perpetual, using the contract snapshot already read above. It sends no request and changes
          no input: quantity is compared with LOT_SIZE and MARKET_LOT_SIZE, the entry and exit fills
          with PRICE_FILTER, and the simulated entry notional with MIN_NOTIONAL.
        </p>
      </div>

      <dl className="scan-facts perp-facts-source">
        <Fact
          name="Contract snapshot received"
          value={
            receivedAt === null
              ? 'None: no validated TRXUSDT contract snapshot'
              : `${formatUtc(receivedAt)} · this device’s clock${stale ? ' · stale' : ''}`
          }
        />
        <Fact name="Staleness" value={POLICY} />
      </dl>

      <div className="account-actions">
        <button
          type="button"
          className="portfolio-cash-btn"
          aria-disabled={missing.length > 0 || undefined}
          onClick={compare}
        >
          Compare this scenario with {FIXED_CONTRACT.symbol} perpetual
        </button>
      </div>
      <output className="market-scan-fit spot-record-status">{status}</output>

      {current && (
        <>
          <dl className="scan-facts">
            <Fact
              name="Compared as"
              value={`${FIXED_CONTRACT.symbol} USDⓈ-M perpetual, by your press at ${formatUtc(current.boundAt)}`}
            />
            <Fact
              name="Snapshot used"
              value={`Received ${formatUtc(current.receivedAt)} · this device’s clock`}
            />
          </dl>
          <Groups id={id} groups={current.groups} stale={stale} />
        </>
      )}

      <ul className="market-scan-notes">
        <li>
          These checks do not establish account eligibility, sufficient collateral,
          maintenance-bracket validity, price-band compliance, liquidity or order acceptance. Each
          line is one arithmetic check against one reported constraint; there is no overall verdict.
        </li>
        <li>
          Exact decimal arithmetic on the simulation’s own figures and the snapshot’s own strings.
          Nothing is rounded, resized or changed; a value outside a constraint is shown as it is.
        </li>
        <li>
          A changed input or a new public read clears the comparison. Comparing again always needs
          another press.
        </li>
      </ul>
    </section>
  );
}

/**
 * The offline simulation, the public TRXUSDT perpetual facts and the comparison between them.
 * Keyed by account in AccountPanel, so nothing typed or read crosses accounts.
 */
export function PerpetualWorkspace() {
  const [inputs, setInputs] = useState<PerpetualInputs>(EMPTY_PERPETUAL);
  const [facts, setFacts] = useState<FactsView>({ phase: 'idle' });
  return (
    <>
      <LeverageSimulation onInputsChange={setInputs} />
      <PerpetualContractFacts onViewChange={setFacts} />
      <PerpetualFilterComparison inputs={inputs} facts={facts} />
    </>
  );
}
