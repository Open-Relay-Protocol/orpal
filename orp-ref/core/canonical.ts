// SPDX-License-Identifier: Apache-2.0
// Canonical JSON for deterministic signing.
//
// Two parties must produce byte-identical input to Ed25519.sign / verify, so we
// serialize with recursively sorted object keys, compact separators, and a hard
// ban on values that don't round-trip deterministically (NaN, Infinity).
//
// This is intentionally small and self-contained rather than pulling in a
// JCS/RFC-8785 dependency: the message set is tiny and fully under our control.

import { utf8 } from "./encoding.js";

function canon(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonical: non-finite number is not serializable");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canon).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // undefined fields are omitted, not signed
      parts.push(JSON.stringify(k) + ":" + canon(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonical: unsupported type ${t}`);
}

/** Deterministic, sorted-key, whitespace-free JSON string. */
export function canonicalize(value: unknown): string {
  return canon(value);
}

/** UTF-8 bytes of the canonical form — the exact preimage that gets signed. */
export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalize(value));
}
