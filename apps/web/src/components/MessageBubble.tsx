import { useEffect, useRef, useState } from "react";
import type { StoredMessage } from "@orpal/core";
import { useOrpal } from "../state/orpal-context.js";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isImageMime(mime: string): boolean {
  return typeof mime === "string" && mime.startsWith("image/");
}

/** ORPAL-019: "complete · verified · sha256 abcd1234…" -- the integrity line that
 *  rides under every preview/attachment so the verified status is never lost. */
function verifiedCaption(file: NonNullable<StoredMessage["file"]>): string {
  const sha = file.sha256 ? ` · sha256 ${file.sha256.slice(0, 8)}…` : "";
  return `${formatBytes(file.size)} · complete · verified${sha}`;
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
          <FileBody m={m} onReveal={reveal} />
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

function FileBody({ m, onReveal }: { m: StoredMessage; onReveal: (p: string) => void }) {
  const f = m.file!;
  // ORPAL-019: a completed, integrity-verified image renders as an inline preview;
  // it falls back to the plain attachment row if the bytes aren't available
  // (e.g. after a reload) or fail to decode. Everything else uses the row.
  if (f.state === "complete" && isImageMime(f.mime)) {
    return <ImagePreview m={m} onReveal={onReveal} />;
  }
  return <FileRow m={m} onReveal={onReveal} />;
}

/** The classic attachment row: 📎 · name · size/state, with progress + reveal. */
function FileRow({ m, onReveal }: { m: StoredMessage; onReveal: (p: string) => void }) {
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

/** ORPAL-019: an inline thumbnail rendered from the reassembled, SHA-256-verified
 *  bytes (an in-memory object URL — never written to disk). Clicking opens a
 *  full-size lightbox. Falls back to {@link FileRow} when no preview is available. */
function ImagePreview({ m, onReveal }: { m: StoredMessage; onReveal: (p: string) => void }) {
  const f = m.file!;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    window.orpal.files
      .imageObjectUrl(f.fileId)
      .then((u) => {
        if (!live) return;
        if (u) setUrl(u);
        else setFailed(true); // no retained bytes (e.g. after a reload) -> row
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [f.fileId]);

  if (failed) return <FileRow m={m} onReveal={onReveal} />;

  return (
    <div className="image-body">
      {url && (
        <button
          type="button"
          className="image-thumb"
          onClick={() => setOpen(true)}
          title="Click to view full size"
          aria-label={`Open image ${f.name} full size`}
        >
          <img src={url} alt={f.name} onError={() => setFailed(true)} />
        </button>
      )}
      <div className="image-caption muted" title={f.sha256 ? `sha256 ${f.sha256}` : undefined}>
        {verifiedCaption(f)}
      </div>
      {open && url && (
        <Lightbox
          url={url}
          name={f.name}
          caption={verifiedCaption(f)}
          direction={m.direction}
          path={f.path}
          onReveal={onReveal}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function Lightbox({
  url,
  name,
  caption,
  direction,
  path,
  onReveal,
  onClose,
}: {
  url: string;
  name: string;
  caption: string;
  direction: StoredMessage["direction"];
  path?: string;
  onReveal: (p: string) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={name}>
      <div className="lightbox" onClick={(e) => e.stopPropagation()}>
        <div className="lightbox-head">
          <span className="lightbox-name" title={name}>
            {name}
          </span>
          <button ref={closeRef} className="x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="lightbox-stage">
          <img src={url} alt={name} />
        </div>
        <div className="lightbox-foot">
          <span className="image-caption muted">{caption}</span>
          <span className="lightbox-actions">
            {/* The verified bytes are in memory; download them on demand rather
                than auto-writing to disk. */}
            <a className="lightbox-download" href={url} download={name}>
              Download
            </a>
            {direction === "in" && path && (
              <button className="ghost" onClick={() => onReveal(path)}>
                Show in folder
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
