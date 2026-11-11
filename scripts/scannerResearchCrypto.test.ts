import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateScan, type MarketScan } from '@/lib/marketScanner';
import {
  TRADINGVIEW_DEV_PROVIDER_ID,
  TRADINGVIEW_DEV_UNIVERSE_SOURCE,
} from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import { measureOutcome, writeStudy, type ResearchOutcome } from './scannerResearch';
import {
  CRYPTO_RESEARCH_SPECIFICATION,
  CRYPTO_RESEARCH_SPECIFICATION_ID,
  cryptoFrozenFactDifferences,
  cryptoHistory,
  cryptoHorizonResults,
  cryptoObservations,
  cutoffOf,
  inputsAt,
  instrumentHashes,
  loadRecordedScan,
  MINIMUM_EVALUATED,
  outcomeBars,
  RECORDED_SCAN,
  recordedScanParity,
  replayDay,
  researchSummaryCrypto,
  runCryptoStudy,
  runScannerResearchCrypto,
  scanDifferences,
  utcCalendar,
  verifyCryptoExport,
  type CryptoObservation,
  type CryptoReplayDate,
} from './scannerResearchCrypto';
import { renderCryptoResearchReport } from './scannerResearchReport';
import {
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  importInputs,
  universeTickers,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Labeled fixtures, not market data: UTC days and synthetic price paths shaped like a
 * `get_ohlcv` 1D response for a Binance Spot USDT pair. Nothing here was fetched.
 */
const DAY = 86_400_000;
/** The retrieval start, and so the export cutoff: 11 Nov 2026, 18:40 UTC. */
const START = Date.UTC(2026, 10, 11, 18, 40);
/** 10 Nov: the last day closed at the cutoff, and the recorded scan's day. */
const LAST_CLOSED = Date.UTC(2026, 10, 10);
const UNIVERSE = universeTickers(CRYPTO_UNIVERSE);
const NOTICE =
  'Market data notice: the last bar is still forming and may change; regular session only; prices are split-adjusted only.';
const STUDY_TIMEOUT = 60_000;

const iso = (time: number) => new Date(time).toISOString();
const utc = (time: number) => iso(time).slice(0, 10);
const dayBefore = (n: number) => utc(LAST_CLOSED - n * DAY);

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

/**
 * `closed` daily bars ending on 10 Nov, then the forming 11 Nov bar at ten times the price, so
 * any use of it shows. Each open sits below its own close, so an outcome read from a close
 * instead of an open would differ.
 */
function bars(path: (i: number) => number, closed = 230): Bar[] {
  const first = LAST_CLOSED - (closed - 1) * DAY;
  return Array.from({ length: closed + 1 }, (_, i) => {
    const close = path(i) * (i === closed ? 10 : 1);
    const open = close * 0.996;
    return {
      t: (first + i * DAY) / 1000,
      o: open,
      h: Math.max(open, close) * 1.01,
      l: Math.min(open, close) * 0.99,
      c: close,
      v: 1_000,
    };
  });
}

const pathOf = (k: number) => (i: number) =>
  100 *
  (1 + (0.02 + 0.01 * (k % 5)) * Math.sin((i + 7 * k) / (4 + (k % 6)))) *
  (1 + 0.001 * ((k % 3) - 1) * i);

function exportOf(
  barsOf: (ticker: string, k: number) => Bar[] = (_, k) => bars(pathOf(k)),
): TradingViewOhlcvExport {
  return {
    schemaVersion: '1',
    source: 'tradingview-mcp',
    universe: CRYPTO_UNIVERSE,
    retrieval: { startedAt: iso(START), completedAt: iso(START + 60_000) },
    instruments: UNIVERSE.map((ticker, k) => {
      const symbol = CRYPTO_TRADINGVIEW_SYMBOLS[ticker]!;
      return {
        ticker,
        symbol,
        receivedAt: iso(START + 30_000),
        response: {
          success: true,
          symbol,
          interval: '1D',
          currency: 'USDT',
          notice: NOTICE,
          bars: barsOf(ticker, k),
        },
      };
    }),
  };
}

const scanOptions = (evaluationTime: number) => ({
  evaluationTime,
  universeSource: TRADINGVIEW_DEV_UNIVERSE_SOURCE,
  equityProvider: null,
  cryptoProvider: TRADINGVIEW_DEV_PROVIDER_ID,
});

/** What the import recorded at the export's cutoff, as recordTradingViewScan scores it. */
const recordedOf = (file: TradingViewOhlcvExport) => ({
  scanId: RECORDED_SCAN.scanId,
  scan: evaluateScan(importInputs(file, START), scanOptions(START)),
});

const study = (file = exportOf()) => runCryptoStudy(file, 'fixture', recordedOf(file));
let clean: ReturnType<typeof runCryptoStudy> | undefined;
const cleanStudy = () => (clean ??= study());

afterEach(() => vi.restoreAllMocks());

describe('crypto scanner study specification', () => {
  it('keeps the frozen machine-readable specification aligned with code', async () => {
    const documented = JSON.parse(
      await readFile('docs/scanner-research-crypto.v1.json', 'utf8'),
    ) as unknown;
    expect(stableSerialize(documented)).toBe(stableSerialize(CRYPTO_RESEARCH_SPECIFICATION));
    expect(CRYPTO_RESEARCH_SPECIFICATION_ID).toBe(
      '6d005fee9ffdfb561e3ea8412800d0d5f116fc816482cf66c5dc46959389dcbc',
    );
  });

  it('freezes crypto-usdt-v1 exactly as committed, with an input hash per member', () => {
    expect(CRYPTO_RESEARCH_SPECIFICATION.universe.members).toEqual(CRYPTO_TRADINGVIEW_SYMBOLS);
    const { rule, ...hashes } = CRYPTO_RESEARCH_SPECIFICATION.data.inputHashes;
    expect(rule).toMatch(/stableSerialize/);
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(CRYPTO_TRADINGVIEW_SYMBOLS).sort());
  });

  it('uses exactly the recorded scan, coverage floor and dates the specification names', () => {
    const spec = CRYPTO_RESEARCH_SPECIFICATION;
    expect(spec.scanner.parity[1]).toContain(RECORDED_SCAN.scanId);
    expect(spec.scanner.parity[1]).toContain(RECORDED_SCAN.sha256);
    expect(spec.evaluationDates.last).toBe(RECORDED_SCAN.day);
    expect(spec.evaluationDates.minimumCoverage).toContain(`at least ${MINIMUM_EVALUATED} of`);
  });
});

describe('no look-ahead', () => {
  const history = cryptoHistory(exportOf());
  const D = dayBefore(10);

  it("decides at D's close, 23:59:59.999 UTC, and passes no later candle to the scanner", () => {
    expect(iso(cutoffOf(D))).toBe(`${D}T23:59:59.999Z`);
    for (const input of inputsAt(history, D)) {
      const opens = (input.candles ?? []).map((candle) => candle.timestamp);
      expect(Math.max(...opens) + DAY - 1).toBeLessThanOrEqual(cutoffOf(D));
      expect(utc(Math.max(...opens))).toBe(D);
      // The 200 UTC days the scan requests: D - 200 days through D.
      expect(utc(Math.min(...opens))).toBe(dayBefore(210));
    }
  });

  it('gives the same scan on D whatever the bars after D say', () => {
    const changed = exportOf((_, k) =>
      bars(pathOf(k)).map((bar) =>
        utc(bar.t * 1000) > D
          ? { ...bar, o: bar.o * 3, h: bar.h * 3, l: bar.l * 3, c: bar.c * 3 }
          : bar,
      ),
    );
    const after = cryptoHistory(changed);
    expect(stableSerialize(replayDay(after, D).date)).toBe(
      stableSerialize(replayDay(history, D).date),
    );
    // Sanity: the change is visible once those bars are history.
    const later = dayBefore(2);
    expect(stableSerialize(replayDay(after, later).date)).not.toBe(
      stableSerialize(replayDay(history, later).date),
    );
  });

  it('never scores the bar forming at the export cutoff', () => {
    const last = replayDay(history, utc(LAST_CLOSED)).date;
    expect(last.results.every((result) => result.dataAsOf === utc(LAST_CLOSED))).toBe(true);
    expect(utcCalendar(history, START).at(-1)).toBe(utc(LAST_CLOSED));
  });
});

describe('outcome reference and endpoints', () => {
  const file = exportOf();
  const history = cryptoHistory(file);
  const days = utcCalendar(history, START);
  const prices = outcomeBars(history, START);
  const ticker = UNIVERSE[3]!;
  const raw = file.instruments[3]!.response as { bars: Bar[] };
  const openOn = (day: string) => raw.bars.find((bar) => utc(bar.t * 1000) === day)!.o;
  const outcome = (day: string, horizon: number) =>
    measureOutcome(prices.get(ticker)!, days, days.indexOf(day), horizon);

  it('references the OPEN of the first bar opening after the cutoff, never the scored close', () => {
    const D = dayBefore(30);
    const reference = utc(LAST_CLOSED - 29 * DAY);
    expect(Date.parse(`${reference}T00:00:00.000Z`)).toBe(cutoffOf(D) + 1);
    for (const horizon of [1, 5, 20]) {
      const endpoint = utc(LAST_CLOSED - (29 - horizon) * DAY);
      const expected = (openOn(endpoint) / openOn(reference) - 1) * 100;
      expect(outcome(D, horizon)).toEqual({ status: 'AVAILABLE', change: expected });
      const closeOnD = raw.bars.find((bar) => utc(bar.t * 1000) === D)!.c;
      expect(expected).not.toBeCloseTo((openOn(endpoint) / closeOnD - 1) * 100, 6);
    }
  });

  it('measures a horizon only when its endpoint bar closed by the export cutoff', () => {
    for (const horizon of [1, 5, 20]) {
      // The endpoint is 10 Nov: closed. One day later it would be the forming 11 Nov bar.
      expect(outcome(dayBefore(horizon + 1), horizon).status).toBe('AVAILABLE');
      expect(outcome(dayBefore(horizon), horizon)).toEqual({ status: 'PENDING', change: null });
    }
    expect(outcome(utc(LAST_CLOSED), 1).status).toBe('PENDING');
  });

  it('reports a missing or invalid bar without substituting a neighbour', () => {
    const gap = dayBefore(15);
    const broken = dayBefore(25);
    const edited = cryptoHistory(
      exportOf((_, k) =>
        bars(pathOf(k))
          .filter((bar) => k !== 3 || utc(bar.t * 1000) !== gap)
          .map((bar) =>
            k === 3 && utc(bar.t * 1000) === broken ? { ...bar, h: bar.l * 0.5 } : bar,
          ),
      ),
    );
    const editedPrices = outcomeBars(edited, START).get(ticker)!;
    const at = (day: string, horizon: number) =>
      measureOutcome(editedPrices, days, days.indexOf(day), horizon);
    expect(at(dayBefore(16), 1).status).toBe('MISSING'); // reference is the gap
    expect(at(dayBefore(21), 5).status).toBe('MISSING'); // endpoint is the gap
    expect(at(dayBefore(26), 1).status).toBe('INVALID'); // reference is the broken bar
    expect(at(dayBefore(18), 1).status).toBe('AVAILABLE');
  });
});

describe('the scanner policy on gaps, invalid bars and young listings', () => {
  const only = (ticker: string, rows: Bar[]) =>
    cryptoHistory(exportOf((t, k) => (t === ticker ? rows : bars(pathOf(k))))).filter(
      (input) => input.ticker === ticker,
    );
  const statusOn = (history: ReturnType<typeof only>, day: string) =>
    replayDay(history, day).date.results[0]!;
  const ticker = UNIVERSE[0]!;

  it('marks exactly the 198 dates whose 199-candle window spans a missing day DATA_INVALID', () => {
    const rows = bars(pathOf(0), 600);
    const gapTime = LAST_CLOSED - 300 * DAY;
    const history = only(
      ticker,
      rows.filter((bar) => bar.t * 1000 !== gapTime),
    );
    const statuses = Array.from({ length: 260 }, (_, i) =>
      statusOn(history, utc(gapTime + (i - 30) * DAY)),
    );
    const invalid = statuses.filter((result) => result.status === 'DATA_INVALID');
    expect(invalid).toHaveLength(198);
    expect(invalid[0]!.detail).toMatch(/MISSING_DAILY_INTERVAL/);
    // On the gap day itself the 24h bound admits the day before (exactly 24h at D's close).
    expect(statusOn(history, utc(gapTime))).toMatchObject({
      status: 'EVALUATED',
      dataAsOf: utc(gapTime - DAY),
    });
    expect(statusOn(history, utc(gapTime + 199 * DAY)).status).toBe('EVALUATED');
  });

  it('marks a window holding an invalid bar DATA_INVALID and never repairs it', () => {
    const rows = bars(pathOf(0), 600);
    const brokenTime = LAST_CLOSED - 300 * DAY;
    const history = only(
      ticker,
      rows.map((bar) => (bar.t * 1000 === brokenTime ? { ...bar, h: bar.l * 0.5 } : bar)),
    );
    expect(statusOn(history, utc(brokenTime - DAY)).status).toBe('EVALUATED');
    expect(statusOn(history, utc(brokenTime)).detail).toMatch(/HIGH_BELOW_LOW/);
    expect(statusOn(history, utc(brokenTime + 198 * DAY)).status).toBe('DATA_INVALID');
    expect(statusOn(history, utc(brokenTime + 199 * DAY)).status).toBe('EVALUATED');
  });

  it('marks a member STALE_DATA two days after its last bar', () => {
    // 300 closed bars end on 10 Nov; keeping 280 ends them on 21 Oct.
    const history = only(ticker, bars(pathOf(0), 300).slice(0, 280));
    const last = LAST_CLOSED - 20 * DAY;
    // One day later the 24h bound still holds at D's close (exactly 24h): nothing is filled.
    expect(statusOn(history, utc(last + DAY))).toMatchObject({
      status: 'EVALUATED',
      dataAsOf: utc(last),
    });
    expect(statusOn(history, utc(last + 2 * DAY)).status).toBe('STALE_DATA');
  });

  it(
    'keeps young listings in the universe, ranks them only from their 199th closed candle',
    () => {
      const young = UNIVERSE[5]!;
      const infant = UNIVERSE[6]!;
      const results = study(
        exportOf((t, k) => {
          if (t === young) return bars(pathOf(k), 215);
          if (t === infant) return bars(pathOf(k), 50);
          return bars(pathOf(k));
        }),
      );
      const firstFull = dayBefore(215 - 199);
      expect(results.coverage.perMember[young]!.firstEvaluated).toBe(firstFull);
      expect(results.coverage.perMember[infant]!.firstEvaluated).toBeNull();
      expect(results.coverage.perMember[infant]!.byStatus).toEqual({
        INSUFFICIENT_HISTORY: results.evaluationDates.count,
      });
      const before = results.replay.find((date) => date.session === dayBefore(17))!;
      const after = results.replay.find((date) => date.session === firstFull)!;
      expect(before.results.find((r) => r.ticker === young)).toMatchObject({
        status: 'INSUFFICIENT_HISTORY',
        rank: null,
      });
      expect(before.evaluated).toBe(23);
      expect(after.evaluated).toBe(24);
      expect(results.coverage.evaluatedPerDate).toEqual({ min: 23, max: 24 });
      // Ranks run 1..evaluated on every date; the never-evaluated listing has no observation.
      for (const date of results.replay) {
        const ranks = date.results.flatMap((r) => (r.rank === null ? [] : [r.rank]));
        expect(ranks.sort((a, b) => a - b)).toEqual(
          Array.from({ length: date.evaluated }, (_, i) => i + 1),
        );
      }
      const universe = results.horizons[0]!.againstUniverse.universe;
      expect(universe.byAsset[infant]).toBeUndefined();
      expect(universe.byAsset[young]!.distinctDates).toBe(16 - 1); // 10 Nov is pending
    },
    STUDY_TIMEOUT,
  );

  it(
    'leaves dates below the coverage floor out of every comparison, and counts them',
    () => {
      // 12 members join 14 days late: until then only 13 are evaluated, below the floor of 15.
      const late = new Set(UNIVERSE.slice(0, 12));
      const results = study(exportOf((t, k) => bars(pathOf(k), late.has(t) ? 216 : 230)));
      expect(results.coverage.datesBelowMinimum).toBe(14);
      expect(results.evaluationDates.compared).toBe(results.evaluationDates.count - 14);
      expect(results.coverage.observationsOnExcludedDates).toBe(14 * 13);
      const universe = results.horizons[0]!.againstUniverse.universe.stats;
      // 1-day outcomes: every compared date but the last two (pending).
      expect(universe.distinctDates).toBe(results.evaluationDates.compared - 2);
      expect(universe.observations).toBe(universe.distinctDates * 25);
    },
    STUDY_TIMEOUT,
  );
});

describe('ranking ties and deterministic baselines', () => {
  it(
    'breaks equal scores by ticker and gives byte-identical results in any export order',
    () => {
      // Two members on the same path score the same on every date.
      const [first, second] = [UNIVERSE[0]!, UNIVERSE[1]!];
      const file = exportOf((t, k) => bars(pathOf(t === second ? 0 : k)));
      const results = study(file);
      for (const date of results.replay) {
        const a = date.results.find((r) => r.ticker === first)!;
        const b = date.results.find((r) => r.ticker === second)!;
        expect(a.score).toBe(b.score);
        expect(b.rank).toBe(a.rank! + 1);
      }
      const reordered = { ...file, instruments: [...file.instruments].reverse() };
      expect(JSON.stringify(study(reordered))).toBe(JSON.stringify(results));
    },
    STUDY_TIMEOUT,
  );
});

/** Synthetic observations on one date: change, tercile and rank as given. */
function observation(
  ticker: string,
  change: number,
  tercile: 1 | 2 | 3,
  extra: Partial<CryptoObservation> = {},
): CryptoObservation {
  const available: ResearchOutcome = { status: 'AVAILABLE', change };
  return {
    ticker,
    session: '2026-01-05',
    volatility: tercile / 100,
    tercile,
    rank: 1,
    quintile: 1,
    long: false,
    risk: false,
    longTransition: false,
    riskTransition: false,
    longOnsetUnknown: false,
    riskOnsetUnknown: false,
    outcomes: { 1: available, 5: available, 20: available },
    ...extra,
  };
}

describe('same-date and volatility-matched baselines', () => {
  const day = [
    observation('A', 4, 1, { rank: 1, long: true }),
    observation('B', 2, 1, { rank: 6 }),
    observation('C', -1, 2, { rank: 2, risk: true }),
    observation('D', 3, 2, { rank: 7 }),
    observation('E', 10, 3, { rank: 3, risk: true }),
    observation('F', 6, 3, { rank: 4, risk: true }),
  ];
  const results = cryptoHorizonResults(day, 1);

  it('compares a group with the equal-weight mean of evaluated pairs that date, itself included', () => {
    const baseline = (4 + 2 - 1 + 3 + 10 + 6) / 6;
    expect(results.againstUniverse['long-setup'].stats).toMatchObject({
      observations: 1,
      mean: 4,
      baselineMean: baseline,
      meanDifferenceVsBaseline: 4 - baseline,
    });
    expect(results.againstUniverse.universe.stats.meanDifferenceVsBaseline).toBeCloseTo(0, 12);
  });

  it('matches against same-tercile pairs outside the group, and counts the unmatched', () => {
    expect(results.volatilityMatched['long-setup'].stats).toMatchObject({
      observations: 1,
      baselineMean: 2,
      meanDifferenceVsBaseline: 2,
    });
    // Tercile 3 holds only risk warnings: E and F have no control and are not forced.
    expect(results.volatilityMatched['risk-warning']).toMatchObject({ unmatched: 2 });
    expect(results.volatilityMatched['risk-warning'].stats).toMatchObject({
      observations: 1,
      baselineMean: 3,
      meanDifferenceVsBaseline: -4,
    });
    // The top 5 (A, C, E, F) against B, D, and nothing in tercile 3.
    expect(results.volatilityMatched.top5.unmatched).toBe(2);
  });

  it('weights each date once in the date-level difference', () => {
    const other = [
      observation('A', 12, 1, { session: '2026-01-06', long: true }),
      observation('C', 12, 2, { session: '2026-01-06', long: true }),
      observation('B', 0, 1, { session: '2026-01-06' }),
    ];
    const stats = cryptoHorizonResults([...day, ...other], 1).againstUniverse['long-setup'].stats;
    // 5 Jan: A is exactly the universe mean (0). 6 Jan: both long setups are +4.
    expect(stats.meanDifferenceVsBaseline).toBeCloseTo((0 + 4 + 4) / 3, 12);
    expect(stats.dateMeanDifferenceVsBaseline).toBeCloseTo((0 + 4) / 2, 12);
    expect(stats.fractionOfDatesAboveBaseline).toBe(0.5);
  });

  it('places members in volatility terciles by ATR/close ascending, ties by ticker', () => {
    const replay: CryptoReplayDate[] = [
      {
        session: '2026-01-05',
        evaluated: 6,
        results: ['F', 'E', 'D', 'C', 'B', 'A'].map((ticker, i) => ({
          ticker,
          status: 'EVALUATED' as const,
          detail: null,
          dataAsOf: '2026-01-05',
          rank: i + 1,
          score: 50,
          regime: 'NEUTRAL' as const,
          setups: { long: false, risk: false },
          volatility: ticker === 'A' || ticker === 'B' ? 0.01 : 0.05 - i * 0.001,
        })),
      },
    ];
    const pending: ResearchOutcome = { status: 'PENDING', change: null };
    const terciles = Object.fromEntries(
      cryptoObservations(replay, () => pending).map((o) => [o.ticker, o.tercile]),
    );
    expect(terciles).toEqual({ A: 1, B: 1, D: 2, C: 2, E: 3, F: 3 });
  });
});

describe('scanner parity', () => {
  it(
    'equals the import reading the whole export at every cutoff, and the recorded scan',
    () => {
      const results = cleanStudy();
      expect(results.parity).toMatchObject({
        status: 'MATCH',
        datesCompared: results.evaluationDates.count,
        last: utc(LAST_CLOSED),
        mismatches: [],
      });
      expect(results.recordedScanParity).toMatchObject({ status: 'MATCH', members: 25 });
    },
    STUDY_TIMEOUT,
  );

  it('names the member and field of a replay that departs from the scanner', () => {
    const file = exportOf();
    const D = dayBefore(5);
    const { scan } = replayDay(cryptoHistory(file), D);
    const actual = evaluateScan(importInputs(file, cutoffOf(D)), scanOptions(cutoffOf(D)));
    expect(scanDifferences(D, scan, actual)).toEqual([]);
    const top = scan.results[0]!;
    const tampered: MarketScan = {
      ...scan,
      results: [{ ...top, rank: 99 }, ...scan.results.slice(1)],
    };
    expect(scanDifferences(D, tampered, actual)).toEqual([
      { session: D, ticker: top.ticker, field: 'rank', replay: 99, scanner: top.rank },
    ]);
  });

  it('refuses a recorded scan that differs from the replay on its day', () => {
    const file = exportOf();
    const { scan } = replayDay(cryptoHistory(file), RECORDED_SCAN.day);
    const recorded = recordedOf(file);
    expect(recordedScanParity(scan, recorded, START).status).toBe('MATCH');
    const [top, ...rest] = recorded.scan.results;
    const changed = {
      ...recorded,
      scan: {
        ...recorded.scan,
        results: [{ ...top!, setups: { long: true, risk: false } }, ...rest],
      },
    };
    expect(recordedScanParity(scan, changed, START)).toMatchObject({
      status: 'MISMATCH',
      mismatches: [{ ticker: top!.ticker, field: 'setups' }],
    });
    expect(recordedScanParity(scan, recorded, START + 1).status).toBe('MISMATCH');
  });
});

describe('reproduction and tamper detection', () => {
  const file = exportOf();
  const raw = Buffer.from(JSON.stringify(file));
  const frozen = {
    exportSha256: createHash('sha256').update(raw).digest('hex'),
    inputHashes: instrumentHashes(file),
  };

  it('reads only the frozen export, and names an instrument whose entry changed', () => {
    expect(verifyCryptoExport(raw, frozen).file).toEqual(file);
    const tampered = structuredClone(file);
    const target = tampered.instruments[4]!;
    (target.response as { bars: Bar[] }).bars[100]!.c *= 1.0001;
    expect(() => verifyCryptoExport(Buffer.from(JSON.stringify(tampered)), frozen)).toThrow(
      `changed instrument entries: ${target.ticker}`,
    );
    expect(() => verifyCryptoExport(Buffer.from(JSON.stringify(file, null, 1)), frozen)).toThrow(
      /every instrument entry is unchanged/,
    );
    const equity = Buffer.from(JSON.stringify({ ...file, universe: undefined, instruments: [] }));
    expect(() => verifyCryptoExport(equity, frozen)).toThrow(/reads a crypto-usdt-v1 export/);
  });

  it('refuses a fixture export and a recorded scan other than the frozen ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popup-crypto-research-'));
    const path = join(dir, 'export.json');
    await writeFile(path, raw);
    await expect(
      runScannerResearchCrypto({
        file: path,
        outputDir: dir,
        repositoryCommit: 'c'.repeat(40),
        scanStore: dir,
      }),
    ).rejects.toThrow(/frozen on export 8d251bbf/);
    await writeFile(join(dir, `${RECORDED_SCAN.scanId}.json`), JSON.stringify(recordedOf(file)));
    await expect(loadRecordedScan(dir)).rejects.toThrow(/frozen as sha256 000cc5ea/);
  });

  it(
    'refuses results off the frozen facts, writes once, and reports a tampered result as CONFLICT',
    async () => {
      const results = cleanStudy();
      expect(cryptoFrozenFactDifferences(results)).toContain(
        `evaluationDates.first: ${results.evaluationDates.first} (frozen 2024-09-01)`,
      );
      const dir = await mkdtemp(join(tmpdir(), 'popup-crypto-research-'));
      const options = { outputDir: dir, repositoryCommit: 'c'.repeat(40), now: () => START };
      const write = (differences: string[]) =>
        writeStudy(results, 'f'.repeat(64), options, renderCryptoResearchReport, differences);
      await expect(write(['parity.status: MISMATCH (frozen MATCH)'])).rejects.toThrow(
        /departs from the frozen study/,
      );
      const created = await write([]);
      expect(created.status).toBe('CREATED');
      expect((await write([])).status).toBe('UNCHANGED');
      const stored = await readFile(created.resultsPath, 'utf8');
      await writeFile(created.resultsPath, stored.replace('"MATCH"', '"MISMATCH"'));
      expect((await write([])).status).toBe('CONFLICT');
    },
    STUDY_TIMEOUT,
  );

  it(
    'recalculates without any network request',
    () => {
      const network = vi.spyOn(globalThis, 'fetch');
      study();
      expect(network).not.toHaveBeenCalled();
    },
    STUDY_TIMEOUT,
  );
});

describe('summary and report', () => {
  it(
    'summarizes aggregates only, with no ticker',
    () => {
      const summary = JSON.stringify(researchSummaryCrypto(cleanStudy()));
      expect(UNIVERSE.filter((ticker) => summary.includes(ticker))).toEqual([]);
      expect(summary).toContain('"volatilityMatched"');
    },
    STUDY_TIMEOUT,
  );

  it(
    'labels the evidence and shows every horizon, without scripts',
    () => {
      const html = renderCryptoResearchReport(cleanStudy(), {
        generatedAt: iso(START),
        repositoryCommit: 'c'.repeat(40),
        resultHash: 'f'.repeat(64),
      });
      expect(html).toContain('retrospective historical research, not prospective evidence');
      expect(html).toContain('a decline is not profit');
      expect(html).toContain('not portfolio returns');
      for (const label of ['1 UTC day:', '5 UTC days:', '20 UTC days:'])
        expect(html).toContain(label);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('-0.00');
    },
    STUDY_TIMEOUT,
  );
});
