// Browser/WebView WebRTCEndpoint, backed by the platform's native
// RTCPeerConnection.
//
// The ORP reference ships only MockWebRTC (in-memory, zero crypto, for tests) and
// RealWebRTC (werift, Node). This is the third implementation the spec calls for:
// a real ICE + DTLS + SCTP data channel using the RTCPeerConnection the Electron
// renderer / Capacitor WebView already provides. It conforms to the reference's
// `WebRTCEndpoint` interface unchanged, so the reference Client drives it with no
// modification — swapping the factory is the whole integration.
//
// SECURITY POSITION (unchanged from the protocol):
//   * This endpoint gathers and returns ALL candidates verbatim. The privacy
//     controls run in the reference Client BEFORE anything is sealed/sent:
//     filterCandidates + filterSdp + assertNoUnobfuscatedHost (control b), then
//     seal to the peer's X25519 key (control a). We deliberately do NOT filter
//     here — doing so would split that responsibility and risk it drifting.
//   * Two devices behind NAT need a STUN server to produce an `srflx` candidate
//     (raw `host` IPs are dropped by control b), or a TURN server for `relay`.
//     `iceTransportPolicy: "relay"` is the SPEC §6 relay-only mode for
//     privacy-sensitive contacts: only TURN-relayed candidates are gathered, so
//     the peer never learns this device's IP at all (requires a configured TURN).

import type { LocalDescription, WebRTCEndpoint, IceTransportPolicy } from "../orp.js";

export type RtcConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface BrowserWebRTCOptions {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: IceTransportPolicy;
  /** How long to wait for ICE gathering to report "complete" before sending what
   *  we have. Some environments never fire "complete"; this bounds the wait.
   *  Default 4000ms. */
  iceGatheringTimeoutMs?: number;
  /** Notified on every aggregate connection-state change. OrpalClient uses this
   *  to mark contacts online/offline and re-initiate rendezvous on drops — the
   *  reference Client interface itself surfaces no such event. */
  onConnectionStateChange?: (state: RtcConnectionState) => void;
  /** Label for the data channel (cosmetic; both peers negotiate one channel). */
  dataChannelLabel?: string;
}

export class BrowserWebRTCEndpoint implements WebRTCEndpoint {
  private readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private dataCb: ((bytes: Uint8Array) => void) | null = null;
  private readonly channelOpen: Promise<void>;
  private resolveChannelOpen!: () => void;
  private rejectChannelOpen!: (err: Error) => void;
  private gathered: string[] = [];
  private closed = false;

  constructor(
    _matchId: string,
    private readonly role: "initiator" | "responder",
    private readonly options: BrowserWebRTCOptions = {},
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers ?? [],
      iceTransportPolicy: options.iceTransportPolicy ?? "all",
    });
    this.channelOpen = new Promise<void>((resolve, reject) => {
      this.resolveChannelOpen = resolve;
      this.rejectChannelOpen = reject;
    });

    // The responder receives its data channel from the remote side; the
    // initiator creates one in createLocalDescription("offer"). Both funnel
    // through wireChannel().
    this.pc.ondatachannel = (ev: RTCDataChannelEvent) => {
      if (this.role === "responder") this.wireChannel(ev.channel);
    };

    this.pc.onconnectionstatechange = () => {
      this.options.onConnectionStateChange?.(this.pc.connectionState as RtcConnectionState);
      if (this.pc.connectionState === "failed") {
        this.rejectChannelOpen(new Error("BrowserWebRTC: connection failed"));
      }
    };
  }

  private wireChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.resolveChannelOpen();
    channel.onclose = () =>
      this.options.onConnectionStateChange?.(this.closed ? "closed" : "disconnected");
    channel.onerror = () =>
      this.options.onConnectionStateChange?.("failed");
    channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      let bytes: Uint8Array;
      if (typeof data === "string") bytes = new TextEncoder().encode(data);
      else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      } else return; // Blob etc. — not used by this protocol
      this.dataCb?.(bytes);
    };
    if (channel.readyState === "open") this.resolveChannelOpen();
  }

  async createLocalDescription(
    type: "offer" | "answer",
    _remoteSdp?: string,
  ): Promise<LocalDescription> {
    this.gathered = [];
    if (type === "offer") {
      this.wireChannel(
        this.pc.createDataChannel(this.options.dataChannelLabel ?? "orpal"),
      );
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
    } else {
      // applyRemoteDescription(offer) has already run for the responder.
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
    }
    await this.waitForGatheringComplete();
    const local = this.pc.localDescription;
    if (!local) throw new Error("BrowserWebRTC: no localDescription after setLocalDescription");
    // Return BOTH the sdp (which may inline a=candidate lines) and the separately
    // gathered candidate values; the Client filters both before sealing.
    return { sdp: local.sdp, candidates: this.gathered };
  }

  async applyRemoteDescription(sdp: string, candidates: string[]): Promise<void> {
    // Exactly one remote description per endpoint lifetime: the offer if we're
    // the responder, the answer if we're the initiator (SPEC §5).
    const type: RTCSdpType = this.role === "initiator" ? "answer" : "offer";
    await this.pc.setRemoteDescription({ type, sdp });
    for (const c of candidates) {
      if (!c) continue;
      try {
        await this.pc.addIceCandidate({ candidate: c, sdpMLineIndex: 0 });
      } catch {
        // A candidate scrubbed by control (b) (e.g. raddr → 0.0.0.0) or otherwise
        // unparseable is skipped — connectivity only needs one working pair.
      }
    }
  }

  connectDataChannel(): Promise<void> {
    return this.channelOpen;
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  sendData(bytes: Uint8Array): void {
    if (!this.channel) throw new Error("BrowserWebRTC: sendData before the data channel exists");
    // RTCDataChannel.send accepts an ArrayBufferView at runtime; the cast sidesteps
    // the TS 5.7 typed-array `ArrayBufferLike` generic vs `ArrayBuffer` mismatch.
    this.channel.send(bytes as unknown as ArrayBuffer);
  }

  /** Current data-channel send-buffer depth — used for optional flow control on
   *  top of the ACK-gated backpressure in the file-transfer layer. */
  bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  close(): void {
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }

  // ---- ICE gathering --------------------------------------------------------

  private waitForGatheringComplete(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, this.options.iceGatheringTimeoutMs ?? 4000);

      this.pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
        if (ev.candidate && ev.candidate.candidate) {
          this.gathered.push(ev.candidate.candidate);
        } else {
          // null candidate => gathering complete
          finish();
        }
      };
      this.pc.onicegatheringstatechange = () => {
        if (this.pc.iceGatheringState === "complete") finish();
      };
    });
  }
}
