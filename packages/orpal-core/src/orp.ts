// The SINGLE seam between Orpal and the ORP reference (github.com/Prograde-Solutions/orp).
//
// Everything Orpal reuses from the protocol — crypto, identity, sealing, ICE
// filtering, the two-stage match Client, and the ReliableChannel ACK layer — is
// re-exported from here so the rest of orpal-core imports `./orp.js` and never
// reaches into the vendored tree directly. If the reference's layout changes,
// this is the only file to touch.
//
// The path points at `vendor/orp`, which is the reference's `core/` + a handful
// of `client/` files compiled by `tsconfig.orp.json` from the vendored Apache
// source in `orp-ref/`. The AGPL `board/`, the Node-only `ws` broker, and the
// `werift` adapter are NOT vendored, so none of them can reach the shipped client.
// We add no second crypto stack: @noble is declared at the reference's exact
// versions (curves 1.8.1 / hashes 1.7.1 / ciphers 1.2.1).
//
// RUNTIME NOTE: the reference's encoding helpers use Node's `Buffer`. Orpal's
// browser shells (the Chromium PWA and a Capacitor WebView) install a `Buffer`
// global before loading core; Node test runs have it natively. orpal-core assumes a
// global `Buffer` exists, exactly as the reference does.

// ---- core: protocol transport types -----------------------------------------
export type {
  BoardConnection,
  RendezvousBroker,
  Inbound,
  Outbound,
  FrameKind,
  Observer,
} from "../vendor/orp/core/protocol.js";

// ---- core: identity + binding -----------------------------------------------
export {
  DeviceIdentity,
  verifyBinding,
} from "../vendor/orp/core/identity.js";
export type {
  KeyBinding,
  PublicIdentity,
} from "../vendor/orp/core/identity.js";

// ---- core: wire records (presence/intent/match frames) ----------------------
export type { Presence, Intent, MatchFrame } from "../vendor/orp/core/wire.js";

// ---- core: low-level crypto / encoding (reused, never re-implemented) --------
export { seal, unseal } from "../vendor/orp/core/sealedbox.js";
export {
  b64uEncode,
  b64uDecode,
  utf8,
  fromUtf8,
  concatBytes,
  bytesEqual,
} from "../vendor/orp/core/encoding.js";

// ---- core: ICE filtering controls (control b) -------------------------------
export {
  filterCandidates,
  filterSdp,
  assertNoUnobfuscatedHost,
  parseCandidate,
} from "../vendor/orp/core/ice.js";

// ---- client: the two-stage match driver -------------------------------------
export { Client } from "../vendor/orp/client/client.js";
export type {
  ClientOptions,
  ConnectedInfo,
} from "../vendor/orp/client/client.js";

// ---- client: the ACK/delivery layer -----------------------------------------
export {
  ReliableChannel,
  DeliveryTimeoutError,
} from "../vendor/orp/client/reliablechannel.js";
export type {
  ReliableChannelOptions,
  PendingInfo,
} from "../vendor/orp/client/reliablechannel.js";

// ---- core: identity rotation (ORP-004) --------------------------------------
export {
  makeKeyMigration,
  makeMigrationAck,
  verifyKeyMigration,
  verifyMigrationAck,
  MigrationRegistry,
} from "../vendor/orp/core/migration.js";
export type {
  KeyMigration,
  MigrationAck,
  MigrationVerification,
} from "../vendor/orp/core/migration.js";

// ---- client: inner secure message channel + WebRTC interface ----------------
export { SecureChannel } from "../vendor/orp/client/securechannel.js";
export type {
  WebRTCEndpoint,
  WebRTCFactory,
  LocalDescription,
  IceTransportPolicy,
  MockProfile,
} from "../vendor/orp/client/webrtc.js";
// MockWebRTC + MockNetwork are the reference's in-memory transport. They ship in
// the public surface so app/integration tests (and the shipped tests below) can
// exercise the full match + ReliableChannel flow without a real RTCPeerConnection.
export {
  MockWebRTC,
  MockNetwork,
  DEFAULT_PROFILE,
} from "../vendor/orp/client/webrtc.js";
