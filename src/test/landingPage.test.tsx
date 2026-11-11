import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingPage } from '@/components/LandingPage';

function renderLanding() {
  const onSignIn = vi.fn();
  const onGetStarted = vi.fn();
  render(<LandingPage onSignIn={onSignIn} onGetStarted={onGetStarted} />);
  return { onSignIn, onGetStarted };
}

const rows = () => screen.getAllByRole('button', { name: /^DEMO\d, rank/ });
const detail = () => screen.getByRole('region', { name: /explanation$/ });

describe('LandingPage example scan', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ranks five synthetic assets by score, with a risk warning and an asset with no setup', () => {
    renderLanding();
    expect(screen.getByText('Illustrative')).toBeInTheDocument();
    const labels = rows().map((row) => row.getAttribute('aria-label') ?? '');
    expect(labels).toHaveLength(5);
    const scores = labels.map((label) => Number(/score (\d+)/.exec(label)?.[1]));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(labels.some((label) => label.endsWith('Risk: high volatility'))).toBe(true);
    expect(labels.some((label) => label.endsWith('No setup'))).toBe(true);
  });

  it('opens on a high score that meets no setup, and says which condition it misses', () => {
    renderLanding();
    expect(rows()[1]).toHaveAttribute('aria-current', 'true');
    const panel = within(detail());
    expect(panel.getByRole('heading', { name: 'DEMO5' })).toBeInTheDocument();
    expect(panel.getAllByText('Does not hold')).toHaveLength(2);
    expect(panel.getByText(/MACD momentum ≥ \+0\.05% of price/)).toHaveTextContent('not met');
  });

  it('shows the selected row’s explanation and the condition behind it', () => {
    renderLanding();
    const risk = screen.getByRole('button', { name: /^DEMO4,.*Risk: high volatility$/ });
    fireEvent.click(risk);
    expect(risk).toHaveAttribute('aria-current', 'true');
    expect(rows().filter((row) => row.hasAttribute('aria-current'))).toHaveLength(1);
    const panel = within(detail());
    expect(panel.getByRole('heading', { name: 'DEMO4' })).toBeInTheDocument();
    expect(panel.getByText('Holds')).toBeInTheDocument();
    expect(panel.getByText(/^High volatility — ATR ≥ 4\.00% of price/)).toHaveTextContent('met');
    expect(panel.getAllByText('Risk: high volatility')[0]).toHaveClass('is-risk');
    expect(screen.getByText('Showing DEMO4')).toBeInTheDocument();
  });

  it('fetches nothing and keeps both sign-in entry points', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { onSignIn, onGetStarted } = renderLanding();
    for (const row of rows()) fireEvent.click(row);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(screen.getByRole('button', { name: /Get started free/ }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onGetStarted).toHaveBeenCalledTimes(1);
  });
});
