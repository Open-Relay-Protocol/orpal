import { useState } from "react";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";

const PRESETS: { label: string; hours: number }[] = [
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 7 * 24 },
  { label: "30 days", hours: 30 * 24 },
];

type Step = "confirm" | "choose-window" | "notifying" | "progress";

export function MigrationWizardModal({ onClose }: { onClose: () => void }) {
  const { startMigration, retireMigration, migrationProgress, contacts } = useOrpal();
  const [step, setStep] = useState<Step>(migrationProgress ? "progress" : "confirm");
  const [selectedHours, setSelectedHours] = useState(PRESETS[1].hours);
  const [error, setError] = useState<string | null>(null);
  const [retiring, setRetiring] = useState(false);

  const progress = migrationProgress;

  const doStart = async () => {
    setStep("notifying");
    setError(null);
    try {
      const retireAt = new Date(Date.now() + selectedHours * 3600_000).toISOString();
      await startMigration(retireAt);
      setStep("progress");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("choose-window");
    }
  };

  const doRetire = async () => {
    setRetiring(true);
    try {
      await retireMigration();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRetiring(false);
    }
  };

  if (step === "confirm") {
    return (
      <Modal title="Rotate identity" onClose={onClose}>
        <p className="muted">
          This generates a brand-new identity keypair and notifies all your contacts so they can
          update your address. During the transition window both keys work — you'll accept
          messages on both but send only from the new one.
        </p>
        <div className="error-text" style={{ fontSize: "12px" }}>
          Warning: after the old key is retired, message history encrypted to it becomes
          unreadable. This will be fixed in a future update.
        </div>
        <div className="modal-actions">
          <button onClick={() => setStep("choose-window")}>Continue</button>
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </Modal>
    );
  }

  if (step === "choose-window") {
    return (
      <Modal title="Retirement window" onClose={onClose}>
        <p className="muted">
          How long should your old key stay valid? Contacts who haven't updated yet can still
          reach you until this window closes.
        </p>
        <label className="field-label">Dual-validity period</label>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {PRESETS.map((p) => {
            const active = selectedHours === p.hours;
            return (
              <button
                key={p.hours}
                className={active ? "" : "ghost"}
                style={active ? {
                  background: "linear-gradient(var(--title-1), var(--title-2))",
                  borderColor: "var(--lcd)",
                  color: "#fff",
                  boxShadow: "inset 0 0 0 1px var(--lcd-dim), 0 0 8px rgba(79, 160, 255, 0.3)",
                } : undefined}
                onClick={() => setSelectedHours(p.hours)}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="muted" style={{ fontSize: "11px" }}>
          {contacts.length} contact{contacts.length !== 1 ? "s" : ""} will be notified.
        </p>
        {error && <div className="error-text">{error}</div>}
        <div className="modal-actions">
          <button onClick={doStart}>Start migration</button>
          <button className="ghost" onClick={() => setStep("confirm")}>Back</button>
        </div>
      </Modal>
    );
  }

  if (step === "notifying") {
    return (
      <Modal title="Notifying contacts…" onClose={() => {}}>
        <p className="muted">Generating new identity and sending migration notices…</p>
      </Modal>
    );
  }

  // step === "progress"
  const acked = progress?.acknowledged ?? 0;
  const total = progress?.totalContacts ?? 0;
  const pct = total > 0 ? Math.round((acked / total) * 100) : 0;
  const retireDate = progress?.retireAfterUtc
    ? new Date(progress.retireAfterUtc).toLocaleString()
    : "—";
  const retirementDue = progress?.retireAfterUtc
    ? Date.now() >= Date.parse(progress.retireAfterUtc)
    : false;

  return (
    <Modal title="Migration in progress" onClose={onClose}>
      <label className="field-label">Contact acknowledgements</label>
      <div className="progress" style={{ marginTop: "4px" }}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="muted" style={{ fontSize: "12px" }}>
        {acked} of {total} contact{total !== 1 ? "s" : ""} acknowledged
      </p>

      <label className="field-label">Status</label>
      <code className="key-block">{progress?.phase ?? "unknown"}</code>

      <label className="field-label">Old key retires</label>
      <code className="key-block">{retireDate}</code>

      {retirementDue && (
        <>
          <div className="info-text" style={{ marginTop: "6px" }}>
            The retirement window has passed. You can now retire the old key.
          </div>
          <div className="error-text" style={{ fontSize: "12px" }}>
            Retiring will delete your old private key. Message history encrypted to it
            will become unreadable.
          </div>
        </>
      )}

      {error && <div className="error-text">{error}</div>}

      <div className="modal-actions">
        {retirementDue && (
          <button onClick={doRetire} disabled={retiring}>
            {retiring ? "Retiring…" : "Retire old key"}
          </button>
        )}
        <button className="ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
