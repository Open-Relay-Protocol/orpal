// ORPAL-008: Identity migration orchestrator.
//
// Drives the ORP-004 key rotation protocol from the app layer: generates a
// replacement identity, notifies every contact, tracks acknowledgements, manages
// the dual-validity window (announce + accept on both keys, send on new only),
// and retires the old key at the cutoff.
//
// RECIPIENT SIDE: when a contact sends us a key-migration frame, this module
// verifies the ORP-004 chain and surfaces a pending prompt. The UI shows a
// confirmation dialog; on accept we update the stored contact and send back a
// migration_ack.
//
// KNOWN ISSUE: retiring the old transport key means old messages sealed to it
// become unreadable (ciphertext). Re-encrypting history before deletion is a
// future fix; users are warned in the wizard.

import {
  DeviceIdentity,
  makeKeyMigration,
  makeMigrationAck,
  verifyKeyMigration,
  verifyMigrationAck,
  MigrationRegistry,
  type KeyMigration,
  type MigrationAck,
} from "../orp.js";
import { IdentityManager } from "../identity/identity-manager.js";
import type { SecureKeyStore, StoredKeys } from "../identity/secure-store.js";
import type { Contact } from "../contacts/contact.js";

// ---- persistence interface --------------------------------------------------

export type MigrationPhase = "notifying" | "dual-validity" | "retiring" | "complete";

export interface MigrationState {
  phase: MigrationPhase;
  oldIdentityKey: string;
  newIdentityKey: string;
  /** The new identity's stored keys (so we can reconstruct across restarts). */
  newStoredKeys: StoredKeys;
  migration: KeyMigration;
  retireAfterUtc: string;
  issuedUtc: string;
  /** Contact keys we've sent the migration to. */
  notifiedContacts: string[];
  /** Contact keys that have acknowledged. */
  acknowledgedContacts: string[];
}

export interface MigrationStore {
  load(): Promise<MigrationState | null>;
  save(state: MigrationState): Promise<void>;
  clear(): Promise<void>;
}

// ---- in-memory store (for tests) --------------------------------------------

export class InMemoryMigrationStore implements MigrationStore {
  private state: MigrationState | null = null;
  async load(): Promise<MigrationState | null> { return this.state; }
  async save(s: MigrationState): Promise<void> { this.state = s; }
  async clear(): Promise<void> { this.state = null; }
}

// ---- pending incoming migrations (recipient side) ---------------------------

export interface PendingMigration {
  contactKey: string;
  contactName: string;
  migration: KeyMigration;
}

// ---- migration manager ------------------------------------------------------

export interface MigrationManagerOptions {
  keyStore: SecureKeyStore;
  migrationStore: MigrationStore;
  now?: () => string;
}

export interface MigrationProgress {
  phase: MigrationPhase;
  totalContacts: number;
  acknowledged: number;
  retireAfterUtc: string;
}

export class MigrationManager {
  private readonly keyStore: SecureKeyStore;
  private readonly migrationStore: MigrationStore;
  private readonly now: () => string;
  private readonly registry = new MigrationRegistry();

  private state: MigrationState | null = null;
  private newIdentity: DeviceIdentity | null = null;

  private readonly pendingIncoming: PendingMigration[] = [];

  constructor(opts: MigrationManagerOptions) {
    this.keyStore = opts.keyStore;
    this.migrationStore = opts.migrationStore;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  async init(): Promise<void> {
    this.state = await this.migrationStore.load();
    if (this.state) {
      this.newIdentity = IdentityManager.fromStored(this.state.newStoredKeys);
    }
  }

  get active(): boolean {
    return this.state !== null && this.state.phase !== "complete";
  }

  get progress(): MigrationProgress | null {
    if (!this.state) return null;
    return {
      phase: this.state.phase,
      totalContacts: this.state.notifiedContacts.length,
      acknowledged: this.state.acknowledgedContacts.length,
      retireAfterUtc: this.state.retireAfterUtc,
    };
  }

  get migrationRecord(): KeyMigration | null {
    return this.state?.migration ?? null;
  }

  get newIdentityIfActive(): DeviceIdentity | null {
    return this.active ? this.newIdentity : null;
  }

  get oldIdentityKey(): string | null {
    return this.state?.oldIdentityKey ?? null;
  }

  get newIdentityKey(): string | null {
    return this.state?.newIdentityKey ?? null;
  }

  // ---- initiator: start a migration -----------------------------------------

  async startMigration(
    currentIdentity: DeviceIdentity,
    contacts: Contact[],
    retireAfterUtc: string,
  ): Promise<{ migration: KeyMigration; newIdentity: DeviceIdentity }> {
    if (this.active) throw new Error("A migration is already in progress.");

    const newStoredKeys = IdentityManager.mintStoredKeys(this.now());
    const newId = IdentityManager.fromStored(newStoredKeys);
    const migration = makeKeyMigration(currentIdentity, newId, {
      retire_after_utc: retireAfterUtc,
      now: this.now,
    });

    this.newIdentity = newId;
    this.state = {
      phase: "notifying",
      oldIdentityKey: currentIdentity.identityKeyB64,
      newIdentityKey: newId.identityKeyB64,
      newStoredKeys,
      migration,
      retireAfterUtc,
      issuedUtc: migration.issued_utc,
      notifiedContacts: contacts.map((c) => c.identityKey),
      acknowledgedContacts: [],
    };
    await this.migrationStore.save(this.state);
    return { migration, newIdentity: newId };
  }

  async markNotified(): Promise<void> {
    if (!this.state || this.state.phase !== "notifying") return;
    this.state.phase = "dual-validity";
    await this.migrationStore.save(this.state);
  }

  // ---- initiator: track acks ------------------------------------------------

  async handleMigrationAck(
    ackRecord: Record<string, unknown>,
    fromContactKey: string,
  ): Promise<boolean> {
    if (!this.state) return false;
    const result = verifyMigrationAck(ackRecord, fromContactKey);
    if (!result.valid) return false;
    const ack = ackRecord as unknown as MigrationAck;
    if (ack.old_key !== this.state.oldIdentityKey || ack.new_key !== this.state.newIdentityKey) {
      return false;
    }
    if (!this.state.acknowledgedContacts.includes(fromContactKey)) {
      this.state.acknowledgedContacts.push(fromContactKey);
      await this.migrationStore.save(this.state);
    }
    return true;
  }

  // ---- initiator: retire the old key ----------------------------------------

  async retire(): Promise<void> {
    if (!this.state || !this.newIdentity) return;
    await this.keyStore.clear();
    await this.keyStore.save(this.state.newStoredKeys);
    this.state.phase = "complete";
    await this.migrationStore.save(this.state);
    await this.migrationStore.clear();
  }

  /** Whether the retirement cutoff has passed. */
  isRetirementDue(): boolean {
    if (!this.state) return false;
    return Date.now() >= Date.parse(this.state.retireAfterUtc);
  }

  // ---- recipient: handle incoming migration ---------------------------------

  handleIncomingMigration(
    migrationRecord: Record<string, unknown>,
    contactKey: string,
    contactName: string,
  ): { valid: boolean; reason?: string } {
    const result = verifyKeyMigration(migrationRecord);
    if (!result.valid) return result;
    const migration = migrationRecord as unknown as KeyMigration;
    if (migration.old_key !== contactKey) {
      return { valid: false, reason: "migration-sender-mismatch" };
    }
    const already = this.pendingIncoming.some(
      (p) => p.contactKey === contactKey && p.migration.new_key === migration.new_key,
    );
    if (!already) {
      this.pendingIncoming.push({ contactKey, contactName, migration });
    }
    return { valid: true };
  }

  get pendingMigrations(): readonly PendingMigration[] {
    return this.pendingIncoming;
  }

  acceptIncomingMigration(contactKey: string): {
    accepted: boolean;
    migration?: KeyMigration;
    newContact?: Partial<Contact>;
  } {
    const idx = this.pendingIncoming.findIndex((p) => p.contactKey === contactKey);
    if (idx === -1) return { accepted: false };
    const pending = this.pendingIncoming.splice(idx, 1)[0];
    this.registry.accept(pending.migration);
    return {
      accepted: true,
      migration: pending.migration,
      newContact: {
        identityKey: pending.migration.new_key,
        transportKey: pending.migration.new_binding.transport_key,
        binding: pending.migration.new_binding,
      },
    };
  }

  declineIncomingMigration(contactKey: string): void {
    const idx = this.pendingIncoming.findIndex((p) => p.contactKey === contactKey);
    if (idx !== -1) this.pendingIncoming.splice(idx, 1);
  }

  buildMigrationAck(
    recipientIdentity: DeviceIdentity,
    migration: KeyMigration,
  ): MigrationAck {
    return makeMigrationAck(recipientIdentity, migration, { now: this.now });
  }
}
