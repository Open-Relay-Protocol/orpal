import { useEffect, useRef, useState } from "react";
import { shortKey } from "@orpal/core";
import { useOrpal } from "../state/orpal-context.js";
import { MessageBubble } from "./MessageBubble.js";
import { CrabMascot } from "./CrabMascot.js";
import { PortalEasterEgg, EASTER_EGG_PHRASE } from "./PortalEasterEgg.js";

export function Conversation() {
  const {
    selected,
    conversations,
    contacts,
    messages,
    connectionOf,
    sendText,
    sendFile,
    connect,
    setRelayOnly,
    setContactBoards,
    setAutoAcceptMigration,
    settings,
    select,
    brokerState,
  } = useOrpal();
  const [draft, setDraft] = useState("");
  const [schwifty, setSchwifty] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selected]);

  if (!selected) {
    return (
      <main className="conversation empty">
        <div className="center muted">
          <CrabMascot
            className="empty-mascot"
            status={brokerState === "open" ? "secure" : brokerState === "connecting" ? "connecting" : "down"}
          />
          <p>Select a contact to start messaging.</p>
          <p className="hint">
            Messages and files travel peer-to-peer over WebRTC. The board only helps you find each
            other — it can’t read anything, and it stores nothing.
          </p>
        </div>
      </main>
    );
  }

  const convo = conversations.find((c) => c.key === selected);
  const contact = contacts.find((c) => c.identityKey === selected);
  const state = connectionOf(selected);
  const boards = settings.boards;
  const preferred = contact?.preferredBoards ?? [];

  const onSend = () => {
    if (!draft.trim()) return;
    // Easter egg: never sent to the peer, just opens the portal.
    if (draft.trim().toLowerCase() === EASTER_EGG_PHRASE) {
      setSchwifty(true);
      setDraft("");
      return;
    }
    sendText(draft);
    setDraft("");
  };

  const toggleBoard = (url: string, on: boolean) => {
    if (!selected) return;
    const next = on ? [...new Set([...preferred, url])] : preferred.filter((b) => b !== url);
    void setContactBoards(selected, next);
  };

  return (
    <main className="conversation">
      {schwifty && <PortalEasterEgg onClose={() => setSchwifty(false)} />}
      <header className="convo-header">
        <div className="convo-title">
          <button
            className="ghost convo-back"
            title="Back to contacts"
            aria-label="Back to contacts"
            onClick={() => select(null)}
          >
            ‹
          </button>
          <span className="convo-h-name marquee">
            <span>
              {convo?.name ?? shortKey(selected)} · {presenceText(state)} ···
            </span>
          </span>
        </div>
        <div className="convo-header-actions">
          {convo?.known && (
            <label
              className="relay-toggle"
              title="Relay-only: route this contact through a TURN server so they never learn your IP address (SPEC §6). Requires a configured TURN server in Settings."
            >
              <input
                type="checkbox"
                checked={convo.relayOnly}
                aria-label="Relay-only mode for this contact (route via TURN, hide your IP)"
                onChange={(e) => void setRelayOnly(selected, e.target.checked)}
              />
              relay-only
            </label>
          )}
          {convo?.known && (
            <details className="board-routes">
              <summary title="Per-contact settings: board routing, auto-accept key rotations">
                settings{preferred.length ? ` · ${preferred.length} boards` : ""}
              </summary>
              <div className="board-routes-menu">
                {boards.length > 1 && (
                  <>
                    <div className="board-routes-hint muted">
                      {preferred.length === 0
                        ? "Using all boards. Pick specific boards to route only over them."
                        : "Only the checked boards are used to reach this contact."}
                    </div>
                    {boards.map((url) => (
                      <label key={url} className="board-route">
                        <input
                          type="checkbox"
                          checked={preferred.includes(url)}
                          onChange={(e) => toggleBoard(url, e.target.checked)}
                        />
                        <span className="board-route-url">{url}</span>
                      </label>
                    ))}
                  </>
                )}
                <div className="board-routes-hint muted" style={{ marginTop: boards.length > 1 ? "8px" : undefined }}>
                  Key rotation
                </div>
                <label className="board-route">
                  <input
                    type="checkbox"
                    checked={contact?.autoAcceptMigration ?? false}
                    onChange={(e) => void setAutoAcceptMigration(selected, e.target.checked)}
                  />
                  <span className="board-route-url">Auto-accept key rotations</span>
                </label>
              </div>
            </details>
          )}
          {state !== "connected" && (
            <button className="ghost" onClick={() => connect(selected)}>
              Connect
            </button>
          )}
        </div>
      </header>

      {state === "down" && (
        <div className="offline-banner">
          This contact appears offline. The board has no store-and-forward, but your messages are
          saved locally and delivered automatically the moment they come back online.
        </div>
      )}

      <div className="messages">
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>

      <footer className="composer">
        <button
          className="attach"
          title="Send a file"
          aria-label="Send a file"
          onClick={() => void sendFile()}
        >
          📎
        </button>
        <textarea
          value={draft}
          placeholder="Type a message…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          rows={1}
        />
        <button className="send" onClick={onSend} disabled={!draft.trim()}>
          Send
        </button>
      </footer>
    </main>
  );
}

function presenceText(state: string): string {
  switch (state) {
    case "connected":
      return "online · connected";
    case "connecting":
      return "connecting…";
    case "down":
      return "offline";
    default:
      return "tap Connect to reach them";
  }
}
