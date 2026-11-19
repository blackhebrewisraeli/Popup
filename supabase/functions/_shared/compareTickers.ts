/** Code-unit order, so ties break the same way in every runtime and locale. */
export function compareTickers(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
