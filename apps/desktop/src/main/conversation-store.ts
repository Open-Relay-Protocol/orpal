// Conversation-store factory.
//
// Prefers real SQLite (better-sqlite3) — the spec's choice — but that's a native
// module that may not build for every Node/Electron ABI. So it's an OPTIONAL
// dependency: if it loaded, we use it; otherwise we transparently fall back to a
// pure-JS file-backed store with the identical interface. Either way the renderer
// (and OrpalClient) see the same ConversationStore contract.

import type { ConversationStore } from "@orpal/core";

export interface ClosableStore extends ConversationStore {
  close(): void;
}

export async function createConversationStore(userDataDir: string): Promise<ClosableStore> {
  try {
    const { SqliteConversationStore } = await import("./conversation-store-sqlite.js");
    const store = new SqliteConversationStore(userDataDir);
    // eslint-disable-next-line no-console
    console.log("[orpal] history store: SQLite (better-sqlite3)");
    return store;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[orpal] better-sqlite3 unavailable; using the JSON file store fallback.",
      err instanceof Error ? err.message : err,
    );
    const { JsonConversationStore } = await import("./conversation-store-json.js");
    return new JsonConversationStore(userDataDir);
  }
}
