import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  InMemoryConversationStore,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once, waitFor } from "./helpers/wait.js";

// Per-contact board lists (issue #19): a contact can carry its own board routes,
// and delivery attempts then use ONLY those boards instead of fanning out to all.

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

/** A federates over boards b1+b2; B lives only on b2. Returns both clients. */
function topology(opts: Partial<ConstructorParameters<typeof OrpalClient>[0]> = {}) {
  const board1 = new MockBoard();
  const board2 = new MockBoard();
  const network = new MockNetwork();
  const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");
  const a = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    boards: [
      { id: "b1", broker: board1 },
      { id: "b2", broker: board2 },
    ],
    webrtcFactory: factory,
    ...opts,
  });
  const b = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    boards: [{ id: "b2", broker: board2 }],
    webrtcFactory: factory,
  });
  return { a, b };
}

describe("per-contact board routing", () => {
  it("delivers over the contact's configured board", async () => {
    const { a, b } = topology();
    live = [a, b];
    await a.start();
    await b.start();
    await a.addContactFromCard(b.ownContactCard(), { preferredBoards: ["b2"] });

    const got = once(b.events, "message", (e) => e.message.text === "routed");
    const acked = once(a.events, "message-updated", (e) => e.message.state === "acknowledged");
    await a.sendText(b.identityKey, "routed");

    expect((await got).message.text).toBe("routed");
    await acked;
  });

  it("uses ONLY configured boards — a contact pinned to the wrong board is unreachable", async () => {
    // A pins B to b1, but B actually lives on b2. Because delivery only uses the
    // configured board, A never announces to b2 and the message can't be delivered.
    const { a, b } = topology({ connectTimeoutMs: 200 });
    live = [a, b];
    await a.start();
    await b.start();
    await a.addContactFromCard(b.ownContactCard(), { preferredBoards: ["b1"] });

    const failed = once(a.events, "message-updated", (e) => e.message.state === "failed");
    const id = await a.sendText(b.identityKey, "wrong board");
    await failed;

    expect((await a.history(b.identityKey)).find((m) => m.id === id)?.state).toBe("failed");
    expect(await b.history(a.identityKey)).toHaveLength(0); // B never saw it
  });

  it("setContactBoards reroutes a contact to a reachable board", async () => {
    const { a, b } = topology({ connectTimeoutMs: 200 });
    live = [a, b];
    await a.start();
    await b.start();
    await a.addContactFromCard(b.ownContactCard(), { preferredBoards: ["b1"] }); // unreachable

    // First attempt over the wrong board can't reach B.
    const failed = once(a.events, "message-updated", (e) => e.message.state === "failed");
    await a.sendText(b.identityKey, "first try");
    await failed;

    // Reroute to b2 (where B lives) and resend — now it gets through.
    await a.setContactBoards(b.identityKey, { preferredBoards: ["b2"] });
    const got = once(b.events, "message", (e) => e.message.text === "after reroute");
    const acked = once(a.events, "message-updated", (e) => e.message.state === "acknowledged");
    await a.sendText(b.identityKey, "after reroute");

    expect((await got).message.text).toBe("after reroute");
    await acked;
  });

  it("falls back to ALL boards when a contact has no configured routes", async () => {
    const { a, b } = topology();
    live = [a, b];
    await a.start();
    await b.start();
    // No preferred/fallback boards → global fan-out, so b2 is still reached.
    await a.addContactFromCard(b.ownContactCard());

    const got = once(b.events, "message", (e) => e.message.text === "global");
    await a.sendText(b.identityKey, "global");
    expect((await got).message.text).toBe("global");
    await waitFor(() => a.contactState(b.identityKey) === "connected");
  });
});
