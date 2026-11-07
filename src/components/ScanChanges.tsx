import { useId, type ReactNode } from 'react';
import {
  scoreCounts,
  setupCounts,
  setupMoved,
  type AssetChange,
  type ScanComparison,
  type ScanSide,
  type SessionGap,
} from '@/lib/scanChanges';
import type { TradingViewDevBaselineSearch, TradingViewDevScan } from '@/lib/tradingViewDevScan';
import { cn } from '@/lib/utils';

const DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

/** "29 Oct" for the New York session 2026-10-29. */
function day(session: string): string {
  return DAY.format(Date.parse(`${session}T12:00:00Z`));
}

function sideLabel(side: ScanSide): string {
  const session = side.session ? `${day(side.session)} session (New York)` : 'No evaluated session';
  const incomplete = side.status === 'COMPLETE' ? '' : ', incomplete';
  return `${session} · ${side.evaluated} of ${side.supported} evaluated${incomplete}`;
}

function gapNote(gap: SessionGap, before: ScanSide): string {
  if (gap.kind === 'NONE') {
    return 'One scan evaluated no asset, so there is no pair of readings to compare.';
  }
  if (gap.kind === 'SAME') {
    return 'Both rest on the same session: the later import retrieved it again, so any difference is a revision of that session’s data, not a new session.';
  }
  if (gap.kind === 'NEXT') {
    return 'Consecutive sessions. Each setup is a standing condition on its own session; a change here is not an alert that fired.';
  }
  const count = gap.skipped.length;
  const first = day(gap.skipped[0]!);
  const span = count === 1 ? first : `${first}–${day(gap.skipped.at(-1)!)}`;
  const sessions = count === 1 ? '1 session' : `${count} sessions`;
  const were = count === 1 ? 'was' : 'were';
  return `${sessions} between them (${span}) ${were} never evaluated, so a change could have happened on any session after ${day(before.session!)}. These are two readings, not when anything changed, and not an alert.`;
}

const SETUP_NAME = { long: 'Long setup', risk: 'Risk warning' } as const;
/** [across sessions, within one session]: a same-session difference is a revision. */
const MOVE_WORDS = {
  APPEARED: ['appeared', 'holds after revision'],
  CLEARED: ['cleared', 'gone after revision'],
} as const;

function SetupMoves({ change }: Readonly<{ change: AssetChange }>) {
  const revised = change.sessions.before === change.sessions.after ? 1 : 0;
  return (['long', 'risk'] as const).map((setup) => {
    const state = change[setup];
    if (state !== 'APPEARED' && state !== 'CLEARED') return null;
    return (
      <span key={setup} className={cn('market-scan-tag', state === 'APPEARED' && `is-${setup}`)}>
        {SETUP_NAME[setup]} {MOVE_WORDS[state][revised]}
      </span>
    );
  });
}

/** "Score 45 → 27 (−18)": the two recorded values, described, never graded. */
function scoreLabel({ before, after }: AssetChange['score']): string {
  const delta = after - before;
  const moved = delta > 0 ? `+${delta}` : `−${-delta}`;
  return `Score ${before} → ${after} (${delta === 0 ? 'unchanged' : moved})`;
}

function ChangeRow({
  change,
  symbol,
  sessions,
  selected,
  wide,
  evidenceId,
  onSelect,
  children,
}: Readonly<{
  change: AssetChange;
  symbol: string | undefined;
  /** The comparison's session pair; an asset resting on others says so. */
  sessions: { before: string | null; after: string | null };
  selected: boolean;
  wide: boolean;
  evidenceId: string;
  onSelect: (ticker: string, opener: HTMLElement) => void;
  children?: ReactNode;
}>) {
  const own = change.sessions;
  const elsewhere = own.before !== sessions.before || own.after !== sessions.after;
  return (
    <li>
      <button
        type="button"
        className={cn('scan-changes-row', selected && 'is-selected')}
        aria-current={selected ? 'true' : undefined}
        aria-controls={wide ? evidenceId : undefined}
        aria-haspopup={wide ? undefined : 'dialog'}
        onClick={(event) => onSelect(change.ticker, event.currentTarget)}
      >
        <span className="market-scan-ticker">{change.ticker}</span>
        {symbol && <span className="scan-row-symbol">{symbol}</span>}
        {children}
        <span className="market-scan-fit">{scoreLabel(change.score)}</span>
        {elsewhere && (
          <span className="market-scan-fit">
            Rests on {day(own.before)} and {day(own.after)}
          </span>
        )}
      </button>
    </li>
  );
}

function Sides({ before, after }: Readonly<{ before: ScanSide; after: ScanSide }>) {
  return (
    <dl className="scan-facts">
      {(
        [
          ['Baseline', before],
          ['Displayed', after],
        ] as const
      ).map(([name, side]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd className="font-mono">{side.scanId}</dd>
          <dd className="market-scan-fit">{sideLabel(side)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The view's record of how its baseline was chosen, or why there is none. */
export type BaselineChoice = Readonly<Pick<TradingViewDevScan, 'baseline' | 'baselineSearch'>>;

function passedOver(search: TradingViewDevBaselineSearch | undefined): string {
  const skipped = search?.skipped ?? [];
  if (skipped.length === 0) return '';
  return ` Passed over: ${skipped.map(({ scanId, reason }) => `${scanId} (${reason})`).join('; ')}.`;
}

function ChosenBy({ choice }: Readonly<{ choice: BaselineChoice | undefined }>) {
  if (!choice?.baseline) return null;
  return (
    <p className="market-scan-fit scan-changes-note">
      {choice.baseline.chosenBy === 'tradingview-finish'
        ? 'Chosen by tradingview-finish: the most recent import of an earlier session that is comparable and reproduces.'
        : 'Named by the owner with tradingview-baseline.'}
      {passedOver(choice.baselineSearch)}
    </p>
  );
}

function counts(record: Record<string, number>, names: Record<string, string>): string {
  return Object.entries(names)
    .map(([key, name]) => `${record[key]} ${name}`)
    .join(' · ');
}

/**
 * "Changes since previous scan" in the TradingView review: the displayed import
 * against the earlier one the owner named. Two readings side by side, never a
 * timeline or an alert; an asset evaluated in only one scan is never read as a
 * setup that appeared or cleared. Selecting a changed asset opens its evidence.
 */
export function ScanChanges({
  comparison,
  choice,
  symbols,
  selected,
  wide,
  evidenceId,
  onSelect,
}: Readonly<{
  comparison: ScanComparison;
  choice?: BaselineChoice | undefined;
  symbols: Readonly<Record<string, string>>;
  selected: string | null;
  wide: boolean;
  evidenceId: string;
  onSelect: (ticker: string, opener: HTMLElement) => void;
}>) {
  const titleId = useId();
  let body: ReactNode;
  const search = choice?.baselineSearch;
  if (comparison.status === 'NO_BASELINE' && search?.reason) {
    body = (
      <p className="market-scan-empty">
        No comparison is shown: {search.reason}.{passedOver(search)} To compare with a particular
        import, name it with <code>npm run evaluate -- tradingview-baseline SCAN_ID</code>.
      </p>
    );
  } else if (comparison.status === 'NO_BASELINE') {
    body = (
      <p className="market-scan-empty">
        No earlier scan is named, so nothing is compared. Name one earlier TradingView import from
        the scan store with <code>npm run evaluate -- tradingview-baseline SCAN_ID</code>; importing
        a scan clears it.
      </p>
    );
  } else if (comparison.status === 'INCOMPATIBLE') {
    body = (
      <>
        <Sides before={comparison.before} after={comparison.after} />
        <ChosenBy choice={choice} />
        <p className="market-scan-fit scan-changes-note">
          Not comparable: readings taken under different terms are different measurements, so no
          setup or score change is shown.
        </p>
        <div
          className="scan-compare-scroll"
          role="region"
          tabIndex={0} // NOSONAR(S6845): a scrollable region must take focus so the keyboard can scroll it
          aria-label="What differs, scrolls sideways on narrow screens"
        >
          <table className="scan-compare-table">
            <thead>
              <tr>
                <th scope="col">Recorded</th>
                <th scope="col">Baseline</th>
                <th scope="col">Displayed</th>
              </tr>
            </thead>
            <tbody>
              {comparison.differences.map((difference) => (
                <tr key={difference.field}>
                  <th scope="row">{difference.field}</th>
                  <td>{difference.before}</td>
                  <td>{difference.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  } else {
    const { before, after, gap, changes, onlyAfter, onlyBefore, neither } = comparison;
    const moved = changes.filter(setupMoved);
    const row = (change: AssetChange, children?: ReactNode) => (
      <ChangeRow
        key={change.ticker}
        change={change}
        symbol={symbols[change.ticker]}
        sessions={{ before: before.session, after: after.session }}
        selected={selected === change.ticker}
        wide={wide}
        evidenceId={evidenceId}
        onSelect={onSelect}
      >
        {children}
      </ChangeRow>
    );
    const setupNames = { APPEARED: 'appeared', CLEARED: 'cleared', HELD: 'held in both' };
    const scores = scoreCounts(changes);
    body = (
      <>
        <Sides before={before} after={after} />
        <ChosenBy choice={choice} />
        <p className="market-scan-fit scan-changes-note">{gapNote(gap, before)}</p>
        <dl className="scan-facts">
          <div>
            <dt>Long setups</dt>
            <dd>{counts(setupCounts(changes, 'long'), setupNames)}</dd>
          </div>
          <div>
            <dt>Risk warnings</dt>
            <dd>{counts(setupCounts(changes, 'risk'), setupNames)}</dd>
          </div>
          <div>
            <dt>Scores</dt>
            <dd>
              {scores.higher} higher · {scores.lower} lower · {scores.same} same, of{' '}
              {changes.length} evaluated in both
            </dd>
          </div>
        </dl>
        {moved.length > 0 ? (
          <ul className="market-scan-list scan-changes-list" aria-label="Setups that changed">
            {moved.map((change) => row(change, <SetupMoves change={change} />))}
          </ul>
        ) : (
          <p className="market-scan-empty">
            {changes.length > 0
              ? `No Long setup or Risk warning appeared or cleared among the ${changes.length} evaluated in both.`
              : 'No asset was evaluated in both scans.'}
          </p>
        )}
        {onlyAfter.length > 0 && (
          <p className="market-scan-fit">
            Evaluated only in the displayed scan, so there is no earlier reading:{' '}
            {onlyAfter.join(', ')}.
          </p>
        )}
        {onlyBefore.length > 0 && (
          <p className="market-scan-fit">
            Not evaluated in the displayed scan, so their earlier setups are neither confirmed nor
            cleared: {onlyBefore.join(', ')}.
          </p>
        )}
        {neither.length > 0 && (
          <p className="market-scan-fit">Evaluated in neither scan: {neither.join(', ')}.</p>
        )}
        {changes.length > 0 && (
          <details className="scan-guide-details">
            <summary>Score changes for all {changes.length} evaluated in both</summary>
            <ul className="market-scan-list scan-changes-list">
              {changes.map((change) => row(change))}
            </ul>
          </details>
        )}
      </>
    );
  }
  return (
    <section className="scan-changes" aria-labelledby={titleId}>
      <h3 id={titleId} className="market-scan-label">
        Changes since previous scan{' '}
        <span className="market-scan-rule">between TradingView imports only</span>
      </h3>
      {body}
    </section>
  );
}
