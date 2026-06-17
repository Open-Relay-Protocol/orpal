// OS-keychain-protected storage for the device's PRIVATE keys.
//
// Electron's `safeStorage` encrypts/decrypts with a key held in the OS keychain
// (Keychain on macOS, libsecret/kwallet on Linux, DPAPI on Windows). We store the
// resulting ciphertext as an opaque blob in userData; the plaintext private keys
// exist only transiently in the main process while (de)serializing, and are NEVER
// sent to the renderer. The renderer only ever receives them to hand straight to
// DeviceIdentity.fromPrivateKeys at startup (load path), exactly as the protocol
// intends.

import { safeStorage } from "electron";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoredKeys } from "@orpal/core";

export class SecureKeyStoreMain {
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "identity", "keys.enc");
  }

  async load(): Promise<StoredKeys | null> {
    let blob: Buffer;
    try {
      blob = await readFile(this.file);
    } catch {
      return null; // first run
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is unavailable on this OS; refusing to read keys insecurely");
    }
    const json = safeStorage.decryptString(blob);
    return JSON.parse(json) as StoredKeys;
  }

  async save(keys: StoredKeys): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("safeStorage encryption is unavailable on this OS; refusing to store keys insecurely");
    }
    await mkdir(dirname(this.file), { recursive: true });
    const blob = safeStorage.encryptString(JSON.stringify(keys));
    await writeFile(this.file, blob, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
