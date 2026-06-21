// Application framing carried as the ReliableChannel payload.
//
// ReliableChannel.send(body: string) / onMessage(text) gives us ONE ordered-ish,
// ACK'd string pipe per contact. Orpal multiplexes text messages and file
// transfers over it with this small JSON envelope. Each frame is one send() call,
// so each gets its own §11 one-time-key ACK -- that ACK is exactly our delivery
// receipt (text) and our per-chunk flow-control signal (files).
//
// We own ordering/idempotency here, because the protocol does not (SPEC §11.4):
//   * every frame carries an id (message id, or fileId+chunk index),
//   * the receiver dedupes file chunks by (fileId, index),
//   * chunk order on the wire doesn't matter -- the receiver writes by offset.

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
 * peer's channel layer -- it says nothing about the app having durably accepted
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

/** Tag for the only sealed-box construction we use (orp.ts `seal`). */
export const SEAL_ALG = "orp-sealedbox-v1" as const;

/**
 * A recipient-sealed envelope (issue #23).
 *
 * The inner app frame (a {@link TextFrame} or {@link FileOfferFrame}) is
 * serialized and sealed to the recipient's PINNED X25519 transport key -- the one
 * carried in their out-of-band-verified contact card -- with the ORP anonymous
 * sealed box (orp.ts `seal`). Only the holder of that transport private key can
 * open it, so a wrong-key / fake-peer connection can never read the contents.
 * The data channel is already end-to-end encrypted by the SecureChannel; this
 * layer additionally binds every user payload to the verified identity, which is
 * the anti-substitution guarantee the contact card promises.
 *
 * `awk`, `file-chunk` and `file-done` are deliberately NOT sealed: an awk carries
 * only a message id (no content) and the acknowledging side may not hold the
 * sender's transport key to seal one back; file chunks ride the already-encrypted
 * SecureChannel and are bound to a sealed offer by `fileId`. See
 * messaging/sealed.ts for the seal/open helpers.
 */
export interface SealedFrame {
  v: 1;
  t: "sealed";
  /** Sealed-box algorithm tag, so the wire format can evolve. */
  alg: typeof SEAL_ALG;
  /** b64u of `seal(utf8(JSON(innerFrame)), recipientTransportPub)`. */
  box: string;
}

/**
 * In-band contact-card exchange (contact requests).
 *
 * Sent once over a freshly-established channel so each side learns the OTHER's
 * shareable contact card -- identity key, transport key, and the signed binding
 * that ties them together. This is what lets a recipient ACCEPT an unknown sender
 * and add them as a full, two-way contact: until we hold a peer's transport key
 * we can receive their sealed messages but cannot seal a reply back to them.
 *
 * The card itself carries no secrets (it is meant to be shared) and the binding
 * is self-signed, so it rides the channel unsealed -- but the channel is already
 * end-to-end encrypted by the ORP SecureChannel, so the card is never exposed on
 * the wire. The receiver MUST additionally verify the card's identity key equals
 * the authenticated counterparty of the connection, so a peer can only ever
 * present its OWN card, never inject a third party's.
 */
export interface HelloFrame {
  v: 1;
  t: "hello";
  /** The sender's own serialized {@link ContactCard} JSON (see contact.ts). */
  card: string;
}

/** Wraps an ORP-004 key_migration record, sent over an existing channel to
 *  notify a contact of an identity rotation. */
export interface KeyMigrationFrame {
  v: 1;
  t: "key-migration";
  /** The full ORP-004 key_migration record (double-signed). */
  migration: Record<string, unknown>;
}

/** Wraps an ORP-004 migration_ack, sent back after the recipient accepts. */
export interface MigrationAckFrame {
  v: 1;
  t: "migration-ack";
  /** The full ORP-004 migration_ack record (signed by recipient). */
  ack: Record<string, unknown>;
}

/** Liveness challenge: recipient seals a nonce to a transport key. The holder
 *  of the corresponding private key must echo it back to prove control. */
export interface MigrationChallengeFrame {
  v: 1;
  t: "migration-challenge";
  /** Which key is being challenged: "old" or "new". */
  target: "old" | "new";
  /** b64u sealed-box ciphertext of the challenge nonce, sealed to the target's
   *  transport key. Only the holder of that transport private key can open it. */
  sealed_nonce: string;
  /** b64u one-time X25519 public key the response must be sealed to. */
  ack_pubkey: string;
}

/** Liveness response: the challenged party echoes the nonce back, sealed to the
 *  challenger's one-time key. */
export interface MigrationChallengeResponseFrame {
  v: 1;
  t: "migration-challenge-response";
  target: "old" | "new";
  /** b64u sealed-box ciphertext of the echoed nonce, sealed to ack_pubkey. */
  sealed_echo: string;
}

export type AppFrame =
  | TextFrame
  | AckFrame
  | FileOfferFrame
  | FileChunkFrame
  | FileDoneFrame
  | SealedFrame
  | HelloFrame
  | KeyMigrationFrame
  | MigrationAckFrame
  | MigrationChallengeFrame
  | MigrationChallengeResponseFrame;

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
    case "sealed":
      if (f.alg === SEAL_ALG && typeof f.box === "string") {
        return { v: 1, t: "sealed", alg: SEAL_ALG, box: f.box };
      }
      return null;
    case "hello":
      if (typeof f.card === "string") {
        return { v: 1, t: "hello", card: f.card };
      }
      return null;
    case "key-migration":
      if (typeof f.migration === "object" && f.migration !== null) {
        return { v: 1, t: "key-migration", migration: f.migration as Record<string, unknown> };
      }
      return null;
    case "migration-ack":
      if (typeof f.ack === "object" && f.ack !== null) {
        return { v: 1, t: "migration-ack", ack: f.ack as Record<string, unknown> };
      }
      return null;
    case "migration-challenge":
      if (
        (f.target === "old" || f.target === "new") &&
        typeof f.sealed_nonce === "string" &&
        typeof f.ack_pubkey === "string"
      ) {
        return { v: 1, t: "migration-challenge", target: f.target, sealed_nonce: f.sealed_nonce, ack_pubkey: f.ack_pubkey };
      }
      return null;
    case "migration-challenge-response":
      if (
        (f.target === "old" || f.target === "new") &&
        typeof f.sealed_echo === "string"
      ) {
        return { v: 1, t: "migration-challenge-response", target: f.target, sealed_echo: f.sealed_echo };
      }
      return null;
    default:
      return null;
  }
}
