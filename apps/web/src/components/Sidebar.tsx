import { useOrpal } from "../state/orpal-context.js";
import { shortKey } from "@orpal/core";
import orpLogo from "@/assets/orp-logo.svg";

const BROKER_LABEL: Record<string, string> = {
  connecting: "Connecting to board…",
  open: "Board connected",
  closed: "Board disconnected",
  error: "Board error",
};

// ORPAL-015: how the device's private keys are protected at rest.
const KEY_PROTECTION_LABEL: Record<string, string> = {
  hardware: "Keys hardware-sealed",
  cleartext: "Keys not hardware-sealed",
};
const KEY_PROTECTION_TIP: Record<string, string> = {
  hardware:
    "Your private keys are sealed by this device's secure hardware (Secure Enclave / " +
    "Android Keystore / TPM). They never sit unencrypted at rest.",
  cleartext:
    "Your private keys are stored locally and origin-scoped, but NOT hardware-sealed " +
    "(no secure hardware, a dismissed biometric prompt, or unsupported WebAuthn PRF). " +
    "Use a device with biometric/secure-hardware auth for stronger protection.",
};

export function Sidebar(props: {
  onShowIdentity: () => void;
  onAddContact: () => void;
  onSettings: () => void;
  onMigration: () => void;
}) {
  const { conversations, selected, select, connectionOf, brokerState, identityKey, pendingMetrics, migrationProgress, keyProtection } =
    useOrpal();

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="brand-row">
          <div className="brand">Orpal</div>
          <div className="eq" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
        <div className="tagline">it really cracks the crab’s back 🦀</div>
        <div
          className={`broker broker-${brokerState}`}
          title={`${BROKER_LABEL[brokerState] ?? brokerState} · your identity: ${identityKey}`}
          role="status"
          aria-label={`Board signal: ${BROKER_LABEL[brokerState] ?? brokerState}`}
        >
          <span className="dot" aria-hidden="true" /> {BROKER_LABEL[brokerState] ?? brokerState}
        </div>
        <div
          className={`key-protection key-protection-${keyProtection}`}
          title={KEY_PROTECTION_TIP[keyProtection]}
          role="status"
          aria-label={KEY_PROTECTION_LABEL[keyProtection]}
        >
          <span className="key-protection-icon" aria-hidden="true">
            {keyProtection === "hardware" ? "🔒" : "⚠️"}
          </span>{" "}
          {KEY_PROTECTION_LABEL[keyProtection]}
        </div>
        {pendingMetrics.total > 0 && (
          <div
            className="queue-status"
            title={
              `${pendingMetrics.total} message(s) waiting for an acknowledgement` +
              `\noldest queued: ${formatAge(pendingMetrics.oldestPendingTs)}` +
              `\nlast attempt: ${formatAge(pendingMetrics.lastAttemptAt)}` +
              `\ndelivery attempts: ${pendingMetrics.totalAttempts}`
            }
          >
            <span className="queue-dot" />
            {pendingMetrics.total} queued · oldest {formatAge(pendingMetrics.oldestPendingTs)}
          </div>
        )}
      </header>

      <div className="sidebar-actions">
        <button onClick={props.onShowIdentity}>My identity / QR</button>
        <button onClick={props.onAddContact}>Add contact</button>
        <button onClick={props.onSettings}>Settings</button>
        <button onClick={props.onMigration}>
          {migrationProgress ? "Migration in progress…" : "Rotate identity"}
        </button>
      </div>

      <div className="convo-list">
        {conversations.length === 0 && (
          <div className="muted convo-empty">
            No contacts yet. Add one with their QR or pasted card.
          </div>
        )}
        {conversations.map((c) => {
          const state = connectionOf(c.key);
          return (
            <button
              key={c.key}
              className={`convo ${selected === c.key ? "active" : ""}`}
              onClick={() => select(c.key)}
            >
              <div className="convo-row">
                <span className="convo-name">{c.name}</span>
                {c.relayOnly && <span className="badge relay" title="Relay-only (TURN)">relay</span>}
              </div>
              <div className="convo-sub">
                <span className={`presence presence-${state}`}>{presenceLabel(state)}</span>
                <span className="convo-key">{shortKey(c.key)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <footer className="sidebar-foot" title="Built on the Open Relay Protocol">
        <img className="info-logo" src={orpLogo} alt="" aria-hidden="true" />
        <span className="info-caption">Open Relay Protocol</span>
      </footer>
    </aside>
  );
}

/** A compact "Xs / Xm / Xh ago" for a queue timestamp (null -> em dash). */
function formatAge(ts: number | null): string {
  if (ts === null) return "—";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function presenceLabel(state: string): string {
  switch (state) {
    case "connected":
      return "online";
    case "connecting":
      return "connecting…";
    case "down":
      return "offline";
    default:
      return "—";
  }
}
