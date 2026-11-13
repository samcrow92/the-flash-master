import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretStore } from "../src/main/secrets";

const rev = (s: string) => Buffer.from([...s].reverse().join(""));
describe("secret store", () => {
  it("uses the async safeStorage API and reads secrets written by the old sync API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    const file = join(dir, "jazz.secret");
    writeFileSync(file, Buffer.from("OLD:" + "pw1")); // legacy format
    let syncCalls = 0;
    const ss = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (s: string) => rev(s),
      decryptStringAsync: async (b: Buffer) => { const t = b.toString(); if (t.startsWith("OLD:")) throw new Error("not async format"); return { result: [...t].reverse().join(""), shouldReEncrypt: false }; },
      decryptString: (b: Buffer) => { syncCalls++; return b.toString().slice(4); },
    };
    const store = new SecretStore(ss);
    expect(await store.load(file)).toBe("pw1");
    expect(syncCalls).toBe(1);
    expect(readFileSync(file).toString()).toBe("1wp"); // re-encrypted with the async API
    expect(await new SecretStore(ss).load(file)).toBe("pw1");
    expect(syncCalls).toBe(1);
    await store.set(file, "new");
    expect(store.get(file)).toBe("new");
    await store.set(file, "");
    expect(await store.load(file)).toBe("");
  });
});
