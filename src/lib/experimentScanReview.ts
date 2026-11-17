/**
 * Reviewing one Manual Spot experiment against a saved crypto scan file the owner chose
 * (docs/MANUAL_SPOT_EXPERIMENTS.md#viewing-in-account). Pure: it reads a scan that already
 * reproduced in the browser (savedScanFile.ts) and the experiment's stored copy, and returns what
 * each side records. The stored copy is never re-derived or changed; nothing is inferred between
 * the two observations.
 */
import { scanStatusLabel } from '@/lib/marketScanner';
import { exactSymbol } from '@/lib/scanChanges';
import { resultAsOfLabel } from '@/lib/scanReview';
import {
  candidateEvidence,
  type CandidateEvidence,
  type SpotExperimentRecord,
} from '@/lib/spotExperiments';
import { spotSymbol } from '@/lib/tradingViewSymbol';
import type { TradingViewDevScan } from '@/lib/tradingViewDevScan';

const DAY = 86_400_000;
const MODEL = 'Model · timeframe';

/** The experiment's exact pair in the selected scan, or why none is shown. Never another pair. */
export type SelectedPair =
  | {
      state: 'EVALUATED';
      evidence: CandidateEvidence;
      score: number;
      /** UTC day number of the candle the result rests on. */
      candleDay: number;
      evaluationTime: number;
    }
  | { state: 'MISSING' | 'AMBIGUOUS' | 'NOT_EVALUATED' | 'UNREADABLE'; reason: string };

/**
 * Finds the pair by its validated instrument only (`BINANCE:<symbol>`, requested and confirmed by
 * TradingView), never by ticker resemblance, and words its evidence exactly as a recorded copy is
 * worded (`candidateEvidence`), with freshness judged at `now`.
 */
export function selectedPair(view: TradingViewDevScan, symbol: string, now: number): SelectedPair {
  const matches = view.scan.results.filter(
    (result) => result.instrument !== null && spotSymbol(result.instrument) === symbol,
  );
  const [result] = matches;
  if (!result) {
    return {
      state: 'MISSING',
      reason: `${symbol} is not in this scan. No other pair is shown in its place.`,
    };
  }
  if (matches.length > 1) {
    return {
      state: 'AMBIGUOUS',
      reason: `${matches.length} results in this scan name ${symbol}, so none of them is shown.`,
    };
  }
  if (exactSymbol(result) !== result.instrument) {
    return {
      state: 'UNREADABLE',
      reason: `TradingView did not confirm ${symbol} as the exact symbol in this scan, so nothing from it is shown.`,
    };
  }
  if (result.status !== 'EVALUATED') {
    const detail = result.detail ? ` ${result.detail.replace(/\.?$/, '.')}` : '';
    return {
      state: 'NOT_EVALUATED',
      reason: `${symbol} was not evaluated in this scan: ${scanStatusLabel(result)}.${detail} No evidence for it is shown, and no other pair is shown in its place.`,
    };
  }
  const cohort = view.scan.cohorts.find((item) => item.assetClass === result.assetClass);
  const { model, setups, dataAsOf } = result;
  if (!model || !setups || result.rank === null || dataAsOf === null || !cohort) {
    return {
      state: 'UNREADABLE',
      reason: `This scan records ${symbol} as evaluated without a complete result, so nothing from it is shown.`,
    };
  }
  return {
    state: 'EVALUATED',
    evidence: candidateEvidence({
      result,
      model,
      setups,
      cohort,
      scan: view.scan,
      scanId: view.scanId,
      source: view.source,
      now,
    }),
    score: model.signal_score,
    candleDay: Math.floor(dataAsOf / DAY),
    evaluationTime: view.scan.evaluationTime,
  };
}

/**
 * The UTC day of the entry candle. The copy stores it as day and month only ("13 Nov candle
 * (UTC)"); the candle closed before the copy was recorded, so this is the latest day at or before
 * the record time with that label. Null when the stored text is not a label this view writes.
 */
export function entryCandleDay(stored: string | undefined, recordedAt: string): number | null {
  const last = Math.floor(Date.parse(recordedAt) / DAY);
  if (!stored || !Number.isFinite(last)) return null;
  for (let day = last; day > last - 366; day--) {
    if (resultAsOfLabel({ assetClass: 'crypto', dataAsOf: day * DAY }) === stored) return day;
  }
  return null;
}

export const isoDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);

export type Chronology = 'ORIGINAL' | 'SAME_CANDLE' | 'LATER' | 'EARLIER' | 'UNKNOWN';
export type Comparability = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

export interface EntryComparison {
  identity: string;
  chronology: Chronology;
  chronologyText: string;
  model: Comparability;
  modelText: string;
}

const YEAR_NOTE =
  ' The copy keeps the entry candle’s day and month only; its year is the latest at or before the record time.';

type RecordIdentity = Pick<
  SpotExperimentRecord,
  'recorded_at' | 'source_scan_id' | 'source_snapshot_sha256'
>;

function identityText(
  experiment: RecordIdentity,
  view: TradingViewDevScan,
  original: boolean,
): string {
  if (original) {
    return 'The exact bytes this experiment was recorded from (the SHA-256 matches): the same scan and the same evidence, not new evidence.';
  }
  if (view.scanId === experiment.source_scan_id) {
    return `The same scan ID as the record, ${view.scanId}, but not the same bytes: its SHA-256 differs from the recorded one.`;
  }
  return `Another scan, ${view.scanId}. The record’s scan is ${experiment.source_scan_id}.`;
}

/** The two candles' order, from candle days only. */
function candleOrder(
  entryDay: number | null,
  pair: SelectedPair,
  original: boolean,
): { chronology: Chronology; chronologyText: string } {
  if (original) {
    return {
      chronology: 'ORIGINAL',
      chronologyText:
        'Same candle: this is the snapshot the experiment was recorded from. Not new evidence or a new signal.',
    };
  }
  if (pair.state !== 'EVALUATED') {
    return {
      chronology: 'UNKNOWN',
      chronologyText: 'Unknown: the pair has no evaluated candle in the selected scan.',
    };
  }
  if (entryDay === null) {
    return {
      chronology: 'UNKNOWN',
      chronologyText:
        'Unknown: the stored copy does not give its evaluated candle in a form this view can place.',
    };
  }
  const days = `entry ${isoDay(entryDay)}, selected ${isoDay(pair.candleDay)} (UTC days)`;
  if (pair.candleDay === entryDay) {
    return {
      chronology: 'SAME_CANDLE',
      chronologyText: `Same candle as the entry evidence (${days}): another scan of it, not new evidence or a new signal.${YEAR_NOTE}`,
    };
  }
  return pair.candleDay > entryDay
    ? {
        chronology: 'LATER',
        chronologyText: `The selected candle is later than the entry candle (${days}). Two observations: nothing here says when or whether anything changed between them.${YEAR_NOTE}`,
      }
    : {
        chronology: 'EARLIER',
        chronologyText: `The selected candle is earlier than the entry candle (${days}): older than the evidence the experiment was recorded from, not new evidence.${YEAR_NOTE}`,
      };
}

/** Model and timeframe, compared only when the copy states them as `<model> · <timeframe>`. */
function modelComparability(
  entryModel: string | undefined,
  pair: SelectedPair,
): { model: Comparability; modelText: string } {
  if (pair.state !== 'EVALUATED') {
    return {
      model: 'UNKNOWN',
      modelText: 'Unknown: the selected scan gives no evaluated result for this pair.',
    };
  }
  const selectedModel = new Map(pair.evidence.facts).get(MODEL);
  const parts = entryModel?.split(' · ') ?? [];
  if (!entryModel || parts.length !== 2 || parts.some((part) => part.trim() === '')) {
    return {
      model: 'UNKNOWN',
      modelText:
        'Unknown: the stored copy does not establish its model and timeframe in a form this view can read.',
    };
  }
  return entryModel === selectedModel
    ? {
        model: 'SAME',
        modelText: `Same model and timeframe as the entry evidence (${entryModel}).`,
      }
    : {
        model: 'DIFFERENT',
        modelText: `Different: entry ${entryModel}, selected ${selectedModel}. The two are not comparable as one measurement.`,
      };
}

/**
 * What can be said about the two observations: whether the file is the record's own snapshot,
 * how the two candles are ordered (from candle days only, never file names or file times), and
 * whether model and timeframe are comparable. Nothing else: no onset, recovery or alert.
 */
export function compareWithEntry(
  experiment: RecordIdentity,
  entry: CandidateEvidence | null,
  view: TradingViewDevScan,
  pair: SelectedPair,
): EntryComparison {
  const original = view.saved?.snapshotSha256 === experiment.source_snapshot_sha256;
  const stored = entry ? new Map(entry.facts) : null;
  const entryDay = entryCandleDay(stored?.get('Evaluated'), experiment.recorded_at);
  return {
    identity: identityText(experiment, view, original),
    ...candleOrder(entryDay, pair, original),
    ...modelComparability(stored?.get(MODEL), pair),
  };
}
