import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  DeliveryWorker,
  InMemoryConversationStore,
  InMemoryPendingQueueStore,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  computePendingMetrics,
  type PendingMessage,
  type PendingQueueStore,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once, waitFor } from "./helpers/wait.js";
import { link, linkIdentity } from "./helpers/link.js";

// Offline message persistence with acknowledgement-based delivery (issue #11).
//
// Covers the three acceptance-criteria behaviours called out in the issue:
//   1. a message to an offline recipient is saved durably and survives a reload,
//   2. the client retries (presence-based, then blind backoff) until the awk,
//   3. the awk removes the message from the pending queue and marks it delivered.

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

function client(
  opts: Partial<ConstructorParameters<typeof OrpalClient>[0]>,
  board: MockBoard,
  network: MockNetwork,
) {
  return new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all"),
    // Fast, tight backoff so the blind-retry path resolves quickly in tests.
    retryBackoff: { baseMs: 20, factor: 2, maxMs: 200, jitter: 0 },
    ...opts,
  });
}

describe("offline pending queue + awk delivery", () => {
  it("persists a message sent to an offline recipient and does not mark it failed", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const queue = new InMemoryPendingQueueStore();
    const a = client({ connectTimeoutMs: 150, pendingQueue: queue }, board, network);
    live = [a];
    await a.start();

    // An added-but-offline contact (its card is pinned so we can seal to it).
    const absentId = DeviceIdentity.generate();
    const absent = absentId.identityKeyB64;
    await linkIdentity(a, absentId);
    const id = await a.sendText(absent, "are you there?");

    // It lands in the durable pending queue (survives reload), not failed.
    await waitFor(async () => (await queue.get(id)) !== null);
    const pending = await queue.get(id);
    expect(pending?.recipientId).toBe(absent);
    expect(pending?.recipientTransportKey).toBe(absentId.transportKeyB64);
    expect(pending?.payload).toEqual({ kind: "text", text: "are you there?" });

    const hist = await a.history(absent);
    // Queued (never dispatched — the recipient is offline), not "sending" (#22).
    expect(hist.find((m) => m.id === id)?.state).toBe("queued");

    const metrics = await a.pendingMetrics();
    expect(metrics.total).toBe(1);
    expect(metrics.oldestPendingTs).toBe(pending?.timestamp);
  });

  it("retries until the recipient comes online, then delivers and clears the queue on awk", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const queue = new InMemoryPendingQueueStore();
    const a = client({ connectTimeoutMs: 150, pendingQueue: queue }, board, network);
    const b = client({ connectTimeoutMs: 150 }, board, network);
    live = [a, b];
    await a.start();
    await link(a, b); // pin B's transport key (B's card works before B starts)
    // B is NOT online yet — the first attempts fail and the message stays queued.

    const id = await a.sendText(b.identityKey, "hello (offline)");
    await waitFor(async () => {
      const p = await queue.get(id);
      return p !== null && p.attemptCount >= 1;
    });

    // Bring B online; presence-based delivery should drain the queue and B awks.
    const bGot = once(b.events, "message", (e) => e.message.text === "hello (offline)");
    const delivered = once(
      a.events,
      "message-updated",
      (e) => e.id === id && e.message.state === "delivered",
    );
    await b.start();

    expect((await bGot).message.text).toBe("hello (offline)");
    await delivered;

    // The awk removed it from the pending queue.
    await waitFor(async () => (await queue.get(id)) === null);
    expect(await queue.list()).toHaveLength(0);
    expect((await a.pendingMetrics()).total).toBe(0);

    // ...and exactly one copy was stored on the recipient despite the retries.
    const bHist = await b.history(a.identityKey);
    expect(bHist.filter((m) => m.text === "hello (offline)")).toHaveLength(1);
  }, 10_000);

  it("delivers immediately when the recipient is already online", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const queue = new InMemoryPendingQueueStore();
    const a = client({ pendingQueue: queue }, board, network);
    const b = client({}, board, network);
    live = [a, b];
    await a.start();
    await b.start();
    await link(a, b);

    const delivered = once(
      a.events,
      "message-updated",
      (e) => e.message.state === "delivered",
    );
    const id = await a.sendText(b.identityKey, "hi");
    await delivered;

    await waitFor(async () => (await queue.get(id)) === null);
    expect(await queue.list()).toHaveLength(0);
  });

  it("survives a reload: a restarted client resumes and delivers the persisted message", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    // A durable store SHARED across the two client instances simulates IndexedDB
    // persisting across a page reload / app restart.
    const queue = new InMemoryPendingQueueStore();

    const aId = DeviceIdentity.generate();
    const bId = DeviceIdentity.generate();

    // First "session": A queues a message while B is offline, then A is closed
    // (page closed) without ever delivering it.
    const a1 = new OrpalClient({
      identity: aId,
      store: new InMemoryConversationStore(),
      broker: board,
      webrtcFactory: (m: string): WebRTCEndpoint => new MockWebRTC(m, network, "all"),
      connectTimeoutMs: 150,
      retryBackoff: { baseMs: 20, factor: 2, maxMs: 200, jitter: 0 },
      pendingQueue: queue,
    });
    await a1.start();
    await linkIdentity(a1, bId); // pin B's transport key so the queued msg can be sealed
    const id = await a1.sendText(bId.identityKeyB64, "persisted across reload");
    await waitFor(async () => (await queue.get(id)) !== null);
    a1.close();
    expect(await queue.get(id)).not.toBeNull(); // still queued after "close"

    // Second "session": a fresh A (same identity, same durable queue) starts up
    // with B online — it must resume the persisted message and deliver it.
    const b = new OrpalClient({
      identity: bId,
      store: new InMemoryConversationStore(),
      broker: board,
      webrtcFactory: (m: string): WebRTCEndpoint => new MockWebRTC(m, network, "all"),
    });
    const a2 = new OrpalClient({
      identity: aId,
      store: new InMemoryConversationStore(),
      broker: board,
      webrtcFactory: (m: string): WebRTCEndpoint => new MockWebRTC(m, network, "all"),
      connectTimeoutMs: 150,
      retryBackoff: { baseMs: 20, factor: 2, maxMs: 200, jitter: 0 },
      pendingQueue: queue,
    });
    live = [a2, b];
    await b.start();

    const bGot = once(b.events, "message", (e) => e.message.text === "persisted across reload");
    await a2.start(); // resumes the queue

    expect((await bGot).message.text).toBe("persisted across reload");
    await waitFor(async () => (await queue.get(id)) === null);
  }, 10_000);
});

// Unit-level checks on the worker + queue primitives, independent of OrpalClient.
describe("DeliveryWorker retry/backoff", () => {
  const mkMsg = (overrides: Partial<PendingMessage> = {}): PendingMessage => ({
    recipientId: "peer",
    recipientTransportKey: "peer-transport-key",
    messageId: "m1",
    timestamp: 1000,
    attemptCount: 0,
    lastAttemptAt: null,
    payload: { kind: "text", text: "hi" },
    ...overrides,
  });

  it("retries with exponential backoff until acknowledged, then stops", async () => {
    const store: PendingQueueStore = new InMemoryPendingQueueStore();
    const attempts: number[] = [];
    let clock = 0;
    let nextId = 1;
    // A controllable fake timer that honours cancellation (so a cancelled backoff
    // never fires) and records the delay each retry was scheduled with.
    interface Timer {
      id: number;
      fireAt: number;
      delay: number;
      cb: () => void;
      active: boolean;
    }
    const timers: Timer[] = [];
    const scheduledDelays: number[] = [];

    const worker = new DeliveryWorker({
      store,
      attempt: async (m) => {
        attempts.push(m.attemptCount);
        return false; // never reachable ⇒ keep retrying
      },
      backoff: { baseMs: 100, factor: 2, maxMs: 10_000, jitter: 0 },
      now: () => clock,
      random: () => 0.5, // jitter is 0 anyway; pin it for determinism
      setTimer: (cb, ms) => {
        const t: Timer = { id: nextId++, fireAt: clock + ms, delay: ms, cb, active: true };
        timers.push(t);
        if (ms > 0) scheduledDelays.push(ms); // ignore the immediate (0ms) kicks
        return t.id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (h) => {
        const t = timers.find((x) => x.id === (h as unknown as number));
        if (t) t.active = false;
      },
    });

    await worker.start();
    await worker.enqueue(mkMsg()); // immediate attempt (attemptCount 0), then backoff

    // Fire the earliest still-active timer; drain microtasks so the attempt and
    // its follow-up scheduling settle.
    const fireNext = async () => {
      const t = timers
        .filter((x) => x.active)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!t) return;
      t.active = false;
      clock = t.fireAt;
      t.cb();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    for (let i = 0; i < 20; i++) await Promise.resolve(); // let the immediate attempt settle
    for (let round = 0; round < 3; round++) await fireNext();

    // attemptCount 0 (immediate) + three backoff rounds.
    expect(attempts).toEqual([0, 1, 2, 3]);
    // First retry waits baseMs, then doubles: 100, 200, 400.
    expect(scheduledDelays.slice(0, 3)).toEqual([100, 200, 400]);

    // An awk stops all further retries and clears the queue.
    const before = attempts.length;
    const removed = await worker.acknowledge("m1");
    expect(removed).toBe(true);
    expect(await store.list()).toHaveLength(0);
    await fireNext();
    expect(attempts.length).toBe(before); // no more attempts after the awk
    worker.stop();
  });

  it("computePendingMetrics reports total, oldest, attempts, and last attempt", () => {
    const rows: PendingMessage[] = [
      mkMsg({ messageId: "a", timestamp: 500, recipientId: "x", attemptCount: 2, lastAttemptAt: 1500 }),
      mkMsg({ messageId: "b", timestamp: 200, recipientId: "x", attemptCount: 1, lastAttemptAt: 1800 }),
      mkMsg({ messageId: "c", timestamp: 900, recipientId: "y", attemptCount: 5, lastAttemptAt: 1200 }),
    ];
    const m = computePendingMetrics(rows);
    expect(m.total).toBe(3);
    expect(m.oldestPendingTs).toBe(200);
    expect(m.byRecipient).toEqual({ x: 2, y: 1 });
    // Queue-health additions (issue #17): attempt totals + most-recent attempt.
    expect(m.totalAttempts).toBe(8);
    expect(m.maxAttempts).toBe(5);
    expect(m.lastAttemptAt).toBe(1800);

    const empty = computePendingMetrics([]);
    expect(empty.oldestPendingTs).toBeNull();
    expect(empty.lastAttemptAt).toBeNull();
    expect(empty.totalAttempts).toBe(0);
    expect(empty.maxAttempts).toBe(0);
  });
});
