import { useOrpal } from "../state/orpal-context.js";
import { shortKey } from "@orpal/core";
import orpLogo from "@/assets/orp-logo.svg";

const BROKER_LABEL: Record<string, string> = {
  connecting: "Connecting to board…",
  open: "Board connected",
  closed: "Board disconnected",
  error: "Board error",
};

export function Sidebar(props: {
  onShowIdentity: () => void;
  onAddContact: () => void;
  onSettings: () => void;
}) {
  const { conversations, selected, select, connectionOf, brokerState, identityKey } = useOrpal();

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
        <div className="tagline">it really whips the crab’s butt 🦀</div>
        <div className={`broker broker-${brokerState}`} title={identityKey}>
          <span className="dot" /> {BROKER_LABEL[brokerState] ?? brokerState}
        </div>
      </header>

      <div className="sidebar-actions">
        <button onClick={props.onShowIdentity}>My identity / QR</button>
        <button onClick={props.onAddContact}>Add contact</button>
        <button onClick={props.onSettings}>Settings</button>
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
