import { SERVER_ERROR_CODE } from '@/lib/db';
import {
  ExperimentReadError,
  refusalText,
  type CandidateEvidence,
  type RecordOutcome,
} from '@/lib/spotExperiments';
import { supabase } from '@/lib/supabaseClient';

export const NO_ENTRY_LIMIT = 100;

export const noEntryQueryKey = (userId: string) => ['spot-no-entry-decisions', userId] as const;

export type NoEntrySubmission = {
  id: string;
  symbol: string;
  source_scan_id: string;
  source_snapshot_sha256: string;
  source_evidence: CandidateEvidence;
  reason: string;
};

export async function recordNoEntry(
  row: NoEntrySubmission,
  userId: string,
): Promise<RecordOutcome> {
  try {
    const inserted = await supabase
      .from('spot_no_entry_decisions')
      .insert(row)
      .select('id, recorded_at')
      .single();

    const duplicate = inserted.error?.code === '23505';
    if (inserted.error && !duplicate) {
      const { code, message } = inserted.error;
      return SERVER_ERROR_CODE.test(code)
        ? { state: 'refused', message: refusalText(code, message) }
        : { state: 'unknown', message };
    }

    let confirmed = inserted.data;
    if (duplicate) {
      // A previous attempt may have committed even if the browser got no answer.
      const { data, error } = await supabase
        .from('spot_no_entry_decisions')
        .select('id, recorded_at, symbol, source_scan_id, source_snapshot_sha256, reason')
        .eq('user_id', userId)
        .eq('id', row.id)
        .maybeSingle();
      if (error) return { state: 'unknown', message: error.message };
      confirmed =
        data?.symbol === row.symbol &&
        data.source_scan_id === row.source_scan_id &&
        data.source_snapshot_sha256 === row.source_snapshot_sha256 &&
        data.reason === row.reason
          ? data
          : null;
    }

    if (confirmed?.id !== row.id || typeof confirmed.recorded_at !== 'string') {
      return { state: 'unknown', message: 'The database did not confirm the stored decision.' };
    }
    return { state: 'recorded', id: confirmed.id, recordedAt: confirmed.recorded_at };
  } catch (error) {
    return { state: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadNoEntryDecisions(userId: string) {
  const { data, error } = await supabase
    .from('spot_no_entry_decisions')
    .select(
      'id, recorded_at, symbol, source_scan_id, source_snapshot_sha256, source_evidence, reason',
    )
    .eq('user_id', userId)
    .order('recorded_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(NO_ENTRY_LIMIT);
  if (error) throw new ExperimentReadError(error.message, error.code);
  return data;
}
