// Full encrypted device backup + restore (ORPAL-017).
//
// This is the BIG SIBLING of the contact export (issue #41). Where that bundle
// carries only the publicly shareable fields of each contact, THIS exports the
// ENTIRE app state -- identity private keys, full message history, the pending
// send queue, settings (incl. TURN credentials), any in-flight migration, and the
// block list -- so a user can move to a new device or recover from disaster.
//
// SECURITY POSTURE (read this before touching the crypto):
//   * The plaintext payload contains the identity PRIVATE KEY in cleartext. The
//     ONLY thing protecting it is the user's password. A weak password = a
//     compromised identity. The backup file must be treated as sensitive as the
//     private key itself.
//   * The file is sealed with AES-256-GCM under a key derived from the password by
//     PBKDF2-HMAC-SHA256 (600k iterations by default; tuned to ~1s on target
//     hardware). The salt + iv + KDF params travel in cleartext alongside the
//     ciphertext (standard practice -- they are not secret; the password is).
//   * We deliberately use a PASSWORD (not the device's secure element) so the file
//     is portable: it must import on a DIFFERENT device that does not share the
//     original's hardware-sealed key. Cross-platform by construction -- a web
//     export imports on Android/iOS and vice versa, because everything is JSON +
//     base64url + standard PBKDF2/AES-GCM.
//
// This module is PURE + framework-agnostic (no DOM, no Capacitor): it only seals
// and opens a payload. Gathering the state to back up and committing a restore is
// the OrpalClient's job (it owns the stores); persisting the shell-owned settings
// is the shell's job. Settings are therefore opaque here (a generic JSON value).

import { gcm } from "@noble/ciphers/aes";
import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import { b64uDecode, b64uEncode } from "../orp.js";
import type { StoredKeys } from "../identity/secure-store.js";
import type { Contact } from "../contacts/contact.js";
import type { StoredMessage } from "../persistence/conversation-store.js";
import type { PendingMessage } from "../messaging/pending-queue.js";
import type { MigrationState } from "../messaging/migration-manager.js";

export const BACKUP_KIND = "orpal-full-backup";
export const BACKUP_VERSION = 1;

/** Default PBKDF2 iteration count. High enough to make an offline brute-force of a
 *  decent password expensive (~1s/derivation on 2020s hardware). Stored in the
 *  envelope so a future bump stays importable -- open() uses the file's count. */
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

/** Minimum password length we enforce in the UI. The private key's entire safety
 *  rests on this, so we nudge hard; longer + unique is strongly recommended. */
export const BACKUP_MIN_PASSWORD_LENGTH = 12;

/** Key-derivation parameters, recorded in cleartext in the envelope. Not secret --
 *  the password is the secret. Captured so import never has to guess them. */
export interface BackupKdf {
  name: "PBKDF2";
  hash: "SHA-256";
  iterations: number;
}

/**
 * The on-disk envelope. Everything secret lives inside `sealed` (AES-256-GCM
 * ciphertext, base64url); `salt`/`iv`/`kdf` are the public parameters needed to
 * re-derive the key and decrypt given the password.
 */
export interface DeviceBackup {
  v: typeof BACKUP_VERSION;
  kind: typeof BACKUP_KIND;
  exportedUtc: string;
  kdf: BackupKdf;
  /** base64url of the 32-byte PBKDF2 salt. */
  salt: string;
  /** base64url of the 12-byte AES-GCM IV. */
  iv: string;
  /** base64url of AES-256-GCM(ciphertext || 16-byte tag) over the JSON payload. */
  sealed: string;
}

/**
 * The decrypted contents. `settings` is intentionally opaque (`TSettings`,
 * default `unknown`): app settings are defined by the shell, not core, so core
 * round-trips them as JSON without knowing their shape.
 */
export interface BackupPayload<TSettings = unknown> {
  /** The identity private keys -- THE core secret (see file header). */
  identity: StoredKeys;
  /** Every contact, with all fields (transport keys, board routes, settings). */
  contacts: Contact[];
  /** Full message history, grouped by contact identity key. */
  messages: Record<string, StoredMessage[]>;
  /** The durable offline send queue (unsent message content -- secret). */
  pending: PendingMessage[];
  /** Shell-owned app settings (boards, ICE config, TURN credentials, ...). */
  settings: TSettings;
  /** Any in-flight identity migration, or null. When present its pending new
   *  identity private keys ride along (embedded as `newStoredKeys`, the legacy
   *  shape MigrationManager.init promotes into its sealed slot on next startup). */
  migrationState: (MigrationState & { newStoredKeys?: StoredKeys }) | null;
  /** Blocked identity keys. */
  blockedKeys: string[];
}

/** Counts shown to the user before they commit an import. */
export interface BackupSummary {
  exportedUtc: string;
  /** The identity key the backup would install, or null if unreadable. */
  identityKey: string | null;
  contacts: number;
  messages: number;
  pending: number;
  hasMigration: boolean;
  blocked: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  return pbkdf2Async(sha256, textEncoder.encode(password), salt, { c: iterations, dkLen: 32 });
}

export interface SealBackupOptions {
  now?: () => string;
  /** Override the PBKDF2 iteration count (defaults to {@link DEFAULT_PBKDF2_ITERATIONS}). */
  iterations?: number;
  /** Test seam: fixed salt/iv for deterministic vectors. Never set in production. */
  salt?: Uint8Array;
  iv?: Uint8Array;
}

/**
 * Seal a payload into a {@link DeviceBackup} envelope under `password`. Generates a
 * fresh random salt + iv, derives the AES key via PBKDF2, and AES-256-GCM-encrypts
 * the JSON. Rejects an empty password outright (the file's only protection).
 */
export async function sealBackup<T>(
  payload: BackupPayload<T>,
  password: string,
  opts: SealBackupOptions = {},
): Promise<DeviceBackup> {
  if (!password) throw new Error("backup: a password is required to seal a backup");
  const now = opts.now ?? (() => new Date().toISOString());
  const iterations = opts.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = opts.salt ?? randomBytes(32);
  const iv = opts.iv ?? randomBytes(12);
  const key = await deriveKey(password, salt, iterations);
  const plaintext = textEncoder.encode(JSON.stringify(payload));
  const sealed = gcm(key, iv).encrypt(plaintext);
  return {
    v: BACKUP_VERSION,
    kind: BACKUP_KIND,
    exportedUtc: now(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations },
    salt: b64uEncode(salt),
    iv: b64uEncode(iv),
    sealed: b64uEncode(sealed),
  };
}

/** Convenience: seal + JSON.stringify, ready to write to a file. */
export async function serializeBackup<T>(
  payload: BackupPayload<T>,
  password: string,
  opts: SealBackupOptions = {},
): Promise<string> {
  return JSON.stringify(await sealBackup(payload, password, opts), null, 2);
}

/**
 * Parse + shallow-validate the envelope WITHOUT decrypting (no password needed).
 * Confirms this is a supported Orpal full-backup file and the crypto fields are
 * present + well-formed, so the UI can reject an obviously-wrong file before
 * prompting for a password.
 */
export function parseBackupEnvelope(
  input: string | DeviceBackup,
): { valid: boolean; reason?: string; envelope?: DeviceBackup } {
  let obj: unknown;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return { valid: false, reason: "not-valid-json" };
    }
  } else {
    obj = input;
  }
  if (typeof obj !== "object" || obj === null) return { valid: false, reason: "not-an-object" };
  const o = obj as Record<string, unknown>;
  if (o.kind !== BACKUP_KIND) return { valid: false, reason: "not-a-device-backup" };
  if (o.v !== BACKUP_VERSION) return { valid: false, reason: "unsupported-version" };
  if (typeof o.salt !== "string" || typeof o.iv !== "string" || typeof o.sealed !== "string") {
    return { valid: false, reason: "missing-crypto-fields" };
  }
  const kdf = o.kdf as Partial<BackupKdf> | undefined;
  if (!kdf || kdf.name !== "PBKDF2" || typeof kdf.iterations !== "number" || kdf.iterations <= 0) {
    return { valid: false, reason: "bad-kdf-params" };
  }
  return {
    valid: true,
    envelope: {
      v: BACKUP_VERSION,
      kind: BACKUP_KIND,
      exportedUtc: typeof o.exportedUtc === "string" ? o.exportedUtc : "",
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations },
      salt: o.salt,
      iv: o.iv,
      sealed: o.sealed,
    },
  };
}

/** Minimal structural check that decrypted JSON looks like a payload (not just any
 *  JSON an attacker could craft to also GCM-verify under a guessed key -- which is
 *  infeasible anyway, but a cheap sanity gate against a corrupt/old file). */
function looksLikePayload(o: unknown): o is BackupPayload {
  if (typeof o !== "object" || o === null) return false;
  const p = o as Record<string, unknown>;
  return (
    typeof p.identity === "object" &&
    p.identity !== null &&
    Array.isArray(p.contacts) &&
    typeof p.messages === "object" &&
    p.messages !== null &&
    Array.isArray(p.pending) &&
    Array.isArray(p.blockedKeys)
  );
}

/**
 * Decrypt + validate a backup with `password`. Returns the payload on success; on
 * failure returns a short machine-readable reason -- crucially WITHOUT
 * distinguishing "wrong password" from "tampered file" beyond `bad-password-or-corrupt`,
 * since AES-GCM auth failure covers both (a wrong key fails the tag check exactly
 * as tampering does).
 */
export async function openBackup<T = unknown>(
  input: string | DeviceBackup,
  password: string,
): Promise<{ ok: true; payload: BackupPayload<T> } | { ok: false; reason: string }> {
  const parsed = parseBackupEnvelope(input);
  if (!parsed.valid || !parsed.envelope) return { ok: false, reason: parsed.reason ?? "invalid" };
  if (!password) return { ok: false, reason: "password-required" };
  const env = parsed.envelope;
  let plaintext: Uint8Array;
  try {
    const key = await deriveKey(password, b64uDecode(env.salt), env.kdf.iterations);
    plaintext = gcm(key, b64uDecode(env.iv)).decrypt(b64uDecode(env.sealed));
  } catch {
    return { ok: false, reason: "bad-password-or-corrupt" };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(textDecoder.decode(plaintext));
  } catch {
    return { ok: false, reason: "decrypted-not-json" };
  }
  if (!looksLikePayload(payload)) return { ok: false, reason: "not-a-backup-payload" };
  return { ok: true, payload: payload as BackupPayload<T> };
}

/** Derive the at-a-glance summary shown before an import is committed. */
export function summarizeBackup(payload: BackupPayload, identityKey: string | null): BackupSummary {
  let messages = 0;
  for (const list of Object.values(payload.messages)) messages += list.length;
  return {
    exportedUtc: "",
    identityKey,
    contacts: payload.contacts.length,
    messages,
    pending: payload.pending.length,
    hasMigration: payload.migrationState !== null,
    blocked: payload.blockedKeys.length,
  };
}

/** Validate a candidate export password against the enforced minimum. Returns a
 *  human-readable reason when too weak, or null when acceptable. UI-facing -- the
 *  seal itself only rejects an empty password. */
export function validateBackupPassword(password: string): string | null {
  if (password.length < BACKUP_MIN_PASSWORD_LENGTH) {
    return `Use at least ${BACKUP_MIN_PASSWORD_LENGTH} characters. This password is the only thing protecting your private key.`;
  }
  return null;
}
