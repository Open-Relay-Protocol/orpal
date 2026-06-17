# Orpal — web (PWA) client

A cross-platform messaging & file-transfer app built on the
[Open Relay Protocol (ORP)](../blind-rendezvous). This repo holds the **shared
core** and a **web (PWA) shell** that runs on **Chromium (desktop) and Android** —
one copy of the UI, installable straight from the browser. The core is deliberately
framework- and runtime-agnostic, so a native **Capacitor/Android** shell can wrap
the same build later (see [Android](#android-native-shell-next)).

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
├─ packages/orpal-core/      # framework-agnostic TS: no UI, no browser/Capacitor imports
│  ├─ src/orp.ts             #   the ONE seam re-exporting the ORP reference
│  ├─ src/broker/            #   BrowserRendezvousBroker (native WebSocket)
│  ├─ src/rtc/               #   BrowserWebRTCEndpoint (native RTCPeerConnection)
│  ├─ src/identity/          #   IdentityManager + SecureKeyStore abstraction
│  ├─ src/contacts/          #   contact cards (QR/paste) + binding validation
│  ├─ src/persistence/       #   ConversationStore abstraction
│  ├─ src/transfer/          #   chunking / reassembly / hashing / backpressure
│  ├─ src/messaging/         #   OrpalClient orchestrator + app frames
│  └─ test/                  #   round-trip, file-transfer, delivery-failure, …
└─ apps/web/                 # Web (PWA) shell — Chromium + Android, installable
   ├─ src/
   │  ├─ components/         #   React UI (conversation, sidebar, modals, QR)
   │  ├─ state/             #   orpal-context: app state over orpal-core
   │  ├─ shared/ipc.ts      #   the `window.orpal` contract the UI is written against
   │  └─ orpal/             #   browser bridge: IndexedDB keys+history, file I/O
   └─ public/               #   manifest + service worker + icons (installable)
```

The web shell **owns the React UI** and backs the `window.orpal` contract with
browser primitives. The UI is written only against that typed contract
(`apps/web/src/shared/ipc.ts`); the browser bridge
(`apps/web/src/orpal/browser-bridge.ts`) implements it with **IndexedDB** for keys
+ history, the **File System Access** picker / in-memory download for transfers,
and `navigator.clipboard`. A future Capacitor/Android shell wraps this same build
and backs the *same contract* with native plugins — that's the "swap the storage,
keep the UI" plan the core was designed for.

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
  private keys live in the browser's **IndexedDB** (origin-scoped; see the security
  note). Identity is rendered as a **QR code**; contacts import by **scanning**
  (webcam + jsQR) or **pasting**, with full binding validation (anti-substitution).
- **Messaging** — contact list, 1:1 conversations, send/receive over
  `ReliableChannel`, per-message delivery state (sending → **delivered** via the
  §11 one-time-key ACK, or **failed/retry** on `DeliveryTimeoutError`). History is
  persisted locally in the browser (**IndexedDB**).
- **File transfer** over the message layer — chunked, header-framed (id, name,
  size, mime, chunk index/total, per-file SHA-256), ACK-gated **backpressure**
  with a sliding window, app-level idempotency (the protocol dedupes/retries
  nothing — §11.4), and **reassembly + integrity verification**. Sending streams
  straight off the source file; an *incoming* file reassembles in memory and is
  then offered as a **download** (the web has no unprompted streaming-to-disk).
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
vendored in `orp-ref/`), so a fresh `git clone` builds anywhere with no sibling
checkout.

```bash
git clone https://github.com/ben-is-jammin/orpal
cd orpal

npm install
npm run dev:web      # http://localhost:5173 (Vite dev server; builds core first)
```

Open the URL in a Chromium browser. To talk between two devices, point two
instances (two machines, two browser profiles, or a phone + a laptop) at the same
board, open **My identity / QR** on one and **Add contact** (scan/paste) on the
other, then message. The app talks to **`wss://board.roshew.com/`** by default — no
local board needed. For two NATed peers to connect you need a STUN server (one is
configured by default); for relay-only contacts add a TURN server in Settings. To
run your own board, set Settings → Board URL to `ws://127.0.0.1:8080/` and run the
ORP reference (`npm run serve:dev` in a clone of github.com/Prograde-Solutions/orp).

### Build & deploy

```bash
npm run build:web    # → apps/web/dist (static; deploy anywhere)
npm run preview:web  # serve the built bundle locally
```

The build uses a relative base, so it works hosted at a domain root or a repo
sub-path (e.g. GitHub Pages `/<repo>/`). Pushes to `master` run
`.github/workflows/deploy-web.yml`, which builds the PWA and publishes it to
**GitHub Pages** (enable once under *Settings → Pages → Source: GitHub Actions*).

### Install it as an app (Chromium & Android)

The web build is an installable **Progressive Web App**, so the same code runs as a
standalone app on desktop **and** Android with nothing to install per-OS:

- **Chromium / Edge (desktop):** use the browser's **Install** action in the
  address bar.
- **Android (Chrome):** open the deployed URL and tap **Install app** / **Add to
  Home screen**.

> **Security note:** browsers have no OS keychain, so the web build keeps private
> keys in **IndexedDB** — origin-scoped and not readable by other sites, but **not**
> hardware/OS-protected. Use the app on a trusted origin (the official deployment or
> one you control). Likewise, an *incoming* file reassembles in memory before being
> offered as a download (there's no unprompted streaming-to-disk on the web);
> sending streams off the source file fine.

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

## Android (native shell, next)

The **PWA already runs on Android today** — install it from Chrome (see
[Install it as an app](#install-it-as-an-app-chromium--android)). It's also the
proof that orpal-core has zero shell-specific imports: the UI talks only to
`window.orpal`, and the web shell backs that contract with browser primitives.

For a fully *native* Android app, a **Capacitor** wrapper reuses this same web
build: keep the React UI + orpal-core, run them in the WebView (whose native
`RTCPeerConnection` + `WebSocket` the `BrowserWebRTCEndpoint` and
`BrowserRendezvousBroker` use as-is), and swap the browser-backed
`SecureKeyStore` / `ConversationStore` / file sinks for Capacitor plugins
(Keychain/Keystore secure storage, Capacitor SQLite, Filesystem) to get OS-grade
key storage and streamed-to-disk transfers.
</content>
