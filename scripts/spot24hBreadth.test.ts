import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  PROTOCOL,
  indexHourly,
  netReturn,
  splitOf,
  type Category,
  type HourCandle,
} from './spot24h';
import {
  analyse,
  breadthAt,
  compareStates,
  daySums,
  replicateStatistics,
  SPEC,
  type Breadth,
  type BreadthState,
  type Spec,
  type StatedRow,
} from './spot24hBreadth';
import { filterIdentity, verifyDiagnostic, verifyFile } from './spot24hBreadthRun';
import type { Git } from './spot24hDiagnosticRun';

/** mulberry32: exact 32-bit arithmetic, so successive draws are independent. */
function random32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const MEMBERS = Array.from({ length: 20 }, (_, i) => `P${String(i).padStart(2, '0')}USDT`);
const T = Date.parse('2026-01-10T12:00:00.000Z');
const CUTOFF = Date.parse(PROTOCOL.data.collectionCutoff);

const candle = (timestamp: number, close: number): HourCandle => ({
  timestamp,
  closeTime: timestamp + PROTOCOL.data.closeOffsetMs,
  open: close,
  high: close,
  low: close,
  close,
});

const validOf = (candles: Record<string, HourCandle[]>) =>
  Object.fromEntries(
    Object.entries(candles).map(([symbol, list]) => [symbol, indexHourly(list, CUTOFF).valid]),
  );

/**
 * Hourly candles from T − 48h to T + 24h. The first `up` members close 100 at T − 25h and 101 at
 * T − 1h, the next `flat` close 100 at both, the rest 99 at T − 1h. The hours next to each input,
 * the candle opening at T included, would flip every member's sign if read in its place.
 */
function market(up: number, flat = 0) {
  return Object.fromEntries(
    MEMBERS.map((symbol, i) => {
      const sign = i < up ? 1 : i < up + flat ? 0 : -1;
      const list: HourCandle[] = [];
      for (let time = T - 48 * HOUR_MS; time <= T + 24 * HOUR_MS; time += HOUR_MS) {
        const hour = (time - T) / HOUR_MS;
        let close = 100;
        if (hour === -25) close = 100;
        else if (hour === -1) close = 100 + sign;
        else if (hour === -26 || hour === -24) close = 100 * 2 ** sign;
        else if (hour === -2 || hour === 0) close = 100 * 2 ** -sign;
        list.push(candle(time, close));
      }
      return [symbol, list];
    }),
  );
}

describe('breadthAt', () => {
  it('reads exactly the candles opening at T − 1h and T − 25h', () => {
    const candles = market(11);
    expect(breadthAt(MEMBERS, validOf(candles), T)).toEqual({
      state: 'PERMITTED',
      positive: 11,
      breadth: 0.55,
      missing: [],
    });
    const changeAt = (offsetHours: number, close: number) =>
      breadthAt(
        MEMBERS,
        validOf({
          ...candles,
          P00USDT: candles['P00USDT']!.map((c) =>
            c.timestamp === T + offsetHours * HOUR_MS ? candle(c.timestamp, close) : c,
          ),
        }),
        T,
      ).positive;
    // Neighbours of both inputs, and the candle opening at T, change nothing even when extreme.
    for (const offset of [-26, -24]) expect(changeAt(offset, 1000)).toBe(11);
    for (const offset of [-2, 0]) expect(changeAt(offset, 1)).toBe(11);
    // Each input does.
    expect(changeAt(-25, 1000)).toBe(10);
    expect(changeAt(-1, 1)).toBe(10);
  });

  it('excludes exactly half, permits one more, and never counts a zero return as positive', () => {
    expect(breadthAt(MEMBERS, validOf(market(10)), T)).toMatchObject({
      state: 'EXCLUDED',
      positive: 10,
      breadth: 0.5,
    });
    expect(breadthAt(MEMBERS, validOf(market(11)), T).state).toBe('PERMITTED');
    expect(breadthAt(MEMBERS, validOf(market(10, 1)), T)).toMatchObject({
      state: 'EXCLUDED',
      positive: 10,
    });
    expect(breadthAt(MEMBERS, validOf(market(11, 9)), T).state).toBe('PERMITTED');
    expect(breadthAt(MEMBERS, validOf(market(0, 20)), T)).toMatchObject({
      state: 'EXCLUDED',
      positive: 0,
    });
  });

  it('makes the state unavailable for a missing or invalid input instead of shrinking the denominator', () => {
    // 11 of 20 rise; without P19 that would read 11 of 19.
    const candles = market(11);
    const without = (offset: number) =>
      candles['P19USDT']!.filter((c) => c.timestamp !== T + offset * HOUR_MS);
    const unavailable = {
      state: 'UNAVAILABLE',
      positive: null,
      breadth: null,
      missing: ['P19USDT'],
    };
    expect(breadthAt(MEMBERS, validOf({ ...candles, P19USDT: without(-25) }), T)).toEqual(
      unavailable,
    );
    expect(breadthAt(MEMBERS, validOf({ ...candles, P19USDT: without(-1) }), T)).toEqual(
      unavailable,
    );
    // v1's validity: both copies of a duplicate are refused, and so is an invalid price.
    const duplicate = [...candles['P19USDT']!, candle(T - HOUR_MS, 99)];
    expect(breadthAt(MEMBERS, validOf({ ...candles, P19USDT: duplicate }), T)).toEqual(unavailable);
    const invalid = candles['P19USDT']!.map((c) =>
      c.timestamp === T - 25 * HOUR_MS ? { ...c, close: Number.NaN } : c,
    );
    expect(breadthAt(MEMBERS, validOf({ ...candles, P19USDT: invalid }), T)).toEqual(unavailable);
    // A member with no candles at all.
    const { P19USDT: _absent, ...rest } = validOf(candles);
    expect(breadthAt(MEMBERS, rest, T)).toEqual(unavailable);
  });

  it('gives the same state at every T for any change to candles opening at or after T', () => {
    const next = random32(20261122);
    const start = Date.parse('2026-02-01T00:00:00.000Z');
    const hours = 24 * 12;
    const walk = () => {
      let close = 100;
      return Array.from({ length: hours }, (_, h) => {
        close *= Math.exp((next() - 0.5) * 0.02);
        return candle(start + h * HOUR_MS, close);
      });
    };
    const candles = Object.fromEntries(MEMBERS.map((symbol) => [symbol, walk()]));
    const grid = Array.from(
      { length: (hours - 28) / 4 },
      (_, k) => start + 28 * HOUR_MS + k * 4 * HOUR_MS,
    );
    const statesOf = (c: Record<string, HourCandle[]>) => {
      const valid = validOf(c);
      return grid.map((time) => breadthAt(MEMBERS, valid, time));
    };
    const original = statesOf(candles);
    const seen = new Set(original.map((b) => b.state));
    expect(seen).toEqual(new Set<BreadthState>(['PERMITTED', 'EXCLUDED']));

    for (const cut of [grid[5]!, grid[20]!, grid[40]!]) {
      const future = (change: (c: HourCandle) => HourCandle[]) =>
        Object.fromEntries(
          Object.entries(candles).map(([symbol, list]) => [
            symbol,
            list.flatMap((c) => (c.timestamp >= cut ? change(c) : [c])),
          ]),
        );
      const variants = [
        future(() => []),
        future((c) => [candle(c.timestamp, c.close * (0.5 + next()))]),
        future((c) => [c, candle(c.timestamp, 1)]),
        future((c) => [{ ...c, close: Number.NaN }]),
      ];
      const upTo = grid.findIndex((time) => time > cut);
      let changedLater = false;
      for (const variant of variants) {
        const states = statesOf(variant);
        expect(states.slice(0, upTo)).toEqual(original.slice(0, upTo));
        changedLater ||=
          JSON.stringify(states.slice(upTo)) !== JSON.stringify(original.slice(upTo));
      }
      // The variants do reach later states, so the equality above is not vacuous.
      expect(changedLater).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Rows with a given state and the same fill in every scenario

const breadthOf = (state: BreadthState): Breadth => ({
  state,
  positive: state === 'UNAVAILABLE' ? null : state === 'PERMITTED' ? 15 : 5,
  breadth: state === 'UNAVAILABLE' ? null : state === 'PERMITTED' ? 0.75 : 0.25,
  missing: state === 'UNAVAILABLE' ? ['P19USDT'] : [],
});

function stated(state: BreadthState, exit: number, time = T, category?: Category): StatedRow {
  const c = category ?? (exit > 1 ? 'TARGET' : 'STOP');
  const outcome = { category: c, exit, net: netReturn(1, exit, c) };
  return {
    symbol: 'AAAUSDT',
    time,
    day: Math.floor(time / DAY_MS),
    cell: 'mid/positive',
    v: 0.01,
    entry: 1,
    holdClose: exit,
    outcomes: PROTOCOL.scenarios.map(() => outcome),
    split: splitOf(time),
    breadth: breadthOf(state),
  };
}

describe('compareStates', () => {
  it('counts unavailable observations in all and in coverage, never in either state', () => {
    const rows = [
      stated('PERMITTED', 1.02),
      stated('PERMITTED', 0.98, T + 4 * HOUR_MS),
      stated('EXCLUDED', 0.97),
      stated('UNAVAILABLE', 1.5, T + DAY_MS),
    ];
    const c = compareStates(rows, 0);
    expect([c.permitted.observations, c.excluded.observations, c.unavailable.observations]).toEqual(
      [2, 1, 1],
    );
    expect(c.all.observations).toBe(4);
    expect([c.permitted.coverage, c.excluded.coverage, c.unavailable.coverage]).toEqual([
      0.5, 0.25, 0.25,
    ]);
    expect([c.permitted.days, c.unavailable.days, c.all.days]).toEqual([1, 1, 2]);
    expect(c.permitted.meanGross).toBeCloseTo(0, 12);
    expect(c.permitted.rates).toMatchObject({ TARGET: 0.5, STOP: 0.5, TIMEOUT: 0, AMBIGUOUS: 0 });
    expect(c.permittedMinusExcluded.meanGross).toBeCloseTo(0.03, 12);
    // The unavailable +50% row moves all, and only all.
    expect(c.all.meanGross).toBeCloseTo((0.02 - 0.02 - 0.03 + 0.5) / 4, 12);
    expect(c.permittedMinusAll.meanGross).toBeCloseTo(-(0.47 / 4), 12);
  });
});

describe('day-block bootstrap', () => {
  it('resamples whole days: every row of a drawn day moves with it', () => {
    const day0 = Math.floor(T / DAY_MS);
    const rows = [
      stated('PERMITTED', 1.01),
      stated('PERMITTED', 1.03, T + 4 * HOUR_MS),
      stated('EXCLUDED', 0.99),
      stated('PERMITTED', 0.95, T + DAY_MS),
      stated('EXCLUDED', 1.04, T + 2 * DAY_MS),
      stated('UNAVAILABLE', 2, T + 2 * DAY_MS),
    ];
    const days = daySums({ name: 'x', rows, firstDay: day0, positions: 3 }, 0);
    const direct = (order: number[]) => {
      const drawn = order.flatMap((i) => rows.filter((row) => row.day === day0 + i));
      const c = compareStates(drawn, 0);
      return {
        permittedMeanNet: c.permitted.observations ? c.permitted.meanNet : null,
        grossDifference: c.permittedMinusExcluded.meanGross,
      };
    };
    for (const order of [
      [0, 1, 2],
      [0, 0, 0],
      [2, 2, 1],
      [1, 1, 1],
    ]) {
      const got = replicateStatistics(days, order);
      const want = direct(order);
      for (const key of ['permittedMeanNet', 'grossDifference'] as const) {
        if (want[key] === null) expect(got[key]).toBeNull();
        else expect(got[key]).toBeCloseTo(want[key]!, 12);
      }
    }
    // Day 1 alone has no excluded row, so the difference is undefined there.
    expect(replicateStatistics(days, [1, 1, 1]).grossDifference).toBeNull();
    expect(() => daySums({ name: 'x', rows, firstDay: day0 + 1, positions: 2 }, 0)).toThrow(
      /outside the set/,
    );
  });
});

describe('verdict', () => {
  const FAST: Spec = { ...SPEC, uncertainty: { ...SPEC.uncertainty, replicates: 25 } };
  const first = Date.parse(PROTOCOL.decisions.firstDecision);

  /** Every grid decision of v1: permitted at 00–08 UTC, excluded at 12–20 UTC. */
  function history(permittedExit: number, excludedExit: number, permittedDays = Infinity) {
    const rows: StatedRow[] = [];
    for (let time = first; time + DAY_MS <= CUTOFF; time += 4 * HOUR_MS) {
      const hour = new Date(time).getUTCHours();
      const permitted = hour < 12 && (time - first) / DAY_MS < permittedDays;
      const exit = permitted ? permittedExit : excludedExit;
      const category: Category = exit >= 1.02 ? 'TARGET' : exit <= 0.98 ? 'STOP' : 'TIMEOUT';
      rows.push(stated(permitted ? 'PERMITTED' : 'EXCLUDED', exit, time, category));
    }
    return rows;
  }
  const verdict = (rows: StatedRow[]) =>
    analyse(rows, PROTOCOL.scenarios, MEMBERS.length, FAST).decision;

  it('merits validation only when permitted decisions separate and make money in every scenario', () => {
    const decision = verdict(history(1.02, 0.98));
    expect(decision.verdict).toBe('MERITS_SEPARATE_VALIDATION');
    expect(decision.scenarios).toHaveLength(6);
  });

  it('tells an improvement that still loses money from one that makes money', () => {
    const decision = verdict(history(1.001, 0.98));
    expect(decision.verdict).toBe('IMPROVES_BUT_LOSES_MONEY');
    expect(decision.scenarios.every((s) => s.netReturn === false)).toBe(true);
    expect(decision.scenarios.every((s) => Object.values(s.separation).every(Boolean))).toBe(true);
  });

  it('finds no consistent separation when permitted does worse', () => {
    const decision = verdict(history(0.98, 1.02));
    expect(decision.verdict).toBe('NO_CONSISTENT_SEPARATION');
    expect(decision.scenarios[0]!.separation).toEqual({
      periods: false,
      bound: false,
      months: false,
    });
  });

  it('refuses to judge with too few permitted observations in a period', () => {
    const result = analyse(history(1.02, 0.98, 40), PROTOCOL.scenarios, MEMBERS.length, FAST);
    expect(result.decision.verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.periods.validation[0]!.permitted.observations).toBe(0);
    expect(result.states.train.PERMITTED).toBeGreaterThan(0);
  });
});

describe('runner identity', () => {
  it('refuses to run while a tracked file differs from HEAD, and records blobs otherwise', async () => {
    const dirty: Git = async (...args) =>
      args[0] === 'status' ? ' M scripts/spot24hBreadth.ts' : 'x';
    await expect(filterIdentity(dirty)).rejects.toThrow(/commit before running/);
    const clean: Git = async (...args) =>
      args[0] === 'status' ? '' : args[0] === 'rev-parse' ? 'abc' : `blob:${args[1]}`;
    const identity = await filterIdentity(clean);
    expect(identity.filterCommit).toBe('abc');
    expect(identity.filterBlobs['docs/spot-24h-breadth-filter.json']).toBe(
      'blob:docs/spot-24h-breadth-filter.json',
    );
  });

  it('refuses a saved file whose bytes differ, and a diagnosis that did not reconcile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spot24h-breadth-'));
    const path = join(dir, 'diagnostic.json');
    const write = async (pass: boolean) => {
      const content = JSON.stringify({ reconciliation: { pass, observations: 87_500 } });
      await writeFile(path, content);
      return createHash('sha256').update(content).digest('hex');
    };
    const good = await write(true);
    await expect(verifyDiagnostic({ ...SPEC.basis.diagnostic, path, sha256: good })).resolves.toBe(
      87_500,
    );
    await expect(verifyFile(path, '0'.repeat(64))).rejects.toThrow(/is not/);
    const failed = await write(false);
    await expect(
      verifyDiagnostic({ ...SPEC.basis.diagnostic, path, sha256: failed }),
    ).rejects.toThrow(/did not pass/);
  });
});
