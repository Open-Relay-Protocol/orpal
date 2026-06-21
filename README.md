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
  private keys are sealed to the device's **secure hardware** when available
  (Secure Enclave / Android Keystore-StrongBox / Windows TPM, reached via a
  WebAuthn platform authenticator), falling back to origin-scoped **IndexedDB**
  where it isn't (ORPAL-007; see the [security caveat](#security)). Your identity
  renders as a **QR code**; contacts
  import by **scanning** (webcam + jsQR) or **pasting**, with full binding
  validation (anti-substitution).
- **Contact requests & blocking** — when an **unknown sender** (someone who has
  your card but isn't in your contacts) messages you, the peers exchange cards
  **in-band** over the already-encrypted channel (a `hello` frame carrying the
  signed binding, bound to the connection's authenticated identity so a peer can
  only present its *own* card). You're prompted to **accept** them — naming them
  and adding a full two-way contact you can reply to — or **block** them. Blocked
  identities are **refused at the protocol level** (their inbound connection is
  torn down, no message/file/card gets through) and hidden from the conversation
  list; manage the block list in **Settings**.
- **Per-contact board routing** — each contact can carry its own **board routes**
  (preferred + fallback). When set, delivery to that contact uses *only* those
  boards instead of fanning an intent out to every board; unset contacts keep the
  global all-boards behavior. Choose a contact's boards from the conversation header.
- **Reliable messaging** — contact list, 1:1 conversations, and a full per-message
  delivery lifecycle: **queued** (durable offline send-queue) → **sending** →
  **delivered** (the §11 one-time-key ACK reached the peer's channel) →
  **acknowledged** (the recipient's app stored it) → **failed/retry**. Retries are
  idempotent (globally-unique message ids; a re-delivered message is stored once
  and re-acknowledged). History is persisted locally in the browser (**IndexedDB**).
- **Recipient-sealed messages** — every outbound text and file-offer is sealed to
  the contact's **pinned** X25519 transport key (from their out-of-band-verified
  card) with ORP's anonymous sealed box *before* it crosses the (already encrypted)
  channel. A wrong-key / fake-peer connection can never read the payload, and a
  message that fails to decrypt is dropped without being displayed or acknowledged.
- **Offline send queue** — messages to an offline contact are persisted to a
  durable local **pending queue** (IndexedDB) and retried until the recipient
  confirms receipt with an app-level **acknowledgement** (`awk`) frame. Delivery
  prefers **presence** (deliver the instant the contact reconnects) and falls back
  to **blind retry** (exponential backoff with jitter); the queue survives reloads
  and restarts, and a delivered message is removed once its `awk` arrives. Local
  metrics (pending count + oldest-pending timestamp) aid debugging.
- **File transfer** — chunked, header-framed (id, name, size, mime, chunk
  index/total, per-file SHA-256), ACK-gated **backpressure** with a sliding window,
  app-level idempotency, and **reassembly + integrity verification**. Sending
  streams straight off the source file; an incoming file reassembles in memory and
  is then offered as a **download** (the web has no unprompted streaming-to-disk).
- **Honest offline UX** — the relay still has no store-and-forward: a contact
  shows offline when a match can't be made, and rendezvous is re-initiated
  automatically on broker reconnect. Outbound messages aren't lost, though — they
  sit in the client-side **offline send queue** above and deliver once the contact
  returns (the board never holds them).
- **Full encrypted device backup & restore** — export your **entire** Orpal state —
  identity private keys, every contact, full message history, the pending queue,
  settings (incl. TURN credentials), any in-flight key migration, and the block
  list — into a single **password-sealed** file (`PBKDF2(600k)` + **AES-256-GCM**),
  then import it on a new device or after a wipe (ORPAL-017). Because it's
  password-based (not hardware-sealed), the file is **portable across platforms** —
  a web export imports on Android/iOS and back. Import shows a summary first and
  offers **merge** (add what's missing) or **replace** (wipe then restore); the
  identity import is effectively a key migration to the new device. The file carries
  the **private key in cleartext inside the encrypted envelope**, so the password is
  its only protection — Orpal enforces a minimum length and warns clearly. Manage it
  in **Settings**.

## Platforms

Both shells run the **same** React UI + orpal-core and back the same typed
`window.orpal` contract with browser primitives:

| Capability      | Web (PWA) & native Android                  |
| --------------- | ------------------------------------------- |
| Private keys    | secure hardware when present (Secure Enclave / Keystore-StrongBox / TPM via WebAuthn), else IndexedDB |
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

> On Android, private keys are sealed to the OS **Keystore/StrongBox** when the
> WebView exposes a WebAuthn platform authenticator (ORPAL-007), and otherwise fall
> back to the WebView's IndexedDB (origin-scoped, like the PWA). History still lives
> in IndexedDB; see the [roadmap](#roadmap) for moving it onto a Capacitor SQLite
> plugin.

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
- **App-layer recipient-sealing:** on top of the encrypted channel, Orpal seals
  every user payload to the contact's **pinned** transport key (from their verified
  card) with the reference's anonymous sealed box. This binds each message to the
  out-of-band-verified identity, so even a connection made to a substituted/fake
  transport key cannot read the contents — and an undecryptable message is dropped,
  never displayed or acknowledged.
- The board is treated as fully untrusted. All of this lives in the reference
  `Client`, which Orpal drives **unmodified**.

> **Key-storage caveat:** browsers have no direct OS-keychain API, but they do
> reach the same secure hardware through a **WebAuthn platform authenticator**.
> When one is present (Apple Secure Enclave, Android Keystore/StrongBox, or a
> Windows TPM via Windows Hello), Orpal derives a wrapping key *inside* that secure
> element using the WebAuthn **PRF** extension and seals the private keys with it
> before they touch IndexedDB — so the at-rest copy is hardware-bound ciphertext
> (ORPAL-007). Where no such authenticator exists, it falls back to keeping the
> keys in IndexedDB — origin-scoped and not readable by other sites, but **not**
> hardware-protected — so use Orpal on a trusted origin (the official deployment or
> one you control) in that case.

> **Backup-file caveat (ORPAL-017):** a full device backup must be importable on a
> *different* device that doesn't share the original's secure element, so it can't be
> hardware-sealed — it's encrypted with a key derived from your **password**
> (PBKDF2-HMAC-SHA256, 600k iterations, then AES-256-GCM). The identity **private
> key travels in cleartext *inside* that encrypted envelope**, so the password is the
> *only* thing protecting it: a weak or reused password on a leaked backup file means
> a compromised identity. Treat the file as sensitive as the private key itself, use
> a strong unique password (Orpal enforces a minimum length), and note that importing
> a backup onto a second device puts the **same identity on two devices** — fine for
> migration, but not how you add a new contact.

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
- **`offline-queue`** — the offline send queue: a message to an offline contact is
  persisted (not failed), retried with exponential backoff, delivered on presence,
  and removed from the queue once its `awk` arrives; it also survives a simulated
  reload (a restarted client resumes and delivers), plus unit checks on the
  delivery worker's backoff schedule and the pending-queue metrics.
- **`sealed-messages`** — recipient-sealing: a text/file-offer round-trips through
  the right transport key, the plaintext never appears on the wire, a wrong key /
  tampered box / unknown alg cannot be opened, and a send with no pinned key fails
  closed (it is never sent unsealed).
- **`duplicate-suppression`** — a re-delivered message id is stored exactly once
  yet re-acknowledged, message ids are globally unique, and retries update the
  existing history row in place rather than appending a duplicate.
- **`device-backup`** — the full encrypted backup (ORPAL-017): a payload seals and
  re-opens with the right password, a wrong password / tampered ciphertext fails the
  AES-GCM auth check, no plaintext secret leaks into the envelope, and an
  `OrpalClient` round-trips its entire state onto a fresh device — covering
  **merge** vs **replace**, the identity-conflict warning, and an in-flight
  migration's pending keys surviving the trip.
- **`per-contact-boards`** — a contact's configured board routes are honored:
  delivery uses only those boards (a contact pinned to the wrong board is
  unreachable even if it's online elsewhere), `setContactBoards` reroutes live, and
  an unconfigured contact still fans out to all boards.
- **`integration-board`** *(opt-in)* — the same round-trip through the **real**
  reference board over real WebSockets. Run with a board up:
  `ORP_BOARD_URL=ws://127.0.0.1:8080/ npx vitest run test/integration-board.test.ts`
  (from `packages/orpal-core`). Skipped by default.

## Roadmap

The **native Android shell ships today** (`apps/android`) — a Capacitor wrapper that
bundles the web renderer into an installable APK (see [Android](#android-native-apk)),
alongside the **PWA**, which installs from any modern browser on desktop or Android.
Both reuse the renderer verbatim and only swap `window.orpal`.

The Android shell currently reuses the **browser** `window.orpal` (IndexedDB
history, in-memory file handling) as-is in the WebView; private keys are already
sealed to secure hardware via WebAuthn when the device supports it (ORPAL-007). The
next steps harden the rest into a first-class native app: swap the browser-backed
`ConversationStore`/file sinks for Capacitor plugins (Capacitor SQLite, Filesystem)
for streamed-to-disk transfers, optionally add a native Keystore-plugin
`HardwareKeyProvider` as a non-WebAuthn fallback, wire the
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
