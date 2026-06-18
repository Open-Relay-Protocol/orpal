// @orpal/core — public API surface.
//
// Re-exports the ORP protocol pieces Orpal builds on (via the ./orp.js seam) plus
// Orpal's own framework-agnostic additions: a browser/WebView WebRTC endpoint, a
// browser-native WebSocket rendezvous broker, identity management, the messaging
// + file-transfer layer over ReliableChannel, and local persistence interfaces.

// Protocol seam (Client, ReliableChannel, identity, sealing, ICE, crypto, types).
export * from "./orp.js";

// Transport adapters (browser/WebView).
export * from "./broker/browser-broker.js";
export * from "./rtc/browser-webrtc.js";

// Identity + secure storage abstraction.
export * from "./identity/secure-store.js";
export * from "./identity/identity-manager.js";

// Contacts.
export * from "./contacts/contact.js";

// Persistence abstraction.
export * from "./persistence/conversation-store.js";

// Messaging + file transfer.
export * from "./messaging/frames.js";
export * from "./messaging/orpal-client.js";
export * from "./messaging/pending-queue.js";
export * from "./messaging/delivery-worker.js";
export * from "./transfer/file-transfer.js";

// Utilities.
export { TypedEmitter } from "./util/events.js";
export type { Listener } from "./util/events.js";
