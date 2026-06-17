// SPDX-License-Identifier: Apache-2.0
// Ed25519 signing over wire records.
//
// Every announce and every signaling frame is signed by its author's Ed25519
// *identity* key. The signature covers the canonical encoding of the record with
// the `signature` field removed. Receivers AND the board reject any record whose
// signature is missing or invalid before acting on it.
//
// `signObject` takes a Signer (not a raw private key) so that DeviceIdentity can
// satisfy it via its guarded `.sign()` method WITHOUT ever exposing the signing
// private key to this module. Tests that need to forge signatures build a Signer
// explicitly from a raw key via `signerFromPrivateKey`.

import { ed25519 } from "@noble/curves/ed25519";
import { canonicalBytes } from "./canonical.js";
import { b64uDecode, b64uEncode } from "./encoding.js";

export type Signed<T> = T & { signature: string };

export interface Signer {
  sign(preimage: Uint8Array): Uint8Array;
}

/** Wrap a raw Ed25519 private key as a Signer (used by tests / low-level callers). */
export function signerFromPrivateKey(priv: Uint8Array): Signer {
  return { sign: (preimage) => ed25519.sign(preimage, priv) };
}

/** Returns a copy of `record` with a `signature` field set. */
export function signObject<T extends Record<string, unknown>>(
  record: T,
  signer: Signer,
): Signed<T> {
  const { signature: _drop, ...body } = record as Record<string, unknown>;
  const sig = signer.sign(canonicalBytes(body));
  return { ...(record as T), signature: b64uEncode(sig) };
}

/**
 * Verify that `record.signature` is a valid Ed25519 signature over the rest of
 * the record, made by `signerPubB64`. Never throws — returns false on any
 * malformed input so callers can treat verification failure uniformly.
 */
export function verifyObject(
  record: Record<string, unknown>,
  signerPubB64: string,
): boolean {
  try {
    const sigB64 = record.signature;
    if (typeof sigB64 !== "string" || sigB64.length === 0) return false;
    const { signature: _drop, ...body } = record;
    const sig = b64uDecode(sigB64);
    const pub = b64uDecode(signerPubB64);
    return ed25519.verify(sig, canonicalBytes(body), pub);
  } catch {
    return false;
  }
}
