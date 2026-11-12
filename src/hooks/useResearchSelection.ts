import { useState } from 'react';

export type MarketsSource = 'market-data' | 'tradingview';

/**
 * Which Research source and TradingView scan this tab last showed, under `vite dev` only, so
 * a full page reload restores them. Per tab (sessionStorage): a new tab starts on market data.
 * It holds a source and a scan ID, never results, prices or Manual Spot scenario inputs.
 */
export const RESEARCH_SELECTION_KEY = 'popup.research-selection';

export interface ResearchSelection {
  source: MarketsSource;
  /** The saved scan chosen, or null for the latest published scan. Checked where it is read. */
  scan: string | null;
}

/** This tab's earlier choice; null when none was made, outside `vite dev`, or unreadable. */
export function readResearchSelection(): ResearchSelection | null {
  if (!import.meta.env.DEV) return null;
  try {
    const stored = JSON.parse(sessionStorage.getItem(RESEARCH_SELECTION_KEY) ?? 'null') as Partial<
      Record<keyof ResearchSelection, unknown>
    > | null;
    const source = stored?.source;
    if (source !== 'market-data' && source !== 'tradingview') return null;
    // Kept as stored even when it is not a scan ID: the review says so instead of guessing.
    const raw = source === 'tradingview' ? stored?.scan : null;
    let scan: string | null = null;
    if (typeof raw === 'string') scan = raw;
    else if (raw != null) scan = JSON.stringify(raw);
    return { source, scan };
  } catch {
    return null;
  }
}

function saveResearchSelection(selection: ResearchSelection): void {
  if (!import.meta.env.DEV) return;
  try {
    sessionStorage.setItem(RESEARCH_SELECTION_KEY, JSON.stringify(selection));
  } catch {
    // Storage blocked: the choice still holds until the page reloads.
  }
}

/** The scan's source, restored after a reload. Changing it starts on the latest published scan. */
export function useResearchSource() {
  const [source, setSource] = useState<MarketsSource>(
    () => readResearchSelection()?.source ?? 'market-data',
  );
  const choose = (next: MarketsSource) => {
    if (next === source) return;
    saveResearchSelection({ source: next, scan: null });
    setSource(next);
  };
  return [source, choose] as const;
}

/** The TradingView scan shown, restored after a reload: null is the latest published scan. */
export function useResearchScan() {
  const [scan, setScan] = useState<string | null>(() => readResearchSelection()?.scan ?? null);
  const choose = (next: string | null) => {
    saveResearchSelection({ source: 'tradingview', scan: next });
    setScan(next);
  };
  return [scan, choose] as const;
}
