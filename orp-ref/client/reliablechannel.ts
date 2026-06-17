// SPDX-License-Identifier: Apache-2.0
//
// ReliableChannel: the stateful half of the delivery ACK layer (see
// core/deliverylayer.ts for the wire format/crypto, SPEC.md §11 for the
// normative spec). Wraps a SecureChannel — does not modify it — adding:
//
//   - a per-message one-time ACK keypair (core/deliverylayer.ts)
//   - a LOCAL PENDING QUEUE of outbound messages, keyed by message_id
//   - automatic ACK generation on receipt (decrypt -> deliver -> ack back)
//   - the queue entry is removed ONLY on a validated ACK, or on timeout
//     (which reports failure but does NOT retry — see SPEC §11.4)
//
// This is exactly the lifecycle from the original design: "sender clears
// local pending queue only after ACK."

import {
  generateOneTimeAckKey,
  newMessageId,
  buildMessageFrame,
  buildAckFrame,
  parseDeliveryFrame,
  verifyAck,
  type OneTimeAckKey,
} from "../core/deliverylayer.js";
import { Clock, RealClock, TimerId } from "../core/clock.js";
import type { SecureChannel } from "./securechannel.js";

export interface ReliableChannelOptions {
  /** How long to wait for an ACK before reporting delivery failure. Default 30s. */
  ackTimeoutMs?: number;
  /** Injectable clock for deterministic tests; defaults to a real one. */
  clock?: Clock;
  now?: () => string;
}

export interface PendingInfo {
  messageId: string;
  body: string;
  sentAt: number;
}

interface PendingEntry {
  messageId: string;
  body: string;
  ackKey: OneTimeAckKey;
  sentAt: number;
  timer: TimerId;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Thrown when send()'s returned promise rejects because no ACK arrived in time. */
export class DeliveryTimeoutError extends Error {
  constructor(public readonly messageId: string) {
    super(`ReliableChannel: no ACK received for message ${messageId} within the timeout`);
  }
}

export class ReliableChannel {
  private readonly ackTimeoutMs: number;
  private readonly clock: Clock;
  private readonly now: () => string;
  private pendingMap = new Map<string, PendingEntry>();
  private messageCb: ((text: string) => void) | null = null;

  constructor(
    private readonly channel: SecureChannel,
    options: ReliableChannelOptions = {},
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
    this.clock = options.clock ?? new RealClock();
    this.now = options.now ?? (() => new Date().toISOString());
    this.channel.onMessage((text) => this.onRawMessage(text));
  }

  /** Register the handler for incoming application messages (after this
   *  layer has already auto-sent the ACK for them). */
  onMessage(cb: (text: string) => void): void {
    this.messageCb = cb;
  }

  /**
   * Send `body`. Returns a promise that resolves once a valid ACK is
   * received, and rejects with DeliveryTimeoutError if none arrives within
   * `ackTimeoutMs`. The message stays in the local pending queue — visible
   * via pending()/pendingCount() — until one of those two outcomes, exactly
   * matching "sender clears local pending queue only after ACK". There is
   * NO automatic retry on timeout; that policy decision is left to the
   * caller (see SPEC §11.4).
   */
  send(body: string): Promise<void> {
    const messageId = newMessageId();
    const ackKey = generateOneTimeAckKey();
    const frame = buildMessageFrame(messageId, ackKey, body);

    return new Promise<void>((resolve, reject) => {
      const timer = this.clock.setTimer(this.ackTimeoutMs, () => {
        if (!this.pendingMap.delete(messageId)) return; // already acked/cleared
        reject(new DeliveryTimeoutError(messageId));
      });
      this.pendingMap.set(messageId, {
        messageId,
        body,
        ackKey,
        sentAt: this.clock.now(),
        timer,
        resolve,
        reject,
      });
      this.channel.send(frame);
    });
  }

  /** Messages sent but not yet acknowledged or timed out. */
  pending(): PendingInfo[] {
    return [...this.pendingMap.values()].map(({ messageId, body, sentAt }) => ({ messageId, body, sentAt }));
  }

  pendingCount(): number {
    return this.pendingMap.size;
  }

  private onRawMessage(text: string): void {
    const frame = parseDeliveryFrame(text);
    if (!frame) return; // malformed/unrecognized — drop, don't crash the channel

    if (frame.type === "msg") {
      this.messageCb?.(frame.body);
      // Auto-ack: seal a receipt to the sender's one-time key and send it
      // straight back over the same already-authenticated channel.
      try {
        const ackPub = Uint8Array.from(Buffer.from(frame.ack_pubkey, "base64url"));
        this.channel.send(buildAckFrame(frame.message_id, ackPub, this.now));
      } catch {
        // A malformed ack_pubkey shouldn't prevent delivering the message to
        // the application; it just means our ack back never reaches them.
      }
      return;
    }

    // type === "ack"
    const entry = this.pendingMap.get(frame.message_id);
    if (!entry) return; // unknown/duplicate/stale ack — ignore, not an error
    try {
      verifyAck(frame, entry.ackKey); // throws on wrong key / tampered / mismatched id
    } catch {
      // A forged or corrupted ack does NOT clear the queue — the message
      // stays pending and may still time out normally.
      return;
    }
    this.clock.clearTimer(entry.timer);
    this.pendingMap.delete(frame.message_id);
    entry.resolve();
  }
}
