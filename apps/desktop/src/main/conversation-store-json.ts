// Pure-JS, file-backed conversation store — the zero-native-dependency fallback
// used when better-sqlite3 isn't available for the current Node/Electron ABI.
//
// It keeps the same ConversationStore shape as the SQLite store. History is held
// in memory and persisted to a JSON file (debounced writes + a flush on quit).
// Fine for typical message volumes; the SQLite store is preferred when it builds.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Contact,
  StoredMessage,
  ListMessagesOptions,
} from "@orpal/core";
import type { MessagePatch } from "../shared/ipc.js";

interface Snapshot {
  contacts: Record<string, Contact>;
  messages: StoredMessage[];
}

export class JsonConversationStore {
  private readonly file: string;
  private data: Snapshot = { contacts: {}, messages: [] };
  private loaded = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "history", "orpal.json");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Snapshot;
      this.data = { contacts: parsed.contacts ?? {}, messages: parsed.messages ?? [] };
    } catch {
      this.data = { contacts: {}, messages: [] };
    }
    this.loaded = true;
  }

  async upsertContact(c: Contact): Promise<void> {
    this.data.contacts[c.identityKey] = c;
    this.scheduleSave();
  }
  async listContacts(): Promise<Contact[]> {
    return Object.values(this.data.contacts).sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
  }
  async getContact(identityKey: string): Promise<Contact | null> {
    return this.data.contacts[identityKey] ?? null;
  }
  async removeContact(identityKey: string): Promise<void> {
    delete this.data.contacts[identityKey];
    this.data.messages = this.data.messages.filter((m) => m.contactKey !== identityKey);
    this.scheduleSave();
  }

  async appendMessage(m: StoredMessage): Promise<void> {
    const idx = this.data.messages.findIndex((x) => x.id === m.id);
    if (idx === -1) this.data.messages.push(m);
    else this.data.messages[idx] = m;
    this.scheduleSave();
  }
  async updateMessage(id: string, patch: MessagePatch): Promise<void> {
    const m = this.data.messages.find((x) => x.id === id);
    if (!m) return;
    if (patch.state !== undefined) m.state = patch.state;
    if (patch.text !== undefined) m.text = patch.text;
    if (patch.file !== undefined) m.file = patch.file;
    this.scheduleSave();
  }
  async listMessages(contactKey: string, opts: ListMessagesOptions = {}): Promise<StoredMessage[]> {
    let rows = this.data.messages.filter((m) => m.contactKey === contactKey);
    if (opts.before !== undefined) rows = rows.filter((m) => m.ts < opts.before!);
    rows = rows.sort((a, b) => b.ts - a.ts);
    if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
    return rows.map((m) => ({ ...m }));
  }

  close(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.flush();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 400);
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data), "utf8");
    await rename(tmp, this.file); // atomic-ish replace
  }
}
