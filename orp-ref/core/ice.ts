// SPDX-License-Identifier: Apache-2.0
// ICE candidate policy — control (b) of signaling confidentiality.
//
// This control protects against a DIFFERENT adversary than sealing does. Sealing
// (sealedbox.ts) blinds the BOARD. This filter limits what the *peer* learns
// about your LAN / IP, by trimming the candidate set BEFORE it is sealed and
// sent. The two are non-substitutable:
//   - Sealing without ICE filtering: board is blind, but the peer still sees
//     your raw host LAN addresses inside the sealed blob.
//   - ICE filtering without sealing: the peer sees less, but the board reads
//     everything in cleartext.
//
// Policy:
//   * DROP `host` candidates whose address is a raw IP literal.
//   * RETAIN `host` candidates whose address is an mDNS `.local` name (already
//     obfuscated — the peer cannot resolve it without being on your LAN).
//   * PREFER / RETAIN `srflx` and `relay` (and `prflx`) candidates.
//   * SCRUB the related-address (`raddr`/`rport`) on retained candidates: srflx
//     reflexive candidates otherwise carry your *base* (host) IP in raddr, which
//     re-leaks exactly what dropping host candidates was meant to hide.
//
// `relay`-only mode (iceTransportPolicy: "relay") goes further and is offered as
// a transport mode for privacy-sensitive contacts (see client + SPEC): it hides
// the peer's IP from the peer entirely at the cost of routing through a TURN
// server.

export type CandidateType = "host" | "srflx" | "prflx" | "relay" | string;

export interface ParsedCandidate {
  foundation: string;
  component: string;
  transport: string;
  priority: string;
  address: string;
  port: string;
  type: CandidateType;
  raddr?: string;
  rport?: string;
  /** the candidate value with the leading `a=` and `candidate:` stripped */
  rest: string;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
// Any colon-containing token that isn't an mDNS name we treat as an IPv6 literal.
function isRawIp(addr: string): boolean {
  if (IPV4.test(addr)) return true;
  if (addr.includes(":")) return true; // IPv6 literal
  return false;
}

export function isMdnsHostname(addr: string): boolean {
  return /\.local$/i.test(addr);
}

/** Parse one candidate line (accepts `a=candidate:...`, `candidate:...`, or the bare value). */
export function parseCandidate(line: string): ParsedCandidate | null {
  let s = line.trim();
  if (s.startsWith("a=")) s = s.slice(2);
  if (s.startsWith("candidate:")) s = s.slice("candidate:".length);
  const t = s.split(/\s+/);
  if (t.length < 8) return null;
  const typIdx = t.indexOf("typ");
  if (typIdx === -1 || typIdx + 1 >= t.length) return null;

  const parsed: ParsedCandidate = {
    foundation: t[0],
    component: t[1],
    transport: t[2],
    priority: t[3],
    address: t[4],
    port: t[5],
    type: t[typIdx + 1],
    rest: s,
  };
  const raddrIdx = t.indexOf("raddr");
  if (raddrIdx !== -1 && raddrIdx + 1 < t.length) parsed.raddr = t[raddrIdx + 1];
  const rportIdx = t.indexOf("rport");
  if (rportIdx !== -1 && rportIdx + 1 < t.length) parsed.rport = t[rportIdx + 1];
  return parsed;
}

export interface FilterDecision {
  keep: boolean;
  reason: string;
  /** the candidate value to emit if kept (may be scrubbed) */
  sanitized?: string;
}

/** Decide whether a single candidate survives the policy, and scrub if retained. */
export function decideCandidate(c: ParsedCandidate): FilterDecision {
  if (c.type === "host") {
    if (isMdnsHostname(c.address)) {
      return { keep: true, reason: "host:mdns-obfuscated", sanitized: scrubRelated(c) };
    }
    if (isRawIp(c.address)) {
      return { keep: false, reason: "host:raw-ip-dropped" };
    }
    return { keep: false, reason: "host:unknown-address-form-dropped" };
  }
  if (c.type === "srflx" || c.type === "relay" || c.type === "prflx") {
    return { keep: true, reason: `${c.type}:retained-raddr-scrubbed`, sanitized: scrubRelated(c) };
  }
  return { keep: false, reason: `unknown-type:${c.type}:dropped` };
}

/** Replace raddr/rport (the base host address leak) with neutral values. */
function scrubRelated(c: ParsedCandidate): string {
  let rest = c.rest;
  rest = rest.replace(/\braddr\s+\S+/i, "raddr 0.0.0.0");
  rest = rest.replace(/\brport\s+\S+/i, "rport 0");
  return rest;
}

export interface CandidateFilterResult {
  kept: string[]; // sanitized candidate values (with leading `candidate:`)
  dropped: { candidate: string; reason: string }[];
}

/** Filter a list of candidate lines/values. */
export function filterCandidates(lines: string[]): CandidateFilterResult {
  const kept: string[] = [];
  const dropped: { candidate: string; reason: string }[] = [];
  for (const line of lines) {
    const c = parseCandidate(line);
    if (!c) {
      dropped.push({ candidate: line, reason: "unparseable" });
      continue;
    }
    const d = decideCandidate(c);
    if (d.keep && d.sanitized) kept.push("candidate:" + d.sanitized);
    else dropped.push({ candidate: line, reason: d.reason });
  }
  return { kept, dropped };
}

/** Filter candidate lines embedded in an SDP blob, returning a rewritten SDP. */
export function filterSdp(sdp: string): { sdp: string; result: CandidateFilterResult } {
  const out: string[] = [];
  const kept: string[] = [];
  const dropped: { candidate: string; reason: string }[] = [];
  for (const rawLine of sdp.split(/\r?\n/)) {
    if (/^a=candidate:/.test(rawLine)) {
      const c = parseCandidate(rawLine);
      if (!c) {
        dropped.push({ candidate: rawLine, reason: "unparseable" });
        continue;
      }
      const d = decideCandidate(c);
      if (d.keep && d.sanitized) {
        const line = "a=candidate:" + d.sanitized;
        out.push(line);
        kept.push(line);
      } else {
        dropped.push({ candidate: rawLine, reason: d.reason });
      }
    } else {
      out.push(rawLine);
    }
  }
  return { sdp: out.join("\r\n"), result: { kept, dropped } };
}

/**
 * Safety gate: throws if ANY `host` candidate with a raw IP survives. Call this
 * on the final candidate set right before sealing/sending — it is the last line
 * of defence behind decideCandidate, so a future bug in the filter cannot let a
 * raw host address escape silently.
 */
export function assertNoUnobfuscatedHost(candidatesOrSdp: string | string[]): void {
  const lines =
    typeof candidatesOrSdp === "string"
      ? candidatesOrSdp.split(/\r?\n/).filter((l) => /candidate:/.test(l))
      : candidatesOrSdp;
  for (const line of lines) {
    const c = parseCandidate(line);
    if (!c) continue;
    if (c.type === "host" && isRawIp(c.address)) {
      throw new Error(
        `ICE leak: unobfuscated host candidate would escape: ${c.address}`,
      );
    }
    // a retained srflx/relay must not still carry a raw raddr base address
    if (c.raddr && isRawIp(c.raddr) && c.raddr !== "0.0.0.0") {
      throw new Error(
        `ICE leak: candidate retains base host address in raddr: ${c.raddr}`,
      );
    }
  }
}
