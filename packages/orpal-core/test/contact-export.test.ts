import { describe, it, expect } from "vitest";
import {
  DeviceIdentity,
  contactFromCard,
  parseContactCard,
  serializeContactCard,
  serializeContacts,
  parseContactsExport,
  importContacts,
  makeLoopbackContact,
  CONTACTS_EXPORT_KIND,
  type Contact,
} from "../src/index.js";

// Bulk contact export / import (issue #41). These exercise the framework-agnostic
// core: serialization round-trips, import binding validation (good / tampered /
// collisions), and the guarantee that no private-key / history field ever leaks
// into a bundle.

/** A fully-validated contact built from a fresh identity, the way a real scan
 *  produces one (card -> parseContactCard -> contactFromCard). */
function makeContact(opts: Partial<Contact> = {}): Contact {
  const id = DeviceIdentity.generate();
  const parsed = parseContactCard(serializeContactCard(id.exportPublic(), "Peer"));
  if (!parsed.valid || !parsed.card) throw new Error(`setup: ${parsed.reason}`);
  return { ...contactFromCard(parsed.card), ...opts };
}

describe("contact export serialization", () => {
  it("round-trips contacts through serialize -> parse -> import with bindings intact", () => {
    const a = makeContact({ displayName: "Alice", relayOnly: true });
    const b = makeContact({ displayName: "Bob", preferredBoards: ["wss://b/"], autoAcceptMigration: true });

    const json = serializeContacts([a, b]);
    const parsed = parseContactsExport(json);
    expect(parsed.valid).toBe(true);
    expect(parsed.bundle?.kind).toBe(CONTACTS_EXPORT_KIND);
    expect(parsed.bundle?.contacts).toHaveLength(2);

    const { contacts, summary } = importContacts(parsed.bundle!);
    expect(summary).toEqual({ imported: 2, skipped: 0, rejected: [] });

    const byKey = new Map(contacts.map((c) => [c.identityKey, c]));
    expect(byKey.get(a.identityKey)?.displayName).toBe("Alice");
    expect(byKey.get(a.identityKey)?.relayOnly).toBe(true);
    expect(byKey.get(a.identityKey)?.binding).toEqual(a.binding);
    expect(byKey.get(b.identityKey)?.preferredBoards).toEqual(["wss://b/"]);
    expect(byKey.get(b.identityKey)?.autoAcceptMigration).toBe(true);
    expect(byKey.get(b.identityKey)?.addedUtc).toBe(b.addedUtc);
  });

  it("never includes private keys or message history in a bundle", () => {
    const c = makeContact({ displayName: "Carol" });
    const json = serializeContacts([c]);
    // No private-key material or conversation fields, by either common name.
    for (const banned of ["private", "secret", "seed", "text", "message", "history", "ts", "mnemonic"]) {
      expect(json.toLowerCase()).not.toContain(`"${banned}`);
    }
    const entry = JSON.parse(json).contacts[0];
    expect(Object.keys(entry).sort()).toEqual(
      [
        "addedUtc",
        "autoAcceptMigration",
        "binding",
        "displayName",
        "fallbackBoards",
        "identityKey",
        "preferredBoards",
        "relayOnly",
        "transportKey",
      ].sort(),
    );
  });

  it("excludes the loopback diagnostic contact from export bundles", () => {
    const real = makeContact({ displayName: "Dave" });
    const loop = makeLoopbackContact(DeviceIdentity.generate().exportPublic());
    const json = serializeContacts([real, loop]);
    const parsed = parseContactsExport(json);
    expect(parsed.bundle?.contacts).toHaveLength(1);
    expect(parsed.bundle?.contacts[0].identityKey).toBe(real.identityKey);
  });
});

describe("contact import validation", () => {
  it("rejects an entry with a tampered (mismatched) transport key, with a reason", () => {
    const good = makeContact();
    const tampered = makeContact();
    const bundle = parseContactsExport(serializeContacts([good, tampered])).bundle!;
    // Swap in an attacker-chosen transport key; the binding no longer ties out.
    bundle.contacts[1].transportKey = makeContact().transportKey;

    const { contacts, summary } = importContacts(bundle);
    expect(summary.imported).toBe(1);
    expect(summary.rejected).toHaveLength(1);
    expect(summary.rejected[0].identityKey).toBe(tampered.identityKey);
    expect(summary.rejected[0].reason).toBe("binding-transport-mismatch");
    expect(contacts.map((c) => c.identityKey)).toEqual([good.identityKey]);
  });

  it("rejects an entry whose binding signature is forged", () => {
    const c = makeContact();
    const bundle = parseContactsExport(serializeContacts([c])).bundle!;
    bundle.contacts[0].binding = { ...c.binding, binding_sig: "AAAA" };
    const { summary } = importContacts(bundle);
    expect(summary.imported).toBe(0);
    expect(summary.rejected[0].reason).toBe("bad-binding-signature");
  });

  it("skips contacts that collide with existing ones by default", () => {
    const existing = makeContact({ displayName: "Local edit" });
    const other = makeContact();
    const bundle = parseContactsExport(serializeContacts([existing, other])).bundle!;

    const { contacts, summary } = importContacts(bundle, {
      existingKeys: [existing.identityKey],
    });
    expect(summary).toMatchObject({ imported: 1, skipped: 1 });
    expect(contacts.map((c) => c.identityKey)).toEqual([other.identityKey]);
  });

  it("overwrites colliding contacts when onCollision is 'overwrite'", () => {
    const existing = makeContact({ displayName: "Old" });
    const bundle = parseContactsExport(
      serializeContacts([{ ...existing, displayName: "New" }]),
    ).bundle!;

    const { contacts, summary } = importContacts(bundle, {
      existingKeys: [existing.identityKey],
      onCollision: "overwrite",
    });
    expect(summary).toMatchObject({ imported: 1, skipped: 0 });
    expect(contacts[0].displayName).toBe("New");
  });

  it("rejects an entry matching this device's own identity", () => {
    const me = DeviceIdentity.generate();
    const mineAsContact = contactFromCard(
      parseContactCard(serializeContactCard(me.exportPublic(), "me")).card!,
    );
    const other = makeContact();
    const bundle = parseContactsExport(serializeContacts([mineAsContact, other])).bundle!;

    const { contacts, summary } = importContacts(bundle, { ownKey: me.identityKeyB64 });
    expect(summary.imported).toBe(1);
    expect(summary.rejected[0].reason).toBe("that-is-your-own-card");
    expect(contacts[0].identityKey).toBe(other.identityKey);
  });

  it("de-dupes duplicate identity keys within a single bundle", () => {
    const c = makeContact();
    const bundle = parseContactsExport(serializeContacts([c, { ...c }])).bundle!;
    const { summary } = importContacts(bundle);
    expect(summary).toMatchObject({ imported: 1, skipped: 1 });
  });
});

describe("parseContactsExport envelope checks", () => {
  it("rejects non-JSON, wrong kind, and unsupported versions", () => {
    expect(parseContactsExport("nope").reason).toBe("not-valid-json");
    expect(parseContactsExport(JSON.stringify({ kind: "other" })).reason).toBe("not-a-contacts-export");
    expect(
      parseContactsExport(JSON.stringify({ kind: CONTACTS_EXPORT_KIND, v: 2, contacts: [] })).reason,
    ).toBe("unsupported-version");
    expect(
      parseContactsExport(JSON.stringify({ kind: CONTACTS_EXPORT_KIND, v: 1 })).reason,
    ).toBe("missing-contacts");
  });
});
