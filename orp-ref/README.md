# Vendored ORP reference (Apache-2.0)

This directory is a vendored copy of the **Apache-2.0** portions of the Open Relay
Protocol reference implementation — its `core/` and the four `client/` files Orpal
builds on (`client.ts`, `reliablechannel.ts`, `securechannel.ts`, `webrtc.ts`).

Source: <https://github.com/Prograde-Solutions/orp> (commit `1af4c68`,
"feat: delivery acknowledgement (ACK) layer").

It is vendored so this repo clones and builds self-contained on any machine
(no sibling checkout required). Orpal **does not modify** these files; it
vendor-compiles them into `packages/orpal-core/vendor/orp/` (see
`packages/orpal-core/tsconfig.orp.json`) and reuses their crypto, matching,
sealing, ICE filtering, the two-stage match `Client`, and the `ReliableChannel`
ACK layer rather than reimplementing any of it.

Deliberately **NOT** vendored:
- `board/` — the AGPL-3.0 reference broker (must never ship in a client).
- `client/wsbroker.ts` (Node `ws`) and `client/webrtc-real.ts` (werift) — Node-only
  adapters; Orpal ships its own browser/WebView `BrowserRendezvousBroker` and
  `BrowserWebRTCEndpoint` instead.

See `LICENSE` (Apache-2.0) and `NOTICE`. To refresh from upstream, re-copy `core/`
and those four `client/` files and re-run `npm run vendor:orp`.
