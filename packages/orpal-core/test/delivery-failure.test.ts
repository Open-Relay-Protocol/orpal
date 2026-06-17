import { describe, it, expect, afterEach } from "vitest";
import {
  DeliveryTimeoutError,
  DeviceIdentity,
  InMemoryConversationStore,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  ReliableChannel,
  SecureChannel,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once, waitFor } from "./helpers/wait.js";

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

function client(opts: Partial<ConstructorParameters<typeof OrpalClient>[0]>, board: MockBoard, network: MockNetwork) {
  const c = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all"),
    ...opts,
  });
  return c;
}

describe("delivery failure handling", () => {
  it("marks a message failed when the contact is offline (no store-and-forward)", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ connectTimeoutMs: 200 }, board, network);
    live = [a];
    await a.start();

    // A target that never comes online: generate a key but never start a client for it.
    const absent = DeviceIdentity.generate().identityKeyB64;

    const failed = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "failed",
    );
    const id = await a.sendText(absent, "are you there?");
    const ev = await failed;
    expect(ev.id).toBe(id);

    const hist = await a.history(absent);
    expect(hist.find((m) => m.id === id)?.state).toBe("failed");
  });

  it("marks a message failed when no ACK returns within the timeout", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ ackTimeoutMs: 150 }, board, network);
    const b = client({ ackTimeoutMs: 150 }, board, network);
    live = [a, b];
    await a.start();
    await b.start();

    await a.connect(b.identityKey);
    await waitFor(() => a.contactState(b.identityKey) === "connected");

    // Tear B down so its ReliableChannel can no longer ACK; A still thinks it's
    // connected (MockWebRTC fires no state change), so the send goes out and times
    // out — exactly the DeliveryTimeoutError → "failed, retry?" path.
    b.close();

    const failed = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "failed",
    );
    const id = await a.sendText(b.identityKey, "still there?");
    const ev = await failed;
    expect(ev.id).toBe(id);
  });

  it("retrying a failed message delivers once the contact is reachable", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ connectTimeoutMs: 400 }, board, network);
    const b = client({ connectTimeoutMs: 400 }, board, network);
    live = [a, b];
    await a.start();
    // B is NOT online yet.

    const firstFailed = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "failed",
    );
    const id = await a.sendText(b.identityKey, "hello (will retry)");
    await firstFailed;

    // Bring B online and retry the SAME message.
    await b.start();
    const bGot = once(b.events, "message", (e) => e.message.text === "hello (will retry)");
    const delivered = once(
      a.events,
      "message-updated",
      (e) => e.id === id && e.message.state === "delivered",
    );
    await a.retryText(id, b.identityKey);

    expect((await bGot).message.text).toBe("hello (will retry)");
    await delivered;
  }, 10_000);

  it("ReliableChannel.send rejects with DeliveryTimeoutError when acks are dropped", async () => {
    // Direct unit check on the §11 layer: a SecureChannel whose peer never acks.
    const network = new MockNetwork();
    const ep = new MockWebRTC("solo", network, "all");
    await ep.connectDataChannel(); // registers, but there is no peer to ack
    const idA = DeviceIdentity.generate();
    const idB = DeviceIdentity.generate();
    const secure = new SecureChannel(
      ep,
      idA.transportPrivate(),
      idA.transportPub,
      idB.transportPub,
    );
    const rc = new ReliableChannel(secure, { ackTimeoutMs: 100 });

    await expect(rc.send("no one will ack this")).rejects.toBeInstanceOf(DeliveryTimeoutError);
    expect(rc.pendingCount()).toBe(0); // queue cleared on timeout
  });
});
