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
  KeyBlobStore,
  ListMessagesOptions,
  MigrationState,
  MigrationStore,
  PendingMessage,
  PendingPatch,
  PendingQueueStore,
  PersistedKeys,
  SecureKeyStore,
  StoredKeys,
  StoredMessage,
} from "@orpal/core";
import type { FilePick, MessagePatch } from "@shared/ipc";
import { kvGet, kvSet, kvDelete } from "./idb.js";

const MIGRATION_KV = "migrationState";
const PENDING_KEYS_KV = "deviceKeys:pending";

/** Private keys via the shell's secure storage (IndexedDB in the browser bridge).
 *  Used directly for the cleartext path; on a device with secure hardware it's the
 *  inner slot of a {@link HardwareBackedKeyStore} (see IpcKeyBlobStore). */
export class IpcSecureKeyStore implements SecureKeyStore {
  load(): Promise<StoredKeys | null> {
    return window.orpal.keys.load() as Promise<StoredKeys | null>;
  }
  save(keys: StoredKeys): Promise<void> {
    return window.orpal.keys.save(keys);
  }
  clear(): Promise<void> {
    return window.orpal.keys.clear();
  }
}

/** The raw key slot (cleartext keys OR a hardware-sealed envelope) backing
 *  HardwareBackedKeyStore. Same IndexedDB slot as IpcSecureKeyStore, but typed
 *  over the `PersistedKeys` union so it can hold either shape (ORPAL-007). */
export class IpcKeyBlobStore implements KeyBlobStore {
  load(): Promise<PersistedKeys | null> {
    return window.orpal.keys.load();
  }
  save(value: PersistedKeys): Promise<void> {
    return window.orpal.keys.save(value);
  }
  clear(): Promise<void> {
    return window.orpal.keys.clear();
  }
}

/** ORPAL-013: the raw key slot for the PENDING new identity during a migration.
 *  A distinct IndexedDB KV slot from the main `deviceKeys` slot, so wrapping it in
 *  a HardwareBackedKeyStore seals the migration's new keys at rest exactly like
 *  the main identity -- they never sit in the migration store in cleartext. */
export class IpcPendingKeyBlobStore implements KeyBlobStore {
  load(): Promise<PersistedKeys | null> {
    return kvGet<PersistedKeys>(PENDING_KEYS_KV);
  }
  async save(value: PersistedKeys): Promise<void> {
    await kvSet(PENDING_KEYS_KV, value);
  }
  clear(): Promise<void> {
    return kvDelete(PENDING_KEYS_KV);
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
  getMessage(id: string): Promise<StoredMessage | null> {
    return window.orpal.store.getMessage(id);
  }
  listMessages(contactKey: string, opts?: ListMessagesOptions): Promise<StoredMessage[]> {
    return window.orpal.store.listMessages(contactKey, opts);
  }
  listAllMessages(): Promise<StoredMessage[]> {
    return window.orpal.store.listAllMessages();
  }
  clear(): Promise<void> {
    return window.orpal.store.clear();
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
  clear(): Promise<void> {
    return window.orpal.pending.clear();
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
