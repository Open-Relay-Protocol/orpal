import { describe, it, expect, afterEach } from "vitest";
import {
  BrowserRendezvousBroker,
  DeviceIdentity,
  InMemoryConversationStore,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  type WebRTCEndpoint,
} from "../src/index.js";
import { once } from "./helpers/wait.js";

// Integration test against a REAL running reference board.
//
//   (in the ORP repo)  npm run serve:dev      # ws://127.0.0.1:8080
//   ORP_BOARD_URL=ws://127.0.0.1:8080/ npx vitest run test/integration-board.test.ts
//
// It exercises the production signaling path end to end: the BrowserRendezvousBroker
// (native WebSocket) (de)serializing the SPEC §4.4 envelope to the actual board,
// the two-stage match, sealing, and the §11 ACK. The data channel itself uses the
// in-process MockNetwork (no real RTCPeerConnection in Node), so two clients in one
// process can complete the channel — the board interop is what's under test.

const BOARD_URL = process.env.ORP_BOARD_URL;
const run = BOARD_URL ? describe : describe.skip;

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

run("message round-trip + ACK against the live reference board", () => {
  it("delivers a text message through the real board", async () => {
    const network = new MockNetwork();
    const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");

    const mk = () =>
      new OrpalClient({
        identity: DeviceIdentity.generate(),
        store: new InMemoryConversationStore(),
        broker: new BrowserRendezvousBroker(BOARD_URL!, { maxReconnectAttempts: 0 }),
        webrtcFactory: factory,
      });

    const a = mk();
    const b = mk();
    live = [a, b];
    await a.start();
    await b.start();
    // Give presence a beat to register on the board.
    await new Promise((r) => setTimeout(r, 300));

    const received = once(b.events, "message", (e) => e.message.text === "over the real board");
    const delivered = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "delivered",
    );

    await a.sendText(b.identityKey, "over the real board");

    expect((await received).message.text).toBe("over the real board");
    await delivered;
  }, 20_000);
});
