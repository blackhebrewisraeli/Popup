import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PerpetualWorkspace } from '@/components/PerpetualFilterComparison';
import { formatUtc, type FactsGroup } from '@/lib/perpetualContractFacts';
import type { FilterCheck } from '@/lib/perpetualFilterComparison';
import type { PerpetualField } from '@/lib/perpetualScenario';
import {
  TRX_PERPETUAL,
  exchangeInfoBody,
  json,
  mockFetch,
  type Reply,
} from './perpetualFactsFixtures';

const RECEIVED = Date.UTC(2026, 10, 14, 21, 16, 25, 123);

/** Synthetic inputs: 30 USDT at an entry of 0.3 is a quantity of exactly 100. */
const FIXTURE: Partial<Record<PerpetualField, string>> = {
  collateral: '10',
  size: '30',
  entry: '0.3',
  exit: '0.33',
  entryFeePercent: '0',
  exitFeePercent: '0',
  carryingCost: '0',
  maintenanceRatePercent: '1',
  maintenanceAmount: '0',
  bracketFloor: '0',
  bracketCap: '1000000',
};
const LABEL: Record<PerpetualField, RegExp> = {
  collateral: /^Starting collateral/,
  size: /^(Target notional|Leverage)/,
  entry: /^Entry fill/,
  exit: /^Exit fill/,
  stopTrigger: /^Stop trigger/,
  entryFeePercent: /^Entry fee rate/,
  exitFeePercent: /^Exit fee rate/,
  carryingCost: /^Carrying cost/,
  maintenanceRatePercent: /^Maintenance margin rate/,
  maintenanceAmount: /^Maintenance amount/,
  bracketFloor: /^Bracket floor/,
  bracketCap: /^Bracket cap/,
};

const simulation = () => screen.getByRole('region', { name: /^Leverage simulation/ });
const factsCard = () =>
  screen.getByRole('region', { name: /^TRXUSDT perpetual: public contract data/ });
const card = () =>
  screen.getByRole('region', { name: /^Scenario against TRXUSDT perpetual filters/ });
const compareButton = () =>
  within(card()).getByRole('button', { name: 'Compare this scenario with TRXUSDT perpetual' });
const status = () => within(card()).getByRole('status');
const textbox = (name: PerpetualField) =>
  within(simulation()).getByRole('textbox', { name: LABEL[name] });

function fill(values: Partial<Record<PerpetualField, string>>) {
  for (const [name, value] of Object.entries(values)) {
    fireEvent.change(textbox(name as PerpetualField), { target: { value } });
  }
}

/** Every dt → dd under root, in order. */
function pairs(root: HTMLElement): [string, string][] {
  return [...root.querySelectorAll('dt')].map((dt) => [
    dt.textContent ?? '',
    dt.nextElementSibling?.textContent ?? '',
  ]);
}

/** The checks of one group, as rule → [compared, constraint, result]. */
function checks(name: RegExp): Partial<Record<FilterCheck['rule'], [string, string, string]>> {
  const region = within(card()).getByRole('region', { name });
  const out: Partial<Record<FilterCheck['rule'], [string, string, string]>> = {};
  for (const item of within(region).getAllByRole('listitem')) {
    const rule = within(item).getByRole('heading').textContent ?? '';
    const values = pairs(item).map(([, value]) => value);
    out[rule as FilterCheck['rule']] = [values[0] ?? '', values[1] ?? '', values[2] ?? ''];
  }
  return out;
}

async function read(replies: Partial<Record<FactsGroup, Reply>> = {}) {
  const fetchMock = mockFetch(replies);
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    fireEvent.click(within(factsCard()).getByRole('button', { name: 'Read public contract data' }));
  });
  return fetchMock;
}

/** The individual checks on screen, one heading each. */
const shownChecks = () => within(card()).queryAllByRole('heading', { level: 5 });

function compare() {
  fireEvent.click(compareButton());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(RECEIVED);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PerpetualFilterComparison: explicit binding', () => {
  it('compares nothing and sends nothing until both parts exist and the button is pressed', async () => {
    const idle = vi.fn();
    vi.stubGlobal('fetch', idle);
    render(<PerpetualWorkspace />);
    expect(status()).toHaveTextContent(
      'Needs a valid result in Leverage simulation; a public contract read (Read public contract data).',
    );
    expect(compareButton()).toHaveAttribute('aria-disabled', 'true');
    expect(compareButton()).not.toBeDisabled();
    compare();
    expect(shownChecks()).toHaveLength(0);
    expect(card()).toHaveTextContent('None: no validated TRXUSDT contract snapshot');

    fill(FIXTURE);
    expect(status()).toHaveTextContent('Needs a public contract read');
    const fetchMock = await read();
    expect(status()).toHaveTextContent('Not compared yet.');
    expect(compareButton()).not.toHaveAttribute('aria-disabled');
    expect(shownChecks()).toHaveLength(0);
    expect(card()).toHaveTextContent(`${formatUtc(RECEIVED)} · this device’s clock`);
    expect(idle).not.toHaveBeenCalled();

    compare();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(card()).toHaveTextContent(
      `Compared asTRXUSDT USDⓈ-M perpetual, by your press at ${formatUtc(RECEIVED)}`,
    );
    expect(status()).toHaveTextContent(
      'Compared: of 13 separate checks, 13 within, 0 outside and 0 not checked. There is no overall verdict.',
    );
  });

  it('shows each check with its compared value, reported constraint and result', async () => {
    render(<PerpetualWorkspace />);
    fill({ ...FIXTURE, size: '30.15' });
    await read();
    compare();
    expect(checks(/^Quantity · LOT_SIZE/)).toEqual({
      Minimum: ['100.5 TRX', 'at least minQty 1 TRX', 'within this constraint'],
      Maximum: ['100.5 TRX', 'at most maxQty 20000000 TRX', 'within this constraint'],
      Step: [
        '100.5 TRX',
        '(quantity − minQty 1) a whole multiple of stepSize 1 TRX',
        'outside this constraint. (quantity − minQty) leaves 0.5 TRX over a whole number of steps.',
      ],
    });
    expect(checks(/^Quantity · MARKET_LOT_SIZE/).Maximum).toEqual([
      '100.5 TRX',
      'at most maxQty 5000000 TRX',
      'within this constraint',
    ]);
    expect(checks(/^Entry fill · PRICE_FILTER/).Tick).toEqual([
      '0.3 USDT per unit',
      '(price − minPrice 0.00132) a whole multiple of tickSize 0.00001 USDT',
      'within this constraint',
    ]);
    expect(checks(/^Simulated entry notional · MIN_NOTIONAL/).Minimum).toEqual([
      '30.15 USDT (quantity × entry fill)',
      'at least notional 5 USDT',
      'within this constraint',
    ]);
    expect(card()).toHaveTextContent(
      'this does not validate a Market order’s exchange reference-price calculation',
    );
    expect(card()).toHaveTextContent(
      'These checks do not establish account eligibility, sufficient collateral, maintenance-bracket validity, price-band compliance, liquidity or order acceptance.',
    );
    expect(card()).not.toHaveTextContent(/ready to trade|eligible|acceptable/i);
  });

  it('never changes a simulation input', async () => {
    render(<PerpetualWorkspace />);
    fill({ ...FIXTURE, size: '30.15' });
    const before = within(simulation())
      .getAllByRole('textbox')
      .map((box) => (box as HTMLInputElement).value);
    await read();
    compare();
    const after = within(simulation())
      .getAllByRole('textbox')
      .map((box) => (box as HTMLInputElement).value);
    expect(after).toEqual(before);
  });

  it('refuses a snapshot that failed the contract check', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read({
      contract: () => json(exchangeInfoBody({ ...TRX_PERPETUAL, status: 'SETTLING' })),
    });
    expect(status()).toHaveTextContent(
      'Needs a contract snapshot that passed the TRXUSDT contract check; the last read did not.',
    );
    compare();
    expect(shownChecks()).toHaveLength(0);
  });
});

describe('PerpetualFilterComparison: staleness (Popup policy)', () => {
  it('keeps conclusions at 60 seconds and withholds them one millisecond later', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    compare();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(status()).toHaveTextContent('Compared: of 13 separate checks, 13 within');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(status()).toHaveTextContent(
      'Conclusions withheld: the contract snapshot is older than 60 seconds (Popup policy).',
    );
    const results = shownChecks().map((heading) => pairs(heading.closest('li') ?? heading)[2]?.[1]);
    expect(results).toHaveLength(13);
    for (const result of results) {
      expect(result).toBe(
        'not checked. Withheld: the snapshot is older than 60 seconds (Popup policy). Read public contract data again, then compare again.',
      );
    }
    expect(card()).toHaveTextContent(`${formatUtc(RECEIVED)} · this device’s clock · stale`);
    expect(compareButton()).toHaveAttribute('aria-disabled', 'true');
  });

  it('checks the age again at the press, even before the timer runs', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    vi.setSystemTime(RECEIVED + 60_001);
    compare();
    expect(shownChecks()).toHaveLength(0);
    expect(status()).toHaveTextContent(
      'Needs a snapshot no older than 60 seconds: read public contract data again.',
    );
  });

  it('needs a new read and a new press after the snapshot goes stale', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    compare();
    act(() => {
      vi.advanceTimersByTime(60_001);
    });
    const later = RECEIVED + 60_001;
    await read();
    expect(status()).toHaveTextContent(
      'The earlier comparison was cleared because the public data was read again. Nothing is compared again until you press the button. Not compared yet.',
    );
    compare();
    expect(card()).toHaveTextContent(`Received ${formatUtc(later)} · this device’s clock`);
    expect(status()).toHaveTextContent('13 within');
  });
});

describe('PerpetualFilterComparison: invalidation', () => {
  it('clears when an input changes and compares again only on a press', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    compare();
    fill({ exit: '0.330005' });
    expect(shownChecks()).toHaveLength(0);
    expect(status()).toHaveTextContent(
      'The earlier comparison was cleared because the simulation inputs changed.',
    );
    compare();
    expect(checks(/^Exit fill · PRICE_FILTER/).Tick?.[2]).toBe(
      'outside this constraint. (price − minPrice) leaves 0.000005 USDT over a whole number of ticks.',
    );
  });

  it('clears when the simulation is cleared', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    compare();
    fireEvent.click(within(simulation()).getByRole('button', { name: 'Clear simulation' }));
    expect(shownChecks()).toHaveLength(0);
    expect(status()).toHaveTextContent('Needs a valid result in Leverage simulation.');
  });

  it('clears as soon as a new public read begins', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    compare();
    await read({ ticker: 'hang' });
    expect(shownChecks()).toHaveLength(0);
    expect(status()).toHaveTextContent(
      'The earlier comparison was cleared because a new public read began.',
    );
    expect(status()).toHaveTextContent('Needs the public read in progress to finish.');
  });

  it('clears when a new public read fails', async () => {
    render(<PerpetualWorkspace />);
    fill(FIXTURE);
    await read();
    compare();
    await read({ contract: () => json({ code: 0 }, 451) });
    expect(shownChecks()).toHaveLength(0);
    expect(status()).toHaveTextContent(
      'The earlier comparison was cleared because the new public read did not return a usable contract.',
    );
    expect(card()).toHaveTextContent('None: no validated TRXUSDT contract snapshot');
  });
});
