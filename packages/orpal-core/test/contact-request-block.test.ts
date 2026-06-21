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

// In-band contact-card exchange + block list.
//
// When an UNKNOWN sender messages us, the connection hello hands us their card so
// we can ACCEPT them as a full two-way contact, or BLOCK them so their connection
// is refused at the protocol level.

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

/** A and B both federate over one shared board + WebRTC network. */
function pair(opts: Partial<ConstructorParameters<typeof OrpalClient>[0]> = {}) {
  const board = new MockBoard();
  const network = new MockNetwork();
  const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");
  const mk = () =>
    new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      boards: [{ id: "b1", broker: board }],
      webrtcFactory: factory,
      ...opts,
    });
  const a = mk();
  const b = mk();
  live = [a, b];
  return { a, b };
}

describe("contact requests (in-band card exchange)", () => {
  it("an unknown sender's message raises a contact-request with their card", async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    // A knows B (has B's card) and can reach them; B does NOT know A.
    await a.addContactFromCard(b.ownContactCard());

    const request = once(b.events, "contact-request", (r) => r.contactKey === a.identityKey);
    const got = once(b.events, "message", (e) => e.message.text === "hi there");
    await a.sendText(b.identityKey, "hi there");

    expect((await got).message.text).toBe("hi there");
    const req = await request;
    expect(req.contactKey).toBe(a.identityKey);
    // B isn't a contact of A's yet.
    expect((await b.listContacts()).some((c) => c.identityKey === a.identityKey)).toBe(false);
    // …but the request is queued for a decision.
    expect(b.contactRequests.map((r) => r.contactKey)).toContain(a.identityKey);
  });

  it("accepting a request adds the sender as a full, named two-way contact", async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    await a.addContactFromCard(b.ownContactCard());

    const request = once(b.events, "contact-request", (r) => r.contactKey === a.identityKey);
    await a.sendText(b.identityKey, "knock knock");
    await request;
    const res = await b.acceptContactRequest(a.identityKey, "Alice");
    expect(res.ok).toBe(true);

    const contact = (await b.listContacts()).find((c) => c.identityKey === a.identityKey);
    expect(contact?.displayName).toBe("Alice");
    // We hold A's transport key now, so a reply can be sealed back to them.
    expect(contact?.transportKey).toBe(a.exportPublicIdentity().transport_key);
    // The pending request is consumed.
    expect(b.contactRequests.map((r) => r.contactKey)).not.toContain(a.identityKey);
  });

  it("accepting an unknown sender with no pending card fails cleanly", async () => {
    const { b } = pair();
    await b.start();
    const res = await b.acceptContactRequest("no-such-key");
    expect(res).toEqual({ ok: false, reason: "no-pending-request" });
  });
});

describe("block list", () => {
  it("a blocked sender's message never arrives", async () => {
    const { a, b } = pair({ connectTimeoutMs: 300 });
    await a.start();
    await b.start();
    await a.addContactFromCard(b.ownContactCard());

    // B blocks A before A ever connects.
    b.setBlockedKeys([a.identityKey]);

    // A tries to send, but B refuses the connection, so nothing is delivered.
    await a.sendText(b.identityKey, "let me in");
    await new Promise((r) => setTimeout(r, 300));

    expect(await b.history(a.identityKey)).toHaveLength(0);
    expect(b.contactRequests).toHaveLength(0);
    expect(b.contactState(a.identityKey)).toBe("unknown"); // never connected
    expect(b.isBlocked(a.identityKey)).toBe(true);
  });

  it("setBlockedKeys tears down an existing live connection", async () => {
    const { a, b } = pair();
    await a.start();
    await b.start();
    await a.addContactFromCard(b.ownContactCard());
    await b.addContactFromCard(a.ownContactCard());

    // Establish a live connection both ways.
    const got = once(b.events, "message", (e) => e.message.text === "first");
    await a.sendText(b.identityKey, "first");
    await got;
    await waitFor(() => b.contactState(a.identityKey) === "connected");

    // Blocking drops the live connection.
    b.setBlockedKeys([a.identityKey]);
    expect(b.contactState(a.identityKey)).toBe("unknown");
  });
});
