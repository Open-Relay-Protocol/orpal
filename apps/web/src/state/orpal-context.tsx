import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  shortKey,
  type BackupPayload,
  type Contact,
  type ContactRequest,
  type ContactState,
  type ImportSummary,
  type LoopbackSelfTestResult,
  type MigrationProgress,
  type OrpalClient,
  type PendingMigration,
  type PendingMetrics,
  type StoredMessage,
} from "@orpal/core";
import type { AppSettings } from "@shared/ipc";
import { createOrpalApp, type KeyProtection } from "../orpal/setup.js";
import { enablePush, disablePush, pushSupported as pushIsSupported } from "../orpal/push.js";
import { makeFileSource } from "../orpal/bridge-stores.js";
import { kvGet, kvSet } from "../orpal/idb.js";
import {
  extractTurnCredentials,
  stripTurnCredentials,
  type SealedCredentialStore,
} from "../orpal/turn-credentials.js";

export type BrokerState = "connecting" | "open" | "closed" | "error";

export interface Conversation {
  key: string;
  name: string;
  relayOnly: boolean;
  known: boolean;
  /** issue #41: the diagnostic loopback/self-test contact, badged in the UI. */
  isLoopback: boolean;
}

interface OrpalContextValue {
  status: "loading" | "ready" | "error";
  errorMsg: string | null;
  identityKey: string;
  ownCard: string;
  contacts: Contact[];
  conversations: Conversation[];
  selected: string | null;
  messages: StoredMessage[];
  connectionOf: (key: string) => ContactState;
  brokerState: BrokerState;
  /** Offline send-queue health (issue #17): pending count, oldest, attempts. */
  pendingMetrics: PendingMetrics;
  /** Whether the device's keys are hardware-sealed or in cleartext fallback (ORPAL-015). */
  keyProtection: KeyProtection;
  settings: AppSettings;
  settingsNeedRestart: boolean;

  select: (key: string | null) => void;
  sendText: (text: string) => void;
  sendFile: () => Promise<void>;
  retry: (messageId: string) => void;
  connect: (key: string) => void;
  addContact: (
    cardText: string,
    name?: string,
    relayOnly?: boolean,
  ) => Promise<{ ok: boolean; reason?: string }>;
  removeContact: (key: string) => Promise<void>;
  /** Rename a contact locally (display label only; never sent to peer/board). */
  renameContact: (key: string, name: string) => Promise<void>;
  setRelayOnly: (key: string, value: boolean) => Promise<void>;

  /** Pending message requests from unknown senders (not yet contacts) who handed
   *  us their card in-band. The UI prompts the user to accept or block each. */
  contactRequests: ContactRequest[];
  /** Accept an unknown sender: add them as a full two-way contact, optionally
   *  naming them. */
  acceptContactRequest: (key: string, name?: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Dismiss a request without accepting/blocking (reappears if they reconnect). */
  dismissContactRequest: (key: string) => void;
  /** Identity keys the user has blocked (from settings). */
  blockedKeys: string[];
  /** Block an identity key: refuse their connection, drop the conversation, and
   *  persist them to the block list. */
  blockContact: (key: string) => Promise<void>;
  /** Remove an identity key from the block list. */
  unblockContact: (key: string) => Promise<void>;
  /** Contact backup/migration (issue #41). Export serializes the shareable fields
   *  of every contact (no private keys / history, loopback excluded) to a file;
   *  import re-validates each binding and reports imported/skipped/rejected. */
  exportContacts: () => Promise<void>;
  importContacts: (onCollision: "skip" | "overwrite") => Promise<ImportSummary | null>;
  /** Create (or surface) the diagnostic loopback "Test (me)" contact (issue #41). */
  createTestContact: () => Promise<void>;
  /** Run the loopback self-test: board reachable + on-device crypto round-trip. */
  runSelfTest: () => Promise<LoopbackSelfTestResult>;
  /** Per-contact board routes (issue #19); empty list restores all-boards default. */
  setContactBoards: (key: string, preferredBoards: string[]) => Promise<void>;
  saveSettings: (s: AppSettings) => Promise<void>;
  reveal: (path: string) => void;

  /** ORPAL-016: wake-on-push state + a live toggle (applied immediately, no
   *  restart). `pushSupported` is false where the runtime can't register at all
   *  (e.g. no service worker / Push API). `setPushEnabled` resolves on success
   *  and rejects with a human-readable message if permission/registration fails,
   *  leaving the setting unchanged. */
  pushEnabled: boolean;
  pushSupported: boolean;
  setPushEnabled: (on: boolean) => Promise<void>;

  migrationProgress: MigrationProgress | null;
  pendingIncomingMigrations: readonly PendingMigration[];
  startMigration: (retireAfterUtc: string) => Promise<void>;
  retireMigration: () => Promise<void>;
  acceptMigration: (contactKey: string) => Promise<boolean>;
  declineMigration: (contactKey: string) => void;
  setAutoAcceptMigration: (key: string, value: boolean) => Promise<void>;

  gatherBackupPayload: () => Promise<BackupPayload>;
  restoreBackupPayload: (payload: BackupPayload) => Promise<void>;

  unreadByContact: Record<string, number>;
  totalUnread: number;
}

// Placeholder settings before the real ones load (empty, not the real defaults,
// so we never momentarily advertise default boards). Mirrors AppSettings shape.
const EMPTY_SETTINGS: AppSettings = {
  boards: [],
  iceServers: [],
  relayOnlyByDefault: false,
  pushNotifications: false,
  blockedKeys: [],
};

const EMPTY_METRICS: PendingMetrics = {
  total: 0,
  oldestPendingTs: null,
  lastAttemptAt: null,
  totalAttempts: 0,
  maxAttempts: 0,
  byRecipient: {},
};

// One-time flag (issue #41): set once the loopback contact has been auto-seeded,
// so deleting it doesn't make it reappear on the next launch.
const LOOPBACK_SEEDED_KV = "loopbackSeeded";

const OrpalContext = createContext<OrpalContextValue | null>(null);

export function useOrpal(): OrpalContextValue {
  const ctx = useContext(OrpalContext);
  if (!ctx) throw new Error("useOrpal must be used within <OrpalProvider>");
  return ctx;
}

export function OrpalProvider({ children }: { children: ReactNode }) {
  const orpalRef = useRef<OrpalClient | null>(null);
  const turnCredStoreRef = useRef<SealedCredentialStore | null>(null);
  const initedRef = useRef(false);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [identityKey, setIdentityKey] = useState("");
  const [ownCard, setOwnCard] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messagesByContact, setMessagesByContact] = useState<Record<string, StoredMessage[]>>({});
  const [connByContact, setConnByContact] = useState<Record<string, ContactState>>({});
  const [brokerState, setBrokerState] = useState<BrokerState>("connecting");
  const [pendingMetrics, setPendingMetrics] = useState<PendingMetrics>(EMPTY_METRICS);
  const [keyProtection, setKeyProtection] = useState<KeyProtection>("cleartext");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsNeedRestart, setSettingsNeedRestart] = useState(false);
  const [pushEnabled, setPushEnabledState] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [pendingIncomingMigrations, setPendingIncomingMigrations] = useState<readonly PendingMigration[]>([]);
  const [contactRequests, setContactRequests] = useState<ContactRequest[]>([]);
  const [unreadByContact, setUnreadByContact] = useState<Record<string, number>>({});
  const lastReadRef = useRef<Record<string, number>>(
    (() => { try { return JSON.parse(localStorage.getItem("orpal:lastRead") ?? "{}"); } catch { return {}; } })(),
  );
  const selectedRef = useRef<string | null>(null);

  const upsertMessage = useCallback((m: StoredMessage) => {
    setMessagesByContact((prev) => {
      const list = prev[m.contactKey] ?? [];
      const idx = list.findIndex((x) => x.id === m.id);
      const next = idx === -1 ? [...list, m] : list.map((x) => (x.id === m.id ? m : x));
      next.sort((a, b) => a.ts - b.ts);
      return { ...prev, [m.contactKey]: next };
    });
    if (m.direction === "in" && m.contactKey !== selectedRef.current) {
      const lastRead = lastReadRef.current[m.contactKey] ?? 0;
      if (m.ts > lastRead) {
        setUnreadByContact((prev) => ({ ...prev, [m.contactKey]: (prev[m.contactKey] ?? 0) + 1 }));
      }
    }
  }, []);

  const refreshContacts = useCallback(async () => {
    const orpal = orpalRef.current;
    if (!orpal) return;
    setContacts(await orpal.listContacts());
  }, []);

  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    (async () => {
      try {
        const app = await createOrpalApp();
        orpalRef.current = app.orpal;
        turnCredStoreRef.current = app.turnCredStore;
        // Key-protection status (ORPAL-015): seed + live updates if a later save
        // falls back to cleartext.
        setKeyProtection(app.keyProtection);
        app.onKeyProtectionChange(setKeyProtection);
        setIdentityKey(app.orpal.identityKey);
        setOwnCard(app.orpal.ownContactCard());
        setSettings(app.settings);

        // issue #41: on a genuine first run (no contacts yet, never seeded) create
        // the diagnostic loopback "Test (me)" contact so a new user can verify
        // their setup. The one-time flag means we never resurrect it after the
        // user deletes it.
        const seeded = await kvGet<boolean>(LOOPBACK_SEEDED_KV);
        if (!seeded && (await app.orpal.listContacts()).length === 0) {
          await app.orpal.ensureLoopbackContact();
          await kvSet(LOOPBACK_SEEDED_KV, true);
        }
        await refreshContacts();

        app.orpal.events.on("message", ({ message }) => upsertMessage(message));
        app.orpal.events.on("message-updated", ({ message }) => upsertMessage(message));
        app.orpal.events.on("connection", ({ contactKey, state }) =>
          setConnByContact((prev) => ({ ...prev, [contactKey]: state })),
        );
        app.orpal.events.on("broker", ({ state }) => setBrokerState(state));
        // Seed from current state in case "open" fired before we subscribed.
        setBrokerState(app.orpal.brokerStatus);
        // Offline send-queue health (issue #17): live updates + an initial seed
        // (the queue may already hold messages resumed from a previous session).
        app.orpal.events.on("pending", ({ metrics }) => setPendingMetrics(metrics));
        setPendingMetrics(await app.orpal.pendingMetrics());
        // Unknown senders who messaged us and handed us their card in-band:
        // surface them as message requests for the user to accept or block.
        app.orpal.events.on("contact-request", (req) =>
          setContactRequests((prev) =>
            prev.some((r) => r.contactKey === req.contactKey) ? prev : [...prev, req],
          ),
        );
        setContactRequests([...app.orpal.contactRequests]);
        app.orpal.events.on("error", ({ error, context }) =>
          // eslint-disable-next-line no-console
          console.warn("[orpal]", context, error),
        );
        // Migration (ORPAL-008): progress updates + incoming prompts.
        app.orpal.events.on("migration-progress", ({ progress }) =>
          setMigrationProgress(progress),
        );
        app.orpal.events.on("migration-incoming", () =>
          setPendingIncomingMigrations([...app.orpal.pendingIncomingMigrations]),
        );
        setMigrationProgress(app.orpal.migrationProgress);

        // ORPAL-016: if push was opted into a previous session, re-register and
        // re-advertise the token now. Best-effort: a revoked permission or a
        // missing VAPID key just leaves the device reachable-while-open, and we
        // reflect the real state back into the toggle.
        if (app.settings.pushNotifications && pushIsSupported()) {
          try {
            app.orpal.setPushToken(await enablePush());
            setPushEnabledState(true);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn("[orpal] push re-registration failed; staying opted out", err);
            setPushEnabledState(false);
          }
        }

        // A contentless wake from the service worker means a peer is trying to
        // reach us: make sure presence is back out there immediately rather than
        // waiting for the next interval (the broker reconnects on its own).
        if ("serviceWorker" in navigator) {
          navigator.serviceWorker.addEventListener("message", (event) => {
            if ((event.data as { type?: string } | null)?.type === "orpal-wake") {
              orpalRef.current?.reannounce();
            }
          });
        }

        setStatus("ready");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, [refreshContacts, upsertMessage]);

  const select = useCallback(
    (key: string | null) => {
      setSelected(key);
      selectedRef.current = key;
      if (key) {
        lastReadRef.current[key] = Date.now();
        try { localStorage.setItem("orpal:lastRead", JSON.stringify(lastReadRef.current)); } catch { /* quota */ }
        setUnreadByContact((prev) => {
          if (!prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
      const orpal = orpalRef.current;
      if (!key || !orpal) return;
      void (async () => {
        const hist = await orpal.history(key, { limit: 500 });
        setMessagesByContact((prev) => ({ ...prev, [key]: [...hist].reverse() }));
        orpal.connect(key).catch(() => {
          /* offline -- surfaced via the connection event */
        });
      })();
    },
    [],
  );

  const sendText = useCallback(
    (text: string) => {
      const orpal = orpalRef.current;
      if (!orpal || !selected || !text.trim()) return;
      void orpal.sendText(selected, text);
    },
    [selected],
  );

  const sendFile = useCallback(async () => {
    const orpal = orpalRef.current;
    if (!orpal || !selected) return;
    const pick = await window.orpal.files.pickForSend();
    if (!pick) return;
    const source = await makeFileSource(pick);
    void orpal.sendFile(selected, source);
  }, [selected]);

  const retry = useCallback(
    (messageId: string) => {
      const orpal = orpalRef.current;
      if (!orpal || !selected) return;
      void orpal.retryText(messageId, selected);
    },
    [selected],
  );

  const connect = useCallback((key: string) => {
    orpalRef.current?.connect(key).catch(() => {});
  }, []);

  const addContact = useCallback(
    async (cardText: string, name?: string, relayOnly?: boolean) => {
      const orpal = orpalRef.current;
      if (!orpal) return { ok: false, reason: "not-ready" };
      const res = await orpal.addContactFromCard(cardText, { displayName: name, relayOnly });
      if (res.ok) await refreshContacts();
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },
    [refreshContacts],
  );

  const removeContact = useCallback(
    async (key: string) => {
      await orpalRef.current?.removeContact(key);
      if (selected === key) setSelected(null);
      await refreshContacts();
    },
    [refreshContacts, selected],
  );

  const renameContact = useCallback(
    async (key: string, name: string) => {
      if (!name.trim()) return;
      await orpalRef.current?.setContactDisplayName(key, name);
      await refreshContacts();
    },
    [refreshContacts],
  );

  const setRelayOnly = useCallback(
    async (key: string, value: boolean) => {
      await orpalRef.current?.setContactRelayOnly(key, value);
      await refreshContacts();
    },
    [refreshContacts],
  );

  // Persist a settings change immediately, without flagging a restart (block-list
  // changes apply live). Mirrors the seal-TURN-credentials handling in saveSettings.
  const persistSettings = useCallback(async (next: AppSettings) => {
    setSettings(next);
    const persisted = turnCredStoreRef.current
      ? { ...next, iceServers: stripTurnCredentials(next.iceServers) }
      : next;
    await window.orpal.settings.set(persisted);
  }, []);

  const acceptContactRequest = useCallback(
    async (key: string, name?: string) => {
      const orpal = orpalRef.current;
      if (!orpal) return { ok: false, reason: "not-ready" };
      const res = await orpal.acceptContactRequest(key, name);
      if (res.ok) {
        await refreshContacts();
        setContactRequests((prev) => prev.filter((r) => r.contactKey !== key));
      }
      return res.ok ? { ok: true } : { ok: false, reason: res.reason };
    },
    [refreshContacts],
  );

  const dismissContactRequest = useCallback((key: string) => {
    orpalRef.current?.dismissContactRequest(key);
    setContactRequests((prev) => prev.filter((r) => r.contactKey !== key));
  }, []);

  const blockContact = useCallback(
    async (key: string) => {
      const orpal = orpalRef.current;
      if (!orpal) return;
      const current = settings ?? EMPTY_SETTINGS;
      const blockedKeys = [...new Set([...current.blockedKeys, key])];
      orpal.setBlockedKeys(blockedKeys); // refuse + drop live connection now
      orpal.dismissContactRequest(key);
      await persistSettings({ ...current, blockedKeys });
      // Drop any open conversation and pending request for the blocked key.
      setContactRequests((prev) => prev.filter((r) => r.contactKey !== key));
      setMessagesByContact((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setSelected((sel) => (sel === key ? null : sel));
    },
    [settings, persistSettings],
  );

  const unblockContact = useCallback(
    async (key: string) => {
      const orpal = orpalRef.current;
      if (!orpal) return;
      const current = settings ?? EMPTY_SETTINGS;
      const blockedKeys = current.blockedKeys.filter((k) => k !== key);
      orpal.setBlockedKeys(blockedKeys);
      await persistSettings({ ...current, blockedKeys });
    },
    [settings, persistSettings],
  );

  const exportContacts = useCallback(async () => {
    const orpal = orpalRef.current;
    if (!orpal) return;
    const bundle = await orpal.exportContacts();
    const stamp = new Date().toISOString().slice(0, 10);
    await window.orpal.files.saveText(`orpal-contacts-${stamp}.json`, bundle);
  }, []);

  const importContacts = useCallback(
    async (onCollision: "skip" | "overwrite") => {
      const orpal = orpalRef.current;
      if (!orpal) return null;
      const text = await window.orpal.files.openText();
      if (text === null) return null; // user cancelled the picker
      const summary = await orpal.importContacts(text, { onCollision });
      await refreshContacts();
      return summary;
    },
    [refreshContacts],
  );

  const createTestContact = useCallback(async () => {
    await orpalRef.current?.ensureLoopbackContact();
    await refreshContacts();
  }, [refreshContacts]);

  const runSelfTest = useCallback(async () => {
    const orpal = orpalRef.current;
    if (!orpal) return { ok: false, boardReachable: false, cryptoRoundTrip: false, reason: "not-ready" };
    const result = await orpal.runLoopbackSelfTest();
    await refreshContacts(); // the self-test may have created the loopback contact
    return result;
  }, [refreshContacts]);

  const setContactBoards = useCallback(
    async (key: string, preferredBoards: string[]) => {
      await orpalRef.current?.setContactBoards(key, { preferredBoards });
      await refreshContacts();
      // Re-establish over the new routes if we're talking to them now.
      orpalRef.current?.connect(key).catch(() => {});
    },
    [refreshContacts],
  );

  const saveSettings = useCallback(async (s: AppSettings) => {
    // ORPAL-014: seal TURN credentials separately; localStorage gets only URLs.
    const store = turnCredStoreRef.current;
    if (store) await store.save(extractTurnCredentials(s.iceServers));
    const persisted: AppSettings = store
      ? { ...s, iceServers: stripTurnCredentials(s.iceServers) }
      : s;
    await window.orpal.settings.set(persisted);
    setSettings(s); // keep credentials merged in memory for continued editing
    setSettingsNeedRestart(true); // board/ICE changes apply on next launch
  }, []);

  // ORPAL-016: flip wake-on-push live. Enabling registers + advertises the token;
  // disabling clears the token and drops the subscription. The setting is
  // persisted only after the (un)registration succeeds, so a denied permission
  // leaves both the toggle and storage off. Applied immediately -- no restart.
  const setPushEnabled = useCallback(
    async (on: boolean) => {
      const orpal = orpalRef.current;
      if (!orpal) return;
      if (on) {
        const token = await enablePush(); // throws PushSetupError if blocked
        orpal.setPushToken(token);
      } else {
        orpal.setPushToken(undefined);
        await disablePush();
      }
      setPushEnabledState(on);
      const next: AppSettings = { ...(settings ?? EMPTY_SETTINGS), pushNotifications: on };
      setSettings(next);
      const persisted = turnCredStoreRef.current
        ? { ...next, iceServers: stripTurnCredentials(next.iceServers) }
        : next;
      await window.orpal.settings.set(persisted);
    },
    [settings],
  );

  const reveal = useCallback((path: string) => {
    void window.orpal.files.reveal(path);
  }, []);

  const startMigration = useCallback(async (retireAfterUtc: string) => {
    await orpalRef.current?.startMigration(retireAfterUtc);
    setMigrationProgress(orpalRef.current?.migrationProgress ?? null);
  }, []);

  const retireMigration = useCallback(async () => {
    await orpalRef.current?.retireMigration();
    setMigrationProgress(orpalRef.current?.migrationProgress ?? null);
  }, []);

  const acceptMigration = useCallback(async (contactKey: string) => {
    const result = await orpalRef.current?.acceptMigration(contactKey);
    setPendingIncomingMigrations([...(orpalRef.current?.pendingIncomingMigrations ?? [])]);
    await refreshContacts();
    return result ?? false;
  }, [refreshContacts]);

  const declineMigration = useCallback((contactKey: string) => {
    orpalRef.current?.declineMigration(contactKey);
    setPendingIncomingMigrations([...(orpalRef.current?.pendingIncomingMigrations ?? [])]);
  }, []);

  const setAutoAcceptMigration = useCallback(
    async (key: string, value: boolean) => {
      await orpalRef.current?.setAutoAcceptMigration(key, value);
      await refreshContacts();
    },
    [refreshContacts],
  );

  const gatherBackupPayload = useCallback(async (): Promise<BackupPayload> => {
    const orpal = orpalRef.current;
    if (!orpal) throw new Error("not ready");
    const contactList = await orpal.listContacts();
    const messages: Record<string, StoredMessage[]> = {};
    for (const c of contactList) {
      messages[c.identityKey] = await orpal.history(c.identityKey, { limit: 100_000 });
    }
    const keys = await window.orpal.keys.load();
    if (!keys) throw new Error("No identity keys found");
    const pending = await window.orpal.pending.list();
    const currentSettings = await window.orpal.settings.get();
    const migrationState = await kvGet("migrationState");
    return {
      identity: keys as any,
      contacts: contactList,
      messages,
      pending,
      settings: { ...currentSettings, blockedKeys: currentSettings.blockedKeys ?? [] },
      migrationState: migrationState as any ?? null,
    };
  }, []);

  const restoreBackupPayload = useCallback(async (payload: BackupPayload): Promise<void> => {
    await window.orpal.keys.save(payload.identity as any);
    const store = window.orpal.store;
    for (const contact of payload.contacts) {
      await store.upsertContact(contact);
    }
    for (const [, msgs] of Object.entries(payload.messages)) {
      for (const msg of msgs) {
        await store.appendMessage(msg);
      }
    }
    for (const msg of payload.pending ?? []) {
      await window.orpal.pending.enqueue(msg);
    }
    if (payload.settings) {
      await window.orpal.settings.set(payload.settings as any);
    }
    if (payload.migrationState) {
      await kvSet("migrationState", payload.migrationState);
    }
  }, []);

  const blockedKeys = settings?.blockedKeys ?? [];

  const conversations = useMemo<Conversation[]>(() => {
    const blocked = new Set(settings?.blockedKeys ?? []);
    const byKey = new Map<string, Conversation>();
    for (const c of contacts) {
      if (blocked.has(c.identityKey)) continue;
      byKey.set(c.identityKey, {
        key: c.identityKey,
        name: c.displayName,
        relayOnly: c.relayOnly,
        known: true,
        isLoopback: c.isLoopback ?? false,
      });
    }
    for (const key of Object.keys(messagesByContact)) {
      if (blocked.has(key)) continue;
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          name: `Unknown (${shortKey(key)})`,
          relayOnly: false,
          known: false,
          isLoopback: false,
        });
      }
    }
    // Loopback contact sorts to the bottom; otherwise alphabetical by name.
    return [...byKey.values()].sort((a, b) =>
      a.isLoopback !== b.isLoopback ? (a.isLoopback ? 1 : -1) : a.name.localeCompare(b.name),
    );
  }, [contacts, messagesByContact, settings?.blockedKeys]);

  const connectionOf = useCallback(
    (key: string): ContactState => connByContact[key] ?? "unknown",
    [connByContact],
  );

  const value: OrpalContextValue = {
    status,
    errorMsg,
    identityKey,
    ownCard,
    contacts,
    conversations,
    selected,
    messages: selected ? messagesByContact[selected] ?? [] : [],
    connectionOf,
    brokerState,
    pendingMetrics,
    keyProtection,
    settings: settings ?? EMPTY_SETTINGS,
    settingsNeedRestart,
    select,
    sendText,
    sendFile,
    retry,
    connect,
    addContact,
    removeContact,
    renameContact,
    setRelayOnly,
    contactRequests,
    acceptContactRequest,
    dismissContactRequest,
    blockedKeys,
    blockContact,
    unblockContact,
    exportContacts,
    importContacts,
    createTestContact,
    runSelfTest,
    setContactBoards,
    saveSettings,
    reveal,
    pushEnabled,
    pushSupported: pushIsSupported(),
    setPushEnabled,
    migrationProgress,
    pendingIncomingMigrations,
    startMigration,
    retireMigration,
    acceptMigration,
    declineMigration,
    setAutoAcceptMigration,
    gatherBackupPayload,
    restoreBackupPayload,
    unreadByContact,
    totalUnread: Object.values(unreadByContact).reduce((sum, n) => sum + n, 0),
  };

  return <OrpalContext.Provider value={value}>{children}</OrpalContext.Provider>;
}
