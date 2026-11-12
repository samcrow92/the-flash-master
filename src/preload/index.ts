import { contextBridge, ipcRenderer } from "electron";
import { API_METHODS, type FlashApi, type FlashBridge } from "@shared/api";
import type { AppEvent } from "@shared/types";

const api = Object.fromEntries(
  API_METHODS.map((name) => [name, (...args: unknown[]) => ipcRenderer.invoke(`flash:${name}`, ...args)]),
) as unknown as FlashApi;

const bridge: FlashBridge = {
  api,
  onEvent(cb) {
    const listener = (_e: unknown, ev: AppEvent) => cb(ev);
    ipcRenderer.on("flash:event", listener);
    return () => ipcRenderer.removeListener("flash:event", listener);
  },
};

contextBridge.exposeInMainWorld("flash", bridge);
