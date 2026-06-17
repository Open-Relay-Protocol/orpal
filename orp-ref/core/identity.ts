// SPDX-License-Identifier: Apache-2.0
// Device identity: TWO keypairs, never reused for each other's job.
//
//   - signing  : Ed25519  -> identity, announce/frame signatures (the device's name)
//   - transport: X25519    -> ECDH target for sealing SDP/ICE and messages
//
// A signed *binding* proves the X25519 transport key belongs to the Ed25519
// identity. Without it, a board (or a peer) could swap in its own transport key
// and MITM the sealed signaling. The binding is signed by the identity key.
//
// INVARIANT: private keys are generated here, held in the returned object, and
// never serialized, exported, logged, or sent. `exportPublic()` is the ONLY way
// material leaves a DeviceIdentity, and it emits public keys + the binding only.

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { canonicalBytes } from "./canonical.js";
import { b64uDecode, b64uEncode } from "./encoding.js";

export interface KeyBinding {
  identity_key: string; // b64u Ed25519 public key
  transport_key: string; // b64u X25519 public key
  created_utc: string; // ISO-8601
  binding_sig: string; // b64u Ed25519 signature over {identity_key,transport_key,created_utc}
}

export interface PublicIdentity {
  identity_key: string;
  transport_key: string;
  binding: KeyBinding;
}

export class DeviceIdentity {
  // Private keys live ONLY in these fields. They are marked readonly and are
  // never touched by any serializer in this codebase. Do not add a toJSON.
  readonly #signingPriv: Uint8Array;
  readonly #transportPriv: Uint8Array;

  readonly signingPub: Uint8Array; // Ed25519 public (identity)
  readonly transportPub: Uint8Array; // X25519 public (transport)
  readonly binding: KeyBinding;

  private constructor(
    signingPriv: Uint8Array,
    transportPriv: Uint8Array,
    createdUtc: string,
  ) {
    this.#signingPriv = signingPriv;
    this.#transportPriv = transportPriv;
    this.signingPub = ed25519.getPublicKey(signingPriv);
    this.transportPub = x25519.getPublicKey(transportPriv);

    const bindingBody = {
      identity_key: b64uEncode(this.signingPub),
      transport_key: b64uEncode(this.transportPub),
      created_utc: createdUtc,
    };
    const binding_sig = b64uEncode(
      ed25519.sign(canonicalBytes(bindingBody), signingPriv),
    );
    this.binding = { ...bindingBody, binding_sig };
  }

  /** Generate a fresh device identity. Both private keys never leave this object. */
  static generate(now: () => string = () => new Date().toISOString()): DeviceIdentity {
    return new DeviceIdentity(
      ed25519.utils.randomPrivateKey(),
      x25519.utils.randomPrivateKey(),
      now(),
    );
  }

  /**
   * Reconstruct an identity from private keys held in the device's OWN secure
   * local storage (e.g. on app restart). This is a LOAD path, not an export
   * path: the keys come from local storage, never from the network, and still
   * never leave the resulting object afterwards.
   */
  static fromPrivateKeys(
    signingPriv: Uint8Array,
    transportPriv: Uint8Array,
    createdUtc = new Date().toISOString(),
  ): DeviceIdentity {
    return new DeviceIdentity(signingPriv, transportPriv, createdUtc);
  }

  get identityKeyB64(): string {
    return b64uEncode(this.signingPub);
  }

  get transportKeyB64(): string {
    return b64uEncode(this.transportPub);
  }

  /** The ONLY export path. Public keys + binding. No private material. */
  exportPublic(): PublicIdentity {
    return {
      identity_key: this.identityKeyB64,
      transport_key: this.transportKeyB64,
      binding: this.binding,
    };
  }

  /** Sign a canonical preimage with the Ed25519 identity key. */
  sign(preimage: Uint8Array): Uint8Array {
    return ed25519.sign(preimage, this.#signingPriv);
  }

  /** X25519 private key — used ONLY by the local sealing/unsealing routines. */
  transportPrivate(): Uint8Array {
    return this.#transportPriv;
  }
}

/**
 * Verify a key binding: the binding_sig must be a valid Ed25519 signature, made
 * by `identity_key`, over {identity_key, transport_key, created_utc}. A peer MUST
 * call this before sealing anything to `transport_key`.
 */
export function verifyBinding(b: KeyBinding): boolean {
  try {
    const body = {
      identity_key: b.identity_key,
      transport_key: b.transport_key,
      created_utc: b.created_utc,
    };
    return ed25519.verify(
      b64uDecode(b.binding_sig),
      canonicalBytes(body),
      b64uDecode(b.identity_key),
    );
  } catch {
    return false;
  }
}
