import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import stageDSpec from '../docs/spot-24h-expected-net-t3s3-dev-v1.json';
import {
  ACTIVITY,
  ACTIVITY_REASONS,
  activityShockAt,
  buildDataset,
  COLUMNS,
  conclude,
  CONFIG,
  countStatuses as countStatusesOf,
  coverageOf,
  evaluatePeriod,
  evaluateScreen,
  EVALUATIONS,
  EXCLUSIONS,
  fromColumns,
  monthly,
  pairParity,
  periodLabel,
  planRequests,
  priceExclusionAt,
  RULES,
  runRetrieval,
  SPEC,
  specSha256,
  stageDParity,
  toColumns,
  validatePair,
  type ActivityHour,
  type ArmPredictions,
  type DatasetRow,
  type PeriodResult,
  type PlannedRequest,
  type Predictions,
  type RetrievalIo,
} from './activityShock';
import {
  assertTermsResolved,
  computeValidation,
  runActivityEvaluate,
  runActivityExport,
  runActivityRetrieve,
  specification,
  STUDY_FILES,
  studyIdentity,
  verifySteps,
} from './activityShockRun';
import {
  CLASSES,
  EXCLUSIONS as STAGE_D_EXCLUSIONS,
  specSha256 as stageDSha256,
  type Row as StageDRow,
} from './expectedNet';
import { mulberry32 } from './opportunityAnalysis';
import { decisionTimes, FEATURES } from './quantileForecast';
import { HOUR_MS, indexHourly, PROTOCOL, splitOf, type HourCandle, type Split } from './spot24h';

const HEAVY = 120_000;
const H = HOUR_MS;

// ---------------------------------------------------------------------------------------------
// Synthetic kline rows and responses (Binance's documented field order); no real market data.

function kline(open: number, volume = '10.00000000', overrides: Record<number, unknown> = {}) {
  const zero = Number(volume) === 0;
  const row: unknown[] = [
    open,
    '100.00000000',
    '101.00000000',
    '99.00000000',
    '100.50000000',
    volume,
    open + H - 1,
    zero ? '0.00000000' : (Number(volume) * 100).toFixed(8),
    zero ? 0 : 50,
    zero ? '0.00000000' : (Number(volume) * 0.6).toFixed(8),
    zero ? '0.00000000' : (Number(volume) * 60).toFixed(8),
    '0',
  ];
  for (const [i, v] of Object.entries(overrides)) row[Number(i)] = v;
  return row;
}

const SENT = RULES.endExclusive + 10 * H;
const ONE = planRequests(['AAAUSDT']);

/** All 19 responses for one pair, each hour's volume from `volumeOf`; `edit` may alter bodies. */
function responses(
  volumeOf: (t: number) => string = () => '10.00000000',
  edit: (k: number, body: unknown[][]) => unknown = (_k, body) => body,
) {
  return ONE.map((request) => {
    const body: unknown[][] = [];
    for (let t = request.startTime; t <= request.endTime; t += H) body.push(kline(t, volumeOf(t)));
    return { request, body: edit(request.k, body), sentAt: SENT };
  });
}

const fakeResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

function fakeIo(answers: (Response | Error)[]) {
  const saved = new Map<string, Buffer>();
  const sleeps: number[] = [];
  const urls: string[] = [];
  let clock = Date.parse('2026-11-26T12:00:00.000Z');
  const io: RetrievalIo = {
    fetchImpl: (url) => {
      urls.push(url);
      const next = answers.shift() ?? fakeResponse(200, []);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => (clock += 5),
    save: (name, bytes) => {
      if (saved.has(name)) return Promise.reject(new Error('EEXIST'));
      saved.set(name, bytes);
      return Promise.resolve();
    },
  };
  return { io, saved, sleeps, urls };
}

// ---------------------------------------------------------------------------------------------

describe('the specification', () => {
  it('is frozen at revision 3 with resolved terms and the support clarification recorded', () => {
    expect(SPEC.revision).toBe(3);
    expect(SPEC.status).toMatch(/^FROZEN at revision 3/);
    expect(SPEC.dataSource.terms.status).toBe('RESOLVED');
    expect(SPEC.dataSource.terms.supportClarification.source).toContain('case 174972727');
    expect(SPEC.dataSource.terms.supportClarification.scope).toContain('not a commercial licence');
    expect(() => assertTermsResolved()).not.toThrow();
    const unresolved = { dataSource: { terms: { status: 'UNRESOLVED' } } };
    expect(() => assertTermsResolved(unresolved)).toThrow(/Refusing/);
    expect(specSha256()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mirrors its lists, v1, #220 and #222', () => {
    expect(SPEC.retrieval.pairs).toContain(
      PROTOCOL.universe.members.map((m) => m.replace(/USDT$/, '')).join(', '),
    );
    expect(EXCLUSIONS).toEqual(SPEC.observations.exclusions.order);
    expect(EXCLUSIONS.slice(0, STAGE_D_EXCLUSIONS.length)).toEqual([
      ...stageDSpec.exclusions.order,
    ]);
    expect(ACTIVITY_REASONS).toEqual(SPEC.activityFeature.unavailable.order);
    expect(SPEC.arms.A.features).toContain(FEATURES.join(', '));
    expect(SPEC.estimator.settings).toEqual(stageDSpec.forecasters.C.settings);
    expect(EVALUATIONS).toEqual(stageDSpec.periods.evaluations);
    expect(SPEC.basis.estimatorSource.sha256).toBe(stageDSha256());
    expect(SPEC.basis.estimatorSource.dataset.path).toContain(stageDSha256().slice(0, 12));
    expect(COLUMNS).toEqual([
      'symbol',
      'time',
      'split',
      'stageDRow',
      'exclusion',
      ...FEATURES,
      ACTIVITY,
      'outcome',
      'class',
    ]);
    expect(COLUMNS.some((c) => /open|entry|net|gross/i.test(c))).toBe(false);
  });

  it('states every prose number the code uses', () => {
    const r = SPEC.retrieval;
    expect(r.range).toContain(`(${RULES.firstOpen})`);
    expect(r.range).toContain(`(${RULES.endExclusive})`);
    expect(r.range).toContain(`${RULES.hoursPerPair.toLocaleString('en-US')} hours per pair`);
    expect(r.requests).toContain(`${RULES.requestsPerPair} per pair, 380 in all`);
    expect(r.requests).toContain('k × 3,600,000,000');
    expect(r.requests).toContain(`limit ${RULES.limit}`);
    expect(r.order).toContain(`at least ${RULES.pauseMs} ms apart`);
    expect(r.stopRules.http429).toContain(`above ${RULES.maxRetryAfterS}`);
    expect(r.stopRules.usedWeight).toContain(`exceeds ${RULES.maxUsedWeight}`);
    expect(SPEC.validation.ohlcParity.hours).toContain(
      new Date(RULES.v1FirstOpen).toISOString().slice(0, 16),
    );
    expect(SPEC.activityFeature.definition.hours).toContain(`j = 1 … ${RULES.windowHours}`);
    expect(SPEC.activityFeature.definition.Rk).toContain(`k = 1 … ${RULES.blocks}`);
    expect(SPEC.observations.coverage.requirement).toContain(`>= ${RULES.minCoverage}`);
    expect(SPEC.evidenceFloors.perEvaluation).toContain(
      `At least ${RULES.minObservations.toLocaleString('en-US')} common observations on at least ${RULES.minDays} distinct UTC days`,
    );
    expect(SPEC.evidenceFloors.interval).toContain(RULES.minDefined.toLocaleString('en-US'));
    expect(SPEC.uncertainty.minimumDefinedReplicates).toBe(RULES.minDefined);
  });

  it("changes only the bootstrap's replicates and seed from protocol v1", () => {
    const back = {
      ...CONFIG,
      uncertainty: { ...CONFIG.uncertainty, replicates: 2000, random: PROTOCOL.uncertainty.random },
    };
    expect(back).toEqual(PROTOCOL);
    expect(CONFIG.uncertainty.replicates).toBe(SPEC.uncertainty.replicates);
    expect(CONFIG.uncertainty.random.seed).toBe(SPEC.uncertainty.random.seed);
    expect(CONFIG.uncertainty.random.drawMessage).toBe(SPEC.uncertainty.random.drawMessage);
  });

  it('records every study file, the Python step and #222 included', () => {
    expect(STUDY_FILES[0]).toBe('docs/spot-24h-activity-shock-increment-dev-v1.json');
    for (const f of [
      'scripts/activityShock.ts',
      'scripts/activity_shock_classifier.py',
      'scripts/binanceActivityProbe.ts',
      'scripts/expected_net_classifier.py',
      'docs/spot-24h-expected-net-t3s3-dev-v1.json',
    ])
      expect(STUDY_FILES).toContain(f);
  });
});

describe('request planning', () => {
  it('plans 19 requests per pair, 380 in all, contiguous over exactly 18,264 hours', () => {
    const plan = planRequests(PROTOCOL.universe.members);
    expect(plan).toHaveLength(380);
    expect(plan.slice(0, 19).every((r) => r.symbol === 'BTCUSDT')).toBe(true);
    expect(plan.map((r) => r.k).slice(0, 19)).toEqual([...Array(19).keys()]);
    const pair = plan.slice(0, 19);
    expect(pair[0]!.startTime).toBe(RULES.firstOpen);
    expect(pair.at(-1)!.endTime).toBe(1795305599999);
    for (let k = 1; k < 19; k += 1) expect(pair[k]!.startTime).toBe(pair[k - 1]!.endTime + 1);
    expect(pair.map((r) => r.expectedRows)).toEqual([...Array(18).fill(1000), 264]);
    expect(pair.reduce((s, r) => s + r.expectedRows, 0)).toBe(RULES.hoursPerPair);
    expect(pair[18]!.url).toBe(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h' +
        '&startTime=1794355200000&endTime=1795305599999&limit=1000',
    );
    expect(plan.every((r) => !/key|signature|timestamp=/i.test(r.url))).toBe(true);
    expect(() => planRequests(['btc'])).toThrow(/Unexpected symbol/);
  });
});

describe('the retrieval stop rules', () => {
  const two = (planRequests(['AAAUSDT', 'BBBUSDT']) as PlannedRequest[]).filter((r) => r.k < 2);

  it('fetches one at a time in order, paced, saving each 200 body byte for byte', async () => {
    const { io, saved, sleeps, urls } = fakeIo(
      two.map((_, i) => fakeResponse(200, [[i]], { 'x-mbx-used-weight-1m': String(2 * (i + 1)) })),
    );
    const { log, stopped } = await runRetrieval(two, io);
    expect(stopped).toBeNull();
    expect(urls).toEqual(two.map((r) => r.url));
    expect(sleeps).toEqual([250, 250, 250, 250]);
    expect([...saved.keys()]).toEqual([
      'raw/AAAUSDT-00.json',
      'raw/AAAUSDT-01.json',
      'raw/BBBUSDT-00.json',
      'raw/BBBUSDT-01.json',
    ]);
    expect(saved.get('raw/BBBUSDT-00.json')!.toString()).toBe('[[2]]');
    expect(log.map((e) => [e.status, e.usedWeight1m, e.attempt])).toEqual([
      [200, 2, 1],
      [200, 4, 1],
      [200, 6, 1],
      [200, 8, 1],
    ]);
    expect(log[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('retries a 429 once after Retry-After, counting the retry separately', async () => {
    const { io, sleeps } = fakeIo([
      fakeResponse(429, '', { 'retry-after': '3' }),
      fakeResponse(200, []),
    ]);
    const { log, stopped } = await runRetrieval(two.slice(0, 1), io);
    expect(stopped).toBeNull();
    expect(sleeps[0]).toBe(3000);
    expect(log.map((e) => [e.attempt, e.status])).toEqual([
      [1, 429],
      [2, 200],
    ]);
  });

  it.each([
    [
      'a second 429',
      [
        fakeResponse(429, '', { 'retry-after': '1' }),
        fakeResponse(429, '', { 'retry-after': '1' }),
      ],
      /second 429/,
    ],
    ['a 429 without Retry-After', [fakeResponse(429, '')], /Retry-After null/],
    [
      'a 429 asking for more than 120 s',
      [fakeResponse(429, '', { 'retry-after': '121' })],
      /Retry-After 121/,
    ],
    ['a 418', [fakeResponse(418, '')], /HTTP 418/],
    ['a 403', [fakeResponse(403, '')], /HTTP 403/],
    ['a 451', [fakeResponse(451, '')], /HTTP 451/],
    ['another status', [fakeResponse(500, '')], /HTTP 500/],
    ['a network error or timeout', [new Error('timeout')], /network error or timeout/],
    ['a non-JSON body', [fakeResponse(200, 'not json')], /non-JSON/],
    ['a body that is not an array', [fakeResponse(200, { code: -1 })], /not a JSON array/],
    [
      'used weight above 3000',
      [fakeResponse(200, [], { 'x-mbx-used-weight-1m': '3001' })],
      /3001 above 3000/,
    ],
  ])('stops on %s and requests nothing more', async (_name, answers, why) => {
    const { io, urls } = fakeIo([...answers]);
    const { stopped } = await runRetrieval(two, io);
    expect(stopped).toMatch(why);
    expect(urls.every((u) => u === two[0]!.url)).toBe(true);
  });

  it('keeps going at exactly 3000 used weight', async () => {
    const { io } = fakeIo([fakeResponse(200, [], { 'x-mbx-used-weight-1m': '3000' })]);
    expect((await runRetrieval(two.slice(0, 2), io)).stopped).toBeNull();
  });
});

describe('validation and classification', () => {
  it('classifies every expected hour once: valid, valid-zero, missing and invalid', () => {
    const zeroAt = RULES.firstOpen + 5 * H;
    const { hours, responseIssues } = validatePair(
      responses(
        (t) => (t === zeroAt ? '0.00000000' : '10.00000000'),
        (k, body) =>
          k !== 0
            ? body
            : body
                .filter((r) => r[0] !== RULES.firstOpen + 7 * H) // hour 7: no row
                .map((r) => {
                  if (r[0] === RULES.firstOpen + 8 * H)
                    return kline(r[0], '10.00000000', { 9: '11.00000000' });
                  if (r[0] === RULES.firstOpen + 9 * H) return r.slice(0, 11); // short row
                  return r;
                }),
      ),
    );
    expect(hours).toHaveLength(RULES.hoursPerPair);
    const at = (i: number) => hours[i]!;
    expect(at(0).status).toBe('VALID');
    expect(at(0).volume).toBe(10);
    expect([at(5).status, at(5).volume]).toEqual(['VALID_ZERO', 0]);
    expect(at(7).status).toBe('MISSING');
    expect(at(7).issues).toEqual(['no row for this hour']);
    expect(at(8).status).toBe('INVALID');
    expect(at(8).issues).toContain('taker-buy base above base volume');
    expect(at(8).volume).toBeNull();
    expect(at(9).status).toBe('MISSING');
    expect(countStatusesOf(hours)).toEqual({
      VALID: RULES.hoursPerPair - 4,
      VALID_ZERO: 1,
      MISSING: 2,
      INVALID: 1,
    });
    expect(responseIssues).toContain('k=0: 999 rows, expected 1000');
  });

  it('marks duplicates, out-of-range and non-increasing rows invalid, never repairing them', () => {
    const dup = RULES.firstOpen + 1000 * H; // first hour of k = 1
    const { hours, responseIssues } = validatePair(
      responses(undefined, (k, body) => {
        if (k === 0) body.push(kline(dup)); // also inside k = 1: duplicate and out of range
        if (k === 2) [body[3], body[4]] = [body[4]!, body[3]!];
        if (k === 3) body.push(kline(RULES.firstOpen + 3000 * H + 1));
        return body;
      }),
    );
    const byTime = new Map(hours.map((h) => [h.openTime, h]));
    expect(byTime.get(dup)!.status).toBe('INVALID');
    expect(byTime.get(dup)!.issues).toEqual(
      expect.arrayContaining(["open time outside its request's range", 'duplicate open time']),
    );
    expect(byTime.get(dup)!.volume).toBeNull();
    expect(byTime.get(RULES.firstOpen + 2003 * H)!.issues).toContain('open time not increasing');
    expect(responseIssues.some((i) => i.startsWith('k=3 row 1000: open time'))).toBe(true);
    expect(hours.filter((h) => h.status === 'INVALID')).toHaveLength(2);
  });

  it('rejects a candle that had not closed when its request was sent', () => {
    const early = responses().map((r) => ({ ...r, sentAt: RULES.firstOpen + 30 * H }));
    const { hours } = validatePair(early);
    expect(hours[29]!.status).toBe('VALID');
    expect(hours[30]!.status).toBe('INVALID');
    expect(hours[30]!.issues).toContain('candle had not closed when the request was sent');
  });

  it('checks OHLC values exactly and presence both ways against v1', () => {
    const { hours } = validatePair(responses());
    const v1 = new Map(
      hours
        .filter((h) => h.openTime >= RULES.v1FirstOpen)
        .map((h) => [
          h.openTime,
          {
            timestamp: h.openTime,
            closeTime: h.openTime + H - 1,
            open: 100,
            high: 101,
            low: 99,
            close: 100.5,
          },
        ]),
    );
    const ok = pairParity(hours, v1);
    expect(ok.pass).toBe(true);
    expect(ok.compared).toBe(RULES.hoursPerPair - (RULES.v1FirstOpen - RULES.firstOpen) / H);
    const changed = new Map(v1);
    const t = RULES.v1FirstOpen + 50 * H;
    changed.set(t, { ...v1.get(t)!, close: 100.50000001 });
    const gone = RULES.v1FirstOpen + 60 * H;
    changed.delete(gone);
    const bad = pairParity(hours, changed);
    expect(bad.mismatches).toEqual([
      { openTime: t, field: 'close', probe: 100.5, v1: 100.50000001 },
    ]);
    expect(bad.retrievedOnly).toEqual([gone]);
    const missing = pairParity(
      hours.map((h) =>
        h.openTime === t ? { ...h, status: 'MISSING' as const, ohlc: null, closeTime: null } : h,
      ),
      v1,
    );
    expect(missing.v1Only).toEqual([t]);
    expect(missing.pass).toBe(false);
  });
});

describe('activityShock24h', () => {
  const T = Date.parse('2025-03-01T08:00:00.000Z');
  const hoursOf = (
    volume: (j: number) => number,
    status: (j: number) => ActivityHour['status'] = () => 'VALID',
  ) => {
    const map = new Map<number, ActivityHour>();
    for (let j = 1; j <= 800; j += 1) {
      const v = volume(j);
      map.set(T - j * H, {
        status: status(j),
        volume: status(j) === 'MISSING' || status(j) === 'INVALID' ? null : v,
      });
    }
    for (let j = 0; j < 30; j += 1) map.set(T + j * H, { status: 'VALID', volume: 1e9 });
    return map;
  };
  /** Block k (k = 0 … 30) gets per-hour volume v_k. */
  const blocks = (v: (k: number) => number) => hoursOf((j) => v(Math.floor((j - 1) / 24)));

  it('equals (ln R0 − ln μ) / s by hand, with ddof = 0', () => {
    const per = (k: number) => (k === 0 ? 3 : k % 2 === 0 ? 1 : 2);
    const R = Array.from({ length: 31 }, (_, k) => 24 * per(k));
    const logs = R.slice(1).map(Math.log);
    const mean = logs.reduce((s, x) => s + x, 0) / 30;
    const s = Math.sqrt(logs.reduce((t, x) => t + (x - mean) ** 2, 0) / 30);
    const mu = R.slice(1).reduce((a, b) => a + b, 0) / 30;
    const value = (Math.log(R[0]!) - Math.log(mu)) / s;
    const got = activityShockAt(blocks(per), T);
    expect('value' in got && got.value).toBeCloseTo(value, 14);
    expect(value).toBeCloseTo((Math.log(72) - Math.log(36)) / (Math.log(2) / 2), 12);
  });

  it('reads only h_1 … h_744: candles at or after T and before T − 744h cannot change it', () => {
    const base = blocks((k) => 1 + (k % 3));
    const value = activityShockAt(base, T);
    const later = new Map(base);
    for (let j = 0; j < 30; j += 1) later.set(T + j * H, { status: 'INVALID', volume: null });
    later.set(T - 745 * H, { status: 'MISSING', volume: null });
    expect(activityShockAt(later, T)).toEqual(value);
    const h744 = new Map(base);
    h744.set(T - 744 * H, { status: 'VALID', volume: 50 });
    expect(activityShockAt(h744, T)).not.toEqual(value);
  });

  it('aligns blocks to T: h_24 belongs to R0 and h_25 to R1', () => {
    const base = blocks((k) => 1 + (k % 3));
    const v = (m: Map<number, ActivityHour>) => {
      const a = activityShockAt(m, T);
      return 'value' in a ? a.value : Number.NaN;
    };
    const h24 = new Map(base);
    h24.set(T - 24 * H, { status: 'VALID', volume: 1 + 10 });
    const h25 = new Map(base);
    h25.set(T - 25 * H, { status: 'VALID', volume: 2 + 10 });
    expect(v(h24)).toBeGreaterThan(v(base)); // R0 up
    expect(v(h25)).not.toBe(v(base)); // R1, so μ and s
    const h745 = new Map(base);
    h745.set(T - 745 * H, { status: 'VALID', volume: 999 });
    expect(v(h745)).toBe(v(base));
  });

  it('lets valid zero-volume hours enter the sums', () => {
    const zero = hoursOf(
      (j) => (j === 3 ? 0 : 1 + (Math.floor((j - 1) / 24) % 3)),
      (j) => (j === 3 ? 'VALID_ZERO' : 'VALID'),
    );
    const got = activityShockAt(zero, T);
    expect('value' in got).toBe(true);
    expect(got).not.toEqual(
      activityShockAt(
        blocks((k) => 1 + (k % 3)),
        T,
      ),
    );
  });

  it.each([
    [
      'ACTIVITY_WINDOW_MISSING',
      hoursOf(
        () => 1,
        (j) => (j === 700 ? 'MISSING' : j === 2 ? 'INVALID' : 'VALID'),
      ),
    ],
    [
      'ACTIVITY_WINDOW_INVALID',
      hoursOf(
        () => 1,
        (j) => (j === 2 ? 'INVALID' : 'VALID'),
      ),
    ],
    [
      'ACTIVITY_BLOCK_ZERO',
      hoursOf(
        (j) => (j > 600 && j <= 624 ? 0 : 1 + (j % 5)),
        (j) => (j > 600 && j <= 624 ? 'VALID_ZERO' : 'VALID'),
      ),
    ],
    ['ACTIVITY_DISPERSION_ZERO', blocks(() => 2)],
    ['ACTIVITY_NOT_FINITE', blocks((k) => (k === 0 ? 1e308 : 1 + (k % 3)))],
  ])('is unavailable as %s, in the specification order', (reason, hours) => {
    expect(activityShockAt(hours, T)).toEqual({ unavailable: reason });
  });

  it('is missing when an hour lies outside the retrieved range', () => {
    expect(activityShockAt(new Map(), T)).toEqual({ unavailable: 'ACTIVITY_WINDOW_MISSING' });
  });
});

// ---------------------------------------------------------------------------------------------
// Dataset, coverage and #222 row parity on synthetic rows

const MEMBERS = ['AAAUSDT', 'BBBUSDT'];
const TIMES = decisionTimes();

function stageDRows(
  seed: number,
  classOf: (t: number, symbol: string, rand: () => number) => string,
) {
  const rand = mulberry32(seed);
  const rows: StageDRow[] = [];
  for (const time of TIMES) {
    for (const symbol of MEMBERS) {
      const klass = classOf(time, symbol, rand) as StageDRow['class'];
      rows.push({
        symbol,
        time,
        split: splitOf(time),
        features: FEATURES.map((_, j) => (j + 1) * 0.001 + rand() * 1e-6),
        cell: 'mid/positive',
        v: 0.01,
        outcome: { category: klass, bar: 24, gross: 0, net: 0 },
        class: klass,
        overshoot: { category: klass, bar: 24, gross: 0, net: 0 },
        orderingNet: 0,
      });
    }
  }
  return rows;
}

const flat = (status: ActivityHour['status'] = 'VALID') => {
  const map = new Map<number, ActivityHour>();
  for (let t = RULES.firstOpen; t < RULES.endExclusive; t += H) {
    const day = Math.floor((t - RULES.firstOpen) / (24 * H));
    map.set(t, { status, volume: 1 + (day % 3) });
  }
  return map;
};

describe('the joined dataset', { timeout: HEAVY }, () => {
  const stageD = stageDRows(3, () => 'TARGET').filter(
    (r) => !(r.symbol === 'BBBUSDT' && r.time === TIMES[10]),
  );
  const hoursB = flat();
  const badAt = TIMES[3000]! - 5 * H;
  hoursB.set(badAt, { status: 'INVALID', volume: null });
  const rows = buildDataset(
    MEMBERS,
    TIMES,
    stageD,
    { AAAUSDT: flat(), BBBUSDT: hoursB },
    () => 'FEATURE_WINDOW_UNAVAILABLE',
  );

  it("has one row per grid decision in #222's order, mapped to #222's rows", () => {
    expect(rows).toHaveLength(TIMES.length * 2);
    expect(rows.slice(0, 4).map((r) => [r.time, r.symbol])).toEqual([
      [TIMES[0], 'AAAUSDT'],
      [TIMES[0], 'BBBUSDT'],
      [TIMES[1], 'AAAUSDT'],
      [TIMES[1], 'BBBUSDT'],
    ]);
    const mapped = rows.filter((r) => r.stageDRow !== null);
    expect(mapped.map((r) => r.stageDRow)).toEqual(stageD.map((_, i) => i));
    expect(mapped.every((r) => r.features === stageD[r.stageDRow!]!.features)).toBe(true);
    expect(rows.every((r) => r.split === splitOf(r.time))).toBe(true);
  });

  it("gives #222's reason first, then the activity reason; no other row loses anything", () => {
    const priced = rows.find((r) => r.symbol === 'BBBUSDT' && r.time === TIMES[10])!;
    expect([priced.exclusion, priced.stageDRow, priced.features]).toEqual([
      'FEATURE_WINDOW_UNAVAILABLE',
      null,
      null,
    ]);
    const window = rows.filter((r) => r.exclusion === 'ACTIVITY_WINDOW_INVALID');
    expect(
      window.every((r) => r.symbol === 'BBBUSDT' && r.time > badAt && r.time <= badAt + 744 * H),
    ).toBe(true);
    expect(window).toHaveLength(186);
    expect(window.every((r) => r.features !== null && r.activity === null)).toBe(true);
    expect(rows.filter((r) => r.exclusion === null)).toHaveLength(rows.length - 1 - 186);
    expect(rows.filter((r) => r.exclusion === null).every((r) => Number.isFinite(r.activity))).toBe(
      true,
    );
  });

  it('round-trips through its columns', () => {
    for (const r of [rows[0]!, rows.find((x) => x.exclusion === 'FEATURE_WINDOW_UNAVAILABLE')!])
      expect(fromColumns(toColumns(r))).toEqual(r);
  });

  it('counts coverage per split over every grid decision, purged decisions apart', () => {
    const { pooled, pairs } = coverageOf(rows);
    const n = (s: Split) => TIMES.filter((t) => splitOf(t) === s).length * 2;
    expect(n('train') + n('validation') + n('test')).toBe((43_700 + 21_620 + 21_980) / 10);
    const train = pooled['train'] as { decisions: number; common: number; coverage: number };
    expect(train.decisions).toBe(n('train'));
    const all = ['train', 'validation', 'test', 'purged'].map(
      (k) => pooled[k] as { decisions: number },
    );
    expect(all.reduce((s, b) => s + b.decisions, 0)).toBe(rows.length);
    expect((pooled['purged'] as { decisions: number }).decisions).toBe(20);
    const b = pairs['BBBUSDT']!;
    const reasons = ['train', 'validation', 'test', 'purged'].reduce(
      (s, k) =>
        s + (b[k] as { exclusions: Record<string, number> }).exclusions['ACTIVITY_WINDOW_INVALID']!,
      0,
    );
    expect(reasons).toBe(186);
  });

  it('refuses #222 rows that fall off the grid', () => {
    const extra = [...stageD, { ...stageD[0]!, time: TIMES[0]! + H }];
    expect(() =>
      buildDataset(MEMBERS, TIMES, extra, {}, () => 'FEATURE_WINDOW_UNAVAILABLE'),
    ).toThrow(/off the grid/);
  });

  it('compares recomputed #222 rows exactly', () => {
    expect(stageDParity(stageD, stageD).pass).toBe(true);
    const changed = stageD.map((r, i) =>
      i === 5
        ? { ...r, features: r.features.map((f, j) => (j === 2 ? f + 1e-17 : f)) }
        : i === 9
          ? { ...r, outcome: { ...r.outcome, bar: 23 } }
          : r,
    );
    const parity = stageDParity(changed, stageD);
    expect(parity.pass).toBe(false);
    expect(parity.differing).toBe(changed[5]!.features[2] === stageD[5]!.features[2] ? 1 : 2);
    expect(parity.first).toContain('row 9');
    expect(stageDParity(stageD.slice(1), stageD).pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Scoring on synthetic probabilities (an integration check, not financial evidence)

const HIGH = [0.6, 0.2, 0.2];
const LOW = [0.2, 0.5, 0.3];
const MID = [0.4, 0.35, 0.25];

function draw(p: number[], u: number) {
  return u < p[0]! ? 'TARGET' : u < p[0]! + p[1]! ? 'STOP' : 'TIMEOUT';
}

/** Rows whose class follows a synthetic activity sign when `learnable`, with A and B forecasts. */
function scenario(options: { learnable: boolean; bOnlyIn?: string; seed?: number }) {
  const rand = mulberry32(options.seed ?? 7);
  const sign = new Map<string, boolean>();
  const stageD = stageDRows(options.seed ?? 7, (t, s) => {
    const up = rand() < 0.5;
    sign.set(`${s}|${t}`, up);
    return draw(options.learnable ? (up ? HIGH : LOW) : MID, rand());
  });
  const rows = buildDataset(
    MEMBERS,
    TIMES,
    stageD,
    { AAAUSDT: flat(), BBBUSDT: flat() },
    () => 'FEATURE_WINDOW_UNAVAILABLE',
  );
  const forecasts = (arm: 'A' | 'B', r: DatasetRow) => {
    const month = new Date(r.time).toISOString().slice(0, 7);
    const informed = arm === 'B' && (options.bOnlyIn === undefined || options.bOnlyIn === month);
    return informed ? (sign.get(`${r.symbol}|${r.time}`) ? HIGH : LOW) : MID;
  };
  const predictions = Object.fromEntries(
    EVALUATIONS.map((e) => {
      const fitRows = rows.filter(
        (r) => r.exclusion === null && r.split !== null && e.fit.includes(r.split),
      );
      const classes = Object.fromEntries(
        CLASSES.map((k) => [k, fitRows.filter((r) => r.class === k).length]),
      );
      const arm = (name: 'A' | 'B'): ArmPredictions => ({
        status: 'FITTED',
        fit: { observations: fitRows.length, classes: classes as ArmPredictions['fit']['classes'] },
        rows: rows.flatMap((r, i) =>
          r.exclusion === null && r.split === e.evaluate
            ? [[i, ...forecasts(name, r)] as [number, number, number, number]]
            : [],
        ),
      });
      return [e.id, { A: arm('A'), B: arm('B') }];
    }),
  ) as Predictions;
  return { rows, predictions };
}

describe('the frozen comparison', { timeout: HEAVY }, () => {
  it('passes the learnable example: B better in both periods and with every month left out', () => {
    const { rows, predictions } = scenario({ learnable: true });
    const result = evaluateScreen(rows, predictions);
    expect(result.conclusion.verdict).toBe('SCREEN_PASSED');
    for (const e of Object.values(result.evaluations)) {
      const m = e.metrics!;
      expect(m.brier.label).toBe('B_BETTER');
      expect(m.brier.primary.interval95!.defined).toBe(10_000);
      expect(m.brier.primary.mean!).toBeCloseTo(m.brier.B! - m.brier.A!, 12);
      expect(m.monthly.leaveOneMonthOut.allNegative).toBe(true);
      expect(m.monthly.monthsNegative).toBe(m.monthly.table.length);
      expect(e.observations).toBe(rows.filter((r) => r.split === e.evaluate).length);
      expect(m.logLoss.BminusA.mean!).toBeLessThan(0);
      expect(Object.keys(m.pairs)).toEqual(MEMBERS);
    }
    expect(result.evaluations.development.metrics!.uncertainty.positions).toBe(181);
    expect(result.evaluations.final.metrics!.uncertainty.positions).toBe(184);
  });

  it('stops on the null control, where the extra column is noise', () => {
    const { rows, predictions } = scenario({ learnable: false, seed: 9 });
    const result = evaluateScreen(rows, predictions);
    expect(result.conclusion.verdict).toBe('STOP');
    expect(Object.values(result.conclusion.labels)).toEqual(['B_WORSE', 'B_WORSE']);
  });

  it('pairs both arms on the same day orders: identical arms give exactly zero', () => {
    const { rows, predictions } = scenario({ learnable: true });
    const same = Object.fromEntries(
      Object.entries(predictions).map(([id, arms]) => [id, { A: arms.A, B: arms.A }]),
    ) as Predictions;
    const result = evaluateScreen(rows, same);
    for (const e of Object.values(result.evaluations)) {
      expect(e.metrics!.brier.primary.mean).toBe(0);
      expect(e.metrics!.brier.primary.interval95).toMatchObject({ low: 0, high: 0 });
      expect(e.metrics!.brier.label).toBe('NO_CLEAR_DIFFERENCE');
    }
    expect(result.conclusion.verdict).toBe('STOP'); // mean d >= 0 in both
  });

  it('is inconclusive when the gain sits in one month (leave-one-month-out fails)', () => {
    const { rows, predictions } = scenario({ learnable: true, bOnlyIn: '2026-01' });
    const result = evaluateScreen(rows, predictions);
    const dev = result.evaluations.development.metrics!;
    expect(dev.monthly.leaveOneMonthOut.allNegative).toBe(false);
    // Leaving January out leaves only d = 0: that is the maximum, and it is not below zero.
    expect(dev.monthly.leaveOneMonthOut.maximum).toEqual({ month: '2026-01', meanD: 0 });
    expect(dev.monthly.monthsNegative).toBe(1);
    expect(result.conclusion.verdict).toBe('INCONCLUSIVE');
  });

  it('reports both arms’ calibration against #222’s limits without gating on it', () => {
    const { rows, predictions } = scenario({ learnable: true });
    const p = evaluatePeriod(rows, EVALUATIONS[0]!, predictions.development);
    const cal = p.metrics!.probabilityCalibration as Record<
      'A' | 'B',
      Record<string, { inTheLargeLabel: string; weightedDecileErrorLabel: string; bins: unknown[] }>
    >;
    for (const arm of ['A', 'B'] as const)
      for (const k of CLASSES) {
        expect(['WITHIN', 'OUTSIDE']).toContain(cal[arm][k]!.inTheLargeLabel);
        expect(cal[arm][k]!.bins).toHaveLength(10);
      }
  });

  it('refuses probabilities that do not cover the evaluated rows or another fit set', () => {
    const { rows, predictions } = scenario({ learnable: true });
    const short = structuredClone(predictions);
    short.final.B.rows.pop();
    expect(() => evaluateScreen(rows, short)).toThrow(
      /INTEGRITY_FAILURE: probabilities do not cover/,
    );
    const other = structuredClone(predictions);
    other.development.A.fit.observations += 1;
    expect(() => evaluateScreen(rows, other)).toThrow(
      /INTEGRITY_FAILURE: an arm's fit set differs/,
    );
    const bad = structuredClone(predictions);
    bad.final.A.rows[3]![2] = Number.NaN;
    expect(() => evaluateScreen(rows, bad)).toThrow(/not finite/);
    const missing = structuredClone(predictions);
    missing.final.A.status = 'MISSING_CLASS';
    expect(() => evaluateScreen(rows, missing)).toThrow(/missing class/);
  });

  it('is insufficient evidence when coverage falls below 95% in a split', () => {
    const { rows, predictions } = scenario({ learnable: true });
    const thinned = rows.map((r, i) =>
      r.split === 'train' && i % 10 === 0
        ? { ...r, exclusion: 'ACTIVITY_WINDOW_MISSING' as const, activity: null }
        : r,
    );
    const fitTrain = thinned.filter((r) => r.exclusion === null && r.split === 'train');
    const fix = (arms: Record<'A' | 'B', ArmPredictions>, extra: DatasetRow[]) => {
      const fitRows = [...fitTrain, ...extra];
      for (const a of Object.values(arms)) {
        a.fit.observations = fitRows.length;
        a.fit.classes = Object.fromEntries(
          CLASSES.map((k) => [k, fitRows.filter((r) => r.class === k).length]),
        ) as ArmPredictions['fit']['classes'];
      }
    };
    const p = structuredClone(predictions);
    fix(p.development, []);
    fix(
      p.final,
      thinned.filter((r) => r.exclusion === null && r.split === 'validation'),
    );
    const result = evaluateScreen(thinned, p);
    expect(result.coverage.train).toBeCloseTo(0.9, 2);
    expect(result.conclusion.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.conclusion.failingFloors).toEqual(['coverage.train']);
  });
});

describe('labels and the verdict order', () => {
  const est = (mean: number | null, low: number, high: number) => ({
    observations: 3000,
    mean,
    interval95: { low, high, defined: 10_000, replicates: 10_000 },
  });

  it('labels each period from the point and the interval; a null figure fails', () => {
    expect(periodLabel(est(-0.01, -0.02, -0.001))).toBe('B_BETTER');
    expect(periodLabel(est(-0.01, -0.02, 0))).toBe('NO_CLEAR_DIFFERENCE');
    expect(periodLabel(est(0.01, 0.001, 0.02))).toBe('B_WORSE');
    expect(periodLabel(est(0.01, 0, 0.02))).toBe('NO_CLEAR_DIFFERENCE');
    expect(periodLabel({ observations: 0, mean: null, interval95: null })).toBe(
      'NO_CLEAR_DIFFERENCE',
    );
  });

  const period = (
    id: 'development' | 'final',
    mean: number,
    low: number,
    high: number,
    lomo = mean < 0,
    extra: Partial<{ observations: number; days: number; status: string; defined: number }> = {},
  ) =>
    ({
      id,
      status: extra.status ?? 'FITTED',
      observations: extra.observations ?? 3000,
      days: extra.days ?? 120,
      metrics: {
        brier: {
          primary: {
            ...est(mean, low, high),
            interval95: { low, high, defined: extra.defined ?? 10_000, replicates: 10_000 },
          },
          label: periodLabel(est(mean, low, high)),
        },
        monthly: { leaveOneMonthOut: { allNegative: lomo } },
      },
    }) as unknown as PeriodResult;
  const full = { train: 0.99, validation: 0.98, test: 0.97 };
  const verdict = (dev: PeriodResult, fin: PeriodResult, coverage = full) =>
    conclude(coverage, { development: dev, final: fin }).verdict;

  it('orders INSUFFICIENT_EVIDENCE, SCREEN_PASSED, STOP and INCONCLUSIVE as written', () => {
    const better = (id: 'development' | 'final') => period(id, -0.002, -0.003, -0.001);
    expect(verdict(better('development'), better('final'))).toBe('SCREEN_PASSED');
    expect(verdict(better('development'), better('final'), { ...full, test: 0.949 })).toBe(
      'INSUFFICIENT_EVIDENCE',
    );
    expect(
      verdict(
        period('development', -0.002, -0.003, -0.001, true, { observations: 1999 }),
        better('final'),
      ),
    ).toBe('INSUFFICIENT_EVIDENCE');
    expect(
      verdict(period('development', -0.002, -0.003, -0.001, true, { days: 89 }), better('final')),
    ).toBe('INSUFFICIENT_EVIDENCE');
    expect(
      verdict(
        period('development', -0.002, -0.003, -0.001, true, { defined: 9899 }),
        better('final'),
      ),
    ).toBe('INSUFFICIENT_EVIDENCE');
    expect(
      verdict(
        period('development', -0.002, -0.003, -0.001, true, { status: 'MISSING_CLASS' }),
        better('final'),
      ),
    ).toBe('INSUFFICIENT_EVIDENCE');
    // B worse in either period stops, even if the other passes.
    expect(verdict(better('development'), period('final', 0.002, 0.001, 0.003))).toBe('STOP');
    // Mean at or above zero in both stops.
    expect(
      verdict(period('development', 0, -0.001, 0.001), period('final', 0.0001, -0.001, 0.001)),
    ).toBe('STOP');
    // Negative means whose interval reaches zero, a failed leave-one-month-out, or opposite signs.
    expect(verdict(period('development', -0.001, -0.002, 0.0001), better('final'))).toBe(
      'INCONCLUSIVE',
    );
    expect(verdict(period('development', -0.002, -0.003, -0.001, false), better('final'))).toBe(
      'INCONCLUSIVE',
    );
    expect(verdict(period('development', 0.001, -0.001, 0.002), better('final'))).toBe(
      'INCONCLUSIVE',
    );
  });

  it('takes the largest leave-one-month-out mean, an undefined one counting as the largest', () => {
    const items = (meanD: number, month: string) => ({
      row: { time: Date.parse(`${month}-10T00:00:00.000Z`), symbol: 'A' } as DatasetRow,
      y: 0,
      A: [0.5, 0.25, 0.25] as [number, number, number],
      B: [0.5 + meanD, 0.25 - meanD, 0.25] as [number, number, number],
    });
    const m = monthly([items(0.01, '2025-12'), items(0.02, '2026-01'), items(0.03, '2026-02')]);
    // Leaving out the month with the largest gain leaves the largest (least negative) mean.
    expect(m.leaveOneMonthOut.maximum!.month).toBe('2026-02');
    expect(m.leaveOneMonthOut.allNegative).toBe(true);
    const one = monthly([items(0.01, '2025-12')]);
    expect(one.leaveOneMonthOut.maximum).toEqual({ month: '2025-12', meanD: null });
    expect(one.leaveOneMonthOut.allNegative).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Runner: write-once retrieval and validation, identity and step checks

describe('the retrieval runner', { timeout: HEAVY }, () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'activity-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function v1Dir(members: string[]) {
    const dataDir = join(root, 'v1');
    await mkdir(join(dataDir, 'klines'), { recursive: true });
    await writeFile(join(dataDir, 'universe.json'), '{}');
    for (const m of members) {
      const candles = [];
      for (let t = RULES.v1FirstOpen; t < RULES.endExclusive; t += H)
        candles.push({
          timestamp: t,
          closeTime: t + H - 1,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
        });
      await writeFile(join(dataDir, 'klines', `${m}-1h.json`), JSON.stringify({ candles }));
    }
    return dataDir;
  }

  const identity = () =>
    Promise.resolve({ codeCommit: 'c'.repeat(40), codeBlobs: { 'scripts/activityShock.ts': 'b' } });

  function liveLike(members: string[], tweak?: (url: string) => Response | undefined) {
    let clock = RULES.endExclusive + 3 * 86_400_000;
    return {
      fetchImpl: (url: string) => {
        const custom = tweak?.(url);
        if (custom) return Promise.resolve(custom);
        const p = new URL(url).searchParams;
        const body = [];
        for (let t = Number(p.get('startTime')); t <= Number(p.get('endTime')); t += H)
          body.push(kline(t));
        expect(members).toContain(p.get('symbol'));
        return Promise.resolve(fakeResponse(200, body, { 'x-mbx-used-weight-1m': '2' }));
      },
      sleep: () => Promise.resolve(),
      now: () => (clock += 1),
    };
  }

  it('retrieves once into a new directory, validates, and refuses to run again', async () => {
    const members = ['AAAUSDT', 'BBBUSDT'];
    const dataDir = await v1Dir(members);
    const outDir = join(root, 'out', 'retrieval');
    const result = await runActivityRetrieve({
      outDir,
      dataDir,
      identity,
      io: liveLike(members),
      members,
    });
    expect(result).toMatchObject({
      status: 'COMPLETE',
      requestsCounted: 38,
      rateLimitRetries: 0,
      pass: true,
    });
    expect(await readdir(join(outDir, 'raw'))).toHaveLength(38);
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.specification.sha256).toBe(specSha256());
    expect(manifest.codeCommit).toBe('c'.repeat(40));
    expect(manifest.log[0]).toMatchObject({ symbol: 'AAAUSDT', k: 0, attempt: 1, status: 200 });
    const saved = await readFile(join(outDir, 'validation.json'), 'utf8');
    const again = await computeValidation(outDir, dataDir, members);
    expect(again.content).toBe(saved); // deterministic, so the export can require equality
    expect(again.validation.total.status).toEqual({
      VALID: 2 * RULES.hoursPerPair,
      VALID_ZERO: 0,
      MISSING: 0,
      INVALID: 0,
    });
    expect(again.validation.v1DirectoryUnchanged).toBe(true);
    await expect(
      runActivityRetrieve({ outDir, dataDir, identity, io: liveLike(members), members }),
    ).rejects.toThrow(/EEXIST/);
  });

  it('keeps a stopped retrieval as RETRIEVAL_INCOMPLETE and writes no validation', async () => {
    const members = ['AAAUSDT'];
    const dataDir = await v1Dir(members);
    const outDir = join(root, 'stopped');
    const io = liveLike(members, (url) =>
      url.includes(`startTime=${RULES.firstOpen + 3 * RULES.requestSpanMs}`)
        ? fakeResponse(418, '')
        : undefined,
    );
    const result = await runActivityRetrieve({ outDir, dataDir, identity, io, members });
    expect(result).toMatchObject({ status: 'RETRIEVAL_INCOMPLETE', requests: 4 });
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('RETRIEVAL_INCOMPLETE');
    expect(manifest.stopped).toMatch(/HTTP 418/);
    expect((await readdir(outDir)).sort()).toEqual(['manifest.json', 'raw']);
  });

  it('fails validation when a saved body or v1 changes', async () => {
    const members = ['AAAUSDT'];
    const dataDir = await v1Dir(members);
    const outDir = join(root, 'r');
    await runActivityRetrieve({ outDir, dataDir, identity, io: liveLike(members), members });
    const v1File = join(dataDir, 'klines', 'AAAUSDT-1h.json');
    const v1 = JSON.parse(await readFile(v1File, 'utf8'));
    v1.candles[5].close = 100.6;
    await writeFile(v1File, JSON.stringify(v1));
    const changed = await computeValidation(outDir, dataDir, members);
    expect(changed.validation.v1DirectoryUnchanged).toBe(false);
    expect(changed.validation.ohlcParityPass).toBe(false);
    await writeFile(join(outDir, 'raw', 'AAAUSDT-03.json'), '[]');
    await expect(computeValidation(outDir, dataDir, members)).rejects.toThrow(
      /INTEGRITY_FAILURE: raw\/AAAUSDT-03.json changed/,
    );
  });
});

describe('identity and step checks', () => {
  it('refuses a dirty tree and records every study file', async () => {
    await expect(studyIdentity(() => Promise.resolve(' M scripts/x.ts'))).rejects.toThrow(
      /Tracked files differ/,
    );
    const clean = await studyIdentity((...args) =>
      Promise.resolve(args[0] === 'status' ? '' : 'abc'),
    );
    expect(Object.keys(clean.codeBlobs)).toEqual([...STUDY_FILES]);
  });

  it('refuses steps written at another commit, under another specification or dataset', () => {
    const spec = { id: SPEC.specificationId, revision: 3, sha256: 's', path: 'p', fileSha256: 'f' };
    const params = { max_iter: 100 };
    const set = { status: 'FITTED', fit: { observations: 1, classes: {}, params }, rows: [] };
    const make = () => ({
      dataset: {
        manifest: { codeCommit: 'c', specification: spec },
        columns: [...COLUMNS],
        rows: [],
        coverage: {},
        hours: {},
        parity: {},
      },
      predictions: {
        manifest: { codeCommit: 'c', specification: spec, dataset: { path: 'd', sha256: 'h' } },
        environment: {},
        evaluations: {
          development: { A: set, B: set },
          final: { A: set, B: set },
        } as unknown as Predictions,
        reproductionOfC: {},
      },
    });
    const ok = make();
    expect(() => verifySteps(ok.dataset, ok.predictions, 'c', spec, 'h', params)).not.toThrow();
    expect(() => verifySteps(ok.dataset, ok.predictions, 'x', spec, 'h', params)).toThrow(
      /written at c/,
    );
    expect(() =>
      verifySteps(ok.dataset, ok.predictions, 'c', { ...spec, fileSha256: 'g' }, 'h', params),
    ).toThrow(/another specification/);
    expect(() => verifySteps(ok.dataset, ok.predictions, 'c', spec, 'other', params)).toThrow(
      /another dataset/,
    );
    expect(() => verifySteps(ok.dataset, ok.predictions, 'c', spec, 'h', { max_iter: 99 })).toThrow(
      /parameters differ/,
    );
    const cols = make();
    cols.dataset.columns.pop();
    expect(() => verifySteps(cols.dataset, cols.predictions, 'c', spec, 'h', params)).toThrow(
      /columns differ/,
    );
  });
});

describe('validation edge cases', () => {
  it('records a non-array response and a row without an integer open time as response issues', () => {
    const [first, second, ...rest] = responses();
    const { hours, responseIssues } = validatePair([
      { ...first!, body: { code: -1 } },
      { ...second!, body: [['x'], ...(second!.body as unknown[][]).slice(1)] },
      ...rest,
    ]);
    expect(responseIssues).toEqual(
      expect.arrayContaining([
        'k=0: response is not an array',
        'k=1 row 0: open time is not an integer',
      ]),
    );
    expect(hours[0]!.status).toBe('MISSING');
    expect(hours[1000]!.status).toBe('MISSING');
    expect(hours[1001]!.status).toBe('VALID');
  });
});

describe("#222's exclusion for a decision without a #222 row", () => {
  const start = Date.parse('2025-01-01T00:00:00.000Z');
  const candles: HourCandle[] = Array.from({ length: 400 }, (_, i) => {
    const open = 100 + Math.sin(i / 5);
    const close = 100 + Math.sin((i + 1) / 5);
    const t = start + i * H;
    return {
      timestamp: t,
      closeTime: t + H - 1,
      open,
      close,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
    };
  });
  const cutoff = Date.parse(PROTOCOL.data.collectionCutoff);

  it("gives #222's first reason, and refuses an observation #222 should have had", () => {
    expect(priceExclusionAt(indexHourly([], cutoff), start + 300 * H)).toBe(
      'FEATURE_WINDOW_UNAVAILABLE',
    );
    expect(() => priceExclusionAt(indexHourly(candles, cutoff), start + 300 * H)).toThrow(
      /missing from #222's rows/,
    );
  });
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const fakeIdentity = (commit: string) => () =>
  Promise.resolve({ codeCommit: commit, codeBlobs: { 'scripts/activityShock.ts': 'b' } });

describe('the export refuses a retrieval it cannot trust', { timeout: HEAVY }, () => {
  const commit = 'c'.repeat(40);
  const members = PROTOCOL.universe.members;
  let root: string;
  let base: string;
  let dataDir: string;

  /** A synthetic 20-pair retrieval whose every response is empty, against empty v1 files. */
  async function retrieval(dir: string, v1: string, firstCandles: unknown[] = []) {
    await mkdir(join(v1, 'klines'), { recursive: true });
    await writeFile(join(v1, 'universe.json'), '{}');
    for (const [i, m] of members.entries()) {
      const candles = i === 0 ? firstCandles : [];
      await writeFile(join(v1, 'klines', `${m}-1h.json`), JSON.stringify({ candles }));
    }
    let clock = RULES.endExclusive + 86_400_000;
    const io = {
      fetchImpl: () => Promise.resolve(fakeResponse(200, [])),
      sleep: () => Promise.resolve(),
      now: () => (clock += 1),
    };
    return runActivityRetrieve({ outDir: dir, dataDir: v1, identity: fakeIdentity(commit), io });
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'activity-export-'));
    base = join(root, 'base');
    dataDir = join(root, 'v1');
    expect(await retrieval(base, dataDir)).toMatchObject({
      status: 'COMPLETE',
      requestsCounted: 380,
      pass: true,
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function variant(name: string, edit: (dir: string) => Promise<void>) {
    const dir = join(root, name);
    await cp(base, dir, { recursive: true });
    await edit(dir);
    return dir;
  }
  const editManifest = (dir: string, change: (m: Record<string, unknown>) => void) =>
    readFile(join(dir, 'manifest.json'), 'utf8').then((text) => {
      const m = JSON.parse(text) as Record<string, unknown>;
      change(m);
      return writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
    });
  const exportFrom = (retrievalDir: string, data = dataDir, at = commit) =>
    runActivityExport({
      retrievalDir,
      dataDir: data,
      outputDir: join(root, 'out'),
      identity: fakeIdentity(at),
    });

  it('written at another commit', async () => {
    await expect(exportFrom(base, dataDir, 'd'.repeat(40))).rejects.toThrow(
      /INTEGRITY_FAILURE: the retrieval was written at c{40}/,
    );
  });

  it('under another specification', async () => {
    const dir = await variant('spec', (d) =>
      editManifest(d, (m) => {
        (m['specification'] as Record<string, unknown>)['fileSha256'] = 'other';
      }),
    );
    await expect(exportFrom(dir)).rejects.toThrow(/another specification/);
  });

  it('that stopped early', async () => {
    const dir = await variant('stopped', (d) =>
      editManifest(d, (m) => {
        m['status'] = 'RETRIEVAL_INCOMPLETE';
      }),
    );
    await expect(exportFrom(dir)).rejects.toThrow(/the retrieval is incomplete/);
  });

  it('whose saved validation differs from a recomputation', async () => {
    const dir = await variant('validation', (d) =>
      readFile(join(d, 'validation.json'), 'utf8').then((t) =>
        writeFile(join(d, 'validation.json'), `${t} `),
      ),
    );
    await expect(exportFrom(dir)).rejects.toThrow(/validation.json differs/);
  });

  it("when v1's directory changed during the retrieval", async () => {
    const v1 = join(root, 'v1-changed');
    await cp(dataDir, v1, { recursive: true });
    const dir = await variant('v1-changed', async (d) => {
      await writeFile(join(v1, 'universe.json'), '{"changed":true}');
      await writeFile(join(d, 'validation.json'), (await computeValidation(d, v1)).content);
    });
    await expect(exportFrom(dir, v1)).rejects.toThrow(/v1's directory changed/);
  });

  it('without exact OHLC and presence parity', async () => {
    const t = RULES.v1FirstOpen;
    const candle = { timestamp: t, closeTime: t + H - 1, open: 1, high: 1, low: 1, close: 1 };
    const v1 = join(root, 'v1-parity');
    const dir = join(root, 'parity');
    expect(await retrieval(dir, v1, [candle])).toMatchObject({ status: 'COMPLETE', pass: false });
    await expect(exportFrom(dir, v1)).rejects.toThrow(/OHLC parity with v1 failed/);
  });

  it("then requires v1's recorded inputs, which this synthetic directory is not", async () => {
    await expect(exportFrom(base)).rejects.toThrow();
  });
});

describe('the evaluate step', { timeout: HEAVY }, () => {
  let out: string;
  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), 'activity-evaluate-'));
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('scores the dataset and probabilities of its own commit once, then reports UNCHANGED', async () => {
    const commit = 'e'.repeat(40);
    const spec = await specification();
    const { rows, predictions } = scenario({ learnable: true });
    const { note: _note, ...params } = stageDSpec.forecasters.C.verifiedParams;
    for (const arms of Object.values(predictions))
      for (const arm of Object.values(arms)) arm.fit['params'] = params;
    const prefix = `spot-24h-activity-shock-increment-dev-v1`;
    const dataset = JSON.stringify({
      manifest: { codeCommit: commit, specification: spec },
      columns: COLUMNS,
      rows: rows.map(toColumns),
      coverage: {},
      hours: {},
      parity: {},
    });
    const datasetPath = join(
      out,
      `${prefix}-dataset-${spec.sha256.slice(0, 12)}-${commit.slice(0, 12)}.json`,
    );
    await writeFile(datasetPath, dataset);
    const identity = fakeIdentity(commit);
    await expect(runActivityEvaluate(out, identity)).rejects.toThrow(
      /expected one predictions file/,
    );
    await writeFile(
      join(out, `${prefix}-predictions-${spec.sha256.slice(0, 12)}-${commit.slice(0, 12)}.json`),
      JSON.stringify({
        manifest: {
          codeCommit: commit,
          specification: spec,
          dataset: { path: datasetPath, sha256: sha(dataset) },
        },
        environment: { python: 'synthetic' },
        evaluations: predictions,
        reproductionOfC: { development: { status: 'PASS' } },
      }),
    );
    const first = await runActivityEvaluate(out, identity);
    expect(first.status).toBe('CREATED');
    expect(first.summary.verdict).toBe('SCREEN_PASSED');
    expect(first.summary.evaluations['development']!.BminusA!.defined).toBe(10_000);
    expect(first.summary.evaluations['final']!.leaveOneMonthOutMaximum).not.toBeNull();
    const written = JSON.parse(await readFile(first.path, 'utf8'));
    expect(written.manifest.dataset.sha256).toBe(sha(dataset));
    expect(written.reproductionOfC).toEqual({ development: { status: 'PASS' } });
    expect(first.path).toBe(join(out, `${prefix}-${spec.sha256.slice(0, 12)}.json`));
    expect((await runActivityEvaluate(out, identity)).status).toBe('UNCHANGED');
    await expect(runActivityEvaluate(out, fakeIdentity('f'.repeat(40)))).rejects.toThrow(
      /expected one dataset file/,
    );
  });
});
