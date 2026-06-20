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
  type Contact,
  type ContactState,
  type MigrationProgress,
  type OrpalClient,
  type PendingMigration,
  type PendingMetrics,
  type StoredMessage,
} from "@orpal/core";
import type { AppSettings } from "@shared/ipc";
import { createOrpalApp, type KeyProtection } from "../orpal/setup.js";
import { makeFileSource } from "../orpal/bridge-stores.js";
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
  setRelayOnly: (key: string, value: boolean) => Promise<void>;
  /** Per-contact board routes (issue #19); empty list restores all-boards default. */
  setContactBoards: (key: string, preferredBoards: string[]) => Promise<void>;
  saveSettings: (s: AppSettings) => Promise<void>;
  reveal: (path: string) => void;

  migrationProgress: MigrationProgress | null;
  pendingIncomingMigrations: readonly PendingMigration[];
  startMigration: (retireAfterUtc: string) => Promise<void>;
  retireMigration: () => Promise<void>;
  acceptMigration: (contactKey: string) => Promise<boolean>;
  declineMigration: (contactKey: string) => void;
  setAutoAcceptMigration: (key: string, value: boolean) => Promise<void>;
}

const EMPTY_METRICS: PendingMetrics = {
  total: 0,
  oldestPendingTs: null,
  lastAttemptAt: null,
  totalAttempts: 0,
  maxAttempts: 0,
  byRecipient: {},
};

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
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(null);
  const [pendingIncomingMigrations, setPendingIncomingMigrations] = useState<readonly PendingMigration[]>([]);

  const upsertMessage = useCallback((m: StoredMessage) => {
    setMessagesByContact((prev) => {
      const list = prev[m.contactKey] ?? [];
      const idx = list.findIndex((x) => x.id === m.id);
      const next = idx === -1 ? [...list, m] : list.map((x) => (x.id === m.id ? m : x));
      next.sort((a, b) => a.ts - b.ts);
      return { ...prev, [m.contactKey]: next };
    });
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
      const orpal = orpalRef.current;
      if (!key || !orpal) return;
      // Load history lazily, then best-effort connect to learn reachability.
      void (async () => {
        const hist = await orpal.history(key, { limit: 500 });
        setMessagesByContact((prev) => ({ ...prev, [key]: [...hist].reverse() }));
        orpal.connect(key).catch(() => {
          /* offline — surfaced via the connection event */
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

  const setRelayOnly = useCallback(
    async (key: string, value: boolean) => {
      await orpalRef.current?.setContactRelayOnly(key, value);
      await refreshContacts();
    },
    [refreshContacts],
  );

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

  const conversations = useMemo<Conversation[]>(() => {
    const byKey = new Map<string, Conversation>();
    for (const c of contacts) {
      byKey.set(c.identityKey, {
        key: c.identityKey,
        name: c.displayName,
        relayOnly: c.relayOnly,
        known: true,
      });
    }
    for (const key of Object.keys(messagesByContact)) {
      if (!byKey.has(key)) {
        byKey.set(key, { key, name: `Unknown (${shortKey(key)})`, relayOnly: false, known: false });
      }
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [contacts, messagesByContact]);

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
    settings: settings ?? { boards: [], iceServers: [], relayOnlyByDefault: false },
    settingsNeedRestart,
    select,
    sendText,
    sendFile,
    retry,
    connect,
    addContact,
    removeContact,
    setRelayOnly,
    setContactBoards,
    saveSettings,
    reveal,
    migrationProgress,
    pendingIncomingMigrations,
    startMigration,
    retireMigration,
    acceptMigration,
    declineMigration,
    setAutoAcceptMigration,
  };

  return <OrpalContext.Provider value={value}>{children}</OrpalContext.Provider>;
}
