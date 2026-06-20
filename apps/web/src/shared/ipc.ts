// The typed `window.orpal` contract between the shared React UI and the shell.
//
// The UI is written against this surface; a shell supplies the implementation --
// today the browser bridge (src/orpal/browser-bridge.ts, backed by IndexedDB /
// File System Access / navigator.clipboard), and a future Capacitor/Android shell
// the same way. All @orpal/core imports here are TYPE-ONLY, so this file pulls no
// runtime code into the UI.

import type {
  Contact,
  PersistedKeys,
  StoredMessage,
  ListMessagesOptions,
  PendingMessage,
  PendingPatch,
} from "@orpal/core";

/** A STUN/TURN server entry. Structurally compatible with the DOM's
 *  RTCIceServer, but defined locally so this shared contract stays
 *  self-describing and independent of the DOM lib. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Persisted app settings (board endpoints, ICE servers, relay-only default). */
export interface AppSettings {
  /** One or more boards to federate over (ws:// or wss://). */
  boards: string[];
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

/** The full surface exposed to the UI as `window.orpal`. */
export interface OrpalBridge {
  /** Private key storage (IndexedDB in the browser shell). The stored value is a
   *  `PersistedKeys`: either cleartext `StoredKeys`, or -- when secure hardware is
   *  available (ORPAL-007) -- a `SecureEnvelope` sealed to the device's secure
   *  element. The slot is opaque to this surface; `HardwareBackedKeyStore` in
   *  core decides which shape to write. */
  keys: {
    load(): Promise<PersistedKeys | null>;
    save(keys: PersistedKeys): Promise<void>;
    clear(): Promise<void>;
  };
  /** Local conversation history (IndexedDB in the browser shell). */
  store: {
    init(): Promise<void>;
    upsertContact(contact: Contact): Promise<void>;
    listContacts(): Promise<Contact[]>;
    getContact(identityKey: string): Promise<Contact | null>;
    removeContact(identityKey: string): Promise<void>;
    appendMessage(message: StoredMessage): Promise<void>;
    updateMessage(id: string, patch: MessagePatch): Promise<void>;
    getMessage(id: string): Promise<StoredMessage | null>;
    listMessages(contactKey: string, opts?: ListMessagesOptions): Promise<StoredMessage[]>;
  };
  /** Durable offline send-queue (IndexedDB in the browser shell): outbound
   *  messages persisted until the recipient acknowledges (see @orpal/core's
   *  PendingQueueStore). Survives reloads so retries resume on restart. */
  pending: {
    init(): Promise<void>;
    enqueue(msg: PendingMessage): Promise<void>;
    update(messageId: string, patch: PendingPatch): Promise<void>;
    remove(messageId: string): Promise<void>;
    get(messageId: string): Promise<PendingMessage | null>;
    list(): Promise<PendingMessage[]>;
  };
  /** Streaming file I/O for transfers -- bytes are never buffered whole in memory. */
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
    get(): Promise<AppSettings>;
    set(settings: AppSettings): Promise<void>;
  };
  /** Clipboard access for contact-card copying. Routed through the bridge so the
   *  shared UI stays shell-agnostic; the browser shell backs it with
   *  `navigator.clipboard`. */
  clipboard: {
    writeText(text: string): Promise<void>;
    readText(): Promise<string>;
  };
  /** Synthesized keyboard typing -- the last-resort way to hand a contact card to
   *  another device when both the QR code and the clipboard fail. The keystrokes
   *  are typed into whatever field is focused in the Orpal window. */
  input: {
    autoType(text: string): Promise<void>;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  // Default to the deployed reference board. Add more in Settings (e.g. a
  // locally-run board ws://127.0.0.1:8080/ via `npm run serve:dev` in the ORP repo).
  boards: ["wss://board.roshew.com/"],
  // A public STUN server lets two NATed peers find an srflx candidate. For
  // relay-only contacts you MUST add a TURN server with credentials.
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  relayOnlyByDefault: false,
};
