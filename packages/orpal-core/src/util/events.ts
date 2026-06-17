// A tiny, dependency-free typed event emitter. orpal-core stays framework- and
// runtime-agnostic, so we don't pull in Node's EventEmitter or any library.

export type Listener<T> = (payload: T) => void;

/**
 * Strongly-typed multi-event emitter. `EventMap` maps an event name to its
 * payload type, e.g. `TypedEmitter<{ message: MsgEvent; "state": StateEvent }>`.
 */
export class TypedEmitter<EventMap extends Record<string, unknown>> {
  private readonly listeners: {
    [K in keyof EventMap]?: Set<Listener<EventMap[K]>>;
  } = {};

  on<K extends keyof EventMap>(event: K, cb: Listener<EventMap[K]>): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(cb);
    return () => this.off(event, cb);
  }

  off<K extends keyof EventMap>(event: K, cb: Listener<EventMap[K]>): void {
    this.listeners[event]?.delete(cb);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    // Copy before iterating so a listener that unsubscribes mid-dispatch is safe.
    const set = this.listeners[event];
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        // A throwing listener must not break sibling listeners or the caller.
        // eslint-disable-next-line no-console
        console.error("[orpal-core] event listener threw", err);
      }
    }
  }

  removeAll(): void {
    for (const key of Object.keys(this.listeners) as (keyof EventMap)[]) {
      this.listeners[key]?.clear();
    }
  }
}
