// @vitest-environment node

import type { BinaryToTextEncoding } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stableSerialize } from '@/lib/stableSerialize';
import { SwingStructureEvaluationRefusal } from './swingStructureEvaluation';
import {
  runSwingStructureEvaluation,
  SwingStructureRunRefusal,
} from './swingStructureEvaluationRun';
import { CRYPTO_TRADINGVIEW_SYMBOLS, tradingViewCryptoCandles } from './tradingViewImport';

/**
 * Every export, bar and price below is synthetic. Nothing reads the real export, a scan, a market
 * outcome or an experiment record, and every result is written under a temporary directory.
 *
 * A synthetic export cannot hash to the frozen identities, so `mocks.translate` presents the
 * digests of these fixtures (and only those) as the frozen ones, as if the fixture were the
 * frozen file. The runner itself has no way to accept other identities: no option, parameter or
 * flag. Analysis is a stub unless a test restores the real one.
 */
const mocks = vi.hoisted(() => ({
  translate: new Map<string, string>(),
  /** Bytes, or an error, that reading a path returns instead of its real content. */
  overrides: new Map<string, Buffer | Error>(),
  reads: [] as string[],
  writes: [] as string[],
  git: vi.fn(),
  evaluate: vi.fn(),
  /** The committed symbol map the runner reads, as a copy a test may change. */
  symbols: {} as Record<string, string>,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const createHash = ((...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args);
    const digest = hash.digest.bind(hash);
    hash.digest = ((encoding?: BinaryToTextEncoding) => {
      const out = encoding === undefined ? digest() : digest(encoding);
      return typeof out === 'string' ? (mocks.translate.get(out) ?? out) : out;
    }) as typeof hash.digest;
    return hash;
  }) as typeof actual.createHash;
  return { ...actual, default: { ...actual, createHash }, createHash };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((path: string, ...rest: unknown[]) => {
    mocks.reads.push(String(path));
    const override = mocks.overrides.get(String(path));
    if (override instanceof Error) return Promise.reject(override);
    if (override) return Promise.resolve(override);
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof actual.readFile;
  const writeFile = ((path: string, ...rest: unknown[]) => {
    mocks.writes.push(String(path));
    return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
  }) as typeof actual.writeFile;
  const mkdir = ((path: string, ...rest: unknown[]) => {
    mocks.writes.push(String(path));
    return (actual.mkdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
  }) as typeof actual.mkdir;
  return {
    ...actual,
    default: { ...actual, readFile, writeFile, mkdir },
    readFile,
    writeFile,
    mkdir,
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(() => undefined, { [promisify.custom]: mocks.git }) };
});

vi.mock('./tradingViewImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tradingViewImport')>();
  Object.assign(mocks.symbols, actual.CRYPTO_TRADINGVIEW_SYMBOLS);
  return { ...actual, CRYPTO_TRADINGVIEW_SYMBOLS: mocks.symbols };
});

vi.mock('./swingStructureEvaluation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swingStructureEvaluation')>()),
  evaluateSwingStructureStudy: mocks.evaluate,
}));

const { evaluateSwingStructureStudy: realAnalysis } = await vi.importActual<
  typeof import('./swingStructureEvaluation')
>('./swingStructureEvaluation');

interface Spec {
  studyId: string;
  specificationId: string;
  candidate: { sourceBlobs: Record<string, string> };
  data: {
    export: {
      file: string;
      sha256: string;
      retrievalStartedAt: string;
      retrievalCompletedAt: string;
    };
    inputHashes: Record<string, string>;
    bars: { firstBar: string };
  };
  universe: { members: Record<string, string> };
}

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SPEC_PATH = 'docs/swing-structure-evaluation.v1.json';
const ANALYSIS_PATH = 'scripts/swingStructureEvaluation.ts';
const RUNNER_PATH = 'scripts/swingStructureEvaluationRun.ts';
const spec = JSON.parse(await readFile(join(REPO, SPEC_PATH), 'utf8')) as Spec;
const MEMBERS = Object.keys(spec.universe.members).sort();
const RESULTS = `.zerochart-reports/swing-structure-evaluation-${spec.specificationId.slice(0, 12)}.json`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const DAY = 86_400_000;
const FIRST = Date.parse(`${spec.data.bars.firstBar}T00:00:00.000Z`);
const RECEIVED = '2026-11-11T18:39:00.000Z';

const hex = (data: string | Buffer, algorithm = 'sha256') =>
  createHash(algorithm).update(data).digest('hex');
const blob = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const blobOf = async (path: string) => blob(await readFile(join(REPO, path)));

interface SyntheticBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
interface SyntheticEntry {
  ticker: string;
  symbol: string;
  receivedAt?: string;
  response?: {
    success: boolean;
    symbol: string;
    interval: string;
    currency: string;
    bars: SyntheticBar[];
  };
  error?: string;
}
interface SyntheticExport {
  schemaVersion: string;
  source: string;
  universe?: string;
  retrieval: { startedAt: string; completedAt: string };
  instruments: SyntheticEntry[];
}

/** A deterministic synthetic walk of 1000 daily bars from the first bar; invented prices. */
function syntheticBars(seed: string): SyntheticBar[] {
  let price = 100;
  return Array.from({ length: 1000 }, (_, i) => {
    const u = (n: number) =>
      createHash('sha256').update(`${seed}|${i}|${n}`).digest().readUInt32BE(0) / 2 ** 32;
    const o = price;
    price = o * Math.exp((u(0) - 0.5) * 0.1);
    const h = Math.max(o, price) * (1 + 0.02 * u(1));
    const l = Math.min(o, price) * (1 - 0.02 * u(2));
    return { t: (FIRST + i * DAY) / 1000, o, h, l, c: price, v: 1 };
  });
}

/** The five members and a sixth, TRX, that is in the export but not in the study. */
const BASE: SyntheticExport = {
  schemaVersion: '1',
  source: 'tradingview-mcp',
  universe: 'crypto-usdt-v1',
  retrieval: {
    startedAt: spec.data.export.retrievalStartedAt,
    completedAt: spec.data.export.retrievalCompletedAt,
  },
  instruments: [...MEMBERS, 'TRX-USDT'].map((ticker) => {
    const symbol = CRYPTO_TRADINGVIEW_SYMBOLS[ticker] ?? '';
    return {
      ticker,
      symbol,
      receivedAt: RECEIVED,
      response: {
        success: true,
        symbol,
        interval: '1D',
        currency: 'USDT',
        bars: syntheticBars(`synthetic|${ticker}`),
      },
    };
  }),
};

const synthetic = () => structuredClone(BASE);
const entryOf = (file: SyntheticExport, ticker: string) => {
  const entry = file.instruments.find((e) => e.ticker === ticker);
  if (!entry?.response) throw new Error(`fixture has no ${ticker}`);
  return entry as Required<SyntheticEntry>;
};

let root: string;

/**
 * Writes the fixture where the specification names the export, and presents its digest and the
 * digests of the listed members' entries as the frozen ones.
 */
async function present(
  file: SyntheticExport,
  options: { bytes?: Buffer; asFrozen?: readonly string[] } = {},
) {
  const bytes = options.bytes ?? Buffer.from(JSON.stringify(file));
  mocks.translate.clear();
  const translations = new Map([[hex(bytes), spec.data.export.sha256]]);
  for (const entry of file.instruments) {
    const frozen = spec.data.inputHashes[entry.ticker];
    if (frozen && (options.asFrozen ?? MEMBERS).includes(entry.ticker)) {
      translations.set(hex(stableSerialize(entry)), frozen);
    }
  }
  for (const [from, to] of translations) mocks.translate.set(from, to);
  await mkdir(join(root, '.zerochart-tradingview'), { recursive: true });
  await writeFile(join(root, spec.data.export.file), bytes);
  mocks.reads.length = 0;
  mocks.writes.length = 0;
  return bytes;
}

const run = () => runSwingStructureEvaluation({ root });
const readsOf = (path: string) => mocks.reads.filter((p) => p === path).length;
const exportPath = () => join(root, spec.data.export.file);

/** A refused run: nothing analysed, nothing written, no results directory. */
async function refused(code: string, message: RegExp) {
  const error = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SwingStructureRunRefusal);
  expect(error).toMatchObject({ code, message: expect.stringMatching(message) });
  expect(mocks.evaluate).not.toHaveBeenCalled();
  expect(mocks.writes).toEqual([]);
  expect(existsSync(join(root, '.zerochart-reports'))).toBe(false);
}

const STUB = { synthetic: 'stub analysis result, not the study' };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'popup-swing-run-'));
  mocks.translate.clear();
  mocks.overrides.clear();
  mocks.reads.length = 0;
  mocks.writes.length = 0;
  mocks.git.mockReset().mockImplementation(async (_file: string, args: string[]) => ({
    stdout: args[0] === 'rev-parse' ? `${COMMIT}\n` : '',
    stderr: '',
  }));
  mocks.evaluate.mockReset().mockImplementation(() => STUB);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('verification order: specification, code, repository, export, members', () => {
  it('refuses an edited specification through the existing validator, before reading code', async () => {
    const edited = { ...spec, interpretability: { minimumDates: 24 } };
    mocks.overrides.set(join(REPO, SPEC_PATH), Buffer.from(JSON.stringify(edited)));
    await present(synthetic());
    const error = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SwingStructureEvaluationRefusal);
    expect(error).toMatchObject({ code: 'SPECIFICATION' });
    expect(mocks.reads).toEqual([join(REPO, SPEC_PATH)]);
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.writes).toEqual([]);
  });

  it.each(Object.keys(spec.candidate.sourceBlobs))(
    'refuses modified working bytes of %s, before git or the export is touched',
    async (path) => {
      const real = await readFile(join(REPO, path));
      mocks.overrides.set(join(REPO, path), Buffer.concat([real, Buffer.from('\n// edited\n')]));
      await present(synthetic());
      await refused('CODE_IDENTITY', new RegExp(`${path} is blob [0-9a-f]{40}, not the pinned`));
      expect(mocks.git).not.toHaveBeenCalled();
      expect(readsOf(exportPath())).toBe(0);
    },
  );

  it('refuses a missing candidate file', async () => {
    await present(synthetic());
    mocks.overrides.set(join(REPO, 'scripts/swingStructure.ts'), new Error('ENOENT: no such file'));
    await refused('CODE_IDENTITY', /cannot read scripts\/swingStructure\.ts: ENOENT/);
  });

  it('refuses a checkout whose tracked files differ from HEAD, or no checkout at all', async () => {
    await present(synthetic());
    mocks.git.mockImplementation(async (_file: string, args: string[]) => ({
      stdout: args[0] === 'rev-parse' ? `${COMMIT}\n` : ' M scripts/tradingViewImport.ts\n',
      stderr: '',
    }));
    await refused(
      'REPOSITORY',
      /tracked files differ from 0123456789abcdef.* scripts\/tradingViewImport\.ts/,
    );
    expect(readsOf(exportPath())).toBe(0);

    mocks.git.mockRejectedValue(new Error('not a git repository'));
    await refused('REPOSITORY', /git rev-parse HEAD failed: not a git repository/);
  });

  it('refuses a missing export', async () => {
    await refused(
      'DATA_UNAVAILABLE',
      /cannot read \.zerochart-tradingview\/20261111T183825Z\.json/,
    );
  });

  it('refuses export bytes that differ from the frozen sha256 before parsing them', async () => {
    // Not JSON at all: a parse before the hash check would fail differently.
    await mkdir(join(root, '.zerochart-tradingview'), { recursive: true });
    await writeFile(exportPath(), 'not json, not the export');
    mocks.writes.length = 0;
    await refused('DATA_UNAVAILABLE', /is sha256 [0-9a-f]{64}, not 8d251bbf/);
  });

  it('refuses a byte change outside every instrument entry, even with every entry intact', async () => {
    const file = synthetic();
    await present(file);
    // Same entries, reformatted file: only the whole-file identity can see it.
    await writeFile(exportPath(), `${JSON.stringify(file, null, 1)}\n`);
    mocks.writes.length = 0;
    await refused('DATA_UNAVAILABLE', /is sha256 [0-9a-f]{64}, not 8d251bbf/);
  });

  it('reads the export once and uses those bytes for every later check and the mapping', async () => {
    await present(synthetic());
    await run();
    expect(readsOf(exportPath())).toBe(1);
    expect(readsOf(join(REPO, SPEC_PATH))).toBe(1);
    for (const path of [...Object.keys(spec.candidate.sourceBlobs), ANALYSIS_PATH, RUNNER_PATH]) {
      expect(readsOf(join(REPO, path)), path).toBe(1);
    }
  });
});

describe('export metadata and members, after the export identity holds', () => {
  it.each([
    [
      'retrieval start',
      (f: SyntheticExport) => (f.retrieval.startedAt = '2026-11-11T18:38:25.831Z'),
    ],
    [
      'retrieval end',
      (f: SyntheticExport) => (f.retrieval.completedAt = '2026-11-11T18:39:47.667Z'),
    ],
  ])('refuses a different %s', async (_what, edit) => {
    const file = synthetic();
    edit(file);
    await present(file);
    await refused('DATA_UNAVAILABLE', /retrieval times differ from data\.export/);
  });

  it('refuses an export of another universe', async () => {
    const file = synthetic();
    delete file.universe;
    await present(file);
    await refused('DATA_UNAVAILABLE', /is not in the dev-scan universe/);
  });

  it('refuses a missing member rather than running on four', async () => {
    const file = synthetic();
    file.instruments = file.instruments.filter((e) => e.ticker !== 'XRP-USDT');
    await present(file);
    await refused('DATA_UNAVAILABLE', /XRP-USDT appears 0 times, not once/);
  });

  it('refuses a duplicated member', async () => {
    const file = synthetic();
    file.instruments.push(structuredClone(entryOf(file, 'BTC-USDT')));
    await present(file);
    await refused('DATA_UNAVAILABLE', /BTC-USDT appears twice/);
  });

  it('refuses a member whose entry differs from its frozen input hash, naming it', async () => {
    await present(synthetic(), { asFrozen: MEMBERS.filter((t) => t !== 'SOL-USDT') });
    await refused('DATA_UNAVAILABLE', /SOL-USDT entry hashes to [0-9a-f]{64}, not its input hash/);
  });

  it('refuses a member whose committed symbol no longer matches the frozen one', async () => {
    await present(synthetic());
    const committed = mocks.symbols['SOL-USDT'] ?? '';
    mocks.symbols['SOL-USDT'] = 'BINANCE:SOLUSDC';
    try {
      await refused('DATA_UNAVAILABLE', /SOL-USDT: BINANCE:SOLUSDT is not its committed symbol/);
    } finally {
      mocks.symbols['SOL-USDT'] = committed;
    }
  });

  it('refuses a member retrieved under another symbol', async () => {
    const file = synthetic();
    entryOf(file, 'BTC-USDT').symbol = 'BINANCE:BTCUSDT.P';
    await present(file);
    await refused('DATA_UNAVAILABLE', /BTC-USDT was retrieved as BINANCE:BTCUSDT\.P/);
  });

  it.each([
    [
      'venue',
      (e: Required<SyntheticEntry>) => (e.response.symbol = 'BYBIT:ETHUSDT'),
      /is for BYBIT/,
    ],
    ['interval', (e: Required<SyntheticEntry>) => (e.response.interval = '1W'), /interval 1W/],
    ['quote', (e: Required<SyntheticEntry>) => (e.response.currency = 'USD'), /quoted in USD/],
    [
      'bar',
      (e: Required<SyntheticEntry>) => ((e.response.bars[7] as { c: unknown }).c = 'n/a'),
      /non-numeric bar/,
    ],
  ])('refuses what the existing mapping refuses: wrong %s', async (_what, edit, message) => {
    const file = synthetic();
    edit(entryOf(file, 'ETH-USDT'));
    await present(file);
    await refused('DATA_UNAVAILABLE', new RegExp(`ETH-USDT: .*${message.source}`));
  });

  it('refuses a member with no recorded response', async () => {
    const file = synthetic();
    const entry = entryOf(file, 'BNB-USDT') as SyntheticEntry;
    delete entry.response;
    delete entry.receivedAt;
    entry.error = 'synthetic timeout';
    await present(file);
    await refused('DATA_UNAVAILABLE', /BNB-USDT has no response: synthetic timeout/);
  });

  it('passes the analysis exactly the five members, mapped by the existing mapping, and nothing else', async () => {
    const file = synthetic();
    await present(file);
    await run();
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    const [given, members] = mocks.evaluate.mock.calls[0] as [Spec, Record<string, unknown>];
    expect(given.specificationId).toBe(spec.specificationId);
    expect(Object.keys(members).sort()).toEqual(MEMBERS);
    for (const ticker of MEMBERS) {
      const symbol = spec.universe.members[ticker] ?? '';
      expect(members[ticker], ticker).toEqual(
        tradingViewCryptoCandles(entryOf(file, ticker).response, { symbol, from: FIRST }),
      );
      expect((members[ticker] as unknown[]).length).toBe(1000);
    }
  });

  it('passes gaps and duplicates through untouched, for the analysis to classify', async () => {
    const file = synthetic();
    const btc = entryOf(file, 'BTC-USDT').response.bars;
    btc.splice(4, 1);
    const eth = entryOf(file, 'ETH-USDT').response.bars;
    eth.push({ ...(eth[900] as SyntheticBar) });
    await present(file);
    await run();
    const [, members] = mocks.evaluate.mock.calls[0] as [
      Spec,
      Record<string, { timestamp: number }[]>,
    ];
    expect(members['BTC-USDT']).toHaveLength(999);
    expect(members['ETH-USDT']).toHaveLength(1001);
    expect(members['ETH-USDT']?.at(-1)?.timestamp).toBe(members['ETH-USDT']?.[900]?.timestamp);
  });
});

describe('the result is written once and never overwritten', () => {
  it('writes no result when the analysis refuses', async () => {
    await present(synthetic());
    mocks.evaluate.mockImplementation(() => {
      throw new SwingStructureEvaluationRefusal('LOOK_AHEAD', 'synthetic refusal');
    });
    await expect(run()).rejects.toMatchObject({ code: 'LOOK_AHEAD' });
    expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    expect(mocks.writes).toEqual([]);
    expect(existsSync(join(root, '.zerochart-reports'))).toBe(false);
  });

  it('reports CREATED, then UNCHANGED for the same bytes, then CONFLICT without overwriting', async () => {
    await present(synthetic());
    const created = await run();
    const first = await readFile(join(root, RESULTS));
    expect(created).toEqual({
      status: 'CREATED',
      resultsPath: RESULTS,
      savedSha256: hex(first),
      contentSha256: hex(first),
    });

    const unchanged = await run();
    expect(unchanged).toEqual({ ...created, status: 'UNCHANGED' });
    expect(await readFile(join(root, RESULTS))).toEqual(first);

    mocks.evaluate.mockImplementation(() => ({ ...STUB, differs: true }));
    const conflict = await run();
    expect(conflict.status).toBe('CONFLICT');
    expect(conflict.savedSha256).toBe(hex(first));
    expect(conflict.contentSha256).not.toBe(hex(first));
    expect(await readFile(join(root, RESULTS))).toEqual(first);
  });

  it('keeps an earlier result it did not write', async () => {
    await present(synthetic());
    await mkdir(join(root, '.zerochart-reports'));
    await writeFile(join(root, RESULTS), 'earlier evidence\n');
    const result = await run();
    expect(result.status).toBe('CONFLICT');
    expect(await readFile(join(root, RESULTS), 'utf8')).toBe('earlier evidence\n');
    expect(result.savedSha256).toBe(hex('earlier evidence\n'));
  });

  it('records a deterministic manifest: no clock, no absolute path, the same bytes at another time', async () => {
    const bytes = await present(synthetic());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    expect((await run()).status).toBe('CREATED');
    vi.setSystemTime(new Date('2031-06-15T12:34:56Z'));
    expect((await run()).status).toBe('UNCHANGED');

    const text = await readFile(join(root, RESULTS), 'utf8');
    expect(text).not.toContain(root);
    expect(text).not.toContain(REPO.replace(/\/$/, ''));
    expect(text).not.toMatch(/203[01]-/);
    const { manifest, results } = JSON.parse(text) as { manifest: unknown; results: unknown };
    expect(results).toEqual(STUB);
    expect(manifest).toEqual({
      studyId: spec.studyId,
      specificationId: spec.specificationId,
      specification: { path: SPEC_PATH, blob: await blobOf(SPEC_PATH), identity: 'MATCH' },
      repository: { commit: COMMIT, trackedFiles: 'MATCH_COMMIT' },
      code: {
        candidate: Object.fromEntries(
          Object.entries(spec.candidate.sourceBlobs).map(([path, pinned]) => [
            path,
            { blob: pinned, pinned: 'MATCH' },
          ]),
        ),
        analysis: { path: ANALYSIS_PATH, blob: await blobOf(ANALYSIS_PATH) },
        runner: { path: RUNNER_PATH, blob: await blobOf(RUNNER_PATH) },
      },
      export: {
        file: spec.data.export.file,
        size: bytes.length,
        sha256: spec.data.export.sha256,
        universe: 'crypto-usdt-v1',
        retrievalStartedAt: spec.data.export.retrievalStartedAt,
        retrievalCompletedAt: spec.data.export.retrievalCompletedAt,
        verification: 'MATCH',
      },
      mapping: { function: 'tradingViewCryptoCandles', from: '2024-02-16T00:00:00.000Z' },
      members: Object.fromEntries(
        MEMBERS.map((ticker) => [
          ticker,
          {
            symbol: spec.universe.members[ticker],
            inputHash: spec.data.inputHashes[ticker],
            candles: 1000,
          },
        ]),
      ),
    });
    expect(Object.keys(manifest as object)).toEqual([
      'studyId',
      'specificationId',
      'specification',
      'repository',
      'code',
      'export',
      'mapping',
      'members',
    ]);
  });
});

describe('synthetic integration: verification, the real analysis and saving', () => {
  it('runs the existing analysis on verified synthetic members and reproduces its bytes', async () => {
    mocks.evaluate.mockImplementation(realAnalysis);
    const file = synthetic();
    entryOf(file, 'BTC-USDT').response.bars.splice(4, 1);
    const eth = entryOf(file, 'ETH-USDT').response.bars;
    eth.push({ ...(eth[958] as SyntheticBar) });
    const duplicated = new Date(FIRST + 958 * DAY).toISOString().slice(0, 10);
    await present(file);

    const created = await run();
    expect(created.status).toBe('CREATED');
    const text = await readFile(join(root, RESULTS), 'utf8');
    expect(created.savedSha256).toBe(hex(text));
    const { manifest, results } = JSON.parse(text) as {
      manifest: { specificationId: string; repository: { commit: string } };
      results: {
        specificationId: string;
        members: Record<string, string>;
        completeness: Record<string, { missing: string[]; duplicate: string[] }>;
        exclusions: { observations: { member: string; state: string }[] };
        observations: unknown[];
        B: { primary: { classification: string } };
      };
    };
    expect(manifest.specificationId).toBe(spec.specificationId);
    expect(manifest.repository.commit).toBe(COMMIT);
    expect(results.specificationId).toBe(spec.specificationId);
    expect(results.members).toEqual(spec.universe.members);
    expect(results.observations).toHaveLength(4 * 5 * 759);
    // The runner neither repaired nor refused them: the analysis classified them.
    expect(results.completeness['BTC-USDT']?.missing).toEqual(['2024-02-20']);
    expect(results.completeness['ETH-USDT']?.duplicate).toEqual([duplicated]);
    expect(
      results.exclusions.observations.some(
        (o) => o.member === 'BTC-USDT' && o.state === 'INVALID_INPUT',
      ),
    ).toBe(true);
    expect(['INFORMATIVE', 'INCONCLUSIVE', 'ADVERSE', 'NOT_INTERPRETABLE']).toContain(
      results.B.primary.classification,
    );

    const again = await run();
    expect(again).toEqual({ ...created, status: 'UNCHANGED' });
    expect(mocks.evaluate).toHaveBeenCalledTimes(2);
  }, 300_000);
});

describe('importing the runner', () => {
  it('starts no study and reads, writes or runs nothing', async () => {
    vi.resetModules();
    mocks.reads.length = 0;
    mocks.writes.length = 0;
    const runner = await import('./swingStructureEvaluationRun');
    expect(runner.runSwingStructureEvaluation).toBeTypeOf('function');
    expect(mocks.reads).toEqual([]);
    expect(mocks.writes).toEqual([]);
    expect(mocks.git).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
