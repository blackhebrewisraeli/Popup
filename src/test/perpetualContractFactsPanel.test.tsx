import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeverageSimulation } from '@/components/LeverageSimulation';
import { PerpetualContractFacts } from '@/components/PerpetualContractFacts';
import {
  OK_REPLIES,
  PREMIUM_INDEX,
  TRX_PERPETUAL,
  URLS,
  exchangeInfoBody,
  fundingInfoBody,
  json,
  mockFetch,
  type Reply,
} from './perpetualFactsFixtures';
import type { FactsGroup } from '@/lib/perpetualContractFacts';

const RECEIVED = Date.UTC(2026, 10, 14, 21, 16, 25, 123);
const ACCOUNT_SPECIFIC = 'Account-specific — not read; enter manually.';

const card = () => screen.getByRole('region', { name: /^TRXUSDT perpetual: public contract data/ });
const button = () => within(card()).getByRole('button', { name: 'Read public contract data' });
const status = () => within(card()).getByRole('status');
const group = (name: RegExp) => within(card()).getByRole('region', { name });
const fact = (scope: HTMLElement, name: string) => {
  const term = within(scope).getByText(name, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? '';
};

async function readWith(replies: Partial<Record<FactsGroup, Reply>> = {}) {
  const fetchMock = mockFetch(replies);
  vi.stubGlobal('fetch', fetchMock);
  await act(async () => {
    fireEvent.click(button());
  });
  return fetchMock;
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(RECEIVED);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PerpetualContractFacts: before a read', () => {
  it('sends nothing until the button is pressed and names the instrument', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<PerpetualContractFacts />);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status()).toHaveTextContent(
      'Not read. Pressing the button sends one GET to each of 4 public endpoints.',
    );
    expect(card()).toHaveTextContent('a different instrument from Spot TRXUSDT');
    expect(within(card()).queryByText('Mark price', { selector: 'dt' })).toBeNull();
  });

  it('states that fees and brackets are account-specific and not read', () => {
    render(<PerpetualContractFacts />);
    const account = group(/^Not read: account parameters/);
    expect(fact(account, 'Trading fee rates')).toBe(ACCOUNT_SPECIFIC);
    expect(fact(account, 'Maintenance-margin bracket')).toBe(ACCOUNT_SPECIFIC);
    expect(card()).not.toHaveTextContent(/0\.0200|0\.0500|0\.65|maintMargin/);
  });
});

describe('PerpetualContractFacts: a full read', () => {
  it('shows each endpoint with its provenance, local receipt time and provider time', async () => {
    render(<PerpetualContractFacts />);
    const fetchMock = await readWith();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(status()).toHaveTextContent('Read finished: 4 of 4 endpoints returned usable data.');

    const contract = group(/exchangeInfo$/);
    expect(fact(contract, 'Source')).toBe(`GET ${URLS.contract}`);
    expect(fact(contract, 'Received')).toBe('2026-11-14 21:16:25.123 UTC · this device’s clock');
    expect(fact(contract, 'Provider time')).toMatch(
      /^None used: Binance documents exchangeInfo serverTime/,
    );

    const premium = group(/premiumIndex$/);
    expect(fact(premium, 'Source')).toBe(`GET ${URLS.premium}`);
    expect(fact(premium, 'Provider time')).toBe('2026-11-14 21:16:20.003 UTC · premiumIndex time');
    // The device's receipt time and the provider's time are never swapped.
    expect(fact(premium, 'Received')).toBe('2026-11-14 21:16:25.123 UTC · this device’s clock');

    const ticker = group(/ticker\/price v2$/);
    expect(fact(ticker, 'Source')).toBe(`GET ${URLS.ticker}`);
    expect(fact(ticker, 'Provider time')).toBe(
      '2026-11-14 21:16:22.309 UTC · ticker time (transaction time)',
    );
    expect(fact(ticker, 'Received')).toBe('2026-11-14 21:16:25.123 UTC · this device’s clock');

    const funding = group(/fundingInfo$/);
    expect(fact(funding, 'Source')).toBe(`GET ${URLS.funding}`);
    expect(fact(funding, 'Provider time')).toBe('None in the response');
  });

  it('shows the validated identity, the filters and the liquidation fee rate as context', async () => {
    render(<PerpetualContractFacts />);
    await readWith();
    const contract = group(/exchangeInfo$/);
    expect(fact(contract, 'Symbol')).toBe('TRXUSDT');
    expect(fact(contract, 'Contract type')).toBe('PERPETUAL');
    expect(fact(contract, 'Status')).toBe('TRADING');
    expect(fact(contract, 'Quote asset')).toBe('USDT');
    expect(fact(contract, 'Margin asset')).toBe('USDT');
    expect(contract).toHaveTextContent('Matches the fixed instrument');
    expect(fact(contract, 'Price tick size')).toBe('0.00001 USDT');
    expect(fact(contract, 'Minimum price')).toBe('0.00132 USDT');
    expect(fact(contract, 'Maximum price')).toBe('20000 USDT');
    expect(fact(contract, 'LOT_SIZE step')).toBe('1 TRX');
    expect(fact(contract, 'LOT_SIZE maximum')).toBe('20000000 TRX');
    expect(fact(contract, 'MARKET_LOT_SIZE maximum')).toBe('5000000 TRX');
    expect(fact(contract, 'Minimum notional')).toBe('5 USDT');
    expect(fact(contract, 'Liquidation fee rate')).toBe(
      '0.012500 (1.2500 %) · reported, context only; the simulation does not use it',
    );
    // The ignored exchangeInfo margin fields never appear.
    expect(card()).not.toHaveTextContent(
      /2\.5000|5\.0000|maintMarginPercent|requiredMarginPercent/,
    );
  });

  it('keeps mark and last price apart and words the funding rate as reported', async () => {
    render(<PerpetualContractFacts />);
    await readWith();
    const premium = group(/premiumIndex$/);
    const ticker = group(/ticker\/price v2$/);
    expect(fact(premium, 'Mark price')).toBe('0.30707000 USDT per unit');
    expect(fact(ticker, 'Last price')).toBe('0.30712 USDT per unit');
    expect(within(premium).queryByText('Last price')).toBeNull();
    expect(fact(premium, 'Reported funding rate')).toBe(
      '-0.00058793 (-0.058793 %) · lastFundingRate',
    );
    expect(fact(premium, 'Next funding time')).toBe('2026-11-15 00:00:00.000 UTC');
    expect(premium).toHaveTextContent('nothing here says it will settle unchanged');
    expect(premium).toHaveTextContent('not the simulation’s carrying cost');

    const funding = group(/fundingInfo$/);
    expect(fact(funding, 'Funding interval')).toBe('8 hours, as published');
    expect(fact(funding, 'Funding rate cap')).toBe('0.004875 (0.4875 %)');
    expect(fact(funding, 'Funding rate floor')).toBe('-0.004875 (-0.4875 %)');
  });

  it('saves nothing and sets no cookie', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = document.cookie;
    render(<PerpetualContractFacts />);
    await readWith();
    expect(setItem).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
  });
});

describe('PerpetualContractFacts: failures', () => {
  it('marks each failed group and keeps the others', async () => {
    render(<PerpetualContractFacts />);
    await readWith({
      contract: () => json({ code: 0, msg: 'restricted' }, 451),
      premium: new TypeError('Failed to fetch'),
    });
    expect(status()).toHaveTextContent(
      'Read finished: 2 of 4 endpoints returned usable data. The others are marked unavailable.',
    );
    const contract = group(/exchangeInfo$/);
    expect(contract).toHaveTextContent('Unavailable. Binance answered HTTP 451.');
    expect(fact(contract, 'Provider time')).toBe('None: no usable response');
    expect(within(contract).queryByText('Symbol', { selector: 'dt' })).toBeNull();
    expect(card()).toHaveTextContent('Contract not confirmed.');

    const premium = group(/premiumIndex$/);
    expect(premium).toHaveTextContent('The browser received no response. A CORS block');
    expect(within(premium).queryByText('Mark price', { selector: 'dt' })).toBeNull();

    expect(fact(group(/ticker\/price v2$/), 'Last price')).toBe('0.30712 USDT per unit');
    expect(fact(group(/fundingInfo$/), 'Funding interval')).toBe('8 hours, as published');
  });

  it('names malformed data instead of showing it', async () => {
    render(<PerpetualContractFacts />);
    await readWith({
      premium: () => json({ ...PREMIUM_INDEX, markPrice: 0.30707 }),
      funding: () => new Response('not json', { status: 200 }),
    });
    expect(group(/premiumIndex$/)).toHaveTextContent(
      'The response did not have the documented shape: markPrice is not a positive decimal.',
    );
    expect(group(/fundingInfo$/)).toHaveTextContent('The body is not JSON.');
  });

  it('marks a missing or malformed filter in place', async () => {
    render(<PerpetualContractFacts />);
    await readWith({
      contract: () =>
        json(
          exchangeInfoBody({
            ...TRX_PERPETUAL,
            filters: [
              { minPrice: '0.00132', maxPrice: '20000', filterType: 'PRICE_FILTER', tickSize: 'x' },
              { stepSize: '1', filterType: 'LOT_SIZE', maxQty: '20000000', minQty: '1' },
            ],
            liquidationFee: undefined,
          }),
        ),
    });
    const contract = group(/exchangeInfo$/);
    expect(fact(contract, 'Price tick size')).toBe('Malformed: tickSize is not a plain decimal');
    expect(fact(contract, 'MARKET_LOT_SIZE step')).toBe(
      'Not reported: no MARKET_LOT_SIZE filter in the response',
    );
    expect(fact(contract, 'Minimum notional')).toBe(
      'Not reported: no MIN_NOTIONAL filter in the response',
    );
    expect(fact(contract, 'LOT_SIZE step')).toBe('1 TRX');
    expect(fact(contract, 'Liquidation fee rate')).toBe('Not reported in the response');
  });

  it('shows an unsupported identity and withholds everything else', async () => {
    render(<PerpetualContractFacts />);
    await readWith({
      contract: () =>
        json(exchangeInfoBody({ ...TRX_PERPETUAL, marginAsset: 'USDC', status: 'SETTLING' })),
    });
    expect(status()).toHaveTextContent(
      'Read finished: the contract check failed, so only the contract is shown.',
    );
    const contract = group(/exchangeInfo$/);
    expect(contract).toHaveTextContent('Unsupported contract.');
    expect(contract).toHaveTextContent('marginAsset is USDC, not USDT.');
    expect(contract).toHaveTextContent('status is SETTLING, not TRADING.');
    expect(fact(contract, 'Margin asset')).toBe('USDC');
    expect(within(contract).queryByText('Price tick size')).toBeNull();
    expect(within(card()).queryByRole('region', { name: /premiumIndex$/ })).toBeNull();
    expect(card()).toHaveTextContent(
      'Mark price, last price and funding are not shown, because the contract check failed.',
    );
  });

  it('treats an unlisted contract as unsupported', async () => {
    const body = exchangeInfoBody();
    render(<PerpetualContractFacts />);
    await readWith({
      contract: () =>
        json({ ...body, symbols: body.symbols.filter((s) => s['symbol'] !== 'TRXUSDT') }),
    });
    expect(group(/exchangeInfo$/)).toHaveTextContent(
      'Unsupported contract: TRXUSDT is not listed.',
    );
    expect(within(card()).queryByRole('region', { name: /fundingInfo$/ })).toBeNull();
  });

  it('says fundingInfo omits the symbol and infers no interval', async () => {
    render(<PerpetualContractFacts />);
    await readWith({ funding: () => json(fundingInfoBody([])) });
    const funding = group(/fundingInfo$/);
    expect(funding).toHaveTextContent('Not published for TRXUSDT.');
    expect(funding).toHaveTextContent('no interval, cap or floor is shown and none is assumed');
    expect(within(funding).queryByText('Funding interval')).toBeNull();
    expect(funding).not.toHaveTextContent(/\b8\b|hours/);
    expect(status()).toHaveTextContent('4 of 4');
  });

  it('stops a request at the timeout without retrying', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<PerpetualContractFacts />);
    const fetchMock = await readWith({ ticker: 'hang' });
    expect(status()).toHaveTextContent('Reading 4 public endpoints.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(group(/ticker\/price v2$/)).toHaveTextContent(
      'No complete response within 10 seconds, so the request was stopped.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('PerpetualContractFacts: request lifecycle', () => {
  function deferred() {
    let resolve!: (response: Response) => void;
    const promise = new Promise<Response>((done) => (resolve = done));
    return { promise, resolve };
  }

  it('ignores presses while a read is in flight', async () => {
    const slow = deferred();
    render(<PerpetualContractFacts />);
    const fetchMock = await readWith({ funding: () => slow.promise });
    expect(button()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => {
      fireEvent.click(button());
      fireEvent.click(button());
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await act(async () => {
      slow.resolve(json(fundingInfoBody()));
    });
    expect(button()).not.toHaveAttribute('aria-disabled');
    expect(status()).toHaveTextContent('4 of 4');
  });

  it('clears the previous snapshot as soon as a new read starts', async () => {
    render(<PerpetualContractFacts />);
    await readWith();
    expect(fact(group(/premiumIndex$/), 'Mark price')).toBe('0.30707000 USDT per unit');

    const slow = deferred();
    const fetchMock = mockFetch({
      premium: () => slow.promise,
      ticker: () => json({ symbol: 'TRXUSDT', price: '0.31000', time: 1794691000000 }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(status()).toHaveTextContent('Reading 4 public endpoints. Earlier results are cleared.');
    expect(card()).not.toHaveTextContent('0.30707000');
    expect(card()).not.toHaveTextContent('0.30712');
    expect(within(card()).queryByRole('region', { name: /exchangeInfo$/ })).toBeNull();

    await act(async () => {
      slow.resolve(json({ ...PREMIUM_INDEX, markPrice: '0.31001000' }));
    });
    expect(fact(group(/premiumIndex$/), 'Mark price')).toBe('0.31001000 USDT per unit');
    expect(fact(group(/ticker\/price v2$/), 'Last price')).toBe('0.31000 USDT per unit');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('aborts on unmount and ignores the late answer', async () => {
    const slow = deferred();
    let signal: AbortSignal | undefined;
    const fetchMock = mockFetch({ ...OK_REPLIES, contract: () => slow.promise });
    const spy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === URLS.contract) signal = init?.signal ?? undefined;
      return fetchMock(url, init);
    });
    vi.stubGlobal('fetch', spy);
    const errors = vi.spyOn(console, 'error');
    const { unmount } = render(<PerpetualContractFacts />);
    await act(async () => {
      fireEvent.click(button());
    });
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      slow.resolve(json(exchangeInfoBody()));
    });
    expect(errors).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

describe('PerpetualContractFacts beside the simulation', () => {
  it('never changes or fills the simulation inputs', async () => {
    render(
      <>
        <LeverageSimulation />
        <PerpetualContractFacts />
      </>,
    );
    const simulation = screen.getByRole('region', { name: /^Leverage simulation/ });
    fireEvent.change(within(simulation).getByRole('textbox', { name: /^Starting collateral/ }), {
      target: { value: '10' },
    });
    const before = within(simulation)
      .getAllByRole('textbox')
      .map((box) => (box as HTMLInputElement).value);
    const statusBefore = within(simulation).getByRole('status').textContent;

    await readWith();

    expect(
      within(simulation)
        .getAllByRole('textbox')
        .map((box) => (box as HTMLInputElement).value),
    ).toEqual(before);
    expect(before.filter((value) => value !== '')).toEqual(['10']);
    expect(within(simulation).getByRole('status').textContent).toBe(statusBefore);
    expect(simulation).not.toHaveTextContent('0.30707');
  });
});
