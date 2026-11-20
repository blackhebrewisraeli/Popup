import type { Step } from 'react-joyride';

/**
 * One tour step. `targets` are `data-tour` names, preferred first: the step anchors to the first
 * one shown on the page. Each list ends with a target the workspace always shows (a header tab,
 * or the Research bar once the step has opened Research › Scan), so a step never depends on
 * loaded data, an opened file, a balance, a subscription or the owner check.
 */
export type TourStepSpec = {
  id: string;
  title: string;
  content: string;
  targets: readonly [string, ...string[]];
  /** Switch to Research › Scan before showing the step. The tour navigates nowhere else. */
  opensResearchScan?: boolean;
};

/** Ordered by task: read the scan, open a saved one, record a real trade. */
export const TOUR_STEPS: readonly TourStepSpec[] = [
  {
    id: 'workspace',
    title: 'Your workspace',
    content:
      'Research holds the market scan and its evidence, the Markets directory and Daily candidates. Account starts with Manual Spot experiments for sign-ins with access, then the holdings you track by hand; data export and the TradingView webhook sit in a closed section below. Paper Desk and Build Portfolio are paused; their simulated history stays readable from that section. This tour only switches to Research › Scan: it never opens a file, saves a record or books a trade.',
    targets: ['workspace-nav'],
  },
  {
    id: 'research-scan',
    title: 'Research › Scan',
    content:
      'Scan scores a fixed list of instruments on daily candles that have closed, and shows the evidence behind each result. Live prices move during the day, but they are not intraday signals. Only crypto pairs are scanned here; stocks and ETFs appear in Markets directory without a score.',
    targets: ['research-places', 'nav-research'],
    opensResearchScan: true,
  },
  {
    id: 'scan-facts',
    title: 'Score, Long and Model Risk',
    content:
      'Each candidate shows separate facts. The score (0–100) measures how closely its readings match the model, and orders the rank. Long conditions and the Model Risk flag are checked on their own. A high rank or score is not an instruction to buy, and a Risk flag is not an instruction to sell.',
    targets: ['scan-key', 'research-places', 'nav-research'],
    opensResearchScan: true,
  },
  {
    id: 'saved-scan',
    title: 'Open a saved crypto scan',
    content:
      'Opens one saved TradingView crypto scan file from your computer and checks it in this browser. It shows that past scan as it was saved: it does not run a new scan, fetch prices or refresh itself.',
    targets: ['open-saved-scan', 'research-places', 'nav-research'],
    opensResearchScan: true,
  },
  {
    id: 'manual-spot',
    title: 'Real trades: Manual Spot experiments',
    content:
      'You place real Spot trades yourself on Binance; Popup only reads Binance and never places orders. For sign-ins with access (currently the owner account only), Account › Manual Spot experiments records your decision, an optional plan and the executions you link. A record is not a verified current holding. Replay this tour any time from Tour.',
    targets: ['nav-account'],
  },
];

/** How long a step waits for its preferred target (a route, chunk or scan still rendering). */
export const TARGET_WAIT_MS = 2500;
const POLL_MS = 50;

const selector = (name: string) => `[data-tour="${name}"]`;

/** Shown on the page: not inside `hidden`, `display: none` or `visibility: hidden`. */
function isShown(element: Element): boolean {
  for (
    let node: Element | null = element;
    node && node !== document.body;
    node = node.parentElement
  ) {
    if (node instanceof HTMLElement && node.hidden) return false;
    const { display, visibility } = getComputedStyle(node);
    if (display === 'none' || visibility === 'hidden') return false;
  }
  return true;
}

/** The first shown element among `names`, in order of preference. */
export function findTarget(names: readonly string[]): HTMLElement | null {
  for (const name of names) {
    const shown = [...document.querySelectorAll<HTMLElement>(selector(name))].find(isShown);
    if (shown) return shown;
  }
  return null;
}

/** Resolves once `name` is shown, or after `timeoutMs`; never rejects, so the tour moves on. */
export function waitForTarget(name: string, timeoutMs = TARGET_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (findTarget([name]) || Date.now() >= deadline) resolve();
      else setTimeout(check, POLL_MS);
    };
    check();
  });
}

/**
 * Joyride steps for `specs`. A step that opens Research › Scan switches there first and waits for
 * its preferred target, then anchors to whichever of its targets is shown. Header steps are
 * `isFixed`: the header is sticky, so Joyride neither scrolls the page nor loses the target.
 */
export function buildTourSteps(
  specs: readonly TourStepSpec[],
  openResearchScan: () => void,
): Step[] {
  return specs.map(({ id, title, content, targets, opensResearchScan }) => ({
    id,
    title,
    content,
    target: () => findTarget(targets),
    placement: 'bottom',
    isFixed: !opensResearchScan,
    ...(opensResearchScan && {
      before: () => {
        openResearchScan();
        return waitForTarget(targets[0]);
      },
    }),
  }));
}
