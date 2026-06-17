// Local conversation persistence abstraction.
//
// The PROTOCOL stores nothing (no server-side store-and-forward; the board is
// RAM-only and blind — SPEC §0/§9.1). Durable history is therefore entirely the
// app's job, and so is *local* store-and-forward: when a contact is offline,
// outbound messages are queued in this store on THIS device and re-sent when the
// contact next comes online (see OrpalClient). orpal-core defines the interface; a
// shell supplies the implementation (web: IndexedDB; Android: a Capacitor SQLite
// plugin). Keeping it behind this interface lets both shells — and the tests —
// reuse the messaging layer.

import type { Contact } from "../contacts/contact.js";

/** Lifecycle of an OUTBOUND message, driven by the §11 ACK layer. */
export type OutboundState =
  | "sending" // in the ReliableChannel pending queue, awaiting ACK
  | "queued" // contact offline — stored locally, will auto-forward when they return
  | "delivered" // a valid one-time-key ACK came back (SPEC §11)
  | "failed"; // undeliverable with store-and-forward off; caller may retry

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
  listMessages(contactKey: string, opts?: ListMessagesOptions): Promise<StoredMessage[]>;
}

/** An in-memory ConversationStore for tests and quick spikes. */
export class InMemoryConversationStore implements ConversationStore {
  private contacts = new Map<string, Contact>();
  private messages: StoredMessage[] = [];

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
    this.messages.push({ ...message });
  }
  async updateMessage(
    id: string,
    patch: Partial<Pick<StoredMessage, "state" | "text" | "file">>,
  ): Promise<void> {
    const m = this.messages.find((x) => x.id === id);
    if (m) Object.assign(m, patch);
  }
  async listMessages(contactKey: string, opts: ListMessagesOptions = {}): Promise<StoredMessage[]> {
    let rows = this.messages.filter((m) => m.contactKey === contactKey);
    if (opts.before !== undefined) rows = rows.filter((m) => m.ts < opts.before!);
    rows = rows.sort((a, b) => b.ts - a.ts);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map((m) => ({ ...m }));
  }
}
