import type { Contact } from "../contacts/contact.js";

export interface ContactRecord {
  relayOnly: boolean;
  transportKey: string;
  boards: { preferred: string[]; fallback: string[] };
  autoAcceptMigration: boolean;
}

export class ContactRegistry {
  private readonly records = new Map<string, ContactRecord>();

  /** Load all contacts from the store into the registry. */
  loadAll(contacts: Contact[]): void {
    for (const c of contacts) {
      this.set(c.identityKey, {
        relayOnly: c.relayOnly,
        transportKey: c.transportKey,
        boards: { preferred: c.preferredBoards ?? [], fallback: c.fallbackBoards ?? [] },
        autoAcceptMigration: c.autoAcceptMigration ?? false,
      });
    }
  }

  get(key: string): ContactRecord | undefined {
    return this.records.get(key);
  }

  set(key: string, record: ContactRecord): void {
    this.records.set(key, record);
  }

  /** Update specific fields of an existing record. */
  patch(key: string, patch: Partial<ContactRecord>): void {
    const existing = this.records.get(key);
    if (existing) {
      this.records.set(key, { ...existing, ...patch });
    }
  }

  remove(key: string): void {
    this.records.delete(key);
  }

  transportKey(key: string): string | undefined {
    return this.records.get(key)?.transportKey;
  }

  relayOnly(key: string): boolean {
    return this.records.get(key)?.relayOnly ?? false;
  }

  autoAcceptMigration(key: string): boolean {
    return this.records.get(key)?.autoAcceptMigration ?? false;
  }

  boards(key: string): { preferred: string[]; fallback: string[] } {
    return this.records.get(key)?.boards ?? { preferred: [], fallback: [] };
  }
}
