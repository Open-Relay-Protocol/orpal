// ORPAL-017: Full encrypted device backup and restore.
//
// Produces a single password-encrypted file containing everything needed to
// move to a new device: identity keys, contacts, message history, pending
// queue, settings, migration state, and block list. The password is the ONLY
// protection -- the backup is designed to be transferable over untrusted
// channels (email, cloud, USB).
//
// Crypto: PBKDF2-SHA256 (600k iterations) -> AES-256-GCM. All via Web Crypto
// API -- no new dependencies. Password-based (not hardware-sealed) because
// the backup must be importable on a DIFFERENT device.

import type { Contact } from "../contacts/contact.js";
import type { StoredMessage } from "../persistence/conversation-store.js";
import type { PendingMessage } from "../messaging/pending-queue.js";
import type { StoredKeys } from "../identity/secure-store.js";
import type { MigrationState } from "../messaging/migration-manager.js";

export const BACKUP_KIND = "orpal-full-backup" as const;
export const BACKUP_VERSION = 1 as const;

const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 32;
const IV_BYTES = 12;

const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

export interface BackupSettings {
  boards: string[];
  iceServers: unknown[];
  relayOnlyByDefault: boolean;
  blockedKeys?: string[];
}

export interface BackupPayload {
  identity: StoredKeys;
  contacts: Contact[];
  messages: Record<string, StoredMessage[]>;
  pending: PendingMessage[];
  settings: BackupSettings;
  migrationState: MigrationState | null;
}

export interface BackupEnvelope {
  v: typeof BACKUP_VERSION;
  kind: typeof BACKUP_KIND;
  exportedUtc: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface BackupImportSummary {
  identityKey: string;
  contactCount: number;
  messageCount: number;
  pendingCount: number;
  hasMigration: boolean;
  exportedUtc: string;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createBackup(payload: BackupPayload, password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const plaintext = enc.encode(JSON.stringify(payload));
  const ciphertextBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(plaintext));
  const envelope: BackupEnvelope = {
    v: BACKUP_VERSION,
    kind: BACKUP_KIND,
    exportedUtc: new Date().toISOString(),
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(new Uint8Array(ciphertextBuf)),
  };
  return JSON.stringify(envelope, null, 2);
}

export class BackupDecryptError extends Error {
  constructor(
    message: string,
    readonly code: "invalid-format" | "wrong-password" | "corrupted",
  ) {
    super(message);
    this.name = "BackupDecryptError";
  }
}

export function parseBackupEnvelope(text: string): BackupEnvelope {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new BackupDecryptError("Not valid JSON.", "invalid-format");
  }
  const e = obj as Partial<BackupEnvelope>;
  if (e.kind !== BACKUP_KIND || e.v !== BACKUP_VERSION) {
    throw new BackupDecryptError("Not a valid Orpal backup file.", "invalid-format");
  }
  if (!e.salt || !e.iv || !e.ciphertext || !e.exportedUtc) {
    throw new BackupDecryptError("Backup file is missing required fields.", "invalid-format");
  }
  return e as BackupEnvelope;
}

export async function decryptBackup(envelope: BackupEnvelope, password: string): Promise<BackupPayload> {
  const salt = fromB64(envelope.salt);
  const iv = fromB64(envelope.iv);
  const ciphertext = fromB64(envelope.ciphertext);
  const key = await deriveKey(password, salt);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(ciphertext));
  } catch {
    throw new BackupDecryptError("Wrong password or corrupted backup.", "wrong-password");
  }
  const dec = new TextDecoder();
  let payload: BackupPayload;
  try {
    payload = JSON.parse(dec.decode(plaintext)) as BackupPayload;
  } catch {
    throw new BackupDecryptError("Decrypted data is not valid JSON.", "corrupted");
  }
  if (!payload.identity || !payload.contacts || !payload.messages) {
    throw new BackupDecryptError("Backup is missing required data.", "corrupted");
  }
  return payload;
}

export function summarizeBackup(payload: BackupPayload, exportedUtc: string): BackupImportSummary {
  let messageCount = 0;
  for (const msgs of Object.values(payload.messages)) messageCount += msgs.length;
  return {
    identityKey: payload.identity.signingPrivB64u ? "(present)" : "(missing)",
    contactCount: payload.contacts.length,
    messageCount,
    pendingCount: payload.pending?.length ?? 0,
    hasMigration: payload.migrationState !== null,
    exportedUtc,
  };
}
