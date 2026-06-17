// Tiny promise wrapper over IndexedDB. The web shell persists the device's
// private keys and the conversation history here (the Electron shell uses the OS
// keychain + SQLite in its main process). IndexedDB is the only durable,
// reasonably-sized, origin-scoped store available in every modern browser.

export const DB_NAME = "orpal";
export const DB_VERSION = 1;

export const STORE_KV = "kv"; // misc key/value (private keys)
export const STORE_CONTACTS = "contacts"; // keyPath: identityKey
export const STORE_MESSAGES = "messages"; // keyPath: id, index: contactKey

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV);
      if (!db.objectStoreNames.contains(STORE_CONTACTS)) {
        db.createObjectStore(STORE_CONTACTS, { keyPath: "identityKey" });
      }
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const msgs = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
        msgs.createIndex("contactKey", "contactKey", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, "readonly");
  const v = await promisify<T | undefined>(tx.objectStore(STORE_KV).get(key));
  return v ?? null;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, "readwrite");
  tx.objectStore(STORE_KV).put(value, key);
  await txDone(tx);
}

export async function kvDelete(key: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_KV, "readwrite");
  tx.objectStore(STORE_KV).delete(key);
  await txDone(tx);
}

export async function put<T>(store: string, value: T): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await txDone(tx);
}

export async function get<T>(store: string, key: IDBValidKey): Promise<T | null> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  const v = await promisify<T | undefined>(tx.objectStore(store).get(key));
  return v ?? null;
}

export async function del(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await txDone(tx);
}

export async function getAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return promisify<T[]>(tx.objectStore(store).getAll());
}

export async function getAllByIndex<T>(
  store: string,
  index: string,
  key: IDBValidKey,
): Promise<T[]> {
  const db = await openDb();
  const tx = db.transaction(store, "readonly");
  return promisify<T[]>(tx.objectStore(store).index(index).getAll(key));
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("indexedDB tx failed"));
  });
}
