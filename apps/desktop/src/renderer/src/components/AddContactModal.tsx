import { useState } from "react";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";
import { QrScanner } from "./QrScanner.js";

const REASONS: Record<string, string> = {
  "not-valid-json": "That doesn’t look like a contact card.",
  "not-an-orpal-contact-card": "That isn’t an Orpal contact card.",
  "missing-fields": "The card is missing required fields.",
  "bad-binding-signature": "The card’s key binding signature is invalid — refusing to add it.",
  "binding-identity-mismatch": "The card’s binding doesn’t match its identity key.",
  "binding-transport-mismatch": "The card’s binding doesn’t match its transport key.",
  "that-is-your-own-card": "That’s your own card.",
};

export function AddContactModal({ onClose }: { onClose: () => void }) {
  const { addContact } = useOrpal();
  const [tab, setTab] = useState<"paste" | "scan">("paste");
  const [card, setCard] = useState("");
  const [name, setName] = useState("");
  const [relayOnly, setRelayOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await addContact(card.trim(), name.trim() || undefined, relayOnly);
    setBusy(false);
    if (res.ok) onClose();
    else setError(REASONS[res.reason ?? ""] ?? `Couldn’t add contact (${res.reason}).`);
  };

  return (
    <Modal title="Add contact" onClose={onClose}>
      <div className="tabs">
        <button className={tab === "paste" ? "tab active" : "tab"} onClick={() => setTab("paste")}>
          Paste
        </button>
        <button className={tab === "scan" ? "tab active" : "tab"} onClick={() => setTab("scan")}>
          Scan QR
        </button>
      </div>

      {tab === "scan" && (
        <div className="scan-wrap">
          <QrScanner
            onResult={(text) => {
              setCard(text);
              setTab("paste");
            }}
          />
          <p className="muted">Point the webcam at the other device’s identity QR.</p>
        </div>
      )}

      {tab === "paste" && (
        <>
          <label className="field-label">Contact card</label>
          <textarea
            className="card-input"
            placeholder="Paste the contact card JSON here…"
            value={card}
            onChange={(e) => setCard(e.target.value)}
            rows={5}
          />
          <label className="field-label">Display name (optional)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alice" />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={relayOnly}
              onChange={(e) => setRelayOnly(e.target.checked)}
            />
            Relay-only (route via TURN; the peer never learns your IP — requires a TURN server)
          </label>
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button onClick={submit} disabled={busy || !card.trim()}>
              {busy ? "Adding…" : "Add contact"}
            </button>
            <button className="ghost" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
