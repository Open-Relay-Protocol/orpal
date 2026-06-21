import { useRef, useState } from "react";
import {
  createBackup,
  decryptBackup,
  parseBackupEnvelope,
  summarizeBackup,
  BackupDecryptError,
  type BackupPayload,
  type BackupImportSummary,
} from "@orpal/core";
import { useOrpal } from "../state/orpal-context.js";

type ExportState = "idle" | "password" | "exporting" | "done";
type ImportState = "idle" | "password" | "decrypting" | "confirm" | "importing" | "done";

export function BackupSection() {
  const { gatherBackupPayload, restoreBackupPayload } = useOrpal();

  const [exportState, setExportState] = useState<ExportState>("idle");
  const [importState, setImportState] = useState<ImportState>("idle");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BackupImportSummary | null>(null);
  const [pendingPayload, setPendingPayload] = useState<BackupPayload | null>(null);
  const [pendingExportedUtc, setPendingExportedUtc] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileText, setFileText] = useState<string | null>(null);

  const resetAll = () => {
    setExportState("idle");
    setImportState("idle");
    setPassword("");
    setConfirmPassword("");
    setError(null);
    setSummary(null);
    setPendingPayload(null);
    setFileText(null);
  };

  const doExport = async () => {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    setExportState("exporting");
    try {
      const payload = await gatherBackupPayload();
      const json = await createBackup(payload, password);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `orpal-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setExportState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setExportState("password");
    }
  };

  const handleFileSelect = () => {
    const input = fileRef.current;
    if (!input?.files?.[0]) return;
    const reader = new FileReader();
    reader.onload = () => {
      setFileText(reader.result as string);
      setImportState("password");
    };
    reader.readAsText(input.files[0]);
  };

  const doDecrypt = async () => {
    if (!fileText) return;
    setError(null);
    setImportState("decrypting");
    try {
      const envelope = parseBackupEnvelope(fileText);
      const payload = await decryptBackup(envelope, password);
      const sum = summarizeBackup(payload, envelope.exportedUtc);
      setSummary(sum);
      setPendingPayload(payload);
      setPendingExportedUtc(envelope.exportedUtc);
      setImportState("confirm");
    } catch (err) {
      if (err instanceof BackupDecryptError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setImportState("password");
    }
  };

  const doRestore = async () => {
    if (!pendingPayload) return;
    setImportState("importing");
    setError(null);
    try {
      await restoreBackupPayload(pendingPayload);
      setImportState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setImportState("confirm");
    }
  };

  return (
    <>
      <label className="field-label">Backup & restore</label>

      {exportState === "idle" && importState === "idle" && (
        <div className="modal-actions">
          <button className="ghost" onClick={() => setExportState("password")}>
            Export backup
          </button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Import backup
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.orpal-backup"
            style={{ display: "none" }}
            onChange={handleFileSelect}
          />
        </div>
      )}

      {exportState === "password" && (
        <div className="backup-form">
          <p className="muted">
            Choose a strong password. This is the ONLY protection for your private keys and
            message history in the backup file.
          </p>
          <input
            type="password"
            placeholder="Backup password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Backup password"
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-label="Confirm backup password"
          />
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button onClick={doExport}>Encrypt & download</button>
            <button className="ghost" onClick={resetAll}>Cancel</button>
          </div>
        </div>
      )}

      {exportState === "exporting" && (
        <p className="muted">Encrypting backup...</p>
      )}

      {exportState === "done" && (
        <>
          <div className="info-text">Backup downloaded. Store it securely.</div>
          <button className="ghost" onClick={resetAll}>Done</button>
        </>
      )}

      {importState === "password" && (
        <div className="backup-form">
          <p className="muted">Enter the password used when this backup was created.</p>
          <input
            type="password"
            placeholder="Backup password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Backup password"
          />
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button onClick={doDecrypt}>Decrypt</button>
            <button className="ghost" onClick={resetAll}>Cancel</button>
          </div>
        </div>
      )}

      {importState === "decrypting" && (
        <p className="muted">Decrypting...</p>
      )}

      {importState === "confirm" && summary && (
        <div className="backup-form">
          <p className="muted">This backup contains:</p>
          <div className="key-block">
            {summary.contactCount} contact{summary.contactCount !== 1 ? "s" : ""},{" "}
            {summary.messageCount} message{summary.messageCount !== 1 ? "s" : ""},{" "}
            {summary.pendingCount} pending
            {summary.hasMigration ? ", active migration" : ""}
            <br />
            Exported: {new Date(pendingExportedUtc).toLocaleString()}
          </div>
          <div className="error-text" style={{ fontSize: "12px" }}>
            Warning: importing will REPLACE your current identity, contacts, and message
            history. This cannot be undone.
          </div>
          {error && <div className="error-text">{error}</div>}
          <div className="modal-actions">
            <button onClick={doRestore}>Restore</button>
            <button className="ghost" onClick={resetAll}>Cancel</button>
          </div>
        </div>
      )}

      {importState === "importing" && (
        <p className="muted">Restoring...</p>
      )}

      {importState === "done" && (
        <>
          <div className="info-text">Backup restored. Restart Orpal to use the restored identity.</div>
          <button className="ghost" onClick={resetAll}>Done</button>
        </>
      )}
    </>
  );
}
