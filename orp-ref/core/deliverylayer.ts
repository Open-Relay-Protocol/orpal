// SPDX-License-Identifier: Apache-2.0
//
// The DELIVERY LAYER: cryptographic delivery receipts, exactly as originally
// specified — "message encrypted with recipient's key contains one-time ACK
// public key + message body; recipient returns ACK encrypted to that
// one-time key; sender clears local pending queue only after ACK." See
// SPEC.md §11 for the normative version of this; this file is the wire
// format + pure crypto/framing logic. client/reliablechannel.ts is the
// stateful piece (the local pending queue, timeouts, the public API).
//
// WHERE THIS SITS: ABOVE SecureChannel, not inside it. SecureChannel already
// gives one already-encrypted, already-authenticated logical pipe between the
// two matched, bound parties (its keys come from their long-term, binding-
// verified X25519 transport keys — see core/messagelayer.ts). This layer's
// frames are carried as SecureChannel's plaintext payload, so they inherit
// that confidentiality/authentication for free. What THIS layer adds on top
// is NOT secrecy — it's: (1) a per-message identity (`message_id`) so a
// receipt can be tied to a specific send, (2) a ONE-TIME key the ACK is
// sealed to, so the ack ciphertext itself doesn't bind to either party's
// PERMANENT identity if it were ever observed out of the context of this one
// already-private channel (defense in depth / future-proofing — see the
// SPEC section for why this still matters even though the surrounding
// channel is already private), and (3) the actual reliability semantics:
// knowing whether the other side decrypted the message at all.
//
// Authentication note: msg/ack frames carry NO signature of their own. They
// don't need one — only the two parties who derived SecureChannel's keys via
// the binding-verified KEY phase can produce or consume them at all, so
// successfully decrypting one already proves the sender is the matched
// counterparty. A signature here would be redundant with that.

import { x25519 } from "@noble/curves/ed25519";
import { randomBytes } from "@noble/hashes/utils";
import { seal, unseal } from "./sealedbox.js";
import { b64uDecode, b64uEncode, fromUtf8, utf8 } from "./encoding.js";

export interface DeliveryMessageFrame {
  type: "msg";
  message_id: string; // b64u random, unique per outbound message
  ack_pubkey: string; // b64u X25519 public key — ONE-TIME, generated fresh per message
  body: string;
}

export interface DeliveryAckFrame {
  type: "ack";
  message_id: string; // echoes the message this acknowledges
  sealed_ack: string; // b64u sealedbox.seal({message_id, received_utc}, ack_pubkey)
}

export type DeliveryFrame = DeliveryMessageFrame | DeliveryAckFrame;

interface AckPayload {
  message_id: string;
  received_utc: string;
}

/** A fresh, one-time X25519 keypair for a single outbound message's ACK. */
export interface OneTimeAckKey {
  priv: Uint8Array;
  pub: Uint8Array;
}

export function generateOneTimeAckKey(): OneTimeAckKey {
  const priv = x25519.utils.randomPrivateKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

export function newMessageId(): string {
  return b64uEncode(randomBytes(16));
}

/** Build the wire JSON for an outbound message frame. */
export function buildMessageFrame(messageId: string, ackKey: OneTimeAckKey, body: string): string {
  const frame: DeliveryMessageFrame = {
    type: "msg",
    message_id: messageId,
    ack_pubkey: b64uEncode(ackKey.pub),
    body,
  };
  return JSON.stringify(frame);
}

/** Build the wire JSON for a delivery receipt, sealed to the message's one-time key. */
export function buildAckFrame(messageId: string, ackPubkey: Uint8Array, now: () => string = () => new Date().toISOString()): string {
  const payload: AckPayload = { message_id: messageId, received_utc: now() };
  const sealed = seal(utf8(JSON.stringify(payload)), ackPubkey);
  const frame: DeliveryAckFrame = {
    type: "ack",
    message_id: messageId,
    sealed_ack: b64uEncode(sealed),
  };
  return JSON.stringify(frame);
}

/** Parse incoming wire JSON into a DeliveryFrame, or null if malformed/unrecognized. */
export function parseDeliveryFrame(text: string): DeliveryFrame | null {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.type === "msg" && typeof o.message_id === "string" && typeof o.ack_pubkey === "string" && typeof o.body === "string") {
    return { type: "msg", message_id: o.message_id, ack_pubkey: o.ack_pubkey, body: o.body };
  }
  if (o.type === "ack" && typeof o.message_id === "string" && typeof o.sealed_ack === "string") {
    return { type: "ack", message_id: o.message_id, sealed_ack: o.sealed_ack };
  }
  return null;
}

/**
 * Validate and decode a received ack frame against the LOCALLY-HELD one-time
 * private key for the message it claims to acknowledge. Throws on any
 * failure (wrong key, tampered ciphertext, message_id mismatch inside the
 * sealed payload) — callers should treat a throw as "ignore this ack, the
 * message stays pending", never as a reason to clear the queue.
 */
export function verifyAck(frame: DeliveryAckFrame, ackKey: OneTimeAckKey): AckPayload {
  const pt = unseal(b64uDecode(frame.sealed_ack), ackKey.priv, ackKey.pub);
  const payload = JSON.parse(fromUtf8(pt)) as AckPayload;
  if (payload.message_id !== frame.message_id) {
    throw new Error("deliverylayer: ack payload message_id does not match envelope");
  }
  return payload;
}
