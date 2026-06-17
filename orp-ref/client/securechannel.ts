// SPDX-License-Identifier: Apache-2.0
// Inner application-message layer over the WebRTC data channel.
//
// This wraps the data channel with the STATIC-KEY message encryption from
// core/messagelayer.ts. See that file's SECURITY NOTICE: there is no ratchet,
// so the message layer has NO forward secrecy (endpoint key compromise -> all
// recorded messages retroactively decryptable). DTLS underneath gives transit
// forward secrecy, but this layer does not. This is a deliberate, FINAL
// design decision (not a TODO): a ratchet would decouple the encryption
// target from the permanent identity-bound transport key this protocol's
// addressing model depends on (see core/messagelayer.ts and SPEC §9.3). The
// two layers are deliberately separate regardless: DTLS protects bytes on the
// wire; this layer protects message content end-to-end across the relay/TURN
// path, where DTLS terminates only at the two endpoints anyway.

import { deriveDirectionalKeys, encryptMessage, decryptMessage } from "../core/messagelayer.js";
import { fromUtf8, utf8 } from "../core/encoding.js";
import type { WebRTCEndpoint } from "./webrtc.js";

export class SecureChannel {
  private readonly sendKey: Uint8Array;
  private readonly recvKey: Uint8Array;

  constructor(
    private readonly endpoint: WebRTCEndpoint,
    myTransportPriv: Uint8Array,
    myTransportPub: Uint8Array,
    theirTransportPub: Uint8Array,
  ) {
    // STATIC, direction-separated keys — derived once, reused for the whole
    // conversation. No ratchet, no forward secrecy, by deliberate final
    // design decision (see core/messagelayer.ts).
    const keys = deriveDirectionalKeys(myTransportPriv, theirTransportPub, myTransportPub);
    this.sendKey = keys.sendKey;
    this.recvKey = keys.recvKey;
  }

  onMessage(cb: (text: string) => void): void {
    this.endpoint.onData((framed) => {
      const pt = decryptMessage(this.recvKey, framed); // throws on tamper/wrong key
      cb(fromUtf8(pt));
    });
  }

  send(text: string): void {
    this.endpoint.sendData(encryptMessage(this.sendKey, utf8(text)));
  }
}
