// Adapters that satisfy orpal-core's runtime-agnostic interfaces by delegating to
// the `window.orpal` bridge. This is the seam where the framework-agnostic core
// meets the shell's storage and file services (the browser bridge today).

import type {
  ConversationStore,
  Contact,
  FileOfferFrame,
  FileSink,
  FileSource,
  IncomingFileSink,
  ListMessagesOptions,
  MigrationState,
  MigrationStore,
  PendingMessage,
  PendingPatch,
  PendingQueueStore,
  SecureKeyStore,
  StoredKeys,
  StoredMessage,
} from "@orpal/core";
import type { FilePick, MessagePatch } from "@shared/ipc";
import { kvGet, kvSet, kvDelete } from "./idb.js";

const MIGRATION_KV = "migrationState";

/** Private keys via the shell's secure storage (IndexedDB in the browser bridge). */
export class IpcSecureKeyStore implements SecureKeyStore {
  load(): Promise<StoredKeys | null> {
    return window.orpal.keys.load();
  }
  save(keys: StoredKeys): Promise<void> {
    return window.orpal.keys.save(keys);
  }
  clear(): Promise<void> {
    return window.orpal.keys.clear();
  }
}

/** Conversation history via the shell's store (IndexedDB in the browser bridge). */
export class IpcConversationStore implements ConversationStore {
  init(): Promise<void> {
    return window.orpal.store.init();
  }
  upsertContact(contact: Contact): Promise<void> {
    return window.orpal.store.upsertContact(contact);
  }
  listContacts(): Promise<Contact[]> {
    return window.orpal.store.listContacts();
  }
  getContact(identityKey: string): Promise<Contact | null> {
    return window.orpal.store.getContact(identityKey);
  }
  removeContact(identityKey: string): Promise<void> {
    return window.orpal.store.removeContact(identityKey);
  }
  appendMessage(message: StoredMessage): Promise<void> {
    return window.orpal.store.appendMessage(message);
  }
  updateMessage(id: string, patch: MessagePatch): Promise<void> {
    return window.orpal.store.updateMessage(id, patch);
  }
  listMessages(contactKey: string, opts?: ListMessagesOptions): Promise<StoredMessage[]> {
    return window.orpal.store.listMessages(contactKey, opts);
  }
}

/** Durable offline send-queue via the shell's store (IndexedDB in the browser
 *  bridge). Lets OrpalClient persist + retry messages to offline contacts. */
export class IpcPendingQueueStore implements PendingQueueStore {
  init(): Promise<void> {
    return window.orpal.pending.init();
  }
  enqueue(msg: PendingMessage): Promise<void> {
    return window.orpal.pending.enqueue(msg);
  }
  update(messageId: string, patch: PendingPatch): Promise<void> {
    return window.orpal.pending.update(messageId, patch);
  }
  remove(messageId: string): Promise<void> {
    return window.orpal.pending.remove(messageId);
  }
  get(messageId: string): Promise<PendingMessage | null> {
    return window.orpal.pending.get(messageId);
  }
  list(): Promise<PendingMessage[]> {
    return window.orpal.pending.list();
  }
}

/** A FileSource that streams chunks off disk via main (sender side). */
export async function makeFileSource(pick: FilePick): Promise<FileSource> {
  const handle = await window.orpal.files.openRead(pick.path);
  return {
    name: handle.name,
    size: handle.size,
    mime: handle.mime,
    readChunk: (offset, length) => window.orpal.files.readChunk(handle.handleId, offset, length),
    sha256: () => window.orpal.files.hash(handle.handleId),
    close: () => window.orpal.files.closeRead(handle.handleId),
  };
}

/** Create the sink an incoming file streams into (receiver side). */
export async function createIncomingFileSink(offer: FileOfferFrame): Promise<IncomingFileSink> {
  const handle = await window.orpal.files.openWrite(offer.name);
  const sink: FileSink = {
    writeChunk: (offset, data) => window.orpal.files.writeChunk(handle.handleId, offset, data),
    finalize: () => window.orpal.files.finalizeWrite(handle.handleId),
    abort: () => window.orpal.files.abortWrite(handle.handleId),
  };
  return { sink, path: handle.path };
}

/** Durable migration state via the KV store (IndexedDB). Survives restarts so a
 *  migration in progress resumes where it left off. */
export class IpcMigrationStore implements MigrationStore {
  async load(): Promise<MigrationState | null> {
    return kvGet<MigrationState>(MIGRATION_KV);
  }
  async save(state: MigrationState): Promise<void> {
    await kvSet(MIGRATION_KV, state);
  }
  async clear(): Promise<void> {
    await kvDelete(MIGRATION_KV);
  }
}
