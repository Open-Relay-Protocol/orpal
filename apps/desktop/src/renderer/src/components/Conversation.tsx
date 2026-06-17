import { useEffect, useRef, useState } from "react";
import { shortKey } from "@orpal/core";
import { useOrpal } from "../state/orpal-context.js";
import { MessageBubble } from "./MessageBubble.js";

export function Conversation() {
  const {
    selected,
    conversations,
    messages,
    connectionOf,
    sendText,
    sendFile,
    connect,
    setRelayOnly,
  } = useOrpal();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, selected]);

  if (!selected) {
    return (
      <main className="conversation empty">
        <div className="center muted">
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
  const state = connectionOf(selected);

  const onSend = () => {
    if (!draft.trim()) return;
    sendText(draft);
    setDraft("");
  };

  return (
    <main className="conversation">
      <header className="convo-header">
        <div className="convo-title">
          <span className="convo-h-name">{convo?.name ?? shortKey(selected)}</span>
          <span className={`presence presence-${state}`}>{presenceText(state)}</span>
        </div>
        <div className="convo-header-actions">
          {convo?.known && (
            <label className="relay-toggle" title="Route via TURN so the peer never learns your IP (SPEC §6)">
              <input
                type="checkbox"
                checked={convo.relayOnly}
                onChange={(e) => void setRelayOnly(selected, e.target.checked)}
              />
              relay-only
            </label>
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
          This contact appears offline. Orpal has no store-and-forward, so messages can’t be
          delivered until they’re online — they’ll be marked failed and you can retry.
        </div>
      )}

      <div className="messages">
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={endRef} />
      </div>

      <footer className="composer">
        <button className="attach" title="Send a file" onClick={() => void sendFile()}>
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
