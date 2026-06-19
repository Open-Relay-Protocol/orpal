// OrpalClient — the high-level messaging + file-transfer orchestrator.
//
// It drives the reference ORP Client (the two-stage match, sealing, ICE
// filtering — all unmodified) and layers on what an app needs:
//   * a per-contact ReliableChannel (the §11 ACK layer) for delivery state,
//   * presence kept always-on (the board has no store-and-forward; SPEC §9.1),
//   * on-demand rendezvous with offline detection (intent → connect, or time out),
//   * text + file framing (frames.ts) multiplexed over each contact's channel,
//   * per-contact relay-only mode (SPEC §6),
//   * local history via a ConversationStore, and
//   * re-initiating rendezvous on reconnect.
//
// MULTIPLE BOARDS: a device can be reachable through several boards at once. We
// run one reference Client per board (same identity), announce presence on all of
// them, and on connect fan an intent out to every board — the first board to
// produce a working data channel wins; duplicate matches for the same contact are
// dropped. The exposed broker state is the AGGREGATE across boards (online if any
// board is up).
//
// PER-CONTACT POLICY TRICK: the reference Client's webrtcFactory(matchId, role)
// isn't told the counterparty key, but relay-only is a per-CONTACT choice. We wrap
// each board's broker so we observe its board→client messages (recording
// match → counterparty) BEFORE the reference Client's handler runs and calls our
// factory — so the factory knows the contact and can pick "all" vs "relay".

import { randomBytes } from "@noble/hashes/utils";
import { Client, ReliableChannel, b64uEncode } from "../orp.js";
import type {
  BoardConnection,
  ConnectedInfo,
  DeviceIdentity,
  Outbound,
  PublicIdentity,
  RendezvousBroker,
  WebRTCEndpoint,
} from "../orp.js";
import { TypedEmitter } from "../util/events.js";
import { BrowserWebRTCEndpoint, type RtcConnectionState } from "../rtc/browser-webrtc.js";
import type { Contact } from "../contacts/contact.js";
import { contactFromCard, parseContactCard, serializeContactCard } from "../contacts/contact.js";
import type { ConversationStore, StoredMessage } from "../persistence/conversation-store.js";
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
export type ContactState = "connected" | "connecting" | "down" | "unknown";
export type BrokerState = "connecting" | "open" | "closed" | "error";

/** One board the client federates over. */
export interface BoardSpec {
  id: string;
  broker: RendezvousBroker;
}

/** Thrown/used when a contact can't be reached within the connect timeout —
 *  the no-store-and-forward reality: if they're not online now, we can't deliver. */
export class OfflineError extends Error {
  constructor(public readonly contactKey: string) {
    super(`Contact ${contactKey} is offline or unreachable (no store-and-forward).`);
    this.name = "OfflineError";
  }
}

/** Used when there is no PINNED transport key for a recipient, so a message
 *  cannot be recipient-sealed (issue #23). Add the peer as a contact (scan/paste
 *  their verified card) before messaging — that's where the transport key is
 *  pinned. We fail closed rather than send an unsealed payload. */
export class NoPinnedKeyError extends Error {
  constructor(public readonly contactKey: string) {
    super(`No pinned transport key for ${contactKey}; add them as a contact (scan/paste their card) before messaging.`);
    this.name = "NoPinnedKeyError";
  }
}

/** What a shell must provide to receive files: where to stream the bytes. */
export interface IncomingFileSink {
  sink: FileSink;
  /** Local path the file is being written to, for display/opening. */
  path?: string;
}

export interface OrpalClientOptions {
  identity: DeviceIdentity;
  store: ConversationStore;

  /**
   * Durable pending-queue for offline delivery (issue #11). When provided,
   * outbound text sent to an unreachable contact is NOT marked failed — it is
   * persisted here and retried (presence-based when the contact comes online,
   * else on exponential backoff with jitter) until the recipient confirms it
   * with an awk frame, at which point it's removed and marked delivered. Survives
   * reloads/restarts because the store is durable. Omit to keep the legacy
   * fire-once "offline ⇒ failed" behaviour.
   */
  pendingQueue?: PendingQueueStore;
  /** Tune the blind-retry backoff used by the pending-queue delivery worker. */
  retryBackoff?: Partial<BackoffConfig>;

  /** Boards to federate over. Shells pass BrowserRendezvousBrokers wired with
   *  lifecycle hooks (onOpen → orpal.onBrokerOpen(id), etc.). */
  boards?: BoardSpec[];
  /** Convenience for a single board (e.g. tests). Equivalent to
   *  `boards: [{ id: "default", broker }]`. */
  broker?: RendezvousBroker;

  /** ICE servers (STUN/TURN). TURN is required for relay-only contacts. */
  iceServers?: RTCIceServer[];
  boardsScope?: string[];

  /** Override endpoint creation (tests pass a MockWebRTC factory). When omitted, a
   *  BrowserWebRTCEndpoint is built with per-contact relay-only policy. */
  webrtcFactory?: (matchId: string, role: "initiator" | "responder") => WebRTCEndpoint;

  /** How a received file is persisted. Required to accept files; if omitted,
   *  incoming file offers are ignored. */
  createFileSink?: (offer: FileOfferFrame, contactKey: string) => Promise<IncomingFileSink>;

  presenceIntervalMs?: number; // default 20s
  connectTimeoutMs?: number; // default 15s
  ackTimeoutMs?: number; // ReliableChannel ACK timeout, default 30s
  fileTransfer?: FileTransferOptions;
  /** App-wide relay-only default (per-contact `relayOnly` still wins). */
  relayOnlyByDefault?: boolean;
  now?: () => string;

  /** Durable migration state (ORPAL-008). Required to initiate or resume a
   *  migration across restarts. Omit to disable migration support. */
  migrationStore?: MigrationStore;
  /** Secure key store — needed by the migration manager to swap keys at
   *  retirement. The same store the IdentityManager uses. */
  keyStore?: import("../identity/secure-store.js").SecureKeyStore;
}

export type OrpalEvents = {
  /** A new message was stored (inbound or outbound). */
  message: { message: StoredMessage };
  /** A stored message changed (delivery/transfer state, file progress). */
  "message-updated": { id: string; message: StoredMessage };
  /** A contact's live connection state changed. */
  connection: { contactKey: string; state: ContactState };
  /** File transfer progress. */
  "transfer-progress": { contactKey: string; direction: "in" | "out"; progress: TransferProgress };
  /** Aggregate broker state across all boards. */
  broker: { state: BrokerState; detail?: string };
  /** Pending-queue observability: emitted whenever the queue changes. */
  pending: { metrics: PendingMetrics };
  /** An outbound migration's progress changed (a contact ack'd, phase advanced). */
  "migration-progress": { progress: MigrationProgress };
  /** A contact sent us a key-migration: UI should prompt the user. */
  "migration-incoming": { pending: PendingMigration };
  error: { error: unknown; context: string };
};

interface BoardEntry {
  id: string;
  client: Client;
  state: BrokerState;
}

interface ContactConn {
  contactKey: string;
  /** namespaced board+match key (so match ids can't collide across boards) */
  matchKey: string;
  boardId: string;
  channel: ReliableChannel;
  endpoint: WebRTCEndpoint | null;
  state: ContactState;
  fileReceiver: FileReceiver | null;
}

const SEP = " ";
const mk = (boardId: string, matchId: string): string => boardId + SEP + matchId;

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

  private readonly connections = new Map<string, ContactConn>();
  private readonly matchToCounterparty = new Map<string, string>();
  private readonly endpointsByMatch = new Map<string, WebRTCEndpoint>();
  private readonly connectWaiters = new Map<string, Set<(conn: ContactConn) => void>>();
  private readonly pendingConnects = new Map<string, Promise<ContactConn>>();
  private readonly desiredContacts = new Set<string>();
  private readonly contactRelayOnly = new Map<string, boolean>();
  /** identityKey → pinned b64u transport key, for recipient-sealing (issue #23). */
  private readonly contactTransportKey = new Map<string, string>();
  /** identityKey → per-contact board routing (issue #19); empty lists = all boards. */
  private readonly contactBoards = new Map<string, { preferred: string[]; fallback: string[] }>();
  /** Per-message-id serialization of state updates (see enqueueUpdate). */
  private readonly updateChains = new Map<string, Promise<void>>();

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
      const client = new Client(observingBroker, this.identity, {
        boards_scope: this.boardsScope,
        webrtcFactory: (matchId, role) => this.buildEndpoint(spec.id, matchId, role),
        now: options.now,
      });
      this.boards.push({ id: spec.id, client, state: "connecting" });
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.store.init();
    for (const c of await this.store.listContacts()) {
      this.contactRelayOnly.set(c.identityKey, c.relayOnly);
      this.contactTransportKey.set(c.identityKey, c.transportKey);
      this.rememberContactBoards(c);
    }
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
      // Resume any messages persisted from a previous session (survives reload).
      await this.worker.start();
    }
    if (this.opts.migrationStore && this.opts.keyStore) {
      this.migration = new MigrationManager({
        keyStore: this.opts.keyStore,
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
    for (const conn of this.connections.values()) {
      try {
        conn.endpoint?.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
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

  /** This device's shareable contact card (for QR / paste). */
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
    await this.store.upsertContact(contact);
    this.contactRelayOnly.set(contact.identityKey, contact.relayOnly);
    this.contactTransportKey.set(contact.identityKey, contact.transportKey);
    this.rememberContactBoards(contact);
    return { ok: true, contact };
  }

  listContacts(): Promise<Contact[]> {
    return this.store.listContacts();
  }

  async removeContact(identityKey: string): Promise<void> {
    await this.store.removeContact(identityKey);
    this.contactRelayOnly.delete(identityKey);
    this.contactTransportKey.delete(identityKey);
    this.contactBoards.delete(identityKey);
  }

  /**
   * Set the per-contact board routes (issue #19). With at least one board listed,
   * delivery attempts for this contact use ONLY those boards (preferred first,
   * then fallback); clear both lists to restore the all-boards default. Takes
   * effect on the NEXT connection — call `connect(identityKey)` to apply now.
   */
  async setContactBoards(
    identityKey: string,
    boards: { preferredBoards?: string[]; fallbackBoards?: string[] },
  ): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    contact.preferredBoards = boards.preferredBoards ?? [];
    contact.fallbackBoards = boards.fallbackBoards ?? [];
    await this.store.upsertContact(contact);
    this.rememberContactBoards(contact);
  }

  private rememberContactBoards(contact: Contact): void {
    this.contactBoards.set(contact.identityKey, {
      preferred: contact.preferredBoards ?? [],
      fallback: contact.fallbackBoards ?? [],
    });
  }

  /**
   * The boards a contact may be reached on (issue #19). When the contact has a
   * non-empty route config, only those boards (that we actually run) are used,
   * preferred first; otherwise we fan out to ALL boards (the global default).
   */
  private boardsForContact(contactKey: string): BoardEntry[] {
    const cfg = this.contactBoards.get(contactKey);
    if (!cfg || (cfg.preferred.length === 0 && cfg.fallback.length === 0)) {
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
    return chosen; // configured ∩ available — possibly empty (contact unreachable)
  }

  /** Toggle relay-only (SPEC §6) for a contact. Takes effect on the NEXT
   *  connection; call `connect(contactKey)` after to apply. */
  async setContactRelayOnly(identityKey: string, relayOnly: boolean): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    contact.relayOnly = relayOnly;
    await this.store.upsertContact(contact);
    this.contactRelayOnly.set(identityKey, relayOnly);
  }

  // ---- migration (ORPAL-008) ------------------------------------------------

  /** Whether an outbound migration is currently in progress. */
  get migrationActive(): boolean {
    return this.migration?.active ?? false;
  }

  /** Current migration progress (null if no migration is active). */
  get migrationProgress(): MigrationProgress | null {
    return this.migration?.progress ?? null;
  }

  /** Pending incoming migrations awaiting user confirmation. */
  get pendingIncomingMigrations(): readonly PendingMigration[] {
    return this.migration?.pendingMigrations ?? [];
  }

  /**
   * Start an identity migration: generate a new identity, notify all contacts,
   * and enter the dual-validity window.
   * @param retireAfterUtc ISO-8601 cutoff when the old key stops working.
   */
  async startMigration(retireAfterUtc: string): Promise<void> {
    if (!this.migration) throw new Error("Migration not configured (provide migrationStore + keyStore).");
    const contacts = await this.store.listContacts();
    const { migration } = await this.migration.startMigration(this.identity, contacts, retireAfterUtc);

    const frame = encodeAppFrame({ v: 1, t: "key-migration", migration: migration as unknown as Record<string, unknown> });
    let sent = 0;
    for (const contact of contacts) {
      const conn = this.connections.get(contact.identityKey);
      if (conn && conn.state === "connected") {
        conn.channel.send(frame).catch(() => {});
        sent++;
      }
    }

    await this.migration.markNotified();
    const progress = this.migration.progress;
    if (progress) this.events.emit("migration-progress", { progress });
  }

  /**
   * Accept an incoming migration from a contact (user confirmed the prompt).
   * Updates the stored contact to the new key and sends back a migration_ack.
   */
  async acceptMigration(contactKey: string): Promise<boolean> {
    if (!this.migration) return false;
    const result = this.migration.acceptIncomingMigration(contactKey);
    if (!result.accepted || !result.migration || !result.newContact) return false;

    const oldContact = await this.store.getContact(contactKey);
    if (oldContact && result.newContact.identityKey) {
      const updated: Contact = {
        ...oldContact,
        identityKey: result.newContact.identityKey,
        transportKey: result.newContact.transportKey!,
        binding: result.newContact.binding!,
      };
      await this.store.upsertContact(updated);
      this.contactRelayOnly.set(updated.identityKey, updated.relayOnly);
      this.contactTransportKey.set(updated.identityKey, updated.transportKey);
      this.rememberContactBoards(updated);
    }

    const ack = this.migration.buildMigrationAck(this.identity, result.migration);
    const conn = this.connections.get(contactKey);
    if (conn && conn.state === "connected") {
      conn.channel
        .send(encodeAppFrame({ v: 1, t: "migration-ack", ack: ack as unknown as Record<string, unknown> }))
        .catch(() => {});
    }
    return true;
  }

  /** Decline an incoming migration from a contact. */
  declineMigration(contactKey: string): void {
    this.migration?.declineIncomingMigration(contactKey);
  }

  /**
   * Retire the old identity: swap keys in secure storage and finalize. Call this
   * when the retirement date has passed. WARNING: old message history sealed to
   * the old transport key becomes unreadable.
   */
  async retireMigration(): Promise<void> {
    if (!this.migration) return;
    await this.migration.retire();
    const progress = this.migration.progress;
    if (progress) this.events.emit("migration-progress", { progress });
  }

  // ---- sending -------------------------------------------------------------

  /** Send a text message. The returned id tracks the message in history; delivery
   *  state is reported via `message-updated` events (delivered on ACK, or failed
   *  on timeout / offline). */
  async sendText(contactKey: string, text: string): Promise<string> {
    const id = newId();
    const ts = Date.now();
    const transportKey = this.contactTransportKey.get(contactKey);
    const message: StoredMessage = {
      id,
      contactKey,
      direction: "out",
      kind: "text",
      text,
      ts,
      // Lifecycle (issue #22): queued in the durable queue, else sending now.
      state: this.worker ? "queued" : "sending",
    };
    await this.store.appendMessage(message);
    this.events.emit("message", { message });

    // Recipient-sealing (issue #23) needs the pinned transport key. Fail closed
    // rather than send an unsealed payload — you must add the peer as a contact.
    if (!transportKey) {
      await this.markMessage(contactKey, id, { state: "failed" });
      this.events.emit("error", { error: new NoPinnedKeyError(contactKey), context: "sendText:seal" });
      return id;
    }

    // With the durable pending-queue enabled, hand delivery to the worker: it
    // persists the message (with the transport key, so it can re-seal across
    // reloads) and retries (presence-based, then blind backoff) until an awk
    // arrives — so an offline recipient never loses it and we don't mark it
    // failed. The message stays queued/sending until its awk flips it to ack'd.
    if (this.worker) {
      const pending: PendingMessage = {
        recipientId: contactKey,
        recipientTransportKey: transportKey,
        messageId: id,
        timestamp: ts,
        attemptCount: 0,
        lastAttemptAt: null,
        payload: { kind: "text", text },
      };
      await this.worker.enqueue(pending);
      return id;
    }

    let conn: ContactConn;
    try {
      conn = await this.ensureConnection(contactKey);
    } catch (err) {
      await this.markMessage(contactKey, id, { state: "failed" });
      if (!(err instanceof OfflineError)) {
        this.events.emit("error", { error: err, context: "sendText:connect" });
      }
      return id;
    }

    conn.channel
      .send(this.encodeSealed(transportKey, { v: 1, t: "text", id, text, ts }))
      .then(() => this.markMessage(contactKey, id, { state: "delivered" }))
      .catch(() => this.markMessage(contactKey, id, { state: "failed" }));
    return id;
  }

  /**
   * Worker callback: attempt to deliver one queued message over a live channel.
   * Returns true if the frame was dispatched (now awaiting its awk), false if the
   * contact is offline right now. A transport timeout throws and is retried.
   */
  private async attemptDelivery(msg: PendingMessage): Promise<boolean> {
    let conn: ContactConn;
    try {
      conn = await this.ensureConnection(msg.recipientId);
    } catch (err) {
      if (err instanceof OfflineError) return false; // retry later (stays "queued")
      throw err; // unexpected — treat as a failed attempt
    }
    // A live channel exists: mark attempting, seal to the recipient (issue #23),
    // and on the §11 ACK mark delivered (issue #22). It stays queued + retried
    // until the app-level awk flips it to "acknowledged" (covers a lost awk).
    await this.markMessage(msg.recipientId, msg.messageId, { state: "sending" });
    await conn.channel.send(
      this.encodeSealed(msg.recipientTransportKey, {
        v: 1,
        t: "text",
        id: msg.messageId,
        text: msg.payload.text,
        ts: msg.timestamp,
      }),
    );
    await this.markMessage(msg.recipientId, msg.messageId, { state: "delivered" });
    return true;
  }

  /** Re-send a previously failed text message (the "failed, retry?" action). */
  async retryText(messageId: string, contactKey: string): Promise<void> {
    const rows = await this.store.listMessages(contactKey);
    const msg = rows.find((m) => m.id === messageId);
    if (!msg || msg.kind !== "text" || msg.direction !== "out" || msg.text === undefined) return;
    const transportKey = this.contactTransportKey.get(contactKey);
    if (!transportKey) {
      await this.markMessage(contactKey, messageId, { state: "failed" });
      this.events.emit("error", { error: new NoPinnedKeyError(contactKey), context: "retryText:seal" });
      return;
    }
    await this.markMessage(contactKey, messageId, { state: "sending" });
    try {
      const conn = await this.ensureConnection(contactKey);
      conn.channel
        .send(this.encodeSealed(transportKey, { v: 1, t: "text", id: messageId, text: msg.text, ts: msg.ts }))
        .then(() => this.markMessage(contactKey, messageId, { state: "delivered" }))
        .catch(() => this.markMessage(contactKey, messageId, { state: "failed" }));
    } catch {
      await this.markMessage(contactKey, messageId, { state: "failed" });
    }
  }

  /** Send a file. Progress is reported via `transfer-progress`/`message-updated`. */
  async sendFile(contactKey: string, source: FileSource): Promise<string> {
    const fileId = newId();
    const ts = Date.now();
    const ft = this.opts.fileTransfer ?? {};
    const chunkSize = ft.chunkSize ?? 16 * 1024;
    const chunks = source.size === 0 ? 0 : Math.ceil(source.size / chunkSize);
    const message: StoredMessage = {
      id: fileId,
      contactKey,
      direction: "out",
      kind: "file",
      ts,
      state: "sending",
      file: {
        fileId,
        name: source.name,
        size: source.size,
        mime: source.mime,
        sha256: "",
        chunkSize,
        chunks,
        state: "transferring",
        transferred: 0,
      },
    };
    await this.store.appendMessage(message);
    this.events.emit("message", { message });

    const transportKey = this.contactTransportKey.get(contactKey);
    if (!transportKey) {
      await this.markFile(contactKey, fileId, { state: "failed" }, "failed");
      this.events.emit("error", { error: new NoPinnedKeyError(contactKey), context: "sendFile:seal" });
      return fileId;
    }

    let conn: ContactConn;
    try {
      conn = await this.ensureConnection(contactKey);
    } catch (err) {
      await this.markFile(contactKey, fileId, { state: "failed" }, "failed");
      if (!(err instanceof OfflineError)) {
        this.events.emit("error", { error: err, context: "sendFile:connect" });
      }
      return fileId;
    }

    // Seal the file-offer to the recipient (issue #23); chunks/done ride the
    // already-encrypted SecureChannel and are bound to the sealed offer by fileId.
    const sender: AckedSender = {
      sendFrame: (frame: AppFrame) => conn.channel.send(this.maybeSealOutbound(transportKey, frame)),
    };

    sendFile(sender, source, {
      ...ft,
      fileId,
      onProgress: (p) => {
        void this.markFile(contactKey, fileId, { transferred: p.transferred, state: "transferring" });
        this.events.emit("transfer-progress", { contactKey, direction: "out", progress: p });
      },
    })
      .then((res) =>
        this.markFile(contactKey, fileId, { state: "complete", sha256: res.sha256 }, "delivered"),
      )
      .catch((err) => {
        void this.markFile(contactKey, fileId, { state: "failed" }, "failed");
        this.events.emit("error", { error: err, context: "sendFile" });
      });
    return fileId;
  }

  // ---- connection management ----------------------------------------------

  /** Proactively connect (or reconnect) to a contact. */
  async connect(contactKey: string): Promise<void> {
    await this.ensureConnection(contactKey);
  }

  contactState(contactKey: string): ContactState {
    return this.connections.get(contactKey)?.state ?? "unknown";
  }

  private ensureConnection(contactKey: string): Promise<ContactConn> {
    const existing = this.connections.get(contactKey);
    if (existing && existing.state === "connected") return Promise.resolve(existing);

    const inflight = this.pendingConnects.get(contactKey);
    if (inflight) return inflight;

    const promise = new Promise<ContactConn>((resolve, reject) => {
      const waiter = (conn: ContactConn) => {
        clearTimeout(timer);
        this.removeConnectWaiter(contactKey, waiter);
        this.pendingConnects.delete(contactKey);
        resolve(conn);
      };
      const timer = setTimeout(() => {
        this.removeConnectWaiter(contactKey, waiter);
        this.pendingConnects.delete(contactKey);
        // No match in time ⇒ the contact is offline/unreachable right now
        // (no store-and-forward). Surface it so the UI can say so.
        if (this.connections.get(contactKey)?.state !== "connected") {
          this.setContactState(contactKey, "down");
        }
        reject(new OfflineError(contactKey));
      }, this.connectTimeoutMs);

      this.addConnectWaiter(contactKey, waiter);
      this.desiredContacts.add(contactKey);
      this.setContactState(contactKey, "connecting");
      // Fan the intent out to the contact's configured boards — or to EVERY board
      // when the contact has no per-contact routes (issue #19).
      const boards = this.boardsForContact(contactKey);
      if (boards.length === 0) {
        this.events.emit("error", {
          error: new Error(`contact ${contactKey} has board routes configured but none are loaded`),
          context: "ensureConnection:no-board",
        });
      }
      for (const board of boards) board.client.sendIntent(contactKey);
    });
    this.pendingConnects.set(contactKey, promise);
    return promise;
  }

  // ---- broker observation + reconnect -------------------------------------

  private observeOutbound(boardId: string, msg: Outbound): void {
    if (msg.kind === "match") {
      this.matchToCounterparty.set(mk(boardId, msg.match_id), msg.counterparty_key);
    }
    // ack/rejected/evicted/relay/channel_closed are handled by the reference Client.
  }

  /** Latest AGGREGATE broker state — online if any board is up. Lets a shell seed
   *  its UI even if it subscribes after the first `open` already fired. */
  get brokerStatus(): BrokerState {
    return this.brokerStateValue;
  }

  /** A shell calls this from a board's onOpen hook (re-rendezvous on reconnect:
   *  re-announce presence and re-initiate intents for contacts we still want). */
  onBrokerOpen(boardId?: string): void {
    const board = this.resolveBoard(boardId);
    if (board) board.state = "open";
    this.recomputeBrokerState();
    if (!this.started) return;
    if (board) {
      this.announcePresenceOn(board);
      for (const key of this.desiredContacts) {
        const conn = this.connections.get(key);
        if (conn && conn.state === "connected") continue;
        // Only re-initiate over a board this contact actually routes on (#19).
        if (this.boardsForContact(key).some((b) => b.id === board.id)) {
          board.client.sendIntent(key);
        }
      }
    }
    // A board reconnected: re-attempt the whole pending queue (a recipient that
    // was unreachable while the board was down may be reachable again now).
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
    const agg: BrokerState = states.includes("open")
      ? "open"
      : states.includes("connecting")
        ? "connecting"
        : states.includes("error")
          ? "error"
          : "closed";
    this.brokerStateValue = agg;
    this.events.emit("broker", { state: agg, detail });
  }

  // ---- internals -----------------------------------------------------------

  private announcePresence(): void {
    for (const board of this.boards) this.announcePresenceOn(board);
  }

  private announcePresenceOn(board: BoardEntry): void {
    try {
      board.client.announcePresence(this.boardsScope);
    } catch (err) {
      this.events.emit("error", { error: err, context: "announcePresence" });
    }
  }

  private buildEndpoint(
    boardId: string,
    matchId: string,
    role: "initiator" | "responder",
  ): WebRTCEndpoint {
    const key = mk(boardId, matchId);
    if (this.opts.webrtcFactory) {
      const ep = this.opts.webrtcFactory(matchId, role);
      this.endpointsByMatch.set(key, ep);
      return ep;
    }
    const counterpartyKey = this.matchToCounterparty.get(key);
    const relayOnly =
      (counterpartyKey ? this.contactRelayOnly.get(counterpartyKey) : undefined) ??
      this.opts.relayOnlyByDefault ??
      false;
    const ep = new BrowserWebRTCEndpoint(matchId, role, {
      iceServers: this.opts.iceServers,
      iceTransportPolicy: relayOnly ? "relay" : "all",
      onConnectionStateChange: (state) => this.handleEndpointState(key, state),
    });
    this.endpointsByMatch.set(key, ep);
    return ep;
  }

  private armConnectionLoop(board: BoardEntry): void {
    board.client
      .waitForConnection()
      .then((info) => {
        this.armConnectionLoop(board); // re-arm before handling so we don't miss the next
        void this.handleConnected(board, info);
      })
      .catch((err) => this.events.emit("error", { error: err, context: "waitForConnection" }));
  }

  private async handleConnected(board: BoardEntry, info: ConnectedInfo): Promise<void> {
    const contactKey = info.counterparty_key;
    const matchKey = mk(board.id, info.match_id);

    const existing = this.connections.get(contactKey);
    if (existing && existing.matchKey !== matchKey) {
      if (existing.state === "connected") {
        // Already connected (possibly via another board) — drop this duplicate.
        this.endpointsByMatch.get(matchKey)?.close();
        return;
      }
      existing.endpoint?.close(); // replace a stale/down connection
    }

    const channel = new ReliableChannel(info.channel, { ackTimeoutMs: this.ackTimeoutMs });
    channel.onMessage((text) => void this.handleIncomingFrame(contactKey, text));

    const fileReceiver = this.opts.createFileSink ? this.buildFileReceiver(contactKey) : null;

    const conn: ContactConn = {
      contactKey,
      matchKey,
      boardId: board.id,
      channel,
      endpoint: this.endpointsByMatch.get(matchKey) ?? null,
      state: "connected",
      fileReceiver,
    };
    this.connections.set(contactKey, conn);
    this.setContactState(contactKey, "connected");
    this.resolveConnectWaiters(contactKey, conn);
    // Presence-based delivery (preferred): the contact is reachable now — drain
    // anything queued for them immediately, ahead of any blind-retry backoff.
    void this.worker?.flushRecipient(contactKey);
  }

  private buildFileReceiver(contactKey: string): FileReceiver {
    return new FileReceiver({
      createSink: async (offer: FileOfferFrame): Promise<FileSink> => {
        const message: StoredMessage = {
          id: offer.fileId,
          contactKey,
          direction: "in",
          kind: "file",
          ts: offer.ts,
          state: "delivered",
          file: {
            fileId: offer.fileId,
            name: offer.name,
            size: offer.size,
            mime: offer.mime,
            sha256: offer.sha256,
            chunkSize: offer.chunkSize,
            chunks: offer.chunks,
            state: "transferring",
            transferred: 0,
          },
        };
        await this.store.appendMessage(message);
        this.events.emit("message", { message });
        const incoming = await this.opts.createFileSink!(offer, contactKey);
        if (incoming.path) {
          await this.markFile(contactKey, offer.fileId, { path: incoming.path });
        }
        return incoming.sink;
      },
      onProgress: (p) => {
        void this.markFile(contactKey, p.fileId, { transferred: p.transferred, state: "transferring" });
        this.events.emit("transfer-progress", { contactKey, direction: "in", progress: p });
      },
      onComplete: (outcome) => {
        if (outcome.ok) {
          void this.markFile(contactKey, outcome.fileId, { state: "complete" });
        } else {
          void this.markFile(contactKey, outcome.fileId, {
            state: outcome.reason === "integrity-failed" ? "integrity-failed" : "failed",
          });
        }
      },
    });
  }

  private async handleIncomingFrame(contactKey: string, text: string): Promise<void> {
    const outer = decodeAppFrame(text);
    if (!outer) return;
    // Recipient-sealed envelope (issue #23): open it with our own transport key.
    // A failed open (wrong key / tampered / fake peer) returns null — drop it
    // WITHOUT displaying, storing, or acknowledging anything.
    if (outer.t === "sealed") {
      const inner = openSealedFrame(outer, this.identity.transportPrivate(), this.identity.transportPub);
      if (!inner) {
        this.events.emit("error", {
          error: new Error("sealed message failed to decrypt; dropped"),
          context: "handleIncomingFrame:unseal",
        });
        return;
      }
      await this.processFrame(contactKey, inner);
      return;
    }
    await this.processFrame(contactKey, outer);
  }

  /** Dispatch a decoded (and, if applicable, unsealed) inbound app frame. */
  private async processFrame(contactKey: string, frame: AppFrame | SealablePayload): Promise<void> {
    switch (frame.t) {
      case "text": {
        // Retries can re-deliver the same id (a previous awk was lost). Store it
        // exactly once (issue #18 idempotency), but ALWAYS re-send the awk so the
        // sender can stop. Globally-unique ids make this dedup reliable.
        const already = (await this.store.listMessages(contactKey)).some((m) => m.id === frame.id);
        if (!already) {
          const message: StoredMessage = {
            id: frame.id,
            contactKey,
            direction: "in",
            kind: "text",
            text: frame.text,
            ts: frame.ts,
            state: "delivered",
          };
          await this.store.appendMessage(message);
          this.events.emit("message", { message });
        }
        this.sendAwk(contactKey, frame.id);
        return;
      }
      case "awk": {
        // The recipient confirmed app-level receipt (issue #22 "acknowledged"):
        // drop it from the pending queue (if in use) and mark it acknowledged.
        if (this.worker) {
          const removed = await this.worker.acknowledge(frame.id);
          if (removed) await this.markMessage(contactKey, frame.id, { state: "acknowledged" });
        } else {
          await this.markMessage(contactKey, frame.id, { state: "acknowledged" });
        }
        return;
      }
      case "file-offer": {
        const conn = this.connections.get(contactKey);
        if (!conn?.fileReceiver) return; // file receiving not configured — ignore
        // Suppress a duplicate offer for an in-progress/known transfer (issue #18).
        const already = (await this.store.listMessages(contactKey)).some((m) => m.id === frame.fileId);
        if (already) return;
        await conn.fileReceiver.onOffer(frame);
        return;
      }
      case "file-chunk": {
        const conn = this.connections.get(contactKey);
        await conn?.fileReceiver?.onChunk(frame);
        return;
      }
      case "file-done": {
        const conn = this.connections.get(contactKey);
        await conn?.fileReceiver?.onDone(frame.fileId);
        return;
      }
      case "key-migration": {
        if (!this.migration) return;
        const contact = await this.store.getContact(contactKey);
        const name = contact?.displayName ?? contactKey;
        const result = this.migration.handleIncomingMigration(frame.migration, contactKey, name);
        if (!result.valid) {
          this.events.emit("error", {
            error: new Error(`Invalid key-migration from ${contactKey}: ${result.reason}`),
            context: "processFrame:key-migration",
          });
          return;
        }
        // Auto-accept: send cryptographic challenges to both transport keys.
        // If both come back, we know the same entity holds both keys and
        // auto-accept without prompting the user.
        const oldTk = this.contactTransportKey.get(contactKey);
        const conn = this.connections.get(contactKey);
        if (oldTk && conn && conn.state === "connected") {
          const challenges = this.migration.createChallenges(contactKey, oldTk);
          if (challenges) {
            for (const c of challenges) {
              conn.channel
                .send(encodeAppFrame({
                  v: 1,
                  t: "migration-challenge",
                  target: c.target,
                  sealed_nonce: c.sealedNonceB64,
                  ack_pubkey: c.ackPubkeyB64,
                }))
                .catch(() => {});
            }
            return; // wait for challenge responses before prompting
          }
        }
        // Fallback: no transport key or no connection — surface manual prompt.
        const pending = this.migration.pendingMigrations;
        const latest = pending[pending.length - 1];
        if (latest) this.events.emit("migration-incoming", { pending: latest });
        return;
      }
      case "migration-challenge": {
        // We are the migrating party: a contact is challenging us to prove we
        // hold both transport keys. Decrypt the nonce and echo it back.
        if (!this.migration?.active) return;
        const echo = this.migration.answerChallenge(
          this.identity,
          frame.target,
          frame.sealed_nonce,
          frame.ack_pubkey,
        );
        if (!echo) return;
        const conn = this.connections.get(contactKey);
        if (conn && conn.state === "connected") {
          conn.channel
            .send(encodeAppFrame({
              v: 1,
              t: "migration-challenge-response",
              target: frame.target,
              sealed_echo: echo,
            }))
            .catch(() => {});
        }
        return;
      }
      case "migration-challenge-response": {
        // We are the recipient: verify the echo proves transport key control.
        if (!this.migration) return;
        const { bothVerified, valid } = this.migration.verifyChallengeResponse(
          contactKey,
          frame.target,
          frame.sealed_echo,
        );
        if (!valid) {
          this.events.emit("error", {
            error: new Error(`Invalid challenge response from ${contactKey} (target: ${frame.target})`),
            context: "processFrame:migration-challenge-response",
          });
        }
        if (bothVerified) {
          // Both challenges passed — auto-accept the migration.
          const accepted = await this.acceptMigration(contactKey);
          if (accepted) {
            this.events.emit("migration-progress", {
              progress: this.migration.progress!,
            });
          }
        }
        return;
      }
      case "migration-ack": {
        if (!this.migration) return;
        const accepted = await this.migration.handleMigrationAck(frame.ack, contactKey);
        if (accepted) {
          const progress = this.migration.progress;
          if (progress) this.events.emit("migration-progress", { progress });
        }
        return;
      }
    }
  }

  private handleEndpointState(matchKey: string, state: RtcConnectionState): void {
    const contactKey = this.matchToCounterparty.get(matchKey);
    if (!contactKey) return;
    const conn = this.connections.get(contactKey);
    if (!conn || conn.matchKey !== matchKey) return;
    if (state === "connected") {
      this.setContactState(contactKey, "connected");
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      conn.state = "down";
      this.setContactState(contactKey, "down");
    }
  }

  // ---- small helpers -------------------------------------------------------

  private setContactState(contactKey: string, state: ContactState): void {
    this.events.emit("connection", { contactKey, state });
  }

  /** Seal a text/file-offer frame to a recipient's pinned transport key and
   *  encode it for the wire (issue #23). */
  private encodeSealed(transportKey: string, frame: SealablePayload): string {
    return encodeAppFrame(sealAppFrame(frame, transportKey));
  }

  /** Seal the sealable frames (text, file-offer); pass others through unsealed
   *  (awk has no content; file chunks ride the encrypted SecureChannel). */
  private maybeSealOutbound(transportKey: string, frame: AppFrame): string {
    if (frame.t === "text" || frame.t === "file-offer") {
      return this.encodeSealed(transportKey, frame);
    }
    return encodeAppFrame(frame);
  }

  /** Acknowledge a received message back to its sender (best-effort: a failed awk
   *  just means the sender retries and we awk again). */
  private sendAwk(contactKey: string, messageId: string): void {
    const conn = this.connections.get(contactKey);
    if (!conn || conn.state !== "connected") return;
    conn.channel
      .send(encodeAppFrame({ v: 1, t: "awk", id: messageId, ts: Date.now() }))
      .catch(() => {
        /* sender will retry; we'll awk again on the next copy */
      });
  }

  private addConnectWaiter(contactKey: string, waiter: (conn: ContactConn) => void): void {
    let set = this.connectWaiters.get(contactKey);
    if (!set) {
      set = new Set();
      this.connectWaiters.set(contactKey, set);
    }
    set.add(waiter);
  }

  private removeConnectWaiter(contactKey: string, waiter: (conn: ContactConn) => void): void {
    this.connectWaiters.get(contactKey)?.delete(waiter);
  }

  private resolveConnectWaiters(contactKey: string, conn: ContactConn): void {
    const set = this.connectWaiters.get(contactKey);
    if (!set) return;
    this.connectWaiters.delete(contactKey);
    for (const waiter of set) waiter(conn);
  }

  /**
   * Serialize all mutations of a given message id through a per-id promise chain.
   * Without this, two near-simultaneous transitions (e.g. the §11 ACK marking
   * "delivered" and the app awk marking "acknowledged") interleave at their await
   * points and the read-after-write can emit the wrong/regressed state — so an
   * observer waiting on the transient "delivered" never sees it. Chaining keeps
   * the store write + the emitted event in causal order, one transition at a time.
   */
  private enqueueUpdate(id: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.updateChains.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.updateChains.set(id, tail);
    void tail.then(() => {
      if (this.updateChains.get(id) === tail) this.updateChains.delete(id);
    });
    return run;
  }

  private markMessage(
    contactKey: string,
    id: string,
    patch: Partial<Pick<StoredMessage, "state" | "text" | "file">>,
  ): Promise<void> {
    return this.enqueueUpdate(id, async () => {
      await this.store.updateMessage(id, patch);
      const message = (await this.store.listMessages(contactKey)).find((m) => m.id === id);
      if (message) this.events.emit("message-updated", { id, message });
    });
  }

  private markFile(
    contactKey: string,
    fileId: string,
    filePatch: Partial<NonNullable<StoredMessage["file"]>>,
    state?: StoredMessage["state"],
  ): Promise<void> {
    return this.enqueueUpdate(fileId, async () => {
      const current = (await this.store.listMessages(contactKey)).find((m) => m.id === fileId);
      if (!current?.file) return;
      const file = { ...current.file, ...filePatch };
      const patch: Partial<Pick<StoredMessage, "state" | "file">> = { file };
      if (state) patch.state = state;
      await this.store.updateMessage(fileId, patch);
      const message = (await this.store.listMessages(contactKey)).find((m) => m.id === fileId);
      if (message) this.events.emit("message-updated", { id: fileId, message });
    });
  }

  history(contactKey: string, opts?: { limit?: number; before?: number }): Promise<StoredMessage[]> {
    return this.store.listMessages(contactKey, opts);
  }

  /** Snapshot of the offline-delivery pending queue (total + oldest pending), for
   *  local observability/debugging. Empty when no pending-queue is configured. */
  async pendingMetrics(): Promise<PendingMetrics> {
    if (this.worker) return this.worker.metrics();
    return computePendingMetrics([]);
  }
}
