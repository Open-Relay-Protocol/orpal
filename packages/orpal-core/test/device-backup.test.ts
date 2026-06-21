import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  IdentityManager,
  InMemoryConversationStore,
  InMemoryKeyStore,
  InMemoryMigrationStore,
  InMemoryPendingQueueStore,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  openBackup,
  parseBackupEnvelope,
  sealBackup,
  serializeBackup,
  summarizeBackup,
  validateBackupPassword,
  BACKUP_KIND,
  type BackupPayload,
  type StoredMessage,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { linkIdentity } from "./helpers/link.js";

// Full encrypted device backup + restore (ORPAL-017). These exercise both halves:
// the pure password-sealing crypto, and the OrpalClient orchestration that gathers
// the entire device state into a backup and restores it onto a fresh device.

const PW = "correct-horse-battery-staple";

function samplePayload(over: Partial<BackupPayload> = {}): BackupPayload {
  const keys = IdentityManager.mintStoredKeys("2024-01-01T00:00:00.000Z");
  return {
    identity: keys,
    contacts: [],
    messages: {},
    pending: [],
    settings: { boards: ["wss://b/"], theme: "dark" },
    migrationState: null,
    blockedKeys: [],
    ...over,
  };
}

describe("device backup sealing", () => {
  it("round-trips a payload through seal -> open with the right password", async () => {
    const payload = samplePayload({ blockedKeys: ["abc"], settings: { x: 1 } });
    const sealed = await sealBackup(payload, PW);
    expect(sealed.kind).toBe(BACKUP_KIND);
    expect(sealed.v).toBe(1);
    expect(sealed.kdf.iterations).toBeGreaterThanOrEqual(600_000);

    const opened = await openBackup(sealed, PW);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.payload.identity).toEqual(payload.identity);
    expect(opened.payload.blockedKeys).toEqual(["abc"]);
    expect(opened.payload.settings).toEqual({ x: 1 });
  });

  it("fails to open with a wrong password (GCM auth)", async () => {
    const sealed = await sealBackup(samplePayload(), PW);
    const opened = await openBackup(sealed, "wrong-password-entirely");
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toBe("bad-password-or-corrupt");
  });

  it("fails to open a tampered ciphertext", async () => {
    const json = await serializeBackup(samplePayload(), PW);
    const env = JSON.parse(json);
    // Flip a byte of the sealed ciphertext: the GCM tag check must reject it.
    env.sealed = env.sealed.slice(0, -2) + (env.sealed.slice(-2) === "AA" ? "BB" : "AA");
    const opened = await openBackup(JSON.stringify(env), PW);
    expect(opened.ok).toBe(false);
  });

  it("never leaks plaintext secrets into the envelope", async () => {
    const payload = samplePayload({
      messages: { peer: [{ id: "1", contactKey: "peer", direction: "in", kind: "text", text: "top secret", ts: 1, state: "delivered" }] },
    });
    const json = await serializeBackup(payload, PW);
    expect(json).not.toContain("top secret");
    expect(json).not.toContain(payload.identity.signingPrivB64u);
  });

  it("rejects an empty password on seal", async () => {
    await expect(sealBackup(samplePayload(), "")).rejects.toThrow(/password/i);
  });

  it("validates the envelope shape without a password", () => {
    expect(parseBackupEnvelope("nope").reason).toBe("not-valid-json");
    expect(parseBackupEnvelope(JSON.stringify({ kind: "other" })).reason).toBe("not-a-device-backup");
    expect(parseBackupEnvelope(JSON.stringify({ kind: BACKUP_KIND, v: 2 })).reason).toBe("unsupported-version");
    expect(
      parseBackupEnvelope(JSON.stringify({ kind: BACKUP_KIND, v: 1, salt: "a", iv: "b", sealed: "c" })).reason,
    ).toBe("bad-kdf-params");
  });

  it("summarizes counts for the import preview", () => {
    const payload = samplePayload({
      contacts: [{ identityKey: "k" } as never],
      messages: { a: [{} as StoredMessage, {} as StoredMessage], b: [{} as StoredMessage] },
      pending: [{} as never],
      blockedKeys: ["x", "y"],
    });
    const s = summarizeBackup(payload, "ident-key");
    expect(s).toMatchObject({ identityKey: "ident-key", contacts: 1, messages: 3, pending: 1, blocked: 2, hasMigration: false });
  });

  it("enforces a minimum export password length", () => {
    expect(validateBackupPassword("short")).toMatch(/at least/);
    expect(validateBackupPassword("a-long-enough-passphrase")).toBeNull();
  });
});

// ---- OrpalClient export / restore orchestration -----------------------------

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

async function makeClient() {
  const keyStore = new InMemoryKeyStore();
  const { identity } = await IdentityManager.loadOrCreate(keyStore);
  const store = new InMemoryConversationStore();
  const pendingQueue = new InMemoryPendingQueueStore();
  const migrationStore = new InMemoryMigrationStore();
  // The migration's pending new-identity keys live in their own sealed slot in
  // production (setup.ts). Wire one here so the backup can capture them.
  const migrationKeyStore = new InMemoryKeyStore();
  const network = new MockNetwork();
  const client = new OrpalClient({
    identity,
    store,
    pendingQueue,
    broker: new MockBoard(),
    webrtcFactory: (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all"),
    keyStore,
    migrationStore,
    migrationKeyStore,
  });
  live.push(client);
  await client.start();
  return { client, keyStore, store, pendingQueue };
}

describe("OrpalClient full backup + restore", () => {
  it("exports the entire device state and restores it onto a fresh device", async () => {
    const a = await makeClient();

    // Seed: a contact, history (incl. an unknown-sender conversation), a pending msg.
    const peer = DeviceIdentity.generate();
    await linkIdentity(a.client, peer);
    await a.store.appendMessage({ id: "m1", contactKey: peer.identityKeyB64, direction: "in", kind: "text", text: "hi from peer", ts: 10, state: "delivered" });
    await a.store.appendMessage({ id: "m2", contactKey: "unknown-sender", direction: "in", kind: "text", text: "stranger", ts: 20, state: "delivered" });
    await a.pendingQueue.enqueue({ recipientId: peer.identityKeyB64, recipientTransportKey: peer.transportKeyB64, messageId: "p1", timestamp: 5, attemptCount: 0, lastAttemptAt: null, payload: { kind: "text", text: "queued" } });

    const json = await a.client.exportBackup(PW, { boards: ["wss://mine/"], secretTurn: "creds" });
    expect(json).not.toContain("queued"); // plaintext is sealed
    expect(json).not.toContain("hi from peer");

    // A brand-new device opens + restores (replace).
    const b = await makeClient();
    const opened = await b.client.readBackup(json, PW);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.result.summary.contacts).toBe(1);
    expect(opened.result.summary.messages).toBe(2);
    expect(opened.result.summary.pending).toBe(1);
    expect(opened.result.identityConflict).toBe(true); // b had its own identity

    const restored = await b.client.restoreBackup(opened.result.payload, { mode: "replace" });
    expect(restored.contactsImported).toBe(1);
    expect(restored.messagesImported).toBe(2);
    expect(restored.pendingImported).toBe(1);
    expect(restored.identityImported).toBe(true);
    expect(restored.restartRequired).toBe(true);
    expect(restored.settings).toMatchObject({ secretTurn: "creds" });

    // Data landed in b's stores.
    expect((await b.store.listContacts()).map((c) => c.identityKey)).toContain(peer.identityKeyB64);
    expect((await b.store.listAllMessages()).map((m) => m.id).sort()).toEqual(["m1", "m2"]);
    expect((await b.pendingQueue.list()).map((p) => p.messageId)).toEqual(["p1"]);
    // b's identity slot now holds a's identity (the key migration to this device).
    const installed = await b.keyStore.load();
    expect(IdentityManager.fromStored(installed!).identityKeyB64).toBe(a.client.identityKey);
  });

  it("merge adds only items missing locally; replace wipes first", async () => {
    const a = await makeClient();
    const peer1 = DeviceIdentity.generate();
    const peer2 = DeviceIdentity.generate();
    await linkIdentity(a.client, peer1);
    await linkIdentity(a.client, peer2);
    await a.store.appendMessage({ id: "x1", contactKey: peer1.identityKeyB64, direction: "in", kind: "text", text: "one", ts: 1, state: "delivered" });
    const json = await a.client.exportBackup(PW, {});

    // Target already has peer1 + message x1; merge should skip those, add peer2.
    const b = await makeClient();
    await linkIdentity(b.client, peer1);
    await b.store.appendMessage({ id: "x1", contactKey: peer1.identityKeyB64, direction: "in", kind: "text", text: "one", ts: 1, state: "delivered" });
    await b.store.appendMessage({ id: "local-only", contactKey: peer1.identityKeyB64, direction: "out", kind: "text", text: "keep me", ts: 2, state: "delivered" });

    const opened = await b.client.readBackup(json, PW);
    if (!opened.ok) throw new Error(opened.reason);
    const merged = await b.client.restoreBackup(opened.result.payload, { mode: "merge", importIdentity: false });
    expect(merged.contactsImported).toBe(1); // peer2
    expect(merged.contactsSkipped).toBe(1); // peer1
    expect(merged.messagesSkipped).toBe(1); // x1
    expect(merged.identityImported).toBe(false);
    // Local-only message is preserved under merge.
    expect((await b.store.getMessage("local-only"))).not.toBeNull();

    // Replace wipes the local-only message.
    const opened2 = await b.client.readBackup(json, PW);
    if (!opened2.ok) throw new Error(opened2.reason);
    await b.client.restoreBackup(opened2.result.payload, { mode: "replace", importIdentity: false });
    expect(await b.store.getMessage("local-only")).toBeNull();
  });

  it("preserves an in-flight migration's pending keys across a backup", async () => {
    const a = await makeClient();
    const peer = DeviceIdentity.generate();
    await linkIdentity(a.client, peer);
    await a.client.startMigration(new Date(Date.now() + 60_000).toISOString());

    const json = await a.client.exportBackup(PW, {});
    const opened = await openBackup(json, PW);
    if (!opened.ok) throw new Error(opened.reason);
    expect(opened.payload.migrationState).not.toBeNull();
    // The pending new-identity private keys ride along (legacy `newStoredKeys`
    // field) so the importing device can resume the migration on next startup.
    expect(opened.payload.migrationState?.newStoredKeys).toBeTruthy();
  });
});
