import { useState } from "react";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";
import type { PendingMigration } from "@orpal/core";

export function MigrationPromptModal({
  pending,
  onClose,
}: {
  pending: PendingMigration;
  onClose: () => void;
}) {
  const { acceptMigration, declineMigration } = useOrpal();
  const [busy, setBusy] = useState(false);

  const shortKey = (k: string) =>
    k.length <= 12 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;

  const retireDate = new Date(pending.migration.retire_after_utc).toLocaleString();

  const doAccept = async () => {
    setBusy(true);
    await acceptMigration(pending.contactKey);
    onClose();
  };

  const doDecline = () => {
    declineMigration(pending.contactKey);
    onClose();
  };

  return (
    <Modal title="Contact key rotation" onClose={onClose}>
      <p className="muted">
        <strong style={{ color: "var(--lcd)" }}>{pending.contactName}</strong> is rotating
        their identity key. This is a cryptographically verified migration — the old key
        authorized this replacement and the new key confirmed it.
      </p>

      <label className="field-label">Old identity key</label>
      <code className="key-block">{shortKey(pending.migration.old_key)}</code>

      <label className="field-label">New identity key</label>
      <code className="key-block">{shortKey(pending.migration.new_key)}</code>

      <label className="field-label">Old key valid until</label>
      <code className="key-block">{retireDate}</code>

      <p className="muted" style={{ fontSize: "12px" }}>
        If you accept, your contact list will update to the new key and you'll send an
        acknowledgement. If you decline, you'll keep using the old key until it retires — after
        that you won't be able to reach this contact unless you re-add them manually.
      </p>

      <div className="modal-actions">
        <button onClick={doAccept} disabled={busy}>
          {busy ? "Accepting…" : "Accept"}
        </button>
        <button className="ghost" onClick={doDecline} disabled={busy}>
          Decline
        </button>
      </div>
    </Modal>
  );
}
