// ICE-server config helpers for the Settings UI (issue #25).
//
// This is PRESENTATION ONLY. The persisted value remains the same
// `IceServer[]` that `BrowserWebRTCEndpoint` already consumes -- these helpers
// just let the UI offer a friendly form instead of raw JSON, and validate /
// reachability-test what the user typed. Nothing here touches the ORP envelope,
// sealing, ICE filtering, or `assertNoUnobfuscatedHost`; the connection test
// only inspects locally-gathered candidate *types* (never addresses), and sends
// nothing over any board.

import type { IceServer } from "@shared/ipc";

/** One TURN relay row in the form editor. */
export interface TurnEntry {
  url: string;
  username: string;
  credential: string;
}

/** The simple, form-editable view of an ICE config: one STUN URL plus any number
 *  of credentialed TURN servers. */
export interface IceForm {
  stunUrl: string;
  turns: TurnEntry[];
}

export const isStunScheme = (url: string): boolean => /^stuns?:/i.test(url.trim());
export const isTurnScheme = (url: string): boolean => /^turns?:/i.test(url.trim());
const hasScheme = (url: string): boolean => /^[a-z]+:/i.test(url.trim());

function urlsOf(server: IceServer): string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls];
}

/**
 * Whether an `IceServer[]` can be shown in the simple form without losing
 * information. We keep it conservative: every server must carry a single URL
 * string of a known (stun/turn) scheme, and there must be at most one STUN URL.
 * Anything more exotic (URL arrays, multiple STUN entries, unknown schemes) stays
 * in the Advanced JSON editor so nothing is silently dropped.
 */
export function isSimpleConfig(servers: IceServer[]): boolean {
  let stunCount = 0;
  for (const s of servers) {
    if (Array.isArray(s.urls)) return false;
    const url = s.urls;
    if (isStunScheme(url)) stunCount++;
    else if (!isTurnScheme(url)) return false;
  }
  return stunCount <= 1;
}

/** Best-effort projection of an `IceServer[]` into the form model. */
export function iceServersToForm(servers: IceServer[]): IceForm {
  let stunUrl = "";
  const turns: TurnEntry[] = [];
  for (const s of servers) {
    for (const url of urlsOf(s)) {
      if (isTurnScheme(url)) {
        turns.push({ url, username: s.username ?? "", credential: s.credential ?? "" });
      } else if (isStunScheme(url) && !stunUrl) {
        stunUrl = url;
      }
    }
  }
  return { stunUrl, turns };
}

/** Serialize the form model back to the `IceServer[]` the endpoint consumes.
 *  This is the single source of truth for what gets persisted in form mode. */
export function formToIceServers(form: IceForm): IceServer[] {
  const out: IceServer[] = [];
  if (form.stunUrl.trim()) out.push({ urls: form.stunUrl.trim() });
  for (const t of form.turns) {
    if (!t.url.trim()) continue;
    out.push({ urls: t.url.trim(), username: t.username, credential: t.credential });
  }
  return out;
}

/** Inline validation for the form. Returns human-readable errors (empty = ok). */
export function validateForm(form: IceForm): string[] {
  const errors: string[] = [];
  if (form.stunUrl.trim() && !isStunScheme(form.stunUrl)) {
    errors.push(
      "STUN URL must start with “stun:” (or “stuns:”), e.g. stun:stun.l.google.com:19302.",
    );
  }
  form.turns.forEach((t, i) => {
    const url = t.url.trim();
    if (!url) return;
    const label = form.turns.length > 1 ? ` #${i + 1}` : "";
    if (!isTurnScheme(url)) {
      errors.push(`TURN server${label} URL must start with “turn:” (or “turns:”).`);
    }
    if (!t.username.trim() || !t.credential.trim()) {
      errors.push(`TURN server${label} needs both a username and a credential.`);
    }
  });
  return errors;
}

/** Parse + validate the raw-JSON editor's contents. */
export function parseIceJson(
  text: string,
): { ok: true; servers: IceServer[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${err instanceof Error ? err.message : err}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, error: "ICE servers must be a JSON array of { urls, … } objects." };
  }
  for (let i = 0; i < parsed.length; i++) {
    const s = parsed[i] as Partial<IceServer>;
    if (!s || typeof s !== "object" || s.urls === undefined) {
      return { ok: false, error: `Entry #${i + 1} is missing a "urls" field.` };
    }
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    if (urls.some((u) => typeof u !== "string" || !hasScheme(u))) {
      return {
        ok: false,
        error: `Entry #${i + 1} has a URL with no scheme (expected stun:/turn:/stuns:/turns:).`,
      };
    }
  }
  return { ok: true, servers: parsed as IceServer[] };
}

// ---------------------------------------------------------------------------
// "Test connection" -- gather ICE candidates against the configured servers and
// report STUN/TURN reachability. Privacy: we only ever read candidate *types*
// (host / srflx / relay), never their addresses, and nothing is sent anywhere.
// ---------------------------------------------------------------------------

export interface IceTestResult {
  srflx: boolean; // a server-reflexive candidate -> STUN reachable
  relay: boolean; // a relay candidate -> TURN relay obtained
  host: boolean;
  candidateCount: number;
  /** Per-server gathering errors (e.g. TURN allocate failed). */
  errors: string[];
}

/** True if at least one configured server uses a TURN scheme. */
export function configHasTurn(servers: IceServer[]): boolean {
  return servers.some((s) => urlsOf(s).some(isTurnScheme));
}

export async function testIceServers(
  servers: IceServer[],
  timeoutMs = 8000,
): Promise<IceTestResult> {
  const result: IceTestResult = {
    srflx: false,
    relay: false,
    host: false,
    candidateCount: 0,
    errors: [],
  };
  if (typeof RTCPeerConnection === "undefined") {
    result.errors.push("WebRTC is not available in this browser.");
    return result;
  }

  const pc = new RTCPeerConnection({ iceServers: servers as RTCIceServer[] });
  try {
    const finished = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
      pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
        if (!ev.candidate) return; // null => gathering complete (handled above)
        result.candidateCount++;
        switch (ev.candidate.type) {
          case "srflx":
            result.srflx = true;
            break;
          case "relay":
            result.relay = true;
            break;
          case "host":
            result.host = true;
            break;
        }
      };
      // Surface STUN/TURN errors (bad host, wrong TURN credentials, …).
      pc.onicecandidateerror = (ev: Event) => {
        const e = ev as RTCPeerConnectionIceErrorEvent;
        // 701 = STUN/TURN server unreachable; ignore the benign 600-range "done".
        if (e.errorCode && e.errorCode !== 600) {
          const where = e.url ? ` (${e.url})` : "";
          result.errors.push(`${e.errorCode} ${e.errorText ?? "ICE error"}${where}`);
        }
      };
    });

    pc.createDataChannel("orpal-ice-test");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await finished;
  } finally {
    pc.close();
  }
  return result;
}
