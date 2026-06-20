// SPDX-License-Identifier: Apache-2.0
// Wire message builders + verifiers for the four message types.
//
//   presence      always-on beacon (identity only; NO transport key/IP/SDP/target)
//   intent        sent only when initiating (NO SDP/ICE)
//   match_offer   } temporary-channel frames, exchanged AFTER a match, carrying
//   match_answer  } sealed signaling blobs (board relays them opaquely)
//
// Every record is signed with the author's Ed25519 identity key. `verifyAnnounce`
// is the gate the board and receivers run before acting on presence/intent.

import { randomBytes } from "@noble/hashes/utils";
import { b64uEncode } from "./encoding.js";
import { DeviceIdentity, KeyBinding, verifyBinding } from "./identity.js";
import { signObject, verifyObject } from "./sign.js";
import {
  INTENT_SCHEMA,
  MATCH_FRAME_SCHEMA,
  PRESENCE_SCHEMA,
  validateSchema,
} from "./schemas.js";

export interface Presence {
  type: "presence";
  self_key: string;
  boards_scope: string[];
  webrtc_capabilities: { data_channel: boolean; ice_restart: boolean };
  session_nonce: string;
  timestamp_utc: string;
  /** ORP-009: OPTIONAL opt-in platform push token. Present only when the device
   * chose to enable wake notifications; covered by `signature` when present. */
  push_token?: string;
  signature: string;
}

export interface Intent {
  type: "intent";
  self_key: string;
  target_key: string;
  session_nonce: string;
  timestamp_utc: string;
  signature: string;
}

export type FramePhase = "key" | "signaling";

export interface MatchFrame {
  type: "match_offer" | "match_answer";
  match_id: string;
  from_key: string;
  phase: FramePhase;
  transport_key?: string;
  binding?: KeyBinding;
  enc_signaling?: string;
  session_nonce: string;
  timestamp_utc: string;
  signature: string;
}

export function newNonce(): string {
  return b64uEncode(randomBytes(16));
}

function nowIso(now?: () => string): string {
  return (now ?? (() => new Date().toISOString()))();
}

// --- builders ---------------------------------------------------------------

export function makePresence(
  identity: DeviceIdentity,
  opts: {
    boards_scope: string[];
    webrtc_capabilities?: { data_channel: boolean; ice_restart: boolean };
    session_nonce?: string;
    /** ORP-009: OPTIONAL platform push token. Spread into the signed body ONLY
     * when set, so an opted-out presence is byte-for-byte identical to pre-ORP-009. */
    push_token?: string;
    now?: () => string;
  },
): Presence {
  const body = {
    type: "presence" as const,
    self_key: identity.identityKeyB64,
    boards_scope: opts.boards_scope,
    webrtc_capabilities: opts.webrtc_capabilities ?? { data_channel: true, ice_restart: true },
    session_nonce: opts.session_nonce ?? newNonce(),
    timestamp_utc: nowIso(opts.now),
    ...(opts.push_token !== undefined ? { push_token: opts.push_token } : {}),
  };
  return signObject(body, identity) as Presence;
}

export function makeIntent(
  identity: DeviceIdentity,
  opts: { target_key: string; session_nonce?: string; now?: () => string },
): Intent {
  const body = {
    type: "intent" as const,
    self_key: identity.identityKeyB64,
    target_key: opts.target_key,
    session_nonce: opts.session_nonce ?? newNonce(),
    timestamp_utc: nowIso(opts.now),
  };
  return signObject(body, identity) as Intent;
}

export function makeKeyFrame(
  identity: DeviceIdentity,
  opts: { type: "match_offer" | "match_answer"; match_id: string; now?: () => string },
): MatchFrame {
  const body = {
    type: opts.type,
    match_id: opts.match_id,
    from_key: identity.identityKeyB64,
    phase: "key" as const,
    transport_key: identity.transportKeyB64,
    binding: identity.binding,
    session_nonce: newNonce(),
    timestamp_utc: nowIso(opts.now),
  };
  return signObject(body, identity) as MatchFrame;
}

export function makeSignalingFrame(
  identity: DeviceIdentity,
  opts: {
    type: "match_offer" | "match_answer";
    match_id: string;
    enc_signaling: string;
    now?: () => string;
  },
): MatchFrame {
  const body = {
    type: opts.type,
    match_id: opts.match_id,
    from_key: identity.identityKeyB64,
    phase: "signaling" as const,
    enc_signaling: opts.enc_signaling,
    session_nonce: newNonce(),
    timestamp_utc: nowIso(opts.now),
  };
  return signObject(body, identity) as MatchFrame;
}

// --- verifiers --------------------------------------------------------------

export interface AnnounceVerification {
  valid: boolean;
  kind?: "presence" | "intent";
  reason?: string;
}

/** Schema-check + signature-check a presence/intent. The board's matching gate. */
export function verifyAnnounce(record: any): AnnounceVerification {
  if (record == null || typeof record !== "object") {
    return { valid: false, reason: "not-an-object" };
  }
  if (record.type === "presence") {
    const v = validateSchema(PRESENCE_SCHEMA, record);
    if (!v.valid) return { valid: false, kind: "presence", reason: v.errors.join("; ") };
    if (!verifyObject(record, record.self_key)) {
      return { valid: false, kind: "presence", reason: "bad-signature" };
    }
    return { valid: true, kind: "presence" };
  }
  if (record.type === "intent") {
    const v = validateSchema(INTENT_SCHEMA, record);
    if (!v.valid) return { valid: false, kind: "intent", reason: v.errors.join("; ") };
    if (!verifyObject(record, record.self_key)) {
      return { valid: false, kind: "intent", reason: "bad-signature" };
    }
    return { valid: true, kind: "intent" };
  }
  return { valid: false, reason: `unknown-type:${record?.type}` };
}

export interface FrameVerification {
  valid: boolean;
  reason?: string;
}

/** Verify a relayed signaling frame: schema, signature, and (key phase) binding. */
export function verifyMatchFrame(frame: any, expectedFromKey?: string): FrameVerification {
  const v = validateSchema(MATCH_FRAME_SCHEMA, frame);
  if (!v.valid) return { valid: false, reason: v.errors.join("; ") };
  if (!verifyObject(frame, frame.from_key)) return { valid: false, reason: "bad-signature" };
  if (expectedFromKey && frame.from_key !== expectedFromKey) {
    return { valid: false, reason: "unexpected-sender" };
  }
  if (frame.phase === "key") {
    if (!frame.transport_key || !frame.binding) {
      return { valid: false, reason: "key-frame-missing-transport-key-or-binding" };
    }
    if (!verifyBinding(frame.binding)) return { valid: false, reason: "bad-binding" };
    if (frame.binding.identity_key !== frame.from_key) {
      return { valid: false, reason: "binding-identity-mismatch" };
    }
    if (frame.binding.transport_key !== frame.transport_key) {
      return { valid: false, reason: "binding-transport-mismatch" };
    }
  } else if (frame.phase === "signaling") {
    if (!frame.enc_signaling) return { valid: false, reason: "signaling-frame-missing-blob" };
  }
  return { valid: true };
}
