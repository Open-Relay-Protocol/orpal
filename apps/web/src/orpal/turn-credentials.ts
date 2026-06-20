// ORPAL-014: TURN credentials sealed at rest.
//
// TURN usernames + credentials used to live in plaintext inside AppSettings
// (localStorage), unlike the identity keys which ORPAL-007 seals to the device's
// secure element. A malicious extension, same-origin XSS, or physical access
// could read them straight out of localStorage.
//
// This module seals the credentials through the SAME HardwareKeyProvider used for
// the identity keys (no new crypto): when secure hardware is available the bytes
// at rest are a hardware-sealed SecureEnvelope; otherwise it gracefully falls
// back to a cleartext blob in its own IndexedDB slot (same posture as the key
// store's fallback). AppSettings keeps only the TURN *URLs* and non-secret config;
// the secret username/credential pairs are merged back in at connection time.

import type { HardwareKeyProvider, SecureEnvelope } from "@orpal/core";
import { b64uDecode, b64uEncode } from "@orpal/core";
import type { IceServer } from "@shared/ipc";
import { kvDelete, kvGet, kvSet } from "./idb.js";

const TURN_CRED_KV = "turnCredentials";

/** Secret half of a TURN server config. */
export interface TurnCredential {
  username: string;
  credential: string;
}

/** TURN credentials keyed by the TURN server URL they belong to. */
export type TurnCredentials = Record<string, TurnCredential>;

/** Cleartext fallback shape (tagged so it's unambiguous against a SecureEnvelope). */
interface ClearCredentials {
  kind: "clear";
  v: 1;
  creds: TurnCredentials;
}

type StoredCredentials = SecureEnvelope | ClearCredentials;

const isSecureEnvelope = (v: StoredCredentials): v is SecureEnvelope =>
  (v as SecureEnvelope).kind === "hw";

const isTurnScheme = (url: string): boolean => /^turns?:/i.test(url.trim());
const urlsOf = (s: IceServer): string[] => (Array.isArray(s.urls) ? s.urls : [s.urls]);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Seals TURN credentials with the device's secure hardware when available, and
 * otherwise stores them in cleartext in their own IndexedDB slot. Mirrors
 * HardwareBackedKeyStore's behaviour (seal-on-save, graceful fallback) but for the
 * credential map rather than the private keys.
 */
export class SealedCredentialStore {
  constructor(
    private readonly provider: HardwareKeyProvider | null,
    /** Surfaces a degraded-to-cleartext save (diagnostics), like the key store. */
    private readonly onFallback?: (reason: unknown) => void,
  ) {}

  async load(): Promise<TurnCredentials> {
    const stored = await kvGet<StoredCredentials>(TURN_CRED_KV);
    if (!stored) return {};
    if (!isSecureEnvelope(stored)) return stored.creds;
    if (!this.provider) {
      throw new Error(
        "TURN credentials are sealed to secure hardware, but no provider is available on this device",
      );
    }
    const plaintext = await this.provider.unwrap(b64uDecode(stored.blob));
    return JSON.parse(textDecoder.decode(plaintext)) as TurnCredentials;
  }

  async save(creds: TurnCredentials): Promise<void> {
    if (this.provider && (await this.provider.isAvailable())) {
      try {
        const sealed = await this.provider.wrap(textEncoder.encode(JSON.stringify(creds)));
        const envelope: SecureEnvelope = {
          kind: "hw",
          v: 1,
          backend: this.provider.backend,
          blob: b64uEncode(sealed),
        };
        await kvSet(TURN_CRED_KV, envelope);
        return;
      } catch (err) {
        // Advertised but sealing failed (prompt dismissed, PRF unsupported) --
        // fall back to cleartext so credentials are still persisted.
        this.onFallback?.(err);
      }
    }
    const clear: ClearCredentials = { kind: "clear", v: 1, creds };
    await kvSet(TURN_CRED_KV, clear);
  }

  async clear(): Promise<void> {
    await kvDelete(TURN_CRED_KV);
  }
}

// ---- splitting credentials out of / back into an IceServer[] ----------------

/** Pull the secret TURN username/credential pairs out of an IceServer[], keyed by
 *  each TURN URL. Used before persisting settings so secrets go only to the sealed
 *  store. */
export function extractTurnCredentials(servers: IceServer[]): TurnCredentials {
  const creds: TurnCredentials = {};
  for (const s of servers) {
    if (s.username === undefined && s.credential === undefined) continue;
    for (const url of urlsOf(s)) {
      if (isTurnScheme(url)) {
        creds[url] = { username: s.username ?? "", credential: s.credential ?? "" };
      }
    }
  }
  return creds;
}

/** Return a copy of the servers with TURN secrets removed -- the non-secret shape
 *  safe to persist in AppSettings (localStorage). */
export function stripTurnCredentials(servers: IceServer[]): IceServer[] {
  return servers.map((s) => {
    if (!urlsOf(s).some(isTurnScheme)) return s;
    const { username: _u, credential: _c, ...rest } = s;
    return rest;
  });
}

/** Re-attach sealed TURN credentials to the servers' TURN entries for use at
 *  connection time (and for editing in the Settings UI). */
export function mergeTurnCredentials(servers: IceServer[], creds: TurnCredentials): IceServer[] {
  return servers.map((s) => {
    const match = urlsOf(s).find((url) => isTurnScheme(url) && creds[url]);
    if (!match) return s;
    return { ...s, username: creds[match].username, credential: creds[match].credential };
  });
}

/** Whether any server carries an inline TURN secret (used to detect a pre-ORPAL-014
 *  plaintext config that should be migrated into the sealed store). */
export function hasInlineTurnSecret(servers: IceServer[]): boolean {
  return servers.some(
    (s) => urlsOf(s).some(isTurnScheme) && (s.username !== undefined || s.credential !== undefined),
  );
}
