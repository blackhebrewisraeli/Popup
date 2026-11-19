// SHA-256 as lowercase hex through Web Crypto, shared by the browser, scripts and Edge Functions.
// No Deno, Node or DOM-only API: `crypto.subtle` exists in all three.

const hex = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** SHA-256 of these bytes. */
export const digestBytes = async (bytes: Uint8Array) =>
  hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

/** Web Crypto over the string's UTF-8 bytes, exactly what node:crypto hashes for the scan store. */
export const webSha256 = (text: string) => digestBytes(new TextEncoder().encode(text));
