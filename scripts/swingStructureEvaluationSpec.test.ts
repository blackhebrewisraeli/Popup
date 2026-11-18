import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/candleValidation';
import { TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION } from '@/lib/marketScanner';
import { TRADINGVIEW_DEV_PROVIDER_ID } from '@/lib/tradingViewDevScan';
import { stableSerialize } from './evaluationStore';
import { SWING_STRUCTURE_CANDIDATE_ID, SWING_STRUCTURE_CANDIDATE_VERSION } from './swingStructure';
import { CRYPTO_TRADINGVIEW_SYMBOLS } from './tradingViewImport';

/**
 * Structural checks of the proposed evaluation contract: its identity, its agreement with the
 * code and data identities it names, and the date arithmetic it states. Nothing here runs the
 * candidate or reads market data.
 */
interface EvaluationSpecification {
  specificationId: string;
  candidate: { id: string; version: string };
  data: {
    provider: string;
    candlePolicy: string;
    export: { file: string; sha256: string; retrievalStartedAt: string };
    inputHashes: Record<string, string>;
    bars: { firstBar: string; lastClosedBar: string };
  };
  universe: { members: Record<string, string> };
  timeframe: { intervalMs: number };
  window: { closedCandles: number };
  observations: {
    daily: { first: string; last: string; count: number };
    primaryGrid: { spacingDays: number; count: number; dates: string[] };
    phaseGrids: { count: number };
  };
  configurations: { id: string; leftBars: number; rightBars: number; role: string }[];
  horizons: { utcDays: number[]; primary: number };
  primary: { configuration: string; horizonUtcDays: number };
  baseline: { excludedPrecedingGridSteps: Record<string, number> };
  uncertainty: {
    blockLengths: { primary: number; longer: number };
    replicates: number;
    random: { seed: string; drawMessage: string; testVectors: Record<string, number[]> };
    intervalHorizons: number[];
    descriptiveOnlyHorizons: number[];
  };
}

const day = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const load = async <T>(path: string) => JSON.parse(await readFile(path, 'utf8')) as T;
const specification = () =>
  load<EvaluationSpecification>('docs/swing-structure-evaluation.v1.json');

describe('swing-structure evaluation specification v1', () => {
  it('declares the hash of its own content as its identity', async () => {
    const { specificationId, ...content } = await specification();
    expect(createHash('sha256').update(stableSerialize(content)).digest('hex')).toBe(
      specificationId,
    );
  });

  it('names the published candidate and the existing crypto data conventions', async () => {
    const spec = await specification();
    expect(spec.candidate).toMatchObject({
      id: SWING_STRUCTURE_CANDIDATE_ID,
      version: SWING_STRUCTURE_CANDIDATE_VERSION,
    });
    expect(spec.data.provider).toBe(TRADINGVIEW_DEV_PROVIDER_ID);
    expect(spec.data.candlePolicy).toBe(TRADINGVIEW_CRYPTO_DAILY_POLICY_VERSION);
    expect(spec.timeframe.intervalMs).toBe(DAY_MS);
  });

  it('takes the first five crypto-usdt-v1 members and the identities already recorded for them', async () => {
    const spec = await specification();
    const firstFive = Object.entries(CRYPTO_TRADINGVIEW_SYMBOLS).slice(0, 5);
    expect(spec.universe.members).toEqual(Object.fromEntries(firstFive));

    const recorded = await load<{
      data: {
        export: string;
        exportSha256: string;
        retrieval: { startedAt: string };
        inputHashes: Record<string, string>;
      };
    }>('docs/scanner-research-crypto.v1.json');
    expect(spec.data.export.file.endsWith(`/${recorded.data.export}`)).toBe(true);
    expect(spec.data.export.sha256).toBe(recorded.data.exportSha256);
    expect(spec.data.export.retrievalStartedAt).toBe(recorded.data.retrieval.startedAt);
    const { rule: _rule, ...hashes } = spec.data.inputHashes;
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(spec.universe.members).sort());
    for (const [ticker, hash] of Object.entries(hashes)) {
      expect(hash).toBe(recorded.data.inputHashes[ticker]);
    }
  });

  it('fits every window and outcome inside the closed bars of the export', async () => {
    const { data, window, observations, horizons } = await specification();
    const maxHorizon = Math.max(...horizons.utcDays);
    const { daily } = observations;
    expect(day(daily.first)).toBe(day(data.bars.firstBar) + (window.closedCandles - 1) * DAY_MS);
    expect(day(daily.last)).toBe(day(data.bars.lastClosedBar) - (maxHorizon + 1) * DAY_MS);
    expect((day(daily.last) - day(daily.first)) / DAY_MS + 1).toBe(daily.count);
    // The last bar used must have closed before the retrieval started.
    expect(day(data.bars.lastClosedBar) + DAY_MS - 1).toBeLessThan(
      Date.parse(data.export.retrievalStartedAt),
    );
  });

  it('spaces the primary grid by the primary horizon, so its primary windows never overlap', async () => {
    const { observations, horizons, primary } = await specification();
    const { primaryGrid, phaseGrids, daily } = observations;
    expect(primaryGrid.spacingDays).toBe(horizons.primary);
    expect(phaseGrids.count).toBe(primaryGrid.spacingDays);
    const expected: string[] = [];
    for (let t = day(daily.first); t <= day(daily.last); t += primaryGrid.spacingDays * DAY_MS) {
      expected.push(iso(t));
    }
    expect(primaryGrid.dates).toEqual(expected);
    expect(primaryGrid.count).toBe(expected.length);
    expect(primary.horizonUtcDays).toBe(horizons.primary);
    expect(horizons.utcDays).toContain(horizons.primary);
  });

  it('has exactly one primary configuration among distinct, valid bar counts', async () => {
    const { configurations, primary } = await specification();
    expect(configurations.filter((c) => c.role === 'primary').map((c) => c.id)).toEqual([
      primary.configuration,
    ]);
    expect(configurations.every((c) => c.role === 'primary' || c.role === 'exploratory')).toBe(
      true,
    );
    for (const { id, leftBars, rightBars } of configurations) {
      expect(Number.isSafeInteger(leftBars) && leftBars >= 1).toBe(true);
      expect(Number.isSafeInteger(rightBars) && rightBars >= 1).toBe(true);
      expect(id).toBe(`L${leftBars}R${rightBars}`);
    }
    const pairs = configurations.map((c) => `${c.leftBars}/${c.rightBars}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('leaves out exactly the earlier grid windows that overlap an observation input', async () => {
    const { baseline, window, observations, horizons } = await specification();
    const { dates, spacingDays } = observations.primaryGrid;
    const mid = day(dates[19]!);
    for (const h of horizons.utcDays) {
      // Eligible earlier window: its path ends (open of D'+1+h) no later than the input's first open.
      const overlapping = dates
        .map(day)
        .filter((d) => d < mid && d + (1 + h) * DAY_MS > mid - (window.closedCandles - 1) * DAY_MS);
      expect(overlapping.length).toBe(baseline.excludedPrecedingGridSteps[String(h)]);
      expect(overlapping.length).toBe(Math.ceil((h + window.closedCandles) / spacingDays) - 1);
    }
  });

  it('gives intervals only where one member never has overlapping outcome windows', async () => {
    const { uncertainty, horizons, observations } = await specification();
    const { intervalHorizons, descriptiveOnlyHorizons } = uncertainty;
    expect([...intervalHorizons, ...descriptiveOnlyHorizons].sort((a, b) => a - b)).toEqual(
      horizons.utcDays,
    );
    expect(intervalHorizons).toContain(horizons.primary);
    const spacing = observations.primaryGrid.spacingDays;
    expect(intervalHorizons.every((h) => h <= spacing)).toBe(true);
    expect(descriptiveOnlyHorizons.every((h) => h > spacing)).toBe(true);
  });

  it('reproduces its block-bootstrap draws from the stated seed, message and rejection rule', async () => {
    const { uncertainty, observations } = await specification();
    const positions = observations.primaryGrid.count;
    const { primary, longer } = uncertainty.blockLengths;
    expect(primary).toBe(Math.ceil(Math.cbrt(positions)));
    expect(longer).toBeGreaterThan(primary);

    // A synthetic re-derivation of the stated sampler, not the runner: starts of the moving blocks.
    const starts = (grid: string, ell: number, replicate: number) => {
      const blocks = positions + 1 - ell;
      const limit = Math.floor(2 ** 32 / blocks) * blocks;
      return Array.from({ length: Math.ceil(positions / ell) }, (_, index) => {
        for (let attempt = 0; ; attempt++) {
          const message = uncertainty.random.drawMessage
            .replace('{seed}', uncertainty.random.seed)
            .replace('{grid}', grid)
            .replace('{blockLength}', String(ell))
            .replace('{replicate}', String(replicate))
            .replace('{draw}', String(index + 1))
            .replace('{attempt}', String(attempt));
          const x = createHash('sha256').update(message, 'utf8').digest().readUInt32BE(0);
          if (x < limit) return x % blocks;
        }
      });
    };
    const vectors = uncertainty.random.testVectors;
    expect(Object.keys(vectors).sort()).toEqual(['G0-L4-r1', 'G0-L4-r10000', 'G0-L8-r1']);
    expect(starts('G0', primary, 1)).toEqual(vectors['G0-L4-r1']);
    expect(starts('G0', primary, uncertainty.replicates)).toEqual(vectors['G0-L4-r10000']);
    expect(starts('G0', longer, 1)).toEqual(vectors['G0-L8-r1']);
    for (const ell of [primary, longer]) {
      // At least four blocks per replicate, none starting past the last full block: no wrap-around.
      const drawn = starts('G0', ell, 1);
      expect(drawn.length).toBeGreaterThanOrEqual(4);
      expect(Math.max(...drawn)).toBeLessThanOrEqual(positions - ell);
    }
  });
});
