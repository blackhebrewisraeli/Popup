import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  ENDPOINTS,
  FAPI_ORIGIN,
  FIXED_CONTRACT,
  REQUEST_TIMEOUT_MS,
  contractGate,
  contractProblems,
  formatUtc,
  readPublicContractData,
  type ContractFacts,
  type FactsGroup,
  type FactsSnapshot,
  type Failure,
  type FilterState,
  type FundingFacts,
  type GroupResult,
  type PremiumFacts,
  type TickerFacts,
} from '@/lib/perpetualContractFacts';

type View = { phase: 'idle' } | { phase: 'reading' } | { phase: 'done'; snapshot: FactsSnapshot };

const ACCOUNT_SPECIFIC = 'Account-specific — not read; enter manually.';

function Fact({ name, value }: Readonly<{ name: string; value: ReactNode }>) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function failureText(failure: Failure): string {
  switch (failure.kind) {
    case 'network':
      return 'The browser received no response. A CORS block, a regional or network restriction, an extension or being offline can cause this, and the browser does not say which.';
    case 'timeout':
      return `No complete response within ${failure.ms / 1000} seconds, so the request was stopped.`;
    case 'cancelled':
      return 'The read was stopped before a response arrived.';
    case 'http':
      return `Binance answered HTTP ${failure.status}.`;
    case 'malformed':
      return `The response did not have the documented shape: ${failure.detail}`;
    case 'unsupported':
      return `Unsupported contract: ${failure.detail}`;
  }
}

/** One endpoint: where it came from, when it arrived, the provider's own time, then its facts. */
function Group<T>({
  id,
  title,
  group,
  result,
  providerTime,
  children,
}: Readonly<{
  id: string;
  title: string;
  group: FactsGroup;
  result: GroupResult<T>;
  providerTime: (data: T) => string;
  children: (data: T) => ReactNode;
}>) {
  return (
    <section className="perp-facts-group" aria-labelledby={id}>
      <h4 id={id} className="scan-effects-title">
        {title}
      </h4>
      <dl className="scan-facts perp-facts-source">
        <Fact name="Source" value={`GET ${FAPI_ORIGIN}${ENDPOINTS[group]}`} />
        <Fact name="Received" value={`${formatUtc(result.receivedAt)} · this device’s clock`} />
        <Fact
          name="Provider time"
          value={result.ok ? providerTime(result.data) : 'None: no usable response'}
        />
      </dl>
      {result.ok ? (
        children(result.data)
      ) : (
        <p className="spot-failed">
          <strong>Unavailable.</strong> {failureText(result.failure)} Nothing from this endpoint is
          shown, and it is not requested again until you press the button.
        </p>
      )}
    </section>
  );
}

function filterValue<K extends string>(
  filter: FilterState<K>,
  field: K,
  unit: string,
  type: string,
): string {
  if (filter.state === 'missing') return `Not reported: no ${type} filter in the response`;
  if (filter.state === 'malformed') return `Malformed: ${filter.field} is not a plain decimal`;
  return `${filter.values[field]} ${unit}`;
}

function ContractBody({ facts }: Readonly<{ facts: ContractFacts }>) {
  const problems = contractProblems(facts);
  const { priceFilter, lotSize, marketLotSize, minNotional, liquidationFee } = facts;
  let fee = 'Not reported in the response';
  if (liquidationFee.state === 'malformed') fee = 'Malformed: not a plain decimal';
  if (liquidationFee.state === 'reported')
    fee = `${liquidationFee.value} (${liquidationFee.percent} %) · reported, context only; the simulation does not use it`;
  return (
    <>
      <dl className="scan-facts">
        <Fact name="Symbol" value={facts.symbol} />
        <Fact name="Contract type" value={facts.contractType} />
        <Fact name="Pair" value={facts.pair} />
        <Fact name="Status" value={facts.status} />
        <Fact name="Base asset" value={facts.baseAsset} />
        <Fact name="Quote asset" value={facts.quoteAsset} />
        <Fact name="Margin asset" value={facts.marginAsset} />
      </dl>
      {problems.length > 0 ? (
        <div className="spot-failed">
          <strong>Unsupported contract.</strong> This panel describes only the TRXUSDT USDⓈ-M
          perpetual with USDT quote and margin, while it is TRADING.
          <ul className="perp-facts-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          Its filters and the other endpoints are not shown.
        </div>
      ) : (
        <>
          <p className="market-scan-fit">
            Matches the fixed instrument: {FIXED_CONTRACT.symbol} USDⓈ-M perpetual, quote and margin{' '}
            {FIXED_CONTRACT.marginAsset}, status TRADING.
          </p>
          <dl className="scan-facts">
            <Fact
              name="Price tick size"
              value={filterValue(priceFilter, 'tickSize', 'USDT', 'PRICE_FILTER')}
            />
            <Fact
              name="Minimum price"
              value={filterValue(priceFilter, 'minPrice', 'USDT', 'PRICE_FILTER')}
            />
            <Fact
              name="Maximum price"
              value={filterValue(priceFilter, 'maxPrice', 'USDT', 'PRICE_FILTER')}
            />
            <Fact
              name="LOT_SIZE step"
              value={filterValue(lotSize, 'stepSize', facts.baseAsset, 'LOT_SIZE')}
            />
            <Fact
              name="LOT_SIZE minimum"
              value={filterValue(lotSize, 'minQty', facts.baseAsset, 'LOT_SIZE')}
            />
            <Fact
              name="LOT_SIZE maximum"
              value={filterValue(lotSize, 'maxQty', facts.baseAsset, 'LOT_SIZE')}
            />
            <Fact
              name="MARKET_LOT_SIZE step"
              value={filterValue(marketLotSize, 'stepSize', facts.baseAsset, 'MARKET_LOT_SIZE')}
            />
            <Fact
              name="MARKET_LOT_SIZE minimum"
              value={filterValue(marketLotSize, 'minQty', facts.baseAsset, 'MARKET_LOT_SIZE')}
            />
            <Fact
              name="MARKET_LOT_SIZE maximum"
              value={filterValue(marketLotSize, 'maxQty', facts.baseAsset, 'MARKET_LOT_SIZE')}
            />
            <Fact
              name="Minimum notional"
              value={filterValue(minNotional, 'notional', 'USDT', 'MIN_NOTIONAL')}
            />
            <Fact name="Liquidation fee rate" value={fee} />
          </dl>
          <p className="market-scan-fit">
            Filters are shown as reported. Popup does not check an order or the simulation against
            them.
          </p>
        </>
      )}
    </>
  );
}

function PremiumBody({ facts }: Readonly<{ facts: PremiumFacts }>) {
  return (
    <>
      <dl className="scan-facts">
        <Fact name="Mark price" value={`${facts.markPrice} USDT per unit`} />
        <Fact
          name="Reported funding rate"
          value={`${facts.lastFundingRate} (${facts.lastFundingRatePercent} %) · lastFundingRate`}
        />
        <Fact name="Next funding time" value={formatUtc(facts.nextFundingTime)} />
      </dl>
      <p className="market-scan-fit">
        The mark price is not the last traded price; Binance uses the mark price for liquidation.
      </p>
      <p className="market-scan-fit">
        Binance documents lastFundingRate as the latest funding rate. It is a reported value, not a
        settled one, and nothing here says it will settle unchanged at the next funding time. It is
        not the simulation’s carrying cost, which covers a whole holding period you choose.
      </p>
    </>
  );
}

function TickerBody({ facts }: Readonly<{ facts: TickerFacts }>) {
  return (
    <>
      <dl className="scan-facts">
        <Fact name="Last price" value={`${facts.price} USDT per unit`} />
      </dl>
      <p className="market-scan-fit">
        The perpetual’s last traded price: not its mark price, and not the Spot TRXUSDT price.
      </p>
    </>
  );
}

function FundingBody({ facts }: Readonly<{ facts: FundingFacts }>) {
  if (!facts.published) {
    return (
      <p className="leverage-unavailable">
        <strong>Not published for {FIXED_CONTRACT.symbol}.</strong> fundingInfo lists only contracts
        whose funding cap, floor or interval was adjusted, so no interval, cap or floor is shown and
        none is assumed.
      </p>
    );
  }
  return (
    <dl className="scan-facts">
      <Fact name="Funding interval" value={`${facts.fundingIntervalHours} hours, as published`} />
      <Fact name="Funding rate cap" value={`${facts.cap} (${facts.capPercent} %)`} />
      <Fact name="Funding rate floor" value={`${facts.floor} (${facts.floorPercent} %)`} />
    </dl>
  );
}

function Snapshot({ id, snapshot }: Readonly<{ id: string; snapshot: FactsSnapshot }>) {
  const gate = contractGate(snapshot.contract);
  return (
    <div className="perp-facts-groups">
      <Group
        id={`${id}-contract`}
        title="Contract and filters · exchangeInfo"
        group="contract"
        result={snapshot.contract}
        providerTime={() => 'None used: Binance documents exchangeInfo serverTime as “ignore”'}
      >
        {(facts) => <ContractBody facts={facts} />}
      </Group>

      {gate === 'unsupported' ? (
        <p className="spot-failed">
          Mark price, last price and funding are not shown, because the contract check failed.
        </p>
      ) : (
        <>
          {gate === 'unconfirmed' && (
            <p className="leverage-unavailable">
              <strong>Contract not confirmed.</strong> exchangeInfo gave no usable answer, so the
              identity and status of {FIXED_CONTRACT.symbol} are unchecked. The groups below are
              checked only against their own symbol field.
            </p>
          )}
          <Group
            id={`${id}-premium`}
            title="Mark price and funding rate · premiumIndex"
            group="premium"
            result={snapshot.premium}
            providerTime={(facts) => `${formatUtc(facts.time)} · premiumIndex time`}
          >
            {(facts) => <PremiumBody facts={facts} />}
          </Group>
          <Group
            id={`${id}-ticker`}
            title="Last price · ticker/price v2"
            group="ticker"
            result={snapshot.ticker}
            providerTime={(facts) => `${formatUtc(facts.time)} · ticker time (transaction time)`}
          >
            {(facts) => <TickerBody facts={facts} />}
          </Group>
          <Group
            id={`${id}-funding`}
            title="Funding schedule · fundingInfo"
            group="funding"
            result={snapshot.funding}
            providerTime={() => 'None in the response'}
          >
            {(facts) => <FundingBody facts={facts} />}
          </Group>
        </>
      )}
    </div>
  );
}

function statusText(view: View): string {
  if (view.phase === 'idle') {
    return 'Not read. Pressing the button sends one GET to each of 4 public endpoints.';
  }
  if (view.phase === 'reading') return 'Reading 4 public endpoints. Earlier results are cleared.';
  const { snapshot } = view;
  if (contractGate(snapshot.contract) === 'unsupported') {
    return 'Read finished: the contract check failed, so only the contract is shown.';
  }
  const usable = [snapshot.contract, snapshot.premium, snapshot.ticker, snapshot.funding].filter(
    (group) => group.ok,
  ).length;
  return usable === 4
    ? 'Read finished: 4 of 4 endpoints returned usable data.'
    : `Read finished: ${usable} of 4 endpoints returned usable data. The others are marked unavailable.`;
}

/**
 * Public, read-only facts about the Binance USDⓈ-M TRXUSDT perpetual, read only on request
 * (docs/LEVERAGE_SIMULATION.md#public-contract-data). It never fills or changes the simulation.
 */
export function PerpetualContractFacts() {
  const id = useId();
  const [view, setView] = useState<View>({ phase: 'idle' });
  const readId = useRef(0);
  const inFlight = useRef<AbortController | null>(null);

  // On unmount, stop the requests and make any late answer obsolete.
  useEffect(
    () => () => {
      readId.current += 1;
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );

  const read = () => {
    if (inFlight.current) return;
    const current = ++readId.current;
    const controller = new AbortController();
    inFlight.current = controller;
    setView({ phase: 'reading' });
    void readPublicContractData({ signal: controller.signal }).then((snapshot) => {
      if (readId.current !== current) return;
      inFlight.current = null;
      setView({ phase: 'done', snapshot });
    });
  };

  const reading = view.phase === 'reading';
  return (
    <section
      className="portfolio-workspace-card leverage-card perp-facts-card"
      aria-labelledby={`${id}-title`}
    >
      <div>
        <h3 id={`${id}-title`} className="portfolio-section-title">
          TRXUSDT perpetual: public contract data <span className="spot-chip">USDⓈ-M</span>
        </h3>
        <p className="spot-note">
          Public facts about the Binance USDⓈ-M TRXUSDT perpetual contract, a different instrument
          from Spot TRXUSDT. Popup reads them in this browser from {FAPI_ORIGIN}, only when you
          press the button, with no account, key or proxy. Each request stops after{' '}
          {REQUEST_TIMEOUT_MS / 1000} seconds and is not retried. Nothing is saved, refreshed on its
          own, or copied into the simulation.
        </p>
      </div>

      <div className="account-actions">
        <button
          type="button"
          className="portfolio-cash-btn"
          aria-disabled={reading || undefined}
          onClick={read}
        >
          Read public contract data
        </button>
      </div>
      <output className="market-scan-fit spot-record-status">{statusText(view)}</output>

      {view.phase === 'done' && <Snapshot id={id} snapshot={view.snapshot} />}

      <section className="perp-facts-group" aria-labelledby={`${id}-account`}>
        <h4 id={`${id}-account`} className="scan-effects-title">
          Not read: account parameters
        </h4>
        <dl className="scan-facts">
          <Fact name="Trading fee rates" value={ACCOUNT_SPECIFIC} />
          <Fact name="Maintenance-margin bracket" value={ACCOUNT_SPECIFIC} />
        </dl>
        <p className="market-scan-fit">
          Public fee schedules and public bracket tables are not your account’s parameters, so Popup
          does not show them here or use them.
        </p>
      </section>
    </section>
  );
}
