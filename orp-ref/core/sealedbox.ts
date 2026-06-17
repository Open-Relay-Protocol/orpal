// SPDX-License-Identifier: Apache-2.0
// Anonymous sealed box: encrypt-to-public-key with an ephemeral sender keypair.
//
// This is control (a) of the signaling-confidentiality design: SDP, the SDP
// answer, and ICE candidates are sealed to the recipient's X25519 transport key
// BEFORE they reach the board. The board relays the resulting ciphertext and
// cannot read it. This is what blinds the board to signaling content.
//
// Construction (libsodium crypto_box_seal style):
//   eph        = fresh X25519 keypair (per message)
//   shared     = X25519(eph_priv, recipient_pub)
//   key        = HKDF-SHA256(shared, salt = eph_pub||recipient_pub, info)
//   nonce      = SHA256(eph_pub||recipient_pub)[:24]   (unique because eph is unique)
//   ciphertext = XChaCha20-Poly1305(key, nonce).encrypt(plaintext)
//   output     = eph_pub (32 bytes) || ciphertext
//
// The sender is anonymous at the crypto layer (ephemeral key, no sender identity
// in the box). Sender authentication is provided separately by the Ed25519
// signature on the enclosing signaling frame.

import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes } from "./encoding.js";

const INFO = new TextEncoder().encode("blind-rendezvous/sealed-box/v1");

function deriveKeyAndNonce(
  shared: Uint8Array,
  ephPub: Uint8Array,
  recipientPub: Uint8Array,
): { key: Uint8Array; nonce: Uint8Array } {
  const salt = concatBytes(ephPub, recipientPub);
  const key = hkdf(sha256, shared, salt, INFO, 32);
  const nonce = sha256(salt).slice(0, 24); // XChaCha20 takes a 24-byte nonce
  return { key, nonce };
}

/** Seal `plaintext` to `recipientTransportPub`. Returns eph_pub || ciphertext. */
export function seal(plaintext: Uint8Array, recipientTransportPub: Uint8Array): Uint8Array {
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientTransportPub);
  const { key, nonce } = deriveKeyAndNonce(shared, ephPub, recipientTransportPub);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return concatBytes(ephPub, ct);
}

/**
 * Unseal a box with the recipient's X25519 *private* key. Throws on auth failure
 * (wrong key, tampered ciphertext). The private key never leaves the caller.
 */
export function unseal(
  box: Uint8Array,
  recipientTransportPriv: Uint8Array,
  recipientTransportPub: Uint8Array,
): Uint8Array {
  if (box.length < 32 + 16) throw new Error("sealedbox: ciphertext too short");
  const ephPub = box.slice(0, 32);
  const ct = box.slice(32);
  const shared = x25519.getSharedSecret(recipientTransportPriv, ephPub);
  const { key, nonce } = deriveKeyAndNonce(shared, ephPub, recipientTransportPub);
  return xchacha20poly1305(key, nonce).decrypt(ct);
}
