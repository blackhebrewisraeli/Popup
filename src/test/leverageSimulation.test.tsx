import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeverageSimulation } from '@/components/LeverageSimulation';
import {
  EMPTY_PERPETUAL,
  SHARED_PRICE_NOTE,
  simulatePerpetualLong,
  type LiquidationReference,
  type PerpetualField,
  type PerpetualInputs,
} from '@/lib/perpetualScenario';

/**
 * Labeled synthetic inputs from docs/LEVERAGE_SIMULATION.md: no value here is a quote, a
 * balance, a rate or a recommendation.
 */
const FIXTURE: Partial<Record<PerpetualField, string>> = {
  collateral: '10',
  size: '50',
  entry: '1',
  exit: '0.96',
  entryFeePercent: '0',
  exitFeePercent: '0',
  carryingCost: '0',
  maintenanceRatePercent: '1',
  maintenanceAmount: '0',
  bracketFloor: '0',
  bracketCap: '50000',
};

const LABEL: Record<Exclude<PerpetualField, 'size'>, string> = {
  collateral: 'Starting collateral',
  entry: 'Entry fill',
  exit: 'Exit fill',
  stopTrigger: 'Stop trigger',
  entryFeePercent: 'Entry fee rate',
  exitFeePercent: 'Exit fee rate',
  carryingCost: 'Carrying cost',
  maintenanceRatePercent: 'Maintenance margin rate',
  maintenanceAmount: 'Maintenance amount',
  bracketFloor: 'Bracket floor',
  bracketCap: 'Bracket cap',
};

const section = () => screen.getByRole('region', { name: /^Leverage simulation/ });
const textbox = (label: string) =>
  within(section()).getByRole('textbox', { name: new RegExp(`^${label}`) });
const input = (name: PerpetualField) =>
  name === 'size'
    ? within(section()).getByRole('textbox', { name: /^(Target notional|Leverage)/ })
    : textbox(LABEL[name]);
const status = () => within(section()).getByRole('status');

function fill(values: Partial<Record<PerpetualField, string>>) {
  for (const [name, value] of Object.entries(values)) {
    fireEvent.change(input(name as PerpetualField), { target: { value } });
  }
}

/** Every dt → dd pair under root, by the dt's text. */
function facts(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dt of root.querySelectorAll('dt')) {
    out[dt.textContent ?? ''] = dt.nextElementSibling?.textContent ?? '';
  }
  return out;
}

const reference = (title: 'Zero-cost reference' | 'After-cost reference') =>
  within(section()).getByRole('region', { name: title });

/** The figures on screen must be the engine's own strings for the same inputs. */
function expectEngineFigures(
  values: Partial<Record<PerpetualField, string>>,
  sizing: PerpetualInputs['sizing'],
) {
  const check = simulatePerpetualLong({ ...EMPTY_PERPETUAL, ...values, sizing });
  if (!check.ok) throw new Error(JSON.stringify(check));
  const s = check.scenario;
  const shown = facts(section());
  expect(shown).toMatchObject({
    Quantity: `${s.quantity} units, floored to 0.00000001`,
    'Simulated entry notional': `${s.entryNotional} USDT`,
    'Exit notional': `${s.exitNotional} USDT`,
    'Entry fee': `${s.fees.entry} USDT`,
    'Exit fee': `${s.fees.exit} USDT`,
    'Total fees': `${s.fees.total} USDT`,
    'Price move': `${s.priceMove} USDT`,
    'Equity at the exit fill': `${s.equityAtExit} USDT`,
    'Change against starting collateral': `${s.collateralChangePercent} %`,
    'Exit fill · used for the result': `${s.exitFill.price} USDT per unit`,
  });
  expect(shown['Net result']?.startsWith(`${s.netResult} USDT · `)).toBe(true);
  expect(shown['Carrying cost']?.startsWith(`${s.carryingCost} USDT · `)).toBe(true);
  const target =
    sizing === 'notional' ? 'Target notional' : 'Target notional (collateral × leverage)';
  expect(shown[target]).toBe(`${s.targetNotional} USDT`);
  for (const [key, title] of [
    ['zeroCost', 'Zero-cost reference'],
    ['afterCosts', 'After-cost reference'],
  ] as const) {
    const engine: LiquidationReference = s.liquidation[key];
    const region = reference(title);
    const shownRef = facts(region);
    expect(shownRef['Collateral before the move']).toBe(`${engine.collateralBeforeMove} USDT`);
    if (engine.status === 'reference') {
      expect(shownRef['Reference price']).toBe(
        `${engine.price} USDT per unit, rounded up (exactly ${engine.exact.numerator}/${engine.exact.denominator})`,
      );
      expect(shownRef['Notional at the reference']).toBe(
        `${engine.notionalAtReference} USDT, rounded up`,
      );
      expect(region).toHaveTextContent(SHARED_PRICE_NOTE);
    } else {
      expect(shownRef['Reference price']).toBeUndefined();
      expect(region).toHaveTextContent('No reference price.');
    }
  }
  return s;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  // Offline by design: nothing in this section may reach the network.
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('LeverageSimulation: inputs', () => {
  it('starts with every numeric field empty, sizing by notional and no figure', () => {
    render(<LeverageSimulation />);
    const boxes = within(section()).getAllByRole('textbox');
    expect(boxes).toHaveLength(12);
    for (const box of boxes) expect(box).toHaveValue('');
    expect(within(section()).getByRole('radio', { name: 'Target notional (USDT)' })).toBeChecked();
    expect(status()).toHaveTextContent(
      'Enter starting collateral, target notional, entry fill, exit fill, entry fee rate, exit fee rate, carrying cost, maintenance margin rate, maintenance amount, bracket floor, bracket cap. No figure is shown until every input is valid.',
    );
    expect(within(section()).queryByRole('heading', { name: 'Hypothetical result' })).toBeNull();
    expect(section()).not.toHaveTextContent(/recommended|risk rating/i);
  });

  it('groups inputs into position, costs and maintenance assumptions and explains each unit', () => {
    render(<LeverageSimulation />);
    for (const legend of ['Position', 'Costs', 'Maintenance assumptions']) {
      expect(within(section()).getByRole('group', { name: legend })).toBeInTheDocument();
    }
    const costs = within(section()).getByRole('group', { name: 'Costs' });
    expect(
      within(costs).getByRole('textbox', { name: 'Entry fee rate % of entry notional' }),
    ).toBeInTheDocument();
    expect(input('carryingCost')).toHaveAccessibleDescription(
      expect.stringContaining(
        'Positive is paid and lowers equity; negative, with a leading minus, is received and raises it.',
      ),
    );
    expect(input('maintenanceRatePercent')).toHaveAccessibleDescription(
      expect.stringContaining('a percent, not a leverage multiple'),
    );
  });

  it('sizes by leverage as a multiple of collateral and clears the size when sizing changes', () => {
    render(<LeverageSimulation />);
    fill(FIXTURE);
    expect(status()).toHaveTextContent('Hypothetical result below.');

    fireEvent.click(within(section()).getByRole('radio', { name: 'Leverage (× collateral)' }));
    const leverage = within(section()).getByRole('textbox', { name: 'Leverage × collateral' });
    expect(leverage).toHaveValue('');
    expect(leverage).toHaveAccessibleDescription(
      expect.stringContaining('A multiple, not a percent'),
    );
    expect(status()).toHaveTextContent('Enter leverage.');
    expect(within(section()).queryByRole('heading', { name: 'Hypothetical result' })).toBeNull();

    // Losses 0.8, 2, 4; references 50/99, 80/99, 10/11 (docs/LEVERAGE_SIMULATION.md).
    for (const [multiple, loss, exact] of [
      ['2', '-0.8', '50/99'],
      ['5', '-2', '80/99'],
      ['10', '-4', '10/11'],
    ] as const) {
      fill({ size: multiple });
      const s = expectEngineFigures({ ...FIXTURE, size: multiple }, 'leverage');
      expect(s.netResult).toBe(loss);
      expect(facts(reference('Zero-cost reference'))['Reference price']).toContain(
        `exactly ${exact}`,
      );
    }
  });
});

describe('LeverageSimulation: results', () => {
  it('shows the accepted 10/50/1/0.96 fixture exactly as the engine computes it', () => {
    render(<LeverageSimulation />);
    fill(FIXTURE);
    expectEngineFigures(FIXTURE, 'notional');
    expect(facts(section())).toMatchObject({
      'Target notional': '50 USDT',
      Quantity: '50 units, floored to 0.00000001',
      'Simulated entry notional': '50 USDT',
      'Exit notional': '48 USDT',
      'Total fees': '0 USDT',
      'Carrying cost': '0 USDT · None',
      'Equity at the exit fill': '8 USDT',
      'Net result': '-2 USDT · Loss',
      'Change against starting collateral': '-20 %',
      'Stop trigger · compared only': 'Not entered',
    });
    for (const title of ['Zero-cost reference', 'After-cost reference'] as const) {
      expect(facts(reference(title))).toEqual({
        'Collateral before the move': '10 USDT',
        'Reference price': '0.80808081 USDT per unit, rounded up (exactly 80/99)',
        'Notional at the reference': '40.40404041 USDT, rounded up',
        'Exit fill': 'Above the reference',
        'Stop trigger': 'Not entered',
      });
    }
    expect(within(section()).queryByRole('heading', { name: 'Warnings' })).toBeNull();
    expect(section()).toHaveTextContent(
      'It is not an executable order, a Binance-verified price or liquidation level, an eligibility check or a guaranteed maximum loss.',
    );
  });

  it('charges fees and a paid carrying cost against equity and the after-cost reference', () => {
    render(<LeverageSimulation />);
    const values = {
      ...FIXTURE,
      entryFeePercent: '0.05',
      exitFeePercent: '0.05',
      carryingCost: '0.105',
    };
    fill(values);
    expectEngineFigures(values, 'notional');
    expect(facts(section())).toMatchObject({
      'Entry fee': '0.025 USDT',
      'Exit fee': '0.024 USDT',
      'Total fees': '0.049 USDT',
      'Carrying cost': '0.105 USDT · Paid: lowers equity',
      'Equity at the exit fill': '7.846 USDT',
      'Change against starting collateral': '-21.54 %',
    });
    expect(facts(reference('Zero-cost reference'))['Reference price']).toContain('exactly 80/99');
    expect(facts(reference('After-cost reference'))).toMatchObject({
      'Collateral before the move': '9.87 USDT',
      'Reference price': expect.stringContaining('exactly 4013/4950'),
    });
  });

  it('adds a carrying credit to equity and lowers the after-cost reference', () => {
    render(<LeverageSimulation />);
    const values = { ...FIXTURE, carryingCost: '-0.105' };
    fill(values);
    expectEngineFigures(values, 'notional');
    expect(facts(section())).toMatchObject({
      'Carrying cost': '-0.105 USDT · Received: raises equity',
      'Equity at the exit fill': '8.105 USDT',
      'Change against starting collateral': '-18.95 %',
    });
    expect(facts(reference('After-cost reference'))['Reference price']).toContain(
      'exactly 7979/9900',
    );
  });

  it('shows the simulated entry notional below the target when quantity is floored', () => {
    render(<LeverageSimulation />);
    const values = { ...FIXTURE, entry: '3', exit: '2.9' };
    fill(values);
    expectEngineFigures(values, 'notional');
    expect(facts(section())).toMatchObject({
      'Target notional': '50 USDT',
      Quantity: '16.66666666 units, floored to 0.00000001',
      'Simulated entry notional': '49.99999998 USDT',
    });
  });

  it('keeps the stop trigger apart from the exit fill', () => {
    render(<LeverageSimulation />);
    fill({ ...FIXTURE, stopTrigger: '0.9' });
    expectEngineFigures({ ...FIXTURE, stopTrigger: '0.9' }, 'notional');
    expect(facts(section())).toMatchObject({
      'Exit fill · used for the result': '0.96 USDT per unit',
      'Stop trigger · compared only': '0.9 USDT per unit',
      'Exit fill minus stop trigger': '0.06 USDT per unit',
      'Equity at the exit fill': '8 USDT',
    });
    expect(facts(reference('Zero-cost reference'))['Stop trigger']).toBe('Above the reference');
    expect(section()).toHaveTextContent('The stop trigger is never used as the fill.');
  });

  it('warns prominently about exhausted collateral and a stop or exit at or below a reference', () => {
    render(<LeverageSimulation />);
    fill({ ...FIXTURE, exit: '0.5', stopTrigger: '0.8' });
    expectEngineFigures({ ...FIXTURE, exit: '0.5', stopTrigger: '0.8' }, 'notional');
    expect(status()).toHaveTextContent('Hypothetical result below, with 5 warnings.');

    const heading = within(section()).getByRole('heading', { name: 'Warnings' });
    const items = within(heading.parentElement as HTMLElement).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent(
      'Collateral exhausted: equity at the exit fill is -15 USDT, zero or below.',
    );
    expect(items[0]).not.toHaveTextContent(SHARED_PRICE_NOTE);
    expect(items[1]).toHaveTextContent(
      'The exit fill (0.5) is at or below the zero-cost liquidation reference (0.80808081).',
    );
    expect(items[2]).toHaveTextContent(
      'The stop trigger (0.8) is at or below the zero-cost liquidation reference (0.80808081).',
    );
    expect(items[3]).toHaveTextContent('at or below the after-cost liquidation reference');
    // The shared-price limitation sits beside every comparison.
    for (const item of items.slice(1)) expect(item).toHaveTextContent(SHARED_PRICE_NOTE);
    expect(facts(reference('Zero-cost reference'))).toMatchObject({
      'Exit fill': 'At or below the reference',
      'Stop trigger': 'At or below the reference',
    });
  });
});

describe('LeverageSimulation: unavailable references', () => {
  const cases: {
    status: Exclude<LiquidationReference['status'], 'reference'>;
    values: Partial<Record<PerpetualField, string>>;
    zeroCost: boolean;
    text: string;
  }[] = [
    {
      status: 'collateral_exhausted',
      values: { carryingCost: '10' },
      zeroCost: false,
      text: 'The costs use up the collateral before any price move',
    },
    {
      status: 'no_positive_solution',
      values: { size: '10' },
      zeroCost: true,
      text: 'This does not mean the position cannot be liquidated.',
    },
    {
      status: 'not_below_entry',
      values: { maintenanceRatePercent: '50' },
      zeroCost: true,
      text: 'The equation solves at or above the entry price',
    },
    {
      status: 'negative_requirement',
      values: { maintenanceRatePercent: '0', maintenanceAmount: '1' },
      zeroCost: true,
      text: 'the maintenance requirement would be below zero',
    },
    {
      status: 'bracket_mismatch',
      values: { bracketCap: '10' },
      zeroCost: true,
      text: 'outside the bracket floor and cap you entered',
    },
  ];

  it.each(cases)(
    'explains $status in plain words and gives no price',
    ({ status: expected, values, zeroCost, text }) => {
      const all = { ...FIXTURE, ...values };
      render(<LeverageSimulation />);
      fill(all);
      const s = expectEngineFigures(all, 'notional');
      expect(s.liquidation.afterCosts.status).toBe(expected);
      expect(s.liquidation.zeroCost.status).toBe(zeroCost ? expected : 'reference');

      const titles = zeroCost
        ? (['Zero-cost reference', 'After-cost reference'] as const)
        : (['After-cost reference'] as const);
      for (const title of titles) {
        const region = reference(title);
        expect(region).toHaveTextContent('No reference price.');
        expect(region).toHaveTextContent(text);
        expect(region).not.toHaveTextContent('USDT per unit');
        expect(region).not.toHaveTextContent(SHARED_PRICE_NOTE);
      }
      if (expected === 'bracket_mismatch') {
        expect(facts(reference('After-cost reference'))['Notional where it solves']).toBe(
          '40.40404041 USDT, rounded up',
        );
      }
    },
  );

  it('shows the after-cost negative requirement while the zero-cost reference holds', () => {
    render(<LeverageSimulation />);
    fill({ ...FIXTURE, maintenanceAmount: '0.4', carryingCost: '-0.1' });
    expect(facts(reference('Zero-cost reference'))['Reference price']).toBe(
      '0.8 USDT per unit, rounded up (exactly 4/5)',
    );
    expect(reference('After-cost reference')).toHaveTextContent(
      'the maintenance requirement would be below zero',
    );
  });
});

describe('LeverageSimulation: validation and reset', () => {
  it('marks invalid inputs, ties each message to its field and removes stale results', () => {
    render(<LeverageSimulation />);
    fill(FIXTURE);
    expect(
      within(section()).getByRole('heading', { name: 'Hypothetical result' }),
    ).toBeInTheDocument();

    fill({ stopTrigger: '1' });
    expect(input('stopTrigger')).toHaveAttribute('aria-invalid', 'true');
    expect(input('stopTrigger')).toHaveAccessibleDescription(
      expect.stringContaining('Must be below the entry price'),
    );
    expect(status()).toHaveTextContent(
      'Correct the marked input. No figure is shown until every input is valid.',
    );
    expect(within(section()).queryByRole('heading', { name: 'Hypothetical result' })).toBeNull();
    expect(within(section()).queryByRole('region', { name: 'Zero-cost reference' })).toBeNull();

    fill({ entryFeePercent: '100', bracketCap: '0', carryingCost: '--1', collateral: '0' });
    expect(input('entryFeePercent')).toHaveAccessibleDescription(
      expect.stringContaining('Must be below 100%.'),
    );
    expect(input('bracketCap')).toHaveAccessibleDescription(
      expect.stringContaining('Must be above the bracket floor.'),
    );
    expect(input('carryingCost')).toHaveAccessibleDescription(
      expect.stringContaining('Enter a plain decimal'),
    );
    expect(input('collateral')).toHaveAccessibleDescription(
      expect.stringContaining('Must be greater than 0.'),
    );
    expect(status()).toHaveTextContent('Correct the 5 marked inputs.');

    fill({
      stopTrigger: '',
      entryFeePercent: '0',
      bracketCap: '50000',
      carryingCost: '0',
      collateral: '10',
    });
    expect(input('collateral')).not.toHaveAttribute('aria-invalid');
    expectEngineFigures(FIXTURE, 'notional');
  });

  it('reports a size below one quantity step without a figure', () => {
    render(<LeverageSimulation />);
    fill({ ...FIXTURE, size: '0.00000001', entry: '2', exit: '1' });
    expect(status()).toHaveTextContent(
      'At this entry, the size is less than 0.00000001 of the base asset.',
    );
    expect(within(section()).queryByRole('heading', { name: 'Hypothetical result' })).toBeNull();
  });

  it('clears every input, the sizing and the result', () => {
    render(<LeverageSimulation />);
    fill({ ...FIXTURE, stopTrigger: '0.9' });
    fireEvent.click(within(section()).getByRole('radio', { name: 'Leverage (× collateral)' }));
    fill({ size: '5' });
    expect(
      within(section()).getByRole('heading', { name: 'Hypothetical result' }),
    ).toBeInTheDocument();

    fireEvent.click(within(section()).getByRole('button', { name: 'Clear simulation' }));
    for (const box of within(section()).getAllByRole('textbox')) expect(box).toHaveValue('');
    expect(within(section()).getByRole('radio', { name: 'Target notional (USDT)' })).toBeChecked();
    expect(within(section()).queryByRole('heading', { name: 'Hypothetical result' })).toBeNull();
    expect(status()).toHaveTextContent(/^Enter starting collateral/);
  });
});

vi.mock('@/lib/authStore', () => ({
  useAuth: () => ({
    user: { id: 'synthetic-user', email: 'synthetic@example.test' },
    isPro: false,
  }),
}));
vi.mock('@/lib/portfolioStore', () => ({
  usePortfolio: () => ({
    portfolios: {
      paper_trading: { transactions: [] },
      long_term_sim: { transactions: [] },
      real_tracking: { transactions: [] },
    },
  }),
}));
vi.mock('@/components/BinanceSpotBalances', () => ({
  BinanceSpotBalances: ({ children }: { children?: ReactNode }) => (
    <section aria-label="Binance Spot card">{children}</section>
  ),
}));
vi.mock('@/components/SpotExperiments', () => ({
  SpotExperiments: () => <section aria-label="Manual Spot experiments" />,
}));
vi.mock('@/components/PortfolioDashboard', () => ({ PortfolioDashboard: () => null }));
vi.mock('@/components/PricingModal', () => ({ PricingModal: () => null }));
vi.mock('@/components/PineScriptModal', () => ({ PineScriptModal: () => null }));

describe('Account placement', () => {
  it('puts the leverage simulation outside the Binance Spot card and Manual Spot experiments', async () => {
    const { AccountPanel } = await import('@/components/AccountPanel');
    render(<AccountPanel assets={[]} />);
    const card = screen.getByRole('region', { name: 'Binance Spot card' });
    expect(
      within(card).getByRole('region', { name: 'Manual Spot experiments' }),
    ).toBeInTheDocument();
    expect(card).not.toContainElement(section());
    for (const box of within(section()).getAllByRole('textbox')) expect(box).toHaveValue('');
  });

  it('puts the public perpetual facts right after the simulation, unread until asked', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { AccountPanel } = await import('@/components/AccountPanel');
      render(<AccountPanel assets={[]} />);
      const facts = screen.getByRole('region', {
        name: /^TRXUSDT perpetual: public contract data/,
      });
      const card = screen.getByRole('region', { name: 'Binance Spot card' });
      expect(card).not.toContainElement(facts);
      expect(section()).not.toContainElement(facts);
      expect(section().nextElementSibling).toBe(facts);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
