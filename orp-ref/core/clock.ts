// SPDX-License-Identifier: Apache-2.0
// Minimal injectable clock/timer abstraction so timeout-driven logic is
// deterministically testable without real wall-clock sleeps. Lives in core/
// (not board/scheduler.ts, which has the same shape) because client/ may
// NEVER depend on anything under board/ — see LICENSING.md. board/scheduler.ts
// re-exports this under its original names so board.ts's existing imports
// are unaffected.

export type TimerId = number;

export interface Clock {
  now(): number;
  setTimer(delayMs: number, cb: () => void): TimerId;
  clearTimer(id: TimerId): void;
}

export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
  setTimer(delayMs: number, cb: () => void): TimerId {
    return setTimeout(cb, delayMs) as unknown as TimerId;
  }
  clearTimer(id: TimerId): void {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
}

/** Deterministic clock for tests: time only moves when advance() is called. */
export class FakeClock implements Clock {
  private clock = 0;
  private seq = 0;
  private timers = new Map<TimerId, { at: number; cb: () => void }>();

  now(): number {
    return this.clock;
  }
  setTimer(delayMs: number, cb: () => void): TimerId {
    const id = this.seq++;
    this.timers.set(id, { at: this.clock + delayMs, cb });
    return id;
  }
  clearTimer(id: TimerId): void {
    this.timers.delete(id);
  }
  /** Advance the clock, firing every timer whose deadline is now in the past. */
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      let next: { id: TimerId; at: number; cb: () => void } | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (next === null || t.at < next.at)) {
          next = { id, at: t.at, cb: t.cb };
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.clock = next.at;
      next.cb();
    }
    this.clock = target;
  }
}
