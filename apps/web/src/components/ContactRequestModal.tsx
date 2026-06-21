import { useState } from "react";
import { shortKey, type ContactRequest } from "@orpal/core";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";

const REASONS: Record<string, string> = {
  "no-pending-request": "This request is no longer available.",
  "that-is-your-own-card": "That’s your own card.",
  "bad-binding-signature": "The sender’s key binding signature is invalid.",
  "binding-identity-mismatch": "The sender’s binding doesn’t match their identity key.",
  "binding-transport-mismatch": "The sender’s binding doesn’t match their transport key.",
  "not-ready": "Orpal isn’t ready yet — try again in a moment.",
};

/**
 * Prompt shown when an unknown sender (not yet a contact) messages us. They
 * handed us their card in-band, so the user can ACCEPT — naming them and adding a
 * full two-way contact — or DECLINE, with the option to BLOCK them (refusing the
 * connection at the protocol level and hiding the conversation).
 */
export function ContactRequestModal({ request }: { request: ContactRequest }) {
  const { acceptContactRequest, blockContact, dismissContactRequest } = useOrpal();
  const [step, setStep] = useState<"choose" | "accept" | "decline">("choose");
  const [name, setName] = useState(request.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fingerprint = shortKey(request.contactKey);

  const doAccept = async () => {
    setBusy(true);
    setError(null);
    const res = await acceptContactRequest(request.contactKey, name.trim() || undefined);
    setBusy(false);
    if (!res.ok) setError(REASONS[res.reason ?? ""] ?? `Couldn’t accept (${res.reason}).`);
    // On success the request disappears from state and this modal unmounts.
  };

  const doBlock = async () => {
    setBusy(true);
    await blockContact(request.contactKey);
    // blockContact clears the request; modal unmounts.
  };

  const onClose = () => dismissContactRequest(request.contactKey);

  return (
    <Modal title="New message request" onClose={onClose}>
      <p className="muted">
        Someone who isn’t in your contacts has messaged you. They can reach you because they have
        your contact card. Their identity key is cryptographically verified, but{" "}
        <strong style={{ color: "var(--lcd)" }}>you decide</strong> whether to talk to them.
      </p>

      <label className="field-label">From</label>
      <code className="key-block">
        {request.name ? `${request.name} · ` : ""}
        {fingerprint}
      </code>

      {step === "choose" && (
        <>
          <p className="muted" style={{ fontSize: "12px" }}>
            Accepting adds them as a contact so you can reply. Declining lets you block them — their
            connection will be refused and the conversation hidden.
          </p>
          <div className="modal-actions">
            <button onClick={() => setStep("accept")} disabled={busy}>
              Accept
            </button>
            <button className="ghost" onClick={() => setStep("decline")} disabled={busy}>
              Decline
            </button>
          </div>
        </>
      )}

      {step === "accept" && (
        <>
          <label className="field-label">Name this contact</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={request.name || "e.g. Alice"}
            maxLength={64}
            aria-label="Contact name"
          />
          <p className="muted" style={{ fontSize: "12px" }}>
            This name is local to your device — it’s never sent to them or the board.
          </p>
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button onClick={doAccept} disabled={busy}>
              {busy ? "Adding…" : "Accept & add contact"}
            </button>
            <button className="ghost" onClick={() => setStep("choose")} disabled={busy}>
              Back
            </button>
          </div>
        </>
      )}

      {step === "decline" && (
        <>
          <p className="muted" style={{ fontSize: "12px" }}>
            Block this sender? Their connection will be refused at the protocol level — no further
            messages, files, or requests — and they’ll be added to your block list in Settings, where
            you can unblock them later. Or just dismiss this for now.
          </p>
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button onClick={doBlock} disabled={busy}>
              {busy ? "Blocking…" : "Block sender"}
            </button>
            <button className="ghost" onClick={onClose} disabled={busy}>
              Just dismiss
            </button>
            <button className="ghost" onClick={() => setStep("choose")} disabled={busy}>
              Back
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
