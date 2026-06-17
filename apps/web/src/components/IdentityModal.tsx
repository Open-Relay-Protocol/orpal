import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";

export function IdentityModal({ onClose }: { onClose: () => void }) {
  const { ownCard, identityKey } = useOrpal();
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    QRCode.toDataURL(ownCard, { width: 280, margin: 1, color: { dark: "#0b0d12", light: "#ffffff" } })
      .then(setDataUrl)
      .catch(() => setDataUrl(""));
  }, [ownCard]);

  // Copy through the bridge so the UI stays shell-agnostic; the browser shell
  // backs window.orpal.clipboard with navigator.clipboard.
  const copy = async () => {
    try {
      await window.orpal.clipboard.writeText(ownCard);
      setCopyFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Last clipboard-based fallback: reveal a selectable field so the user can
      // copy by hand. If even that won't do, there's the auto-type button below.
      setCopyFailed(true);
      setTimeout(() => fallbackRef.current?.select(), 0);
    }
  };

  // Last resort when both QR and the clipboard fail: synthesize keystrokes into
  // the focused field. The countdown lets the user click into the destination
  // (e.g. a paste box on this device, or a remote session to the other device)
  // before typing starts.
  const typeOut = async () => {
    if (countdown !== null) return;
    for (let n = 3; n > 0; n--) {
      setCountdown(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCountdown(0); // typing now
    try {
      await window.orpal.input.autoType(ownCard);
    } catch {
      /* nothing more we can do; the manual field is still available */
    } finally {
      setCountdown(null);
    }
  };

  const typing = countdown !== null;

  return (
    <Modal title="My identity" onClose={onClose}>
      <p className="muted">
        Share this with a contact in person. They scan or paste it to add you. It contains your
        public identity key and transport key with a signed binding — never any private key.
      </p>
      <div className="qr-wrap">{dataUrl ? <img src={dataUrl} alt="identity QR" /> : <span className="muted">Generating…</span>}</div>
      <label className="field-label">Identity key</label>
      <code className="key-block">{identityKey}</code>

      {copyFailed && (
        <>
          <label className="field-label">Contact card (copy manually)</label>
          <textarea
            ref={fallbackRef}
            className="card-input"
            readOnly
            value={ownCard}
            rows={4}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="error-text">
            Couldn’t reach the clipboard. Select the text above to copy it, or use “Type it out”.
          </div>
        </>
      )}

      {typing && (
        <div className="muted">
          {countdown && countdown > 0
            ? `Focus the destination field… typing in ${countdown}`
            : "Typing the contact card…"}
        </div>
      )}

      <div className="modal-actions">
        <button onClick={copy} disabled={typing}>
          {copied ? "Copied!" : "Copy contact card"}
        </button>
        <button className="ghost" onClick={typeOut} disabled={typing} title="Last resort if QR and copy both fail: type the card into the focused field">
          Type it out
        </button>
        <button className="ghost" onClick={onClose} disabled={typing}>
          Close
        </button>
      </div>
    </Modal>
  );
}
