// An in-memory mock rendezvous board for tests.
//
// This is NOT the AGPL reference board and does NOT reimplement any crypto,
// sealing, or ICE — it only does the routing the board is responsible for:
// match presence(B) ↔ intent(A) on identity keys, issue a match_id, and relay
// opaque blobs between the two matched participants (tearing the channel down on
// the answer relay). It's a faithful-enough stand-in for the §4.4 envelope so we
// can exercise the full Client + ReliableChannel flow deterministically.

import type {
  BoardConnection,
  FrameKind,
  Inbound,
  Outbound,
  RendezvousBroker,
} from "../../src/orp.js";

interface Conn {
  id: number;
  selfKey: string | null;
  onOutbound: (msg: Outbound) => void;
  closed: boolean;
}

interface Match {
  matchId: string;
  initiator: Conn;
  responder: Conn;
  offerSeen: boolean;
}

export class MockBoard implements RendezvousBroker {
  private nextConnId = 1;
  private nextMatchId = 1;
  private readonly conns = new Set<Conn>();
  private readonly presence = new Map<string, Conn>(); // self_key -> connection
  private readonly pendingIntents: { from: Conn; target: string }[] = [];
  private readonly matches = new Map<string, Match>();
  /** pairs (sorted "a|b") that already have a live channel — no second one. */
  private readonly livePairs = new Set<string>();

  connect(onOutbound: (msg: Outbound) => void): BoardConnection {
    const conn: Conn = { id: this.nextConnId++, selfKey: null, onOutbound, closed: false };
    this.conns.add(conn);
    return {
      send: (msg: Inbound) => this.handleInbound(conn, msg),
      close: () => this.handleClose(conn),
    };
  }

  /** Deliver board→client ASYNCHRONOUSLY, like a real WebSocket. This decouples
   *  the two peers' message handling: without it, an initiator's KEY frame
   *  (relayed synchronously during the same call that issued the match) would
   *  reach the responder before the responder had processed its own `match` and
   *  created a session — and be dropped. Microtask ordering is FIFO, so per-peer
   *  delivery order is preserved. */
  private deliver(conn: Conn, msg: Outbound): void {
    queueMicrotask(() => {
      if (!conn.closed) conn.onOutbound(msg);
    });
  }

  private handleInbound(conn: Conn, msg: Inbound): void {
    if (conn.closed) return;
    if (process.env.MB_DEBUG) {
      console.log("MB in", conn.id, msg.kind, msg.kind === "relay" ? msg.frame_kind : "");
    }
    switch (msg.kind) {
      case "presence": {
        conn.selfKey = msg.record.self_key;
        this.presence.set(msg.record.self_key, conn);
        this.deliver(conn, { kind: "ack", of: "presence" });
        // A presence arriving after an intent toward it should still match.
        this.flushIntentsTargeting(msg.record.self_key);
        break;
      }
      case "intent": {
        conn.selfKey = msg.record.self_key;
        this.deliver(conn, { kind: "ack", of: "intent" });
        const target = this.presence.get(msg.record.target_key);
        if (target && target !== conn) {
          this.tryMakeMatch(conn, msg.record.self_key, target, msg.record.target_key);
        } else {
          this.pendingIntents.push({ from: conn, target: msg.record.target_key });
        }
        break;
      }
      case "relay": {
        this.relay(conn, msg.match_id, msg.frame_kind, msg.blob);
        break;
      }
    }
  }

  private flushIntentsTargeting(selfKey: string): void {
    const target = this.presence.get(selfKey);
    if (!target) return;
    const remaining: { from: Conn; target: string }[] = [];
    for (const intent of this.pendingIntents) {
      if (intent.target === selfKey && !intent.from.closed && intent.from !== target) {
        this.tryMakeMatch(intent.from, intent.from.selfKey ?? "", target, selfKey);
      } else {
        remaining.push(intent);
      }
    }
    this.pendingIntents.length = 0;
    this.pendingIntents.push(...remaining);
  }

  private tryMakeMatch(
    initiator: Conn,
    initiatorKey: string,
    responder: Conn,
    responderKey: string,
  ): void {
    const pairKey = [initiatorKey, responderKey].sort().join("|");
    if (this.livePairs.has(pairKey)) return; // already a live channel for this pair
    const matchId = `m${this.nextMatchId++}`;
    this.matches.set(matchId, { matchId, initiator, responder, offerSeen: false });
    this.livePairs.add(pairKey);

    this.deliver(initiator, {
      kind: "match",
      match_id: matchId,
      role: "initiator",
      counterparty_key: responderKey,
    });
    this.deliver(responder, {
      kind: "match",
      match_id: matchId,
      role: "responder",
      counterparty_key: initiatorKey,
    });
  }

  private relay(from: Conn, matchId: string, frameKind: FrameKind, blob: string): void {
    const match = this.matches.get(matchId);
    if (!match) {
      this.deliver(from, { kind: "rejected", of: "relay", reason: "no-such-channel" });
      return;
    }
    if (from !== match.initiator && from !== match.responder) {
      this.deliver(from, { kind: "rejected", of: "relay", reason: "not-a-participant" });
      return;
    }
    const other = from === match.initiator ? match.responder : match.initiator;
    if (frameKind === "offer") match.offerSeen = true;
    this.deliver(other, { kind: "relay", match_id: matchId, frame_kind: frameKind, blob });

    // Teardown on the signaling-phase answer (only after an offer was relayed),
    // mirroring SPEC §7.
    if (frameKind === "answer" && match.offerSeen) {
      this.matches.delete(matchId);
      const pairKey = [match.initiator.selfKey ?? "", match.responder.selfKey ?? ""]
        .sort()
        .join("|");
      this.livePairs.delete(pairKey);
      this.deliver(match.initiator, { kind: "channel_closed", match_id: matchId, reason: "answered" });
      this.deliver(match.responder, { kind: "channel_closed", match_id: matchId, reason: "answered" });
    }
  }

  private handleClose(conn: Conn): void {
    conn.closed = true;
    this.conns.delete(conn);
    if (conn.selfKey && this.presence.get(conn.selfKey) === conn) {
      this.presence.delete(conn.selfKey);
    }
  }
}
