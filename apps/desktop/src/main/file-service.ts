// Streaming file I/O for transfers, in the main process.
//
// The renderer orchestrates chunking/framing over the data channel but NEVER
// holds a whole file: it asks main to read a chunk at an offset (sending) or to
// write a chunk at an offset (receiving). This keeps large transfers off the
// renderer heap and lets integrity hashing stream off disk.

import { app, dialog, shell } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat, mkdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FilePick, ReadHandle, WriteHandle } from "../shared/ipc.js";

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".zip": "application/zip",
};

function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

interface ReadEntry {
  fh: FileHandle;
  path: string;
}
interface WriteEntry {
  fh: FileHandle;
  path: string;
}

export class FileService {
  private readonly reads = new Map<string, ReadEntry>();
  private readonly writes = new Map<string, WriteEntry>();

  async pickForSend(): Promise<FilePick | null> {
    const res = await dialog.showOpenDialog({ properties: ["openFile"] });
    if (res.canceled || res.filePaths.length === 0) return null;
    const path = res.filePaths[0];
    const s = await stat(path);
    return { path, name: basename(path), size: s.size, mime: mimeFor(path) };
  }

  async openRead(path: string): Promise<ReadHandle> {
    const fh = await open(path, "r");
    const s = await fh.stat();
    const handleId = randomUUID();
    this.reads.set(handleId, { fh, path });
    return { handleId, name: basename(path), size: s.size, mime: mimeFor(path) };
  }

  async readChunk(handleId: string, offset: number, length: number): Promise<Uint8Array> {
    const entry = this.reads.get(handleId);
    if (!entry) throw new Error(`file-service: no open read handle ${handleId}`);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await entry.fh.read(buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  }

  async hash(handleId: string): Promise<string> {
    const entry = this.reads.get(handleId);
    if (!entry) throw new Error(`file-service: no open read handle ${handleId}`);
    return sha256OfFile(entry.path);
  }

  async closeRead(handleId: string): Promise<void> {
    const entry = this.reads.get(handleId);
    if (!entry) return;
    this.reads.delete(handleId);
    await entry.fh.close();
  }

  async openWrite(name: string): Promise<WriteHandle> {
    const dir = join(app.getPath("downloads"), "Orpal");
    await mkdir(dir, { recursive: true });
    const path = await uniquePath(join(dir, sanitize(name)));
    const fh = await open(path, "w");
    const handleId = randomUUID();
    this.writes.set(handleId, { fh, path });
    return { handleId, path };
  }

  async writeChunk(handleId: string, offset: number, data: Uint8Array): Promise<void> {
    const entry = this.writes.get(handleId);
    if (!entry) throw new Error(`file-service: no open write handle ${handleId}`);
    await entry.fh.write(data, 0, data.length, offset);
  }

  async finalizeWrite(handleId: string): Promise<{ sha256: string; path: string }> {
    const entry = this.writes.get(handleId);
    if (!entry) throw new Error(`file-service: no open write handle ${handleId}`);
    this.writes.delete(handleId);
    await entry.fh.close();
    const sha256 = await sha256OfFile(entry.path);
    return { sha256, path: entry.path };
  }

  async abortWrite(handleId: string): Promise<void> {
    const entry = this.writes.get(handleId);
    if (!entry) return;
    this.writes.delete(handleId);
    await entry.fh.close();
    await rm(entry.path, { force: true });
  }

  reveal(path: string): void {
    shell.showItemInFolder(path);
  }

  async closeAll(): Promise<void> {
    for (const e of this.reads.values()) await e.fh.close().catch(() => {});
    for (const e of this.writes.values()) await e.fh.close().catch(() => {});
    this.reads.clear();
    this.writes.clear();
  }
}

function sanitize(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").slice(0, 200) || "file";
}

async function uniquePath(path: string): Promise<string> {
  const dot = path.lastIndexOf(".");
  const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  let candidate = path;
  let n = 1;
  for (;;) {
    try {
      await stat(candidate);
      candidate = `${base} (${n++})${ext}`;
    } catch {
      return candidate; // doesn't exist
    }
  }
}
