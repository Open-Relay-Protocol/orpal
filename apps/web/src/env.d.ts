/// <reference types="vite/client" />
import type { OrpalBridge } from "@shared/ipc";

declare global {
  interface Window {
    orpal: OrpalBridge;
  }
}

export {};
