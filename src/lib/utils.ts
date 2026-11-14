import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Click handler for a modal backdrop: closes only when the backdrop itself is
 * clicked, and stops every click inside the portal from reaching the
 * components rendered behind it. Escape closes the modals for keyboard users.
 */
export function closeOnBackdrop(close: () => void) {
  return (event: React.MouseEvent) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) close();
  };
}

/** An instant as UTC text, with milliseconds only when it has them. */
export const utcText = (time: number | string) =>
  new Date(time).toISOString().replace('T', ' ').replace('.000Z', 'Z').replace('Z', ' UTC');

/**
 * A `datetime-local` value read as UTC. The input's value carries no time zone, so appending Z
 * keeps the browser's own zone out of it. The round trip refuses dates such as 30 February, which
 * some engines roll into March.
 */
export function utcInputTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const time = Date.parse(`${value}Z`);
  return time > 0 && new Date(time).toISOString().startsWith(value) ? time : null;
}
