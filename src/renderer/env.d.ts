import type { FlashBridge } from "@shared/api";

declare global {
  interface Window {
    flash: FlashBridge;
  }
}
export {};
