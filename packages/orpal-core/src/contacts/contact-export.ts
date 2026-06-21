// Bulk contact export / import (issue #41).
//
// Backs up or migrates a contact list as a single versioned JSON bundle. Only the
// PUBLICLY SHAREABLE fields of each contact travel -- exactly the data already
// exchanged one card at a time via QR / paste (SPEC §2). Private keys and message
// history are NEVER included. On import every entry is reconstructed into a
// `ContactCard` and run through the SAME `parseContactCard` binding validation
// single-card import uses (the anti-substitution check, §2.1), so a tampered or
// mismatched binding is rejected exactly as a bad scanned card would be -- import
// is no more trusting than a face-to-face scan.

import {
  contactFromCard,
  parseContactCard,
  type Contact,
  type ContactCard,
} from "./contact.js";
import type { KeyBinding } from "../orp.js";

export const CONTACTS_EXPORT_KIND = "orpal-contacts-export";

/** One contact's publicly shareable fields. No private keys, no history. */
export interface ContactExportEntry {
  identityKey: string;
  transportKey: string;
  binding: KeyBinding;
  displayName: string;
  relayOnly: boolean;
  preferredBoards?: string[];
  fallbackBoards?: string[];
  autoAcceptMigration?: boolean;
  addedUtc: string;
}

/** The versioned bundle written to / read from disk. */
export interface ContactsExport {
  v: 1;
  kind: typeof CONTACTS_EXPORT_KIND;
  exportedUtc: string;
  contacts: ContactExportEntry[];
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  rejected: { identityKey: string; reason: string }[];
}

export interface ImportOptions {
  /** What to do when an entry's identity key already exists locally. Default
   *  `"skip"` -- preserve the user's local edits and never clobber them. */
  onCollision?: "skip" | "overwrite";
  /** Identity keys already stored locally, used for collision handling. */
  existingKeys?: Iterable<string>;
  /** This device's own identity key, if any -- a matching entry is rejected
   *  (you can't import yourself as a normal contact; that's the loopback). */
  ownKey?: string;
  now?: () => string;
}

function toEntry(c: Contact): ContactExportEntry {
  return {
    identityKey: c.identityKey,
    transportKey: c.transportKey,
    binding: c.binding,
    displayName: c.displayName,
    relayOnly: c.relayOnly,
    preferredBoards: c.preferredBoards ?? [],
    fallbackBoards: c.fallbackBoards ?? [],
    autoAcceptMigration: c.autoAcceptMigration ?? false,
    addedUtc: c.addedUtc,
  };
}

/**
 * Serialize contacts to a versioned bundle string. The diagnostic loopback
 * contact is excluded -- it's device-specific and re-created locally on import.
 * Gated behind an explicit user action in the shell because it writes a file.
 */
export function serializeContacts(contacts: Contact[], opts: { now?: () => string } = {}): string {
  const now = opts.now ?? (() => new Date().toISOString());
  const bundle: ContactsExport = {
    v: 1,
    kind: CONTACTS_EXPORT_KIND,
    exportedUtc: now(),
    contacts: contacts.filter((c) => !c.isLoopback).map(toEntry),
  };
  return JSON.stringify(bundle, null, 2);
}

/**
 * Parse + shallow-validate a bundle's envelope. Per-entry binding validation is
 * deferred to {@link importContacts} (so a single bad entry never sinks the whole
 * bundle); this only confirms the wrapper is a recognized, supported export.
 */
export function parseContactsExport(
  input: string,
): { valid: boolean; reason?: string; bundle?: ContactsExport } {
  let obj: unknown;
  try {
    obj = JSON.parse(input);
  } catch {
    return { valid: false, reason: "not-valid-json" };
  }
  if (typeof obj !== "object" || obj === null) return { valid: false, reason: "not-an-object" };
  const o = obj as Record<string, unknown>;
  if (o.kind !== CONTACTS_EXPORT_KIND) return { valid: false, reason: "not-a-contacts-export" };
  if (o.v !== 1) return { valid: false, reason: "unsupported-version" };
  if (!Array.isArray(o.contacts)) return { valid: false, reason: "missing-contacts" };
  return {
    valid: true,
    bundle: {
      v: 1,
      kind: CONTACTS_EXPORT_KIND,
      exportedUtc: typeof o.exportedUtc === "string" ? o.exportedUtc : "",
      contacts: o.contacts as ContactExportEntry[],
    },
  };
}

/**
 * Validate + materialize a bundle's entries into `Contact` records. This is PURE
 * -- it touches no persistence; the caller stores the returned contacts. Each
 * entry is rebuilt into a `ContactCard` and run through `parseContactCard`, so the
 * binding check is byte-for-byte identical to a single scanned/pasted card.
 * Entries with a bad/mismatched binding are rejected with a reason, never stored.
 * Import is non-destructive: existing contacts are never deleted, and a collision
 * is resolved per `onCollision` (default `"skip"`).
 */
export function importContacts(
  bundle: ContactsExport,
  opts: ImportOptions = {},
): { contacts: Contact[]; summary: ImportSummary } {
  const onCollision = opts.onCollision ?? "skip";
  const existing = new Set(opts.existingKeys ?? []);
  const summary: ImportSummary = { imported: 0, skipped: 0, rejected: [] };
  const contacts: Contact[] = [];
  const seen = new Set<string>();

  for (const entry of bundle.contacts) {
    const idKey =
      entry && typeof entry.identityKey === "string" ? entry.identityKey : "(unknown)";
    // Reconstruct the exact card shape single-card import validates, then run the
    // identical binding check -- no shortcut for "trusted" bundle data.
    const card = {
      v: 1,
      kind: "orpal-contact",
      identity_key: entry?.identityKey,
      transport_key: entry?.transportKey,
      binding: entry?.binding,
      name: entry?.displayName,
    };
    const parsed = parseContactCard(JSON.stringify(card));
    if (!parsed.valid || !parsed.card) {
      summary.rejected.push({ identityKey: idKey, reason: parsed.reason ?? "invalid" });
      continue;
    }
    const card2: ContactCard = parsed.card;
    if (opts.ownKey && card2.identity_key === opts.ownKey) {
      summary.rejected.push({ identityKey: idKey, reason: "that-is-your-own-card" });
      continue;
    }
    const collides = seen.has(card2.identity_key) || existing.has(card2.identity_key);
    if (collides && onCollision === "skip") {
      summary.skipped++;
      continue;
    }
    const contact = contactFromCard(card2, {
      displayName: entry.displayName,
      relayOnly: entry.relayOnly,
      preferredBoards: entry.preferredBoards,
      fallbackBoards: entry.fallbackBoards,
      now: opts.now,
    });
    contact.autoAcceptMigration = entry.autoAcceptMigration ?? false;
    // Preserve the original add timestamp so a backup round-trips faithfully.
    if (typeof entry.addedUtc === "string" && entry.addedUtc) contact.addedUtc = entry.addedUtc;
    contacts.push(contact);
    seen.add(card2.identity_key);
    summary.imported++;
  }
  return { contacts, summary };
}
