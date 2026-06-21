import { describe, it, expect } from "vitest";
import {
  createBackup,
  decryptBackup,
  parseBackupEnvelope,
  summarizeBackup,
  BackupDecryptError,
  type BackupPayload,
} from "../src/backup/backup.js";

const SAMPLE_PAYLOAD: BackupPayload = {
  identity: {
    signingPrivB64u: "c2lnbmluZy1rZXk",
    transportPrivB64u: "dHJhbnNwb3J0LWtleQ",
    createdUtc: "2026-06-20T00:00:00.000Z",
  },
  contacts: [
    {
      identityKey: "contact-key-1",
      transportKey: "transport-key-1",
      binding: { identity_key: "contact-key-1", transport_key: "transport-key-1", created_utc: "2026-06-20T00:00:00.000Z", binding_sig: "sig" },
      displayName: "Alice",
      relayOnly: false,
      addedUtc: "2026-06-20T00:00:00.000Z",
    },
  ],
  messages: {
    "contact-key-1": [
      { id: "msg-1", contactKey: "contact-key-1", direction: "in", kind: "text", text: "hello", ts: 1000, state: "delivered" },
      { id: "msg-2", contactKey: "contact-key-1", direction: "out", kind: "text", text: "hi back", ts: 2000, state: "acknowledged" },
    ],
  },
  pending: [
    { recipientId: "contact-key-1", recipientTransportKey: "tk", messageId: "msg-3", timestamp: 3000, attemptCount: 2, lastAttemptAt: 2500, payload: { kind: "text", text: "queued msg" } },
  ],
  settings: {
    boards: ["wss://board.roshew.com/"],
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    relayOnlyByDefault: false,
    blockedKeys: ["blocked-key-1"],
  },
  migrationState: null,
};

describe("full encrypted backup (ORPAL-017)", () => {
  it("round-trips a backup through encrypt and decrypt", async () => {
    const password = "test-password-strong-enough";
    const backupJson = await createBackup(SAMPLE_PAYLOAD, password);
    const envelope = parseBackupEnvelope(backupJson);
    const restored = await decryptBackup(envelope, password);

    expect(restored.identity).toEqual(SAMPLE_PAYLOAD.identity);
    expect(restored.contacts).toEqual(SAMPLE_PAYLOAD.contacts);
    expect(restored.messages).toEqual(SAMPLE_PAYLOAD.messages);
    expect(restored.pending).toEqual(SAMPLE_PAYLOAD.pending);
    expect(restored.settings).toEqual(SAMPLE_PAYLOAD.settings);
    expect(restored.migrationState).toBeNull();
  });

  it("rejects a wrong password", async () => {
    const backupJson = await createBackup(SAMPLE_PAYLOAD, "correct-password");
    const envelope = parseBackupEnvelope(backupJson);
    await expect(decryptBackup(envelope, "wrong-password")).rejects.toThrow(BackupDecryptError);
    await expect(decryptBackup(envelope, "wrong-password")).rejects.toThrow(/wrong password/i);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseBackupEnvelope("not json")).toThrow(BackupDecryptError);
    expect(() => parseBackupEnvelope("not json")).toThrow(/not valid json/i);
  });

  it("rejects a non-backup JSON object", () => {
    expect(() => parseBackupEnvelope(JSON.stringify({ v: 1, kind: "not-a-backup" }))).toThrow(/not a valid orpal backup/i);
  });

  it("produces a correct summary", async () => {
    const backupJson = await createBackup(SAMPLE_PAYLOAD, "pw");
    const envelope = parseBackupEnvelope(backupJson);
    const restored = await decryptBackup(envelope, "pw");
    const summary = summarizeBackup(restored, envelope.exportedUtc);

    expect(summary.contactCount).toBe(1);
    expect(summary.messageCount).toBe(2);
    expect(summary.pendingCount).toBe(1);
    expect(summary.hasMigration).toBe(false);
    expect(summary.exportedUtc).toBeTruthy();
  });

  it("each backup has a unique salt and IV (not reused)", async () => {
    const b1 = parseBackupEnvelope(await createBackup(SAMPLE_PAYLOAD, "pw"));
    const b2 = parseBackupEnvelope(await createBackup(SAMPLE_PAYLOAD, "pw"));
    expect(b1.salt).not.toBe(b2.salt);
    expect(b1.iv).not.toBe(b2.iv);
    expect(b1.ciphertext).not.toBe(b2.ciphertext);
  });

  it("private key material does not appear in the ciphertext", async () => {
    const backupJson = await createBackup(SAMPLE_PAYLOAD, "pw");
    expect(backupJson).not.toContain(SAMPLE_PAYLOAD.identity.signingPrivB64u);
    expect(backupJson).not.toContain(SAMPLE_PAYLOAD.identity.transportPrivB64u);
    expect(backupJson).not.toContain("queued msg");
  });
});
