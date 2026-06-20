// Persistent pending-queue for outbound messages awaiting acknowledgement.
//
// The Open Relay Protocol has NO store-and-forward -- the board is blind and
// RAM-only (SPEC §0/§9.1), so a message sent to an offline contact simply can't
// be delivered right now. To make 1:1 messaging reliable across that gap, the
// SENDER keeps undelivered messages in a durable local queue and retries until
// the RECIPIENT confirms receipt with an app-level acknowledgement (an "awk"
// frame; see frames.ts). Only an awk removes a message from this queue, so the
// queue must survive page reloads / app restarts.
//
// orpal-core defines the storage interface (this file) and an in-memory
// implementation for tests; a shell supplies the durable backing (web/Android:
// IndexedDB), exactly like ConversationStore.

/** The deliverable carried by a pending message. Today only text is queued --
 *  file transfers stream over a live channel and are not store-and-forwarded. */
export type PendingPayload = { kind: "text"; text: string };

/**
 * One outbound message awaiting acknowledgement, with the retry metadata the
 * delivery worker needs. `messageId` is the app-level id (a client-generated
 * UUID, stable across retries) and is the same id carried in the wire frame and
 * the matching awk -- that's how an acknowledgement is correlated back here.
 */
export interface PendingMessage {
  /** Contact identity key the message is addressed to. */
  recipientId: string;
  /**
   * Recipient's PINNED b64u X25519 transport key (from their verified contact
   * card). Carried in the queue so the message can be re-sealed (issue #23) on
   * every retry -- including after a reload, independent of the contact store.
   */
  recipientTransportKey: string;
  /** Client-generated id, stable across every retry; matched by the awk. */
  messageId: string;
  /** Epoch-ms the message was first enqueued (its logical send time). */
  timestamp: number;
  /** How many delivery attempts have been made so far. */
  attemptCount: number;
  /** Epoch-ms of the most recent attempt, or null if never attempted. */
  lastAttemptAt: number | null;
  /** The message content to (re)deliver. */
  payload: PendingPayload;
}

/** Patchable retry metadata (everything else on a pending row is immutable). */
export type PendingPatch = Partial<Pick<PendingMessage, "attemptCount" | "lastAttemptAt">>;

/**
 * Durable storage for the pending queue. A shell backs this with IndexedDB (web /
 * Android WebView); tests use {@link InMemoryPendingQueueStore}. Keyed by
 * `messageId`, so `enqueue` of an already-present id is an idempotent upsert.
 */
export interface PendingQueueStore {
  init(): Promise<void>;
  /** Insert (or replace) a pending message, keyed by `messageId`. */
  enqueue(msg: PendingMessage): Promise<void>;
  /** Patch retry metadata for a queued message; a no-op if it's already gone. */
  update(messageId: string, patch: PendingPatch): Promise<void>;
  /** Remove a message from the queue (called once its awk arrives). */
  remove(messageId: string): Promise<void>;
  /** Fetch a single queued message, or null if not (or no longer) queued. */
  get(messageId: string): Promise<PendingMessage | null>;
  /** All currently-queued messages, in no particular order. */
  list(): Promise<PendingMessage[]>;
}

/** Local observability snapshot of the pending queue (issue #17): queue health
 *  for surfacing in the UI and debugging the offline-delivery path. */
export interface PendingMetrics {
  /** How many messages are still waiting for an awk. */
  total: number;
  /** Epoch-ms timestamp of the oldest still-pending message, or null if empty. */
  oldestPendingTs: number | null;
  /** Epoch-ms of the most recent delivery attempt across the queue, or null if
   *  nothing has been attempted yet. */
  lastAttemptAt: number | null;
  /** Total delivery attempts made across all queued messages so far. */
  totalAttempts: number;
  /** Largest attempt count of any single queued message (the most-retried one). */
  maxAttempts: number;
  /** Pending count broken down by recipient identity key. */
  byRecipient: Record<string, number>;
}

/** Derive the metrics snapshot from a queue listing. */
export function computePendingMetrics(rows: PendingMessage[]): PendingMetrics {
  let oldest: number | null = null;
  let lastAttemptAt: number | null = null;
  let totalAttempts = 0;
  let maxAttempts = 0;
  const byRecipient: Record<string, number> = {};
  for (const m of rows) {
    if (oldest === null || m.timestamp < oldest) oldest = m.timestamp;
    if (m.lastAttemptAt !== null && (lastAttemptAt === null || m.lastAttemptAt > lastAttemptAt)) {
      lastAttemptAt = m.lastAttemptAt;
    }
    totalAttempts += m.attemptCount;
    if (m.attemptCount > maxAttempts) maxAttempts = m.attemptCount;
    byRecipient[m.recipientId] = (byRecipient[m.recipientId] ?? 0) + 1;
  }
  return { total: rows.length, oldestPendingTs: oldest, lastAttemptAt, totalAttempts, maxAttempts, byRecipient };
}

/** An in-memory PendingQueueStore for tests and quick spikes. */
export class InMemoryPendingQueueStore implements PendingQueueStore {
  private readonly rows = new Map<string, PendingMessage>();

  async init(): Promise<void> {}

  async enqueue(msg: PendingMessage): Promise<void> {
    this.rows.set(msg.messageId, { ...msg });
  }
  async update(messageId: string, patch: PendingPatch): Promise<void> {
    const m = this.rows.get(messageId);
    if (m) Object.assign(m, patch);
  }
  async remove(messageId: string): Promise<void> {
    this.rows.delete(messageId);
  }
  async get(messageId: string): Promise<PendingMessage | null> {
    const m = this.rows.get(messageId);
    return m ? { ...m } : null;
  }
  async list(): Promise<PendingMessage[]> {
    return [...this.rows.values()].map((m) => ({ ...m }));
  }
}
