import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  InMemoryConversationStore,
  type WebRTCEndpoint,
} from "../src/index.js";
import type {
  BoardConnection,
  Inbound,
  Outbound,
  RendezvousBroker,
} from "../src/orp.js";
import { MockBoard } from "./helpers/mock-board.js";
import { verifyAnnounce } from "../vendor/orp/core/wire.js";
import { waitFor } from "./helpers/wait.js";

// ORPAL-016 / ORP-009: the opt-in platform push token rides the SIGNED presence
// beacon so the board can wake an offline device on a channel timeout. These
// tests pin the wire contract: the token appears only when opted in, an opted-out
// presence is byte-for-byte identical to pre-ORP-009 (no `push_token` key at all),
// and a token-bearing presence still passes the board's gate (schema +
// signature). They also pin the runtime toggle via setPushToken().

/** A broker that wraps another and records every `presence` record it sends. */
class PresenceSpyBroker implements RendezvousBroker {
  readonly presences: { self_key: string; push_token?: string; signature: string }[] = [];
  constructor(private readonly inner: RendezvousBroker) {}
  connect(onOutbound: (msg: Outbound) => void): BoardConnection {
    const conn = this.inner.connect(onOutbound);
    return {
      send: (msg: Inbound) => {
        if (msg.kind === "presence") this.presences.push(msg.record as never);
        conn.send(msg);
      },
      close: () => conn.close(),
    };
  }
}

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

function makeClient(broker: RendezvousBroker, pushToken?: string): OrpalClient {
  const network = new MockNetwork();
  const c = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker,
    webrtcFactory: (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all"),
    pushToken,
  });
  live.push(c);
  return c;
}

describe("ORPAL-016 push token in presence", () => {
  it("omits push_token entirely when push is disabled (default)", async () => {
    const spy = new PresenceSpyBroker(new MockBoard());
    const c = makeClient(spy);
    await c.start();
    await waitFor(() => spy.presences.length >= 1);

    const p = spy.presences[0];
    expect("push_token" in p).toBe(false); // not present, not `undefined`
    expect(c.pushToken).toBeUndefined();
    // Still a valid presence by the board's gate (schema + signature).
    expect(verifyAnnounce(p)).toEqual({ valid: true, kind: "presence" });
  });

  it("includes the token in the signed presence when opted in at construction", async () => {
    const spy = new PresenceSpyBroker(new MockBoard());
    const c = makeClient(spy, "fcm-token-abc");
    await c.start();
    await waitFor(() => spy.presences.length >= 1);

    const p = spy.presences[0];
    expect(p.push_token).toBe("fcm-token-abc");
    expect(c.pushToken).toBe("fcm-token-abc");
    // The token is covered by the signature: tampering with it fails the gate.
    expect(verifyAnnounce(p)).toEqual({ valid: true, kind: "presence" });
    expect(verifyAnnounce({ ...p, push_token: "tampered" }).valid).toBe(false);
  });

  it("setPushToken() opts in and out at runtime and re-announces immediately", async () => {
    const spy = new PresenceSpyBroker(new MockBoard());
    const c = makeClient(spy);
    await c.start();
    await waitFor(() => spy.presences.length >= 1);
    const before = spy.presences.length;

    // Opt in -> re-announces now with the token.
    c.setPushToken("apns-token-xyz");
    await waitFor(() => spy.presences.length > before);
    const opted = spy.presences[spy.presences.length - 1];
    expect(opted.push_token).toBe("apns-token-xyz");
    expect(verifyAnnounce(opted)).toEqual({ valid: true, kind: "presence" });

    // Opt back out -> next beacon drops the key again.
    const mark = spy.presences.length;
    c.setPushToken(undefined);
    await waitFor(() => spy.presences.length > mark);
    const off = spy.presences[spy.presences.length - 1];
    expect("push_token" in off).toBe(false);
    expect(c.pushToken).toBeUndefined();
  });

  it("setPushToken() is a no-op when the value is unchanged", async () => {
    const spy = new PresenceSpyBroker(new MockBoard());
    const c = makeClient(spy, "same-token");
    await c.start();
    await waitFor(() => spy.presences.length >= 1);
    const count = spy.presences.length;

    c.setPushToken("same-token"); // unchanged -> must NOT re-announce
    await Promise.resolve();
    expect(spy.presences.length).toBe(count);
  });
});
