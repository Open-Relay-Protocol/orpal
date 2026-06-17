import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  InMemoryConversationStore,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once, waitFor } from "./helpers/wait.js";

// The "Start by" milestone: a single text message round-trips with a working ACK
// between two clients, against an (in-memory) board.

function makePair() {
  const network = new MockNetwork();
  const board = new MockBoard();
  const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");

  const a = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: factory,
  });
  const b = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: factory,
  });
  return { a, b };
}

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

describe("text message round-trip with ACK", () => {
  it("delivers a message and marks it delivered once the ACK returns", async () => {
    const { a, b } = makePair();
    live = [a, b];
    await a.start();
    await b.start();

    const received = once(
      b.events,
      "message",
      (e) => e.message.direction === "in" && e.message.text === "hello there",
    );
    const deliveredP = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "delivered",
    );

    const id = await a.sendText(b.identityKey, "hello there");

    const got = await received;
    expect(got.message.text).toBe("hello there");
    expect(got.message.contactKey).toBe(a.identityKey);

    const delivered = await deliveredP;
    expect(delivered.id).toBe(id);

    // History on both sides reflects the exchange.
    const aHist = await a.history(b.identityKey);
    const bHist = await b.history(a.identityKey);
    expect(aHist.find((m) => m.id === id)?.state).toBe("delivered");
    expect(bHist.some((m) => m.text === "hello there" && m.direction === "in")).toBe(true);
  });

  it("works in both directions over the same established connection", async () => {
    const { a, b } = makePair();
    live = [a, b];
    await a.start();
    await b.start();

    // A → B establishes the connection.
    const bGotFirst = once(b.events, "message", (e) => e.message.text === "ping");
    await a.sendText(b.identityKey, "ping");
    await bGotFirst;

    // B → A reuses it (B now has a live channel to A).
    const aGotReply = once(a.events, "message", (e) => e.message.text === "pong");
    const replyDelivered = once(
      b.events,
      "message-updated",
      (e) => e.message.text === "pong" && e.message.state === "delivered",
    );
    await b.sendText(a.identityKey, "pong");

    expect((await aGotReply).message.text).toBe("pong");
    await replyDelivered;
  });

  it("reports the contact as connected after a successful rendezvous", async () => {
    const { a, b } = makePair();
    live = [a, b];
    await a.start();
    await b.start();

    await a.connect(b.identityKey);
    await waitFor(() => a.contactState(b.identityKey) === "connected");
    expect(a.contactState(b.identityKey)).toBe("connected");
  });
});
