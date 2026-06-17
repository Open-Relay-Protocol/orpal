// SPDX-License-Identifier: Apache-2.0
// Byte <-> string helpers. Buffer is used because this reference targets Node;
// a browser build would swap these for a base64url shim. Nothing here is
// security sensitive — it only moves public bytes around.

export function b64uEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Constant-time-ish equality for byte arrays (lengths may differ). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
