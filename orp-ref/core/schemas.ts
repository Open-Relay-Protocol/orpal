// SPDX-License-Identifier: Apache-2.0
// JSON Schemas for the wire message types + a compact validator.
//
// `additionalProperties: false` is load-bearing here, not cosmetic: it is how the
// schema mechanically forbids a `presence` from ever carrying a transport_key,
// IP, SDP, or target_key, and an `intent` from carrying SDP/ICE. Conformance is
// asserted in the tests. These exact objects are reproduced in SPEC.md.

export const KEY_BINDING_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/key_binding.json",
  title: "KeyBinding",
  type: "object",
  additionalProperties: false,
  required: ["identity_key", "transport_key", "created_utc", "binding_sig"],
  properties: {
    identity_key: { type: "string", description: "b64u Ed25519 identity public key" },
    transport_key: { type: "string", description: "b64u X25519 transport public key" },
    created_utc: { type: "string", description: "ISO-8601 timestamp" },
    binding_sig: {
      type: "string",
      description: "b64u Ed25519 signature over {identity_key,transport_key,created_utc}",
    },
  },
} as const;

export const PRESENCE_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/presence.json",
  title: "presence",
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "self_key",
    "boards_scope",
    "webrtc_capabilities",
    "session_nonce",
    "timestamp_utc",
    "signature",
  ],
  properties: {
    type: { const: "presence" },
    self_key: { type: "string", description: "b64u Ed25519 identity public key" },
    boards_scope: { type: "array", minItems: 1, items: { type: "string" } },
    webrtc_capabilities: {
      type: "object",
      additionalProperties: false,
      required: ["data_channel", "ice_restart"],
      properties: {
        data_channel: { type: "boolean" },
        ice_restart: { type: "boolean" },
      },
    },
    session_nonce: { type: "string" },
    timestamp_utc: { type: "string" },
    signature: { type: "string" },
  },
} as const;

export const INTENT_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/intent.json",
  title: "intent",
  type: "object",
  additionalProperties: false,
  required: ["type", "self_key", "target_key", "session_nonce", "timestamp_utc", "signature"],
  properties: {
    type: { const: "intent" },
    self_key: { type: "string", description: "b64u Ed25519 identity public key of initiator" },
    target_key: { type: "string", description: "b64u Ed25519 identity public key of target" },
    session_nonce: { type: "string" },
    timestamp_utc: { type: "string" },
    signature: { type: "string" },
  },
} as const;

// match_offer and match_answer share this envelope. It is sealed/opaque to the
// board; only peers validate it. `transport_key`+`binding` appear in the `key`
// phase; `enc_signaling` appears in the `signaling` phase.
export const MATCH_FRAME_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/match_frame.json",
  title: "match_offer | match_answer",
  type: "object",
  additionalProperties: false,
  required: ["type", "match_id", "from_key", "phase", "session_nonce", "timestamp_utc", "signature"],
  properties: {
    type: { enum: ["match_offer", "match_answer"] },
    match_id: { type: "string" },
    from_key: { type: "string", description: "b64u Ed25519 identity public key of sender" },
    phase: { enum: ["key", "signaling"] },
    transport_key: {
      type: "string",
      description: "b64u X25519 transport key (key phase only)",
    },
    binding: KEY_BINDING_SCHEMA,
    enc_signaling: {
      type: "string",
      description: "b64u sealed-box ciphertext of {sdp, candidates} (signaling phase only)",
    },
    session_nonce: { type: "string" },
    timestamp_utc: { type: "string" },
    signature: { type: "string" },
  },
} as const;

// ORP-004: a graceful identity-rotation announcement. The OLD identity vouches
// for a replacement key (old_sig) and the NEW identity co-signs to prove it
// consents and controls the replacement (new_sig). Carries the new identity's
// transport binding so recipients can immediately seal to the new key. Both
// keys stay valid until `retire_after_utc`, after which the old key is retired.
export const KEY_MIGRATION_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/key_migration.json",
  title: "key_migration",
  type: "object",
  additionalProperties: false,
  required: [
    "type",
    "old_key",
    "new_key",
    "new_binding",
    "issued_utc",
    "retire_after_utc",
    "session_nonce",
    "timestamp_utc",
    "old_sig",
    "new_sig",
  ],
  properties: {
    type: { const: "key_migration" },
    old_key: { type: "string", description: "b64u Ed25519 identity public key being retired" },
    new_key: { type: "string", description: "b64u Ed25519 identity public key replacing it" },
    new_binding: KEY_BINDING_SCHEMA,
    issued_utc: { type: "string", description: "ISO-8601 when the migration was announced" },
    retire_after_utc: {
      type: "string",
      description: "ISO-8601 cutoff; old_key is retired at/after this, both valid before it",
    },
    session_nonce: { type: "string" },
    timestamp_utc: { type: "string" },
    old_sig: { type: "string", description: "b64u Ed25519 by old_key over the body (authorizes)" },
    new_sig: { type: "string", description: "b64u Ed25519 by new_key over the body (accepts)" },
  },
} as const;

// ORP-004: a recipient's acknowledgement that it has accepted a migration.
export const MIGRATION_ACK_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/migration_ack.json",
  title: "migration_ack",
  type: "object",
  additionalProperties: false,
  required: ["type", "acked_by", "old_key", "new_key", "migration_nonce", "session_nonce", "timestamp_utc", "signature"],
  properties: {
    type: { const: "migration_ack" },
    acked_by: { type: "string", description: "b64u Ed25519 identity public key of the acknowledging recipient" },
    old_key: { type: "string" },
    new_key: { type: "string" },
    migration_nonce: { type: "string", description: "echoes the acknowledged migration's session_nonce" },
    session_nonce: { type: "string" },
    timestamp_utc: { type: "string" },
    signature: { type: "string" },
  },
} as const;

// ORP-007: the canonical SealedMessage object — the on-wire form of a `msg`
// frame whose application body is sealed to the recipient's long-term X25519
// transport key. The envelope fields (message_id, created_utc, ack_pubkey) are
// NOT secret (routing/ACK metadata); only `sealed_body` is encrypted, and only
// the recipient's transport private key can open it. Transported inside the
// existing SecureChannel/ReliableChannel envelope with no transport changes.
export const SEALED_MESSAGE_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/sealed_message.json",
  title: "SealedMessage",
  type: "object",
  additionalProperties: false,
  required: ["type", "message_id", "created_utc", "ack_pubkey", "sealed_body"],
  properties: {
    type: { const: "msg" },
    message_id: { type: "string", description: "b64u random, unique per outbound message" },
    created_utc: { type: "string", description: "ISO-8601 creation timestamp" },
    ack_pubkey: { type: "string", description: "b64u ONE-TIME X25519 ACK public key" },
    sealed_body: {
      type: "string",
      description: "b64u sealed-box ciphertext of the body, sealed to the recipient's long-term X25519 transport key",
    },
  },
} as const;

// ORP-006: the board-to-board neighbor-propagation envelope. It wraps a single
// ALREADY-device-signed `presence`/`intent` (`record`) and adds only PUBLIC
// routing metadata used for loop/hop/freshness/duplicate suppression. Nothing
// here is a secret: the inner record is the same public announce the board
// already accepts directly (its own schema forbids transport keys/IP/SDP), and
// the envelope fields are routing hints a receiving board independently bounds.
// So propagation crosses board boundaries without touching the blindness
// invariant. `record` is typed only as an object here; its inner presence/intent
// shape is validated separately by `verifyAnnounce` (see core/propagation.ts).
export const BOARD_PROPAGATION_SCHEMA = {
  $id: "https://blind-rendezvous/schemas/board_propagation.json",
  title: "board_propagation",
  type: "object",
  additionalProperties: false,
  required: ["type", "record", "origin_board", "hop", "max_hops", "path"],
  properties: {
    type: { const: "board_propagation" },
    record: { type: "object", description: "the wrapped, device-signed presence|intent" },
    origin_board: { type: "string", description: "id of the board that first injected the record" },
    hop: { type: "integer", description: "board-to-board hops so far; origin injects at 0 (== path.length - 1)" },
    max_hops: { type: "integer", description: "origin's requested ceiling; a receiver clamps to its own" },
    path: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
      description: "ordered board ids visited, starting with origin_board; used for loop suppression",
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Compact JSON Schema validator (subset: type/const/enum/required/properties/
// additionalProperties/items/minItems/pattern). Enough to honestly check the
// schemas above; not a general-purpose implementation.
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSchema(schema: any, value: unknown, path = "$"): ValidationResult {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return { valid: errors.length === 0, errors };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function check(schema: any, value: unknown, path: string, errors: string[]): void {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value as any)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const actual = typeOf(value);
    const want = schema.type === "integer" ? "number" : schema.type;
    if (actual !== want) {
      errors.push(`${path}: expected type ${schema.type}, got ${actual}`);
      return; // further checks assume the type matched
    }
  }
  if (schema.type === "string" && schema.pattern) {
    if (!new RegExp(schema.pattern).test(value as string)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }
  if (schema.type === "array") {
    const arr = value as unknown[];
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push(`${path}: expected >= ${schema.minItems} items`);
    }
    if (schema.items) {
      arr.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
    }
  }
  if (schema.type === "object") {
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required property "${req}"`);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: additional property "${key}" not allowed`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) check(sub, obj[key], `${path}.${key}`, errors);
    }
  }
}
