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
