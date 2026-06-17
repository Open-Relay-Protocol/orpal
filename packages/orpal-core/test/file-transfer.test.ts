import { describe, it, expect, afterEach } from "vitest";
import {
  DeviceIdentity,
  InMemoryConversationStore,
  InMemoryFileSink,
  InMemoryFileSource,
  FileReceiver,
  MockNetwork,
  MockWebRTC,
  OrpalClient,
  sendFile,
  type AckedSender,
  type AppFrame,
  type FileChunkFrame,
  type FileOfferFrame,
  type FileSink,
  type ReceiveOutcome,
  type WebRTCEndpoint,
} from "../src/index.js";
import { MockBoard } from "./helpers/mock-board.js";
import { once } from "./helpers/wait.js";

function makeBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

/** A sender that just records the frames the engine emits and acks instantly. */
function capturingSender(): { sender: AckedSender; frames: AppFrame[] } {
  const frames: AppFrame[] = [];
  return {
    frames,
    sender: { sendFrame: (f) => (frames.push(f), Promise.resolve()) },
  };
}

let live: OrpalClient[] = [];
afterEach(() => {
  for (const c of live) c.close();
  live = [];
});

describe("file transfer: chunking, reassembly, integrity, idempotency", () => {
  it("reassembles a file byte-for-byte and verifies its hash", async () => {
    const bytes = makeBytes(70_000); // 5 chunks at 16 KiB, last one partial
    const source = new InMemoryFileSource(bytes, "photo.bin", "application/octet-stream");
    const { sender, frames } = capturingSender();

    const res = await sendFile(sender, source, { fileId: "f1", chunkSize: 16 * 1024, window: 3 });
    expect(res.chunks).toBe(5);

    const offer = frames.find((f): f is FileOfferFrame => f.t === "file-offer")!;
    const chunks = frames.filter((f): f is FileChunkFrame => f.t === "file-chunk");
    expect(offer.chunks).toBe(5);
    expect(chunks).toHaveLength(5);
    expect(offer.sha256).toBe(res.sha256);

    const sink = new InMemoryFileSink();
    let outcome: ReceiveOutcome | null = null;
    const receiver = new FileReceiver({
      createSink: async () => sink,
      onComplete: (o) => (outcome = o),
    });

    await receiver.onOffer(offer);
    for (const c of chunks) await receiver.onChunk(c);

    expect(outcome).toEqual({ ok: true, fileId: "f1", sha256: res.sha256 });
    expect(sink.assembled).not.toBeNull();
    expect(Array.from(sink.assembled!)).toEqual(Array.from(bytes));
  });

  it("is idempotent under out-of-order and duplicate chunks", async () => {
    const bytes = makeBytes(50_000);
    const source = new InMemoryFileSource(bytes, "doc.bin", "application/octet-stream");
    const { sender, frames } = capturingSender();
    const res = await sendFile(sender, source, { fileId: "f2", chunkSize: 8 * 1024, window: 4 });

    const offer = frames.find((f): f is FileOfferFrame => f.t === "file-offer")!;
    const chunks = frames.filter((f): f is FileChunkFrame => f.t === "file-chunk");

    // Shuffle (reverse) and duplicate every chunk.
    const scrambled = [...chunks].reverse().flatMap((c) => [c, c]);

    const sink = new InMemoryFileSink();
    let outcome: ReceiveOutcome | null = null;
    let writes = 0;
    const countingSink: FileSink = {
      writeChunk: (offset, data) => (writes++, sink.writeChunk(offset, data)),
      finalize: () => sink.finalize(),
      abort: () => sink.abort(),
    };
    const receiver = new FileReceiver({
      createSink: async () => countingSink,
      onComplete: (o) => (outcome = o),
    });

    await receiver.onOffer(offer);
    for (const c of scrambled) await receiver.onChunk(c);

    // Despite duplicates, each chunk is written exactly once.
    expect(writes).toBe(chunks.length);
    expect(outcome).toEqual({ ok: true, fileId: "f2", sha256: res.sha256 });
    expect(Array.from(sink.assembled!)).toEqual(Array.from(bytes));
  });

  it("fails the transfer on an integrity mismatch", async () => {
    const bytes = makeBytes(20_000);
    const source = new InMemoryFileSource(bytes, "x.bin", "application/octet-stream");
    const { sender, frames } = capturingSender();
    await sendFile(sender, source, { fileId: "f3", chunkSize: 8 * 1024 });

    const offer = { ...(frames.find((f) => f.t === "file-offer") as FileOfferFrame) };
    offer.sha256 = "0".repeat(64); // claim a hash the bytes won't match
    const chunks = frames.filter((f): f is FileChunkFrame => f.t === "file-chunk");

    let outcome: ReceiveOutcome | null = null;
    const receiver = new FileReceiver({
      createSink: async () => new InMemoryFileSink(),
      onComplete: (o) => (outcome = o),
    });
    await receiver.onOffer(offer);
    for (const c of chunks) await receiver.onChunk(c);

    expect(outcome).toEqual({ ok: false, fileId: "f3", reason: "integrity-failed" });
  });

  it("handles a zero-byte file (completes on the offer)", async () => {
    const source = new InMemoryFileSource(new Uint8Array(0), "empty.bin", "application/octet-stream");
    const { sender, frames } = capturingSender();
    const res = await sendFile(sender, source, { fileId: "f4" });
    expect(res.chunks).toBe(0);

    const offer = frames.find((f): f is FileOfferFrame => f.t === "file-offer")!;
    let outcome: ReceiveOutcome | null = null;
    const receiver = new FileReceiver({
      createSink: async () => new InMemoryFileSink(),
      onComplete: (o) => (outcome = o),
    });
    await receiver.onOffer(offer);
    expect(outcome).toEqual({ ok: true, fileId: "f4", sha256: res.sha256 });
  });

  it("transfers a file end-to-end between two OrpalClients", async () => {
    const network = new MockNetwork();
    const board = new MockBoard();
    const factory = (matchId: string): WebRTCEndpoint => new MockWebRTC(matchId, network, "all");
    const bytes = makeBytes(40_000);

    const sinksByFileId = new Map<string, InMemoryFileSink>();
    const a = new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      broker: board,
      webrtcFactory: factory,
    });
    const b = new OrpalClient({
      identity: DeviceIdentity.generate(),
      store: new InMemoryConversationStore(),
      broker: board,
      webrtcFactory: factory,
      fileTransfer: { chunkSize: 8 * 1024, window: 3 },
      createFileSink: async (offer) => {
        const sink = new InMemoryFileSink();
        sinksByFileId.set(offer.fileId, sink);
        return { sink, path: `/tmp/${offer.name}` };
      },
    });
    live = [a, b];
    await a.start();
    await b.start();

    const completed = once(
      b.events,
      "message-updated",
      (e) => e.message.kind === "file" && e.message.file?.state === "complete",
    );

    const fileId = await a.sendFile(
      b.identityKey,
      new InMemoryFileSource(bytes, "report.bin", "application/octet-stream"),
    );

    const done = await completed;
    expect(done.message.file?.fileId).toBe(fileId);
    expect(done.message.file?.path).toBe("/tmp/report.bin");

    const sink = sinksByFileId.get(fileId)!;
    expect(Array.from(sink.assembled!)).toEqual(Array.from(bytes));
  }, 10_000);
});
