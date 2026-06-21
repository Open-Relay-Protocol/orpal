// OrpalClient -- the high-level messaging + file-transfer orchestrator.
//
// Delegates per-contact state to ContactRegistry (one record per contact
// instead of N parallel maps) and connection lifecycle to ConnectionManager
// (match/channel/waiter state). OrpalClient itself handles messaging,
// file transfer, migration, and broker lifecycle.

import { randomBytes } from "@noble/hashes/utils";
import { Client, ReliableChannel, b64uEncode } from "../orp.js";
import type {
  BoardConnection,
  ClientOptions,
  ConnectedInfo,
  DeviceIdentity,
  Outbound,
  PublicIdentity,
  RendezvousBroker,
  WebRTCEndpoint,
} from "../orp.js";
import { TypedEmitter } from "../util/events.js";
import { BrowserWebRTCEndpoint } from "../rtc/browser-webrtc.js";
import type { Contact } from "../contacts/contact.js";
import { contactFromCard, makeLoopbackContact, parseContactCard, serializeContactCard } from "../contacts/contact.js";
import {
  importContacts as importContactsBundle,
  parseContactsExport,
  serializeContacts,
  type ContactsExport,
  type ImportSummary,
} from "../contacts/contact-export.js";
import type { ConversationStore, StoredMessage } from "../persistence/conversation-store.js";
import { InMemoryKeyStore } from "../identity/secure-store.js";
import {
  decodeAppFrame,
  encodeAppFrame,
  type AppFrame,
  type FileOfferFrame,
} from "./frames.js";
import { openSealedFrame, sealAppFrame, type SealablePayload } from "./sealed.js";
import {
  computePendingMetrics,
  type PendingMessage,
  type PendingMetrics,
  type PendingQueueStore,
} from "./pending-queue.js";
import { DeliveryWorker, type BackoffConfig } from "./delivery-worker.js";
import {
  FileReceiver,
  sendFile,
  type AckedSender,
  type FileSink,
  type FileSource,
  type FileTransferOptions,
  type TransferProgress,
} from "../transfer/file-transfer.js";
import {
  MigrationManager,
  type MigrationProgress,
  type MigrationStore,
  type PendingMigration,
} from "./migration-manager.js";
import { ContactRegistry } from "./contact-registry.js";
import { ConnectionManager, mk, type ContactConn } from "./connection-manager.js";

export type { ContactConn } from "./connection-manager.js";
export type ContactState = "connected" | "connecting" | "down" | "unknown";
export type BrokerState = "connecting" | "open" | "closed" | "error";

export interface BoardSpec {
  id: string;
  broker: RendezvousBroker;
}

export class OfflineError extends Error {
  constructor(public readonly contactKey: string) {
    super(`Contact ${contactKey} is offline or unreachable (no store-and-forward).`);
    this.name = "OfflineError";
  }
}

export class NoPinnedKeyError extends Error {
  constructor(public readonly contactKey: string) {
    super(`No pinned transport key for ${contactKey}; add them as a contact (scan/paste their card) before messaging.`);
    this.name = "NoPinnedKeyError";
  }
}

export interface IncomingFileSink {
  sink: FileSink;
  path?: string;
}

/** Result of the loopback diagnostic self-test (issue #41). `ok` is true only
 *  when BOTH the board is reachable and the local seal/open crypto round-trips. */
export interface LoopbackSelfTestResult {
  ok: boolean;
  boardReachable: boolean;
  cryptoRoundTrip: boolean;
  /** A short machine-readable reason when `ok` is false (e.g. "board-unreachable",
   *  "decrypt-mismatch"); undefined on success. */
  reason?: string;
}

export interface OrpalClientOptions {
  identity: DeviceIdentity;
  store: ConversationStore;
  pendingQueue?: PendingQueueStore;
  retryBackoff?: Partial<BackoffConfig>;
  boards?: BoardSpec[];
  broker?: RendezvousBroker;
  iceServers?: RTCIceServer[];
  boardsScope?: string[];
  webrtcFactory?: (matchId: string, role: "initiator" | "responder") => WebRTCEndpoint;
  createFileSink?: (offer: FileOfferFrame, contactKey: string) => Promise<IncomingFileSink>;
  presenceIntervalMs?: number;
  connectTimeoutMs?: number;
  ackTimeoutMs?: number;
  fileTransfer?: FileTransferOptions;
  relayOnlyByDefault?: boolean;
  now?: () => string;
  migrationStore?: MigrationStore;
  keyStore?: import("../identity/secure-store.js").SecureKeyStore;
  /** ORPAL-013: a SEPARATE sealed key store for the pending new identity during a
   *  migration. Should be a HardwareBackedKeyStore over its own slot so the new
   *  keys are sealed at rest. If omitted, an in-memory store is used -- fine for
   *  tests, but a shell wanting cross-restart migration resume must wire this. */
  migrationKeyStore?: import("../identity/secure-store.js").SecureKeyStore;
  /** ORPAL-016 / ORP-009: OPTIONAL opt-in platform push token (APNs/FCM token or
   *  Web Push endpoint), obtained by the host shell from the platform push
   *  service. When set it rides the signed presence beacon so the relay board can
   *  fire a contentless wake on a channel timeout. Omit it (the default) and the
   *  device is only reachable while the app is open -- no token is ever announced.
   *  The shell can flip this at runtime via `setPushToken()`. */
  pushToken?: string;
}

export type OrpalEvents = {
  message: { message: StoredMessage };
  "message-updated": { id: string; message: StoredMessage };
  connection: { contactKey: string; state: ContactState };
  "transfer-progress": { contactKey: string; direction: "in" | "out"; progress: TransferProgress };
  broker: { state: BrokerState; detail?: string };
  pending: { metrics: PendingMetrics };
  "migration-progress": { progress: MigrationProgress };
  "migration-incoming": { pending: PendingMigration };
  /** An unknown sender (not yet a contact) messaged us and handed us their card
   *  in-band. The UI can prompt the user to accept (add as a full contact) or
   *  block them. `name` is the sender's self-chosen card name, if any. */
  "contact-request": { contactKey: string; card: string; name?: string };
  error: { error: unknown; context: string };
};

/** A pending request from an unknown sender awaiting the user's accept/block
 *  decision (see {@link OrpalEvents}'s `contact-request`). */
export interface ContactRequest {
  contactKey: string;
  /** The sender's serialized contact card (verified binding, bound to the
   *  authenticated connection). */
  card: string;
  /** The sender's self-chosen name from their card, if any. */
  name?: string;
}

interface BoardEntry {
  id: string;
  client: Client;
  state: BrokerState;
  /** The exact options object handed to `new Client`. We retain the reference so
   *  `setPushToken()` can mutate `orpOpts.pushToken` in place -- the ORP client
   *  reads `this.opts.pushToken` fresh on every `announcePresence()`, so the next
   *  periodic beacon picks up the change without reconstructing the client. */
  orpOpts: ClientOptions;
}

function newId(): string {
  return b64uEncode(randomBytes(16));
}

export class OrpalClient {
  readonly identity: DeviceIdentity;
  readonly events = new TypedEmitter<OrpalEvents>();

  private readonly store: ConversationStore;
  private readonly pendingQueue: PendingQueueStore | null;
  private worker: DeliveryWorker | null = null;
  private readonly boards: BoardEntry[] = [];
  private readonly opts: OrpalClientOptions;
  private readonly boardsScope: string[];
  private readonly presenceIntervalMs: number;
  private readonly connectTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  /** ORPAL-016: current opt-in push token (undefined => push disabled). Mirrored
   *  into every board's `orpOpts.pushToken` so re-announces carry it. */
  private pushTokenValue: string | undefined;

  private readonly contacts = new ContactRegistry();
  private readonly conns = new ConnectionManager();
  private readonly updateChains = new Map<string, Promise<void>>();

  /** Identity keys the user has blocked. Blocked peers have their inbound
   *  connection refused (handleConnected) and any stray frame dropped. */
  private blockedKeys = new Set<string>();
  /** Cards received in-band from unknown senders, keyed by identity key, awaiting
   *  the user's accept/block decision. In-memory only: re-sent on reconnect. */
  private readonly pendingCards = new Map<string, ContactRequest>();

  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private brokerStateValue: BrokerState = "connecting";
  private migration: MigrationManager | null = null;

  constructor(options: OrpalClientOptions) {
    this.opts = options;
    this.identity = options.identity;
    this.store = options.store;
    this.pendingQueue = options.pendingQueue ?? null;
    this.boardsScope = options.boardsScope ?? ["default"];
    this.presenceIntervalMs = options.presenceIntervalMs ?? 20_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000;
    this.pushTokenValue = options.pushToken;

    const specs: BoardSpec[] =
      options.boards ?? (options.broker ? [{ id: "default", broker: options.broker }] : []);
    if (specs.length === 0) {
      throw new Error("OrpalClient: provide `boards` (or `broker` for a single board).");
    }
    for (const spec of specs) {
      const observingBroker: RendezvousBroker = {
        connect: (onOutbound: (msg: Outbound) => void): BoardConnection =>
          spec.broker.connect((msg) => {
            this.observeOutbound(spec.id, msg);
            onOutbound(msg);
          }),
      };
      // Retain the options object: setPushToken() mutates orpOpts.pushToken in
      // place, and the ORP client reads it fresh on each announcePresence().
      const orpOpts: ClientOptions = {
        boards_scope: this.boardsScope,
        webrtcFactory: (matchId, role) => this.buildEndpoint(spec.id, matchId, role),
        pushToken: this.pushTokenValue,
        now: options.now,
      };
      const client = new Client(observingBroker, this.identity, orpOpts);
      this.boards.push({ id: spec.id, client, state: "connecting", orpOpts });
    }

    this.conns.events.on("state", ({ contactKey, state }) => {
      this.events.emit("connection", { contactKey, state });
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.store.init();
    this.contacts.loadAll(await this.store.listContacts());
    if (this.pendingQueue) {
      await this.pendingQueue.init();
      this.worker = new DeliveryWorker({
        store: this.pendingQueue,
        attempt: (msg) => this.attemptDelivery(msg),
        backoff: this.opts.retryBackoff,
        onMetrics: (metrics) => this.events.emit("pending", { metrics }),
        log: (event, data) =>
          // eslint-disable-next-line no-console
          console.debug(`[orpal-core] pending-queue ${event}`, data ?? {}),
      });
      await this.worker.start();
    }
    if (this.opts.migrationStore && this.opts.keyStore) {
      this.migration = new MigrationManager({
        keyStore: this.opts.keyStore,
        // ORPAL-013: keep the pending new identity's keys in their own sealed
        // slot. Default to in-memory when a shell doesn't wire one (tests).
        pendingKeyStore: this.opts.migrationKeyStore ?? new InMemoryKeyStore(),
        migrationStore: this.opts.migrationStore,
        now: this.opts.now,
      });
      await this.migration.init();
    }
    for (const board of this.boards) this.armConnectionLoop(board);
    this.announcePresence();
    this.presenceTimer = setInterval(() => this.announcePresence(), this.presenceIntervalMs);
  }

  close(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.worker?.stop();
    this.worker = null;
    this.conns.closeAll();
    for (const board of this.boards) board.client.close();
    this.events.removeAll();
    this.started = false;
  }

  // ---- identity / contacts -------------------------------------------------

  get identityKey(): string {
    return this.identity.identityKeyB64;
  }

  exportPublicIdentity(): PublicIdentity {
    return this.identity.exportPublic();
  }

  ownContactCard(name?: string): string {
    return serializeContactCard(this.identity.exportPublic(), name);
  }

  async addContactFromCard(
    input: string,
    opts: { displayName?: string; relayOnly?: boolean } = {},
  ): Promise<{ ok: true; contact: Contact } | { ok: false; reason: string }> {
    const parsed = parseContactCard(input);
    if (!parsed.valid || !parsed.card) return { ok: false, reason: parsed.reason ?? "invalid" };
    if (parsed.card.identity_key === this.identityKey) {
      return { ok: false, reason: "that-is-your-own-card" };
    }
    const contact = contactFromCard(parsed.card, opts);
    await this.registerContact(contact);
    return { ok: true, contact };
  }

  /** Persist a contact and mirror it into the in-memory registry so sealing /
   *  routing see it immediately (shared by single-card add, bulk import, and the
   *  loopback contact). */
  private async registerContact(contact: Contact): Promise<void> {
    await this.store.upsertContact(contact);
    this.contacts.set(contact.identityKey, {
      relayOnly: contact.relayOnly,
      transportKey: contact.transportKey,
      boards: { preferred: contact.preferredBoards ?? [], fallback: contact.fallbackBoards ?? [] },
      autoAcceptMigration: contact.autoAcceptMigration ?? false,
    });
  }

  /** Bulk-export contacts as a versioned JSON bundle (issue #41). Excludes the
   *  loopback diagnostic contact and never includes private keys or history. The
   *  shell gates the resulting file write behind an explicit user action. */
  async exportContacts(): Promise<string> {
    const contacts = await this.store.listContacts();
    return serializeContacts(contacts, { now: this.opts.now });
  }

  /** Import a previously exported bundle (issue #41). Every entry is re-validated
   *  through the same binding check as a single scanned card; bad/mismatched
   *  bindings are rejected (never stored). Non-destructive: existing contacts are
   *  never deleted, and collisions resolve per `onCollision` (default `"skip"`).
   *  Returns a summary of imported / skipped / rejected counts. */
  async importContacts(
    input: string | ContactsExport,
    opts: { onCollision?: "skip" | "overwrite" } = {},
  ): Promise<ImportSummary> {
    let bundle: ContactsExport;
    if (typeof input === "string") {
      const parsed = parseContactsExport(input);
      if (!parsed.valid || !parsed.bundle) {
        return { imported: 0, skipped: 0, rejected: [{ identityKey: "(bundle)", reason: parsed.reason ?? "invalid" }] };
      }
      bundle = parsed.bundle;
    } else {
      bundle = input;
    }
    const existingKeys = (await this.store.listContacts()).map((c) => c.identityKey);
    const { contacts, summary } = importContactsBundle(bundle, {
      onCollision: opts.onCollision,
      existingKeys,
      ownKey: this.identityKey,
      now: this.opts.now,
    });
    for (const contact of contacts) await this.registerContact(contact);
    return summary;
  }

  /** Ensure the diagnostic loopback test contact exists (issue #41), creating it
   *  from this device's own public identity if absent. Idempotent: returns the
   *  existing loopback contact when one is already stored. */
  async ensureLoopbackContact(opts: { name?: string } = {}): Promise<Contact> {
    const existing = (await this.store.listContacts()).find((c) => c.isLoopback);
    if (existing) return existing;
    const contact = makeLoopbackContact(this.identity.exportPublic(), { name: opts.name, now: this.opts.now });
    await this.registerContact(contact);
    return contact;
  }

  /** Run the loopback diagnostic self-test (issue #41).
   *
   *  NOTE on scope: a true message round-trip to one's OWN identity is not
   *  possible over the ORP secure channel -- `deriveDirectionalKeys` splits the
   *  send/recv keys by comparing the two transport keys, which collapses when both
   *  ends share one identity, and a board won't rendezvous a device with itself.
   *  So instead of a network echo this verifies the two locally-checkable halves
   *  of "is my setup working?": (1) the board is reachable, and (2) the sealing
   *  pipeline + this device's own keys round-trip -- a message sealed to our own
   *  transport key opens cleanly with our own transport private key (the exact
   *  seal/open the messaging path uses, just kept on-device). */
  async runLoopbackSelfTest(): Promise<LoopbackSelfTestResult> {
    const contact = await this.ensureLoopbackContact();
    const boardReachable = this.brokerStateValue === "open";
    let cryptoRoundTrip = false;
    let reason: string | undefined;
    try {
      const probe: SealablePayload = {
        v: 1,
        t: "text",
        id: newId(),
        text: `loopback-${b64uEncode(randomBytes(8))}`,
        ts: Date.now(),
      };
      const wire = this.encodeSealed(contact.transportKey, probe);
      const outer = decodeAppFrame(wire);
      if (!outer || outer.t !== "sealed") {
        reason = "seal-encode-failed";
      } else {
        const inner = openSealedFrame(outer, this.identity.transportPrivate(), this.identity.transportPub);
        cryptoRoundTrip = !!inner && inner.t === "text" && inner.text === probe.text;
        if (!cryptoRoundTrip) reason = "decrypt-mismatch";
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    if (cryptoRoundTrip && !boardReachable) reason = "board-unreachable";
    return { ok: boardReachable && cryptoRoundTrip, boardReachable, cryptoRoundTrip, reason };
  }

  listContacts(): Promise<Contact[]> {
    return this.store.listContacts();
  }

  async removeContact(identityKey: string): Promise<void> {
    await this.store.removeContact(identityKey);
    this.contacts.remove(identityKey);
  }

  async setContactBoards(
    identityKey: string,
    boards: { preferredBoards?: string[]; fallbackBoards?: string[] },
  ): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    contact.preferredBoards = boards.preferredBoards ?? [];
    contact.fallbackBoards = boards.fallbackBoards ?? [];
    await this.store.upsertContact(contact);
    this.contacts.patch(identityKey, {
      boards: { preferred: contact.preferredBoards, fallback: contact.fallbackBoards },
    });
  }

  private boardsForContact(contactKey: string): BoardEntry[] {
    const cfg = this.contacts.boards(contactKey);
    if (cfg.preferred.length === 0 && cfg.fallback.length === 0) {
      return this.boards;
    }
    const seen = new Set<string>();
    const chosen: BoardEntry[] = [];
    for (const id of [...cfg.preferred, ...cfg.fallback]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const board = this.boards.find((b) => b.id === id);
      if (board) chosen.push(board);
    }
    return chosen;
  }

  async setContactRelayOnly(identityKey: string, relayOnly: boolean): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    contact.relayOnly = relayOnly;
    await this.store.upsertContact(contact);
    this.contacts.patch(identityKey, { relayOnly });
  }

  /** Rename a contact locally. The display name is device-local labelling only --
   *  it is not part of the key binding and is never advertised to the peer or the
   *  board. An empty/whitespace name is ignored so a contact is never left
   *  nameless. */
  async setContactDisplayName(identityKey: string, displayName: string): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    const trimmed = displayName.trim();
    if (!trimmed) return;
    contact.displayName = trimmed;
    await this.store.upsertContact(contact);
  }

  // ---- block list + contact requests ---------------------------------------

  /** Replace the set of blocked identity keys. Any currently-live connection to a
   *  now-blocked peer is torn down immediately, and any pending contact request
   *  from them is discarded. New inbound connections from blocked keys are refused
   *  in `handleConnected`. */
  setBlockedKeys(keys: Iterable<string>): void {
    this.blockedKeys = new Set(keys);
    for (const key of this.blockedKeys) {
      this.conns.dropConnection(key);
      this.pendingCards.delete(key);
    }
  }

  isBlocked(identityKey: string): boolean {
    return this.blockedKeys.has(identityKey);
  }

  /** Unknown senders awaiting an accept/block decision. */
  get contactRequests(): readonly ContactRequest[] {
    return [...this.pendingCards.values()];
  }

  /** Accept an unknown sender: add them as a full two-way contact from the card
   *  they handed us in-band, optionally with a chosen display name. Returns the
   *  same shape as `addContactFromCard`. */
  async acceptContactRequest(
    identityKey: string,
    displayName?: string,
  ): Promise<{ ok: true; contact: Contact } | { ok: false; reason: string }> {
    const req = this.pendingCards.get(identityKey);
    if (!req) return { ok: false, reason: "no-pending-request" };
    const res = await this.addContactFromCard(req.card, { displayName });
    if (res.ok) this.pendingCards.delete(identityKey);
    return res;
  }

  /** Dismiss a pending contact request without accepting or blocking (e.g. the
   *  user closed the prompt). It will reappear if the sender reconnects. */
  dismissContactRequest(identityKey: string): void {
    this.pendingCards.delete(identityKey);
  }

  async setAutoAcceptMigration(identityKey: string, autoAccept: boolean): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    contact.autoAcceptMigration = autoAccept;
    await this.store.upsertContact(contact);
    this.contacts.patch(identityKey, { autoAcceptMigration: autoAccept });
  }

  // ---- migration (ORPAL-008) ------------------------------------------------

  get migrationActive(): boolean { return this.migration?.active ?? false; }
  get migrationProgress(): MigrationProgress | null { return this.migration?.progress ?? null; }
  get pendingIncomingMigrations(): readonly PendingMigration[] { return this.migration?.pendingMigrations ?? []; }

  async startMigration(retireAfterUtc: string): Promise<void> {
    if (!this.migration) throw new Error("Migration not configured (provide migrationStore + keyStore).");
    const contactList = await this.store.listContacts();
    const { migration } = await this.migration.startMigration(this.identity, contactList, retireAfterUtc);
    const frame = encodeAppFrame({ v: 1, t: "key-migration", migration: migration as unknown as Record<string, unknown> });
    for (const contact of contactList) {
      const conn = this.conns.getConnection(contact.identityKey);
      if (conn && conn.state === "connected") conn.channel.send(frame).catch(() => {});
    }
    await this.migration.markNotified();
    const progress = this.migration.progress;
    if (progress) this.events.emit("migration-progress", { progress });
  }

  async acceptMigration(contactKey: string): Promise<boolean> {
    if (!this.migration) return false;
    const result = this.migration.acceptIncomingMigration(contactKey);
    if (!result.accepted || !result.migration || !result.newContact) return false;
    const oldContact = await this.store.getContact(contactKey);
    if (oldContact && result.newContact.identityKey) {
      const updated: Contact = { ...oldContact, identityKey: result.newContact.identityKey, transportKey: result.newContact.transportKey!, binding: result.newContact.binding! };
      await this.store.upsertContact(updated);
      this.contacts.set(updated.identityKey, {
        relayOnly: updated.relayOnly, transportKey: updated.transportKey,
        boards: { preferred: updated.preferredBoards ?? [], fallback: updated.fallbackBoards ?? [] },
        autoAcceptMigration: updated.autoAcceptMigration ?? false,
      });
    }
    const ack = this.migration.buildMigrationAck(this.identity, result.migration);
    const conn = this.conns.getConnection(contactKey);
    if (conn && conn.state === "connected") {
      conn.channel.send(encodeAppFrame({ v: 1, t: "migration-ack", ack: ack as unknown as Record<string, unknown> })).catch(() => {});
    }
    return true;
  }

  declineMigration(contactKey: string): void { this.migration?.declineIncomingMigration(contactKey); }

  async retireMigration(): Promise<void> {
    if (!this.migration) return;
    await this.migration.retire();
    const progress = this.migration.progress;
    if (progress) this.events.emit("migration-progress", { progress });
  }

  // ---- sending -------------------------------------------------------------

  async sendText(contactKey: string, text: string): Promise<string> {
    const id = newId();
    const ts = Date.now();
    const transportKey = this.contacts.transportKey(contactKey);
    const message: StoredMessage = { id, contactKey, direction: "out", kind: "text", text, ts, state: this.worker ? "queued" : "sending" };
    await this.store.appendMessage(message);
    this.events.emit("message", { message });
    if (!transportKey) {
      await this.markMessage(id, { state: "failed" });
      this.events.emit("error", { error: new NoPinnedKeyError(contactKey), context: "sendText:seal" });
      return id;
    }
    if (this.worker) {
      const pending: PendingMessage = { recipientId: contactKey, recipientTransportKey: transportKey, messageId: id, timestamp: ts, attemptCount: 0, lastAttemptAt: null, payload: { kind: "text", text } };
      await this.worker.enqueue(pending);
      return id;
    }
    let conn: ContactConn;
    try { conn = await this.ensureConnection(contactKey); } catch (err) {
      await this.markMessage(id, { state: "failed" });
      if (!(err instanceof OfflineError)) this.events.emit("error", { error: err, context: "sendText:connect" });
      return id;
    }
    conn.channel.send(this.encodeSealed(transportKey, { v: 1, t: "text", id, text, ts }))
      .then(() => this.markMessage(id, { state: "delivered" }))
      .catch(() => this.markMessage(id, { state: "failed" }));
    return id;
  }

  private async attemptDelivery(msg: PendingMessage): Promise<boolean> {
    let conn: ContactConn;
    try { conn = await this.ensureConnection(msg.recipientId); } catch (err) {
      if (err instanceof OfflineError) return false;
      throw err;
    }
    await this.markMessage(msg.messageId, { state: "sending" });
    await conn.channel.send(this.encodeSealed(msg.recipientTransportKey, { v: 1, t: "text", id: msg.messageId, text: msg.payload.text, ts: msg.timestamp }));
    await this.markMessage(msg.messageId, { state: "delivered" });
    return true;
  }

  async retryText(messageId: string, contactKey: string): Promise<void> {
    const msg = await this.store.getMessage(messageId);
    if (!msg || msg.kind !== "text" || msg.direction !== "out" || msg.text === undefined) return;
    const transportKey = this.contacts.transportKey(contactKey);
    if (!transportKey) {
      await this.markMessage(messageId, { state: "failed" });
      this.events.emit("error", { error: new NoPinnedKeyError(contactKey), context: "retryText:seal" });
      return;
    }
    await this.markMessage(messageId, { state: "sending" });
    try {
      const conn = await this.ensureConnection(contactKey);
      conn.channel.send(this.encodeSealed(transportKey, { v: 1, t: "text", id: messageId, text: msg.text, ts: msg.ts }))
        .then(() => this.markMessage(messageId, { state: "delivered" }))
        .catch(() => this.markMessage(messageId, { state: "failed" }));
    } catch { await this.markMessage(messageId, { state: "failed" }); }
  }

  async sendFile(contactKey: string, source: FileSource): Promise<string> {
    const fileId = newId();
    const ts = Date.now();
    const ft = this.opts.fileTransfer ?? {};
    const chunkSize = ft.chunkSize ?? 16 * 1024;
    const chunks = source.size === 0 ? 0 : Math.ceil(source.size / chunkSize);
    const message: StoredMessage = { id: fileId, contactKey, direction: "out", kind: "file", ts, state: "sending", file: { fileId, name: source.name, size: source.size, mime: source.mime, sha256: "", chunkSize, chunks, state: "transferring", transferred: 0 } };
    await this.store.appendMessage(message);
    this.events.emit("message", { message });
    const transportKey = this.contacts.transportKey(contactKey);
    if (!transportKey) {
      await this.markFile(fileId, { state: "failed" }, "failed");
      this.events.emit("error", { error: new NoPinnedKeyError(contactKey), context: "sendFile:seal" });
      return fileId;
    }
    let conn: ContactConn;
    try { conn = await this.ensureConnection(contactKey); } catch (err) {
      await this.markFile(fileId, { state: "failed" }, "failed");
      if (!(err instanceof OfflineError)) this.events.emit("error", { error: err, context: "sendFile:connect" });
      return fileId;
    }
    const sender: AckedSender = { sendFrame: (frame: AppFrame) => conn.channel.send(this.maybeSealOutbound(transportKey, frame)) };
    sendFile(sender, source, { ...ft, fileId, onProgress: (p) => {
      void this.markFile(fileId, { transferred: p.transferred, state: "transferring" });
      this.events.emit("transfer-progress", { contactKey, direction: "out", progress: p });
    }})
      .then((res) => this.markFile(fileId, { state: "complete", sha256: res.sha256 }, "delivered"))
      .catch((err) => { void this.markFile(fileId, { state: "failed" }, "failed"); this.events.emit("error", { error: err, context: "sendFile" }); });
    return fileId;
  }

  // ---- push notifications (ORPAL-016) --------------------------------------

  /** The push token currently riding the presence beacon, or `undefined` when
   *  push is disabled (the default). */
  get pushToken(): string | undefined { return this.pushTokenValue; }

  /** Opt in/out of wake-on-push at runtime. Pass a platform push token to start
   *  advertising it in the signed presence (so the board can wake this device on
   *  a channel timeout); pass `undefined` to stop -- the next beacon omits the
   *  token entirely. A change re-announces immediately on every board so the
   *  board's view is updated without waiting for the next interval. No-op if the
   *  value is unchanged. */
  setPushToken(token: string | undefined): void {
    if (token === this.pushTokenValue) return;
    this.pushTokenValue = token;
    for (const board of this.boards) board.orpOpts.pushToken = token;
    if (this.started) this.announcePresence();
  }

  /** Push a fresh presence beacon to every board right now, instead of waiting
   *  for the next interval. Used on a push wake (ORPAL-016): the device just came
   *  back online and wants peers to see it immediately. No-op until started. */
  reannounce(): void {
    if (this.started) this.announcePresence();
  }

  // ---- connection management -----------------------------------------------

  async connect(contactKey: string): Promise<void> { await this.ensureConnection(contactKey); }

  contactState(contactKey: string): ContactState { return this.conns.contactState(contactKey); }

  private ensureConnection(contactKey: string): Promise<ContactConn> {
    return this.conns.ensureConnection(contactKey, this.connectTimeoutMs, () => {
      const boards = this.boardsForContact(contactKey);
      if (boards.length === 0) this.events.emit("error", { error: new Error(`contact ${contactKey} has board routes configured but none are loaded`), context: "ensureConnection:no-board" });
      for (const board of boards) board.client.sendIntent(contactKey);
    }, (key) => new OfflineError(key));
  }

  // ---- broker observation + reconnect --------------------------------------

  private observeOutbound(boardId: string, msg: Outbound): void {
    if (msg.kind === "match") this.conns.recordMatch(mk(boardId, msg.match_id), msg.counterparty_key);
  }

  get brokerStatus(): BrokerState { return this.brokerStateValue; }

  onBrokerOpen(boardId?: string): void {
    const board = this.resolveBoard(boardId);
    if (board) board.state = "open";
    this.recomputeBrokerState();
    if (!this.started) return;
    if (board) {
      this.announcePresenceOn(board);
      for (const key of this.conns.desiredContacts) {
        const conn = this.conns.getConnection(key);
        if (conn && conn.state === "connected") continue;
        if (this.boardsForContact(key).some((b) => b.id === board.id)) board.client.sendIntent(key);
      }
    }
    void this.worker?.flushAll();
  }

  onBrokerClose(boardId?: string, detail?: string): void {
    const board = this.resolveBoard(boardId);
    if (board) board.state = "closed";
    this.recomputeBrokerState(detail);
  }

  onBrokerError(boardId?: string, detail?: string): void {
    const board = this.resolveBoard(boardId);
    if (board) board.state = "error";
    this.recomputeBrokerState(detail);
  }

  private resolveBoard(boardId?: string): BoardEntry | undefined {
    if (boardId) return this.boards.find((b) => b.id === boardId);
    return this.boards.length === 1 ? this.boards[0] : undefined;
  }

  private recomputeBrokerState(detail?: string): void {
    const states = this.boards.map((b) => b.state);
    const agg: BrokerState = states.includes("open") ? "open" : states.includes("connecting") ? "connecting" : states.includes("error") ? "error" : "closed";
    this.brokerStateValue = agg;
    this.events.emit("broker", { state: agg, detail });
  }

  // ---- internals -----------------------------------------------------------

  private announcePresence(): void { for (const board of this.boards) this.announcePresenceOn(board); }

  private announcePresenceOn(board: BoardEntry): void {
    try { board.client.announcePresence(this.boardsScope); }
    catch (err) { this.events.emit("error", { error: err, context: "announcePresence" }); }
  }

  private buildEndpoint(boardId: string, matchId: string, role: "initiator" | "responder"): WebRTCEndpoint {
    const key = mk(boardId, matchId);
    if (this.opts.webrtcFactory) { const ep = this.opts.webrtcFactory(matchId, role); this.conns.storeEndpoint(key, ep); return ep; }
    const counterpartyKey = this.conns.counterpartyFor(key);
    const relayOnly = (counterpartyKey ? this.contacts.relayOnly(counterpartyKey) : false) || (this.opts.relayOnlyByDefault ?? false);
    const ep = new BrowserWebRTCEndpoint(matchId, role, { iceServers: this.opts.iceServers, iceTransportPolicy: relayOnly ? "relay" : "all", onConnectionStateChange: (state) => this.conns.handleEndpointState(key, state) });
    this.conns.storeEndpoint(key, ep);
    return ep;
  }

  private armConnectionLoop(board: BoardEntry): void {
    board.client.waitForConnection()
      .then((info) => { this.armConnectionLoop(board); void this.handleConnected(board, info); })
      .catch((err) => this.events.emit("error", { error: err, context: "waitForConnection" }));
  }

  private async handleConnected(board: BoardEntry, info: ConnectedInfo): Promise<void> {
    const contactKey = info.counterparty_key;
    const matchKey = mk(board.id, info.match_id);
    // Block enforcement: refuse a blocked peer's connection outright -- close the
    // freshly-matched endpoint and never wire up a channel, so no message, file,
    // or card can be delivered.
    if (this.blockedKeys.has(contactKey)) {
      this.conns.getEndpoint(matchKey)?.close();
      return;
    }
    const existing = this.conns.getConnection(contactKey);
    if (existing && existing.matchKey !== matchKey) {
      if (existing.state === "connected") { this.conns.getEndpoint(matchKey)?.close(); return; }
      existing.endpoint?.close();
    }
    const channel = new ReliableChannel(info.channel, { ackTimeoutMs: this.ackTimeoutMs });
    channel.onMessage((text) => void this.handleIncomingFrame(contactKey, text));
    const fileReceiver = this.opts.createFileSink ? this.buildFileReceiver(contactKey) : null;
    const conn: ContactConn = { contactKey, matchKey, boardId: board.id, channel, endpoint: this.conns.getEndpoint(matchKey) ?? null, state: "connected", fileReceiver };
    this.conns.setConnection(contactKey, conn);
    this.conns.emitState(contactKey, "connected");
    this.conns.resolveConnectWaiters(contactKey, conn);
    // In-band card exchange: hand the peer our card so an unknown sender can add
    // us back as a full two-way contact. The card carries no secrets and rides
    // the already-encrypted channel. (No name attached -- they already reached us
    // via our card, so this leaks nothing new.)
    conn.channel
      .send(encodeAppFrame({ v: 1, t: "hello", card: this.ownContactCard() }))
      .catch(() => { /* best-effort; not delivery-critical */ });
    void this.worker?.flushRecipient(contactKey);
  }

  private buildFileReceiver(contactKey: string): FileReceiver {
    return new FileReceiver({
      createSink: async (offer: FileOfferFrame): Promise<FileSink> => {
        const message: StoredMessage = { id: offer.fileId, contactKey, direction: "in", kind: "file", ts: offer.ts, state: "delivered", file: { fileId: offer.fileId, name: offer.name, size: offer.size, mime: offer.mime, sha256: offer.sha256, chunkSize: offer.chunkSize, chunks: offer.chunks, state: "transferring", transferred: 0 } };
        await this.store.appendMessage(message);
        this.events.emit("message", { message });
        const incoming = await this.opts.createFileSink!(offer, contactKey);
        if (incoming.path) await this.markFile(offer.fileId, { path: incoming.path });
        return incoming.sink;
      },
      onProgress: (p) => { void this.markFile(p.fileId, { transferred: p.transferred, state: "transferring" }); this.events.emit("transfer-progress", { contactKey, direction: "in", progress: p }); },
      onComplete: (outcome) => {
        if (outcome.ok) void this.markFile(outcome.fileId, { state: "complete" });
        else void this.markFile(outcome.fileId, { state: outcome.reason === "integrity-failed" ? "integrity-failed" : "failed" });
      },
    });
  }

  private async handleIncomingFrame(contactKey: string, text: string): Promise<void> {
    // Defence in depth: a connection blocked mid-flight is torn down, but drop any
    // frame that still slips through before teardown completes.
    if (this.blockedKeys.has(contactKey)) return;
    const outer = decodeAppFrame(text);
    if (!outer) return;
    if (outer.t === "sealed") {
      const inner = openSealedFrame(outer, this.identity.transportPrivate(), this.identity.transportPub);
      if (!inner) { this.events.emit("error", { error: new Error("sealed message failed to decrypt; dropped"), context: "handleIncomingFrame:unseal" }); return; }
      await this.processFrame(contactKey, inner);
      return;
    }
    await this.processFrame(contactKey, outer);
  }

  private async processFrame(contactKey: string, frame: AppFrame | SealablePayload): Promise<void> {
    switch (frame.t) {
      case "text": {
        const already = (await this.store.getMessage(frame.id)) !== null;
        if (!already) { const message: StoredMessage = { id: frame.id, contactKey, direction: "in", kind: "text", text: frame.text, ts: frame.ts, state: "delivered" }; await this.store.appendMessage(message); this.events.emit("message", { message }); }
        this.sendAwk(contactKey, frame.id);
        return;
      }
      case "awk": {
        if (this.worker) { const removed = await this.worker.acknowledge(frame.id); if (removed) await this.markMessage(frame.id, { state: "acknowledged" }); }
        else { await this.markMessage(frame.id, { state: "acknowledged" }); }
        return;
      }
      case "hello": {
        // A peer handed us their card in-band. Validate the binding and bind it to
        // the AUTHENTICATED counterparty: a connected peer may only ever present
        // its OWN card, never inject a third party's.
        const parsed = parseContactCard(frame.card);
        if (!parsed.valid || !parsed.card) return;
        if (parsed.card.identity_key !== contactKey) return;
        if (parsed.card.identity_key === this.identityKey) return; // our own echo
        // Already known (or already pending): nothing to ask the user.
        if (await this.store.getContact(contactKey)) return;
        if (this.pendingCards.has(contactKey)) return;
        const req: ContactRequest = { contactKey, card: frame.card, name: parsed.card.name };
        this.pendingCards.set(contactKey, req);
        this.events.emit("contact-request", req);
        return;
      }
      case "file-offer": {
        const conn = this.conns.getConnection(contactKey);
        if (!conn?.fileReceiver) return;
        const already = (await this.store.getMessage(frame.fileId)) !== null;
        if (already) return;
        await conn.fileReceiver.onOffer(frame);
        return;
      }
      case "file-chunk": { const conn = this.conns.getConnection(contactKey); await conn?.fileReceiver?.onChunk(frame); return; }
      case "file-done": { const conn = this.conns.getConnection(contactKey); await conn?.fileReceiver?.onDone(frame.fileId); return; }
      case "key-migration": {
        if (!this.migration) return;
        const contact = await this.store.getContact(contactKey);
        const name = contact?.displayName ?? contactKey;
        const result = this.migration.handleIncomingMigration(frame.migration, contactKey, name);
        if (!result.valid) { this.events.emit("error", { error: new Error(`Invalid key-migration from ${contactKey}: ${result.reason}`), context: "processFrame:key-migration" }); return; }
        const autoAccept = this.contacts.autoAcceptMigration(contactKey);
        const oldTk = this.contacts.transportKey(contactKey);
        const conn = this.conns.getConnection(contactKey);
        if (autoAccept && oldTk && conn && conn.state === "connected") {
          const challenges = this.migration.createChallenges(contactKey, oldTk);
          if (challenges) { for (const c of challenges) conn.channel.send(encodeAppFrame({ v: 1, t: "migration-challenge", target: c.target, sealed_nonce: c.sealedNonceB64, ack_pubkey: c.ackPubkeyB64 })).catch(() => {}); return; }
        }
        const pending = this.migration.pendingMigrations;
        const latest = pending[pending.length - 1];
        if (latest) this.events.emit("migration-incoming", { pending: latest });
        return;
      }
      case "migration-challenge": {
        if (!this.migration?.active) return;
        const echo = this.migration.answerChallenge(this.identity, frame.target, frame.sealed_nonce, frame.ack_pubkey);
        if (!echo) return;
        const conn = this.conns.getConnection(contactKey);
        if (conn && conn.state === "connected") conn.channel.send(encodeAppFrame({ v: 1, t: "migration-challenge-response", target: frame.target, sealed_echo: echo })).catch(() => {});
        return;
      }
      case "migration-challenge-response": {
        if (!this.migration) return;
        const { bothVerified, valid } = this.migration.verifyChallengeResponse(contactKey, frame.target, frame.sealed_echo);
        if (!valid) this.events.emit("error", { error: new Error(`Invalid challenge response from ${contactKey} (target: ${frame.target})`), context: "processFrame:migration-challenge-response" });
        if (bothVerified) { const accepted = await this.acceptMigration(contactKey); if (accepted) this.events.emit("migration-progress", { progress: this.migration.progress! }); }
        return;
      }
      case "migration-ack": {
        if (!this.migration) return;
        const accepted = await this.migration.handleMigrationAck(frame.ack, contactKey);
        if (accepted) { const progress = this.migration.progress; if (progress) this.events.emit("migration-progress", { progress }); }
        return;
      }
    }
  }

  // ---- small helpers -------------------------------------------------------

  private encodeSealed(transportKey: string, frame: SealablePayload): string { return encodeAppFrame(sealAppFrame(frame, transportKey)); }
  private maybeSealOutbound(transportKey: string, frame: AppFrame): string { return (frame.t === "text" || frame.t === "file-offer") ? this.encodeSealed(transportKey, frame) : encodeAppFrame(frame); }

  private sendAwk(contactKey: string, messageId: string): void {
    const conn = this.conns.getConnection(contactKey);
    if (!conn || conn.state !== "connected") return;
    conn.channel.send(encodeAppFrame({ v: 1, t: "awk", id: messageId, ts: Date.now() })).catch(() => {});
  }

  private enqueueUpdate(id: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.updateChains.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    this.updateChains.set(id, tail);
    void tail.then(() => { if (this.updateChains.get(id) === tail) this.updateChains.delete(id); });
    return run;
  }

  private markMessage(id: string, patch: Partial<Pick<StoredMessage, "state" | "text" | "file">>): Promise<void> {
    return this.enqueueUpdate(id, async () => {
      await this.store.updateMessage(id, patch);
      const message = await this.store.getMessage(id);
      if (message) this.events.emit("message-updated", { id, message });
    });
  }

  private markFile(fileId: string, filePatch: Partial<NonNullable<StoredMessage["file"]>>, state?: StoredMessage["state"]): Promise<void> {
    return this.enqueueUpdate(fileId, async () => {
      const current = await this.store.getMessage(fileId);
      if (!current?.file) return;
      const file = { ...current.file, ...filePatch };
      const patch: Partial<Pick<StoredMessage, "state" | "file">> = { file };
      if (state) patch.state = state;
      await this.store.updateMessage(fileId, patch);
      const message = await this.store.getMessage(fileId);
      if (message) this.events.emit("message-updated", { id: fileId, message });
    });
  }

  history(contactKey: string, opts?: { limit?: number; before?: number }): Promise<StoredMessage[]> { return this.store.listMessages(contactKey, opts); }

  async pendingMetrics(): Promise<PendingMetrics> {
    if (this.worker) return this.worker.metrics();
    return computePendingMetrics([]);
  }
}
