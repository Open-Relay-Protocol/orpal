import "./polyfills.js"; // MUST be first: installs Buffer for orpal-core's encoding helpers
import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
