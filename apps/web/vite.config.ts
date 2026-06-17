import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web shell reuses the desktop renderer's React UI verbatim (no Electron in
// it — see apps/desktop/src/renderer) and swaps the IPC `window.orpal` bridge for
// a browser one (src/orpal/browser-bridge.ts). Aliases point the reused renderer
// sources and their `@`/`@shared` imports at the desktop tree so there's a single
// copy of the UI; only the bridge differs between shells.
const here = __dirname;
const rendererSrc = resolve(here, "../desktop/src/renderer/src");
const sharedSrc = resolve(here, "../desktop/src/shared");

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
