/**
 * Manual Spot experiments (docs/MANUAL_SPOT_EXPERIMENTS.md): the owner's record of one real
 * Binance Spot decision and the saved scan it came from. The database decides who may read or
 * add one (`is_binance_spot_owner()` and row-level security) and sets the ID, owner and
 * recorded time; nothing here can.
 *
 * The owner records the experiment itself and links fills from a Popup execution read. Nothing
 * here writes a rule, observation or close, and the scenario's arithmetic is never copied: a rule
 * exists only as an entry the owner adds. A linked fill is a client-submitted copy: the server
 * never re-reads Binance to verify it.
 */
import type { CanonicalScore, ModelSetups } from '@/lib/canonicalModel';
import type { SpotExecution } from '@/lib/binanceSpotAccount';
import { SERVER_ERROR_CODE } from '@/lib/db';
import type { Database, Json } from '@/integrations/supabase/types';
import type { MarketScan, ScanAssetResult, ScanCohort } from '@/lib/marketScanner';
import {
  clauseValue,
  cohortFreshness,
  explainResult,
  resultAsOfLabel,
  symbolEvidence,
} from '@/lib/scanReview';
import { supabase } from '@/lib/supabaseClient';
import type { TradingViewDevSource, TradingViewSavedScan } from '@/lib/tradingViewDevScan';
import { utcInputTime } from '@/lib/utils';

type Tables = Database['public']['Tables'];
export type SpotExperimentInsert = Required<
  Pick<
    Tables['spot_experiments']['Insert'],
    | 'account_label'
    | 'symbol'
    | 'source_scan_id'
    | 'source_snapshot_sha256'
    | 'source_reproduction'
    | 'source_evidence'
    | 'decision'
    | 'decision_stated_at'
  >
>;

/** The database's own checks, mirrored so a form can say what is wrong before anything is sent. */
export const ACCOUNT_LABEL = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const MAX_STATEMENT = 1000;

/**
 * The candidate as the Manual Spot scenario shows it under "Recorded evidence it rests on":
 * the same facts, in the same words. The experiment stores this copy; it is never re-derived.
 */
export type CandidateEvidence = {
  version: 1;
  instrument: string;
  /** Each fact as shown: name, then text. */
  facts: [string, string][];
  rank: number | null;
  evaluated: number;
  long: boolean;
  risk: boolean;
  /** Whether the evidence was older than its freshness rule when it was shown. */
  stale: boolean;
};

/** The Risk clauses that held, as one phrase. */
export function riskReasons(model: CanonicalScore, setups: ModelSetups): string {
  return explainResult(model, setups)
    .risk.clauses.filter((clause) => clause.met)
    .map(clauseValue)
    .join(', ');
}

export function candidateEvidence({
  result,
  model,
  setups,
  cohort,
  scan,
  scanId,
  source,
  now,
}: Readonly<{
  result: ScanAssetResult;
  model: CanonicalScore;
  setups: ModelSetups;
  cohort: ScanCohort;
  scan: MarketScan;
  scanId: string | undefined;
  source: TradingViewDevSource;
  now: number;
}>): CandidateEvidence {
  const { coverage } = cohort;
  const complete = scan.status === 'COMPLETE' && cohort.status === 'COMPLETE';
  const incomplete = complete ? '' : `, incomplete scan (${coverage.supported} supported)`;
  const freshness = cohortFreshness(cohort, now);
  return {
    version: 1,
    instrument: result.instrument ?? result.ticker,
    facts: [
      ['Instrument', symbolEvidence(result, source)],
      ['Venue', 'Binance Spot, USDT pair'],
      ['Scan', scanId ?? 'Not recorded'],
      ['Model · timeframe', `${model.version} · ${scan.timeframe.toUpperCase()}`],
      ['Evaluated', resultAsOfLabel(result)],
      ['Technical rank', `#${result.rank} of ${coverage.evaluated}${incomplete}`],
      ['ZC LONG', setups.long ? 'Holds' : 'Does not hold'],
      ['ZC RISK', setups.risk ? `Holds: ${riskReasons(model, setups)}` : 'Does not hold'],
      ['Freshness', freshness?.detail ?? 'Not recorded'],
      [
        'Data quality',
        `Evaluated on ${result.closedCandles} closed UTC days; scan ${complete ? 'complete' : 'incomplete'}`,
      ],
    ],
    rank: result.rank,
    evaluated: coverage.evaluated,
    long: setups.long,
    risk: setups.risk,
    stale: freshness?.stale ?? false,
  };
}

/** A stored evidence copy, or null when it is not one this view can read. */
export function parseEvidence(value: Json): CandidateEvidence | null {
  const raw = value as Partial<CandidateEvidence> | null;
  const valid =
    raw?.version === 1 &&
    typeof raw.instrument === 'string' &&
    Array.isArray(raw.facts) &&
    raw.facts.every(
      (fact) =>
        Array.isArray(fact) &&
        fact.length === 2 &&
        typeof fact[0] === 'string' &&
        typeof fact[1] === 'string',
    ) &&
    typeof raw.stale === 'boolean';
  return valid ? (raw as CandidateEvidence) : null;
}

export interface ExperimentDraft {
  decision: string;
  accountLabel: string;
  /** A `datetime-local` value read as UTC; empty when not stated. */
  statedAt: string;
}

export const EMPTY_DRAFT: ExperimentDraft = { decision: '', accountLabel: '', statedAt: '' };

export type DraftErrors = Partial<Record<keyof ExperimentDraft, string>>;

export type DraftCheck =
  | { ok: true; decision: string; accountLabel: string; statedAt: string | null }
  | { ok: false; errors: DraftErrors };

/** The owner's own words and times, checked as the database will check them. */
export function checkDraft(draft: ExperimentDraft, now: number): DraftCheck {
  const errors: DraftErrors = {};
  const decision = draft.decision.trim();
  if (decision === '') errors.decision = 'Describe the decision you made, in your own words.';
  else if ([...decision].length > MAX_STATEMENT) {
    errors.decision = `Use at most ${MAX_STATEMENT} characters.`;
  }
  if (!ACCOUNT_LABEL.test(draft.accountLabel)) {
    errors.accountLabel =
      'Use 1 to 40 lowercase letters, digits, hyphens or underscores, starting with a letter or digit.';
  }
  let statedAt: string | null = null;
  if (draft.statedAt !== '') {
    const time = utcInputTime(draft.statedAt);
    if (time === null) errors.statedAt = 'Enter a valid UTC date and time, or leave it empty.';
    else if (time > now) {
      errors.statedAt = 'This is in the future. A decision cannot be stated after it is recorded.';
    } else statedAt = new Date(time).toISOString();
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, decision, accountLabel: draft.accountLabel, statedAt };
}

/** The Binance Spot pair a scanned instrument names ("BINANCE:ZCTUSDT" → "ZCTUSDT"). */
export function spotSymbol(instrument: string): string | null {
  return /^BINANCE:([A-Z0-9]{1,20}USDT)$/.exec(instrument)?.[1] ?? null;
}

/**
 * The row to store: content only. The ID, owner and recorded time come from the database.
 * `match` because the saved-scan route returns a snapshot only after it reproduced offline, from
 * the same read that hashed it.
 */
export function experimentRow(
  check: Extract<DraftCheck, { ok: true }>,
  evidence: CandidateEvidence,
  scanId: string,
  saved: TradingViewSavedScan,
): SpotExperimentInsert | null {
  const symbol = spotSymbol(evidence.instrument);
  if (!symbol) return null;
  return {
    account_label: check.accountLabel,
    symbol,
    source_scan_id: scanId,
    source_snapshot_sha256: saved.snapshotSha256,
    source_reproduction: 'match',
    source_evidence: evidence,
    decision: check.decision,
    decision_stated_at: check.statedAt,
  };
}

/** Why the database refused a request it answered. */
export function refusalText(code: string, message: string): string {
  if (code === '42501') {
    return 'Permission denied: only the configured Binance owner can do this, and the database did not accept this sign-in as the owner.';
  }
  if (code === '23514') return `A value failed the database's checks (${message}).`;
  if (code === '23503') {
    return `The experiment does not accept it: its pair or account label differ, or it is not one of yours (${message}).`;
  }
  return `The database refused it (${code}: ${message}).`;
}

export type RecordOutcome =
  | { state: 'recorded'; id: string; recordedAt: string }
  /** The database answered and stored nothing. */
  | { state: 'refused'; message: string }
  /** No answer from the database: the row may or may not be stored. */
  | { state: 'unknown'; message: string };

/** Stores one experiment. `recorded` only with the ID and time the database returned. */
export async function recordSpotExperiment(row: SpotExperimentInsert): Promise<RecordOutcome> {
  try {
    const { data, error } = await supabase
      .from('spot_experiments')
      .insert(row)
      .select('id, recorded_at')
      .single();
    if (error) {
      return SERVER_ERROR_CODE.test(error.code)
        ? { state: 'refused', message: refusalText(error.code, error.message) }
        : { state: 'unknown', message: error.message };
    }
    if (typeof data?.id !== 'string' || typeof data.recorded_at !== 'string') {
      return { state: 'unknown', message: 'The database did not return the stored row.' };
    }
    return { state: 'recorded', id: data.id, recordedAt: data.recorded_at };
  } catch (error) {
    return { state: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}

/** A refused or failed read, with the database's code when it answered. */
export class ExperimentReadError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Whether the database names the signed-in user as the Binance owner. It says nothing of anyone else. */
export async function isSpotExperimentOwner(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_binance_spot_owner');
  if (error) throw new ExperimentReadError(error.message, error.code);
  return data === true;
}

export const EXPERIMENT_LIMIT = 100;

const FILL_COLUMNS =
  'id, experiment_id, recorded_at, account_label, symbol, trade_id, order_id, side, trade_time_ms, quantity, price, quote_quantity, commission, commission_asset, retrieved_at, window_start_ms, window_end_ms, coverage_complete';

const EXPERIMENT_COLUMNS = `id, recorded_at, account_label, symbol, source_scan_id, source_snapshot_sha256, source_reproduction, source_evidence, decision, decision_stated_at, spot_experiment_entries(id, kind, rule, rule_status, supersedes, statement, stated_at, recorded_at), spot_experiment_fills(${FILL_COLUMNS})`;

/** A stored fill link: the copied fill, the read it came from, and the database's own time. */
export type LinkedFill = Pick<
  Tables['spot_experiment_fills']['Row'],
  | 'id'
  | 'experiment_id'
  | 'recorded_at'
  | 'account_label'
  | 'symbol'
  | 'trade_id'
  | 'order_id'
  | 'side'
  | 'trade_time_ms'
  | 'quantity'
  | 'price'
  | 'quote_quantity'
  | 'commission'
  | 'commission_asset'
  | 'retrieved_at'
  | 'window_start_ms'
  | 'window_end_ms'
  | 'coverage_complete'
>;

export type ExperimentEntry = Pick<
  Tables['spot_experiment_entries']['Row'],
  'id' | 'kind' | 'rule' | 'rule_status' | 'supersedes' | 'statement' | 'stated_at' | 'recorded_at'
>;

export type SpotExperimentRecord = Pick<
  Tables['spot_experiments']['Row'],
  | 'id'
  | 'recorded_at'
  | 'account_label'
  | 'symbol'
  | 'source_scan_id'
  | 'source_snapshot_sha256'
  | 'source_reproduction'
  | 'source_evidence'
  | 'decision'
  | 'decision_stated_at'
> & {
  spot_experiment_entries: ExperimentEntry[];
  spot_experiment_fills: LinkedFill[];
};

export type OwnerExperiments =
  { owner: false } | { owner: true; experiments: SpotExperimentRecord[] };

/**
 * The owner's experiments, newest recorded first, each with its entries and linked fills from
 * the same read. A non-owner gets `owner: false`, never an empty list that would read as
 * "none recorded".
 */
export async function loadOwnerExperiments(userId: string): Promise<OwnerExperiments> {
  if (!(await isSpotExperimentOwner())) return { owner: false };
  const { data, error } = await supabase
    .from('spot_experiments')
    .select(EXPERIMENT_COLUMNS)
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(EXPERIMENT_LIMIT);
  if (error) throw new ExperimentReadError(error.message, error.code);
  return { owner: true, experiments: data };
}

export const NAMED_RULES = ['allocation_ceiling', 'stop', 'horizon', 'target', 'exit'] as const;
export type NamedRule = (typeof NAMED_RULES)[number];

/**
 * The current rules: rule entries no later entry replaces. A named rule is decided only by its
 * current entry, and only when that entry is approved; `other` may hold several.
 */
export function currentRules(entries: readonly ExperimentEntry[]): {
  named: Record<NamedRule, ExperimentEntry | null>;
  other: ExperimentEntry[];
} {
  const replaced = new Set(
    entries.flatMap((entry) => (entry.supersedes ? [entry.supersedes] : [])),
  );
  const approved = entries.filter(
    (entry) => entry.kind === 'rule' && entry.rule_status === 'approved' && !replaced.has(entry.id),
  );
  const named = Object.fromEntries(
    NAMED_RULES.map((rule) => [rule, approved.find((entry) => entry.rule === rule) ?? null]),
  ) as Record<NamedRule, ExperimentEntry | null>;
  return { named, other: approved.filter((entry) => entry.rule === 'other') };
}

export type SpotFillInsert = Required<
  Pick<
    Tables['spot_experiment_fills']['Insert'],
    | 'experiment_id'
    | 'account_label'
    | 'symbol'
    | 'trade_id'
    | 'order_id'
    | 'side'
    | 'trade_time_ms'
    | 'quantity'
    | 'price'
    | 'quote_quantity'
    | 'commission'
    | 'commission_asset'
    | 'retrieved_at'
    | 'window_start_ms'
    | 'window_end_ms'
    | 'coverage_complete'
  >
>;

/** The execution read a fill is copied from, as the browser holds it. */
export interface FillRead {
  /** The account label the owner gave this retrieval. */
  accountLabel: string;
  /** The function's clock for the retrieval's latest page. */
  retrievedAt: string;
  startTime: number;
  endTime: number;
  /** Complete for the requested pairs and window, as the execution view assessed it. */
  complete: boolean;
}

/**
 * The row to store: the fill exactly as the read returned it (decimal strings untouched, the
 * commission in its own asset) and the read's provenance. The ID, owner and recorded time come
 * from the database.
 */
export function fillRow(
  experimentId: string,
  execution: SpotExecution,
  read: FillRead,
): SpotFillInsert {
  return {
    experiment_id: experimentId,
    account_label: read.accountLabel,
    symbol: execution.symbol,
    trade_id: execution.tradeId,
    order_id: execution.orderId,
    side: execution.side,
    trade_time_ms: execution.time,
    quantity: execution.quantity,
    price: execution.price,
    quote_quantity: execution.quoteQuantity,
    commission: execution.commission,
    commission_asset: execution.commissionAsset,
    retrieved_at: read.retrievedAt,
    window_start_ms: read.startTime,
    window_end_ms: read.endTime,
    coverage_complete: read.complete,
  };
}

/** The experiments a fill may join: the database accepts only the same pair and account label. */
export function matchingExperiments(
  experiments: readonly SpotExperimentRecord[],
  symbol: string,
  accountLabel: string,
): SpotExperimentRecord[] {
  return experiments.filter(
    (experiment) => experiment.symbol === symbol && experiment.account_label === accountLabel,
  );
}

/** The stored link for this trade under this label, if the loaded experiments hold one. */
export function storedLink(
  experiments: readonly SpotExperimentRecord[],
  accountLabel: string,
  symbol: string,
  tradeId: string,
): { experiment: SpotExperimentRecord; fill: LinkedFill } | null {
  for (const experiment of experiments) {
    const fill = experiment.spot_experiment_fills.find(
      (item) =>
        item.account_label === accountLabel && item.symbol === symbol && item.trade_id === tradeId,
    );
    if (fill) return { experiment, fill };
  }
  return null;
}

const FILL_FIELDS: [keyof SpotFillInsert & keyof LinkedFill, string][] = [
  ['order_id', 'order ID'],
  ['side', 'side'],
  ['trade_time_ms', 'trade time'],
  ['quantity', 'quantity'],
  ['price', 'price'],
  ['quote_quantity', 'quote quantity'],
  ['commission', 'commission'],
  ['commission_asset', 'commission asset'],
];

/**
 * The fill fields in which a stored copy differs from this read, compared exactly. The read's
 * own provenance (its time, window and coverage) is expected to differ between reads.
 */
export function fillDifferences(stored: LinkedFill, row: SpotFillInsert): string[] {
  return FILL_FIELDS.filter(([key]) => stored[key] !== row[key]).map(([, name]) => name);
}

export type LinkOutcome =
  | { state: 'linked'; fill: LinkedFill }
  /** The database already holds a link for this trade; `fill` is its stored copy when it could be read. */
  | { state: 'already'; fill: LinkedFill | null }
  /** The database answered and stored nothing. */
  | { state: 'refused'; message: string }
  /** No answer from the database: the link may or may not be stored. */
  | { state: 'unknown'; message: string };

const UNIQUE_VIOLATION = '23505';

/** The stored link for one trade under one label, read after the database refused a second one. */
async function readStoredLink(row: SpotFillInsert): Promise<LinkedFill | null> {
  try {
    const { data, error } = await supabase
      .from('spot_experiment_fills')
      .select(FILL_COLUMNS)
      .eq('account_label', row.account_label)
      .eq('symbol', row.symbol)
      .eq('trade_id', row.trade_id)
      .maybeSingle();
    return error ? null : data;
  } catch {
    return null;
  }
}

/**
 * Links one fill. `linked` only with the row the database returned. The database stores one link
 * per trade and account label, so a second attempt (a retry after no answer included) is told
 * apart as `already`, never stored twice.
 */
export async function linkSpotFill(row: SpotFillInsert): Promise<LinkOutcome> {
  try {
    const { data, error } = await supabase
      .from('spot_experiment_fills')
      .insert(row)
      .select(FILL_COLUMNS)
      .single();
    if (error) {
      if (error.code === UNIQUE_VIOLATION)
        return { state: 'already', fill: await readStoredLink(row) };
      return SERVER_ERROR_CODE.test(error.code)
        ? { state: 'refused', message: refusalText(error.code, error.message) }
        : { state: 'unknown', message: error.message };
    }
    if (typeof data?.id !== 'string' || typeof data.recorded_at !== 'string') {
      return { state: 'unknown', message: 'The database did not return the stored row.' };
    }
    return { state: 'linked', fill: data };
  } catch (error) {
    return { state: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}
