// SQLite-backed conversation history (the protocol stores nothing — SPEC §9.1).
//
// Lives in the main process; the renderer reaches it over IPC. Implements the
// same shape as @orpal/core's ConversationStore so the renderer's IPC proxy can
// satisfy that interface for OrpalClient.

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Contact,
  StoredMessage,
  ListMessagesOptions,
  FileMeta,
} from "@orpal/core";
import type { MessagePatch } from "../shared/ipc.js";

interface ContactRow {
  identity_key: string;
  transport_key: string;
  binding: string;
  display_name: string;
  relay_only: number;
  added_utc: string;
}

interface MessageRow {
  id: string;
  contact_key: string;
  direction: string;
  kind: string;
  ts: number;
  text: string | null;
  file: string | null;
  state: string;
}

export class SqliteConversationStore {
  private readonly db: Database.Database;

  constructor(userDataDir: string) {
    const file = join(userDataDir, "history", "orpal.db");
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        identity_key  TEXT PRIMARY KEY,
        transport_key TEXT NOT NULL,
        binding       TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        relay_only    INTEGER NOT NULL DEFAULT 0,
        added_utc     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        contact_key TEXT NOT NULL,
        direction   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        text        TEXT,
        file        TEXT,
        state       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_contact_ts ON messages(contact_key, ts);
    `);
  }

  async init(): Promise<void> {
    /* tables created in constructor */
  }

  async upsertContact(c: Contact): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO contacts (identity_key, transport_key, binding, display_name, relay_only, added_utc)
         VALUES (@identity_key, @transport_key, @binding, @display_name, @relay_only, @added_utc)
         ON CONFLICT(identity_key) DO UPDATE SET
           transport_key=excluded.transport_key,
           binding=excluded.binding,
           display_name=excluded.display_name,
           relay_only=excluded.relay_only`,
      )
      .run({
        identity_key: c.identityKey,
        transport_key: c.transportKey,
        binding: JSON.stringify(c.binding),
        display_name: c.displayName,
        relay_only: c.relayOnly ? 1 : 0,
        added_utc: c.addedUtc,
      });
  }

  async listContacts(): Promise<Contact[]> {
    const rows = this.db.prepare(`SELECT * FROM contacts ORDER BY display_name COLLATE NOCASE`).all() as ContactRow[];
    return rows.map(rowToContact);
  }

  async getContact(identityKey: string): Promise<Contact | null> {
    const row = this.db
      .prepare(`SELECT * FROM contacts WHERE identity_key = ?`)
      .get(identityKey) as ContactRow | undefined;
    return row ? rowToContact(row) : null;
  }

  async removeContact(identityKey: string): Promise<void> {
    const tx = this.db.transaction((key: string) => {
      this.db.prepare(`DELETE FROM messages WHERE contact_key = ?`).run(key);
      this.db.prepare(`DELETE FROM contacts WHERE identity_key = ?`).run(key);
    });
    tx(identityKey);
  }

  async appendMessage(m: StoredMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (id, contact_key, direction, kind, ts, text, file, state)
         VALUES (@id, @contact_key, @direction, @kind, @ts, @text, @file, @state)`,
      )
      .run({
        id: m.id,
        contact_key: m.contactKey,
        direction: m.direction,
        kind: m.kind,
        ts: m.ts,
        text: m.text ?? null,
        file: m.file ? JSON.stringify(m.file) : null,
        state: m.state,
      });
  }

  async updateMessage(id: string, patch: MessagePatch): Promise<void> {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.state !== undefined) {
      sets.push("state = @state");
      params.state = patch.state;
    }
    if (patch.text !== undefined) {
      sets.push("text = @text");
      params.text = patch.text;
    }
    if (patch.file !== undefined) {
      sets.push("file = @file");
      params.file = JSON.stringify(patch.file);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  async listMessages(contactKey: string, opts: ListMessagesOptions = {}): Promise<StoredMessage[]> {
    const clauses = ["contact_key = @contactKey"];
    const params: Record<string, unknown> = { contactKey };
    if (opts.before !== undefined) {
      clauses.push("ts < @before");
      params.before = opts.before;
    }
    let sql = `SELECT * FROM messages WHERE ${clauses.join(" AND ")} ORDER BY ts DESC`;
    if (opts.limit !== undefined) {
      sql += " LIMIT @limit";
      params.limit = opts.limit;
    }
    const rows = this.db.prepare(sql).all(params) as MessageRow[];
    return rows.map(rowToMessage);
  }

  close(): void {
    this.db.close();
  }
}

function rowToContact(r: ContactRow): Contact {
  return {
    identityKey: r.identity_key,
    transportKey: r.transport_key,
    binding: JSON.parse(r.binding),
    displayName: r.display_name,
    relayOnly: r.relay_only === 1,
    addedUtc: r.added_utc,
  };
}

function rowToMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    contactKey: r.contact_key,
    direction: r.direction as StoredMessage["direction"],
    kind: r.kind as StoredMessage["kind"],
    ts: r.ts,
    text: r.text ?? undefined,
    file: r.file ? (JSON.parse(r.file) as FileMeta) : undefined,
    state: r.state as StoredMessage["state"],
  };
}
