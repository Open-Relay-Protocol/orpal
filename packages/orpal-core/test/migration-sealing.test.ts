import { describe, it, expect } from "vitest";
import {
  DeviceIdentity,
  HardwareBackedKeyStore,
  IdentityManager,
  InMemoryKeyStore,
  isSecureEnvelope,
  type Contact,
  type HardwareKeyProvider,
  type KeyBlobStore,
  type PersistedKeys,
} from "../src/index.js";
import { MigrationManager, InMemoryMigrationStore } from "../src/messaging/migration-manager.js";

// ORPAL-013 (#35): the new identity's private keys must be sealed at rest and the
// migration state must contain no cleartext private key material.

class MemoryBlobStore implements KeyBlobStore {
  value: PersistedKeys | null = null;
  async load(): Promise<PersistedKeys | null> {
    return this.value;
  }
  async save(value: PersistedKeys): Promise<void> {
    this.value = value;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}

// A reversible "seal" so the test can prove the bytes at rest aren't the keys.
class FakeHardwareProvider implements HardwareKeyProvider {
  readonly backend = "fake-secure-element";
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    return plaintext.map((b) => b ^ 0x5a);
  }
  async unwrap(sealed: Uint8Array): Promise<Uint8Array> {
    return sealed.map((b) => b ^ 0x5a);
  }
}

function contact(identityKey: string): Contact {
  return { identityKey } as Contact;
}

const RETIRE_AT = new Date(Date.now() + 3600_000).toISOString();

describe("migration key sealing (ORPAL-013)", () => {
  it("seals the new identity's keys and keeps them out of the migration state", async () => {
    const mainSlot = new MemoryBlobStore();
    const pendingSlot = new MemoryBlobStore();
    const hw = new FakeHardwareProvider();
    const keyStore = new HardwareBackedKeyStore(mainSlot, hw);
    const pendingKeyStore = new HardwareBackedKeyStore(pendingSlot, hw);
    const migrationStore = new InMemoryMigrationStore();

    const current = DeviceIdentity.generate();
    const mgr = new MigrationManager({ keyStore, pendingKeyStore, migrationStore });
    await mgr.init();

    const { newIdentity } = await mgr.startMigration(current, [contact("peer")], RETIRE_AT);

    // The pending slot holds a SEALED envelope, not cleartext keys.
    expect(pendingSlot.value && isSecureEnvelope(pendingSlot.value)).toBe(true);

    // The migration state has no private key material at all.
    const saved = await migrationStore.load();
    const stateJson = JSON.stringify(saved);
    expect(stateJson).not.toContain("newStoredKeys");
    expect(stateJson).not.toContain("signingPrivB64u");
    expect(stateJson).not.toContain("transportPrivB64u");
    expect(saved?.newIdentityKey).toBe(newIdentity.identityKeyB64);
  });

  it("reconstructs the pending identity from the sealed slot across a restart", async () => {
    const pendingSlot = new MemoryBlobStore();
    const hw = new FakeHardwareProvider();
    const migrationStore = new InMemoryMigrationStore();
    const mk = () => ({
      keyStore: new HardwareBackedKeyStore(new MemoryBlobStore(), hw),
      pendingKeyStore: new HardwareBackedKeyStore(pendingSlot, hw),
      migrationStore,
    });

    const current = DeviceIdentity.generate();
    const first = new MigrationManager(mk());
    await first.init();
    const { newIdentity } = await first.startMigration(current, [contact("peer")], RETIRE_AT);

    // Simulate a restart: a fresh manager over the SAME durable stores.
    const restarted = new MigrationManager(mk());
    await restarted.init();
    expect(restarted.newIdentityIfActive?.identityKeyB64).toBe(newIdentity.identityKeyB64);
  });

  it("retirement promotes the sealed pending keys into the main identity slot", async () => {
    const mainStore = new HardwareBackedKeyStore(new MemoryBlobStore(), new FakeHardwareProvider());
    const pendingSlot = new MemoryBlobStore();
    const pendingKeyStore = new HardwareBackedKeyStore(pendingSlot, new FakeHardwareProvider());
    const migrationStore = new InMemoryMigrationStore();

    const current = DeviceIdentity.generate();
    const mgr = new MigrationManager({ keyStore: mainStore, pendingKeyStore, migrationStore });
    await mgr.init();
    const { newIdentity } = await mgr.startMigration(current, [contact("peer")], RETIRE_AT);

    await mgr.retire();

    // Main identity slot now holds the NEW identity's keys.
    const promoted = await mainStore.load();
    expect(promoted).not.toBeNull();
    expect(IdentityManager.fromStored(promoted!).identityKeyB64).toBe(newIdentity.identityKeyB64);
    // Pending slot and migration state are cleared.
    expect(pendingSlot.value).toBeNull();
    expect(await migrationStore.load()).toBeNull();
  });

  it("falls back to cleartext sealing without a hardware provider, still off the migration state", async () => {
    const pendingSlot = new MemoryBlobStore();
    // No provider → HardwareBackedKeyStore writes cleartext StoredKeys to its slot.
    const pendingKeyStore = new HardwareBackedKeyStore(pendingSlot, null);
    const migrationStore = new InMemoryMigrationStore();

    const mgr = new MigrationManager({
      keyStore: new InMemoryKeyStore(),
      pendingKeyStore,
      migrationStore,
    });
    await mgr.init();
    await mgr.startMigration(DeviceIdentity.generate(), [contact("peer")], RETIRE_AT);

    // Pending slot is cleartext (the graceful fallback) ...
    expect(pendingSlot.value && isSecureEnvelope(pendingSlot.value)).toBe(false);
    // ... but the migration state still carries no private key material.
    const stateJson = JSON.stringify(await migrationStore.load());
    expect(stateJson).not.toContain("signingPrivB64u");
    expect(stateJson).not.toContain("newStoredKeys");
  });
});
