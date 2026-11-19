import { describe, expect, it } from 'vitest';
import {
  compareDecimals,
  DAY_MS,
  DISCOVERY_POLICY_ID,
  DISCOVERY_STALE_AFTER_MS,
  discoveryFeedState,
  discoveryPolicySha256,
  dueSlot,
  eligibleSymbols,
  evidenceSha256,
  parseExchangeInfo,
  parseTickers,
  selectCandidates,
  slotForDate,
  verifyDiscoveryBatch,
  type DiscoveryEvidence,
  type DiscoveryInputs,
  type DiscoveryInstrument,
} from '@/lib/dailyDiscovery';
import { stableSerialize } from '@/lib/stableSerialize';
import { collectDiscoveryEvidence } from '../../scripts/dailyDiscovery';
import { at, binanceFake, syntheticMarket, testClock } from './dailyDiscoveryFixtures';

/** SYNTHETIC inputs only: ZCT pairs, invented volumes and times. */
const tradable = (base: string): DiscoveryInstrument => ({
  symbol: `${base}USDT`,
  baseAsset: base,
  status: 'TRADING',
  spotTradingAllowed: true,
});

const NOW = at(0, 31);
const TIMING = { requestedAt: NOW, receivedAt: NOW + 400 };
const figure = (symbol: string, quoteVolume: string, closeTime = NOW - 1_000) => ({
  symbol,
  quoteVolume,
  openTime: closeTime - DAY_MS,
  closeTime,
});

function inputs(overrides: Partial<DiscoveryInputs> = {}): DiscoveryInputs {
  return {
    listedSymbols: 10,
    malformedInstruments: 0,
    usdtInstruments: [],
    tickers: [],
    invalidTickers: [],
    ...overrides,
  };
}

/** The SHA-256 of DISCOVERY_POLICY: a deliberate change edits this and the policy ID together. */
const POLICY_SHA256 = 'b28becf5086f3a4815b72755065249e8125b705130a01d3e252a6e71325776db';

describe('policy identity', () => {
  it('is pinned: changing membership or order rules needs a new policy ID', async () => {
    expect(DISCOVERY_POLICY_ID).toBe('binance-spot-usdt-liquidity-v1');
    await expect(discoveryPolicySha256()).resolves.toBe(POLICY_SHA256);
  });
});

describe('slots', () => {
  it('starts each slot at 00:30 UTC; before it, the due slot is yesterday’s', () => {
    expect(dueSlot(at(0, 29, 59, 999)).date).toBe('2026-11-19');
    expect(dueSlot(at(0, 30))).toEqual({
      date: '2026-11-20',
      scheduledFor: '2026-11-20T00:30:00.000Z',
      retryDeadline: '2026-11-20T06:00:00.000Z',
    });
    expect(dueSlot(at(23, 59, 59, 999)).date).toBe('2026-11-20');
    expect(() => slotForDate('2026-11-20T00:00')).toThrow(RangeError);
  });
});

describe('exchangeInfo', () => {
  it('keeps exactly USDT-quoted instruments, by the quoteAsset field, never the symbol text', () => {
    const parsed = parseExchangeInfo({
      serverTime: NOW,
      symbols: [
        {
          symbol: 'ZCTAUSDT',
          baseAsset: 'ZCTA',
          quoteAsset: 'USDT',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        // Ends in USDT but is quoted in TUSD: not a USDT pair.
        {
          symbol: 'ZCTBUSDT',
          baseAsset: 'ZCTBU',
          quoteAsset: 'SDT',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        {
          symbol: 'ZCTCusdt',
          baseAsset: 'ZCTC',
          quoteAsset: 'usdt',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        {
          symbol: '币安人生USDT',
          baseAsset: '币安人生',
          quoteAsset: 'USDT',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
      ],
    });
    expect(parsed?.usdtInstruments.map((i) => i.symbol)).toEqual(['ZCTAUSDT', '币安人生USDT']);
    expect(parsed).toMatchObject({ serverTime: NOW, listedSymbols: 4, malformedInstruments: 0 });
  });

  it('counts unreadable and duplicated USDT entries as malformed and drops them', () => {
    const parsed = parseExchangeInfo({
      serverTime: NOW,
      symbols: [
        null,
        { symbol: 'ZCTAUSDT', quoteAsset: 'USDT', baseAsset: 'ZCTA', status: 'TRADING' },
        {
          symbol: 'ZCTBUSDT',
          quoteAsset: 'USDT',
          baseAsset: '',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        {
          symbol: 'ZCT CUSDT',
          quoteAsset: 'USDT',
          baseAsset: 'ZCT C',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        {
          symbol: 'ZCTDUSDT',
          quoteAsset: 'USDT',
          baseAsset: 'ZCTD',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        {
          symbol: 'ZCTDUSDT',
          quoteAsset: 'USDT',
          baseAsset: 'ZCTD',
          status: 'TRADING',
          isSpotTradingAllowed: true,
        },
        { symbol: 'ZCTEBTC', quoteAsset: 'BTC' },
      ],
    });
    expect(parsed?.usdtInstruments).toEqual([]);
    expect(parsed?.malformedInstruments).toBe(6);
  });

  it('refuses a response with no symbols list or serverTime', () => {
    expect(parseExchangeInfo(null)).toBeNull();
    expect(parseExchangeInfo([])).toBeNull();
    expect(parseExchangeInfo({ serverTime: NOW })).toBeNull();
    expect(parseExchangeInfo({ serverTime: '1', symbols: [] })).toBeNull();
    expect(parseExchangeInfo({ serverTime: 1.5, symbols: [] })).toBeNull();
  });
});

describe('eligibility', () => {
  it('needs TRADING, spot trading allowed and a base not on the stablecoin list, by exact code', () => {
    expect(
      eligibleSymbols([
        tradable('ZCTA'),
        { ...tradable('ZCTB'), status: 'BREAK' },
        { ...tradable('ZCTC'), spotTradingAllowed: false },
        tradable('USDC'),
        tradable('USDT0'),
        // Look-alikes are never matched: the list holds exact codes.
        tradable('USDCX'),
        tradable('usdc'),
        tradable('ZUSDC'),
      ]),
    ).toEqual(['ZCTAUSDT', 'USDCXUSDT', 'usdcUSDT', 'ZUSDCUSDT']);
  });
});

describe('24-hour figures', () => {
  const symbols = [
    'ZCTAUSDT',
    'ZCTBUSDT',
    'ZCTCUSDT',
    'ZCTDUSDT',
    'ZCTEUSDT',
    'ZCTFUSDT',
    'ZCTGUSDT',
  ];

  it('validates each eligible pair and records why one has no figure, never repairing it', () => {
    const parsed = parseTickers(
      [
        figure('ZCTAUSDT', '100.5'),
        figure('ZCTBUSDT', '1e9'),
        { ...figure('ZCTCUSDT', '5'), closeTime: NOW - 1_000 + 1 },
        figure('ZCTDUSDT', '7', NOW - 3_600_000 - 1),
        figure('ZCTEUSDT', '7', TIMING.receivedAt + 60_001),
        figure('ZCTFUSDT', '1'),
        figure('ZCTFUSDT', '2'),
        // Not eligible: ignored, never stored.
        figure('ZCTXUSDT', '999999'),
        { symbol: 42 },
      ],
      symbols,
      TIMING,
    );
    expect(parsed?.tickers).toEqual([figure('ZCTAUSDT', '100.5')]);
    expect(parsed?.invalidTickers).toEqual([
      { symbol: 'ZCTBUSDT', issue: 'QUOTE_VOLUME_INVALID' },
      { symbol: 'ZCTCUSDT', issue: 'WINDOW_INVALID' },
      { symbol: 'ZCTDUSDT', issue: 'WINDOW_OUTDATED' },
      { symbol: 'ZCTEUSDT', issue: 'WINDOW_IN_FUTURE' },
      { symbol: 'ZCTFUSDT', issue: 'TICKER_DUPLICATE' },
      { symbol: 'ZCTGUSDT', issue: 'TICKER_MISSING' },
    ]);
  });

  it('accepts windows exactly at the lag and skew bounds', () => {
    const parsed = parseTickers(
      [
        figure('ZCTAUSDT', '1', NOW - 3_600_000),
        figure('ZCTBUSDT', '1', TIMING.receivedAt + 60_000),
      ],
      ['ZCTAUSDT', 'ZCTBUSDT'],
      TIMING,
    );
    expect(parsed?.invalidTickers).toEqual([]);
  });

  it.each([12.5, '-1', '1,000', ' 1', '0x10', '', '1.', null])(
    'refuses quote volume %j',
    (quoteVolume) => {
      expect(
        parseTickers([{ ...figure('ZCTAUSDT', '1'), quoteVolume }], ['ZCTAUSDT'], TIMING)
          ?.invalidTickers,
      ).toEqual([{ symbol: 'ZCTAUSDT', issue: 'QUOTE_VOLUME_INVALID' }]);
    },
  );

  it('refuses a response that is not a list', () => {
    expect(parseTickers({ code: -1003 }, symbols, TIMING)).toBeNull();
  });
});

describe('decimal order', () => {
  it.each([
    ['10', '9.99999999', 1],
    ['0001.5', '1.50', 0],
    ['123.1', '123.10000001', -1],
    // Beyond float precision: Number() calls each pair equal.
    ['9007199254740993', '9007199254740992', 1],
    ['0.30000000000000001', '0.3', 1],
    ['0', '0.00000000', 0],
  ])('%s vs %s', (a, b, sign) => {
    expect(Math.sign(compareDecimals(a, b))).toBe(sign);
    expect(Math.sign(compareDecimals(b, a))).toBe(-sign || 0);
  });
});

describe('selection', () => {
  it('ranks by quote volume, breaks ties by exact symbol in code-unit order, keeps 50', () => {
    const bases = Array.from({ length: 55 }, (_, i) => `ZCT${String(i).padStart(2, '0')}`);
    const tied = ['ZCTB', 'ZCTAB', 'ZCTA', 'ZCTa', 'ZCT_'];
    const all = [...bases, ...tied];
    const result = selectCandidates(
      inputs({
        usdtInstruments: all.map(tradable),
        tickers: [
          ...bases.map((base, i) => figure(`${base}USDT`, `${1000 - i}`)),
          ...tied.map((base) => figure(`${base}USDT`, '5000.000')),
        ],
      }),
    );
    expect(result.members.slice(0, 5).map((m) => m.symbol)).toEqual([
      'ZCTABUSDT',
      'ZCTAUSDT',
      'ZCTBUSDT',
      'ZCT_USDT',
      'ZCTaUSDT',
    ]);
    expect(result.members).toHaveLength(50);
    expect(result.members.map((m) => m.rank)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(result.members.at(-1)?.symbol).toBe('ZCT44USDT');
    expect(result.coverage).toMatchObject({ eligible: 60, ranked: 60, selected: 50 });
    expect(result.status).toBe('COMPLETE');
  });

  it('gives the same result whatever order the provider listed things in', () => {
    const base = inputs({
      usdtInstruments: ['ZCTA', 'ZCTB', 'ZCTC', 'XAUT', 'USDC'].map(tradable),
      tickers: [
        figure('ZCTAUSDT', '3'),
        figure('ZCTBUSDT', '3'),
        figure('ZCTCUSDT', '9'),
        figure('XAUTUSDT', '4'),
      ],
    });
    const reversed = {
      ...base,
      usdtInstruments: [...base.usdtInstruments].reverse(),
      tickers: [...base.tickers].reverse(),
    };
    expect(stableSerialize(selectCandidates(reversed))).toBe(
      stableSerialize(selectCandidates(base)),
    );
    const result = selectCandidates(base);
    expect(result.members.map((m) => [m.symbol, m.category])).toEqual([
      ['ZCTCUSDT', 'unclassified'],
      ['XAUTUSDT', 'tokenized-commodity'],
      ['ZCTAUSDT', 'unclassified'],
      ['ZCTBUSDT', 'unclassified'],
    ]);
    expect(result.exclusions).toEqual([{ symbol: 'USDCUSDT', reason: 'STABLECOIN_BASE' }]);
  });

  it('lists every exclusion and pair without a figure; nothing is substituted for them', () => {
    const result = selectCandidates(
      inputs({
        malformedInstruments: 0,
        usdtInstruments: [
          tradable('ZCTA'),
          tradable('ZCTB'),
          { ...tradable('ZCTH'), status: 'HALT' },
          { ...tradable('ZCTN'), spotTradingAllowed: false },
          tradable('USDT'),
        ],
        tickers: [figure('ZCTAUSDT', '1')],
        invalidTickers: [{ symbol: 'ZCTBUSDT', issue: 'TICKER_MISSING' }],
      }),
    );
    expect(result.status).toBe('PARTIAL');
    expect(result.members.map((m) => m.symbol)).toEqual(['ZCTAUSDT']);
    expect(result.exclusions).toEqual([
      { symbol: 'USDTUSDT', reason: 'STABLECOIN_BASE' },
      { symbol: 'ZCTBUSDT', reason: 'TICKER_MISSING' },
      { symbol: 'ZCTHUSDT', reason: 'NOT_TRADING' },
      { symbol: 'ZCTNUSDT', reason: 'SPOT_TRADING_NOT_ALLOWED' },
    ]);
    expect(result.coverage).toEqual({
      listed: 10,
      usdtQuoted: 5,
      malformed: 0,
      notTrading: 1,
      spotTradingNotAllowed: 1,
      stablecoin: 1,
      eligible: 2,
      invalid: 1,
      ranked: 1,
      selected: 1,
    });
  });

  it('is EMPTY only when nothing was eligible and nothing was unreadable', () => {
    expect(selectCandidates(inputs()).status).toBe('EMPTY');
    expect(selectCandidates(inputs({ usdtInstruments: [tradable('USDC')] })).status).toBe('EMPTY');
    expect(selectCandidates(inputs({ malformedInstruments: 1 })).status).toBe('PARTIAL');
  });
});

describe('verification', () => {
  async function batch() {
    const clock = testClock(at(0, 33));
    const evidence = await collectDiscoveryEvidence(dueSlot(clock.now()), {
      ...binanceFake(syntheticMarket(), clock),
      now: clock.now,
      sleep: clock.sleep,
    });
    return {
      evidence,
      record: {
        policy_id: DISCOVERY_POLICY_ID,
        slot_date: evidence.slot.date,
        collected_at: evidence.collection.ticker.receivedAt.replace('Z', '+00:00'),
        status: evidence.result.status.toLowerCase(),
        member_count: evidence.result.members.length,
        // As jsonb returns it: keys reordered, values unchanged.
        evidence: JSON.parse(JSON.stringify(evidence)) as unknown,
        evidence_sha256: await evidenceSha256(evidence),
      },
    };
  }

  async function resigned(evidence: DiscoveryEvidence, change: (e: DiscoveryEvidence) => void) {
    const copy = structuredClone(evidence);
    change(copy);
    return { evidence: copy, evidence_sha256: await evidenceSha256(copy) };
  }

  it('accepts a collected batch after the database round trip', async () => {
    const { record } = await batch();
    const verified = await verifyDiscoveryBatch(record);
    expect(verified.ok).toBe(true);
  });

  it('refuses changed bytes, a reordered list, another policy or slot, and disagreeing columns', async () => {
    const { evidence, record } = await batch();
    const refusal = async (changed: Partial<typeof record>) => {
      const verified = await verifyDiscoveryBatch({ ...record, ...changed });
      return verified.ok ? null : verified.reason;
    };
    expect(await refusal({ evidence_sha256: '0'.repeat(64) })).toMatch(/SHA-256/);
    expect(
      await refusal(
        await resigned(evidence, (e) => {
          e.result.members.reverse();
        }),
      ),
    ).toMatch(/re-derive/);
    expect(
      await refusal(
        await resigned(evidence, (e) => {
          e.inputs.tickers[0]!.quoteVolume = '1';
        }),
      ),
    ).toMatch(/re-derive/);
    expect(
      await refusal(
        await resigned(evidence, (e) => {
          e.policy.sha256 = 'f'.repeat(64);
        }),
      ),
    ).toMatch(/policy identity/);
    expect(
      await refusal(
        await resigned(evidence, (e) => {
          e.inputs.tickers.push(figure('ZCTHALTUSDT', '9'));
        }),
      ),
    ).toMatch(/exactly once/);
    expect(await refusal({ slot_date: '2026-11-19' })).toMatch(/slot/);
    // A column no evidence check reaches still ends in a refusal, never an exception.
    expect(await refusal({ slot_date: 'not-a-date' })).toBe('Unreadable evidence');
    expect(await refusal({ member_count: 49 })).toMatch(/columns/);
    expect(
      await refusal({ status: 'complete' === record.status ? 'partial' : 'complete' }),
    ).toMatch(/columns/);
    const garbage = { schemaVersion: 1, policy: null };
    expect(
      await refusal({ evidence: garbage, evidence_sha256: await evidenceSha256(garbage) }),
    ).toMatch(/policy identity|Unreadable/);
    expect(await refusal({ evidence: 'text' })).toMatch(/format/);
  });

  /**
   * As a forger who knows the format would: change stored inputs or metadata, re-derive the
   * result from them and recompute the hash, so only validating the stored values can refuse it.
   */
  async function forged(change: (e: DiscoveryEvidence) => void) {
    const { evidence } = await batch();
    const copy = structuredClone(evidence);
    change(copy);
    copy.result = selectCandidates(copy.inputs);
    return {
      policy_id: DISCOVERY_POLICY_ID,
      slot_date: copy.slot.date,
      // The column follows a changed receipt time, so only the evidence check can refuse it.
      collected_at: copy.collection?.ticker.receivedAt ?? evidence.collection.ticker.receivedAt,
      status: copy.result.status.toLowerCase(),
      member_count: copy.result.members.length,
      evidence: JSON.parse(JSON.stringify(copy)) as unknown,
      evidence_sha256: await evidenceSha256(copy),
    };
  }

  const iso = (ms: number) => new Date(ms).toISOString();
  const ms = (text: string) => Date.parse(text);
  const top = (e: DiscoveryEvidence) => e.inputs.tickers.find((t) => t.symbol === 'ZCT001USDT')!;
  const retime = (e: DiscoveryEvidence, closeTime: number) => {
    top(e).closeTime = closeTime;
    top(e).openTime = closeTime - DAY_MS;
  };
  const unsafe = (value: unknown) => value as never;

  it.each<[string, (e: DiscoveryEvidence) => void, RegExp]>([
    [
      'a quote volume BigInt cannot render',
      (e) => void (top(e).quoteVolume = '99999999x'),
      /quote volume/,
    ],
    ['a quote volume in exponent form', (e) => void (top(e).quoteVolume = '6e7'), /quote volume/],
    ['a window that is not 24 hours', (e) => void (top(e).openTime += 1), /window/],
    [
      'a window ending over an hour before the cutoff',
      (e) => retime(e, ms(e.collection.ticker.requestedAt) - 3_600_001),
      /window/,
    ],
    [
      'a window ending over a minute after the response',
      (e) => retime(e, ms(e.collection.ticker.receivedAt) + 60_001),
      /window/,
    ],
    [
      'a ticker received before it was requested',
      (e) => void (e.collection.ticker.receivedAt = iso(ms(e.collection.ticker.requestedAt) - 1)),
      /order/,
    ],
    [
      'exchangeInfo requested before the slot',
      (e) => void (e.collection.exchangeInfo.requestedAt = iso(ms(e.slot.scheduledFor) - 1)),
      /order/,
    ],
    [
      'a ticker requested before exchangeInfo arrived',
      (e) =>
        void (e.collection.exchangeInfo.receivedAt = iso(ms(e.collection.ticker.requestedAt) + 1)),
      /order/,
    ],
    [
      'a response received at the retry deadline',
      (e) => void (e.collection.ticker.receivedAt = e.slot.retryDeadline),
      /order/,
    ],
    [
      'a cutoff other than the ticker request',
      (e) => void (e.collection.cutoff = iso(ms(e.collection.ticker.requestedAt) + 1)),
      /cutoff/,
    ],
    [
      'another source endpoint',
      (e) => void (e.collection.exchangeInfo.endpoint = 'https://example.invalid/exchangeInfo'),
      /source/,
    ],
    ['a time that is not ISO', (e) => void (e.collection.exchangeInfo.receivedAt = 'soon'), /time/],
    [
      'a serverTime that is not an integer',
      (e) => void (e.collection.exchangeInfo.serverTime = unsafe('1')),
      /serverTime/,
    ],
    [
      'an instrument with a non-boolean spot flag',
      (e) => void (e.inputs.usdtInstruments[0]!.spotTradingAllowed = unsafe('yes')),
      /instrument/,
    ],
    [
      'an instrument whose base asset is not text',
      (e) => void (e.inputs.usdtInstruments[0]!.baseAsset = unsafe(5)),
      /instrument/,
    ],
    [
      'a duplicated instrument',
      (e) => {
        const halted = e.inputs.usdtInstruments.find((i) => i.symbol === 'ZCTHALTUSDT')!;
        e.inputs.usdtInstruments.push({ ...halted });
      },
      /instrument/,
    ],
    [
      'an issue that is not a known one',
      (e) => {
        e.inputs.tickers = e.inputs.tickers.filter((t) => t.symbol !== 'ZCT060USDT');
        e.inputs.invalidTickers.push({ symbol: 'ZCT060USDT', issue: unsafe('BOGUS') });
      },
      /issue/,
    ],
    [
      'a ticker entry with a field the format does not have',
      (e) => void Object.assign(top(e), { lastPrice: '1.10' }),
      /ticker/,
    ],
    ['tickers out of exact-symbol order', (e) => void e.inputs.tickers.reverse(), /ticker/],
    ['a negative symbol count', (e) => void (e.inputs.listedSymbols = -1), /count/],
    ['a fractional malformed count', (e) => void (e.inputs.malformedInstruments = 1.5), /count/],
    ['fewer symbols listed than stored', (e) => void (e.inputs.listedSymbols = 3), /count/],
  ])('refuses %s, even with a consistent result and hash', async (_, change, reason) => {
    const verified = await verifyDiscoveryBatch(await forged(change));
    expect(verified.ok).toBe(false);
    expect(verified.ok ? null : verified.reason).toMatch(reason);
  });

  it('refuses unreadable metadata instead of throwing', async () => {
    const record = await forged((e) => void (e.collection = unsafe(null)));
    await expect(verifyDiscoveryBatch(record)).resolves.toMatchObject({ ok: false });
  });
});

describe('freshness', () => {
  const slot = Date.parse('2026-11-20T00:30:00.000Z');
  const failed = (slot_date: string, status = 'failed') => ({ slot_date, status });

  it('is 29h30m after the batch’s slot: the next slot’s 06:00 UTC deadline', () => {
    expect(DISCOVERY_STALE_AFTER_MS).toBe(29.5 * 3_600_000);
    expect(discoveryFeedState('2026-11-20', null, slot + DISCOVERY_STALE_AFTER_MS - 1)).toBe(
      'awaiting',
    );
    expect(discoveryFeedState('2026-11-20', null, slot + DISCOVERY_STALE_AFTER_MS)).toBe('stale');
    expect(discoveryFeedState('2026-11-20', null, Date.parse('2026-11-21T06:00:00.000Z'))).toBe(
      'stale',
    );
  });

  it('is current from its slot until the next slot starts', () => {
    expect(discoveryFeedState('2026-11-20', null, slot)).toBe('current');
    expect(discoveryFeedState('2026-11-20', null, slot + DAY_MS - 1)).toBe('current');
    expect(discoveryFeedState('2026-11-20', null, slot + DAY_MS)).toBe('awaiting');
  });

  it('never presents yesterday’s batch as current after today’s attempt failed', () => {
    const now = slot + DAY_MS + 10 * 60_000;
    expect(discoveryFeedState('2026-11-20', failed('2026-11-21'), now)).toBe('attempt-failed');
    expect(discoveryFeedState('2026-11-20', failed('2026-11-21', 'missed'), now)).toBe(
      'attempt-failed',
    );
    expect(discoveryFeedState('2026-11-20', failed('2026-11-21', 'conflict'), now)).toBe(
      'attempt-failed',
    );
    // An old failure says nothing about today.
    expect(discoveryFeedState('2026-11-20', failed('2026-11-20'), now)).toBe('awaiting');
    expect(discoveryFeedState('2026-11-20', failed('2026-11-21'), slot + DAY_MS - 1)).toBe(
      'current',
    );
    expect(
      discoveryFeedState('2026-11-20', failed('2026-11-21'), slot + DISCOVERY_STALE_AFTER_MS),
    ).toBe('stale');
  });

  it('is missing without a batch', () => {
    expect(discoveryFeedState(null, failed('2026-11-21'), slot)).toBe('missing');
  });
});
