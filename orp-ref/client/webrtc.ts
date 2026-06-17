// SPDX-License-Identifier: Apache-2.0
// WebRTC transport abstraction + an in-memory mock.
//
// The protocol's security-critical logic (signing, sealing, ICE filtering,
// channel lifetime) lives in core/ and board/ and is fully exercised without a
// real WebRTC stack. This interface is the seam where a real adapter plugs in.
//
// MockWebRTC produces realistic SDP and ICE candidate lines — including a raw-IP
// `host` candidate, an mDNS `.local` host, an `srflx` whose raddr leaks the base
// host IP, and a `relay` — so the ICE-filter and blindness tests are meaningful
// rather than testing against sanitized fixtures. A real adapter (e.g. wrapping
// `node-datachannel` or the browser RTCPeerConnection) would implement the same
// WebRTCEndpoint interface; the rest of the client is unchanged.

import { randomBytes } from "@noble/hashes/utils";
import { b64uEncode } from "../core/encoding.js";

export interface LocalDescription {
  sdp: string;
  candidates: string[]; // raw candidate values "candidate:..."
}

export interface WebRTCEndpoint {
  /** Create a fresh SDP offer/answer + gather ICE candidates on demand. */
  createLocalDescription(type: "offer" | "answer", remoteSdp?: string): Promise<LocalDescription>;
  applyRemoteDescription(sdp: string, candidates: string[]): Promise<void>;
  /** Establish the (mock) DTLS data channel and start delivering data. */
  connectDataChannel(): Promise<void>;
  onData(cb: (bytes: Uint8Array) => void): void;
  sendData(bytes: Uint8Array): void;
  close(): void;
}

export type IceTransportPolicy = "all" | "relay";

export interface MockProfile {
  hostIp: string; // raw LAN IP that must NEVER reach the peer or the board
  mdnsName: string; // obfuscated host name (e.g. <uuid>.local)
  srflxIp: string; // server-reflexive (public) IP
  relayIp: string; // TURN relay IP
}

export const DEFAULT_PROFILE: MockProfile = {
  hostIp: "192.168.1.37",
  mdnsName: "a1b2c3d4-1111-4222-8333-444455556666.local",
  srflxIp: "203.0.113.45",
  relayIp: "198.51.100.10",
};

/** Shared in-memory fabric that pairs the two endpoints of a match by match_id. */
export class MockNetwork {
  private endpoints = new Map<string, MockWebRTC[]>();

  register(matchId: string, ep: MockWebRTC): void {
    const list = this.endpoints.get(matchId) ?? [];
    list.push(ep);
    this.endpoints.set(matchId, list);
  }
  deliver(matchId: string, from: MockWebRTC, bytes: Uint8Array): void {
    const list = this.endpoints.get(matchId) ?? [];
    for (const ep of list) if (ep !== from) ep._receive(bytes);
  }
}

export class MockWebRTC implements WebRTCEndpoint {
  private dataCb: ((b: Uint8Array) => void) | null = null;
  private connected = false;

  constructor(
    private readonly matchId: string,
    private readonly network: MockNetwork,
    private readonly policy: IceTransportPolicy = "all",
    private readonly profile: MockProfile = DEFAULT_PROFILE,
  ) {}

  async createLocalDescription(type: "offer" | "answer"): Promise<LocalDescription> {
    const ufrag = b64uEncode(randomBytes(4));
    const pwd = b64uEncode(randomBytes(16));
    const fp = fakeFingerprint();
    const sdp = [
      "v=0",
      "o=- " + b64uEncode(randomBytes(6)) + " 2 IN IP4 127.0.0.1",
      "s=-",
      "t=0 0",
      "a=group:BUNDLE 0",
      "m=application 51820 UDP/DTLS/SCTP webrtc-datachannel",
      "c=IN IP4 0.0.0.0",
      "a=ice-ufrag:" + ufrag,
      "a=ice-pwd:" + pwd,
      "a=fingerprint:sha-256 " + fp,
      type === "offer" ? "a=setup:actpass" : "a=setup:active",
      "a=mid:0",
      "a=sctp-port:5000",
    ].join("\r\n");
    return { sdp, candidates: this.gatherCandidates() };
  }

  private gatherCandidates(): string[] {
    const p = this.profile;
    if (this.policy === "relay") {
      // relay-only transport mode: only TURN-relayed candidates are produced, so
      // the peer never learns this host's real IP at all.
      return [`candidate:4 1 udp 41885439 ${p.relayIp} 60000 typ relay raddr 0.0.0.0 rport 0`];
    }
    return [
      // raw-IP host: MUST be dropped by the ICE filter before sealing
      `candidate:1 1 udp 2122260223 ${p.hostIp} 51820 typ host`,
      // mDNS host: obfuscated, may be retained
      `candidate:2 1 udp 2122194687 ${p.mdnsName} 51821 typ host`,
      // srflx: retained, but its raddr leaks the base host IP -> must be scrubbed
      `candidate:3 1 udp 1686052607 ${p.srflxIp} 51822 typ srflx raddr ${p.hostIp} rport 51820`,
      // relay: preferred
      `candidate:4 1 udp 41885439 ${p.relayIp} 60000 typ relay raddr ${p.srflxIp} rport 51822`,
    ];
  }

  async applyRemoteDescription(_sdp: string, _candidates: string[]): Promise<void> {
    // The mock does not need SDP/ICE to connect (it pairs by match_id); a real
    // adapter would feed these into RTCPeerConnection.setRemoteDescription /
    // addIceCandidate. Kept as a no-op store to mirror the real call shape.
  }

  async connectDataChannel(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.network.register(this.matchId, this);
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  sendData(bytes: Uint8Array): void {
    this.network.deliver(this.matchId, this, bytes);
  }
  _receive(bytes: Uint8Array): void {
    this.dataCb?.(bytes);
  }
  close(): void {
    this.connected = false;
    this.dataCb = null;
  }
}

function fakeFingerprint(): string {
  const bytes = randomBytes(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

export type WebRTCFactory = (matchId: string, role: "initiator" | "responder") => WebRTCEndpoint;
