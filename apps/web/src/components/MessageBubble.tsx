import type { StoredMessage } from "@orpal/core";
import { useOrpal } from "../state/orpal-context.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function deliveryGlyph(state: StoredMessage["state"]): { glyph: string; cls: string; label: string } {
  switch (state) {
    case "queued":
      return { glyph: "🕓", cls: "queued", label: "Queued — waiting for the contact to come online" };
    case "sending":
      return { glyph: "•", cls: "sending", label: "Attempting delivery…" };
    case "delivered":
      return { glyph: "✓", cls: "delivered", label: "Delivered to their device (channel ACK)" };
    case "acknowledged":
      return { glyph: "✓✓", cls: "acknowledged", label: "Acknowledged — read by the app" };
    case "failed":
      return { glyph: "!", cls: "failed", label: "Failed" };
  }
}

export function MessageBubble({ m }: { m: StoredMessage }) {
  const { retry, reveal } = useOrpal();
  const out = m.direction === "out";
  const d = deliveryGlyph(m.state);

  return (
    <div className={`bubble-row ${out ? "out" : "in"}`}>
      <div className={`bubble ${out ? "out" : "in"}`}>
        {m.kind === "text" ? (
          <span className="bubble-text">{m.text}</span>
        ) : (
          <FileBody m={m} onReveal={reveal} formatBytes={formatBytes} />
        )}
        <div className="bubble-meta">
          <span className="time">{new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          {out && (
            <span className={`delivery ${d.cls}`} title={d.label}>
              {d.glyph}
            </span>
          )}
          {out && m.state === "failed" && (
            <button className="retry" onClick={() => retry(m.id)}>
              retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function FileBody({
  m,
  onReveal,
  formatBytes,
}: {
  m: StoredMessage;
  onReveal: (p: string) => void;
  formatBytes: (n: number) => string;
}) {
  const f = m.file!;
  const pct = f.size === 0 ? 100 : Math.min(100, Math.round((f.transferred / f.size) * 100));
  const stateLabel: Record<string, string> = {
    offered: "offered",
    transferring: `${pct}%`,
    complete: "complete · verified",
    failed: "failed",
    "integrity-failed": "integrity check failed",
  };
  return (
    <div className="file-body">
      <div className="file-top">
        <span className="file-icon">📎</span>
        <div className="file-info">
          <div className="file-name">{f.name}</div>
          <div className="file-sub muted">
            {formatBytes(f.size)} · {stateLabel[f.state] ?? f.state}
          </div>
        </div>
      </div>
      {f.state === "transferring" && (
        <div className="progress">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      {f.state === "complete" && m.direction === "in" && f.path && (
        <button className="reveal" onClick={() => onReveal(f.path!)}>
          Show in folder
        </button>
      )}
    </div>
  );
}
