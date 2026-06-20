// Secure native key storage for the web/WebView shell (ORPAL-007).
//
// A browser has no direct OS-keychain API, but it does have one portal to the
// very same secure hardware: a WebAuthn *platform authenticator*. On each OS the
// platform authenticator is implemented by exactly the secure element this issue
// asks for --
//
//   * Apple (Safari / WKWebView)      -> Secure Enclave
//   * Android (Chrome / Capacitor)    -> Android Keystore, StrongBox when present
//   * Windows (Edge / Chrome)         -> TPM, via Windows Hello
//
// We use the credential's **PRF extension** (a HMAC-secret evaluated *inside* the
// authenticator) to derive a 256-bit wrapping key that never exists outside the
// secure element. That key seals the device's private keys with AES-GCM before
// they touch IndexedDB, so the at-rest copy is ciphertext bound to this device's
// hardware. When no platform authenticator / PRF is available we return `null`
// and the caller keeps the existing cleartext IndexedDB path.
//
// This file is the ONLY place that knows about WebAuthn; core sees just the
// `HardwareKeyProvider` byte interface.

import type { HardwareKeyProvider } from "@orpal/core";

const BACKEND = "webauthn-prf";
// Stable, app-scoped info for the resident credential we mint once per device.
const RP_NAME = "Orpal";
const CRED_USER_NAME = "orpal-device-key";
// localStorage handle for the credential id, so repeat saves reuse one passkey
// instead of minting (and prompting for) a new one each time.
const CRED_ID_LS = "orpal:hwkey:credentialId";

// TS 5.7's lib.dom types a fresh `Uint8Array` as `Uint8Array<ArrayBufferLike>`,
// which it won't accept where a `BufferSource` (backed by a plain ArrayBuffer) is
// required. These bytes always come from a real ArrayBuffer at runtime, so coerce.
const buf = (b: Uint8Array): BufferSource => b as unknown as BufferSource;

function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PRF results aren't in older lib.dom typings; describe just what we read. */
interface PrfExtensionResults {
  prf?: { results?: { first?: ArrayBuffer } };
}

function prfFirst(cred: PublicKeyCredential): Uint8Array | null {
  const results = cred.getClientExtensionResults() as PrfExtensionResults;
  const first = results.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function deriveAesKey(prfOutput: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(prfOutput), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Ensure a resident platform credential exists, returning its raw id. Mints one
 *  (prompting the user) on first use, then reuses it via localStorage. */
async function ensureCredentialId(): Promise<Uint8Array> {
  const cached = localStorage.getItem(CRED_ID_LS);
  if (cached) return b64uToBytes(cached);

  const userId = crypto.getRandomValues(new Uint8Array(16));
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      rp: { name: RP_NAME, id: location.hostname },
      user: { id: buf(userId), name: CRED_USER_NAME, displayName: CRED_USER_NAME },
      // -7 = ES256, -257 = RS256: the two every platform authenticator supports.
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!created) throw new Error("WebAuthn credential creation returned null");

  const rawId = new Uint8Array(created.rawId);
  localStorage.setItem(CRED_ID_LS, bytesToB64u(rawId));
  return rawId;
}

/** Run a WebAuthn assertion against our credential, evaluating PRF with `salt`,
 *  and return the 32-byte secret derived inside the secure element. */
async function evaluatePrf(credentialId: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: buf(crypto.getRandomValues(new Uint8Array(32))),
      allowCredentials: [{ type: "public-key", id: buf(credentialId) }],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: buf(salt) } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error("WebAuthn assertion returned null");
  const prf = prfFirst(assertion);
  if (!prf) throw new Error("authenticator did not return a PRF result (extension unsupported)");
  return prf;
}

// Opaque sealed-bytes layout: [1B version][1B saltLen][salt][12B iv][ciphertext].
const ENVELOPE_VERSION = 1;
const SALT_LEN = 32;
const IV_LEN = 12;

class WebAuthnKeyProvider implements HardwareKeyProvider {
  readonly backend = BACKEND;

  async isAvailable(): Promise<boolean> {
    try {
      if (typeof window === "undefined") return false;
      if (typeof PublicKeyCredential === "undefined") return false;
      if (!navigator.credentials || !window.isSecureContext) return false;
      // A platform (built-in) authenticator is the gateway to the secure element.
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }

  async wrap(plaintext: Uint8Array): Promise<Uint8Array> {
    const credentialId = await ensureCredentialId();
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const prf = await evaluatePrf(credentialId, salt);
    const key = await deriveAesKey(prf);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(plaintext)),
    );

    const out = new Uint8Array(2 + SALT_LEN + IV_LEN + ciphertext.length);
    out[0] = ENVELOPE_VERSION;
    out[1] = SALT_LEN;
    out.set(salt, 2);
    out.set(iv, 2 + SALT_LEN);
    out.set(ciphertext, 2 + SALT_LEN + IV_LEN);
    return out;
  }

  async unwrap(sealed: Uint8Array): Promise<Uint8Array> {
    if (sealed[0] !== ENVELOPE_VERSION) {
      throw new Error(`unsupported sealed-key version ${sealed[0]}`);
    }
    const saltLen = sealed[1];
    let off = 2;
    const salt = sealed.subarray(off, off + saltLen);
    off += saltLen;
    const iv = sealed.subarray(off, off + IV_LEN);
    off += IV_LEN;
    const ciphertext = sealed.subarray(off);

    const credentialId = localStorage.getItem(CRED_ID_LS);
    if (!credentialId) {
      throw new Error("no WebAuthn credential id on this device to unseal keys");
    }
    const prf = await evaluatePrf(b64uToBytes(credentialId), new Uint8Array(salt));
    const key = await deriveAesKey(prf);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(iv) },
      key,
      buf(ciphertext),
    );
    return new Uint8Array(plaintext);
  }
}

/**
 * Capability-detect platform secure hardware and return a provider for it, or
 * `null` when none is present (the caller then keeps the cleartext IndexedDB
 * path). Detection is at runtime, so one build degrades gracefully across
 * Apple / Android / Windows and plain browsers alike.
 */
export async function createHardwareKeyProvider(): Promise<HardwareKeyProvider | null> {
  const provider = new WebAuthnKeyProvider();
  return (await provider.isAvailable()) ? provider : null;
}
