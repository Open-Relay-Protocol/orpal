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
// PER-CONTACT POLICY TRICK: the reference Client's webrtcFactory(matchId, role)
// isn't told the counterparty key, but relay-only is a per-CONTACT choice. We wrap
// the broker so we observe each board→client message (and record match_id →
// counterparty_key) BEFORE the reference Client's handler runs and calls our
// factory — so by the time the factory builds the endpoint, it knows the contact
// and can pick "all" vs "relay". This also gives us one place to watch broker
// lifecycle for reconnect-driven re-rendezvous.

import { randomBytes } from "@noble/hashes/utils";
import {
  Client,
  ReliableChannel,
  b64uEncode,
} from "../orp.js";
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
import {
  BrowserWebRTCEndpoint,
  type RtcConnectionState,
} from "../rtc/browser-webrtc.js";
import type { Contact } from "../contacts/contact.js";
import {
  contactFromCard,
  parseContactCard,
  serializeContactCard,
} from "../contacts/contact.js";
import type { ConversationStore, StoredMessage } from "../persistence/conversation-store.js";
import {
  decodeAppFrame,
  encodeAppFrame,
  type AppFrame,
  type FileOfferFrame,
} from "./frames.js";
import {
  FileReceiver,
  sendFile,
  type AckedSender,
  type FileSink,
  type FileSource,
  type FileTransferOptions,
  type TransferProgress,
} from "../transfer/file-transfer.js";

export type ContactState = "connected" | "connecting" | "down" | "unknown";

/** Thrown/used when a contact can't be reached within the connect timeout —
 *  the no-store-and-forward reality: if they're not online now, we can't deliver. */
export class OfflineError extends Error {
  constructor(public readonly contactKey: string) {
    super(`Contact ${contactKey} is offline or unreachable (no store-and-forward).`);
    this.name = "OfflineError";
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

  /** A constructed RendezvousBroker. Shells pass a BrowserRendezvousBroker wired
   *  with lifecycle hooks (its onOpen → orpal.onBrokerOpen for reconnect
   *  re-rendezvous); tests inject a mock broker. */
  broker: RendezvousBroker;

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
  /** Broker socket lifecycle. */
  broker: { state: "open" | "closed" | "error"; detail?: string };
  error: { error: unknown; context: string };
};

interface ContactConn {
  contactKey: string;
  matchId: string;
  channel: ReliableChannel;
  endpoint: WebRTCEndpoint | null;
  state: ContactState;
  fileReceiver: FileReceiver | null;
}

function newId(): string {
  return b64uEncode(randomBytes(16));
}

export class OrpalClient {
  readonly identity: DeviceIdentity;
  readonly events = new TypedEmitter<OrpalEvents>();

  private readonly store: ConversationStore;
  private readonly client: Client;
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

  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private brokerStateValue: "connecting" | "open" | "closed" | "error" = "connecting";

  constructor(options: OrpalClientOptions) {
    this.opts = options;
    this.identity = options.identity;
    this.store = options.store;
    this.boardsScope = options.boardsScope ?? ["default"];
    this.presenceIntervalMs = options.presenceIntervalMs ?? 20_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 30_000;

    const innerBroker = options.broker;
    const observingBroker: RendezvousBroker = {
      connect: (onOutbound: (msg: Outbound) => void): BoardConnection =>
        innerBroker.connect((msg) => {
          this.observeOutbound(msg);
          onOutbound(msg);
        }),
    };

    this.client = new Client(observingBroker, this.identity, {
      boards_scope: this.boardsScope,
      webrtcFactory: (matchId, role) => this.buildEndpoint(matchId, role),
      now: options.now,
    });
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.store.init();
    for (const c of await this.store.listContacts()) {
      this.contactRelayOnly.set(c.identityKey, c.relayOnly);
    }
    this.armConnectionLoop();
    this.announcePresence();
    this.presenceTimer = setInterval(() => this.announcePresence(), this.presenceIntervalMs);
  }

  close(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    for (const conn of this.connections.values()) {
      try {
        conn.endpoint?.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    this.client.close();
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
    return { ok: true, contact };
  }

  listContacts(): Promise<Contact[]> {
    return this.store.listContacts();
  }

  async removeContact(identityKey: string): Promise<void> {
    await this.store.removeContact(identityKey);
    this.contactRelayOnly.delete(identityKey);
  }

  /** Toggle relay-only (SPEC §6) for a contact. Takes effect on the NEXT
   *  connection; call `reconnect(contactKey)` to apply immediately. */
  async setContactRelayOnly(identityKey: string, relayOnly: boolean): Promise<void> {
    const contact = await this.store.getContact(identityKey);
    if (!contact) return;
    contact.relayOnly = relayOnly;
    await this.store.upsertContact(contact);
    this.contactRelayOnly.set(identityKey, relayOnly);
  }

  // ---- sending -------------------------------------------------------------

  /** Send a text message. The returned id tracks the message in history; delivery
   *  state is reported via `message-updated` events (delivered on ACK, or failed
   *  on timeout / offline). */
  async sendText(contactKey: string, text: string): Promise<string> {
    const id = newId();
    const ts = Date.now();
    const message: StoredMessage = {
      id,
      contactKey,
      direction: "out",
      kind: "text",
      text,
      ts,
      state: "sending",
    };
    await this.store.appendMessage(message);
    this.events.emit("message", { message });

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
      .send(encodeAppFrame({ v: 1, t: "text", id, text, ts }))
      .then(() => this.markMessage(contactKey, id, { state: "delivered" }))
      .catch(() => this.markMessage(contactKey, id, { state: "failed" }));
    return id;
  }

  /** Re-send a previously failed text message (the "failed, retry?" action). */
  async retryText(messageId: string, contactKey: string): Promise<void> {
    const rows = await this.store.listMessages(contactKey);
    const msg = rows.find((m) => m.id === messageId);
    if (!msg || msg.kind !== "text" || msg.direction !== "out" || msg.text === undefined) return;
    await this.markMessage(contactKey, messageId, { state: "sending" });
    try {
      const conn = await this.ensureConnection(contactKey);
      conn.channel
        .send(encodeAppFrame({ v: 1, t: "text", id: messageId, text: msg.text, ts: msg.ts }))
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

    const sender: AckedSender = {
      sendFrame: (frame: AppFrame) => conn.channel.send(encodeAppFrame(frame)),
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
      // Intent matches only if the contact's presence is on the board right now.
      this.client.sendIntent(contactKey);
    });
    this.pendingConnects.set(contactKey, promise);
    return promise;
  }

  // ---- broker observation + reconnect -------------------------------------

  private observeOutbound(msg: Outbound): void {
    switch (msg.kind) {
      case "match":
        this.matchToCounterparty.set(msg.match_id, msg.counterparty_key);
        break;
      case "channel_closed":
        // Signaling channel torn down (normal after the answer relay); the data
        // channel is independent, so nothing to do here.
        break;
      // ack/rejected/evicted/relay are handled by the reference Client; we don't
      // duplicate that logic.
    }
  }

  /** Latest broker socket state — lets a shell seed its UI even if it subscribes
   *  to the `broker` event after the first `open` already fired. */
  get brokerStatus(): "connecting" | "open" | "closed" | "error" {
    return this.brokerStateValue;
  }

  /** A shell calls this from the broker's onOpen hook (re-rendezvous on reconnect:
   *  re-announce presence and re-initiate intents for contacts we still want). */
  onBrokerOpen(): void {
    this.brokerStateValue = "open";
    this.events.emit("broker", { state: "open" });
    if (!this.started) return;
    this.announcePresence();
    for (const key of this.desiredContacts) {
      const conn = this.connections.get(key);
      if (!conn || conn.state !== "connected") {
        this.client.sendIntent(key);
      }
    }
  }

  onBrokerClose(detail?: string): void {
    this.brokerStateValue = "closed";
    this.events.emit("broker", { state: "closed", detail });
  }

  onBrokerError(detail?: string): void {
    this.brokerStateValue = "error";
    this.events.emit("broker", { state: "error", detail });
  }

  // ---- internals -----------------------------------------------------------

  private announcePresence(): void {
    try {
      this.client.announcePresence(this.boardsScope);
    } catch (err) {
      this.events.emit("error", { error: err, context: "announcePresence" });
    }
  }

  private buildEndpoint(matchId: string, role: "initiator" | "responder"): WebRTCEndpoint {
    if (this.opts.webrtcFactory) {
      const ep = this.opts.webrtcFactory(matchId, role);
      this.endpointsByMatch.set(matchId, ep);
      return ep;
    }
    const counterpartyKey = this.matchToCounterparty.get(matchId);
    const relayOnly =
      (counterpartyKey ? this.contactRelayOnly.get(counterpartyKey) : undefined) ??
      this.opts.relayOnlyByDefault ??
      false;
    const ep = new BrowserWebRTCEndpoint(matchId, role, {
      iceServers: this.opts.iceServers,
      iceTransportPolicy: relayOnly ? "relay" : "all",
      onConnectionStateChange: (state) => this.handleEndpointState(matchId, state),
    });
    this.endpointsByMatch.set(matchId, ep);
    return ep;
  }

  private armConnectionLoop(): void {
    this.client
      .waitForConnection()
      .then((info) => {
        // Re-arm FIRST so a second match completing right after this one isn't lost.
        this.armConnectionLoop();
        void this.handleConnected(info);
      })
      .catch((err) => this.events.emit("error", { error: err, context: "waitForConnection" }));
  }

  private async handleConnected(info: ConnectedInfo): Promise<void> {
    const contactKey = info.counterparty_key;
    const matchId = info.match_id;

    // Replace any prior connection for this contact.
    const prev = this.connections.get(contactKey);
    if (prev && prev.matchId !== matchId) {
      try {
        prev.endpoint?.close();
      } catch {
        /* ignore */
      }
    }

    const channel = new ReliableChannel(info.channel, { ackTimeoutMs: this.ackTimeoutMs });
    channel.onMessage((text) => void this.handleIncomingFrame(contactKey, text));

    const fileReceiver = this.opts.createFileSink
      ? this.buildFileReceiver(contactKey)
      : null;

    const conn: ContactConn = {
      contactKey,
      matchId,
      channel,
      endpoint: this.endpointsByMatch.get(matchId) ?? null,
      state: "connected",
      fileReceiver,
    };
    this.connections.set(contactKey, conn);
    this.setContactState(contactKey, "connected");
    this.resolveConnectWaiters(contactKey, conn);
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
          void this.markFile(
            contactKey,
            outcome.fileId,
            { state: outcome.reason === "integrity-failed" ? "integrity-failed" : "failed" },
          );
        }
      },
    });
  }

  private async handleIncomingFrame(contactKey: string, text: string): Promise<void> {
    const frame = decodeAppFrame(text);
    if (!frame) return;
    switch (frame.t) {
      case "text": {
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
        return;
      }
      case "file-offer": {
        const conn = this.connections.get(contactKey);
        if (!conn?.fileReceiver) return; // file receiving not configured — ignore
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
    }
  }

  private handleEndpointState(matchId: string, state: RtcConnectionState): void {
    const contactKey = this.matchToCounterparty.get(matchId);
    if (!contactKey) return;
    const conn = this.connections.get(contactKey);
    if (state === "connected") {
      if (conn && conn.matchId === matchId) this.setContactState(contactKey, "connected");
      return;
    }
    if (state === "disconnected" || state === "failed" || state === "closed") {
      if (conn && conn.matchId === matchId) {
        conn.state = "down";
        this.setContactState(contactKey, "down");
      }
    }
  }

  // ---- small helpers -------------------------------------------------------

  private setContactState(contactKey: string, state: ContactState): void {
    this.events.emit("connection", { contactKey, state });
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

  private async markMessage(
    contactKey: string,
    id: string,
    patch: Partial<Pick<StoredMessage, "state" | "text" | "file">>,
  ): Promise<void> {
    await this.store.updateMessage(id, patch);
    const message = (await this.store.listMessages(contactKey)).find((m) => m.id === id);
    if (message) this.events.emit("message-updated", { id, message });
  }

  private async markFile(
    contactKey: string,
    fileId: string,
    filePatch: Partial<NonNullable<StoredMessage["file"]>>,
    state?: StoredMessage["state"],
  ): Promise<void> {
    const current = (await this.store.listMessages(contactKey)).find((m) => m.id === fileId);
    if (!current?.file) return;
    const file = { ...current.file, ...filePatch };
    const patch: Partial<Pick<StoredMessage, "state" | "file">> = { file };
    if (state) patch.state = state;
    await this.store.updateMessage(fileId, patch);
    const message = (await this.store.listMessages(contactKey)).find((m) => m.id === fileId);
    if (message) this.events.emit("message-updated", { id: fileId, message });
  }

  history(contactKey: string, opts?: { limit?: number; before?: number }): Promise<StoredMessage[]> {
    return this.store.listMessages(contactKey, opts);
  }
}
