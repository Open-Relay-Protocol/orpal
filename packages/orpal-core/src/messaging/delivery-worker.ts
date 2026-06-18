// The delivery worker — retries pending outbound messages until acknowledged.
//
// It drives the persistent pending queue (pending-queue.ts) toward delivery
// using BOTH strategies the issue calls for, with presence preferred:
//
//   * Presence-based (preferred): when a recipient appears online, OrpalClient
//     calls `flushRecipient()` and we attempt that recipient's queue immediately,
//     ahead of any backoff timer.
//   * Blind retry (fallback): each message also carries a self-rescheduling timer
//     that re-attempts on exponential backoff WITH JITTER, so a message still
//     drains even if no presence signal ever arrives (and so two senders don't
//     resynchronise into a thundering herd).
//
// A message leaves the queue ONLY when its awk arrives (`acknowledge()`); a
// successful transport send just means "dispatched, now awaiting the awk", so we
// keep retrying on backoff until that awk comes (covering a lost awk too).
//
// Timers and `now`/`random` are injectable so tests stay deterministic.

import type {
  PendingMessage,
  PendingMetrics,
  PendingQueueStore,
} from "./pending-queue.js";
import { computePendingMetrics } from "./pending-queue.js";

/** Exponential-backoff-with-jitter schedule for blind retries. */
export interface BackoffConfig {
  /** Delay before the first retry, in ms. */
  baseMs: number;
  /** Multiplier applied per attempt. */
  factor: number;
  /** Upper bound on a single delay, in ms. */
  maxMs: number;
  /** Jitter fraction in [0,1]: the delay is scaled by 1 ± (jitter·rand). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 1_000,
  factor: 2,
  maxMs: 60_000,
  jitter: 0.3,
};

type TimerHandle = ReturnType<typeof setTimeout>;

export interface DeliveryWorkerOptions {
  store: PendingQueueStore;
  /**
   * Attempt to deliver one message over a live channel. Resolve `true` if the
   * frame was dispatched to a connected channel (now awaiting its awk), or
   * `false` if the recipient is offline/unreachable right now. A throw is
   * treated the same as `false` (a failed attempt) — the worker reschedules.
   */
  attempt: (msg: PendingMessage) => Promise<boolean>;
  backoff?: Partial<BackoffConfig>;
  /** Notified after every queue mutation with a fresh metrics snapshot. */
  onMetrics?: (metrics: PendingMetrics) => void;
  /** Local debug log sink (count/oldest, attempts, awks). */
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class DeliveryWorker {
  private readonly store: PendingQueueStore;
  private readonly attempt: (msg: PendingMessage) => Promise<boolean>;
  private readonly backoff: BackoffConfig;
  private readonly onMetrics?: (metrics: PendingMetrics) => void;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  /** Per-message backoff timers (so we can cancel on awk / immediate flush). */
  private readonly timers = new Map<string, TimerHandle>();
  /** Messages with an attempt currently in flight (so we don't double-send). */
  private readonly inflight = new Set<string>();
  private running = false;

  constructor(opts: DeliveryWorkerOptions) {
    this.store = opts.store;
    this.attempt = opts.attempt;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.onMetrics = opts.onMetrics;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  }

  /** Resume any messages persisted from a previous session (survives reload). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const rows = await this.store.list();
    this.log("resume", { pending: rows.length });
    for (const msg of rows) this.scheduleSoon(msg.messageId);
    await this.emitMetrics();
  }

  stop(): void {
    this.running = false;
    for (const h of this.timers.values()) this.clearTimer(h);
    this.timers.clear();
  }

  /** Enqueue a freshly-sent message and attempt delivery right away. */
  async enqueue(msg: PendingMessage): Promise<void> {
    await this.store.enqueue(msg);
    await this.emitMetrics();
    if (this.running) void this.runAttempt(msg.messageId);
  }

  /**
   * Presence-based trigger: a recipient just came online — attempt all of their
   * queued messages now, cancelling any pending backoff so delivery is immediate.
   */
  async flushRecipient(recipientId: string): Promise<void> {
    if (!this.running) return;
    const rows = await this.store.list();
    for (const msg of rows) {
      if (msg.recipientId === recipientId) void this.runAttempt(msg.messageId);
    }
  }

  /** Attempt every queued message now (e.g. a board reconnected). */
  async flushAll(): Promise<void> {
    if (!this.running) return;
    for (const msg of await this.store.list()) void this.runAttempt(msg.messageId);
  }

  /**
   * Acknowledge a message by id (an awk arrived): drop it from the queue and
   * cancel its retries. Returns true if a queued message was actually removed.
   */
  async acknowledge(messageId: string): Promise<boolean> {
    const existing = await this.store.get(messageId);
    if (!existing) return false;
    this.cancelTimer(messageId);
    await this.store.remove(messageId);
    this.log("awk", { messageId, recipientId: existing.recipientId });
    await this.emitMetrics();
    return true;
  }

  async metrics(): Promise<PendingMetrics> {
    return computePendingMetrics(await this.store.list());
  }

  // ---- internals -----------------------------------------------------------

  private cancelTimer(messageId: string): void {
    const h = this.timers.get(messageId);
    if (h !== undefined) {
      this.clearTimer(h);
      this.timers.delete(messageId);
    }
  }

  /** Schedule an immediate (next-tick) attempt without an extra send dispatch. */
  private scheduleSoon(messageId: string): void {
    this.cancelTimer(messageId);
    const h = this.setTimer(() => {
      this.timers.delete(messageId);
      void this.runAttempt(messageId);
    }, 0);
    this.timers.set(messageId, h);
  }

  /** Compute the backoff delay for the Nth attempt, with symmetric jitter. */
  private delayFor(attemptCount: number): number {
    const raw = this.backoff.baseMs * Math.pow(this.backoff.factor, attemptCount);
    const capped = Math.min(this.backoff.maxMs, raw);
    const spread = capped * this.backoff.jitter;
    const jittered = capped + (this.random() * 2 - 1) * spread;
    return Math.max(0, Math.round(jittered));
  }

  private scheduleBackoff(messageId: string, attemptCount: number): void {
    if (!this.running) return;
    this.cancelTimer(messageId);
    const delay = this.delayFor(attemptCount);
    const h = this.setTimer(() => {
      this.timers.delete(messageId);
      void this.runAttempt(messageId);
    }, delay);
    this.timers.set(messageId, h);
  }

  /** Run one delivery attempt, then (unless acked meanwhile) arm the next one. */
  private async runAttempt(messageId: string): Promise<void> {
    if (!this.running) return;
    if (this.inflight.has(messageId)) return; // an attempt is already running
    const msg = await this.store.get(messageId);
    if (!msg) return; // acked/removed before we got here
    this.cancelTimer(messageId);
    this.inflight.add(messageId);

    let dispatched = false;
    try {
      dispatched = await this.attempt(msg);
    } catch {
      dispatched = false;
    } finally {
      this.inflight.delete(messageId);
    }

    // Record the attempt. If it was acked while in flight, get() is now null and
    // we must not resurrect it.
    const still = await this.store.get(messageId);
    if (!still) return;
    const attemptCount = still.attemptCount + 1;
    await this.store.update(messageId, { attemptCount, lastAttemptAt: this.now() });
    this.log("attempt", { messageId, recipientId: msg.recipientId, attemptCount, dispatched });
    await this.emitMetrics();

    // Either way we keep retrying on backoff until the awk arrives (dispatched
    // only means "sent"; a lost awk still needs a re-send). The first retry waits
    // `baseMs`, hence attemptCount-1 (this is the Nth failure).
    this.scheduleBackoff(messageId, attemptCount - 1);
  }

  private async emitMetrics(): Promise<void> {
    const metrics = await this.metrics();
    this.onMetrics?.(metrics);
    this.log("metrics", {
      total: metrics.total,
      oldestPendingTs: metrics.oldestPendingTs,
    });
  }
}
