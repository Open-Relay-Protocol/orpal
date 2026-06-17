// SPDX-License-Identifier: Apache-2.0
//
// Client: generates both keypairs locally, signs announces, drives the two-stage
// match, seals SDP/ICE to the peer's X25519 key, applies ICE filtering, and
// completes the (mock) DTLS data-channel handshake + inner secure message layer.
//
// This file (and all of client/ and core/) is Apache-2.0 and depends ONLY on the
// Apache-licensed protocol interface in core/protocol.ts — never on the AGPL
// reference board in board/. A client builder can take client/ + core/ and talk
// to any conforming RendezvousBroker without inheriting the board's copyleft.
//
// Two-stage match (see SPEC.md):
//   Stage 1: presence(B) <-> intent(A) match on identity keys (done by the board).
//   Stage 2: over the temporary channel keyed by match_id —
//     (1) KEY phase:       each side publishes its X25519 transport key + signed
//                          binding (public; resolves "how does A get B's key" —
//                          transport keys are deliberately NOT in presence/intent
//                          to prevent passive mass harvesting; see collision #1).
//     (2) SIGNALING phase: A seals a FRESH SDP offer+ICE to B; B seals a FRESH
//                          SDP answer+ICE to A. The board relays opaque blobs.

import type {
  BoardConnection,
  FrameKind,
  Outbound,
  RendezvousBroker,
} from "../core/protocol.js";
import { DeviceIdentity, verifyBinding } from "../core/identity.js";
import {
  MatchFrame,
  makeIntent,
  makeKeyFrame,
  makePresence,
  makeSignalingFrame,
  verifyMatchFrame,
} from "../core/wire.js";
import { assertNoUnobfuscatedHost, filterCandidates, filterSdp } from "../core/ice.js";
import { seal, unseal } from "../core/sealedbox.js";
import { b64uDecode, b64uEncode, fromUtf8, utf8 } from "../core/encoding.js";
import { SecureChannel } from "./securechannel.js";
import {
  DEFAULT_PROFILE,
  IceTransportPolicy,
  MockNetwork,
  MockProfile,
  MockWebRTC,
  WebRTCEndpoint,
  WebRTCFactory,
} from "./webrtc.js";

export interface ClientOptions {
  boards_scope?: string[];
  iceTransportPolicy?: IceTransportPolicy;
  /** Real adapters override this; defaults to the in-memory MockWebRTC. */
  webrtcFactory?: WebRTCFactory;
  network?: MockNetwork; // used by the default mock factory
  profile?: MockProfile;
  now?: () => string;
}

export interface ConnectedInfo {
  match_id: string;
  counterparty_key: string;
  channel: SecureChannel;
}

function encodeFrame(frame: MatchFrame): string {
  return b64uEncode(utf8(JSON.stringify(frame)));
}
function decodeFrame(blob: string): MatchFrame {
  return JSON.parse(fromUtf8(b64uDecode(blob)));
}

export class Client {
  readonly identity: DeviceIdentity;
  private readonly conn: BoardConnection;
  private readonly opts: ClientOptions;
  private readonly factory: WebRTCFactory;

  private sessions = new Map<string, MatchSession>();
  /** Identity keys this client has an outstanding intent toward. Used to reject a
   *  board that tries to match the initiator with someone it did NOT ask for
   *  (board-driven redirection — see onBoardMessage). */
  private pendingTargets = new Set<string>();
  /** Every board->client message, for test assertions (acks/rejects/evictions). */
  readonly events: Outbound[] = [];
  private connectionWaiters: ((info: ConnectedInfo) => void)[] = [];

  constructor(broker: RendezvousBroker, identity?: DeviceIdentity, opts: ClientOptions = {}) {
    this.identity = identity ?? DeviceIdentity.generate(opts.now);
    this.opts = opts;
    const network = opts.network ?? new MockNetwork();
    const profile = opts.profile ?? DEFAULT_PROFILE;
    const policy = opts.iceTransportPolicy ?? "all";
    this.factory =
      opts.webrtcFactory ??
      ((matchId: string) => new MockWebRTC(matchId, network, policy, profile));
    this.conn = broker.connect((msg) => this.onBoardMessage(msg));
  }

  get identityKey(): string {
    return this.identity.identityKeyB64;
  }

  /** Publish the always-on presence beacon (identity only — no transport key). */
  announcePresence(boards_scope?: string[]): void {
    const presence = makePresence(this.identity, {
      boards_scope: boards_scope ?? this.opts.boards_scope ?? ["default"],
      now: this.opts.now,
    });
    this.conn.send({ kind: "presence", record: presence });
  }

  /** Send an intent to initiate a rendezvous with `targetKey`. */
  sendIntent(targetKey: string): void {
    this.pendingTargets.add(targetKey);
    const intent = makeIntent(this.identity, { target_key: targetKey, now: this.opts.now });
    this.conn.send({ kind: "intent", record: intent });
  }

  /** Resolves the next time any match for this client connects. */
  waitForConnection(): Promise<ConnectedInfo> {
    return new Promise((resolve) => this.connectionWaiters.push(resolve));
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.conn.close();
  }

  // ---- board message dispatch ---------------------------------------------

  private onBoardMessage(msg: Outbound): void {
    this.events.push(msg);
    switch (msg.kind) {
      case "match": {
        // Anti-redirection: if WE initiated, the board must not match us with
        // anyone other than a key we actually sent an intent for. A malicious
        // board could otherwise steer us to a peer of its choosing (who would
        // then learn we wanted to connect, and our IP in P2P mode). The
        // responder side legitimately accepts any initiator (open presence).
        if (msg.role === "initiator" && !this.pendingTargets.has(msg.counterparty_key)) {
          this.events.push({ kind: "rejected", of: "relay", reason: "unsolicited-match" });
          break;
        }
        const session = new MatchSession(
          this.identity,
          msg.role,
          msg.match_id,
          msg.counterparty_key,
          this.factory(msg.match_id, msg.role),
          (frame_kind, blob) =>
            this.conn.send({ kind: "relay", match_id: msg.match_id, frame_kind, blob }),
          (info) => this.onConnected(info),
        );
        this.sessions.set(msg.match_id, session);
        // Fire-and-forget, but never let a throw become an unhandled rejection:
        // MatchSession records failures in `lastError`; this is the backstop.
        session.start().catch((e) => {
          session.lastError = `session-error:${(e as Error)?.message ?? e}`;
        });
        break;
      }
      case "relay": {
        const s = this.sessions.get(msg.match_id);
        s?.onRelay(msg.frame_kind, msg.blob).catch((e) => {
          s.lastError = `session-error:${(e as Error)?.message ?? e}`;
        });
        break;
      }
      case "channel_closed": {
        // Signaling done or expired; the data channel (if up) is independent.
        this.sessions.get(msg.match_id)?.onChannelClosed(msg.reason);
        break;
      }
      // ack / rejected / evicted are recorded in `events` for tests.
    }
  }

  private onConnected(info: ConnectedInfo): void {
    const waiters = this.connectionWaiters;
    this.connectionWaiters = [];
    for (const w of waiters) w(info);
  }
}

type SessionState = "await-peer-key" | "await-offer" | "await-answer" | "connected" | "closed";

class MatchSession {
  private state: SessionState = "await-peer-key";
  private peerTransportPub: Uint8Array | null = null;
  private remoteSdp: string | null = null;
  lastError: string | null = null;

  constructor(
    private readonly identity: DeviceIdentity,
    private readonly role: "initiator" | "responder",
    private readonly matchId: string,
    private readonly counterpartyKey: string,
    private readonly endpoint: WebRTCEndpoint,
    private readonly relay: (frame_kind: FrameKind, blob: string) => void,
    private readonly onConnected: (info: ConnectedInfo) => void,
  ) {}

  async start(): Promise<void> {
    // Publish our transport key + binding (KEY phase). Initiator frames are
    // match_offer; responder frames are match_answer.
    const type = this.role === "initiator" ? "match_offer" : "match_answer";
    const keyFrame = makeKeyFrame(this.identity, { type, match_id: this.matchId });
    this.relay("key", encodeFrame(keyFrame));
    this.state = this.role === "initiator" ? "await-peer-key" : "await-offer";
  }

  async onRelay(_frameKind: FrameKind, blob: string): Promise<void> {
    let frame: MatchFrame;
    try {
      frame = decodeFrame(blob);
    } catch {
      this.lastError = "undecodable-frame";
      return;
    }
    if (frame.match_id !== this.matchId) {
      this.lastError = "wrong-match-id";
      return;
    }
    const v = verifyMatchFrame(frame, this.counterpartyKey);
    if (!v.valid) {
      this.lastError = `frame-rejected:${v.reason}`;
      return;
    }

    if (frame.phase === "key") {
      // Idempotent: a duplicate/replayed key frame must NOT drive a second offer.
      if (this.peerTransportPub) return;
      // Already validated by verifyMatchFrame (binding + identity/transport match).
      if (!verifyBinding(frame.binding!)) {
        this.lastError = "bad-binding";
        return;
      }
      this.peerTransportPub = b64uDecode(frame.transport_key!);
      if (this.role === "initiator") {
        await this.sendOffer();
      }
      // responder: wait for the offer (already in await-offer)
      return;
    }

    // SIGNALING phase
    if (!this.peerTransportPub) {
      this.lastError = "signaling-before-key";
      return;
    }
    let payload: { sdp: string; candidates: string[] };
    try {
      const pt = unseal(
        b64uDecode(frame.enc_signaling!),
        this.identity.transportPrivate(),
        this.identity.transportPub,
      );
      payload = JSON.parse(fromUtf8(pt));
    } catch {
      this.lastError = "unseal-failed";
      return;
    }

    if (this.role === "responder") {
      this.remoteSdp = payload.sdp;
      await this.endpoint.applyRemoteDescription(payload.sdp, payload.candidates);
      await this.sendAnswer();
      await this.finishConnect();
    } else {
      await this.endpoint.applyRemoteDescription(payload.sdp, payload.candidates);
      await this.finishConnect();
    }
  }

  private async sendOffer(): Promise<void> {
    const local = await this.endpoint.createLocalDescription("offer");
    const enc = this.sealSignaling(local.sdp, local.candidates);
    const frame = makeSignalingFrame(this.identity, {
      type: "match_offer",
      match_id: this.matchId,
      enc_signaling: enc,
    });
    this.relay("offer", encodeFrame(frame));
    this.state = "await-answer";
  }

  private async sendAnswer(): Promise<void> {
    const local = await this.endpoint.createLocalDescription("answer", this.remoteSdp ?? undefined);
    const enc = this.sealSignaling(local.sdp, local.candidates);
    const frame = makeSignalingFrame(this.identity, {
      type: "match_answer",
      match_id: this.matchId,
      enc_signaling: enc,
    });
    this.relay("answer", encodeFrame(frame));
  }

  /** Filter ICE (control b), gate against host leaks, then seal (control a).
   *  Applies the filter to BOTH the separate candidate array AND the SDP body —
   *  a real WebRTC adapter routinely inlines `a=candidate:` lines (with host IPs)
   *  inside the SDP, so filtering only the array would let those escape to the
   *  peer. SPEC §5/§6b: filter -> gate -> seal over the whole {sdp, candidates}. */
  private sealSignaling(sdp: string, candidates: string[]): string {
    const filtered = filterCandidates(candidates);
    const filteredSdp = filterSdp(sdp);
    // Last-line-of-defence gate: never let a raw host candidate escape, even if
    // the filter has a bug — covering the candidate array AND the SDP body.
    assertNoUnobfuscatedHost(filtered.kept);
    assertNoUnobfuscatedHost(filteredSdp.sdp);
    const payload = utf8(JSON.stringify({ sdp: filteredSdp.sdp, candidates: filtered.kept }));
    return b64uEncode(seal(payload, this.peerTransportPub!));
  }

  private async finishConnect(): Promise<void> {
    if (this.state === "connected" || this.state === "closed") return;
    await this.endpoint.connectDataChannel();
    const channel = new SecureChannel(
      this.endpoint,
      this.identity.transportPrivate(),
      this.identity.transportPub,
      this.peerTransportPub!,
    );
    this.state = "connected";
    this.onConnected({ match_id: this.matchId, counterparty_key: this.counterpartyKey, channel });
  }

  onChannelClosed(_reason: string): void {
    // The board's signaling channel is gone; the data channel is independent.
  }

  close(): void {
    this.state = "closed";
    this.endpoint.close();
  }
}
