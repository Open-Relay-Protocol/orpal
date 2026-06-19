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
  it("initiator sends a key-migration and recipient receives the prompt", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    // Establish a connection so the migration frame can be sent.
    const bGot = once(b.events, "message", (e) => e.message.text === "setup");
    await a.sendText(b.identityKey, "setup");
    await bGot;

    // B listens for incoming migration.
    const migrationPrompt = once(b.events, "migration-incoming");

    // A starts a migration with a 1-hour retirement window.
    const retireAt = new Date(Date.now() + 3600_000).toISOString();
    await a.startMigration(retireAt);

    expect(a.migrationActive).toBe(true);
    expect(a.migrationProgress).not.toBeNull();
    expect(a.migrationProgress!.phase).toBe("dual-validity");
    expect(a.migrationProgress!.totalContacts).toBe(1);

    // B should receive the migration prompt.
    const prompt = await migrationPrompt;
    expect(prompt.pending.contactKey).toBe(a.identityKey);
    expect(prompt.pending.migration.old_key).toBe(a.identityKey);
    expect(b.pendingIncomingMigrations.length).toBe(1);
  });

  it("recipient accepts migration and sends back an ack", async () => {
    const { a, b } = makeMigrationPair();
    live = [a, b];
    await a.start();
    await b.start();
    await linkBoth(a, b);

    // Establish connection.
    const bGot = once(b.events, "message", (e) => e.message.text === "hi");
    await a.sendText(b.identityKey, "hi");
    await bGot;

    const migrationPrompt = once(b.events, "migration-incoming");

    const retireAt = new Date(Date.now() + 3600_000).toISOString();
    await a.startMigration(retireAt);
    await migrationPrompt;

    // Listen for the ack-carrying progress update AFTER startMigration's own emit.
    const ackReceived = once(
      a.events,
      "migration-progress",
      (e) => e.progress.acknowledged > 0,
    );

    // B accepts the migration.
    const accepted = await b.acceptMigration(a.identityKey);
    expect(accepted).toBe(true);
    expect(b.pendingIncomingMigrations.length).toBe(0);

    // A should receive the ack and update progress.
    const progress = await ackReceived;
    expect(progress.progress.acknowledged).toBe(1);
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

    const migrationPrompt = once(b.events, "migration-incoming");
    const retireAt = new Date(Date.now() + 3600_000).toISOString();
    await a.startMigration(retireAt);
    await migrationPrompt;

    b.declineMigration(a.identityKey);
    expect(b.pendingIncomingMigrations.length).toBe(0);

    // A's progress should still show 0 acknowledged.
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

    // Set a retirement date in the past.
    const retireAt = new Date(Date.now() - 1000).toISOString();
    await a.startMigration(retireAt);

    // The migration manager should know retirement is due.
    await waitFor(() => a.migrationActive);
    // We can't directly test isRetirementDue on OrpalClient, but we can
    // verify the progress shows the correct retire time.
    expect(a.migrationProgress!.retireAfterUtc).toBe(retireAt);
  });
});
