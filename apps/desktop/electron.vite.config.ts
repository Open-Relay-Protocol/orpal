import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// The desktop app is CommonJS (no "type":"module"): main/preload are Node CJS so
// `__dirname` works and native better-sqlite3 loads cleanly; the renderer is a
// browser ESM bundle regardless, and can still import the ESM @orpal/core.
const here = __dirname;

// electron-vite splits the build into three: main (Node), preload (isolated
// bridge), and renderer (Chromium, where the UI + orpal-core + native WebRTC
// live). Native/Node deps in main/preload are externalized (not bundled);
// better-sqlite3 in particular must stay external so its .node binary is loaded
// at runtime rather than bundled.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(here, "src/main/index.ts") },
        // Optional native module: kept external so it's require()'d at runtime
        // (and gracefully missing → JSON store fallback) rather than bundled.
        external: ["better-sqlite3"],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(here, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(here, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@": resolve(here, "src/renderer/src"),
        "@shared": resolve(here, "src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(here, "src/renderer/index.html") },
      },
    },
  },
});
