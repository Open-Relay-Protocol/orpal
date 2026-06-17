// SPDX-License-Identifier: Apache-2.0
//
// The board<->client transport envelope AND the broker interface a client codes
// against. This lives in core/ (Apache-2.0) — not in board/ (AGPL-3.0) — because
// it is part of the open PROTOCOL: anyone may implement a conforming board or a
// conforming client from these types without inheriting the reference board's
// copyleft. The reference Board implements RendezvousBroker; a client depends
// only on the interface, never on the board implementation.
//
// What the board can read here vs. what stays opaque:
//
//   READS (routing metadata, all public, none secret):
//     - presence / intent records (must, to match + verify signatures)
//     - match_id            (ephemeral routing handle)
//     - frame_kind          (key|offer|answer — needed for the teardown rule)
//     - the sender's identity_key (to route notifications)
//
//   NEVER READS (opaque):
//     - `blob` on a relay — the entire signed match_offer/answer frame, whose
//       signaling payload is sealed to the recipient's X25519 key. The board
//       forwards these bytes verbatim and does not parse them.

import type { Intent, Presence } from "./wire.js";

export type FrameKind = "key" | "offer" | "answer";

/** client -> board */
export type Inbound =
  | { kind: "presence"; record: Presence }
  | { kind: "intent"; record: Intent }
  | { kind: "relay"; match_id: string; frame_kind: FrameKind; blob: string };

/** board -> client */
export type Outbound =
  | { kind: "ack"; of: "presence" | "intent" }
  | { kind: "rejected"; of: "presence" | "intent" | "relay"; reason: string }
  | { kind: "evicted"; reason: string }
  | { kind: "match"; match_id: string; role: "initiator" | "responder"; counterparty_key: string }
  | { kind: "relay"; match_id: string; frame_kind: FrameKind; blob: string }
  | { kind: "channel_closed"; match_id: string; reason: string };

/** A wiretap observer: receives EVERYTHING crossing the board boundary, in both
 *  directions. The production board passes no observer and logs nothing; tests
 *  pass one to model an adversary with "full logs of everything the board
 *  routed", then assert no secret is recoverable from it. */
export type Observer = (event: {
  dir: "in" | "out";
  connId: number;
  identity_key?: string;
  msg: Inbound | Outbound;
}) => void;

/** A live connection to a rendezvous broker. The client codes against this, not
 *  against any concrete board class. */
export interface BoardConnection {
  identityKey?: string;
  /** client -> board */
  send(msg: Inbound): void;
  /** tear down this connection */
  close(): void;
}

/** A rendezvous broker (the "bulletin board"). A client only needs this much of
 *  it; the reference Board implements it, but so could any conforming server. */
export interface RendezvousBroker {
  connect(onOutbound: (msg: Outbound) => void): BoardConnection;
}
