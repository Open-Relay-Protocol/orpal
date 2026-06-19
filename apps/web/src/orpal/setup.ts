// Wire orpal-core together for the UI: native WebSocket broker, native
// RTCPeerConnection endpoints (the default factory inside OrpalClient), and
// identity / history / file I/O via the `window.orpal` bridge.

import {
  BrowserRendezvousBroker,
  IdentityManager,
  OrpalClient,
  type DeviceIdentity,
} from "@orpal/core";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/ipc";
import {
  IpcConversationStore,
  IpcMigrationStore,
  IpcPendingQueueStore,
  IpcSecureKeyStore,
  createIncomingFileSink,
} from "./bridge-stores.js";

export interface OrpalApp {
  orpal: OrpalClient;
  identity: DeviceIdentity;
  createdIdentity: boolean;
  settings: AppSettings;
}

export async function createOrpalApp(): Promise<OrpalApp> {
  const settings = await window.orpal.settings.get();

  // Load the identity from the OS keychain, or generate + persist one on first run.
  const keyStore = new IpcSecureKeyStore();
  const { identity, created } = await IdentityManager.loadOrCreate(keyStore);

  // Each board needs to call back into OrpalClient on (re)connect; OrpalClient
  // needs the boards at construction. Resolve the cycle with a forward ref.
  let app: OrpalClient | undefined;
  // Defensive: tolerate older/partial settings that predate the multi-board field.
  const boardUrls =
    settings.boards && settings.boards.length ? settings.boards : DEFAULT_SETTINGS.boards;
  const boards = boardUrls.map((url) => ({
    id: url,
    broker: new BrowserRendezvousBroker(url, {
      WebSocketImpl: window.WebSocket,
      onOpen: () => app?.onBrokerOpen(url),
      onClose: (info) =>
        app?.onBrokerClose(url, `code=${info.code}${info.reason ? ` ${info.reason}` : ""}`),
      onError: () => app?.onBrokerError(url, "socket error"),
    }),
  }));

  const orpal = new OrpalClient({
    identity,
    store: new IpcConversationStore(),
    // Durably queue messages to offline contacts and retry until acknowledged
    // (issue #11). Persisted in IndexedDB, so retries resume after a reload.
    pendingQueue: new IpcPendingQueueStore(),
    boards,
    iceServers: settings.iceServers,
    relayOnlyByDefault: settings.relayOnlyByDefault,
    createFileSink: (offer) => createIncomingFileSink(offer),
    migrationStore: new IpcMigrationStore(),
    keyStore,
  });
  app = orpal;

  await orpal.start();
  return { orpal, identity, createdIdentity: created, settings };
}
