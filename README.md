<div align="center">

# Orpal

**A cross-platform, end-to-end-encrypted messaging & file-transfer app built on the Open Relay Protocol (ORP).**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-43853d.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-desktop%20%7C%20web%20(PWA)%20%7C%20mobile-informational.svg)](#platforms)
[![Built on ORP](https://img.shields.io/badge/built%20on-ORP-6f42c1.svg)](https://github.com/Prograde-Solutions/orp)

[Features](#features) · [Quick start](#quick-start) · [Architecture](#architecture) · [Security](#security) · [Contributing](#contributing)

</div>

---

Orpal is a peer-to-peer messenger that connects two devices **directly** over an
encrypted WebRTC data channel — the relay server never sees your private keys,
your message plaintext, or unencrypted connection data.

It is built on the [Open Relay Protocol (ORP)](https://github.com/Prograde-Solutions/orp),
which provides a **blind, RAM-only broker** ("the board") that matches two online
devices by their Ed25519 identity keys and relays *sealed* blobs so the peers can
bootstrap a direct connection. Orpal layers messaging and file transfer on top of
that, **reusing** ORP's crypto, matching, sealing, ICE filtering, the two-stage
match `Client`, and the `ReliableChannel` ACK layer rather than reimplementing any
of it.

The same codebase ships three ways from one shared, framework-agnostic core:

- 🖥️ **Desktop** — an Electron app with OS-keychain key storage and SQLite history.
- 🌐 **Web** — an installable Progressive Web App that runs in any modern browser.
- 📱 **Mobile** — a native **Android** app (Capacitor) that bundles the web
  renderer into an installable APK, or install the PWA from any mobile browser.

## Table of contents

- [Features](#features)
- [Platforms](#platforms)
- [Quick start](#quick-start)
  - [Desktop (Electron)](#desktop-electron)
  - [Web app (PWA)](#web-app-pwa)
  - [Android (native APK)](#android-native-apk)
  - [Install on Linux](#install-on-linux)
- [Usage](#usage)
- [Architecture](#architecture)
  - [Repository layout](#repository-layout)
  - [How the ORP reference is consumed](#how-the-orp-reference-is-consumed)
- [Security](#security)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## Features

- **Direct peer-to-peer transport** — a browser/WebView `WebRTCEndpoint`
  (`BrowserWebRTCEndpoint`) over native `RTCPeerConnection`, with STUN/TURN support
  and **relay-only** mode (SPEC §6), surfacing connection-state changes for offline
  detection.
- **Blind rendezvous** — a native-WebSocket `RendezvousBroker`
  (`BrowserRendezvousBroker`) that (de)serializes the SPEC §4.4 envelope with
  automatic reconnect/backoff.
- **Identity & contacts** — generate or load your keypairs via `DeviceIdentity`;
  private keys live **only** in OS-native secure storage (Electron `safeStorage`).
  Your identity renders as a **QR code**; contacts import by **scanning** (webcam +
  jsQR) or **pasting**, with full binding validation (anti-substitution).
- **Reliable messaging** — contact list, 1:1 conversations, and per-message
  delivery state (sending → **delivered** via the §11 one-time-key ACK, or
  **failed/retry** on `DeliveryTimeoutError`). History is persisted locally
  (SQLite when available, JSON file fallback).
- **File transfer** — chunked, header-framed (id, name, size, mime, chunk
  index/total, per-file SHA-256), ACK-gated **backpressure** with a sliding window,
  app-level idempotency, **reassembly + integrity verification**, and large files
  **streamed to disk** (never buffered whole in the renderer).
- **Honest offline UX** — no store-and-forward: a contact shows offline when a
  match can't be made, undeliverable messages are marked failed, and rendezvous is
  re-initiated automatically on broker reconnect.

## Platforms

| Capability      | Desktop (Electron)            | Web (PWA)                                   |
| --------------- | ----------------------------- | ------------------------------------------- |
| Private keys    | OS keychain (`safeStorage`)   | IndexedDB *(origin-scoped, not OS-grade)*   |
| History         | SQLite (main process)         | IndexedDB                                   |
| Send a file     | native open dialog, disk read | file picker, read via `Blob.slice`          |
| Receive a file  | streamed to `~/Downloads`     | reassembled in memory, then **downloaded**  |
| Clipboard       | native clipboard module       | `navigator.clipboard`                       |
| Contact card    | QR / copy / auto-type         | QR / copy *(auto-type is desktop-only)*     |

The **native Android app** (`apps/android`) bundles the **Web (PWA)** column above —
it reuses the browser `window.orpal` inside a Capacitor WebView, so its storage
characteristics match the Web column today (IndexedDB keys/history); see the
[roadmap](#roadmap) for moving it onto OS-grade Keystore/SQLite plugins.

The **web shell reuses the desktop renderer verbatim** (same React UI + orpal-core,
imported via Vite aliases). The only thing that differs between shells is the
`window.orpal` implementation: Electron backs it with privileged main-process
services; the web build backs the *same typed contract* with browser primitives.

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org) **≥ 20**. The repo is
self-contained — the Apache-2.0 ORP source is vendored in `orp-ref/`, so a fresh
`git clone` builds on macOS, Linux, or Windows with no sibling checkout.

```bash
git clone https://github.com/ben-is-jammin/orpal
cd orpal
npm install          # installs all workspace deps; better-sqlite3 is optional
npm run build:core   # emits packages/orpal-core/dist that the renderers consume
```

### Desktop (Electron)

```bash
npm run dev:desktop  # launch the Electron app in dev mode
```

### Web app (PWA)

The same app runs in any modern browser as an installable Progressive Web App, so
it works across desktop **and** mobile with nothing to install per-OS.

```bash
npm run dev:web      # http://localhost:5173 (dev server)
# or a production build:
npm run build:web    # → apps/web/dist (static; deploy anywhere)
npm run preview:web  # serve the built bundle locally
```

Open the dev/deployed URL and, on Chromium/Edge/Android, use the browser's
**Install** action (on iOS Safari: *Share → Add to Home Screen*) to get a
standalone app window with offline support.

**Hosted build:** pushes to `master` run
[`.github/workflows/deploy-web.yml`](.github/workflows/deploy-web.yml), which
builds the PWA and publishes it to **GitHub Pages** (enable once under *Settings →
Pages → Source: GitHub Actions*). The build uses a relative base, so it works at a
domain root or a repo sub-path.

### Android (native APK)

The native Android shell (`apps/android`) is a **Capacitor** wrapper that bundles
the **same web renderer** (React UI + orpal-core) into an installable APK — no dev
server, fully self-contained. The WebView's native `RTCPeerConnection` + `WebSocket`
back the same `BrowserWebRTCEndpoint`/`BrowserRendezvousBroker`, so orpal-core runs
**unmodified**; only the packaging differs from the PWA.

> Private keys on Android currently live in the WebView's IndexedDB (origin-scoped,
> like the PWA) — **not** the OS Keystore yet. See the [roadmap](#roadmap) for
> moving key storage and history onto Capacitor secure-storage plugins.

**Option A — download a prebuilt APK from CI (no Android SDK needed).**
Pushes to `master` run [`.github/workflows/build-android.yml`](.github/workflows/build-android.yml),
which builds a debug APK uploaded as a workflow artifact (`orpal-android`). Download
`Orpal-debug.apk` from the run's **Artifacts**, copy it to your phone, and open it —
Android will prompt you to allow installing from this source (sideloading), then
install **Orpal** to your app drawer. Tag a release (`git tag v0.1.0 && git push
--tags`) to also attach the APK to a GitHub Release.

**Option B — build it yourself** (needs a JDK 21 + the Android SDK, e.g. via Android
Studio):

```bash
git clone https://github.com/ben-is-jammin/orpal && cd orpal
npm install
npm run sync:android          # builds the web bundle and copies it into apps/android
cd apps/android/android
./gradlew assembleDebug       # → app/build/outputs/apk/debug/app-debug.apk
# install onto a connected device/emulator:
adb install app/build/outputs/apk/debug/app-debug.apk
```

`npm run sync:android` runs `build:web` then `npx cap sync android`, so re-run it
whenever the UI/core changes to refresh the assets baked into the APK. To open the
project in Android Studio instead, run `npm run open --workspace orpal-android`.

> **Debug vs. release:** the CI build is a **debug** APK (debug-signed) — fine for
> sideloading and testing. For Play Store distribution, configure a release
> signing config and build `assembleRelease`/`bundleRelease`.

### Install on Linux

electron-builder does **not** cross-compile Linux from macOS, so there are two ways
to get an installable package:

**Option A — download a prebuilt installer from CI (no build needed).**
Pushes to `master` run
[`.github/workflows/build-linux.yml`](.github/workflows/build-linux.yml) on
`ubuntu-latest`, producing an **AppImage** and a **.deb** uploaded as a workflow
artifact (`orpal-linux`). On your Ubuntu box:

```bash
# AppImage (portable; needs FUSE):
sudo apt install -y libfuse2
chmod +x Orpal-*-x64.AppImage
./Orpal-*-x64.AppImage

# or the .deb:
sudo apt install ./Orpal-*-x64.deb       # installs "Orpal" to your apps menu
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

`npm run dist:desktop` builds and runs electron-builder for the **host OS**, so it
also produces dmg/zip on macOS and an NSIS installer on Windows.

> **SQLite note:** history uses **better-sqlite3** when it builds for your
> Node/Electron ABI, and transparently falls back to a JSON file store otherwise
> (it's an *optional* dependency, so install never fails). To force the native
> build for Electron: `npm run rebuild --workspace orpal-desktop`.

## Usage

By default the app talks to **`wss://board.roshew.com/`**, so no local board is
needed. To connect two peers:

1. Point two app instances (two machines, or two OS user accounts) at the same
   board.
2. Open **My identity / QR** on one device.
3. On the other, choose **Add contact** and scan or paste the card.
4. Start messaging.

For two NATed peers to connect you need a STUN server (one is configured by
default); for relay-only contacts, add a TURN server in **Settings**. To run your
own board instead, set **Settings → Board URL** to `ws://127.0.0.1:8080/` and run
the [ORP reference](https://github.com/Prograde-Solutions/orp) (`npm run serve:dev`
in a clone).

## Architecture

The **shared core** (`packages/orpal-core`) is deliberately framework- and
runtime-agnostic — no UI, no Electron, no Capacitor — so every shell can reuse it.
Each shell only provides a `window.orpal` implementation of the same typed contract.

### Repository layout

```
orpal/
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
├─ apps/desktop/             # Electron shell (electron-vite + electron-builder)
│  └─ src/
│     ├─ main/               #   safeStorage keys, SQLite history, file I/O, IPC
│     ├─ preload/            #   typed contextBridge → window.orpal
│     ├─ shared/             #   the IPC contract (types + channels)
│     └─ renderer/           #   React UI + orpal-core + native WebRTC/WebSocket
├─ apps/web/                 # Web (PWA) shell — same renderer, browser window.orpal
│  ├─ src/orpal/             #   browser bridge: IndexedDB keys+history, file I/O
│  └─ public/                #   manifest + service worker + icons (installable)
├─ apps/android/             # Native Android shell — Capacitor wraps apps/web/dist
│  ├─ capacitor.config.ts    #   appId/appName + webDir → ../web/dist
│  └─ android/               #   committed Gradle project (assembleDebug → APK)
└─ orp-ref/                  # vendored Apache-2.0 ORP reference (see NOTICE)
```

### How the ORP reference is consumed

The reference lives upstream at
[github.com/Prograde-Solutions/orp](https://github.com/Prograde-Solutions/orp). Its
Apache-2.0 portions are vendored into `orp-ref/`, and orpal-core
**vendor-compiles** the `core/` plus the four `client/` files Orpal builds on
(`Client`, `ReliableChannel`, `SecureChannel`, the WebRTC interface + `MockWebRTC`)
into a local `vendor/orp/` via `tsconfig.orp.json`. The AGPL `board/`, the Node-only
`ws` broker, and the `werift` adapter are **never** vendored, so none of them can
reach the shipped client. `@noble` crypto is reused transitively — no second crypto
stack.

## Security

Orpal handles private keys and message content, so it is designed to keep the
relay untrusted end-to-end:

- Transport keys / IPs / SDP / targets never appear in presence or intent (enforced
  by the reference's schemas).
- `verifyBinding()` runs before sealing; ICE filtering + `assertNoUnobfuscatedHost`
  run before sealing.
- Client-side anti-redirection: Orpal only proceeds with a match whose
  `counterparty_key` matches an intent it sent.
- The board is treated as fully untrusted. All of this lives in the reference
  `Client`, which Orpal drives **unmodified**.

> **Web key-storage caveat:** browsers have no OS keychain, so the web build keeps
> private keys in IndexedDB — origin-scoped and not readable by other sites, but
> **not** hardware/OS-protected like the desktop app. Use the web build on a trusted
> origin (the official deployment or one you control). For the strongest key
> protection, use the desktop app.

**Reporting a vulnerability:** please do **not** open a public issue for security
problems. Instead, report privately via GitHub's [Security
Advisories](https://github.com/ben-is-jammin/orpal/security/advisories/new), or
email the maintainers. We'll acknowledge receipt and coordinate a fix and
disclosure timeline with you.

## Testing

```bash
npm test                     # orpal-core unit suites
```

The suites cover:

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

## Roadmap

The **native Android shell ships today** (`apps/android`) — a Capacitor wrapper that
bundles the web renderer into an installable APK (see [Android](#android-native-apk)),
alongside the **PWA**, which installs from any mobile browser on Android or iOS. Both
are proof that orpal-core has zero Electron imports: they reuse the renderer verbatim
and only swap `window.orpal`.

The Android shell currently reuses the **browser** `window.orpal` (IndexedDB keys +
history, in-memory file handling) as-is in the WebView. The next steps harden it into
a first-class native app: swap the browser-backed `SecureKeyStore`/`ConversationStore`/
file sinks for Capacitor plugins (Android **Keystore** secure storage, Capacitor
SQLite, Filesystem) for OS-grade key storage and streamed-to-disk transfers, wire the
**camera** permission for in-app QR scanning (the `CAMERA` permission is already
declared; pasting the card is the fallback today), and add an **iOS** target the same
way. The same React UI and the WebView's native `RTCPeerConnection` + `WebSocket`
(`BrowserWebRTCEndpoint`/`BrowserRendezvousBroker`) carry over unchanged.

## Contributing

Contributions are welcome! To get started:

1. **Fork** the repository and create a feature branch
   (`git checkout -b feature/my-change`).
2. Make your changes and add or update tests where appropriate.
3. Run the checks locally:
   ```bash
   npm install
   npm run build:core
   npm run typecheck
   npm test
   ```
4. Commit with a clear, descriptive message and **open a pull request** against
   `master`.

Please keep changes focused and avoid modifying the vendored `orp-ref/` files
directly — those are refreshed from upstream (see `orp-ref/README.md`). By
contributing, you agree that your contributions are licensed under the project's
[Apache-2.0](LICENSE) license.

## License

Orpal is licensed under the **[Apache License 2.0](LICENSE)**. You are free to use,
modify, fork, and redistribute it — including for commercial use — provided you
retain the copyright and license notices (see [`NOTICE`](NOTICE)).

The vendored ORP reference in `orp-ref/` is also Apache-2.0. Note that the upstream
ORP **board/** broker is AGPL-3.0 and is deliberately **not** included in this
repository; see [`NOTICE`](NOTICE) for the full attribution breakdown.

## Acknowledgments

- The [Open Relay Protocol (ORP)](https://github.com/Prograde-Solutions/orp)
  reference implementation, whose crypto, matching, sealing, and ACK layer Orpal
  builds on directly.
- The [@noble](https://github.com/paulmillr/noble-hashes) cryptography libraries
  (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`).
