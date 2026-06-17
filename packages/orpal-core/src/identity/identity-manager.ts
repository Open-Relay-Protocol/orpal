// Identity lifecycle: generate-once-then-load, backed by a SecureKeyStore.
//
// WHY WE GENERATE RAW KEYS HERE rather than calling DeviceIdentity.generate():
// DeviceIdentity deliberately never exposes its private keys (only `sign()`,
// `transportPrivate()`, and `exportPublic()`), so a DeviceIdentity it generated
// can't be serialized back out for storage. The reference's intended persistence
// path is `DeviceIdentity.fromPrivateKeys(...)` fed from "the device's OWN secure
// storage". So on first run we mint the two private keys with the SAME crypto
// stack the protocol uses (@noble), hand them straight to (a) the SecureKeyStore
// and (b) `fromPrivateKeys`, and never let them leave again. On later runs we
// load from the store and reconstruct. The ONLY value that ever leaves a
// DeviceIdentity afterwards is `exportPublic()`.

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { DeviceIdentity, b64uEncode, b64uDecode } from "../orp.js";
import type { PublicIdentity } from "../orp.js";
import type { SecureKeyStore, StoredKeys } from "./secure-store.js";

export interface LoadOrCreateResult {
  identity: DeviceIdentity;
  /** True if a brand-new identity was generated on this call (first run). */
  created: boolean;
}

export class IdentityManager {
  /**
   * Load the device identity from secure storage, or generate and persist a new
   * one on first run. The private keys never leave secure storage + the returned
   * DeviceIdentity.
   */
  static async loadOrCreate(
    store: SecureKeyStore,
    now: () => string = () => new Date().toISOString(),
  ): Promise<LoadOrCreateResult> {
    const existing = await store.load();
    if (existing) {
      return { identity: IdentityManager.fromStored(existing), created: false };
    }
    const stored = IdentityManager.mintStoredKeys(now());
    await store.save(stored);
    return { identity: IdentityManager.fromStored(stored), created: true };
  }

  /** Reconstruct a DeviceIdentity from stored private keys (load path). */
  static fromStored(keys: StoredKeys): DeviceIdentity {
    return DeviceIdentity.fromPrivateKeys(
      b64uDecode(keys.signingPrivB64u),
      b64uDecode(keys.transportPrivB64u),
      keys.createdUtc,
    );
  }

  /** Generate a fresh pair of private keys ready to persist. */
  static mintStoredKeys(createdUtc: string): StoredKeys {
    return {
      signingPrivB64u: b64uEncode(ed25519.utils.randomPrivateKey()),
      transportPrivB64u: b64uEncode(x25519.utils.randomPrivateKey()),
      createdUtc,
    };
  }

  /**
   * Replace the stored identity with a brand-new one. Destroys the old identity
   * (and therefore the ability to decrypt anything sealed to the old transport
   * key) — callers should confirm with the user first.
   */
  static async rotate(
    store: SecureKeyStore,
    now: () => string = () => new Date().toISOString(),
  ): Promise<DeviceIdentity> {
    await store.clear();
    const stored = IdentityManager.mintStoredKeys(now());
    await store.save(stored);
    return IdentityManager.fromStored(stored);
  }

  /** The shareable public identity (identity key + transport key + signed
   *  binding) — what goes into a QR code / contact card. */
  static exportPublic(identity: DeviceIdentity): PublicIdentity {
    return identity.exportPublic();
  }
}
