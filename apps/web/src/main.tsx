// Web (PWA) entry point. Installs the browser `window.orpal` bridge (IndexedDB /
// File System Access / clipboard) before the React app mounts, then mounts the
// shared UI. The React UI and orpal-core are imported via the `@` alias (this
// app's own src) -- a future Capacitor/Android shell wraps this same web build.
import "@/polyfills.js"; // MUST be first: installs Buffer for orpal-core's encoding helpers
import { createRoot } from "react-dom/client";
import { App } from "@/components/App.js";
import "@/styles.css";
import { installBrowserBridge } from "./orpal/browser-bridge.js";
import { applySkin, loadSkin } from "./orpal/skins.js";

installBrowserBridge();
// Apply the saved skin (ORPAL-019) before first paint so there's no theme flash.
applySkin(loadSkin());

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);

// Register the service worker for offline support + installability. Best-effort:
// the app works without it (it just won't be installable / offline-capable).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline support unavailable; app still runs online */
    });
  });
}
