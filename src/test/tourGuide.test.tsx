import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TourGuide } from '@/components/TourGuide';
import { TARGET_WAIT_MS } from '@/lib/tourSteps';

const record = vi.fn();
const book = vi.fn();
const link = vi.fn();
const pickFile = vi.fn();

/**
 * A synthetic workspace: the header tabs every sign-in sees, and Research › Scan, which mounts
 * a little after the tour asks for it (a route change and lazy chunk) and only then. It holds
 * the controls the tour points at next to ones it must never press. No owner-only section exists.
 */
function Workspace({
  startOn,
  scanKey = true,
}: Readonly<{ startOn: 'research' | 'history' | 'account'; scanKey?: boolean }>) {
  const [page, setPage] = useState(startOn);
  const [openCalls, setOpenCalls] = useState(0);
  const openResearchScan = useCallback(() => {
    setOpenCalls((count) => count + 1);
    setTimeout(() => setPage('research'), 200);
  }, []);
  return (
    <>
      <header>
        <div data-tour="workspace-nav" role="tablist" aria-label="Workspace">
          <button type="button" role="tab" data-tour="nav-research">
            Research
          </button>
          <button type="button" role="tab" data-tour="nav-account">
            Account
          </button>
        </div>
        <TourGuide openResearchScan={openResearchScan} />
      </header>
      <output data-testid="open-calls">{openCalls}</output>
      <output data-testid="page">{page}</output>
      {page === 'research' && (
        <main>
          <div data-tour="research-places">Scan | Markets directory</div>
          <div data-tour="open-saved-scan">
            <button type="button" onClick={pickFile}>
              Open saved crypto scan
            </button>
          </div>
          {scanKey && <dl data-tour="scan-key">Rank, Score, Long, Model Risk</dl>}
          <button type="button" onClick={record}>
            Record experiment
          </button>
          <button type="button" onClick={link}>
            Link execution
          </button>
        </main>
      )}
      {page === 'history' && (
        <main>
          <button type="button" onClick={book}>
            Export CSV
          </button>
        </main>
      )}
      {page === 'account' && <main>Account</main>}
    </>
  );
}

const STEP_TITLES = [
  'Your workspace',
  'Research › Scan',
  'Score, Long and Model Risk',
  'Open a saved crypto scan',
  'Real trades: Manual Spot experiments',
];

const tourButton = () => screen.getByRole('button', { name: 'Start product tour' });

/** The open tooltip, once it shows step `n` with its title. */
async function expectStep(n: number, timeout = 2000) {
  const title = STEP_TITLES[n - 1]!;
  const dialog = await screen.findByRole('alertdialog', {}, { timeout });
  await waitFor(
    () => {
      expect(dialog).toHaveTextContent(`Step ${n} of ${STEP_TITLES.length}`);
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    },
    { timeout },
  );
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
}

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** Nothing of the tour is left on the page. */
function expectClosed(bodyStyle: string) {
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(document.getElementById('react-joyride-portal')).toBeNull();
  expect(document.querySelector('.react-joyride__overlay')).toBeNull();
  expect(document.querySelector('.react-joyride__floater')).toBeNull();
  expect(document.body.getAttribute('style') ?? '').toBe(bodyStyle);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

describe('the product tour', () => {
  it('walks every step from Simulation history, waiting for Research to render, and triggers nothing', async () => {
    render(<Workspace startOn="history" />);
    const bodyStyle = document.body.getAttribute('style') ?? '';
    fireEvent.click(tourButton());

    await expectStep(1);
    // The header step stays where the user was.
    expect(screen.getByTestId('page')).toHaveTextContent('history');

    press('Next');
    await expectStep(2);
    expect(screen.getByTestId('page')).toHaveTextContent('research');
    for (const n of [3, 4, 5]) {
      press('Next');
      await expectStep(n);
    }
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull();
    press('Finish');

    await waitFor(() => expectClosed(bodyStyle));
    await waitFor(() => expect(tourButton()).toHaveFocus());
    // Research › Scan is the only place it moved to; it pressed nothing and requested nothing.
    expect(screen.getByTestId('page')).toHaveTextContent('research');
    for (const action of [record, book, link, pickFile]) expect(action).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('goes Back across the route change and into Research steps again', async () => {
    render(<Workspace startOn="account" />);
    fireEvent.click(tourButton());
    await expectStep(1);
    press('Next');
    await expectStep(2);
    press('Back');
    await expectStep(1);
    press('Next');
    await expectStep(2);
    press('Next');
    await expectStep(3);
    press('Next');
    await expectStep(4);
    press('Next');
    await expectStep(5);
    press('Back');
    await expectStep(4);
    expect(Number(screen.getByTestId('open-calls').textContent)).toBeGreaterThanOrEqual(4);
  });

  it(
    'falls back to the Research bar when the scan has no candidates, keeping the step and its count',
    async () => {
      render(<Workspace startOn="research" scanKey={false} />);
      fireEvent.click(tourButton());
      await expectStep(1);
      press('Next');
      await expectStep(2);
      press('Next');
      // Waits for the scan's key, then shows the step anyway instead of skipping it.
      await expectStep(3, TARGET_WAIT_MS + 2000);
      press('Next');
      await expectStep(4);
    },
    TARGET_WAIT_MS + 8000,
  );

  it('ends on Skip and on Escape, returns focus, and restarts from step 1 once', async () => {
    render(<Workspace startOn="research" />);
    const bodyStyle = document.body.getAttribute('style') ?? '';

    fireEvent.click(tourButton());
    await expectStep(1);
    press('Next');
    await expectStep(2);
    press('Skip tour');
    await waitFor(() => expectClosed(bodyStyle));
    await waitFor(() => expect(tourButton()).toHaveFocus());

    // Restart: a fresh tour at step 1, and repeated clicks never stack a second one.
    fireEvent.click(tourButton());
    fireEvent.click(tourButton());
    await expectStep(1);
    fireEvent.click(tourButton());
    press('Next');
    await expectStep(2);

    act(() => {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    });
    await waitFor(() => expectClosed(bodyStyle));
    await waitFor(() => expect(tourButton()).toHaveFocus());

    fireEvent.click(tourButton());
    await expectStep(1);
  });
});
