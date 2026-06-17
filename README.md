# Orpal — desktop client

A cross-platform messaging & file-transfer app built on the
[Open Relay Protocol (ORP)](../blind-rendezvous). This repo holds the **shared
core** and the **Electron desktop shell**. The core is deliberately framework- and
runtime-agnostic so a Capacitor mobile shell can reuse it later (see
[Mobile](#mobile-next)).

ORP gives devices a **blind, RAM-only broker** ("the board") that matches two
online devices on their Ed25519 identity keys and relays *sealed* blobs so the two
peers bootstrap a peer-to-peer WebRTC data channel. The board never sees private
keys, message plaintext, or unencrypted SDP/ICE. Orpal builds messaging and file
transfer on top of that — it **reuses** ORP's crypto, matching, sealing, ICE
filtering, the two-stage match `Client`, and the `ReliableChannel` ACK layer
rather than reimplementing any of it.

## Layout

```
client-desktop/
├─ packages/orpal-core/      # framework-agnostic TS: no UI, no Electron/Capacitor
│  ├─ src/orp.ts             #   the ONE seam re-exporting the ORP reference
│  ├─ src/broker/            #   BrowserRendezvousBroker (native WebSocket)
│  ├─ src/rtc/               #   BrowserWebRTCEndpoint (native RTCPeerConnection)
│  ├─ src/identity/          #   IdentityManager + SecureKeyStore abstraction
│  ├─ src/contacts/          #   contact cards (QR/paste) + binding validation
│  ├─ src/persistence/       #   ConversationStore abstraction
│  ├─ src/transfer/          #   chunking / reassembly / hashing / backpressure
│  ├─ src/messaging/         #   OrpalClient orchestrator + app frames
│  └─ test/                  #   round-trip, file-transfer, delivery-failure, …
└─ apps/desktop/             # Electron shell (electron-vite + electron-builder)
   └─ src/
      ├─ main/               #   safeStorage keys, SQLite history, file I/O, IPC
      ├─ preload/            #   typed contextBridge → window.orpal
      ├─ shared/             #   the IPC contract (types + channels)
      └─ renderer/           #   React UI + orpal-core + native WebRTC/WebSocket
```

### How the ORP reference is consumed

The reference is a sibling repo (`../blind-rendezvous`). orpal-core **vendor-compiles**
its `core/` plus the four `client/` files Orpal builds on (`Client`,
`ReliableChannel`, `SecureChannel`, the WebRTC interface + `MockWebRTC`) into a
local `vendor/orp/` via `tsconfig.orp.json`. The AGPL `board/`, the Node-only `ws`
broker, and the `werift` adapter are **never** vendored, so none of them can reach
the shipped client. `@noble` crypto is reused transitively — no second crypto stack.

## What's implemented

- **Browser/WebView `WebRTCEndpoint`** over the native `RTCPeerConnection`
  (`BrowserWebRTCEndpoint`) — the third implementation alongside the reference's
  `MockWebRTC` and werift. Supports STUN/TURN and **relay-only** mode (SPEC §6),
  and surfaces connection-state changes for offline detection.
- **Browser-native WebSocket `RendezvousBroker`** (`BrowserRendezvousBroker`) that
  (de)serializes the SPEC §4.4 Inbound/Outbound envelope with reconnect/backoff.
- **Identity management** — generate or load the two keypairs via `DeviceIdentity`;
  private keys live **only** in OS-native secure storage (Electron `safeStorage`).
  Identity is rendered as a **QR code**; contacts import by **scanning** (webcam +
  jsQR) or **pasting**, with full binding validation (anti-substitution).
- **Messaging** — contact list, 1:1 conversations, send/receive over
  `ReliableChannel`, per-message delivery state (sending → **delivered** via the
  §11 one-time-key ACK, or **failed/retry** on `DeliveryTimeoutError`). History is
  persisted locally (SQLite when available, JSON file fallback).
- **File transfer** over the message layer — chunked, header-framed (id, name,
  size, mime, chunk index/total, per-file SHA-256), ACK-gated **backpressure**
  with a sliding window, app-level idempotency (the protocol dedupes/retries
  nothing — §11.4), **reassembly + integrity verification**, and large files
  **streamed to disk** (never buffered whole in the renderer).
- **Offline / no-store-and-forward UX** — a contact shows offline when a match
  can't be made; undeliverable messages are marked failed; rendezvous is
  re-initiated on broker reconnect.
- **Relay-only toggle** per contact (SPEC §6), requiring a configured TURN server.

### Security constraints honored

Transport keys / IPs / SDP / targets never appear in presence or intent (enforced
by the reference's schemas). `verifyBinding()` runs before sealing; ICE filtering +
`assertNoUnobfuscatedHost` run before sealing; client-side anti-redirection (only
proceed with a match whose `counterparty_key` matches an intent we sent). The board
is treated as fully untrusted. All of this lives in the reference `Client`, which
Orpal drives **unmodified**.

## Run it

Prerequisites: Node ≥ 20. The repo is self-contained (the Apache ORP source is
vendored in `orp-ref/`), so a fresh `git clone` builds on macOS, Linux, or Windows
with no sibling checkout.

```bash
git clone https://github.com/ben-is-jammin/orpal
cd orpal

npm install          # 471+ deps incl. Electron; better-sqlite3 is optional
npm run build:core   # emits packages/orpal-core/dist that the renderer consumes
npm run dev:desktop  # launch the Electron app (dev)
```

The app talks to **`wss://board.roshew.com/`** by default — no local board needed.
Point two app instances (two machines, or two OS user accounts) at the same board,
open **My identity / QR** on one and **Add contact** (scan/paste) on the other, then
message. For two NATed peers to connect you need a STUN server (one is configured by
default); for relay-only contacts add a TURN server in Settings. To run your own
board instead, set Settings → Board URL to `ws://127.0.0.1:8080/` and run the ORP
reference (`npm run serve:dev` in a clone of github.com/Prograde-Solutions/orp).

### Install on Ubuntu / Linux

electron-builder does **not** cross-compile Linux from macOS, so there are two
ways to get an installable package:

**Option A — download a prebuilt installer from CI (no build needed).**
Pushes to `master` run `.github/workflows/build-linux.yml` on `ubuntu-latest`,
which produces an **AppImage** and a **.deb** and uploads them as a workflow
artifact (`orpal-linux`). On your Ubuntu box:

```bash
# AppImage (portable; needs FUSE):
sudo apt install -y libfuse2
chmod +x Orpal-*.AppImage
./Orpal-*.AppImage

# or the .deb:
sudo apt install ./orpal_*_amd64.deb     # installs "Orpal" to your apps menu
```

Tag a release (`git tag v0.1.0 && git push --tags`) to also attach the installers
to a GitHub Release.

**Option B — build it yourself on the Ubuntu machine:**

```bash
git clone https://github.com/ben-is-jammin/orpal && cd orpal
npm install
npm run build:core
npm run dist:desktop          # → apps/desktop/release/*.AppImage and *.deb
```

`npm run dist:desktop` builds + runs electron-builder for the **host OS**, so it
also produces dmg/zip on macOS and an NSIS installer on Windows.

History uses **better-sqlite3** when it builds for the target ABI (it does on a
normal Ubuntu Node toolchain) and transparently falls back to a JSON file store
otherwise — so packaging never fails on the native module.

### SQLite note

History uses **better-sqlite3** when it builds for your Node/Electron ABI, and
transparently falls back to a JSON file store otherwise (it's an *optional*
dependency, so install never fails). To force the native build for Electron:
`npm run rebuild --workspace @orpal/desktop`.

## Tests

```bash
npm test                     # orpal-core unit suites
```

Covers the required areas and more:

- **`round-trip`** — a text message round-trips with a working ACK between two
  clients (the "Start by" milestone), via `MockWebRTC` + an in-memory mock board.
- **`file-transfer`** — chunking/reassembly byte-for-byte, out-of-order + duplicate
  idempotency, SHA-256 integrity (incl. tamper detection), zero-byte files, and a
  full end-to-end transfer between two `OrpalClient`s.
- **`delivery-failure`** — offline contact → failed; ACK timeout →
  `DeliveryTimeoutError` → failed; retry-after-reachable succeeds.
- **`integration-board`** *(opt-in)* — the same round-trip through the **real**
  reference board over real WebSockets. Run with a board up:
  `ORP_BOARD_URL=ws://127.0.0.1:8080/ npx vitest run test/integration-board.test.ts`
  (from `packages/orpal-core`). Skipped by default.

## Mobile (next)

orpal-core has zero Electron imports, so the Capacitor shell reuses it directly:
swap the IPC-backed `SecureKeyStore`/`ConversationStore`/file sinks for Capacitor
plugins (Keychain/Keystore secure storage, Capacitor SQLite, Filesystem), keep the
same React UI, and use the WebView's native `RTCPeerConnection` + `WebSocket` — the
`BrowserWebRTCEndpoint` and `BrowserRendezvousBroker` work as-is in a WebView.
```
