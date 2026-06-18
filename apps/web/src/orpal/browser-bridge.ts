// Browser implementation of the `window.orpal` contract (src/shared/ipc.ts).
//
// The shared React UI talks only to `window.orpal`; this module backs that typed
// contract with browser primitives:
//
//   keys     → IndexedDB           (see the security note below)
//   store    → IndexedDB
//   files    → File System Access pick for SEND; in-memory reassembly + a
//              browser download for RECEIVE (no unprompted disk streaming exists
//              on the web, so incoming files buffer in memory — see the note)
//   settings → localStorage
//   clipboard→ navigator.clipboard
//   input    → unsupported (the QR code + manual-copy field already cover this)
//
// Because the UI depends only on `window.orpal`, installing this bridge lets the
// identical React UI + orpal-core run in any modern Chromium browser, installable
// as a PWA on desktop and Android. (A future Capacitor/Android shell would back
// the same contract with native plugins.)
//
// SECURITY NOTE: a browser has no OS keychain. Private keys live in IndexedDB,
// which is origin-scoped and not readable by other sites, but is NOT
// hardware/OS-protected. Treat the web build as convenient-and-portable, and only
// use it on a trusted origin you control (or the official deployment).

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import type {
  Contact,
  StoredKeys,
  StoredMessage,
  ListMessagesOptions,
  PendingMessage,
  PendingPatch,
} from "@orpal/core";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type FilePick,
  type MessagePatch,
  type OrpalBridge,
  type ReadHandle,
  type WriteHandle,
} from "@shared/ipc";
import {
  STORE_CONTACTS,
  STORE_MESSAGES,
  STORE_PENDING,
  del,
  get,
  getAll,
  getAllByIndex,
  kvDelete,
  kvGet,
  kvSet,
  put,
} from "./idb.js";

const KEYS_KV = "deviceKeys";
const SETTINGS_LS = "orpal:settings";
const READ_CHUNK_FOR_HASH = 1 << 20; // 1 MiB

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  zip: "application/zip",
};

function mimeFor(name: string, declared: string): string {
  if (declared) return declared;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

// ---- file SEND side: a picked File lives here, keyed by the synthetic "path" ----
const pickedFiles = new Map<string, File>();

function pickFile(): Promise<FilePick | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    // Some browsers only fire `change`/`cancel` once the element is in the DOM.
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        cleanup();
        if (!file) return resolve(null);
        // No real path on the web — a synthetic id stands in for it and keys the
        // cached File (openRead/readChunk look it up by this "path").
        const path = crypto.randomUUID();
        pickedFiles.set(path, file);
        resolve({ path, name: file.name, size: file.size, mime: mimeFor(file.name, file.type) });
      },
      { once: true },
    );
    // Modern browsers fire `cancel` when the dialog is dismissed; fall back gracefully.
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });
    input.click();
  });
}

// ---- file RECEIVE side: incoming bytes reassemble in memory, then download ----
interface WriteEntry {
  name: string;
  // offset → bytes; the engine writes idempotently and possibly out of order.
  chunks: Map<number, Uint8Array>;
}
const writes = new Map<string, WriteEntry>();

function assemble(entry: WriteEntry): Uint8Array<ArrayBuffer> {
  const offsets = [...entry.chunks.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const off of offsets) total = Math.max(total, off + entry.chunks.get(off)!.length);
  const out = new Uint8Array(total);
  for (const off of offsets) out.set(entry.chunks.get(off)!, off);
  return out;
}

function triggerDownload(name: string, bytes: Uint8Array<ArrayBuffer>): void {
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = localStorage.getItem(SETTINGS_LS);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      boards: parsed.boards?.length ? parsed.boards : DEFAULT_SETTINGS.boards,
      iceServers: parsed.iceServers ?? DEFAULT_SETTINGS.iceServers,
      relayOnlyByDefault: parsed.relayOnlyByDefault ?? DEFAULT_SETTINGS.relayOnlyByDefault,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const bridge: OrpalBridge = {
  keys: {
    load: () => kvGet<StoredKeys>(KEYS_KV),
    save: (k) => kvSet(KEYS_KV, k),
    clear: () => kvDelete(KEYS_KV),
  },

  store: {
    init: async () => {
      /* IndexedDB stores are created lazily on first open. */
    },
    upsertContact: (c: Contact) => put(STORE_CONTACTS, c),
    listContacts: () => getAll<Contact>(STORE_CONTACTS),
    getContact: (key) => get<Contact>(STORE_CONTACTS, key),
    removeContact: (key) => del(STORE_CONTACTS, key),
    appendMessage: (m: StoredMessage) => put(STORE_MESSAGES, m),
    updateMessage: async (id: string, patch: MessagePatch) => {
      const existing = await get<StoredMessage>(STORE_MESSAGES, id);
      if (!existing) return;
      await put(STORE_MESSAGES, { ...existing, ...patch });
    },
    listMessages: async (contactKey: string, opts: ListMessagesOptions = {}) => {
      let rows = await getAllByIndex<StoredMessage>(STORE_MESSAGES, "contactKey", contactKey);
      if (opts.before !== undefined) rows = rows.filter((m) => m.ts < opts.before!);
      rows.sort((a, b) => b.ts - a.ts); // newest-first, matching listMessages' contract
      if (opts.limit !== undefined) rows = rows.slice(0, opts.limit);
      return rows;
    },
  },

  pending: {
    init: async () => {
      /* IndexedDB stores are created lazily on first open (see idb.ts). */
    },
    enqueue: (msg: PendingMessage) => put(STORE_PENDING, msg),
    update: async (messageId: string, patch: PendingPatch) => {
      const existing = await get<PendingMessage>(STORE_PENDING, messageId);
      if (!existing) return;
      await put(STORE_PENDING, { ...existing, ...patch });
    },
    remove: (messageId: string) => del(STORE_PENDING, messageId),
    get: (messageId: string) => get<PendingMessage>(STORE_PENDING, messageId),
    list: () => getAll<PendingMessage>(STORE_PENDING),
  },

  files: {
    pickForSend: () => pickFile(),

    openRead: async (path: string): Promise<ReadHandle> => {
      const file = pickedFiles.get(path);
      if (!file) throw new Error(`web file bridge: no picked file ${path}`);
      // The "path" doubles as the handleId on the web — the File stays cached.
      return { handleId: path, name: file.name, size: file.size, mime: mimeFor(file.name, file.type) };
    },

    readChunk: async (handleId: string, offset: number, length: number): Promise<Uint8Array> => {
      const file = pickedFiles.get(handleId);
      if (!file) throw new Error(`web file bridge: no open read handle ${handleId}`);
      const buf = await file.slice(offset, offset + length).arrayBuffer();
      return new Uint8Array(buf);
    },

    hash: async (handleId: string): Promise<string> => {
      const file = pickedFiles.get(handleId);
      if (!file) throw new Error(`web file bridge: no open read handle ${handleId}`);
      // Stream the hash so a large file never has to sit in memory all at once.
      const hasher = sha256.create();
      for (let off = 0; off < file.size; off += READ_CHUNK_FOR_HASH) {
        const buf = await file.slice(off, off + READ_CHUNK_FOR_HASH).arrayBuffer();
        hasher.update(new Uint8Array(buf));
      }
      return bytesToHex(hasher.digest());
    },

    closeRead: async (handleId: string): Promise<void> => {
      pickedFiles.delete(handleId);
    },

    openWrite: async (name: string): Promise<WriteHandle> => {
      const handleId = crypto.randomUUID();
      writes.set(handleId, { name, chunks: new Map() });
      // No real filesystem path on the web — surface the chosen name.
      return { handleId, path: name };
    },

    writeChunk: async (handleId: string, offset: number, data: Uint8Array): Promise<void> => {
      const entry = writes.get(handleId);
      if (!entry) throw new Error(`web file bridge: no open write handle ${handleId}`);
      // Copy: the caller may reuse the underlying buffer after this resolves.
      entry.chunks.set(offset, data.slice());
    },

    finalizeWrite: async (handleId: string): Promise<{ sha256: string; path: string }> => {
      const entry = writes.get(handleId);
      if (!entry) throw new Error(`web file bridge: no open write handle ${handleId}`);
      writes.delete(handleId);
      const bytes = assemble(entry);
      const hash = bytesToHex(sha256(bytes));
      triggerDownload(entry.name, bytes); // hand the completed, verified file to the user
      return { sha256: hash, path: entry.name };
    },

    abortWrite: async (handleId: string): Promise<void> => {
      writes.delete(handleId);
    },

    reveal: async (): Promise<void> => {
      // No OS file manager to reveal into on the web; the file was downloaded on
      // finalize, so this is a no-op.
    },
  },

  settings: {
    get: () => loadSettings(),
    set: async (s: AppSettings) => {
      localStorage.setItem(SETTINGS_LS, JSON.stringify(s));
    },
  },

  clipboard: {
    writeText: async (text: string) => {
      await navigator.clipboard.writeText(text);
    },
    readText: () => navigator.clipboard.readText(),
  },

  input: {
    autoType: async () => {
      // No synthetic-keyboard API in a browser sandbox. The QR code and the
      // manual-copy field in the identity modal are the supported paths.
      throw new Error("auto-type is not available in the browser build");
    },
  },
};

/** Install the browser bridge on `window.orpal`. Call once, before the React app
 *  mounts (so the very first `createOrpalApp()` sees it). */
export function installBrowserBridge(): void {
  (window as unknown as { orpal: OrpalBridge }).orpal = bridge;
}
