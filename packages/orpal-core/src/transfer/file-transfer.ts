// File transfer over the message layer.
//
// Files are chunked and framed (file-offer → file-chunk* → file-done; see
// frames.ts), sent over the per-contact ReliableChannel, reassembled and
// integrity-verified (per-file SHA-256) on the receiver. Because the protocol
// does NOT dedupe, reorder, or auto-retry (SPEC §11.4), this layer owns all of
// that itself:
//   * delivery: each frame is one ACK'd send(); a chunk isn't considered sent
//     until its ACK returns — that ACK IS the backpressure signal.
//   * flow control: a bounded sliding WINDOW of in-flight chunks (so we never
//     dump a whole file into the data channel's send buffer at once).
//   * retry: a timed-out chunk is retried a bounded number of times; the receiver
//     is idempotent (dedupes by index), so a retry can never double-write.
//   * integrity: the receiver compares the reassembled file's SHA-256 to the
//     offer's; a mismatch fails the transfer rather than yielding a corrupt file.
//
// Large files are STREAMED to disk via the FileSink (shells back this with real
// file I/O), never buffered whole in memory.

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { b64uEncode, b64uDecode, DeliveryTimeoutError } from "../orp.js";
import type { AppFrame, FileChunkFrame, FileOfferFrame } from "../messaging/frames.js";

/** Random source of bytes to send. Shells implement this over real files; tests
 *  use the in-memory version below. */
export interface FileSource {
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  /** Read `length` bytes starting at `offset`. */
  readChunk(offset: number, length: number): Promise<Uint8Array>;
  /** Hex SHA-256 of the whole file (streamed by real implementations). */
  sha256(): Promise<string>;
  close(): Promise<void>;
}

/** Sink the received bytes are streamed into. */
export interface FileSink {
  /** Write `data` at byte `offset`. Must be safe to call out of order and to
   *  receive the SAME (offset,data) twice (idempotent at the engine layer, but
   *  implementations should not corrupt on a duplicate either). */
  writeChunk(offset: number, data: Uint8Array): Promise<void>;
  /** Flush, close, and return the hex SHA-256 of the fully written file. */
  finalize(): Promise<{ sha256: string }>;
  /** Discard a partial/failed transfer. */
  abort(): Promise<void>;
}

/** The minimal send surface the transfer engine needs: send one frame and resolve
 *  when it is ACK'd (or reject with DeliveryTimeoutError). OrpalClient implements
 *  this over a contact's ReliableChannel. */
export interface AckedSender {
  sendFrame(frame: AppFrame): Promise<void>;
}

export interface TransferProgress {
  fileId: string;
  name: string;
  transferred: number;
  total: number;
  /** chunks acked / total chunks */
  chunksDone: number;
  chunksTotal: number;
}

export interface FileTransferOptions {
  /** Bytes per chunk before base64 framing. Default 16 KiB (safe across WebRTC
   *  data-channel implementations even after base64 + JSON overhead). */
  chunkSize?: number;
  /** Max chunks in flight at once. Default 4. */
  window?: number;
  /** Per-chunk retry attempts on DeliveryTimeoutError. Default 3. */
  maxRetries?: number;
  /** Base backoff between retries, ms (doubles each attempt). Default 250. */
  retryBackoffMs?: number;
}

const DEFAULTS = {
  chunkSize: 16 * 1024,
  window: 4,
  maxRetries: 3,
  retryBackoffMs: 250,
};

function chunkCount(size: number, chunkSize: number): number {
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

export interface SendFileResult {
  fileId: string;
  sha256: string;
  chunks: number;
}

/**
 * Send one file over an AckedSender. Resolves once every chunk has been ACK'd and
 * the file-done marker sent; rejects if a chunk exhausts its retries.
 */
export async function sendFile(
  sender: AckedSender,
  source: FileSource,
  opts: FileTransferOptions & {
    fileId: string;
    onProgress?: (p: TransferProgress) => void;
    now?: () => number;
  },
): Promise<SendFileResult> {
  const chunkSize = opts.chunkSize ?? DEFAULTS.chunkSize;
  const window = Math.max(1, opts.window ?? DEFAULTS.window);
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const retryBackoffMs = opts.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
  const now = opts.now ?? (() => Date.now());

  const size = source.size;
  const chunks = chunkCount(size, chunkSize);
  const hash = await source.sha256();

  const offer: FileOfferFrame = {
    v: 1,
    t: "file-offer",
    fileId: opts.fileId,
    name: source.name,
    size,
    mime: source.mime,
    chunkSize,
    chunks,
    sha256: hash,
    ts: now(),
  };
  await sendWithRetry(sender, offer, maxRetries, retryBackoffMs);

  let transferred = 0;
  let chunksDone = 0;
  const emit = () =>
    opts.onProgress?.({
      fileId: opts.fileId,
      name: source.name,
      transferred,
      total: size,
      chunksDone,
      chunksTotal: chunks,
    });
  emit();

  // Sliding-window worker pool over a shared next-index counter.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= chunks) return;
      const offset = i * chunkSize;
      const length = Math.min(chunkSize, size - offset);
      const bytes = await source.readChunk(offset, length);
      const frame: FileChunkFrame = {
        v: 1,
        t: "file-chunk",
        fileId: opts.fileId,
        i,
        data: b64uEncode(bytes),
      };
      await sendWithRetry(sender, frame, maxRetries, retryBackoffMs);
      transferred += length;
      chunksDone += 1;
      emit();
    }
  };
  await Promise.all(Array.from({ length: Math.min(window, chunks) }, () => worker()));

  // Best-effort completion marker; the receiver also self-completes on the last
  // chunk, so a lost file-done is not fatal.
  try {
    await sendWithRetry(sender, { v: 1, t: "file-done", fileId: opts.fileId }, 1, retryBackoffMs);
  } catch {
    /* receiver completes on chunk count regardless */
  }

  await source.close();
  return { fileId: opts.fileId, sha256: hash, chunks };
}

async function sendWithRetry(
  sender: AckedSender,
  frame: AppFrame,
  maxRetries: number,
  backoffMs: number,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await sender.sendFrame(frame);
      return;
    } catch (err) {
      // Only retry the protocol's documented failure mode (no ACK in time).
      // Anything else (e.g. channel gone) propagates immediately.
      if (!(err instanceof DeliveryTimeoutError) || attempt >= maxRetries) throw err;
      await delay(backoffMs * 2 ** attempt);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------

export type ReceiveOutcome =
  | { ok: true; fileId: string; sha256: string }
  | { ok: false; fileId: string; reason: "integrity-failed" | "aborted" };

interface ReceivingFile {
  offer: FileOfferFrame;
  /** null until createSink() resolves; chunks that arrive before then are buffered. */
  sink: FileSink | null;
  received: Set<number>;
  transferred: number;
  /** chunks (by index) that arrived before the sink was ready. */
  buffer: Map<number, Uint8Array>;
  ready: boolean;
}

export interface FileReceiverCallbacks {
  /** Decide where the incoming file goes; create and return its sink. Throwing or
   *  returning a rejected promise rejects the transfer (no sink ⇒ no write). */
  createSink: (offer: FileOfferFrame) => Promise<FileSink>;
  onProgress?: (p: TransferProgress) => void;
  onComplete?: (outcome: ReceiveOutcome) => void;
}

/**
 * Stateful receiver for one or many concurrent incoming files, keyed by fileId.
 * Drive it by handing it decoded file-* frames; it dedupes, writes by offset,
 * tracks progress, and verifies integrity on completion.
 */
export class FileReceiver {
  private readonly files = new Map<string, ReceivingFile>();

  constructor(private readonly cb: FileReceiverCallbacks) {}

  async onOffer(offer: FileOfferFrame): Promise<void> {
    if (this.files.has(offer.fileId)) return; // duplicate offer — keep the first
    // Register SYNCHRONOUSLY so chunks racing ahead of the (async) sink creation
    // are buffered, not dropped — the recipient's ReliableChannel acks the offer
    // immediately (SPEC §11.4#4), so the sender may start chunking before
    // createSink() resolves.
    const f: ReceivingFile = {
      offer,
      sink: null,
      received: new Set(),
      transferred: 0,
      buffer: new Map(),
      ready: false,
    };
    this.files.set(offer.fileId, f);
    this.emitProgress(offer.fileId);

    let sink: FileSink;
    try {
      sink = await this.cb.createSink(offer);
    } catch {
      this.files.delete(offer.fileId);
      this.cb.onComplete?.({ ok: false, fileId: offer.fileId, reason: "aborted" });
      return;
    }
    f.sink = sink;
    f.ready = true;

    // Flush anything that arrived while the sink was being created.
    for (const [i, bytes] of [...f.buffer.entries()].sort((a, b) => a[0] - b[0])) {
      if (f.received.has(i)) continue;
      await sink.writeChunk(i * offer.chunkSize, bytes);
      f.received.add(i);
      f.transferred += bytes.length;
    }
    f.buffer.clear();
    this.emitProgress(offer.fileId);

    if (f.received.size === offer.chunks) await this.complete(offer.fileId);
  }

  async onChunk(chunk: FileChunkFrame): Promise<void> {
    const f = this.files.get(chunk.fileId);
    if (!f) return; // chunk for an unknown/finished file — drop
    if (chunk.i < 0 || chunk.i >= f.offer.chunks) return; // out of range — drop
    if (f.received.has(chunk.i)) return; // duplicate — idempotent no-op

    const bytes = b64uDecode(chunk.data);
    if (!f.ready || !f.sink) {
      // Sink not ready yet — buffer (overwriting a duplicate of the same index).
      f.buffer.set(chunk.i, bytes);
      return;
    }
    await f.sink.writeChunk(chunk.i * f.offer.chunkSize, bytes);
    f.received.add(chunk.i);
    f.transferred += bytes.length;
    this.emitProgress(chunk.fileId);

    if (f.received.size === f.offer.chunks) await this.complete(chunk.fileId);
  }

  /** Optional explicit completion marker; no-op if already finalized. */
  async onDone(fileId: string): Promise<void> {
    const f = this.files.get(fileId);
    if (f && f.received.size === f.offer.chunks) await this.complete(fileId);
  }

  /** Abort and discard a partial transfer. */
  async abort(fileId: string): Promise<void> {
    const f = this.files.get(fileId);
    if (!f) return;
    this.files.delete(fileId);
    await f.sink?.abort();
    this.cb.onComplete?.({ ok: false, fileId, reason: "aborted" });
  }

  private async complete(fileId: string): Promise<void> {
    const f = this.files.get(fileId);
    if (!f || !f.sink) return;
    this.files.delete(fileId);
    const { sha256: got } = await f.sink.finalize();
    if (got !== f.offer.sha256) {
      this.cb.onComplete?.({ ok: false, fileId, reason: "integrity-failed" });
      return;
    }
    this.cb.onComplete?.({ ok: true, fileId, sha256: got });
  }

  private emitProgress(fileId: string): void {
    const f = this.files.get(fileId);
    if (!f) return;
    this.cb.onProgress?.({
      fileId,
      name: f.offer.name,
      transferred: f.transferred,
      total: f.offer.size,
      chunksDone: f.received.size,
      chunksTotal: f.offer.chunks,
    });
  }
}

// ---------------------------------------------------------------------------
// In-memory FileSource / FileSink — reference impls used by tests and spikes.
// Shells provide streaming, disk-backed versions of these.
// ---------------------------------------------------------------------------

export class InMemoryFileSource implements FileSource {
  constructor(
    private readonly bytes: Uint8Array,
    readonly name: string,
    readonly mime: string,
  ) {}
  get size(): number {
    return this.bytes.length;
  }
  async readChunk(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.slice(offset, offset + length);
  }
  async sha256(): Promise<string> {
    return bytesToHex(sha256(this.bytes));
  }
  async close(): Promise<void> {}
}

export class InMemoryFileSink implements FileSink {
  private parts = new Map<number, Uint8Array>();
  private total = 0;

  async writeChunk(offset: number, data: Uint8Array): Promise<void> {
    if (!this.parts.has(offset)) this.total += data.length;
    this.parts.set(offset, data);
  }
  async finalize(): Promise<{ sha256: string }> {
    const out = new Uint8Array(this.total);
    for (const [offset, data] of [...this.parts.entries()].sort((a, b) => a[0] - b[0])) {
      out.set(data, offset);
    }
    this.assembled = out;
    return { sha256: bytesToHex(sha256(out)) };
  }
  async abort(): Promise<void> {
    this.parts.clear();
    this.total = 0;
  }
  /** The reassembled bytes (set after finalize) — for test assertions. */
  assembled: Uint8Array | null = null;
}
