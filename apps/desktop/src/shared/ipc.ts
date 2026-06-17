// The typed contract for the main↔renderer IPC bridge.
//
// Shared by the main process (which implements the handlers), the preload (which
// exposes them on `window.orpal` via contextBridge), and the renderer (which
// consumes them). All @orpal/core imports here are TYPE-ONLY, so this file pulls
// no runtime code into any of the three contexts.

import type {
  Contact,
  StoredKeys,
  StoredMessage,
  ListMessagesOptions,
} from "@orpal/core";

/** A STUN/TURN server entry. Structurally compatible with the DOM's
 *  RTCIceServer, but defined locally so this shared contract doesn't require the
 *  DOM lib (it's compiled in the Node main process too). */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Persisted app settings (board endpoint, ICE servers, relay-only default). */
export interface DesktopSettings {
  boardUrl: string;
  iceServers: IceServer[];
  relayOnlyByDefault: boolean;
}

export interface FilePick {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export interface ReadHandle {
  handleId: string;
  name: string;
  size: number;
  mime: string;
}

export interface WriteHandle {
  handleId: string;
  path: string;
}

export type MessagePatch = Partial<Pick<StoredMessage, "state" | "text" | "file">>;

/** The full surface exposed to the renderer as `window.orpal`. */
export interface OrpalBridge {
  /** OS-keychain-protected private key storage (Electron safeStorage). */
  keys: {
    load(): Promise<StoredKeys | null>;
    save(keys: StoredKeys): Promise<void>;
    clear(): Promise<void>;
  };
  /** Local conversation history (SQLite in the main process). */
  store: {
    init(): Promise<void>;
    upsertContact(contact: Contact): Promise<void>;
    listContacts(): Promise<Contact[]>;
    getContact(identityKey: string): Promise<Contact | null>;
    removeContact(identityKey: string): Promise<void>;
    appendMessage(message: StoredMessage): Promise<void>;
    updateMessage(id: string, patch: MessagePatch): Promise<void>;
    listMessages(contactKey: string, opts?: ListMessagesOptions): Promise<StoredMessage[]>;
  };
  /** Streaming file I/O for transfers — bytes never buffer whole in the renderer. */
  files: {
    pickForSend(): Promise<FilePick | null>;
    openRead(path: string): Promise<ReadHandle>;
    readChunk(handleId: string, offset: number, length: number): Promise<Uint8Array>;
    hash(handleId: string): Promise<string>;
    closeRead(handleId: string): Promise<void>;
    openWrite(name: string): Promise<WriteHandle>;
    writeChunk(handleId: string, offset: number, data: Uint8Array): Promise<void>;
    finalizeWrite(handleId: string): Promise<{ sha256: string; path: string }>;
    abortWrite(handleId: string): Promise<void>;
    reveal(path: string): Promise<void>;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    set(settings: DesktopSettings): Promise<void>;
  };
}

/** IPC channel names. One per bridge method; kept in one place to avoid typos. */
export const CH = {
  keysLoad: "keys:load",
  keysSave: "keys:save",
  keysClear: "keys:clear",

  storeInit: "store:init",
  storeUpsertContact: "store:upsertContact",
  storeListContacts: "store:listContacts",
  storeGetContact: "store:getContact",
  storeRemoveContact: "store:removeContact",
  storeAppendMessage: "store:appendMessage",
  storeUpdateMessage: "store:updateMessage",
  storeListMessages: "store:listMessages",

  filePickForSend: "file:pickForSend",
  fileOpenRead: "file:openRead",
  fileReadChunk: "file:readChunk",
  fileHash: "file:hash",
  fileCloseRead: "file:closeRead",
  fileOpenWrite: "file:openWrite",
  fileWriteChunk: "file:writeChunk",
  fileFinalizeWrite: "file:finalizeWrite",
  fileAbortWrite: "file:abortWrite",
  fileReveal: "file:reveal",

  settingsGet: "settings:get",
  settingsSet: "settings:set",
} as const;

export const DEFAULT_SETTINGS: DesktopSettings = {
  // Default to the deployed reference board. Override in Settings to point at a
  // locally-run board (ws://127.0.0.1:8080/ via `npm run serve:dev` in the ORP repo).
  boardUrl: "wss://board.roshew.com/",
  // A public STUN server lets two NATed peers find an srflx candidate. For
  // relay-only contacts you MUST add a TURN server with credentials.
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  relayOnlyByDefault: false,
};
