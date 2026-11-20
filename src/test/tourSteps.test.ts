import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTourSteps,
  findTarget,
  TARGET_WAIT_MS,
  TOUR_STEPS,
  waitForTarget,
} from '@/lib/tourSteps';

/** Targets the workspace header shows on every page, for every sign-in. */
const HEADER = new Set(['workspace-nav', 'nav-research', 'nav-account']);

const copy = (id: string) => {
  const step = TOUR_STEPS.find((candidate) => candidate.id === id);
  return `${step?.title} ${step?.content}`;
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the tour steps', () => {
  it('stay short and never depend on data, a file or the owner check', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(5);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(7);
    for (const step of TOUR_STEPS) {
      // Every chain ends at a header tab; a step that opens Research may prefer its own controls.
      expect(HEADER.has(step.targets.at(-1)!)).toBe(true);
      expect(step.targets).not.toContain('spot-experiments');
    }
  });

  it('introduce Daily candidates first, then Model scan, and end on real trades', () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual([
      'workspace',
      'daily-candidates',
      'research-scan',
      'scan-facts',
      'saved-scan',
      'manual-spot',
    ]);
    expect(TOUR_STEPS.flatMap((step) => step.targets)).not.toContain('nav-paper');
    expect(TOUR_STEPS.map((step) => [step.id, step.opensResearch])).toEqual([
      ['workspace', undefined],
      ['daily-candidates', 'daily'],
      ['research-scan', 'scan'],
      ['scan-facts', 'scan'],
      ['saved-scan', 'scan'],
      ['manual-spot', undefined],
    ]);
  });

  it('open the Research place that holds a step’s own target before pointing at it', () => {
    const home: Record<string, string> = {
      'place-daily': 'daily',
      'place-scan': 'scan',
      'scan-key': 'scan',
      'open-saved-scan': 'scan',
    };
    for (const step of TOUR_STEPS) {
      const place = home[step.targets[0]];
      if (place) expect([step.id, step.opensResearch]).toEqual([step.id, place]);
      else expect(HEADER.has(step.targets[0])).toBe(true);
    }
  });

  it('say what each fact is not, and that real records are not verified holdings', () => {
    expect(copy('workspace')).toMatch(/Research opens on Daily candidates, then Model scan \(1D\)/);
    expect(copy('daily-candidates')).toMatch(/Binance Spot/);
    expect(copy('daily-candidates')).toMatch(/not a model score or a prediction/);
    expect(copy('daily-candidates')).toMatch(/other sign-ins see an access notice/);
    expect(copy('research-scan')).toMatch(/coverage and candle timestamps/);
    expect(copy('research-scan')).toMatch(/closed/);
    expect(copy('research-scan')).toMatch(/not intraday signals/);
    expect(copy('research-scan')).toMatch(/Only crypto pairs are scanned/);
    expect(copy('scan-facts')).toMatch(/not an instruction to buy/);
    expect(copy('scan-facts')).toMatch(/Risk flag is not an instruction to sell/);
    expect(copy('saved-scan')).toMatch(/does not run a new scan, fetch prices or refresh itself/);
    expect(copy('manual-spot')).toMatch(/never places orders/);
    expect(copy('manual-spot')).toMatch(/owner account only/);
    expect(copy('manual-spot')).toMatch(/not a verified current holding/);
    expect(copy('workspace')).toMatch(/Paper Desk and Build Portfolio are paused/);
    expect(copy('workspace')).toMatch(/Daily candidates/);
  });

  it('make no protection, performance or implementation claims', () => {
    const all = TOUR_STEPS.map((step) => `${step.title} ${step.content}`).join(' ');
    expect(all).not.toMatch(
      /guarantee|at most \d+ ?%|protect|real[- ]time|web ?worker|websocket|useSyncExternalStore|\d+ ?ms\b|alpha|recommend/i,
    );
  });
});

describe('findTarget', () => {
  it('takes the first preferred target that is shown, passing over hidden copies', () => {
    document.body.innerHTML = `
      <div hidden><dl data-tour="scan-key"></dl></div>
      <div style="display: none"><dl data-tour="scan-key"></dl></div>
      <div data-tour="research-places"></div>
      <nav data-tour="nav-research"></nav>`;
    expect(findTarget(['scan-key', 'research-places', 'nav-research'])).toBe(
      document.querySelector('[data-tour="research-places"]'),
    );

    document.body.insertAdjacentHTML('beforeend', '<dl id="shown" data-tour="scan-key"></dl>');
    expect(findTarget(['scan-key', 'research-places'])?.id).toBe('shown');
  });

  it('returns null when nothing is shown', () => {
    document.body.innerHTML = '<div data-tour="nav-paper" style="visibility: hidden"></div>';
    expect(findTarget(['nav-paper'])).toBeNull();
  });
});

describe('waitForTarget', () => {
  it('resolves as soon as a delayed target renders', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    let settled = false;
    const waiting = waitForTarget('scan-key').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toBe(false);

    document.body.innerHTML = '<dl data-tour="scan-key"></dl>';
    await vi.advanceTimersByTimeAsync(60);
    await waiting;
    expect(settled).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('gives up after the wait so the step falls back instead of hanging', async () => {
    vi.useFakeTimers();
    let settled = false;
    void waitForTarget('scan-key').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(TARGET_WAIT_MS - 100);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(true);
  });
});

describe('buildTourSteps', () => {
  it.each([
    [1, 'daily', 'place-daily'],
    [2, 'scan', 'place-scan'],
  ])(
    'opens its Research place before step %i and waits for its preferred target',
    async (index, place, target) => {
      vi.useFakeTimers();
      const openResearch = vi.fn(() => {
        setTimeout(() => {
          document.body.innerHTML = `<div data-tour="research-places"><span data-tour="${target}"></span></div>`;
        }, 300);
      });
      const steps = buildTourSteps(TOUR_STEPS, openResearch);
      const research = steps[index]!;

      let shown = false;
      void research.before?.({} as never).then(() => {
        shown = true;
      });
      expect(openResearch).toHaveBeenCalledExactlyOnceWith(place);
      await vi.advanceTimersByTimeAsync(250);
      expect(shown).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(shown).toBe(true);
      expect(typeof research.target === 'function' && research.target()).toBe(
        document.querySelector(`[data-tour="${target}"]`),
      );
    },
  );

  it('anchors header steps without navigating or scrolling', () => {
    const openResearch = vi.fn();
    const steps = buildTourSteps(TOUR_STEPS, openResearch);
    for (const [index, spec] of TOUR_STEPS.entries()) {
      expect(steps[index]?.before === undefined).toBe(!spec.opensResearch);
      expect(steps[index]?.isFixed).toBe(!spec.opensResearch);
    }
    expect(openResearch).not.toHaveBeenCalled();
  });
});
