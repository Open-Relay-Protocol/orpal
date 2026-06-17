import { useState } from "react";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";
import type { IceServer } from "@shared/ipc";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings, settingsNeedRestart } = useOrpal();
  const [boardUrl, setBoardUrl] = useState(settings.boardUrl);
  const [iceJson, setIceJson] = useState(JSON.stringify(settings.iceServers, null, 2));
  const [relayDefault, setRelayDefault] = useState(settings.relayOnlyByDefault);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    let iceServers: IceServer[];
    try {
      iceServers = JSON.parse(iceJson);
      if (!Array.isArray(iceServers)) throw new Error("must be an array");
    } catch (err) {
      setError(`ICE servers must be a JSON array: ${err instanceof Error ? err.message : err}`);
      return;
    }
    setError(null);
    await saveSettings({ boardUrl: boardUrl.trim(), iceServers, relayOnlyByDefault: relayDefault });
    setSaved(true);
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <label className="field-label">Board URL (wss:// or ws://)</label>
      <input value={boardUrl} onChange={(e) => setBoardUrl(e.target.value)} placeholder="ws://127.0.0.1:8080/" />

      <label className="field-label">ICE servers (STUN/TURN) — JSON</label>
      <textarea
        className="card-input mono"
        rows={7}
        value={iceJson}
        onChange={(e) => setIceJson(e.target.value)}
      />
      <p className="muted">
        A STUN server lets two NATed peers connect directly. For relay-only contacts you must add a
        TURN server here with credentials, e.g.
        <code> {"{ \"urls\": \"turn:host:3478\", \"username\": \"u\", \"credential\": \"p\" }"}</code>.
      </p>

      <label className="checkbox-row">
        <input type="checkbox" checked={relayDefault} onChange={(e) => setRelayDefault(e.target.checked)} />
        Relay-only by default for new contacts
      </label>

      {error && <div className="error-text">{error}</div>}
      {(saved || settingsNeedRestart) && (
        <div className="info-text">Saved. Restart Orpal to apply board / ICE changes.</div>
      )}

      <div className="modal-actions">
        <button onClick={save}>Save</button>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
