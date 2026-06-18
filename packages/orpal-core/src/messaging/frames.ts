// Application framing carried as the ReliableChannel payload.
//
// ReliableChannel.send(body: string) / onMessage(text) gives us ONE ordered-ish,
// ACK'd string pipe per contact. Orpal multiplexes text messages and file
// transfers over it with this small JSON envelope. Each frame is one send() call,
// so each gets its own §11 one-time-key ACK — that ACK is exactly our delivery
// receipt (text) and our per-chunk flow-control signal (files).
//
// We own ordering/idempotency here, because the protocol does not (SPEC §11.4):
//   * every frame carries an id (message id, or fileId+chunk index),
//   * the receiver dedupes file chunks by (fileId, index),
//   * chunk order on the wire doesn't matter — the receiver writes by offset.

export const APP_FRAME_VERSION = 1 as const;

export interface TextFrame {
  v: 1;
  t: "text";
  /** App-level message id (stable across retries the app may do). */
  id: string;
  text: string;
  ts: number;
}

/**
 * Application-level acknowledgement ("awk") of a delivered message.
 *
 * The ReliableChannel's §11 one-time-key ACK only proves a frame reached the
 * peer's channel layer — it says nothing about the app having durably accepted
 * the message. For offline/store-and-forward delivery (see pending-queue.ts) the
 * SENDER keeps a message queued and retrying until the RECIPIENT confirms it has
 * stored the message by sending this awk back over the same channel.
 *
 * Contract (sender ⇄ recipient must agree):
 *   - On receiving a `text` frame with id X, a recipient stores it and replies
 *     with `{ v: 1, t: "awk", id: X, ts: <now> }`.
 *   - awks are idempotent: a recipient that receives the same `id` again (a
 *     retry, because an earlier awk was lost) re-sends the awk and does NOT
 *     re-store the message.
 *   - On receiving an awk for id X, the sender removes X from its pending queue
 *     and marks it delivered locally. An awk for an unknown id is ignored.
 *   - awks are never themselves acked (no awk-of-an-awk).
 */
export interface AckFrame {
  v: 1;
  t: "awk";
  /** The app-level message id being acknowledged (matches the TextFrame.id). */
  id: string;
  /** Epoch-ms the recipient acknowledged at, for sender-side observability. */
  ts: number;
}

export interface FileOfferFrame {
  v: 1;
  t: "file-offer";
  fileId: string;
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  chunks: number;
  /** hex SHA-256 of the whole file, for end-to-end integrity verification. */
  sha256: string;
  ts: number;
}

export interface FileChunkFrame {
  v: 1;
  t: "file-chunk";
  fileId: string;
  /** 0-based chunk index. */
  i: number;
  /** b64u of the chunk bytes. */
  data: string;
}

export interface FileDoneFrame {
  v: 1;
  t: "file-done";
  fileId: string;
}

export type AppFrame = TextFrame | AckFrame | FileOfferFrame | FileChunkFrame | FileDoneFrame;

export function encodeAppFrame(frame: AppFrame): string {
  return JSON.stringify(frame);
}

/** Parse + shape-validate an incoming frame. Returns null on anything malformed
 *  so a bad frame is dropped rather than crashing the channel. */
export function decodeAppFrame(text: string): AppFrame | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const f = o as Record<string, unknown>;
  if (f.v !== APP_FRAME_VERSION) return null;
  switch (f.t) {
    case "text":
      if (typeof f.id === "string" && typeof f.text === "string" && typeof f.ts === "number") {
        return { v: 1, t: "text", id: f.id, text: f.text, ts: f.ts };
      }
      return null;
    case "awk":
      if (typeof f.id === "string" && typeof f.ts === "number") {
        return { v: 1, t: "awk", id: f.id, ts: f.ts };
      }
      return null;
    case "file-offer":
      if (
        typeof f.fileId === "string" &&
        typeof f.name === "string" &&
        typeof f.size === "number" &&
        typeof f.mime === "string" &&
        typeof f.chunkSize === "number" &&
        typeof f.chunks === "number" &&
        typeof f.sha256 === "string" &&
        typeof f.ts === "number"
      ) {
        return {
          v: 1,
          t: "file-offer",
          fileId: f.fileId,
          name: f.name,
          size: f.size,
          mime: f.mime,
          chunkSize: f.chunkSize,
          chunks: f.chunks,
          sha256: f.sha256,
          ts: f.ts,
        };
      }
      return null;
    case "file-chunk":
      if (typeof f.fileId === "string" && typeof f.i === "number" && typeof f.data === "string") {
        return { v: 1, t: "file-chunk", fileId: f.fileId, i: f.i, data: f.data };
      }
      return null;
    case "file-done":
      if (typeof f.fileId === "string") {
        return { v: 1, t: "file-done", fileId: f.fileId };
      }
      return null;
    default:
      return null;
  }
}
