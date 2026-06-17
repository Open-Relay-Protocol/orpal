import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";

export function IdentityModal({ onClose }: { onClose: () => void }) {
  const { ownCard, identityKey } = useOrpal();
  const [dataUrl, setDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    QRCode.toDataURL(ownCard, { width: 280, margin: 1, color: { dark: "#0b0d12", light: "#ffffff" } })
      .then(setDataUrl)
      .catch(() => setDataUrl(""));
  }, [ownCard]);

  const copy = async () => {
    await navigator.clipboard.writeText(ownCard);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Modal title="My identity" onClose={onClose}>
      <p className="muted">
        Share this with a contact in person. They scan or paste it to add you. It contains your
        public identity key and transport key with a signed binding — never any private key.
      </p>
      <div className="qr-wrap">{dataUrl ? <img src={dataUrl} alt="identity QR" /> : <span className="muted">Generating…</span>}</div>
      <label className="field-label">Identity key</label>
      <code className="key-block">{identityKey}</code>
      <div className="modal-actions">
        <button onClick={copy}>{copied ? "Copied!" : "Copy contact card"}</button>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
