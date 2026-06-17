import type { TypedEmitter } from "../../src/index.js";

/** Resolve on the first emitted event matching `predicate`. */
export function once<EventMap extends Record<string, unknown>, K extends keyof EventMap>(
  emitter: TypedEmitter<EventMap>,
  event: K,
  predicate: (payload: EventMap[K]) => boolean = () => true,
  timeoutMs = 4000,
): Promise<EventMap[K]> {
  return new Promise<EventMap[K]>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for event "${String(event)}"`));
    }, timeoutMs);
    const off = emitter.on(event, (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

/** Poll `predicate` until it returns true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4000,
  intervalMs = 10,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
