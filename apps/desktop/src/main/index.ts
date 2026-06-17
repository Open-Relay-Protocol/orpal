// Electron main process.
//
// Creates the window with the secure renderer posture (contextIsolation:true,
// nodeIntegration:false, sandboxed preload) and registers the typed IPC handlers
// that back the privileged services: OS-keychain key storage, SQLite history, and
// streaming file I/O. The renderer talks to these only through the preload bridge;
// no Node API is ever exposed to it directly.

import { app, BrowserWindow, clipboard, ipcMain, session, systemPreferences } from "electron";
import { join } from "node:path";
import { SecureKeyStoreMain } from "./secure-key-store.js";
import { createConversationStore, type ClosableStore } from "./conversation-store.js";
import { FileService } from "./file-service.js";
import { SettingsStore } from "./settings.js";
import { CH, type DesktopSettings, type MessagePatch } from "../shared/ipc.js";
import type { Contact, StoredKeys, StoredMessage, ListMessagesOptions } from "@orpal/core";

let mainWindow: BrowserWindow | null = null;
let fileService: FileService | null = null;
let store: ClosableStore | null = null;

async function registerIpc(): Promise<void> {
  const userData = app.getPath("userData");
  const keys = new SecureKeyStoreMain(userData);
  store = await createConversationStore(userData);
  fileService = new FileService();
  const settings = new SettingsStore(userData);
  const db = store;
  const files = fileService;

  // --- keys (safeStorage) ---
  ipcMain.handle(CH.keysLoad, () => keys.load());
  ipcMain.handle(CH.keysSave, (_e, k: StoredKeys) => keys.save(k));
  ipcMain.handle(CH.keysClear, () => keys.clear());

  // --- conversation store (SQLite) ---
  ipcMain.handle(CH.storeInit, () => db.init());
  ipcMain.handle(CH.storeUpsertContact, (_e, c: Contact) => db.upsertContact(c));
  ipcMain.handle(CH.storeListContacts, () => db.listContacts());
  ipcMain.handle(CH.storeGetContact, (_e, key: string) => db.getContact(key));
  ipcMain.handle(CH.storeRemoveContact, (_e, key: string) => db.removeContact(key));
  ipcMain.handle(CH.storeAppendMessage, (_e, m: StoredMessage) => db.appendMessage(m));
  ipcMain.handle(CH.storeUpdateMessage, (_e, args: { id: string; patch: MessagePatch }) =>
    db.updateMessage(args.id, args.patch),
  );
  ipcMain.handle(CH.storeListMessages, (_e, args: { contactKey: string; opts?: ListMessagesOptions }) =>
    db.listMessages(args.contactKey, args.opts),
  );

  // --- file service (streaming disk I/O) ---
  ipcMain.handle(CH.filePickForSend, () => files.pickForSend());
  ipcMain.handle(CH.fileOpenRead, (_e, path: string) => files.openRead(path));
  ipcMain.handle(CH.fileReadChunk, (_e, a: { handleId: string; offset: number; length: number }) =>
    files.readChunk(a.handleId, a.offset, a.length),
  );
  ipcMain.handle(CH.fileHash, (_e, handleId: string) => files.hash(handleId));
  ipcMain.handle(CH.fileCloseRead, (_e, handleId: string) => files.closeRead(handleId));
  ipcMain.handle(CH.fileOpenWrite, (_e, name: string) => files.openWrite(name));
  ipcMain.handle(CH.fileWriteChunk, (_e, a: { handleId: string; offset: number; data: Uint8Array }) =>
    files.writeChunk(a.handleId, a.offset, a.data),
  );
  ipcMain.handle(CH.fileFinalizeWrite, (_e, handleId: string) => files.finalizeWrite(handleId));
  ipcMain.handle(CH.fileAbortWrite, (_e, handleId: string) => files.abortWrite(handleId));
  ipcMain.handle(CH.fileReveal, (_e, path: string) => files.reveal(path));

  // --- settings ---
  ipcMain.handle(CH.settingsGet, () => settings.get());
  ipcMain.handle(CH.settingsSet, (_e, s: DesktopSettings) => settings.set(s));

  // --- clipboard (native, cross-OS) ---
  // The sandboxed renderer can't reliably reach the OS clipboard via
  // navigator.clipboard; Electron's module talks to the real backend on every
  // platform. We coerce to string defensively so a bad payload can't throw deep
  // inside the native call.
  ipcMain.handle(CH.clipboardWrite, (_e, text: string) => {
    clipboard.writeText(String(text ?? ""));
  });
  ipcMain.handle(CH.clipboardRead, () => clipboard.readText());

  // --- auto-type (last-resort contact-card transfer) ---
  ipcMain.handle(CH.inputAutoType, (_e, text: string) => autoType(String(text ?? "")));
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Type `text` into the focused field of the main window by synthesizing
 * keystrokes through Electron's input pipeline. This is the last resort for
 * handing over a contact card when QR scanning fails AND the clipboard copy
 * fails: the destination field is focused and the card is typed in character by
 * character.
 *
 * `sendInputEvent` dispatches into this window's renderer, so the keystrokes
 * land in whatever Orpal field currently holds focus. The small per-character
 * delay keeps React's controlled inputs from coalescing/dropping characters
 * when the card (a long JSON string) is typed quickly.
 */
async function autoType(text: string): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) throw new Error("no-window");
  win.focus();
  win.webContents.focus();
  for (const ch of text) {
    if (win.isDestroyed()) return;
    // `char` events carry the literal character in keyCode, so punctuation in
    // the JSON ({ } " : etc.) is typed verbatim without keymap translation.
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    await delay(6);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: "#0b0d12",
    show: false,
    title: "Orpal",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // electron-vite sets ELECTRON_RENDERER_URL in dev (the Vite dev server);
  // production loads the built file.
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function setupMediaPermissions(): void {
  // The renderer's QR scanner uses getUserMedia(camera). Electron denies media by
  // default unless a handler approves it; on macOS we additionally trigger the
  // system camera (TCC) prompt via askForMediaAccess. The packaged app declares
  // NSCameraUsageDescription (electron-builder.yml) so that prompt can appear.
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "media") {
      if (process.platform === "darwin") {
        systemPreferences
          .askForMediaAccess("camera")
          .then((granted) => callback(granted))
          .catch(() => callback(false));
        return;
      }
      callback(true);
      return;
    }
    callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "media");
}

function applyCsp(): void {
  // A strict-ish CSP for the renderer. WebRTC ICE traffic is not governed by CSP;
  // the board connection is a WebSocket, hence ws:/wss: in connect-src.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self';" +
            "script-src 'self' 'unsafe-inline';" +
            "style-src 'self' 'unsafe-inline';" +
            "img-src 'self' data: blob:;" +
            "media-src 'self' blob:;" +
            "connect-src 'self' ws: wss: http: https:;",
        ],
      },
    });
  });
}

app.whenReady().then(async () => {
  applyCsp();
  setupMediaPermissions();
  await registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void fileService?.closeAll();
  store?.close();
});
