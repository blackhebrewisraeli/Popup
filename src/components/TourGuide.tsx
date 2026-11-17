import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Options, PartialDeep, Styles, TooltipRenderProps } from 'react-joyride';
import { Compass } from 'lucide-react';
import { buildTourSteps, TOUR_STEPS } from '@/lib/tourSteps';

// react-joyride loads on the first Tour click, not with the workspace.
const Joyride = lazy(() => import('react-joyride').then((m) => ({ default: m.Joyride })));

/**
 * Joyride applies these as inline CSS, so theme tokens follow a theme switch while the tour is
 * open. The scrim is an SVG `fill` attribute, which cannot read a variable; it matches the app's
 * dialog scrim (black in both themes). Escape and the overlay are handled below, not by Joyride:
 * its defaults advance the tour instead of ending it.
 */
const OPTIONS: Partial<Options> = {
  arrowColor: 'var(--popover)',
  backgroundColor: 'var(--popover)',
  textColor: 'var(--popover-foreground)',
  primaryColor: 'var(--primary)',
  overlayColor: 'rgba(0, 0, 0, 0.6)',
  buttons: ['back', 'skip', 'primary'],
  skipBeacon: true,
  dismissKeyAction: false,
  overlayClickAction: false,
  // The tour points at controls; it never lets a click through to open, record or trade.
  blockTargetInteraction: true,
  spotlightRadius: 12,
  spotlightPadding: 6,
  // Scrolls a target below the sticky 72px workspace header instead of under it.
  scrollOffset: 96,
  zIndex: 10000,
};

const STYLES: PartialDeep<Styles> = {
  floater: { filter: 'none' },
  loader: { margin: 'auto' },
  spotlight: { style: { stroke: 'var(--primary)', strokeWidth: 2, pointerEvents: 'none' } },
};

const LOCALE = { back: 'Back', next: 'Next', last: 'Finish', skip: 'Skip tour' };

/** The visible labels repeat LOCALE, which Joyride also puts in each button's aria-label. */
function TourTooltip({
  index,
  size,
  isLastStep,
  step,
  backProps,
  primaryProps,
  skipProps,
  tooltipProps,
}: Readonly<TooltipRenderProps>) {
  return (
    <div
      {...tooltipProps}
      className="tour-tooltip"
      aria-labelledby="tour-title"
      aria-describedby="tour-desc"
    >
      <p className="tour-step">
        Step {index + 1} of {size}
      </p>
      <h2 id="tour-title" className="tour-title">
        {step.title}
      </h2>
      <p id="tour-desc" className="tour-desc">
        {step.content}
      </p>
      <div className="tour-actions">
        {!isLastStep && (
          <button type="button" className="tour-skip" {...skipProps}>
            {LOCALE.skip}
          </button>
        )}
        <div className="tour-nav">
          {index > 0 && (
            <button type="button" className="tour-back" {...backProps}>
              {LOCALE.back}
            </button>
          )}
          <button type="button" className="tour-next" {...primaryProps}>
            {isLastStep ? LOCALE.last : LOCALE.next}
          </button>
        </div>
      </div>
    </div>
  );
}

function TourLoader() {
  return <output className="tour-loader" aria-label="Loading the next step" />;
}

/**
 * The product tour. One instance at a time: a Tour click while it runs does nothing. Finish,
 * Skip and Escape unmount Joyride (its portal and overlay go with it) and return focus to Tour,
 * so a restart always begins at step 1. `openResearchScan` is its only effect on the workspace.
 */
export function TourGuide({ openResearchScan }: Readonly<{ openResearchScan: () => void }>) {
  const [run, setRun] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const started = useRef(false);
  const steps = useMemo(() => buildTourSteps(TOUR_STEPS, openResearchScan), [openResearchScan]);

  useEffect(() => {
    if (!run) {
      if (started.current) trigger.current?.focus();
      return;
    }
    started.current = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRun(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [run]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="tour-trigger"
        onClick={() => setRun(true)}
        aria-label="Start product tour"
        title="Product tour"
      >
        <Compass size={14} />
        <span className="tour-trigger-label">Tour</span>
      </button>

      {run && (
        <Suspense fallback={null}>
          <Joyride
            run
            continuous
            steps={steps}
            options={OPTIONS}
            styles={STYLES}
            locale={LOCALE}
            tooltipComponent={TourTooltip}
            loaderComponent={TourLoader}
            onEvent={(data) => {
              if (data.status === 'finished' || data.status === 'skipped') setRun(false);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
