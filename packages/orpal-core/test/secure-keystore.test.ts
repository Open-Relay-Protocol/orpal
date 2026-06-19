import { describe, it, expect, vi } from "vitest";
import {
  HardwareBackedKeyStore,
  IdentityManager,
  isSecureEnvelope,
  type HardwareKeyProvider,
  type KeyBlobStore,
  type PersistedKeys,
  type StoredKeys,
} from "../src/index.js";

// An in-memory KeyBlobStore standing in for the shell's underlying slot
// (IndexedDB on the web, Keychain/Keystore on native).
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

// A fake secure element: "sealing" is a reversible byte transform plus a tag so
// the test can prove the bytes at rest are not the cleartext keys. Stands in for
// WebAuthn-PRF / Secure Enclave / StrongBox / TPM, which core never sees.
class FakeHardwareProvider implements HardwareKeyProvider {
  readonly backend = "fake-secure-element";
  available = true;
  wrapCalls = 0;
  constructor(private readonly mask = 0x5a) {}
  async isAvailable(): Promise<boolean> {
    return this.available;
  }
  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    this.wrapCalls++;
    return plaintext.map((b) => b ^ this.mask);
  }
  async unwrap(sealed: Uint8Array): Promise<Uint8Array> {
    return sealed.map((b) => b ^ this.mask);
  }
}

const SAMPLE: StoredKeys = {
  signingPrivB64u: "c2lnbmluZy1rZXk",
  transportPrivB64u: "dHJhbnNwb3J0LWtleQ",
  createdUtc: "2026-06-19T00:00:00.000Z",
};

describe("HardwareBackedKeyStore — secure path", () => {
  it("seals keys into an envelope and round-trips them back", async () => {
    const slot = new MemoryBlobStore();
    const hw = new FakeHardwareProvider();
    const store = new HardwareBackedKeyStore(slot, hw);

    await store.save(SAMPLE);

    expect(hw.wrapCalls).toBe(1);
    // What's persisted is a sealed envelope, not the cleartext keys.
    expect(slot.value && isSecureEnvelope(slot.value)).toBe(true);
    const envelope = slot.value as Extract<PersistedKeys, { kind: "hw" }>;
    expect(envelope.backend).toBe("fake-secure-element");
    // The raw private-key material must not appear anywhere at rest.
    expect(JSON.stringify(slot.value)).not.toContain(SAMPLE.signingPrivB64u);

    expect(await store.load()).toEqual(SAMPLE);
  });

  it("errors (rather than silently losing keys) when a sealed slot has no provider", async () => {
    const slot = new MemoryBlobStore();
    await new HardwareBackedKeyStore(slot, new FakeHardwareProvider()).save(SAMPLE);

    const noHw = new HardwareBackedKeyStore(slot, null);
    await expect(noHw.load()).rejects.toThrow(/sealed to secure hardware/i);
  });
});

describe("HardwareBackedKeyStore — fallback path", () => {
  it("stores cleartext when no provider is supplied", async () => {
    const slot = new MemoryBlobStore();
    const store = new HardwareBackedKeyStore(slot, null);

    await store.save(SAMPLE);

    expect(slot.value && isSecureEnvelope(slot.value)).toBe(false);
    expect(slot.value).toEqual(SAMPLE);
    expect(await store.load()).toEqual(SAMPLE);
  });

  it("stores cleartext when the device reports no secure hardware", async () => {
    const slot = new MemoryBlobStore();
    const hw = new FakeHardwareProvider();
    hw.available = false;
    const store = new HardwareBackedKeyStore(slot, hw);

    await store.save(SAMPLE);

    expect(hw.wrapCalls).toBe(0);
    expect(slot.value).toEqual(SAMPLE);
    expect(await store.load()).toEqual(SAMPLE);
  });

  it("falls back to cleartext (and reports) if sealing throws despite availability", async () => {
    const slot = new MemoryBlobStore();
    const hw = new FakeHardwareProvider();
    hw.wrap = vi.fn().mockRejectedValue(new Error("user dismissed the biometric prompt"));
    const onFallback = vi.fn();
    const store = new HardwareBackedKeyStore(slot, hw, onFallback);

    await store.save(SAMPLE);

    expect(onFallback).toHaveBeenCalledOnce();
    expect(slot.value).toEqual(SAMPLE);
    expect(await store.load()).toEqual(SAMPLE);
  });

  it("re-seals a pre-existing cleartext slot on load when hardware is available", async () => {
    // Simulate an install that predates ORPAL-007: cleartext keys already at rest.
    const slot = new MemoryBlobStore();
    slot.value = { ...SAMPLE };

    const hw = new FakeHardwareProvider();
    const store = new HardwareBackedKeyStore(slot, hw);

    // Loading still returns the right keys...
    expect(await store.load()).toEqual(SAMPLE);
    // ...and as a side effect the at-rest copy is upgraded to a sealed envelope.
    expect(hw.wrapCalls).toBe(1);
    expect(slot.value && isSecureEnvelope(slot.value)).toBe(true);
    expect(JSON.stringify(slot.value)).not.toContain(SAMPLE.signingPrivB64u);

    // A subsequent load goes through the envelope branch and does NOT re-seal again.
    expect(await store.load()).toEqual(SAMPLE);
    expect(hw.wrapCalls).toBe(1);
  });

  it("leaves a cleartext slot untouched on load when no hardware is available", async () => {
    const slot = new MemoryBlobStore();
    slot.value = { ...SAMPLE };
    const hw = new FakeHardwareProvider();
    hw.available = false;

    const store = new HardwareBackedKeyStore(slot, hw);
    expect(await store.load()).toEqual(SAMPLE);
    expect(hw.wrapCalls).toBe(0);
    expect(slot.value).toEqual(SAMPLE); // still cleartext, unchanged
  });

  it("returns the keys even if an opportunistic reseal throws on load", async () => {
    const slot = new MemoryBlobStore();
    slot.value = { ...SAMPLE };
    const hw = new FakeHardwareProvider();
    hw.wrap = vi.fn().mockRejectedValue(new Error("biometric prompt dismissed"));
    const onFallback = vi.fn();

    const store = new HardwareBackedKeyStore(slot, hw, onFallback);
    expect(await store.load()).toEqual(SAMPLE);
    expect(onFallback).toHaveBeenCalled();
    expect(slot.value).toEqual(SAMPLE); // unchanged; will retry next load
  });

  it("returns null for an empty slot", async () => {
    const store = new HardwareBackedKeyStore(new MemoryBlobStore(), new FakeHardwareProvider());
    expect(await store.load()).toBeNull();
  });

  it("clear() empties the slot", async () => {
    const slot = new MemoryBlobStore();
    const store = new HardwareBackedKeyStore(slot, new FakeHardwareProvider());
    await store.save(SAMPLE);
    await store.clear();
    expect(slot.value).toBeNull();
    expect(await store.load()).toBeNull();
  });
});

describe("IdentityManager over a HardwareBackedKeyStore", () => {
  it("loadOrCreate works unchanged on the secure path", async () => {
    const slot = new MemoryBlobStore();
    const hw = new FakeHardwareProvider();
    const store = new HardwareBackedKeyStore(slot, hw);

    const first = await IdentityManager.loadOrCreate(store);
    expect(first.created).toBe(true);
    expect(slot.value && isSecureEnvelope(slot.value)).toBe(true);

    // A second load reconstructs the SAME identity from the sealed envelope.
    const second = await IdentityManager.loadOrCreate(store);
    expect(second.created).toBe(false);
    expect(second.identity.exportPublic().identity_key).toBe(
      first.identity.exportPublic().identity_key,
    );
  });

  it("loadOrCreate works unchanged on the cleartext fallback path", async () => {
    const store = new HardwareBackedKeyStore(new MemoryBlobStore(), null);
    const first = await IdentityManager.loadOrCreate(store);
    const second = await IdentityManager.loadOrCreate(store);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.identity.exportPublic().identity_key).toBe(
      first.identity.exportPublic().identity_key,
    );
  });
});
