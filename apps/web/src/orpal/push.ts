// ORPAL-016: opt-in platform push registration for wake notifications.
//
// The shell registers with the platform push service, hands the resulting token
// to orpal-core via `OrpalClient.setPushToken()`, and core advertises it in the
// signed presence beacon (ORP-009). When the device goes offline and a peer's
// signaling channel to it times out, the board fires ONE contentless wake to
// this token; the device wakes, reconnects, re-announces, and the sender's
// offline queue retry completes delivery. No message content is ever in a push.
//
// This module implements the Web Push (PWA) provider, which the Android
// Capacitor shell also runs (it bundles the web build). Native FCM/APNs would
// slot in behind the same `enablePush`/`disablePush` shape via the
// `@capacitor/push-notifications` plugin once Firebase/APNs config is wired.

/** The VAPID public key (urlsafe base64) of the board's Web Push sender, injected
 *  at build time. Must match the keypair the board uses for ORP_PUSH_PROVIDER=
 *  webpush; without it the browser can't create a usable subscription. */
const VAPID_PUBLIC_KEY: string | undefined = import.meta.env.VITE_ORP_VAPID_PUBLIC_KEY;

/** True when this runtime can register for Web Push at all. */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** True when a VAPID key is configured (push can't work without one). */
export function pushConfigured(): boolean {
  return typeof VAPID_PUBLIC_KEY === "string" && VAPID_PUBLIC_KEY.length > 0;
}

/** Error thrown when enabling push can't proceed; `code` lets the UI explain. */
export class PushSetupError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "unconfigured" | "denied" | "failed",
  ) {
    super(message);
    this.name = "PushSetupError";
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Allocate over an explicit ArrayBuffer so the type is a plain (non-shared)
  // buffer, which `applicationServerKey: BufferSource` requires.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Serialize a PushSubscription into the opaque token the board stores in
 *  presence and uses to send the wake. A Web Push sender needs the endpoint AND
 *  the p256dh/auth keys, so the whole subscription rides as one JSON string. */
function subscriptionToToken(sub: PushSubscription): string {
  return JSON.stringify(sub.toJSON());
}

/** Opt in: request notification permission, subscribe via the service worker's
 *  PushManager, and return the opaque token to advertise in presence. Throws a
 *  `PushSetupError` (never silently fakes a token) if anything blocks it. */
export async function enablePush(): Promise<string> {
  if (!pushSupported()) {
    throw new PushSetupError("Push notifications aren't supported on this device.", "unsupported");
  }
  if (!pushConfigured()) {
    throw new PushSetupError(
      "Push notifications need a VAPID key (VITE_ORP_VAPID_PUBLIC_KEY) matching your board's Web Push config.",
      "unconfigured",
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushSetupError("Notification permission was not granted.", "denied");
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    // Reuse an existing subscription if present (it's already advertised); else
    // create one bound to the board's VAPID key.
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true, // required by Chromium; the wake shows a notification
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
      }));
    return subscriptionToToken(sub);
  } catch (err) {
    throw new PushSetupError(
      `Could not subscribe to push: ${err instanceof Error ? err.message : String(err)}`,
      "failed",
    );
  }
}

/** Opt out: drop the push subscription so no token is advertised and no wake can
 *  be delivered. Best-effort and idempotent. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    // Already gone / SW unavailable — nothing to clean up.
  }
}
