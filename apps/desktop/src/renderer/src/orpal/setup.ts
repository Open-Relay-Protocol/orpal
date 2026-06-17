// Wire orpal-core together in the renderer: native WebSocket broker, native
// RTCPeerConnection endpoints (the default factory inside OrpalClient), OS-keychain
// identity, SQLite history, and streaming file I/O — all via the IPC bridge.

import {
  BrowserRendezvousBroker,
  IdentityManager,
  OrpalClient,
  type DeviceIdentity,
} from "@orpal/core";
import type { DesktopSettings } from "@shared/ipc";
import {
  IpcConversationStore,
  IpcSecureKeyStore,
  createIncomingFileSink,
} from "./bridge-stores.js";

export interface OrpalApp {
  orpal: OrpalClient;
  identity: DeviceIdentity;
  createdIdentity: boolean;
  settings: DesktopSettings;
}

export async function createOrpalApp(): Promise<OrpalApp> {
  const settings = await window.orpal.settings.get();

  // Load the identity from the OS keychain, or generate + persist one on first run.
  const { identity, created } = await IdentityManager.loadOrCreate(new IpcSecureKeyStore());

  // The broker needs to call back into OrpalClient on (re)connect; OrpalClient
  // needs the broker at construction. Resolve the cycle with a forward ref.
  let app: OrpalClient | undefined;
  const broker = new BrowserRendezvousBroker(settings.boardUrl, {
    WebSocketImpl: window.WebSocket,
    onOpen: () => app?.onBrokerOpen(),
    onClose: (info) => app?.onBrokerClose(`code=${info.code}${info.reason ? ` ${info.reason}` : ""}`),
    onError: () => app?.onBrokerError("socket error"),
  });

  const orpal = new OrpalClient({
    identity,
    store: new IpcConversationStore(),
    broker,
    iceServers: settings.iceServers,
    relayOnlyByDefault: settings.relayOnlyByDefault,
    createFileSink: (offer) => createIncomingFileSink(offer),
  });
  app = orpal;

  await orpal.start();
  return { orpal, identity, createdIdentity: created, settings };
}
