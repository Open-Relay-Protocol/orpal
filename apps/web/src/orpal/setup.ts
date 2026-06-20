// Wire orpal-core together for the UI: native WebSocket broker, native
// RTCPeerConnection endpoints (the default factory inside OrpalClient), and
// identity / history / file I/O via the `window.orpal` bridge.

import {
  BrowserRendezvousBroker,
  HardwareBackedKeyStore,
  IdentityManager,
  OrpalClient,
  type DeviceIdentity,
} from "@orpal/core";
import { DEFAULT_SETTINGS, type AppSettings } from "@shared/ipc";
import {
  IpcConversationStore,
  IpcKeyBlobStore,
  IpcMigrationStore,
  IpcPendingKeyBlobStore,
  IpcPendingQueueStore,
  createIncomingFileSink,
} from "./bridge-stores.js";
import { createHardwareKeyProvider } from "./webauthn-keystore.js";
import {
  SealedCredentialStore,
  extractTurnCredentials,
  hasInlineTurnSecret,
  mergeTurnCredentials,
  stripTurnCredentials,
} from "./turn-credentials.js";

export interface OrpalApp {
  orpal: OrpalClient;
  identity: DeviceIdentity;
  createdIdentity: boolean;
  /** Settings with sealed TURN credentials merged back in (for the UI to edit). */
  settings: AppSettings;
  /** Sealed store for the TURN credentials (ORPAL-014); used when saving settings. */
  turnCredStore: SealedCredentialStore;
}

export async function createOrpalApp(): Promise<OrpalApp> {
  const settings = await window.orpal.settings.get();

  // Load the identity from secure storage, or generate + persist one on first run.
  // ORPAL-007: when the device exposes a WebAuthn platform authenticator, seal the
  // keys to its secure element (Secure Enclave / Android Keystore-StrongBox / TPM);
  // otherwise HardwareBackedKeyStore falls back to the cleartext IndexedDB slot.
  // The keyStore stays a plain SecureKeyStore, so OrpalClient/IdentityManager are
  // unchanged either way.
  const hardwareProvider = await createHardwareKeyProvider();
  const onSealFallback = (err: unknown) =>
    // eslint-disable-next-line no-console
    console.warn("[orpal] secure-hardware key sealing unavailable; stored in cleartext", err);
  const keyStore = new HardwareBackedKeyStore(
    new IpcKeyBlobStore(),
    hardwareProvider,
    onSealFallback,
  );
  // ORPAL-013: seal the migration's pending new identity through the same path,
  // over its own slot, so those keys are never written in cleartext either.
  const migrationKeyStore = new HardwareBackedKeyStore(
    new IpcPendingKeyBlobStore(),
    hardwareProvider,
    onSealFallback,
  );
  const { identity, created } = await IdentityManager.loadOrCreate(keyStore);

  // ORPAL-014: keep TURN credentials out of plaintext localStorage. They're sealed
  // through the same hardware path in their own slot; AppSettings holds only the
  // TURN URLs. Migrate any pre-ORPAL-014 inline secrets into the sealed store and
  // strip them from localStorage, then merge the sealed secrets back in for use.
  const turnCredStore = new SealedCredentialStore(hardwareProvider, onSealFallback);
  let turnCreds = await turnCredStore.load();
  if (hasInlineTurnSecret(settings.iceServers)) {
    turnCreds = { ...extractTurnCredentials(settings.iceServers), ...turnCreds };
    await turnCredStore.save(turnCreds);
    settings.iceServers = stripTurnCredentials(settings.iceServers);
    await window.orpal.settings.set(settings);
  }
  const iceServers = mergeTurnCredentials(settings.iceServers, turnCreds);
  const mergedSettings: AppSettings = { ...settings, iceServers };

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
    iceServers,
    relayOnlyByDefault: settings.relayOnlyByDefault,
    createFileSink: (offer) => createIncomingFileSink(offer),
    migrationStore: new IpcMigrationStore(),
    keyStore,
    migrationKeyStore,
  });
  app = orpal;

  await orpal.start();
  return { orpal, identity, createdIdentity: created, settings: mergedSettings, turnCredStore };
}
