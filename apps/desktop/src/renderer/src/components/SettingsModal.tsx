import { useState } from "react";
import { useOrpal } from "../state/orpal-context.js";
import { Modal } from "./Modal.js";
import type { IceServer } from "@shared/ipc";

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings, settingsNeedRestart } = useOrpal();
  const [boards, setBoards] = useState<string[]>(
    settings.boards.length ? [...settings.boards] : [""],
  );
  const [iceJson, setIceJson] = useState(JSON.stringify(settings.iceServers, null, 2));
  const [relayDefault, setRelayDefault] = useState(settings.relayOnlyByDefault);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const setBoard = (i: number, v: string) =>
    setBoards((b) => b.map((x, idx) => (idx === i ? v : x)));
  const addBoard = () => setBoards((b) => [...b, ""]);
  const removeBoard = (i: number) => setBoards((b) => b.filter((_, idx) => idx !== i));

  const save = async () => {
    const cleaned = boards.map((b) => b.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      setError("Add at least one board URL (ws:// or wss://).");
      return;
    }
    let iceServers: IceServer[];
    try {
      iceServers = JSON.parse(iceJson);
      if (!Array.isArray(iceServers)) throw new Error("must be an array");
    } catch (err) {
      setError(`ICE servers must be a JSON array: ${err instanceof Error ? err.message : err}`);
      return;
    }
    setError(null);
    await saveSettings({ boards: cleaned, iceServers, relayOnlyByDefault: relayDefault });
    setSaved(true);
  };

  return (
    <Modal title="Settings" onClose={onClose}>
      <label className="field-label">Boards (ws:// or wss://) — federated</label>
      {boards.map((url, i) => (
        <div className="board-row" key={i}>
          <input
            value={url}
            onChange={(e) => setBoard(i, e.target.value)}
            placeholder="wss://board.example.com/"
          />
          <button
            className="ghost board-remove"
            onClick={() => removeBoard(i)}
            disabled={boards.length === 1}
            title="Remove board"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="ghost add-board" onClick={addBoard}>
        + Add board
      </button>
      <p className="muted">
        Your device announces presence on every board and reaches a contact via whichever board
        you’re both on. The first board to make a working connection wins.
      </p>

      <label className="field-label">ICE servers (STUN/TURN) — JSON</label>
      <textarea
        className="card-input mono"
        rows={6}
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
