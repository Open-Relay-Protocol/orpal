// Recipient-sealed message envelopes (issue #23).
//
// Orpal already runs every user payload through an end-to-end-encrypted
// SecureChannel, but the channel is established via board-mediated signaling. To
// match the protocol's intended model
//
//     encrypted tunnel  +  message sealed to the recipient public key  +  ACK
//
// we additionally seal each outbound text / file-offer to the recipient's PINNED
// X25519 transport key — the key carried in their out-of-band-verified contact
// card (contacts/contact.ts validates the binding on import). Sealing reuses the
// reference's anonymous sealed box (orp.ts `seal`/`unseal`); we add no crypto.
//
// The guarantee this buys: if a connection is ever made to the wrong peer (a
// fake/substituted transport key), the sealed payload still cannot be read,
// because only the holder of the verified transport private key can open it. A
// failed open returns null so the caller drops the message WITHOUT displaying,
// storing, or acknowledging it.

import { seal, unseal, b64uDecode, b64uEncode, utf8, fromUtf8 } from "../orp.js";
import {
  decodeAppFrame,
  encodeAppFrame,
  SEAL_ALG,
  type FileOfferFrame,
  type SealedFrame,
  type TextFrame,
} from "./frames.js";

/** The frame kinds carried inside a {@link SealedFrame}. */
export type SealablePayload = TextFrame | FileOfferFrame;

/** Seal an inner text / file-offer frame to a recipient's b64u transport key. */
export function sealAppFrame(inner: SealablePayload, recipientTransportKeyB64u: string): SealedFrame {
  const box = seal(utf8(encodeAppFrame(inner)), b64uDecode(recipientTransportKeyB64u));
  return { v: 1, t: "sealed", alg: SEAL_ALG, box: b64uEncode(box) };
}

/**
 * Open a sealed frame with the recipient's own transport keypair. Returns the
 * inner frame, or null on any failure (unknown alg, wrong key, tampered box,
 * malformed inner) — callers MUST treat null as "drop, do not display/awk".
 */
export function openSealedFrame(
  frame: SealedFrame,
  transportPriv: Uint8Array,
  transportPub: Uint8Array,
): SealablePayload | null {
  if (frame.alg !== SEAL_ALG) return null;
  let plaintext: Uint8Array;
  try {
    plaintext = unseal(b64uDecode(frame.box), transportPriv, transportPub);
  } catch {
    return null; // wrong key / tampered ciphertext
  }
  const inner = decodeAppFrame(fromUtf8(plaintext));
  if (inner && (inner.t === "text" || inner.t === "file-offer")) return inner;
  return null; // only text / file-offer are ever sealed
}
