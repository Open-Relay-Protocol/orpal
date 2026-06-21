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

// Local contact rename: the display name is device-local labelling only and is
// never part of the key binding or advertised to the peer / board.

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

function makeClient(): OrpalClient {
  const board = new MockBoard();
  const network = new MockNetwork();
  const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");
  const c = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    boards: [{ id: "b1", broker: board }],
    webrtcFactory: factory,
  });
  live.push(c);
  return c;
}

describe("setContactDisplayName", () => {
  it("renames a contact and persists the new name", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.start();
    await a.addContactFromCard(b.ownContactCard(), { displayName: "Original" });

    await a.setContactDisplayName(b.identityKey, "Renamed");

    const contact = (await a.listContacts()).find((c) => c.identityKey === b.identityKey);
    expect(contact?.displayName).toBe("Renamed");
  });

  it("trims surrounding whitespace", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.start();
    await a.addContactFromCard(b.ownContactCard(), { displayName: "Original" });

    await a.setContactDisplayName(b.identityKey, "  Spaced Out  ");

    const contact = (await a.listContacts()).find((c) => c.identityKey === b.identityKey);
    expect(contact?.displayName).toBe("Spaced Out");
  });

  it("ignores an empty / whitespace-only name so a contact is never nameless", async () => {
    const a = makeClient();
    const b = makeClient();
    await a.start();
    await a.addContactFromCard(b.ownContactCard(), { displayName: "Keep Me" });

    await a.setContactDisplayName(b.identityKey, "   ");

    const contact = (await a.listContacts()).find((c) => c.identityKey === b.identityKey);
    expect(contact?.displayName).toBe("Keep Me");
  });

  it("is a no-op for an unknown contact", async () => {
    const a = makeClient();
    await a.start();
    await expect(a.setContactDisplayName("not-a-real-key", "Whoever")).resolves.toBeUndefined();
  });
});
