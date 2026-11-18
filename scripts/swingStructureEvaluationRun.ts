import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RESEARCH_OUTPUT_DIR, saveResearchResults } from './scannerResearch';
import { instrumentHashes } from './scannerResearchCrypto';
import {
  evaluateSwingStructureStudy,
  SWING_STRUCTURE_EVALUATION_SPECIFICATION_PATH,
  utcDay,
  verifySpecificationIdentity,
  type SwingStructureEvaluationSpecification,
} from './swingStructureEvaluation';
import {
  CRYPTO_TRADINGVIEW_SYMBOLS,
  CRYPTO_UNIVERSE,
  parseExport,
  tradingViewCryptoCandles,
  type TradingViewOhlcvExport,
} from './tradingViewImport';

/**
 * Runs the frozen swing-structure study (docs/swing-structure-evaluation.v1.json) on the export it
 * names, once, and keeps the result. Every identity is checked before anything is analysed or
 * written, in this order: the specification, the candidate's code bytes, the repository, the
 * export's bytes, its metadata and its five members. The expected values come only from the
 * verified specification; nothing here can replace them. Importing this module starts nothing.
 */

/**
 * The checkout this file belongs to: where the analysis and the candidate are loaded from.
 * Resolved when a run starts, so importing this module does nothing, in any environment.
 */
const repositoryRoot = () => fileURLToPath(new URL('..', import.meta.url));
const ANALYSIS_PATH = 'scripts/swingStructureEvaluation.ts';
const RUNNER_PATH = 'scripts/swingStructureEvaluationRun.ts';

/** The fields this runner verifies beyond those the analysis reads. */
type FrozenSpecification = SwingStructureEvaluationSpecification & {
  candidate: { sourceBlobs: Record<string, string> };
  data: {
    export: { file: string; sha256: string; retrievalCompletedAt: string };
    inputHashes: Record<string, string>;
  };
};

export type SwingStructureRunRefusalCode =
  'SPECIFICATION' | 'CODE_IDENTITY' | 'REPOSITORY' | 'DATA_UNAVAILABLE';

/** The run stops before any analysis or write. Nothing is repaired, replaced or skipped. */
export class SwingStructureRunRefusal extends Error {
  constructor(
    readonly code: SwingStructureRunRefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'SwingStructureRunRefusal';
  }
}

function refuse(code: SwingStructureRunRefusalCode, message: string): never {
  throw new SwingStructureRunRefusal(code, message);
}

const execFileAsync = promisify(execFile);
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** Git's blob id of these exact bytes, as `git hash-object` gives for a file without filters. */
const gitBlob = (bytes: Buffer) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const byCodeUnit = (a: string, b: string) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** Each file is read once; every later check and use takes these bytes. */
async function bytesOf(
  path: string,
  shown: string,
  code: SwingStructureRunRefusalCode,
): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    return refuse(code, `cannot read ${shown}: ${errorText(error)}`);
  }
}

async function git(repository: string, args: string[]): Promise<string> {
  try {
    return (await execFileAsync('git', args, { cwd: repository })).stdout;
  } catch (error) {
    return refuse('REPOSITORY', `git ${args.join(' ')} failed: ${errorText(error)}`);
  }
}

/** candidate.rule and reproducibility.code: the files that execute, byte for byte as pinned. */
async function verifyCode(spec: FrozenSpecification, repository: string) {
  const blobOf = async (path: string) =>
    gitBlob(await bytesOf(join(repository, path), path, 'CODE_IDENTITY'));
  const pinned = Object.entries(spec.candidate.sourceBlobs).sort(([a], [b]) => byCodeUnit(a, b));
  const blobs = await Promise.all(pinned.map(([path]) => blobOf(path)));
  const candidate: Record<string, { blob: string; pinned: 'MATCH' }> = {};
  pinned.forEach(([path, expected], i) => {
    const blob = blobs[i] ?? '';
    if (blob !== expected) {
      refuse('CODE_IDENTITY', `${path} is blob ${blob}, not the pinned ${expected}`);
    }
    candidate[path] = { blob, pinned: 'MATCH' };
  });
  return {
    candidate,
    analysis: { path: ANALYSIS_PATH, blob: await blobOf(ANALYSIS_PATH) },
    runner: { path: RUNNER_PATH, blob: await blobOf(RUNNER_PATH) },
  };
}

/**
 * The commit the result is attributed to. Tracked files must match it, so the commit names all
 * the code that runs, and a modified checkout cannot take the single output file.
 */
async function verifyRepository(repository: string) {
  const commit = (await git(repository, ['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) refuse('REPOSITORY', `HEAD is not a commit: ${commit}`);
  const changed = (await git(repository, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (changed !== '') {
    refuse('REPOSITORY', `tracked files differ from ${commit}: ${changed.replaceAll('\n', '; ')}`);
  }
  return { commit, trackedFiles: 'MATCH_COMMIT' as const };
}

/**
 * data.export, data.inputHashes and data.mapping: the frozen bytes, then the frozen members,
 * mapped by the existing TradingView crypto mapping. Any difference stops the study
 * (missingData.study). Observation-level gaps are left for the analysis to classify.
 */
async function verifyExport(spec: FrozenSpecification, root: string) {
  const frozen = spec.data.export;
  const raw = await bytesOf(join(root, frozen.file), frozen.file, 'DATA_UNAVAILABLE');
  const exportSha256 = sha256(raw);
  if (exportSha256 !== frozen.sha256) {
    refuse('DATA_UNAVAILABLE', `${frozen.file} is sha256 ${exportSha256}, not ${frozen.sha256}`);
  }
  let file: TradingViewOhlcvExport;
  try {
    file = parseExport(JSON.parse(raw.toString('utf8')));
  } catch (error) {
    return refuse('DATA_UNAVAILABLE', errorText(error));
  }
  if (
    file.universe !== CRYPTO_UNIVERSE ||
    file.retrieval.startedAt !== frozen.retrievalStartedAt ||
    file.retrieval.completedAt !== frozen.retrievalCompletedAt
  ) {
    refuse('DATA_UNAVAILABLE', 'export universe or retrieval times differ from data.export');
  }

  const hashes = instrumentHashes(file);
  const from = utcDay(spec.data.bars.firstBar);
  const members: Record<string, ReturnType<typeof tradingViewCryptoCandles>> = {};
  const manifest: Record<string, { symbol: string; inputHash: string; candles: number }> = {};
  for (const ticker of Object.keys(spec.universe.members).sort(byCodeUnit)) {
    const member = verifyMember(spec, file, hashes, ticker, from);
    members[ticker] = member.candles;
    manifest[ticker] = member.manifest;
  }
  return {
    members,
    manifest: {
      export: {
        file: frozen.file,
        size: raw.length,
        sha256: exportSha256,
        universe: file.universe,
        retrievalStartedAt: file.retrieval.startedAt,
        retrievalCompletedAt: file.retrieval.completedAt,
        verification: 'MATCH' as const,
      },
      mapping: { function: 'tradingViewCryptoCandles', from: new Date(from).toISOString() },
      members: manifest,
    },
  };
}

/** One member: present once, under its committed and frozen symbol, with its input hash. */
function verifyMember(
  spec: FrozenSpecification,
  file: TradingViewOhlcvExport,
  hashes: Readonly<Record<string, string>>,
  ticker: string,
  from: number,
) {
  const symbol = spec.universe.members[ticker];
  if (symbol === undefined || CRYPTO_TRADINGVIEW_SYMBOLS[ticker] !== symbol) {
    refuse('DATA_UNAVAILABLE', `${ticker}: ${symbol} is not its committed symbol`);
  }
  const entries = file.instruments.filter((entry) => entry.ticker === ticker);
  const [entry] = entries;
  if (entries.length !== 1 || !entry) {
    refuse('DATA_UNAVAILABLE', `${ticker} appears ${entries.length} times, not once`);
  }
  if (entry.symbol !== symbol) {
    refuse('DATA_UNAVAILABLE', `${ticker} was retrieved as ${entry.symbol}, not ${symbol}`);
  }
  const inputHash = hashes[ticker];
  if (inputHash === undefined || inputHash !== spec.data.inputHashes[ticker]) {
    refuse('DATA_UNAVAILABLE', `${ticker} entry hashes to ${inputHash}, not its input hash`);
  }
  if (entry.response === undefined) {
    refuse('DATA_UNAVAILABLE', `${ticker} has no response: ${entry.error ?? 'none recorded'}`);
  }
  try {
    const candles = tradingViewCryptoCandles(entry.response, { symbol, from });
    return { candles, manifest: { symbol, inputHash, candles: candles.length } };
  } catch (error) {
    return refuse('DATA_UNAVAILABLE', `${ticker}: ${errorText(error)}`);
  }
}

export interface SwingStructureRunResult {
  status: 'CREATED' | 'UNCHANGED' | 'CONFLICT';
  /** Relative to the root, never an absolute path. */
  resultsPath: string;
  /** sha256 of the bytes now saved at resultsPath: on CONFLICT, the earlier result that was kept. */
  savedSha256: string;
  /** sha256 of this run's bytes. It differs from savedSha256 only on CONFLICT. */
  contentSha256: string;
}

/**
 * The whole run. `root` holds the export and receives the result; it defaults to this checkout,
 * and tests point it at a temporary directory. The specification and the code are always read
 * from this checkout, where they are loaded from, and every expected identity comes from the
 * verified specification.
 */
export async function runSwingStructureEvaluation(
  options: { root?: string } = {},
): Promise<SwingStructureRunResult> {
  const repository = repositoryRoot();
  const root = options.root ?? repository;
  const specificationPath = SWING_STRUCTURE_EVALUATION_SPECIFICATION_PATH;
  const specificationBytes = await bytesOf(
    join(repository, specificationPath),
    specificationPath,
    'SPECIFICATION',
  );
  let spec: FrozenSpecification;
  try {
    spec = JSON.parse(specificationBytes.toString('utf8')) as FrozenSpecification;
  } catch (error) {
    return refuse('SPECIFICATION', errorText(error));
  }
  verifySpecificationIdentity(spec);
  const code = await verifyCode(spec, repository);
  const checkout = await verifyRepository(repository);
  const verified = await verifyExport(spec, root);

  const results = evaluateSwingStructureStudy(spec, verified.members);
  const manifest = {
    studyId: spec.studyId,
    specificationId: spec.specificationId,
    specification: {
      path: specificationPath,
      blob: gitBlob(specificationBytes),
      identity: 'MATCH' as const,
    },
    repository: checkout,
    code,
    ...verified.manifest,
  };
  const content = `${JSON.stringify({ manifest, results })}\n`;
  const resultsPath = `${RESEARCH_OUTPUT_DIR}/swing-structure-evaluation-${spec.specificationId.slice(0, 12)}.json`;
  const status = await saveResearchResults(join(root, resultsPath), content);
  return {
    status,
    resultsPath,
    savedSha256: sha256(await readFile(join(root, resultsPath))),
    contentSha256: sha256(content),
  };
}
