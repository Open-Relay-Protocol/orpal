// Persistence abstraction for the device's PRIVATE keys.
//
// orpal-core never touches secure storage directly (that's shell territory: the
// browser's IndexedDB on the web, Capacitor Keychain/Keystore on Android). It only
// defines this interface; a shell provides the implementation.
// The contract is deliberately tiny and only ever moves the two private keys.

import { b64uDecode, b64uEncode } from "../orp.js";

/** The only material an identity needs to be reconstructed via
 *  `DeviceIdentity.fromPrivateKeys`. These bytes are SECRET and must live ONLY in
 *  OS-native secure storage — never in plain files, logs, or the renderer's own
 *  storage. */
export interface StoredKeys {
  /** b64u Ed25519 signing (identity) private key. */
  signingPrivB64u: string;
  /** b64u X25519 transport private key. */
  transportPrivB64u: string;
  /** ISO-8601 creation time, so the reconstructed binding's `created_utc` is stable. */
  createdUtc: string;
}

export interface SecureKeyStore {
  /** Return the stored private keys, or null if none have been saved yet. */
  load(): Promise<StoredKeys | null>;
  /** Persist (or overwrite) the private keys in OS-native secure storage. */
  save(keys: StoredKeys): Promise<void>;
  /** Remove any stored keys (used when resetting/rotating the identity). */
  clear(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Secure native key storage (ORPAL-007)
//
// The plain SecureKeyStore above persists `StoredKeys` as-is. On a platform with
// secure hardware we want the private keys to never sit at rest in cleartext:
// instead they're sealed by a key that lives in (and never leaves) the device's
// secure element — Apple Secure Enclave, Android Keystore / StrongBox, or a
// Windows TPM (reached from the browser/WebView via a WebAuthn platform
// authenticator with the PRF extension). When no such hardware is present we
// transparently fall back to the existing cleartext path.
//
// The pieces below keep that capability OUT of core's runtime (core stays
// DOM/Capacitor-agnostic): core only defines the seam — a `HardwareKeyProvider`
// a shell implements, and a `HardwareBackedKeyStore` decorator that uses it when
// available and falls back when it isn't. Crucially the decorator IS a
// `SecureKeyStore`, so every existing caller (IdentityManager, OrpalClient's
// migration path) is unchanged.
// ---------------------------------------------------------------------------

/** A blob produced by a `HardwareKeyProvider`. Marked with `kind: "hw"` so the
 *  loader can tell a sealed envelope apart from cleartext `StoredKeys`, and with
 *  the originating `backend` for diagnostics. `blob` is the provider's opaque,
 *  base64url-encoded ciphertext (e.g. credentialId + iv + AES-GCM ciphertext). */
export interface SecureEnvelope {
  kind: "hw";
  /** Schema version of the envelope (bump if the wire shape ever changes). */
  v: 1;
  /** Identifies which secure backend sealed this (e.g. "webauthn-prf"). */
  backend: string;
  /** base64url of the provider's opaque sealed bytes. */
  blob: string;
}

/** The two shapes that can live in the underlying key slot: a sealed envelope
 *  (secure-hardware path) or cleartext keys (fallback path). */
export type PersistedKeys = StoredKeys | SecureEnvelope;

/** Narrow a persisted value to a hardware-sealed envelope. */
export function isSecureEnvelope(value: PersistedKeys): value is SecureEnvelope {
  return (value as SecureEnvelope).kind === "hw";
}

/** The low-level slot the `HardwareBackedKeyStore` reads/writes. It persists
 *  whichever `PersistedKeys` shape it's given — a shell backs this with the same
 *  store it already uses for keys (IndexedDB in the browser, Keychain/Keystore on
 *  native). Identical in spirit to `SecureKeyStore`, but its value type is the
 *  `PersistedKeys` union so it can hold a sealed envelope too. */
export interface KeyBlobStore {
  load(): Promise<PersistedKeys | null>;
  save(value: PersistedKeys): Promise<void>;
  clear(): Promise<void>;
}

/** Capability + sealing primitive backed by the device's secure hardware. A
 *  shell implements this (the web shell over WebAuthn's PRF extension); core only
 *  ever speaks raw bytes so it pulls in no platform APIs. */
export interface HardwareKeyProvider {
  /** Stable identifier for the backing mechanism (recorded in the envelope). */
  readonly backend: string;
  /** Whether usable secure hardware is present on this device right now. Checked
   *  at runtime so the same build degrades gracefully across platforms. */
  isAvailable(): Promise<boolean>;
  /** Seal `plaintext` with a key bound to the secure element. The returned bytes
   *  are opaque to core and only meaningful to this provider's `unwrap`. */
  wrap(plaintext: Uint8Array): Promise<Uint8Array>;
  /** Reverse of `wrap`. Rejects if the secure element is unavailable or refuses. */
  unwrap(sealed: Uint8Array): Promise<Uint8Array>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * A `SecureKeyStore` that seals the private keys with platform secure hardware
 * when it's available, and otherwise stores them in cleartext exactly as before.
 *
 * Behaviour:
 *  - `save` — if a provider is present and reports availability, the keys are
 *    JSON-serialized and sealed into a {@link SecureEnvelope}. If sealing throws
 *    for any reason (e.g. the platform authenticator is dismissed, or PRF turns
 *    out to be unsupported), it falls back to writing cleartext so a save never
 *    loses the identity — the same durability the cleartext path always had.
 *  - `load` — a cleartext value is returned as-is; a sealed envelope is unsealed
 *    via the provider. An envelope with no available provider is a hard error
 *    (the keys exist but can't be reached on this device) rather than silent loss.
 */
export class HardwareBackedKeyStore implements SecureKeyStore {
  constructor(
    private readonly slot: KeyBlobStore,
    private readonly provider: HardwareKeyProvider | null,
    /** Optional hook for surfacing a degraded-to-cleartext save (diagnostics). */
    private readonly onFallback?: (reason: unknown) => void,
  ) {}

  async load(): Promise<StoredKeys | null> {
    const stored = await this.slot.load();
    if (!stored) return null;

    if (!isSecureEnvelope(stored)) {
      // Cleartext: either a hardware-less device, or an install that predates
      // ORPAL-007 whose keys were written before a provider existed. If secure
      // hardware is available now, opportunistically re-seal so existing installs
      // stop leaving keys in cleartext — without this, an upgraded user's keys
      // would never migrate (loadOrCreate returns early on the first load).
      await this.resealIfPossible(stored);
      return stored;
    }

    if (!this.provider) {
      throw new Error(
        "device keys are sealed to secure hardware, but no secure-hardware provider is available on this device",
      );
    }
    const sealed = b64uDecode(stored.blob);
    const plaintext = await this.provider.unwrap(sealed);
    return JSON.parse(textDecoder.decode(plaintext)) as StoredKeys;
  }

  /** Best-effort upgrade of a cleartext slot to a hardware-sealed envelope.
   *  Reuses `save` (which seals when the provider is available and otherwise
   *  no-ops back to cleartext), and never throws into the load path — a failed
   *  reseal just leaves the existing cleartext value and is retried next load. */
  private async resealIfPossible(keys: StoredKeys): Promise<void> {
    if (!this.provider) return;
    try {
      if (!(await this.provider.isAvailable())) return;
      await this.save(keys);
    } catch (err) {
      this.onFallback?.(err);
    }
  }

  async save(keys: StoredKeys): Promise<void> {
    if (this.provider && (await this.provider.isAvailable())) {
      try {
        const sealed = await this.provider.wrap(textEncoder.encode(JSON.stringify(keys)));
        const envelope: SecureEnvelope = {
          kind: "hw",
          v: 1,
          backend: this.provider.backend,
          blob: b64uEncode(sealed),
        };
        await this.slot.save(envelope);
        return;
      } catch (err) {
        // Secure hardware was advertised but sealing failed — fall back to the
        // cleartext path so the identity is still persisted (never bricked).
        this.onFallback?.(err);
      }
    }
    await this.slot.save(keys);
  }

  clear(): Promise<void> {
    return this.slot.clear();
  }
}

/** An in-memory SecureKeyStore — for tests and ephemeral sessions ONLY. It keeps
 *  keys in process memory, providing none of the OS-keychain protection the real
 *  shells do. Never use it to persist a real identity. */
export class InMemoryKeyStore implements SecureKeyStore {
  private keys: StoredKeys | null = null;
  constructor(initial?: StoredKeys) {
    this.keys = initial ?? null;
  }
  async load(): Promise<StoredKeys | null> {
    return this.keys;
  }
  async save(keys: StoredKeys): Promise<void> {
    this.keys = keys;
  }
  async clear(): Promise<void> {
    this.keys = null;
  }
}
