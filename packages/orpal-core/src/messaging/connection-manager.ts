import type { ReliableChannel, WebRTCEndpoint } from "../orp.js";
import type { ContactState } from "./orpal-client.js";
import type { FileReceiver } from "../transfer/file-transfer.js";
import { TypedEmitter } from "../util/events.js";

export interface ContactConn {
  contactKey: string;
  matchKey: string;
  boardId: string;
  channel: ReliableChannel;
  endpoint: WebRTCEndpoint | null;
  state: ContactState;
  fileReceiver: FileReceiver | null;
}

export type ConnectionEvents = {
  state: { contactKey: string; state: ContactState };
};

const SEP = " ";
export const mk = (boardId: string, matchId: string): string => boardId + SEP + matchId;

export class ConnectionManager {
  readonly events = new TypedEmitter<ConnectionEvents>();

  private readonly connections = new Map<string, ContactConn>();
  private readonly matchToCounterparty = new Map<string, string>();
  private readonly endpointsByMatch = new Map<string, WebRTCEndpoint>();
  private readonly connectWaiters = new Map<string, Set<(conn: ContactConn) => void>>();
  private readonly pendingConnects = new Map<string, Promise<ContactConn>>();
  private readonly _desiredContacts = new Set<string>();

  get desiredContacts(): ReadonlySet<string> {
    return this._desiredContacts;
  }

  getConnection(contactKey: string): ContactConn | undefined {
    return this.connections.get(contactKey);
  }

  setConnection(contactKey: string, conn: ContactConn): void {
    this.connections.set(contactKey, conn);
  }

  allConnections(): IterableIterator<ContactConn> {
    return this.connections.values();
  }

  recordMatch(matchKey: string, counterpartyKey: string): void {
    this.matchToCounterparty.set(matchKey, counterpartyKey);
  }

  counterpartyFor(matchKey: string): string | undefined {
    return this.matchToCounterparty.get(matchKey);
  }

  storeEndpoint(matchKey: string, endpoint: WebRTCEndpoint): void {
    this.endpointsByMatch.set(matchKey, endpoint);
  }

  getEndpoint(matchKey: string): WebRTCEndpoint | undefined {
    return this.endpointsByMatch.get(matchKey);
  }

  contactState(contactKey: string): ContactState {
    return this.connections.get(contactKey)?.state ?? "unknown";
  }

  emitState(contactKey: string, state: ContactState): void {
    this.events.emit("state", { contactKey, state });
  }

  ensureConnection(
    contactKey: string,
    timeoutMs: number,
    sendIntents: () => void,
    makeTimeoutError: (key: string) => Error,
  ): Promise<ContactConn> {
    const existing = this.connections.get(contactKey);
    if (existing && existing.state === "connected") return Promise.resolve(existing);

    const inflight = this.pendingConnects.get(contactKey);
    if (inflight) return inflight;

    const promise = new Promise<ContactConn>((resolve, reject) => {
      const waiter = (conn: ContactConn) => {
        clearTimeout(timer);
        this.removeConnectWaiter(contactKey, waiter);
        this.pendingConnects.delete(contactKey);
        resolve(conn);
      };
      const timer = setTimeout(() => {
        this.removeConnectWaiter(contactKey, waiter);
        this.pendingConnects.delete(contactKey);
        if (this.connections.get(contactKey)?.state !== "connected") {
          this.emitState(contactKey, "down");
        }
        reject(makeTimeoutError(contactKey));
      }, timeoutMs);

      this.addConnectWaiter(contactKey, waiter);
      this._desiredContacts.add(contactKey);
      this.emitState(contactKey, "connecting");
      sendIntents();
    });
    this.pendingConnects.set(contactKey, promise);
    return promise;
  }

  resolveConnectWaiters(contactKey: string, conn: ContactConn): void {
    const set = this.connectWaiters.get(contactKey);
    if (!set) return;
    this.connectWaiters.delete(contactKey);
    for (const waiter of set) waiter(conn);
  }

  handleEndpointState(matchKey: string, state: string): void {
    const contactKey = this.matchToCounterparty.get(matchKey);
    if (!contactKey) return;
    const conn = this.connections.get(contactKey);
    if (!conn || conn.matchKey !== matchKey) return;
    if (state === "connected") {
      this.emitState(contactKey, "connected");
    } else if (state === "disconnected" || state === "failed" || state === "closed") {
      conn.state = "down";
      this.emitState(contactKey, "down");
    }
  }

  closeAll(): void {
    for (const conn of this.connections.values()) {
      try { conn.endpoint?.close(); } catch { /* ignore */ }
    }
    this.connections.clear();
  }

  private addConnectWaiter(contactKey: string, waiter: (conn: ContactConn) => void): void {
    let set = this.connectWaiters.get(contactKey);
    if (!set) {
      set = new Set();
      this.connectWaiters.set(contactKey, set);
    }
    set.add(waiter);
  }

  private removeConnectWaiter(contactKey: string, waiter: (conn: ContactConn) => void): void {
    this.connectWaiters.get(contactKey)?.delete(waiter);
  }
}
