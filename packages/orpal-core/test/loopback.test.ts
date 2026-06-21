import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  InMemoryConversationStore,
  LOOPBACK_NAME,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";

// The loopback diagnostic contact (issue #41). A true message echo to one's OWN
// identity is impossible over the ORP secure channel (deriveDirectionalKeys splits
// send/recv keys by comparing the two transport keys, which collapses when both
// ends share one identity; and a board won't rendezvous a device with itself), so
// the self-test verifies the two locally-checkable halves of "is my setup
// working?": board reachability + an on-device seal/open crypto round-trip using
// this device's own keys.

function makeClient(): OrpalClient {
  return new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: new MockBoard(),
    webrtcFactory: (m) => new MockWebRTC(m, new MockNetwork(), "all"),
  });
}

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

describe("loopback test contact", () => {
  it("ensureLoopbackContact creates a self-derived, badged contact (idempotently)", async () => {
    const c = makeClient();
    live = [c];
    await c.start();

    const loop = await c.ensureLoopbackContact();
    expect(loop.isLoopback).toBe(true);
    expect(loop.displayName).toBe(LOOPBACK_NAME);
    expect(loop.identityKey).toBe(c.identityKey);

    const again = await c.ensureLoopbackContact();
    expect(again.identityKey).toBe(loop.identityKey);
    expect((await c.listContacts()).filter((x) => x.isLoopback)).toHaveLength(1);
  });

  it("self-test passes when the board is reachable and crypto round-trips", async () => {
    const c = makeClient();
    live = [c];
    await c.start();
    c.onBrokerOpen(); // simulate the board connection coming up

    const result = await c.runLoopbackSelfTest();
    expect(result).toEqual({ ok: true, boardReachable: true, cryptoRoundTrip: true, reason: undefined });

    // The self-test auto-creates the loopback contact on demand.
    expect((await c.listContacts()).some((x) => x.isLoopback)).toBe(true);
  });

  it("reports the board as unreachable while crypto still round-trips", async () => {
    const c = makeClient();
    live = [c];
    await c.start(); // no onBrokerOpen -> broker stays "connecting"

    const result = await c.runLoopbackSelfTest();
    expect(result.cryptoRoundTrip).toBe(true); // keys + sealing are fine offline
    expect(result.boardReachable).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("board-unreachable");
  });
});
