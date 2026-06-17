// Preload bridge. Runs in an isolated, sandboxed context and exposes ONLY the
// typed `window.orpal` surface to the renderer via contextBridge — never raw
// ipcRenderer, never any Node API. Every method is a thin invoke() over a named
// channel from the shared contract.

import { contextBridge, ipcRenderer } from "electron";
import { CH, type OrpalBridge } from "../shared/ipc.js";

const api: OrpalBridge = {
  keys: {
    load: () => ipcRenderer.invoke(CH.keysLoad),
    save: (k) => ipcRenderer.invoke(CH.keysSave, k),
    clear: () => ipcRenderer.invoke(CH.keysClear),
  },
  store: {
    init: () => ipcRenderer.invoke(CH.storeInit),
    upsertContact: (c) => ipcRenderer.invoke(CH.storeUpsertContact, c),
    listContacts: () => ipcRenderer.invoke(CH.storeListContacts),
    getContact: (k) => ipcRenderer.invoke(CH.storeGetContact, k),
    removeContact: (k) => ipcRenderer.invoke(CH.storeRemoveContact, k),
    appendMessage: (m) => ipcRenderer.invoke(CH.storeAppendMessage, m),
    updateMessage: (id, patch) => ipcRenderer.invoke(CH.storeUpdateMessage, { id, patch }),
    listMessages: (contactKey, opts) =>
      ipcRenderer.invoke(CH.storeListMessages, { contactKey, opts }),
  },
  files: {
    pickForSend: () => ipcRenderer.invoke(CH.filePickForSend),
    openRead: (path) => ipcRenderer.invoke(CH.fileOpenRead, path),
    readChunk: (handleId, offset, length) =>
      ipcRenderer.invoke(CH.fileReadChunk, { handleId, offset, length }),
    hash: (handleId) => ipcRenderer.invoke(CH.fileHash, handleId),
    closeRead: (handleId) => ipcRenderer.invoke(CH.fileCloseRead, handleId),
    openWrite: (name) => ipcRenderer.invoke(CH.fileOpenWrite, name),
    writeChunk: (handleId, offset, data) =>
      ipcRenderer.invoke(CH.fileWriteChunk, { handleId, offset, data }),
    finalizeWrite: (handleId) => ipcRenderer.invoke(CH.fileFinalizeWrite, handleId),
    abortWrite: (handleId) => ipcRenderer.invoke(CH.fileAbortWrite, handleId),
    reveal: (path) => ipcRenderer.invoke(CH.fileReveal, path),
  },
  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (s) => ipcRenderer.invoke(CH.settingsSet, s),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(CH.clipboardWrite, text),
    readText: () => ipcRenderer.invoke(CH.clipboardRead),
  },
  input: {
    autoType: (text) => ipcRenderer.invoke(CH.inputAutoType, text),
  },
};

contextBridge.exposeInMainWorld("orpal", api);
