// Local conversation persistence abstraction.
//
// The protocol stores NOTHING (no store-and-forward; the board is RAM-only and
// blind -- SPEC §0/§9.1), so durable history is entirely the app's job. orpal-core
// defines the interface; a shell supplies the implementation (web: IndexedDB;
// Android: a Capacitor SQLite plugin). Keeping it behind this
// interface lets both shells -- and the tests -- reuse the messaging layer.

import type { Contact } from "../contacts/contact.js";

/**
 * Lifecycle of an OUTBOUND message (issue #22). Two distinct receipts are
 * surfaced: the transport-level §11 one-time-key ACK ("delivered" -- the frame
 * reached the peer's channel) and the app-level awk ("acknowledged" -- the peer
 * stored/displayed it). "queued" is the durable offline-queue state before any
 * successful dispatch.
 */
export type OutboundState =
  | "queued" // in the durable offline send-queue, not yet dispatched (no live channel yet)
  | "sending" // an attempt is in flight over a live ReliableChannel, awaiting its §11 ACK
  | "delivered" // the §11 one-time-key ACK came back: the frame reached the peer's channel
  | "acknowledged" // the recipient's app-level awk came back: stored + displayed (see frames.ts)
  | "failed"; // gave up (offline with no queue, or DeliveryTimeoutError); caller may retry

/** Lifecycle of a FILE transfer (either direction). */
export type TransferState =
  | "offered"
  | "transferring"
  | "complete"
  | "failed"
  | "integrity-failed";

export type MessageKind = "text" | "file";
export type Direction = "out" | "in";

export interface FileMeta {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  chunkSize: number;
  chunks: number;
  /** Local filesystem path once received/sent (shell-provided). */
  path?: string;
  state: TransferState;
  /** Bytes transferred so far (for progress display). */
  transferred: number;
}

export interface StoredMessage {
  /** App-level message id, unique per logical message (NOT the ReliableChannel
   *  message_id, which is per send attempt). */
  id: string;
  contactKey: string;
  direction: Direction;
  kind: MessageKind;
  ts: number;
  /** Present for kind==="text". */
  text?: string;
  /** Present for kind==="file". */
  file?: FileMeta;
  /** Delivery state for outbound text/files; inbound messages are "delivered". */
  state: OutboundState;
}

export interface ListMessagesOptions {
  /** Return at most this many, newest-first. */
  limit?: number;
  /** Return messages older than this epoch-ms cursor (for paging). */
  before?: number;
}

export interface ConversationStore {
  init(): Promise<void>;

  upsertContact(contact: Contact): Promise<void>;
  listContacts(): Promise<Contact[]>;
  getContact(identityKey: string): Promise<Contact | null>;
  removeContact(identityKey: string): Promise<void>;

  appendMessage(message: StoredMessage): Promise<void>;
  /** Patch the mutable parts of a message (delivery/transfer state, file progress). */
  updateMessage(
    id: string,
    patch: Partial<Pick<StoredMessage, "state" | "text" | "file">>,
  ): Promise<void>;
  /** Fetch a single message by its app-level id, or null if unknown. O(1) via the
   *  store's primary key (IndexedDB `get` / in-memory Map) -- avoids an O(n)
   *  `listMessages().find()` scan on every delivery-state transition (issue #34). */
  getMessage(id: string): Promise<StoredMessage | null>;
  listMessages(contactKey: string, opts?: ListMessagesOptions): Promise<StoredMessage[]>;
  /** Every stored message across ALL conversations, in no particular order. Used
   *  by the full-device backup (ORPAL-017) to capture complete history -- including
   *  conversations with unknown senders that aren't (yet) contacts. */
  listAllMessages(): Promise<StoredMessage[]>;
  /** Wipe ALL contacts and messages. Used by a "replace" restore (ORPAL-017),
   *  which clears local state before importing the backup's. */
  clear(): Promise<void>;
}

/** An in-memory ConversationStore for tests and quick spikes. */
export class InMemoryConversationStore implements ConversationStore {
  private contacts = new Map<string, Contact>();
  /** Keyed by message id so `getMessage` is an O(1) lookup (issue #34). JS Maps
   *  preserve insertion order; `listMessages` sorts by `ts` regardless. */
  private messages = new Map<string, StoredMessage>();

  async init(): Promise<void> {}

  async upsertContact(contact: Contact): Promise<void> {
    this.contacts.set(contact.identityKey, contact);
  }
  async listContacts(): Promise<Contact[]> {
    return [...this.contacts.values()];
  }
  async getContact(identityKey: string): Promise<Contact | null> {
    return this.contacts.get(identityKey) ?? null;
  }
  async removeContact(identityKey: string): Promise<void> {
    this.contacts.delete(identityKey);
  }

  async appendMessage(message: StoredMessage): Promise<void> {
    this.messages.set(message.id, { ...message });
  }
  async updateMessage(
    id: string,
    patch: Partial<Pick<StoredMessage, "state" | "text" | "file">>,
  ): Promise<void> {
    const m = this.messages.get(id);
    if (m) Object.assign(m, patch);
  }
  async getMessage(id: string): Promise<StoredMessage | null> {
    const m = this.messages.get(id);
    return m ? { ...m } : null;
  }
  async listMessages(contactKey: string, opts: ListMessagesOptions = {}): Promise<StoredMessage[]> {
    let rows = [...this.messages.values()].filter((m) => m.contactKey === contactKey);
    if (opts.before !== undefined) rows = rows.filter((m) => m.ts < opts.before!);
    rows = rows.sort((a, b) => b.ts - a.ts);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map((m) => ({ ...m }));
  }
  async listAllMessages(): Promise<StoredMessage[]> {
    return [...this.messages.values()].map((m) => ({ ...m }));
  }
  async clear(): Promise<void> {
    this.contacts.clear();
    this.messages.clear();
  }
}
