// Browser/WebView WebSocket RendezvousBroker adapter.
//
// The ORP reference ships a Node `WebSocketRendezvousBroker` (client/wsbroker.ts)
// built on the `ws` package. That can't bundle into a browser (it pulls in
// node:net/tls). This is the conforming browser-native equivalent: it implements
// the SAME `RendezvousBroker` interface from core/protocol.ts, opens a `wss://`
// (or `ws://`) connection with the platform's native `WebSocket`, and
// (de)serializes the SPEC §4.4 Inbound/Outbound envelope as one JSON text frame
// each. It is a TRANSPORT only — it never inspects `relay` blobs (opaque,
// end-to-end-sealed; SPEC §0) and carries zero protocol semantics, so it adds no
// copyleft obligation and reuses the protocol's own types.
//
// Reconnect uses capped exponential backoff; a caller `close()` disables it.

import type {
  BoardConnection,
  Inbound,
  Outbound,
  RendezvousBroker,
} from "../orp.js";

/** Minimal slice of the WHATWG `WebSocket` surface this adapter relies on. The
 *  platform `WebSocket` (Chromium renderer, Capacitor WebView, Node 21+) all
 *  satisfy it; tests inject a double. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(
    type: "close",
    listener: (ev: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface BrowserBrokerOptions {
  /** Auto-reconnect on UNEXPECTED disconnect (default true). A caller `close()`
   *  always disables reconnect regardless of this flag. */
  reconnect?: boolean;
  /** First reconnect backoff, ms (default 500). Doubles each attempt up to max. */
  reconnectInitialMs?: number;
  /** Backoff ceiling, ms (default 10_000). */
  reconnectMaxMs?: number;
  /** Give up after this many consecutive failed attempts (default Infinity). */
  maxReconnectAttempts?: number;
  /** WebSocket constructor. Defaults to the global `WebSocket`. Inject for tests
   *  or non-standard environments. */
  WebSocketImpl?: WebSocketCtor;
  /** Lifecycle hooks — connection state only, never routed contents (SPEC §0/§8). */
  onOpen?: () => void;
  onClose?: (info: { code: number; reason: string; willReconnect: boolean }) => void;
  onError?: (err: unknown) => void;
  /** A board frame that isn't parseable JSON (defensive; the board never emits
   *  these). Defaults to ignoring it, mirroring the server which logs nothing. */
  onMalformed?: (raw: string) => void;
}

const WS_OPEN = 1; // WHATWG WebSocket.OPEN
const NORMAL_CLOSURE = 1000;

/** A `RendezvousBroker` backed by a native WebSocket endpoint (e.g.
 *  `wss://board.example.com/`). Each `connect()` opens its own socket, matching
 *  the reference server's one-socket-per-connection model. */
export class BrowserRendezvousBroker implements RendezvousBroker {
  constructor(
    private readonly url: string,
    private readonly opts: BrowserBrokerOptions = {},
  ) {}

  connect(onOutbound: (msg: Outbound) => void): BoardConnection {
    return new BrowserBoardConnection(this.url, onOutbound, this.opts);
  }
}

class BrowserBoardConnection implements BoardConnection {
  private ws: WebSocketLike | null = null;
  /** Inbound messages enqueued while the socket isn't OPEN; flushed on open. */
  private readonly pending: Inbound[] = [];
  private closedByCaller = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly Impl: WebSocketCtor;
  private readonly reconnectEnabled: boolean;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly url: string,
    private readonly onOutbound: (msg: Outbound) => void,
    private readonly opts: BrowserBrokerOptions,
  ) {
    const Impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Impl) {
      throw new Error(
        "BrowserRendezvousBroker: no WebSocket implementation available; pass options.WebSocketImpl",
      );
    }
    this.Impl = Impl;
    this.reconnectEnabled = opts.reconnect ?? true;
    this.initialMs = opts.reconnectInitialMs ?? 500;
    this.maxMs = opts.reconnectMaxMs ?? 10_000;
    this.maxAttempts = opts.maxReconnectAttempts ?? Infinity;
    this.open();
  }

  // ---- BoardConnection -----------------------------------------------------

  /** client → board. Buffered until the socket is OPEN, then flushed in order. */
  send(msg: Inbound): void {
    if (this.closedByCaller) return;
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.pending.push(msg);
    }
  }

  /** Caller-initiated clean shutdown: disables reconnect and closes the socket. */
  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pending.length = 0;
    try {
      this.ws?.close(NORMAL_CLOSURE);
    } catch {
      /* socket already gone */
    }
  }

  // ---- socket lifecycle ----------------------------------------------------

  private open(): void {
    let ws: WebSocketLike;
    try {
      ws = new this.Impl(this.url);
    } catch (err) {
      this.opts.onError?.(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.flush();
      this.opts.onOpen?.();
    });

    ws.addEventListener("message", (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      let msg: Outbound;
      try {
        msg = JSON.parse(raw) as Outbound;
      } catch {
        this.opts.onMalformed?.(raw);
        return;
      }
      this.onOutbound(msg);
    });

    ws.addEventListener("error", (ev) => {
      // The browser fires "close" after "error"; let close drive reconnect so we
      // never schedule it twice.
      this.opts.onError?.(ev);
    });

    ws.addEventListener("close", (ev) => {
      this.ws = null;
      const willReconnect =
        !this.closedByCaller &&
        this.reconnectEnabled &&
        this.reconnectAttempts < this.maxAttempts;
      this.opts.onClose?.({ code: ev.code, reason: ev.reason, willReconnect });
      if (willReconnect) this.scheduleReconnect();
    });
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    const queued = this.pending.splice(0, this.pending.length);
    for (const msg of queued) this.ws.send(JSON.stringify(msg));
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || !this.reconnectEnabled) return;
    if (this.reconnectAttempts >= this.maxAttempts) return;
    const delay = Math.min(this.maxMs, this.initialMs * 2 ** this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByCaller) this.open();
    }, delay);
  }
}
