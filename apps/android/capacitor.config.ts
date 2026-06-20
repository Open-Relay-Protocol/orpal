import type { CapacitorConfig } from "@capacitor/cli";

// The Android shell deliberately reuses the *web* build verbatim: `npm run
// build:web` emits apps/web/dist (the same React UI + orpal-core the PWA shell
// runs), and Capacitor bundles that directory into the APK so the app is fully
// self-contained -- no dev server, no remote URL. orpal-core stays
// untouched; the WebView's native RTCPeerConnection + WebSocket back the same
// BrowserWebRTCEndpoint / BrowserRendezvousBroker the PWA already uses.
const config: CapacitorConfig = {
  appId: "com.prograde.orpal",
  appName: "Orpal",
  // Resolved relative to this file: apps/android/../web/dist -> apps/web/dist.
  webDir: "../web/dist",
  android: {
    // Orpal only talks to the board over wss:// (TLS) and connects to peers over
    // (D)TLS-secured WebRTC, so no cleartext HTTP is needed -- keep the secure
    // default and don't relax the network security config.
    allowMixedContent: false,
  },
};

export default config;
