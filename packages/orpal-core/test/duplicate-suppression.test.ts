import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  InMemoryConversationStore,
  InMemoryPendingQueueStore,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once } from "./helpers/wait.js";
import { link, linkBoth, linkIdentity } from "./helpers/link.js";

// Duplicate message suppression (issue #18): retries re-deliver the same message
// id, so the recipient must store it exactly once (idempotent) while still
// re-acknowledging, and ids must be globally unique so dedup is reliable.

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

function client(opts: Partial<ConstructorParameters<typeof OrpalClient>[0]>, board: MockBoard, network: MockNetwork) {
  return new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all"),
    ...opts,
  });
}

describe("duplicate message suppression", () => {
  it("stores a re-delivered message exactly once but re-acknowledges it", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({}, board, network);
    const b = client({}, board, network);
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const bGot = once(b.events, "message", (e) => e.message.text === "only once");
    const acked1 = once(a.events, "message-updated", (e) => e.message.state === "acknowledged");
    const id = await a.sendText(b.identityKey, "only once");
    await bGot;
    await acked1;

    // Re-deliver the EXACT same id (simulates a retry after a lost awk).
    const acked2 = once(
      a.events,
      "message-updated",
      (e) => e.id === id && e.message.state === "acknowledged",
    );
    await a.retryText(id, b.identityKey);
    await acked2; // B re-awked, proving it processed the duplicate...

    // ...but it stored the message only once.
    const bHist = await b.history(a.identityKey);
    expect(bHist.filter((m) => m.text === "only once")).toHaveLength(1);
  });

  it("generates globally-unique message ids", async () => {
    const board = new MockBoard();
    const network = new MockNetwork();
    const queue = new InMemoryPendingQueueStore();
    const a = client({ connectTimeoutMs: 50, pendingQueue: queue, retryBackoff: { baseMs: 10_000 } }, board, network);
    live = [a];
    await a.start();

    // An added-but-offline recipient: sends just queue (returning their id) without
    // needing a live peer, so we can mint many ids cheaply.
    const absent = DeviceIdentity.generate();
    await linkIdentity(a, absent);

    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(await a.sendText(absent.identityKeyB64, `m${i}`));
    expect(ids.size).toBe(200);
  });

  it("updates the existing message in place rather than appending on retry", async () => {
    // The sender keeps ONE history row per logical message across retries (the id
    // is stable), so the UI updates state in place instead of duplicating.
    const board = new MockBoard();
    const network = new MockNetwork();
    const a = client({ connectTimeoutMs: 80 }, board, network);
    const b = client({ connectTimeoutMs: 80 }, board, network);
    live = [a, b];
    await a.start();
    await link(a, b); // b offline at first

    const firstFailed = once(a.events, "message-updated", (e) => e.message.state === "failed");
    const id = await a.sendText(b.identityKey, "retry me");
    await firstFailed;

    await b.start();
    const delivered = once(a.events, "message-updated", (e) => e.id === id && e.message.state === "delivered");
    await a.retryText(id, b.identityKey);
    await delivered;

    const aHist = await a.history(b.identityKey);
    expect(aHist.filter((m) => m.id === id)).toHaveLength(1);
  }, 10_000);
});
