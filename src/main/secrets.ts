/**
 * Small secrets (Jazz password, GitHub token) encrypted with the OS keychain (Windows DPAPI) via Electron safeStorage.
 * Uses the async API (Electron ≥ 39) when present — the sync calls are deprecated — and keeps reading secrets
 * written by the older sync API. Values are loaded once at startup and kept in memory.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface SafeStorageLike {
  isEncryptionAvailable?(): boolean;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptString?(s: string): Buffer;
  decryptString?(b: Buffer): string;
  encryptStringAsync?(s: string): Promise<Buffer | Uint8Array>;
  decryptStringAsync?(b: Buffer): Promise<string | { result: string; shouldReEncrypt?: boolean }>;
}

export class SecretStore {
  private cache = new Map<string, string>();
  constructor(private ss: SafeStorageLike) {}

  async available(): Promise<boolean> {
    if (this.ss.isAsyncEncryptionAvailable) return this.ss.isAsyncEncryptionAvailable().catch(() => false);
    return !!this.ss.isEncryptionAvailable?.();
  }

  private async decrypt(buf: Buffer): Promise<{ text: string; reEncrypt: boolean }> {
    if (this.ss.decryptStringAsync) {
      try {
        const r = await this.ss.decryptStringAsync(buf);
        return typeof r === "string" ? { text: r, reEncrypt: false } : { text: r.result, reEncrypt: !!r.shouldReEncrypt };
      } catch { /* written by the old sync API → fall through */ }
    }
    if (this.ss.decryptString) return { text: this.ss.decryptString(buf), reEncrypt: !!this.ss.encryptStringAsync };
    throw new Error("cannot decrypt");
  }
  private async encrypt(text: string): Promise<Buffer> {
    if (this.ss.encryptStringAsync) return Buffer.from(await this.ss.encryptStringAsync(text));
    if (this.ss.encryptString) return this.ss.encryptString(text);
    throw new Error("OS encryption is not available on this machine");
  }

  /** Load a secret file into memory (re-encrypting it with the current API when needed). */
  async load(file: string): Promise<string> {
    if (!existsSync(file)) { this.cache.set(file, ""); return ""; }
    try {
      const { text, reEncrypt } = await this.decrypt(readFileSync(file));
      this.cache.set(file, text);
      if (reEncrypt && text) await this.encrypt(text).then((b) => writeFileSync(file, b)).catch(() => undefined);
      return text;
    } catch {
      this.cache.set(file, "");
      return "";
    }
  }
  get(file: string): string {
    return this.cache.get(file) ?? "";
  }
  async set(file: string, value: string): Promise<void> {
    if (!value) { if (existsSync(file)) unlinkSync(file); this.cache.set(file, ""); return; }
    if (!(await this.available())) throw new Error("OS encryption is not available on this machine");
    writeFileSync(file, await this.encrypt(value));
    this.cache.set(file, value);
  }
}
