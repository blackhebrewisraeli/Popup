/**
 * Reviewing one Manual Spot experiment against a saved crypto scan file the owner chose
 * (docs/MANUAL_SPOT_EXPERIMENTS.md#viewing-in-account). Pure: it reads a scan that already
 * reproduced in the browser (savedScanFile.ts) and the experiment's stored copy, and returns what
 * each side records. The stored copy is never re-derived or changed; nothing is inferred between
 * the two observations. A version 1 copy keeps its candle as a day and month without a year, so the
 * two candles are never ordered: no year is guessed from record times, scan IDs or files.
 */
import { scanStatusLabel } from '@/lib/marketScanner';
import { exactSymbol } from '@/lib/scanChanges';
import {
  candidateEvidence,
  type CandidateEvidence,
  type SpotExperimentRecord,
} from '@/lib/spotExperiments';
import { spotSymbol } from '@/lib/tradingViewSymbol';
import type { TradingViewDevScan } from '@/lib/tradingViewDevScan';

const MODEL = 'Model · timeframe';

/** The experiment's exact pair in the selected scan, or why none is shown. Never another pair. */
export type SelectedPair =
  | {
      state: 'EVALUATED';
      evidence: CandidateEvidence;
      score: number;
      /** Close time of the latest closed candle the result rests on, as the scan recorded it. */
      candleClose: number;
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
    candleClose: dataAsOf,
    evaluationTime: view.scan.evaluationTime,
  };
}

export type Comparability = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

export interface EntryComparison {
  identity: string;
  candleOrder: string;
  model: Comparability;
  modelText: string;
}

type RecordIdentity = Pick<SpotExperimentRecord, 'source_scan_id' | 'source_snapshot_sha256'>;

/** Which file this is, by its bytes and scan ID. A matching hash names the file, nothing more. */
function identityText(experiment: RecordIdentity, view: TradingViewDevScan): string {
  if (view.saved?.snapshotSha256 === experiment.source_snapshot_sha256) {
    return 'These bytes match the snapshot SHA-256 this experiment references. That identifies the file only: it does not check the copied entry facts against it.';
  }
  if (view.scanId === experiment.source_scan_id) {
    return `The same scan ID as the record, ${view.scanId}, but not the same bytes: its SHA-256 differs from the one the experiment references.`;
  }
  return `Another scan, ${view.scanId}. The experiment references ${experiment.source_scan_id}.`;
}

/**
 * Always unknown today: the copy keeps no complete candle date, so the selected candle (shown with
 * its full close time) is never placed before, after or on the entry candle.
 */
function candleOrderText(entryCandle: string | undefined, pair: SelectedPair): string {
  if (pair.state !== 'EVALUATED') {
    return 'Unknown: the selected scan has no evaluated candle for this pair.';
  }
  if (!entryCandle) return 'Unknown: the stored copy records no entry candle this view can read.';
  return `Unknown: the stored copy records the entry candle as “${entryCandle}” and keeps no complete candle date, so the two candles are not ordered.`;
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
 * What can be said about the two observations: which file this is, that their candles are not
 * ordered, and whether model and timeframe are comparable. Nothing else: no onset, recovery or
 * alert, and no claim that the copy agrees with the file.
 */
export function compareWithEntry(
  experiment: RecordIdentity,
  entry: CandidateEvidence | null,
  view: TradingViewDevScan,
  pair: SelectedPair,
): EntryComparison {
  const stored = entry ? new Map(entry.facts) : null;
  return {
    identity: identityText(experiment, view),
    candleOrder: candleOrderText(stored?.get('Evaluated'), pair),
    ...modelComparability(stored?.get(MODEL), pair),
  };
}
