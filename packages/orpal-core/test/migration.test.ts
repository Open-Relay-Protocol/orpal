import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  InMemoryConversationStore,
  InMemoryKeyStore,
  type WebRTCEndpoint,
} from "../src/index.js";
import { InMemoryMigrationStore } from "../src/messaging/migration-manager.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once, waitFor } from "./helpers/wait.js";
import { linkBoth } from "./helpers/link.js";

function makeMigrationPair() {
  const network = new MockNetwork();
  const board = new MockBoard();
  const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");

  const aKeyStore = new InMemoryKeyStore();
  const bKeyStore = new InMemoryKeyStore();

  const a = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: factory,
    migrationStore: new InMemoryMigrationStore(),
    keyStore: aKeyStore,
  });
  const b = new OrpalClient({
    identity: DeviceIdentity.generate(),
    store: new InMemoryConversationStore(),
    broker: board,
    webrtcFactory: factory,
    migrationStore: new InMemoryMigrationStore(),
    keyStore: bKeyStore,
  });
  return { a, b, board };
}

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

describe("identity migration wizard (ORPAL-008)", () => {
  it("auto-accepts via challenge-response: both transport keys verified", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    // Establish a connection.
    const bGot = once(b.events, "message", (e) => e.message.text === "setup");
    await a.sendText(b.identityKey, "setup");
    await bGot;

    // A starts a migration. B should auto-verify via challenge-response and
    // send back a migration_ack — no manual prompt needed.
    const ackReceived = once(
      a.events,
      "migration-progress",
      (e) => e.progress.acknowledged > 0,
    );

    const retireAt = new Date(Date.now() + 3600_000).toISOString();
    await a.startMigration(retireAt);

    // The ack should arrive automatically (challenge → response → auto-accept → ack).
    const progress = await ackReceived;
    expect(progress.progress.acknowledged).toBe(1);
    expect(a.migrationProgress!.phase).toBe("dual-validity");

    // B should have no pending prompts (it was auto-accepted).
    expect(b.pendingIncomingMigrations.length).toBe(0);
  });

  it("manual accept still works as a fallback", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const bGot = once(b.events, "message", (e) => e.message.text === "hi");
    await a.sendText(b.identityKey, "hi");
    await bGot;

    // Manually accept (simulates the case where challenges couldn't be sent).
    const migrationPrompt = once(b.events, "migration-incoming");
    const retireAt = new Date(Date.now() + 3600_000).toISOString();

    // Temporarily remove B's stored transport key for A so challenges can't
    // be created, forcing the fallback to manual prompt.
    const bStore = (b as any).contactTransportKey as Map<string, string>;
    const savedTk = bStore.get(a.identityKey)!;
    bStore.delete(a.identityKey);

    await a.startMigration(retireAt);
    const prompt = await migrationPrompt;
    expect(prompt.pending.contactKey).toBe(a.identityKey);

    // Restore and manually accept.
    bStore.set(a.identityKey, savedTk);
    const ackReceived = once(
      a.events,
      "migration-progress",
      (e) => e.progress.acknowledged > 0,
    );
    const accepted = await b.acceptMigration(a.identityKey);
    expect(accepted).toBe(true);

    const ackProgress = await ackReceived;
    expect(ackProgress.progress.acknowledged).toBe(1);
  });

  it("recipient declines migration and no ack is sent", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const bGot = once(b.events, "message", (e) => e.message.text === "yo");
    await a.sendText(b.identityKey, "yo");
    await bGot;

    // Remove transport key to force manual prompt path.
    const bStore = (b as any).contactTransportKey as Map<string, string>;
    bStore.delete(a.identityKey);

    const migrationPrompt = once(b.events, "migration-incoming");
    const retireAt = new Date(Date.now() + 3600_000).toISOString();
    await a.startMigration(retireAt);
    await migrationPrompt;

    b.declineMigration(a.identityKey);
    expect(b.pendingIncomingMigrations.length).toBe(0);
    expect(a.migrationProgress!.acknowledged).toBe(0);
  });

  it("migration manager reports retirement is due after the cutoff", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const bGot = once(b.events, "message", (e) => e.message.text === "x");
    await a.sendText(b.identityKey, "x");
    await bGot;

    const retireAt = new Date(Date.now() - 1000).toISOString();
    await a.startMigration(retireAt);

    await waitFor(() => a.migrationActive);
    expect(a.migrationProgress!.retireAfterUtc).toBe(retireAt);
  });

  it("initiator progress tracks the migration lifecycle", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    const bGot = once(b.events, "message", (e) => e.message.text === "z");
    await a.sendText(b.identityKey, "z");
    await bGot;

    expect(a.migrationActive).toBe(false);
    expect(a.migrationProgress).toBeNull();

    const retireAt = new Date(Date.now() + 3600_000).toISOString();
    await a.startMigration(retireAt);

    expect(a.migrationActive).toBe(true);
    expect(a.migrationProgress!.phase).toBe("dual-validity");
    expect(a.migrationProgress!.totalContacts).toBe(1);
  });
});
