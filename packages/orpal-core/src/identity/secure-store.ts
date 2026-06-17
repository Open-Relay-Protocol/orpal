// Persistence abstraction for the device's PRIVATE keys.
//
// orpal-core never touches OS keychains directly (that's shell territory:
// Electron `safeStorage` in the main process, Capacitor Keychain/Keystore on
// mobile). It only defines this interface; a shell provides the implementation.
// The contract is deliberately tiny and only ever moves the two private keys.

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
