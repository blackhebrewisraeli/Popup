import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Fact } from '@/components/MarketScanSummary';
import type { Asset } from '@/lib/assets';
import { useAuth } from '@/lib/authStore';
import {
  DISCOVERY_POLICY,
  DISCOVERY_POLICY_ID,
  discoveryFeedState,
  slotForDate,
  verifyDiscoveryBatch,
  type DiscoveryAttemptStatus,
  type DiscoveryCategory,
  type DiscoveryEvidence,
  type DiscoveryFeedState,
  type DiscoveryMember,
  type DiscoveryResult,
  type DiscoveryVerification,
} from '@/lib/dailyDiscovery';
import { ageLabel, UTC_TIME } from '@/lib/scanReview';
import { isSpotExperimentOwner } from '@/lib/spotExperiments';
import { supabase } from '@/lib/supabaseClient';
import { toBinanceSymbol } from '@/lib/ticker';
import { cn } from '@/lib/utils';

const BATCH_COLUMNS =
  'policy_id, slot_date, collected_at, status, member_count, evidence, evidence_sha256';
const ATTEMPT_COLUMNS = 'attempt_id, slot_date, started_at, finished_at, status, failure_code';

type Attempt = {
  attempt_id: string;
  slot_date: string;
  started_at: string;
  finished_at: string;
  status: string;
  failure_code: string | null;
};

interface DailyFeed {
  batchDate: string | null;
  verification: DiscoveryVerification | null;
  attempt: Attempt | null;
}

/** The newest batch and the newest attempt; the batch is verified before anything shows it. */
async function readDailyFeed(): Promise<DailyFeed> {
  const [batches, attempts] = await Promise.all([
    supabase
      .from('discovery_batches')
      .select(BATCH_COLUMNS)
      .eq('policy_id', DISCOVERY_POLICY_ID)
      .order('slot_date', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(15_000)),
    supabase
      .from('discovery_attempts')
      .select(ATTEMPT_COLUMNS)
      .eq('policy_id', DISCOVERY_POLICY_ID)
      .order('finished_at', { ascending: false })
      .limit(1)
      .abortSignal(AbortSignal.timeout(15_000)),
  ]);
  if (batches.error) throw new Error(batches.error.message);
  if (attempts.error) throw new Error(attempts.error.message);
  const batch = batches.data[0] ?? null;
  return {
    batchDate: batch?.slot_date ?? null,
    verification: batch ? await verifyDiscoveryBatch(batch) : null,
    attempt: attempts.data[0] ?? null,
  };
}

/** Re-renders each minute so the freshness state crosses its bounds without a reload. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const FEED_LABEL: Record<DiscoveryFeedState, string> = {
  current: 'Current',
  awaiting: 'Today’s batch not in yet',
  'attempt-failed': 'Today’s attempt failed',
  stale: 'Stale',
  missing: 'No batch to show',
};

const FEED_TONE: Record<DiscoveryFeedState, string | undefined> = {
  current: undefined,
  awaiting: 'market-scan-partial',
  'attempt-failed': 'market-scan-failed',
  stale: 'market-scan-partial',
  missing: 'market-scan-failed',
};

const FEED_DETAIL: Record<DiscoveryFeedState, string> = {
  current: 'The latest slot’s batch.',
  awaiting:
    'This is the previous slot’s batch: today’s 00:30 UTC collection has not stored one yet. It may retry until 06:00 UTC.',
  'attempt-failed':
    'This is the previous slot’s batch: today’s collection failed. It may retry until 06:00 UTC.',
  stale:
    'Older than the daily bound: the next slot’s 06:00 UTC deadline passed without a newer batch.',
  missing: 'No daily batch has been stored yet.',
};

const ATTEMPT_LABEL: Record<DiscoveryAttemptStatus, string> = {
  complete: 'Collected',
  partial: 'Collected, partial',
  empty: 'Collected, no eligible pair',
  already_collected: 'Already collected; nothing fetched',
  unchanged: 'Identical retry; batch kept',
  conflict: 'Conflicting retry; first batch kept',
  failed: 'Failed',
  missed: 'Missed: started after 06:00 UTC',
};

const CATEGORY_LABEL: Record<DiscoveryCategory, string> = {
  'duplicate-exposure': 'Wrapped or staked receipt',
  'tokenized-commodity': 'Tokenized commodity',
  unclassified: 'Not classified',
};

const EXCLUSION_LABEL: Record<DiscoveryResult['exclusions'][number]['reason'], string> = {
  NOT_TRADING: 'Not trading (status other than TRADING)',
  SPOT_TRADING_NOT_ALLOWED: 'Spot trading not allowed',
  STABLECOIN_BASE: 'Stablecoin base asset (crypto-usdt-v1 record)',
  TICKER_MISSING: 'No 24h figure in the response',
  TICKER_DUPLICATE: '24h figure listed twice',
  QUOTE_VOLUME_INVALID: 'Quote volume not a decimal',
  WINDOW_INVALID: 'Window not exactly 24 hours',
  WINDOW_OUTDATED: 'Window ended over an hour before the cutoff',
  WINDOW_IN_FUTURE: 'Window ends after the response arrived',
};

const UTC_SECONDS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** "1,234,567,890" from Binance's exact decimal string: grouped, the fraction dropped, no float. */
function wholeUnits(decimal: string): string {
  return BigInt(decimal.split('.')[0] ?? '0').toLocaleString('en-US');
}

function attemptLabel(status: string): string {
  return ATTEMPT_LABEL[status as DiscoveryAttemptStatus] ?? status;
}

/** Popup's asset whose Binance symbol is exactly this pair; none means no detail route. */
function assetFor(symbol: string, assets: readonly Asset[]): Asset | undefined {
  return assets.find((asset) => toBinanceSymbol(asset.ticker) === symbol);
}

function CandidateRow({
  member,
  ranked,
  asset,
  noAsset,
  onOpenAsset,
}: Readonly<{
  member: DiscoveryMember;
  ranked: number;
  asset: Asset | undefined;
  /** Why there is no detail route, when `asset` is undefined. */
  noAsset: string;
  onOpenAsset: (asset: Asset) => void;
}>) {
  return (
    <tr>
      <td className="discovery-rank">#{member.rank}</td>
      <td>
        <span className="discovery-symbol">{member.symbol}</span>
        <span className="market-scan-sub block">Binance Spot · {member.baseAsset}/USDT</span>
      </td>
      <td className="discovery-number" title={`${member.quoteVolume} USDT, exactly as reported`}>
        {wholeUnits(member.quoteVolume)}
        <span className="market-scan-sub block">
          24h to {UTC_SECONDS.format(member.windowCloseTime)} UTC
        </span>
      </td>
      <td>
        Rank {member.rank} of {ranked} eligible pairs by rolling 24h quote volume
      </td>
      <td className={cn(member.category === 'unclassified' && 'text-muted-foreground')}>
        {CATEGORY_LABEL[member.category]}
      </td>
      <td>
        {asset ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={`Open ${asset.ticker} details (${member.symbol})`}
            onClick={() => onOpenAsset(asset)}
          >
            {asset.ticker}
          </Button>
        ) : (
          <span className="text-muted-foreground" title={noAsset}>
            —<span className="sr-only">{noAsset}</span>
          </span>
        )}
      </td>
    </tr>
  );
}

function Exclusions({ result }: Readonly<{ result: DiscoveryResult }>) {
  const groups = new Map<string, string[]>();
  for (const { symbol, reason } of result.exclusions) {
    groups.set(reason, [...(groups.get(reason) ?? []), symbol]);
  }
  if (groups.size === 0 && result.coverage.malformed === 0) return null;
  return (
    <details className="market-scan-coverage discovery-exclusions">
      <summary className="market-scan-label">
        Excluded or unranked USDT pairs ({result.exclusions.length})
      </summary>
      <ul className="market-scan-list market-scan-notes">
        {[...groups].map(([reason, symbols]) => (
          <li key={reason}>
            <strong>
              {EXCLUSION_LABEL[reason as keyof typeof EXCLUSION_LABEL] ?? reason} ({symbols.length})
            </strong>
            <span className="discovery-symbol-list"> {symbols.join(', ')}</span>
          </li>
        ))}
        {result.coverage.malformed > 0 && (
          <li>
            <strong>Unreadable exchangeInfo entries ({result.coverage.malformed})</strong>: their
            pair could not be identified, so none of them is listed or ranked.
          </li>
        )}
      </ul>
    </details>
  );
}

function BatchNotes({ evidence }: Readonly<{ evidence: DiscoveryEvidence }>) {
  const { status, coverage } = evidence.result;
  if (status === 'EMPTY') {
    return (
      <output className="market-scan-empty block">
        Collection succeeded and no USDT pair was eligible, so this date has no candidates. This is
        a recorded result, not a failed collection.
      </output>
    );
  }
  if (status === 'PARTIAL') {
    return (
      <p className="market-scan-fit scan-stale" role="note">
        Partial batch: {coverage.invalid} eligible{' '}
        {coverage.invalid === 1 ? 'pair has' : 'pairs have'} no valid 24h figure
        {coverage.malformed > 0 &&
          ` and ${coverage.malformed} exchangeInfo entries were unreadable`}
        . They are not ranked and nothing stands in for them, so a pair among them may belong in the
        list.
      </p>
    );
  }
  return null;
}

function CandidatesTable({
  evidence,
  assets,
  onOpenAsset,
}: Readonly<{
  evidence: DiscoveryEvidence;
  assets: readonly Asset[] | null;
  onOpenAsset: (asset: Asset) => void;
}>) {
  const { members, coverage } = evidence.result;
  if (members.length === 0) return null;
  const noAsset =
    assets === null
      ? 'Live market data is not loaded, so no asset detail is linked'
      : 'No Popup asset maps to this exact pair';
  return (
    <section
      className="scan-compare-scroll"
      aria-label="Candidates, scrollable"
      tabIndex={0} // NOSONAR(S6845): a scrollable region must take focus so the keyboard can scroll it
    >
      <table className="discovery-table">
        <caption className="sr-only">
          Daily candidates for {evidence.slot.date}, by rolling 24-hour quote volume
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Pair</th>
            <th scope="col">24h quote volume (USDT)</th>
            <th scope="col">Why included</th>
            <th scope="col">Category</th>
            <th scope="col">Asset detail</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <CandidateRow
              key={member.symbol}
              member={member}
              ranked={coverage.ranked}
              asset={assets === null ? undefined : assetFor(member.symbol, assets)}
              noAsset={noAsset}
              onOpenAsset={onOpenAsset}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AttemptFact({ attempt }: Readonly<{ attempt: Attempt | null }>) {
  if (!attempt) return <Fact label="Latest attempt" value="None recorded" />;
  const late =
    Date.parse(attempt.started_at) - Date.parse(slotForDate(attempt.slot_date).scheduledFor);
  return (
    <Fact
      label="Latest attempt"
      value={attemptLabel(attempt.status)}
      detail={[
        `slot ${attempt.slot_date}`,
        attempt.failure_code,
        `started ${UTC_TIME.format(Date.parse(attempt.started_at))} UTC (${ageLabel(late)} after the slot)`,
      ]
        .filter(Boolean)
        .join(' · ')}
    />
  );
}

function Board({
  feed,
  assets,
  onOpenAsset,
}: Readonly<{
  feed: DailyFeed;
  assets: readonly Asset[] | null;
  onOpenAsset: (asset: Asset) => void;
}>) {
  const now = useMinuteClock();
  const verified = feed.verification?.ok ? feed.verification.evidence : null;
  const refused = feed.verification && !feed.verification.ok ? feed.verification.reason : null;
  // A refused batch is never current: the feed then has no batch to show.
  const state = discoveryFeedState(verified ? feed.batchDate : null, feed.attempt, now);
  const collected = verified ? Date.parse(verified.collection.ticker.receivedAt) : null;
  return (
    <section className="market-scan daily-candidates" aria-label="Daily candidates">
      <header className="market-scan-head">
        <div className="market-scan-heading">
          <h2 className="market-scan-title">Daily candidates</h2>
          <p className="market-scan-state">
            <span className={cn('market-scan-status', FEED_TONE[state])}>{FEED_LABEL[state]}</span>
            {verified?.result.status === 'PARTIAL' && (
              <span className="market-scan-status market-scan-partial">Partial</span>
            )}
            {refused && (
              <span className="market-scan-status market-scan-failed">Failed verification</span>
            )}
            {feed.batchDate && collected !== null && (
              <span>
                Batch {feed.batchDate} · collected {UTC_TIME.format(collected)} UTC
              </span>
            )}
          </p>
        </div>
        <div className="scan-viewing is-saved" role="note" aria-label="What this view shows">
          <p className="scan-viewing-title">
            <strong>Discovery candidates</strong> <span>not signals, not scores</span>
          </p>
          <p>
            Binance Spot USDT pairs ranked by Binance&rsquo;s rolling 24-hour quote volume when the
            batch was collected: a liquidity-based shortlist to investigate later, not a BUY/SELL
            signal, a model score or evidence of profitability.
          </p>
          <p className="market-scan-sub">
            Collected unattended once a day for the 00:30 UTC slot from Binance&rsquo;s public Spot
            market data; it does not refresh between batches and shows no prices. The 24-hour window
            is rolling, not a UTC calendar day. Saved TradingView scans are a separate source: open
            one under Model scan (1D). They are owner-session imports and are not collected daily.
          </p>
        </div>
        <dl className="market-scan-stats">
          <Fact
            label="Batch date"
            value={feed.batchDate ?? 'None'}
            detail={
              verified &&
              `Slot 00:30 UTC; ticker received ${UTC_SECONDS.format(collected ?? 0)} UTC, ${ageLabel(
                (collected ?? 0) - Date.parse(verified.slot.scheduledFor),
              )} after the slot`
            }
          />
          <Fact
            label="Source"
            value="Binance Spot public REST"
            detail="exchangeInfo and 24hr ticker (MINI)"
          />
          <Fact
            label="Policy"
            value={DISCOVERY_POLICY_ID}
            detail={`${DISCOVERY_POLICY.kind}; top ${DISCOVERY_POLICY.ranking.maxMembers}`}
          />
          {verified && (
            <Fact
              label="Coverage"
              value={`${verified.result.coverage.selected} of ${verified.result.coverage.eligible} eligible`}
              detail={[
                `${verified.result.coverage.usdtQuoted} USDT pairs listed`,
                `${verified.result.coverage.notTrading} not trading`,
                `${verified.result.coverage.stablecoin} stablecoin bases`,
                `${verified.result.coverage.invalid} without a valid 24h figure`,
                verified.result.coverage.malformed > 0 &&
                  `${verified.result.coverage.malformed} unreadable`,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          )}
          <Fact
            label="Batch age"
            value={collected === null ? '—' : ageLabel(now - collected)}
            detail={refused ? 'The latest batch failed verification.' : FEED_DETAIL[state]}
          />
          <AttemptFact attempt={feed.attempt} />
        </dl>
      </header>
      {refused && (
        <div role="alert" className="error-banner">
          <span>
            The {feed.batchDate} batch failed verification: {refused}. Its candidates are not shown,
            and no earlier batch is shown in its place.
          </span>
        </div>
      )}
      {verified && <BatchNotes evidence={verified} />}
      {verified && (
        <CandidatesTable evidence={verified} assets={assets} onOpenAsset={onOpenAsset} />
      )}
      {verified && <Exclusions result={verified.result} />}
    </section>
  );
}

/**
 * Research › Daily candidates: the latest verified batch from the unattended collector, with
 * its freshness and the latest attempt. Owner-only during the private beta, as the database
 * enforces. Never falls back to sample assets, assets_status or an older batch.
 */
export function DailyCandidates({
  assets,
  onOpenAsset,
}: Readonly<{
  /**
   * Live assets_status rows only, never sample data: they give the exact-symbol detail route.
   * Null while live market data is not loaded; the board shows the same without detail links.
   */
  assets: readonly Asset[] | null;
  onOpenAsset: (asset: Asset) => void;
}>) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const owner = useQuery({
    queryKey: ['binance-spot-owner', userId],
    queryFn: isSpotExperimentOwner,
    enabled: userId !== null,
    retry: false,
  });
  const feed = useQuery({
    queryKey: ['daily-discovery', DISCOVERY_POLICY_ID, userId],
    queryFn: readDailyFeed,
    enabled: owner.data === true,
    retry: 1,
    refetchInterval: 10 * 60_000,
  });
  if (userId === null || owner.isPending) {
    return (
      <output className="market-scan-fit" aria-busy="true">
        Checking whether this sign-in may read daily candidates…
      </output>
    );
  }
  if (owner.isError) {
    return (
      <div role="alert" className="error-banner">
        <span>Couldn&rsquo;t check access to daily candidates ({owner.error.message}).</span>
        <Button variant="outline" size="sm" onClick={() => void owner.refetch()}>
          Check again
        </Button>
      </div>
    );
  }
  if (!owner.data) {
    return (
      <section className="market-scan" aria-label="Daily candidates">
        <header className="market-scan-head">
          <h2 className="market-scan-title">Daily candidates</h2>
          <p className="market-scan-empty">
            During the private beta, daily candidates are visible only to the configured owner.
          </p>
        </header>
      </section>
    );
  }
  if (feed.isPending) {
    return <div aria-busy="true" aria-label="Loading daily candidates" className="skeleton h-64" />;
  }
  if (feed.isError) {
    return (
      <div role="alert" className="error-banner">
        <span>
          Couldn&rsquo;t read daily batches ({feed.error.message}). Nothing is shown in their place.
        </span>
        <Button variant="outline" size="sm" onClick={() => void feed.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <Board feed={feed.data} assets={assets} onOpenAsset={onOpenAsset} />;
}
