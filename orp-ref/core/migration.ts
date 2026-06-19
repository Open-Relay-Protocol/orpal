// SPDX-License-Identifier: Apache-2.0
//
// ORP-004: identity rotation protocol — a GRACEFUL, trusted key migration.
//
// Generating a fresh DeviceIdentity is an abrupt "reset": contacts who knew the
// old identity key have no cryptographic reason to trust the new one, so the
// social graph silently breaks. This module adds the missing migration path: a
// signed announcement in which the OLD identity vouches for a replacement key,
// the NEW identity co-signs to prove it consents and controls the replacement,
// and both keys remain valid until a cutoff after which the old one retires.
//
// SIGNATURE CHAIN (the security property): a recipient who already trusts
// `old_key` can transfer that trust to `new_key` because:
//   1. `old_sig` is a valid Ed25519 signature by OLD_KEY over the migration
//      body — old_key authorizes the migration. This is the load-bearing link:
//      only the holder of the old signing key can mint it.
//   2. `new_sig` is a valid Ed25519 signature by NEW_KEY over the same body —
//      the new identity accepts the migration (so old_key cannot conscript an
//      unwitting/uncontrolled key), completing a bidirectional chain.
//   3. `new_binding` is a self-consistent KeyBinding for new_key, so recipients
//      can immediately seal transport to the replacement (no separate KEY phase
//      needed just to learn the new transport key).
//
// SCOPE / BLINDNESS: migration is a CLIENT/PEER-level trust update, not a board
// operation. The blind board keeps matching on whatever identity key is
// presented to it; it neither stores nor interprets migrations. A device hands
// a `key_migration` to its contacts (over an established channel, or however it
// re-establishes contact), each recipient verifies the chain locally, updates
// which key it targets, and MAY return a `migration_ack`. No secret is involved
// — every field is public key material — so this does not touch the invariant.

import { ed25519 } from "@noble/curves/ed25519";
import { canonicalBytes } from "./canonical.js";
import { b64uDecode, b64uEncode } from "./encoding.js";
import { DeviceIdentity, KeyBinding, verifyBinding } from "./identity.js";
import { signObject, verifyObject, type Signed } from "./sign.js";
import { KEY_MIGRATION_SCHEMA, MIGRATION_ACK_SCHEMA, validateSchema } from "./schemas.js";
import { newNonce } from "./wire.js";

export interface KeyMigration {
  type: "key_migration";
  old_key: string; // b64u Ed25519 identity public key being retired
  new_key: string; // b64u Ed25519 identity public key replacing it
  new_binding: KeyBinding; // the replacement's transport binding (self-signed by new_key)
  issued_utc: string; // when the migration was announced
  retire_after_utc: string; // cutoff: old_key retired at/after this; both valid before it
  session_nonce: string;
  timestamp_utc: string;
  old_sig: string; // Ed25519 by old_key over the body (authorizes the migration)
  new_sig: string; // Ed25519 by new_key over the body (accepts the migration)
}

export interface MigrationAck {
  type: "migration_ack";
  acked_by: string; // recipient's identity key
  old_key: string;
  new_key: string;
  migration_nonce: string; // echoes the acknowledged migration's session_nonce
  session_nonce: string;
  timestamp_utc: string;
  signature: string; // by acked_by
}

export interface MigrationVerification {
  valid: boolean;
  reason?: string;
}

function nowIso(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))();
}

/** The exact object both signatures cover: the record minus the two sig fields. */
function migrationSigningBody(m: Omit<KeyMigration, "old_sig" | "new_sig">) {
  return {
    type: m.type,
    old_key: m.old_key,
    new_key: m.new_key,
    new_binding: m.new_binding,
    issued_utc: m.issued_utc,
    retire_after_utc: m.retire_after_utc,
    session_nonce: m.session_nonce,
    timestamp_utc: m.timestamp_utc,
  };
}

// --- builders ---------------------------------------------------------------

/**
 * Build a signed migration announcing that `oldIdentity` is being replaced by
 * `newIdentity`, with both keys valid until `retire_after_utc`. Signed by the
 * old key (authorizes) and co-signed by the new key (accepts).
 */
export function makeKeyMigration(
  oldIdentity: DeviceIdentity,
  newIdentity: DeviceIdentity,
  opts: { retire_after_utc: string; issued_utc?: string; session_nonce?: string; now?: () => string },
): KeyMigration {
  const issued = opts.issued_utc ?? nowIso(opts.now);
  const body = {
    type: "key_migration" as const,
    old_key: oldIdentity.identityKeyB64,
    new_key: newIdentity.identityKeyB64,
    new_binding: newIdentity.binding,
    issued_utc: issued,
    retire_after_utc: opts.retire_after_utc,
    session_nonce: opts.session_nonce ?? newNonce(),
    timestamp_utc: nowIso(opts.now),
  };
  const preimage = canonicalBytes(body);
  return {
    ...body,
    old_sig: b64uEncode(oldIdentity.sign(preimage)),
    new_sig: b64uEncode(newIdentity.sign(preimage)),
  };
}

/** Build a recipient's acknowledgement of a verified migration. */
export function makeMigrationAck(
  recipient: DeviceIdentity,
  migration: KeyMigration,
  opts: { session_nonce?: string; now?: () => string } = {},
): MigrationAck {
  const body = {
    type: "migration_ack" as const,
    acked_by: recipient.identityKeyB64,
    old_key: migration.old_key,
    new_key: migration.new_key,
    migration_nonce: migration.session_nonce,
    session_nonce: opts.session_nonce ?? newNonce(),
    timestamp_utc: nowIso(opts.now),
  };
  return signObject(body, recipient) as Signed<typeof body> as MigrationAck;
}

// --- verifiers --------------------------------------------------------------

/**
 * Verify a migration's full signature chain and structure. Never throws.
 * Establishes that old_key authorized the migration, new_key consented, and
 * new_binding is a valid binding for new_key. Does NOT itself enforce
 * freshness/retirement (that is time-relative — see MigrationRegistry).
 */
export function verifyKeyMigration(record: any): MigrationVerification {
  const v = validateSchema(KEY_MIGRATION_SCHEMA, record);
  if (!v.valid) return { valid: false, reason: v.errors.join("; ") };

  const m = record as KeyMigration;
  if (m.old_key === m.new_key) return { valid: false, reason: "old-and-new-key-identical" };

  // The new identity's transport binding must be self-consistent and belong to
  // the announced new_key (not some third key).
  if (!verifyBinding(m.new_binding)) return { valid: false, reason: "bad-new-binding" };
  if (m.new_binding.identity_key !== m.new_key) {
    return { valid: false, reason: "new-binding-identity-mismatch" };
  }

  const preimage = canonicalBytes(migrationSigningBody(m));
  try {
    if (!ed25519.verify(b64uDecode(m.old_sig), preimage, b64uDecode(m.old_key))) {
      return { valid: false, reason: "bad-old-signature" };
    }
    if (!ed25519.verify(b64uDecode(m.new_sig), preimage, b64uDecode(m.new_key))) {
      return { valid: false, reason: "bad-new-signature" };
    }
  } catch {
    return { valid: false, reason: "malformed-signature" };
  }
  return { valid: true };
}

/** Verify a migration_ack: schema + the recipient's own signature. */
export function verifyMigrationAck(record: any, expectedRecipientKey?: string): MigrationVerification {
  const v = validateSchema(MIGRATION_ACK_SCHEMA, record);
  if (!v.valid) return { valid: false, reason: v.errors.join("; ") };
  const a = record as MigrationAck;
  if (!verifyObject(record as Record<string, unknown>, a.acked_by)) {
    return { valid: false, reason: "bad-signature" };
  }
  if (expectedRecipientKey && a.acked_by !== expectedRecipientKey) {
    return { valid: false, reason: "unexpected-acker" };
  }
  return { valid: true };
}

// --- recipient-side trust store ---------------------------------------------

interface AcceptedMigration {
  newKey: string;
  newBinding: KeyBinding;
  retireAfterMs: number;
}

/**
 * A recipient's view of the migrations it has accepted. Resolves which key to
 * use for a contact now (following chains old -> new -> newer), and answers
 * whether a given key is still valid or has been retired past its cutoff.
 *
 * Time is supplied as an ISO string per call (consistent with the wire
 * timestamps) so this stays clock-injectable and side-effect free.
 */
export class MigrationRegistry {
  // old_key -> accepted migration away from it
  private byOldKey = new Map<string, AcceptedMigration>();

  /**
   * Verify and record a migration. Returns the verification result; the
   * migration is stored only if it verifies. Re-accepting the same old_key
   * overwrites with the latest (a device may re-announce / chain again).
   */
  accept(migration: KeyMigration): MigrationVerification {
    const result = verifyKeyMigration(migration);
    if (!result.valid) return result;
    const retireAfterMs = Date.parse(migration.retire_after_utc);
    if (Number.isNaN(retireAfterMs)) return { valid: false, reason: "bad-retire-after-utc" };
    this.byOldKey.set(migration.old_key, {
      newKey: migration.new_key,
      newBinding: migration.new_binding,
      retireAfterMs,
    });
    return { valid: true };
  }

  /** Has a migration away from `key` been accepted? */
  hasMigration(key: string): boolean {
    return this.byOldKey.has(key);
  }

  /**
   * The key a contact should be reached at now: follow the chain of accepted
   * migrations to its terminal key. A key with no migration resolves to itself.
   * Guards against cycles (a malformed/hostile chain) by bounding iterations.
   */
  currentKey(key: string): string {
    let cur = key;
    const seen = new Set<string>([cur]);
    for (;;) {
      const next = this.byOldKey.get(cur);
      if (!next) return cur;
      if (seen.has(next.newKey)) return cur; // cycle guard
      seen.add(next.newKey);
      cur = next.newKey;
    }
  }

  /** The current transport binding for a contact (the terminal key's binding). */
  currentBinding(key: string): KeyBinding | undefined {
    let cur = key;
    let binding: KeyBinding | undefined;
    const seen = new Set<string>([cur]);
    for (;;) {
      const next = this.byOldKey.get(cur);
      if (!next) return binding;
      if (seen.has(next.newKey)) return binding;
      binding = next.newBinding;
      seen.add(next.newKey);
      cur = next.newKey;
    }
  }

  /**
   * True if `key` has been migrated away from AND the retirement cutoff has
   * passed at `nowUtc`. Before the cutoff both keys are honored (the
   * dual-validity window); at/after it the old key is retired.
   */
  isRetired(key: string, nowUtc: string = new Date().toISOString()): boolean {
    const m = this.byOldKey.get(key);
    if (!m) return false;
    return Date.parse(nowUtc) >= m.retireAfterMs;
  }

  /** Whether `key` should still be honored right now (i.e. it is not retired). */
  isValid(key: string, nowUtc: string = new Date().toISOString()): boolean {
    return !this.isRetired(key, nowUtc);
  }
}
