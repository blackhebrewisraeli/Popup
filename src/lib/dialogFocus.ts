import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  // A disclosure's own summary takes focus, open or closed.
  'details > summary:first-of-type',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Whether Tab can reach a matched control: not taken out of the tab order, not inside a
 * hidden or inert subtree, and not inside a closed <details> except in its summary. An
 * aria-disabled control stays reachable; aria-hidden counts only on the control itself.
 */
function tabbable(element: HTMLElement): boolean {
  if (element.getAttribute('tabindex') === '-1') return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[hidden], [inert]')) return false;
  for (
    let details = element.parentElement?.closest('details');
    details;
    details = details.parentElement?.closest('details')
  ) {
    if (!details.open && !details.querySelector(':scope > summary')?.contains(element)) {
      return false;
    }
  }
  return true;
}

/** Keeps keyboard focus inside a custom modal dialog. Radix dialogs do this themselves. */
export function containDialogTab(
  event: KeyboardEvent | ReactKeyboardEvent,
  dialog: HTMLElement | null,
) {
  if (event.key !== 'Tab' || !dialog) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(tabbable);
  if (controls.length === 0) return;
  const first = controls[0]!;
  const last = controls.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
