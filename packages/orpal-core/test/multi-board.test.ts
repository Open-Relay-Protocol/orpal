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
import { once } from "./helpers/wait.js";
import { linkBoth } from "./helpers/link.js";

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

describe("multiple boards", () => {
  it("reaches a contact that is only on the second board", async () => {
    const board1 = new MockBoard();
    const board2 = new MockBoard();
    const network = new MockNetwork();
    const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");

    // A federates over BOTH boards.
    const a = new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      boards: [
        { id: "b1", broker: board1 },
        { id: "b2", broker: board2 },
      ],
      webrtcFactory: factory,
    });
    // B is only present on board2.
    const b = new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      boards: [{ id: "b2", broker: board2 }],
      webrtcFactory: factory,
    });
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const got = once(b.events, "message", (e) => e.message.text === "hi via board2");
    const delivered = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "delivered",
    );

    await a.sendText(b.identityKey, "hi via board2");

    expect((await got).message.text).toBe("hi via board2");
    await delivered;
    expect(a.contactState(b.identityKey)).toBe("connected");
  });

  it("aggregate broker state is open when at least one board is open", async () => {
    const board1 = new MockBoard();
    const board2 = new MockBoard();
    const a = new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      boards: [
        { id: "b1", broker: board1 },
        { id: "b2", broker: board2 },
      ],
    });
    live = [a];
    await a.start();

    a.onBrokerOpen("b1");
    expect(a.brokerStatus).toBe("open");
    a.onBrokerError("b2", "boom");
    expect(a.brokerStatus).toBe("open"); // b1 still up
    a.onBrokerClose("b1");
    expect(a.brokerStatus).toBe("error"); // none open; b2 errored
  });
});
