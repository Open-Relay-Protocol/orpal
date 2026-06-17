// Web (PWA) entry point. Mirrors the desktop renderer's main.tsx, but installs
// the BROWSER `window.orpal` bridge (IndexedDB / File System Access / clipboard)
// before the React app mounts, instead of relying on the Electron preload. The
// React UI and orpal-core are imported verbatim from the desktop renderer via the
// `@` alias — there is a single copy of the UI shared by both shells.
import "@/polyfills.js"; // MUST be first: installs Buffer for orpal-core's encoding helpers
import { createRoot } from "react-dom/client";
import { App } from "@/components/App.js";
import "@/styles.css";
import { installBrowserBridge } from "./orpal/browser-bridge.js";

installBrowserBridge();

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
