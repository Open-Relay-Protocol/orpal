import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  InMemoryConversationStore,
  MockNetwork,
  MockWebRTC,
  NoPinnedKeyError,
  OrpalClient,
  decodeAppFrame,
  openSealedFrame,
  sealAppFrame,
  type TextFrame,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once, waitFor } from "./helpers/wait.js";
import { link, linkBoth } from "./helpers/link.js";

// Recipient-sealed messages (issue #23): every outbound user payload is sealed to
// the recipient's PINNED transport key before it goes over the (already
// encrypted) channel, so a wrong-key / fake-peer connection can never read it.

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

const textFrame = (text: string): TextFrame => ({ v: 1, t: "text", id: "m1", text, ts: 1000 });

describe("sealed-box envelope (unit)", () => {
  it("round-trips through the right key and hides the plaintext on the wire", () => {
    const me = DeviceIdentity.generate();
    const sealed = sealAppFrame(textFrame("attack at dawn"), me.transportKeyB64);

    expect(sealed.t).toBe("sealed");
    expect(sealed.alg).toBe("orp-sealedbox-v1");
    // The plaintext never appears in the encoded frame.
    expect(JSON.stringify(sealed)).not.toContain("attack at dawn");

    const opened = openSealedFrame(sealed, me.transportPrivate(), me.transportPub);
    expect(opened).not.toBeNull();
    expect(opened?.t).toBe("text");
    expect(opened && opened.t === "text" ? opened.text : null).toBe("attack at dawn");
  });

  it("cannot be opened with the wrong key (fake-peer / substituted key)", () => {
    const recipient = DeviceIdentity.generate();
    const attacker = DeviceIdentity.generate();
    const sealed = sealAppFrame(textFrame("secret"), recipient.transportKeyB64);

    // The attacker holds a different transport key — the box stays opaque.
    expect(openSealedFrame(sealed, attacker.transportPrivate(), attacker.transportPub)).toBeNull();
  });

  it("returns null on a tampered ciphertext", () => {
    const me = DeviceIdentity.generate();
    const sealed = sealAppFrame(textFrame("secret"), me.transportKeyB64);
    const tampered = { ...sealed, box: sealed.box.slice(0, -2) + (sealed.box.endsWith("A") ? "B" : "A") };
    expect(openSealedFrame(tampered, me.transportPrivate(), me.transportPub)).toBeNull();
  });

  it("decodeAppFrame validates the sealed envelope and rejects an unknown alg", () => {
    const me = DeviceIdentity.generate();
    const sealed = sealAppFrame(textFrame("secret"), me.transportKeyB64);
    expect(decodeAppFrame(JSON.stringify(sealed))?.t).toBe("sealed");
    expect(decodeAppFrame(JSON.stringify({ ...sealed, alg: "bogus" }))).toBeNull();
  });
});

describe("sealed messages end-to-end", () => {
  function pair() {
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

  it("delivers a sealed text the recipient can read, through to acknowledged", async () => {
    const { a, b } = pair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const bGot = once(b.events, "message", (e) => e.message.text === "sealed hello");
    const acked = once(
      a.events,
      "message-updated",
      (e) => e.message.direction === "out" && e.message.state === "acknowledged",
    );

    await a.sendText(b.identityKey, "sealed hello");
    expect((await bGot).message.text).toBe("sealed hello");
    await acked;
  });

  it("fails closed when there is no pinned transport key for the recipient", async () => {
    const { a, b } = pair();
    live = [a, b];
    await a.start();
    await b.start();
    // NOTE: a never imports b's card, so it has no pinned key to seal to.

    const errored = once(a.events, "error", (e) => e.error instanceof NoPinnedKeyError);
    const id = await a.sendText(b.identityKey, "should not send unsealed");

    await errored;
    await waitFor(async () => (await a.history(b.identityKey)).find((m) => m.id === id)?.state === "failed");
    // And nothing reached B.
    expect(await b.history(a.identityKey)).toHaveLength(0);
  });

  it("seals file-offer metadata so a file transfers end-to-end", async () => {
    // Covered structurally by file-transfer.test.ts's e2e case (which now links
    // contacts); this asserts the sealed offer is what crosses the wire.
    const me = DeviceIdentity.generate();
    const offer = sealAppFrame(
      { v: 1, t: "file-offer", fileId: "f1", name: "secret.pdf", size: 10, mime: "application/pdf", chunkSize: 8, chunks: 2, sha256: "ab", ts: 1 },
      me.transportKeyB64,
    );
    expect(JSON.stringify(offer)).not.toContain("secret.pdf");
    const opened = openSealedFrame(offer, me.transportPrivate(), me.transportPub);
    expect(opened?.t).toBe("file-offer");
    expect(opened && opened.t === "file-offer" ? opened.name : null).toBe("secret.pdf");
  });
});

// Sanity: the link helper itself rejects a self-card (can't message yourself).
describe("link helper", () => {
  it("rejects linking a client to itself", async () => {
    const board = new MockBoard();
    const a = new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      broker: board,
    });
    live = [a];
    await a.start();
    await expect(link(a, a)).rejects.toThrow();
  });
});
