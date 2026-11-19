/**
 * JSON with every object's keys sorted, so equal values serialize to equal text whatever the key
 * order. It is the text every scan and evaluation hash is taken over, in scripts/ (node:crypto)
 * and in the browser (Web Crypto) alike, so its rules are the evidence contract: keys sort by
 * `localeCompare`, everything else is `JSON.stringify`.
 */
export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
