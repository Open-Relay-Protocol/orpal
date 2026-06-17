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

describe("delivery failure handling (store-and-forward off)", () => {
  it("marks a message failed when the contact is offline and store-and-forward is off", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ connectTimeoutMs: 200, storeAndForward: false }, board, network);
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
    const a = client({ ackTimeoutMs: 150, storeAndForward: false }, board, network);
    const b = client({ ackTimeoutMs: 150, storeAndForward: false }, board, network);
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
    const a = client({ connectTimeoutMs: 400, storeAndForward: false }, board, network);
    const b = client({ connectTimeoutMs: 400, storeAndForward: false }, board, network);
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

describe("local store-and-forward (on by default)", () => {
  it("queues an offline message and auto-forwards it when the contact returns", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ connectTimeoutMs: 150, retryIntervalMs: 50 }, board, network);
    live = [a];
    await a.start();

    const b = client({ connectTimeoutMs: 150, retryIntervalMs: 50 }, board, network);
    // B is NOT online yet.

    // Offline send is queued locally (not failed).
    const queued = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "queued",
    );
    const id = await a.sendText(b.identityKey, "ping while you were away");
    await queued;
    expect((await a.history(b.identityKey)).find((m) => m.id === id)?.state).toBe("queued");

    // Bring B online — with NO manual retry, the outbox flushes itself and the
    // §11 ACK flips the message to delivered.
    live = [a, b];
    const bGot = once(b.events, "message", (e) => e.message.text === "ping while you were away");
    const delivered = once(
      a.events,
      "message-updated",
      (e) => e.id === id && e.message.state === "delivered",
    );
    await b.start();

    expect((await bGot).message.text).toBe("ping while you were away");
    await delivered;
    expect((await a.history(b.identityKey)).find((m) => m.id === id)?.state).toBe("delivered");
  }, 10_000);

  it("forwards queued messages in order and delivers each exactly once", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ connectTimeoutMs: 150, retryIntervalMs: 50 }, board, network);
    live = [a];
    await a.start();

    const b = client({ connectTimeoutMs: 150, retryIntervalMs: 50 }, board, network);

    // Queue three messages while B is offline.
    const ids: string[] = [];
    for (const text of ["one", "two", "three"]) {
      ids.push(await a.sendText(b.identityKey, text));
    }
    await waitFor(async () => {
      const hist = await a.history(b.identityKey);
      return ids.every((id) => hist.find((m) => m.id === id)?.state === "queued");
    });

    const received: string[] = [];
    b.events.on("message", (e) => {
      if (e.message.direction === "in" && e.message.text) received.push(e.message.text);
    });

    live = [a, b];
    await b.start();

    // All three delivered (ACK'd) on A.
    await waitFor(async () => {
      const hist = await a.history(b.identityKey);
      return ids.every((id) => hist.find((m) => m.id === id)?.state === "delivered");
    }, 8000);

    // Ordered, and no duplicates even though both the connect-flush and the retry
    // timer can fire (the outbox is emptied on ACK).
    expect(received).toEqual(["one", "two", "three"]);
  }, 10_000);

  it("rebuilds the outbox from persisted history on restart", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    // Share one store across two client instances to simulate a restart.
    const store = new InMemoryConversationStore();
    const identity = DeviceIdentity.generate();
    const mk = () =>
      new OrpalClient({
        identity,
        store,
        broker: board,
        webrtcFactory: (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all"),
        connectTimeoutMs: 150,
        retryIntervalMs: 50,
      });

    const a1 = mk();
    live = [a1];
    await a1.start();

    const b = client({ connectTimeoutMs: 150, retryIntervalMs: 50 }, board, network);

    // Add B as a known contact so the restart scan finds the conversation, then
    // queue a message while B is offline.
    await a1.addContactFromCard(b.ownContactCard("Bee"));
    // sendText already awaits the offline→queued transition, so just read it back.
    const id = await a1.sendText(b.identityKey, "survives a restart");
    expect((await a1.history(b.identityKey)).find((m) => m.id === id)?.state).toBe("queued");
    a1.close();

    // "Restart": a fresh client on the same store re-queues the message.
    const a2 = mk();
    live = [a2, b];
    await a2.start();

    const bGot = once(b.events, "message", (e) => e.message.text === "survives a restart");
    const delivered = once(
      a2.events,
      "message-updated",
      (e) => e.id === id && e.message.state === "delivered",
    );
    await b.start();

    expect((await bGot).message.text).toBe("survives a restart");
    await delivered;
  }, 10_000);
});
