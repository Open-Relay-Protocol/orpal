import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web shell owns the React UI (src/components, src/state, …) and backs the
// `window.orpal` contract (src/shared/ipc.ts) with a browser bridge
// (src/orpal/browser-bridge.ts). The `@`/`@shared` aliases below are kept so the
// UI's existing `@/…` and `@shared/…` imports resolve to this app's own sources —
// a future Capacitor/Android shell wraps this same web build.
const here = __dirname;
const rendererSrc = resolve(here, "src");
const sharedSrc = resolve(here, "src/shared");

export default defineConfig({
  root: here,
  // Relative base so the build works whether it's hosted at a domain root or a
  // repo sub-path (e.g. GitHub Pages /<repo>/).
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": rendererSrc,
      "@shared": sharedSrc,
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
