import { serializeContactCard, type DeviceIdentity, type OrpalClient } from "../../src/index.js";

// Recipient-sealing (issue #23) seals every outbound payload to the recipient's
// PINNED transport key, which the sender only holds after importing the peer's
// verified contact card. These helpers replicate that out-of-band card exchange
// in tests (the real app does it via QR scan / paste before any messaging).
//
// NOTE: the SENDER needs the recipient added; the recipient does NOT need the
// sender added to receive (a sealed box is opened with the recipient's own key).
// `addContactFromCard` requires `start()` to have run (it writes to the store).

/** Add `to` as a contact of `from` so `from` can seal messages to `to`. */
export async function link(from: OrpalClient, to: OrpalClient): Promise<void> {
  const res = await from.addContactFromCard(to.ownContactCard());
  if (!res.ok) throw new Error(`link failed: ${res.reason}`);
}

/** Mutually add `a` and `b` as contacts so either can message the other. */
export async function linkBoth(a: OrpalClient, b: OrpalClient): Promise<void> {
  await link(a, b);
  await link(b, a);
}

/** Add a bare identity (no live client) as a contact of `from` — e.g. an offline
 *  recipient whose card was imported but who never comes online. */
export async function linkIdentity(from: OrpalClient, to: DeviceIdentity): Promise<void> {
  const res = await from.addContactFromCard(serializeContactCard(to.exportPublic()));
  if (!res.ok) throw new Error(`linkIdentity failed: ${res.reason}`);
}
