import { useState } from "react";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";
import type { IceServer } from "@shared/ipc";
import type { ImportSummary, LoopbackSelfTestResult } from "@orpal/core";
import {
  configHasTurn,
  formToIceServers,
  iceServersToForm,
  isSimpleConfig,
  parseIceJson,
  testIceServers,
  validateForm,
  type IceForm,
  type IceTestResult,
} from "../orpal/ice-config.js";
import { BackupSection } from "./BackupSection.js";
import { SKINS, type SkinId } from "../orpal/skins.js";

type TestState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: IceTestResult; hadTurn: boolean }
  | { phase: "error"; message: string };

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const {
    settings,
    saveSettings,
    settingsNeedRestart,
    pushEnabled,
    pushSupported,
    setPushEnabled,
    contacts,
    exportContacts,
    importContacts,
    createTestContact,
    runSelfTest,
    blockedKeys,
    unblockContact,
    skin,
    setSkin,
  } = useOrpal();
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const togglePush = async (on: boolean) => {
    setPushError(null);
    setPushBusy(true);
    try {
      await setPushEnabled(on);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushBusy(false);
    }
  };
  const [boards, setBoards] = useState<string[]>(
    settings.boards.length ? [...settings.boards] : [""],
  );

  // ICE config has two editors kept in sync: a friendly form (default) and a raw
  // JSON escape hatch (Advanced). Both serialize down to the same IceServer[].
  // If the existing config can't be represented in the simple form without loss
  // (URL arrays, multiple STUN entries, unusual RTCIceServer fields), open in the
  // JSON editor so the original config stays the source of truth and is never
  // silently overwritten by the lossy form projection.
  const [form, setForm] = useState<IceForm>(() => iceServersToForm(settings.iceServers));
  const [advanced, setAdvanced] = useState(() => !isSimpleConfig(settings.iceServers));
  const [iceJson, setIceJson] = useState(() => JSON.stringify(settings.iceServers, null, 2));

  const [relayDefault, setRelayDefault] = useState(settings.relayOnlyByDefault);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<TestState>({ phase: "idle" });

  const setBoard = (i: number, v: string) =>
    setBoards((b) => b.map((x, idx) => (idx === i ? v : x)));
  const addBoard = () => setBoards((b) => [...b, ""]);
  const removeBoard = (i: number) => setBoards((b) => b.filter((_, idx) => idx !== i));

  const setStun = (stunUrl: string) => setForm((f) => ({ ...f, stunUrl }));
  const addTurn = () =>
    setForm((f) => ({ ...f, turns: [...f.turns, { url: "", username: "", credential: "" }] }));
  const removeTurn = (i: number) =>
    setForm((f) => ({ ...f, turns: f.turns.filter((_, idx) => idx !== i) }));
  const setTurn = (i: number, patch: Partial<IceForm["turns"][number]>) =>
    setForm((f) => ({
      ...f,
      turns: f.turns.map((t, idx) => (idx === i ? { ...t, ...patch } : t)),
    }));

  // Live validation for the form editor (shown inline, not on save only).
  const formErrors = advanced ? [] : validateForm(form);

  /** Resolve the current editor down to an IceServer[], or an error string. */
  const resolveIceServers = (): { servers: IceServer[] } | { err: string } => {
    if (advanced) {
      const parsed = parseIceJson(iceJson);
      return parsed.ok ? { servers: parsed.servers } : { err: parsed.error };
    }
    const errs = validateForm(form);
    if (errs.length) return { err: errs[0] };
    return { servers: formToIceServers(form) };
  };

  // Switching editors carries the config across so neither view goes stale.
  const openAdvanced = () => {
    if (!advanced) setIceJson(JSON.stringify(formToIceServers(form), null, 2));
    setAdvanced(true);
  };
  const closeAdvanced = () => {
    const parsed = parseIceJson(iceJson);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!isSimpleConfig(parsed.servers)) {
      setError(
        "This JSON has servers the simple form can’t represent (URL arrays, multiple STUN " +
          "entries, or unusual schemes). Keep editing here, or simplify it first.",
      );
      return;
    }
    setForm(iceServersToForm(parsed.servers));
    setError(null);
    setAdvanced(false);
  };

  const runTest = async () => {
    const resolved = resolveIceServers();
    if ("err" in resolved) {
      setError(resolved.err);
      return;
    }
    setError(null);
    setTest({ phase: "running" });
    try {
      const result = await testIceServers(resolved.servers);
      setTest({ phase: "done", result, hadTurn: configHasTurn(resolved.servers) });
    } catch (err) {
      setTest({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const save = async () => {
    const cleaned = boards.map((b) => b.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      setError("Add at least one board URL (ws:// or wss://).");
      return;
    }
    const resolved = resolveIceServers();
    if ("err" in resolved) {
      setError(resolved.err);
      return;
    }
    setError(null);
    await saveSettings({
      boards: cleaned,
      iceServers: resolved.servers,
      relayOnlyByDefault: relayDefault,
      // Push is toggled live above; preserve whatever it's currently set to.
      pushNotifications: settings.pushNotifications,
      // Block list is managed live (request prompt / Unblock); preserve it here.
      blockedKeys: settings.blockedKeys,
    });
    setSaved(true);
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <SkinsSection active={skin} onPick={setSkin} />

      <label className="field-label">Boards (ws:// or wss://) — federated</label>
      {boards.map((url, i) => (
        <div className="board-row" key={i}>
          <input
            value={url}
            onChange={(e) => setBoard(i, e.target.value)}
            placeholder="wss://board.example.com/"
          />
          <button
            className="ghost board-remove"
            onClick={() => removeBoard(i)}
            disabled={boards.length === 1}
            title="Remove board"
            aria-label="Remove board"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="ghost add-board" onClick={addBoard}>
        + Add board
      </button>
      <p className="muted">
        Your device announces presence on every board and reaches a contact via whichever board
        you’re both on. The first board to make a working connection wins.
      </p>

      <div className="ice-head">
        <label className="field-label">Connection helpers (STUN / TURN)</label>
        <button
          className="ghost ice-advanced-toggle"
          onClick={() => (advanced ? closeAdvanced() : openAdvanced())}
          aria-pressed={advanced}
        >
          {advanced ? "← Back to form" : "Advanced (edit JSON)"}
        </button>
      </div>

      <details className="ice-why">
        <summary>Why do I need this?</summary>
        <p className="muted">
          Orpal connects your two devices <strong>directly</strong>, but most devices sit behind a
          home/office router (NAT) that hides their address. A <strong>STUN</strong> server is a
          quick “what’s my public address?” lookup that lets two such devices find each other — it
          never sees your messages. When a network is too strict for even that (symmetric NAT, or a
          contact you’ve set to <strong>relay-only</strong> so they never learn your IP), a{" "}
          <strong>TURN</strong> server relays the encrypted traffic for you and therefore needs a
          username and credential. Your messages and files stay end-to-end encrypted in every case.
        </p>
      </details>

      {advanced ? (
        <>
          <textarea
            className="card-input mono"
            rows={7}
            value={iceJson}
            onChange={(e) => setIceJson(e.target.value)}
            aria-label="ICE servers JSON"
          />
          <p className="muted">
            Raw <code>RTCIceServer[]</code>. Each entry needs a <code>urls</code> field; TURN entries
            also need <code>username</code> and <code>credential</code>.
            {!isSimpleConfig(settings.iceServers) && (
              <>
                {" "}
                Your current config uses options the simple form can’t show (e.g. URL arrays or
                multiple STUN entries), so it opened here to avoid dropping them.
              </>
            )}
          </p>
        </>
      ) : (
        <>
          <label className="ice-sub-label">STUN server</label>
          <input
            value={form.stunUrl}
            onChange={(e) => setStun(e.target.value)}
            placeholder="stun:stun.l.google.com:19302"
            aria-label="STUN server URL"
          />

          <label className="ice-sub-label">TURN servers (for relay-only / strict NATs)</label>
          {form.turns.length === 0 && (
            <p className="muted ice-turn-empty">
              No TURN server yet. Add one if a contact is unreachable over STUN alone, or to use
              relay-only mode.
            </p>
          )}
          {form.turns.map((t, i) => (
            <div className="turn-card" key={i}>
              <div className="turn-card-head">
                <span className="muted">TURN server{form.turns.length > 1 ? ` #${i + 1}` : ""}</span>
                <button
                  className="ghost board-remove"
                  onClick={() => removeTurn(i)}
                  title="Remove TURN server"
                  aria-label="Remove TURN server"
                >
                  ✕
                </button>
              </div>
              <input
                value={t.url}
                onChange={(e) => setTurn(i, { url: e.target.value })}
                placeholder="turn:turn.example.com:3478"
                aria-label="TURN server URL"
              />
              <input
                value={t.username}
                onChange={(e) => setTurn(i, { username: e.target.value })}
                placeholder="Username"
                aria-label="TURN username"
              />
              <input
                value={t.credential}
                onChange={(e) => setTurn(i, { credential: e.target.value })}
                placeholder="Credential"
                type="password"
                aria-label="TURN credential"
              />
            </div>
          ))}
          <button className="ghost add-board" onClick={addTurn}>
            + Add TURN server
          </button>
        </>
      )}

      {formErrors.length > 0 && (
        <ul className="error-text ice-errors">
          {formErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}

      <div className="ice-test-row">
        <button className="ghost" onClick={runTest} disabled={test.phase === "running"}>
          {test.phase === "running" ? "Testing…" : "Test connection"}
        </button>
        <TestReport test={test} />
      </div>

      <label className="checkbox-row">
        <input type="checkbox" checked={relayDefault} onChange={(e) => setRelayDefault(e.target.checked)} />
        Relay-only by default for new contacts
      </label>

      <label className="field-label">Push notifications</label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={pushEnabled}
          disabled={!pushSupported || pushBusy}
          onChange={(e) => void togglePush(e.target.checked)}
        />
        Enable push notifications {pushBusy && <span className="muted">— working…</span>}
      </label>
      <p className="muted">
        When enabled, the relay board and your device’s platform provider (Apple/Google) learn that
        this device uses Orpal and when someone tries to reach you. Your messages and keys are{" "}
        <strong>never</strong> included in the notification — the board just wakes your device so it
        can reconnect and pick up the waiting message. When disabled, you can only receive messages
        while the app is open.
      </p>
      {!pushSupported && (
        <p className="muted">Push isn’t supported on this device/browser.</p>
      )}
      {pushError && <div className="error-text">{pushError}</div>}

      <ContactsSection
        hasLoopback={contacts.some((c) => c.isLoopback)}
        onExport={exportContacts}
        onImport={importContacts}
        onCreateTest={createTestContact}
        onSelfTest={runSelfTest}
      />

      <BlockedSection
        blockedKeys={blockedKeys}
        contacts={contacts}
        onUnblock={unblockContact}
      />

      <BackupSection />

      {error && <div className="error-text">{error}</div>}
      {(saved || settingsNeedRestart) && (
        <div className="info-text">Saved. Restart Orpal to apply board / ICE changes.</div>
      )}

      <div className="modal-actions">
        <button onClick={save}>Save</button>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

// Human-readable reasons for a rejected import entry (issue #41), mirroring the
// single-card add flow's binding-validation messages.
const IMPORT_REASONS: Record<string, string> = {
  "not-valid-json": "not valid JSON",
  "not-an-orpal-contact-card": "not an Orpal contact",
  "missing-fields": "missing required fields",
  "bad-binding-signature": "invalid key-binding signature",
  "binding-identity-mismatch": "binding doesn’t match the identity key",
  "binding-transport-mismatch": "binding doesn’t match the transport key",
  "that-is-your-own-card": "your own identity",
};

function ContactsSection(props: {
  hasLoopback: boolean;
  onExport: () => Promise<void>;
  onImport: (onCollision: "skip" | "overwrite") => Promise<ImportSummary | null>;
  onCreateTest: () => Promise<void>;
  onSelfTest: () => Promise<LoopbackSelfTestResult>;
}) {
  const [collision, setCollision] = useState<"skip" | "overwrite">("skip");
  const [busy, setBusy] = useState<null | "export" | "import" | "test" | "selftest">(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [selfTest, setSelfTest] = useState<LoopbackSelfTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (kind: "export" | "import" | "test" | "selftest", fn: () => Promise<void>) => {
    setError(null);
    setBusy(kind);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const doExport = () =>
    run("export", async () => {
      // Writing a file to disk is an explicit, confirmed action (issue #41).
      if (!window.confirm("Export your contacts to a file? It contains no private keys or messages, but anyone with the file can see who you know.")) {
        return;
      }
      await props.onExport();
    });

  const doImport = () =>
    run("import", async () => {
      setSummary(null);
      const result = await props.onImport(collision);
      if (result) setSummary(result);
    });

  const doSelfTest = () =>
    run("selftest", async () => {
      setSelfTest(null);
      setSelfTest(await props.onSelfTest());
    });

  return (
    <>
      <label className="field-label">Contacts backup &amp; test</label>
      <p className="muted">
        Export your contacts to a file to back them up or move them to another device, then import
        the file there. Bindings are re-verified on import; private keys and message history are
        never exported.
      </p>

      <div className="board-row">
        <button className="ghost" onClick={doExport} disabled={busy !== null}>
          {busy === "export" ? "Exporting…" : "Export contacts"}
        </button>
        <button className="ghost" onClick={doImport} disabled={busy !== null}>
          {busy === "import" ? "Importing…" : "Import contacts"}
        </button>
      </div>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={collision === "overwrite"}
          onChange={(e) => setCollision(e.target.checked ? "overwrite" : "skip")}
        />
        On import, overwrite contacts I already have (default: keep mine)
      </label>

      {summary && (
        <div className="info-text" role="status">
          Imported {summary.imported}, skipped {summary.skipped}, rejected {summary.rejected.length}.
          {summary.rejected.length > 0 && (
            <ul className="ice-errors">
              {summary.rejected.map((r, i) => (
                <li key={i}>
                  {r.identityKey === "(bundle)" ? "File" : r.identityKey.slice(0, 10) + "…"}:{" "}
                  {IMPORT_REASONS[r.reason] ?? r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <label className="field-label">Test contact (self-check)</label>
      <p className="muted">
        A diagnostic “Test (me)” contact lets you verify your board connection and encryption keys
        without a second person. The self-test checks the board is reachable and that messages seal
        and open with your own keys.
      </p>
      <div className="board-row">
        <button
          className="ghost"
          onClick={() => run("test", props.onCreateTest)}
          disabled={busy !== null || props.hasLoopback}
        >
          {props.hasLoopback ? "Test contact exists" : busy === "test" ? "Creating…" : "Create test contact"}
        </button>
        <button className="ghost" onClick={doSelfTest} disabled={busy !== null}>
          {busy === "selftest" ? "Testing…" : "Run self-test"}
        </button>
      </div>

      {selfTest && (
        <div className="info-text" role="status">
          <span className={selfTest.boardReachable ? "ok" : "warn"}>
            {selfTest.boardReachable ? "✓ Board reachable" : "✗ Board not reachable"}
          </span>{" "}
          <span className={selfTest.cryptoRoundTrip ? "ok" : "warn"}>
            {selfTest.cryptoRoundTrip ? "✓ Encryption keys OK" : "✗ Encryption check failed"}
          </span>
          {!selfTest.ok && selfTest.reason && <span className="muted"> — {selfTest.reason}</span>}
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
    </>
  );
}

function BlockedSection({
  blockedKeys,
  contacts,
  onUnblock,
}: {
  blockedKeys: string[];
  contacts: { identityKey: string; displayName: string }[];
  onUnblock: (key: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const shortKey = (k: string) => (k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`);
  const nameFor = (k: string) => contacts.find((c) => c.identityKey === k)?.displayName;

  const unblock = async (key: string) => {
    setBusy(key);
    try {
      await onUnblock(key);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <label className="field-label">Blocked senders</label>
      {blockedKeys.length === 0 ? (
        <p className="muted">
          Nobody is blocked. When an unknown sender messages you, you can block them from the
          request prompt; blocked senders are refused at the protocol level and hidden.
        </p>
      ) : (
        <>
          <p className="muted">
            These identities are refused at the protocol level — no messages, files, or requests get
            through, and their conversations are hidden. Unblock to allow them again.
          </p>
          {blockedKeys.map((key) => (
            <div className="board-row" key={key}>
              <code className="key-block" style={{ flex: 1, margin: 0 }}>
                {nameFor(key) ? `${nameFor(key)} · ` : ""}
                {shortKey(key)}
              </code>
              <button
                className="ghost"
                onClick={() => void unblock(key)}
                disabled={busy === key}
              >
                {busy === key ? "Unblocking…" : "Unblock"}
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ORPAL-019: the "SKINS" picker. Every option is a faithful Winamp/retro variant
// (just a swapped CSS token set); choosing one applies + persists it immediately.
function SkinsSection({ active, onPick }: { active: SkinId; onPick: (id: SkinId) => void }) {
  return (
    <>
      <label className="field-label">Skins</label>
      <p className="muted">
        Make Orpal yours. Each skin keeps the Winamp look — beveled chrome, an LCD readout — with a
        different palette. Your pick is saved on this device and survives restarts.
      </p>
      <div className="skins-grid">
        {SKINS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`skin-chip ${active === s.id ? "active" : ""}`}
            onClick={() => onPick(s.id)}
            aria-pressed={active === s.id}
            title={s.blurb}
          >
            <span className="skin-swatch" style={{ background: s.swatch.bg }} aria-hidden="true">
              <span className="skin-swatch-chrome" style={{ background: s.swatch.chrome }} />
              <span className="skin-swatch-accent" style={{ background: s.swatch.accent }} />
            </span>
            <span className="skin-meta">
              <span className="skin-name">{s.name}</span>
              <span className="skin-blurb muted">{s.blurb}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

function TestReport({ test }: { test: TestState }) {
  if (test.phase === "idle" || test.phase === "running") return null;
  if (test.phase === "error") {
    return <span className="ice-test-result error-text">Test failed: {test.message}</span>;
  }
  const { result, hadTurn } = test;
  return (
    <span className="ice-test-result" role="status">
      <span className={result.srflx ? "ok" : "warn"}>
        {result.srflx ? "✓ STUN reachable (server-reflexive candidate)" : "✗ No STUN candidate"}
      </span>
      {hadTurn && (
        <span className={result.relay ? "ok" : "warn"}>
          {result.relay ? "✓ TURN relay candidate obtained" : "✗ No TURN relay candidate"}
        </span>
      )}
      {!result.srflx && !result.relay && (
        <span className="muted">
          Got {result.candidateCount} candidate(s){result.host ? ", local only" : ""}. Check the URL,
          port, and (for TURN) the credentials.
        </span>
      )}
      {result.errors.length > 0 && <span className="muted">{result.errors.join(" · ")}</span>}
    </span>
  );
}
