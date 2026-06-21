// Contacts and contact cards.
//
// A device's address is its Ed25519 identity key (SPEC §2 -- the only required
// identifier). A contact CARD additionally carries the X25519 transport key and
// its signed binding so the importer can pin and verify them out-of-band. The
// transport key is deliberately NOT broadcast in presence/intent (§2,
// anti-harvesting); sharing it face-to-face via a QR code / paste is the intended
// channel. On import we ALWAYS verify the binding and that it ties this identity
// key to this transport key -- the same check a peer runs before sealing (§2.1).

import { verifyBinding } from "../orp.js";
import type { KeyBinding, PublicIdentity } from "../orp.js";

export interface Contact {
  /** b64u Ed25519 identity public key -- the routing address. */
  identityKey: string;
  /** b64u X25519 transport public key (bound to identityKey). */
  transportKey: string;
  binding: KeyBinding;
  displayName: string;
  /** Privacy-sensitive contact: use relay-only ICE (SPEC §6) so the peer never
   *  learns this device's IP. Requires a configured TURN server. */
  relayOnly: boolean;
  /**
   * Per-contact board routing (issue #19). Board ids (the web shell uses the
   * board URL as its id) this contact is reachable on. When BOTH lists are empty
   * / undefined, delivery fans out to ALL configured boards (the global default).
   * When set, delivery attempts use ONLY these boards -- preferred first, then
   * fallback -- so a contact known to live on a specific board isn't announced to
   * every board.
   */
  preferredBoards?: string[];
  /** Boards to also try when no preferred board is reachable. */
  fallbackBoards?: string[];
  /** Auto-accept key rotations from this contact via challenge-response
   *  verification (ORPAL-008). When false, a manual prompt is shown instead. */
  autoAcceptMigration?: boolean;
  addedUtc: string;
  /**
   * Diagnostic self-test contact (issue #41): derived from this device's OWN
   * PublicIdentity so a user can verify their board / STUN-TURN / sealing pipeline
   * end-to-end without a second peer. The UI badges it; it is EXCLUDED from
   * contact export bundles (it's device-specific and re-created locally) and can
   * be deleted at any time.
   */
  isLoopback?: boolean;
}

/** The serializable card encoded into a QR / pasted between devices. */
export interface ContactCard {
  v: 1;
  kind: "orpal-contact";
  identity_key: string;
  transport_key: string;
  binding: KeyBinding;
  name?: string;
}

export interface ParsedCard {
  valid: boolean;
  reason?: string;
  card?: ContactCard;
}

/** Build a shareable card from this device's own public identity. */
export function serializeContactCard(pub: PublicIdentity, name?: string): string {
  const card: ContactCard = {
    v: 1,
    kind: "orpal-contact",
    identity_key: pub.identity_key,
    transport_key: pub.transport_key,
    binding: pub.binding,
    name,
  };
  return JSON.stringify(card);
}

/**
 * Parse and FULLY VALIDATE a scanned/pasted contact card. Returns
 * `{ valid:false, reason }` rather than throwing so the UI can show a clear
 * error. A card only validates if its binding is a correct self-signature AND it
 * ties the advertised identity key to the advertised transport key -- this is the
 * anti-substitution guarantee: nobody can hand you a card pairing someone's
 * identity with an attacker-chosen transport key.
 */
export function parseContactCard(input: string): ParsedCard {
  let obj: unknown;
  try {
    obj = JSON.parse(input);
  } catch {
    return { valid: false, reason: "not-valid-json" };
  }
  if (typeof obj !== "object" || obj === null) {
    return { valid: false, reason: "not-an-object" };
  }
  const o = obj as Record<string, unknown>;
  if (o.kind !== "orpal-contact") return { valid: false, reason: "not-an-orpal-contact-card" };
  if (
    typeof o.identity_key !== "string" ||
    typeof o.transport_key !== "string" ||
    typeof o.binding !== "object" ||
    o.binding === null
  ) {
    return { valid: false, reason: "missing-fields" };
  }
  const binding = o.binding as KeyBinding;
  if (!verifyBinding(binding)) return { valid: false, reason: "bad-binding-signature" };
  if (binding.identity_key !== o.identity_key) {
    return { valid: false, reason: "binding-identity-mismatch" };
  }
  if (binding.transport_key !== o.transport_key) {
    return { valid: false, reason: "binding-transport-mismatch" };
  }
  const card: ContactCard = {
    v: 1,
    kind: "orpal-contact",
    identity_key: o.identity_key,
    transport_key: o.transport_key,
    binding,
    name: typeof o.name === "string" ? o.name : undefined,
  };
  return { valid: true, card };
}

/** Turn a validated card into a Contact record for storage. */
export function contactFromCard(
  card: ContactCard,
  opts: {
    displayName?: string;
    relayOnly?: boolean;
    preferredBoards?: string[];
    fallbackBoards?: string[];
    now?: () => string;
  } = {},
): Contact {
  return {
    identityKey: card.identity_key,
    transportKey: card.transport_key,
    binding: card.binding,
    displayName: opts.displayName ?? card.name ?? shortKey(card.identity_key),
    relayOnly: opts.relayOnly ?? false,
    preferredBoards: opts.preferredBoards ?? [],
    fallbackBoards: opts.fallbackBoards ?? [],
    addedUtc: (opts.now ?? (() => new Date().toISOString()))(),
  };
}

/** Default display name for the diagnostic loopback contact (issue #41). */
export const LOOPBACK_NAME = "Test (me)";

/**
 * Build the diagnostic "loopback" test contact from this device's OWN public
 * identity (issue #41). It deliberately reuses the exact same pipeline a real
 * card takes -- `serializeContactCard` -> `parseContactCard` -> `contactFromCard`
 * -- so the binding is validated identically; the only difference is the
 * `isLoopback` tag and that it points at the device's own identity/transport key.
 * Messaging it seals a box to the user's own transport key and round-trips it
 * back, exercising board match + ICE + sealing without needing a second person.
 */
export function makeLoopbackContact(
  pub: PublicIdentity,
  opts: { name?: string; now?: () => string } = {},
): Contact {
  const parsed = parseContactCard(serializeContactCard(pub, opts.name ?? LOOPBACK_NAME));
  if (!parsed.valid || !parsed.card) {
    // The device's own card failing self-validation means a broken identity --
    // surface it loudly rather than storing a half-formed contact.
    throw new Error(`makeLoopbackContact: own card failed validation (${parsed.reason})`);
  }
  const contact = contactFromCard(parsed.card, { now: opts.now });
  contact.isLoopback = true;
  return contact;
}

/** A short, human-readable fingerprint of an identity key for default names. */
export function shortKey(identityKey: string): string {
  return identityKey.length <= 12
    ? identityKey
    : `${identityKey.slice(0, 6)}…${identityKey.slice(-4)}`;
}
