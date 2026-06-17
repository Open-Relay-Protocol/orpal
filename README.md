<div align="center">

# Orpal

**A cross-platform, end-to-end-encrypted messaging & file-transfer app built on the Open Relay Protocol (ORP).**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-43853d.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platforms](https://img.shields.io/badge/platforms-web%20(PWA)%20%7C%20Android-informational.svg)](#platforms)
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

The same codebase ships two ways from one shared, framework-agnostic core:

- 🌐 **Web** — an installable Progressive Web App that runs in any modern Chromium
  browser, on desktop **and** Android.
- 📱 **Android** — a native **Capacitor** app that bundles the same web renderer
  into an installable APK (or just install the PWA from any mobile browser).

## Table of contents

- [Features](#features)
- [Platforms](#platforms)
- [Quick start](#quick-start)
  - [Web app (PWA)](#web-app-pwa)
  - [Android (native APK)](#android-native-apk)
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
  private keys live in the browser's **IndexedDB** (origin-scoped; see the
  [security caveat](#security)). Your identity renders as a **QR code**; contacts
  import by **scanning** (webcam + jsQR) or **pasting**, with full binding
  validation (anti-substitution).
- **Reliable messaging** — contact list, 1:1 conversations, and per-message
  delivery state (sending → **delivered** via the §11 one-time-key ACK, or
  **failed/retry** on `DeliveryTimeoutError`). History is persisted locally in the
  browser (**IndexedDB**).
- **File transfer** — chunked, header-framed (id, name, size, mime, chunk
  index/total, per-file SHA-256), ACK-gated **backpressure** with a sliding window,
  app-level idempotency, and **reassembly + integrity verification**. Sending
  streams straight off the source file; an incoming file reassembles in memory and
  is then offered as a **download** (the web has no unprompted streaming-to-disk).
- **Honest offline UX** — no store-and-forward: a contact shows offline when a
  match can't be made, undeliverable messages are marked failed, and rendezvous is
  re-initiated automatically on broker reconnect.

## Platforms

Both shells run the **same** React UI + orpal-core and back the same typed
`window.orpal` contract with browser primitives:

| Capability      | Web (PWA) & native Android                  |
| --------------- | ------------------------------------------- |
| Private keys    | IndexedDB *(origin-scoped, not OS-grade)*   |
| History         | IndexedDB                                   |
| Send a file     | file picker, read via `Blob.slice`          |
| Receive a file  | reassembled in memory, then **downloaded**  |
| Clipboard       | `navigator.clipboard`                       |
| Contact card    | QR / copy                                   |

The **native Android app** (`apps/android`) is a Capacitor wrapper around the
**web build**: it reuses the browser `window.orpal` inside a WebView, so its storage
characteristics match the web shell today (IndexedDB keys/history); see the
[roadmap](#roadmap) for moving it onto OS-grade Keystore/SQLite plugins.

The web shell **owns the React UI** and is the single copy both targets share. The
only thing that varies per shell is the `window.orpal` implementation — the web
build backs the typed contract with browser primitives (IndexedDB, File System
Access, `navigator.clipboard`), and Android reuses that same bridge inside the
WebView.

## Quick start

**Prerequisites:** [Node.js](https://nodejs.org) **≥ 20**. The repo is
self-contained — the Apache-2.0 ORP source is vendored in `orp-ref/`, so a fresh
`git clone` builds on macOS, Linux, or Windows with no sibling checkout.

```bash
git clone https://github.com/ben-is-jammin/orpal
cd orpal
npm install          # installs all workspace deps (no native modules)
npm run build:core   # emits packages/orpal-core/dist that the renderer consumes
```

### Web app (PWA)

The app runs in any modern Chromium browser as an installable Progressive Web App,
so it works across desktop **and** Android with nothing to install per-OS.

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

## Usage

By default the app talks to **`wss://board.roshew.com/`**, so no local board is
needed. To connect two peers:

1. Point two app instances (two machines, two browser profiles, or a phone + a
   laptop) at the same board.
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
runtime-agnostic — no UI, no shell-specific (browser or Capacitor) imports — so
every shell can reuse it. Each shell only provides a `window.orpal` implementation
of the same typed contract.

### Repository layout

```
orpal/
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
├─ apps/web/                 # Web (PWA) shell — React UI + browser window.orpal
│  ├─ src/components/        #   React UI (conversation, sidebar, modals, QR)
│  ├─ src/state/             #   orpal-context: app state over orpal-core
│  ├─ src/shared/ipc.ts      #   the window.orpal contract the UI is written against
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

> **Key-storage caveat:** browsers (and the Android WebView) have no OS keychain, so
> the app keeps private keys in IndexedDB — origin-scoped and not readable by other
> sites, but **not** hardware/OS-protected. Use Orpal on a trusted origin (the
> official deployment or one you control). Moving Android onto the OS **Keystore**
> for hardware-grade key protection is on the [roadmap](#roadmap).

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
alongside the **PWA**, which installs from any modern browser on desktop or Android.
Both reuse the renderer verbatim and only swap `window.orpal`.

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
</content>
