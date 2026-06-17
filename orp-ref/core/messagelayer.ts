// SPDX-License-Identifier: Apache-2.0
// Inner application-message encryption over the WebRTC data channel.
//
// ============================ SECURITY NOTICE ==============================
// This layer is STATIC-KEY. The symmetric key is derived once from the two
// peers' long-term X25519 transport keys (X25519(my_priv, their_pub)) and reused
// for every message in the conversation. There is NO ratchet.
//
// Consequences:
//   * NO forward secrecy at the message layer. If an endpoint's transport
//     private key is later compromised, an attacker who recorded the inner
//     ciphertexts can RETROACTIVELY DECRYPT every past message.
//   * NO post-compromise security / break-in recovery.
//
// What still holds:
//   * DTLS (the WebRTC transport beneath this) gives transit forward secrecy via
//     its own ephemeral handshake, so a passive wire tap that did NOT also log
//     this inner ciphertext gets nothing after the session ends. But anything
//     that captured the inner ciphertext (e.g. a malicious endpoint, or a logger
//     above DTLS) is exposed by a future key compromise.
//
// DELIBERATELY REJECTED, NOT PENDING: a ratchet was considered and rejected,
// not merely deferred. The reason is identity-model, not effort — see SPEC
// §9.3. A device's identity key (Ed25519, the address) is bound 1:1 to a
// single long-term X25519 transport key for the LIFE of that identity; that
// transport key IS the encryption target, permanently, by construction (§2 —
// "PubKey_B is the only required identifier"). A ratchet would decouple "who
// you're addressing" from "what key the ciphertext is actually under" per
// message, which breaks that fixed one-key-one-target model and reintroduces
// exactly the kind of extra coordination state (key-exchange bookkeeping,
// ratchet synchronization) this protocol exists to avoid. This trade-off
// closes the threat "future transport-key compromise retroactively decrypts
// recorded traffic" in exchange for keeping the address model trivial — and
// it is not a new exposure: physical device seizure and key exposure were
// already listed as "weak against" in this protocol's threat model before
// this trade-off was made explicit.
// ==========================================================================

import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { randomBytes } from "@noble/hashes/utils";
import { concatBytes } from "./encoding.js";

const INFO_BASE = "blind-rendezvous/message-layer/v1-STATIC-NO-RATCHET";
const INFO_LO_HI = new TextEncoder().encode(INFO_BASE + "/lo->hi");
const INFO_HI_LO = new TextEncoder().encode(INFO_BASE + "/hi->lo");

export interface DirectionalKeys {
  sendKey: Uint8Array;
  recvKey: Uint8Array;
}

/**
 * Derive a STILL-STATIC but DIRECTION-SEPARATED key pair from the two peers'
 * long-term X25519 keys. Both peers compute the same shared secret and the same
 * sorted salt, then HKDF two keys with distinct `info` for each direction. The
 * "lo" peer (lexicographically smaller transport pub) sends with the lo->hi key;
 * the "hi" peer sends with hi->lo. Hence A.sendKey === B.recvKey and vice-versa.
 *
 * This removes the shared-key cross-direction coupling (so a reflected ciphertext
 * cannot decrypt under the receiver's recvKey) but does NOT add forward secrecy —
 * the keys are still long-term, by deliberate final design decision, not a
 * pending one. See the SECURITY NOTICE above.
 */
export function deriveDirectionalKeys(
  myTransportPriv: Uint8Array,
  theirTransportPub: Uint8Array,
  myTransportPub: Uint8Array,
): DirectionalKeys {
  const shared = x25519.getSharedSecret(myTransportPriv, theirTransportPub);
  const iAmLo = lexLess(myTransportPub, theirTransportPub);
  const lo = iAmLo ? myTransportPub : theirTransportPub;
  const hi = iAmLo ? theirTransportPub : myTransportPub;
  const salt = concatBytes(lo, hi); // order-independent
  const loHi = hkdf(sha256, shared, salt, INFO_LO_HI, 32);
  const hiLo = hkdf(sha256, shared, salt, INFO_HI_LO, 32);
  return iAmLo ? { sendKey: loHi, recvKey: hiLo } : { sendKey: hiLo, recvKey: loHi };
}

function lexLess(a: Uint8Array, b: Uint8Array): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** Encrypt one message. Output: nonce(24) || ciphertext. Random nonce per message. */
export function encryptMessage(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return concatBytes(nonce, ct);
}

/** Decrypt one message produced by encryptMessage. Throws on auth failure. */
export function decryptMessage(key: Uint8Array, framed: Uint8Array): Uint8Array {
  if (framed.length < 24 + 16) throw new Error("messagelayer: frame too short");
  const nonce = framed.slice(0, 24);
  const ct = framed.slice(24);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}
