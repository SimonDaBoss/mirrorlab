import { contextBridge, ipcRenderer, webUtils } from "electron";

const ALLOWED_EVENTS = new Set([
  "ios:usbError",
  "mirror:video",
  "mirror:audio",
  "mirror:info",
  "mirror:closed",
  "mirror:error",
  "mirror:notice",
  "mirror:capture",
  "mirror:indicate",
  "mirror:logcat",
  "mirror:timeline",
]);

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (!ALLOWED_EVENTS.has(channel)) throw new Error(`Channel not allowed: ${channel}`);
    const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.off(channel, listener);
  },
  control: (bytes: Uint8Array) => ipcRenderer.send("mirror:control", bytes),
  captured: (id: number, png: Uint8Array) => ipcRenderer.send("mirror:captured", id, png),
  userEvent: (kind: string, detail: string) => ipcRenderer.send("mirror:userEvent", kind, detail),
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("mirrorlab", api);
export type MirrorlabApi = typeof api;
