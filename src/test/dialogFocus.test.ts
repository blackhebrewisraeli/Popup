import { afterEach, describe, expect, it } from 'vitest';
import { containDialogTab } from '@/lib/dialogFocus';

afterEach(() => {
  document.body.replaceChildren();
});

/** Presses Tab (or Shift+Tab) on the focused element and reports whether the helper took it. */
function tab(dialog: HTMLElement, shiftKey = false) {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true });
  containDialogTab(event, dialog);
  return event.defaultPrevented;
}

/** The evidence sheet's shape: Close first, a disclosure last, its fields inside. */
function sheet() {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `
    <button type="button" id="close">Close</button>
    <p>Evidence text</p>
    <details id="scenario">
      <summary id="summary">Plan a hypothetical scenario</summary>
      <input id="allocation" />
      <button type="button" id="clear">Clear scenario</button>
    </details>`;
  document.body.append(dialog);
  const get = (id: string) => dialog.querySelector<HTMLElement>(`#${id}`)!;
  return { dialog, get, details: get('scenario') as HTMLDetailsElement };
}

describe('containDialogTab', () => {
  it('wraps Tab and Shift+Tab within a custom dialog', () => {
    const dialog = document.createElement('dialog');
    const first = document.createElement('button');
    const last = document.createElement('button');
    dialog.append(first, last);
    document.body.append(dialog);

    last.focus();
    expect(tab(dialog)).toBe(true);
    expect(document.activeElement).toBe(first);

    expect(tab(dialog, true)).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('treats a closed disclosure’s summary as the last control, never its hidden fields', () => {
    const { dialog, get } = sheet();

    get('summary').focus();
    expect(tab(dialog)).toBe(true);
    expect(document.activeElement).toBe(get('close'));

    expect(tab(dialog, true)).toBe(true);
    expect(document.activeElement).toBe(get('summary'));
  });

  it('lets Tab move from the summary into an open disclosure and wraps after its last field', () => {
    const { dialog, get, details } = sheet();
    details.open = true;

    get('summary').focus();
    expect(tab(dialog)).toBe(false);

    get('clear').focus();
    expect(tab(dialog)).toBe(true);
    expect(document.activeElement).toBe(get('close'));

    expect(tab(dialog, true)).toBe(true);
    expect(document.activeElement).toBe(get('clear'));
  });

  it('moves the boundary back to the summary when the disclosure closes again', () => {
    const { dialog, get, details } = sheet();
    details.open = true;
    get('close').focus();
    tab(dialog, true);
    expect(document.activeElement).toBe(get('clear'));

    details.open = false;
    get('close').focus();
    expect(tab(dialog, true)).toBe(true);
    expect(document.activeElement).toBe(get('summary'));
  });

  it('skips fields of a closed disclosure nested in an open one', () => {
    const { dialog, get, details } = sheet();
    details.open = true;
    get('clear').insertAdjacentHTML(
      'afterend',
      '<details><summary id="inner">More</summary><input id="nested" /></details>',
    );

    get('inner').focus();
    expect(tab(dialog)).toBe(true);
    expect(document.activeElement).toBe(get('close'));
  });

  it('skips controls in hidden or inert subtrees and controls taken out of the tab order', () => {
    const { dialog, get } = sheet();
    get('summary')
      .closest('details')!
      .insertAdjacentHTML(
        'afterend',
        `<div hidden><button id="hidden">Hidden</button></div>
         <div inert><button id="inert">Inert</button></div>
         <button id="skipped" tabindex="-1">Roving</button>
         <button id="disabled" disabled>Disabled</button>`,
      );

    get('summary').focus();
    expect(tab(dialog)).toBe(true);
    expect(document.activeElement).toBe(get('close'));
  });

  it('keeps an aria-disabled control reachable, so a pressed button keeps focus', () => {
    const { dialog, get } = sheet();
    get('scenario').insertAdjacentHTML(
      'afterend',
      '<button id="reprice" aria-disabled="true">Reprice</button>',
    );

    get('summary').focus();
    expect(tab(dialog)).toBe(false);
    get('reprice').focus();
    expect(tab(dialog)).toBe(true);
    expect(document.activeElement).toBe(get('close'));
  });

  it('ignores other keys, a missing dialog and a dialog with nothing to focus', () => {
    const { dialog, get } = sheet();
    get('summary').focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    containDialogTab(enter, dialog);
    expect(enter.defaultPrevented).toBe(false);

    expect(tab(document.createElement('dialog'))).toBe(false);
    const missing = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    containDialogTab(missing, null);
    expect(missing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(get('summary'));
  });
});
