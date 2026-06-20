/// <reference types="vite/client" />
import type { OrpalBridge } from "@shared/ipc";

interface ImportMetaEnv {
  /** ORPAL-016: VAPID public key of the board's Web Push sender (build-time). */
  readonly VITE_ORP_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    orpal: OrpalBridge;
  }
}

export {};
