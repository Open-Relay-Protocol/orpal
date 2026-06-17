import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment: the required test suites (chunking/reassembly,
    // delivery-failure, message round-trip) run against MockWebRTC + an
    // in-memory mock board, so no DOM / real RTCPeerConnection is needed.
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
