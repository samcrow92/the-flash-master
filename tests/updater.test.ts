import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Updater, parseFeed, type Fetch } from "../src/main/updater";

const exe = Buffer.from("MZ fake installer v0.9.0");
const sha = createHash("sha256").update(exe).digest("hex");
const manifest = (v = "0.9.0") => ({ version: v, notes: "New: updates", files: [
  { kind: "setup", name: `TheFlashMaster-${v}-x64-setup.exe`, sha256: sha, size: exe.length },
  { kind: "portable", name: `TheFlashMaster-${v}-x64-portable.exe`, sha256: sha, size: exe.length },
] });
const resp = (status: number, body: string | Buffer, extra: { url?: string; type?: string } = {}) => ({
  ok: status < 400, status, url: extra.url, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? extra.type ?? "application/json" : null) },
  text: async () => body.toString(), arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }, body: null,
});
function make(feedUrl: string, routes: (url: string, h: Record<string, string>) => ReturnType<typeof resp>, o: { mode?: "installer" | "portable" | "dev"; token?: string; channel?: "stable" | "beta"; portablePath?: string } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const spawned: { cmd: string; args: string[] }[] = [];
  let quit = false;
  const fetch: Fetch = async (url, init) => { calls.push({ url, headers: init?.headers ?? {} }); return routes(url, init?.headers ?? {}) as any; };
  const u = new Updater({ fetch, version: "0.3.0", mode: o.mode ?? "installer", dataDir: mkdtempSync(join(tmpdir(), "upd-")), feed: () => ({ url: feedUrl, channel: o.channel ?? "stable", token: o.token ?? "" }),
    emit: () => {}, spawnDetached: (cmd, args) => spawned.push({ cmd, args }), quit: () => { quit = true; }, portablePath: o.portablePath });
  return { u, calls, spawned, isQuit: () => quit };
}

describe("update source parsing", () => {
  it("recognises github.com, GitHub Enterprise and web folders", () => {
    expect(parseFeed("https://github.com/acme/the-flash-master.git")).toMatchObject({ kind: "github", api: "https://api.github.com", web: "https://github.com/acme/the-flash-master" });
    expect(parseFeed("https://github.hella.com/ele/the-flash-master/")).toMatchObject({ kind: "github", api: "https://github.hella.com/api/v3", owner: "ele", repo: "the-flash-master" });
    expect(parseFeed("https://files.corp/apps/flash/latest.json")).toEqual({ kind: "folder", base: "https://files.corp/apps/flash" });
    expect(parseFeed("https://forvia-hella.ghe.com/marianmarcel-abagiu/the-flash-master")).toMatchObject({ kind: "github",
      api: "https://api.forvia-hella.ghe.com", web: "https://forvia-hella.ghe.com/marianmarcel-abagiu/the-flash-master", owner: "marianmarcel-abagiu", repo: "the-flash-master" });
    expect(parseFeed("")).toBeNull();
  });
});

describe("updater", () => {
  it("finds a newer release via the repository's web 'latest' link, downloads and verifies it, installs silently", async () => {
    const { u, calls, spawned, isQuit } = make("https://github.hella.com/ele/tfm", (url) =>
      url.endsWith("/releases/latest/download/latest.json") ? resp(200, JSON.stringify(manifest()))
      : url.endsWith("/releases/download/v0.9.0/TheFlashMaster-0.9.0-x64-setup.exe") ? resp(200, exe, { type: "application/octet-stream" }) : resp(404, "nope"));
    expect(await u.check()).toMatchObject({ status: "available", latest: "0.9.0", notes: "New: updates" });
    expect(await u.download()).toMatchObject({ status: "ready" });
    expect(calls.map((c) => c.url)).toContain("https://github.hella.com/ele/tfm/releases/download/v0.9.0/TheFlashMaster-0.9.0-x64-setup.exe");
    u.install();
    expect(spawned[0]!.args).toEqual(["/S", "--updated", "--force-run"]);
    expect(spawned[0]!.cmd).toMatch(/TheFlashMaster-0\.9\.0-x64-setup\.exe$/);
    expect(isQuit()).toBe(true);
  });

  it("uses the GitHub Enterprise REST API with a token (private repositories)", async () => {
    const rel = { tag_name: "v0.9.0", draft: false, assets: [
      { name: "latest.json", url: "https://github.hella.com/api/v3/repos/ele/tfm/releases/assets/1", browser_download_url: "x" },
      { name: "TheFlashMaster-0.9.0-x64-setup.exe", url: "https://github.hella.com/api/v3/repos/ele/tfm/releases/assets/2", browser_download_url: "y" } ] };
    const { u, calls } = make("https://github.hella.com/ele/tfm", (url) =>
      url.endsWith("/api/v3/repos/ele/tfm/releases/latest") ? resp(200, JSON.stringify(rel))
      : url.endsWith("/assets/1") ? resp(200, JSON.stringify(manifest())) : url.endsWith("/assets/2") ? resp(200, exe) : resp(404, ""), { token: "t0k" });
    expect(await u.check()).toMatchObject({ status: "available", latest: "0.9.0" });
    expect(await u.download()).toMatchObject({ status: "ready" });
    expect(calls[0]!.headers.Authorization).toBe("token t0k");
    expect(calls.find((c) => c.url.endsWith("/assets/2"))!.headers.Accept).toBe("application/octet-stream");
  });

  it("asks for sign-in when the repository answers with a login page, and rejects bad checksums", async () => {
    const login = make("https://github.hella.com/ele/tfm", () => resp(200, "<html><form action=/session>login</form></html>", { url: "https://github.hella.com/login?return_to=x", type: "text/html" }));
    expect(await login.u.check()).toMatchObject({ status: "error", needsSignIn: true });
    // ghe.com with company SSO: a 200 HTML page on a different host, no recognisable login URL
    const sso = make("https://forvia-hella.ghe.com/team/tfm", () => resp(200, "<!DOCTYPE html><html><body>Redirecting to your identity provider…</body></html>", { url: "https://login.microsoftonline.com/x", type: "text/html" }));
    expect(await sso.u.check()).toMatchObject({ status: "error", needsSignIn: true, error: expect.stringMatching(/private/) });

    const bad = make("https://files.corp/flash", (url) => url.endsWith("latest.json") ? resp(200, JSON.stringify(manifest())) : resp(200, Buffer.from("tampered")));
    expect(await bad.u.check()).toMatchObject({ status: "available" });
    expect(await bad.u.download()).toMatchObject({ status: "error", error: expect.stringMatching(/Checksum mismatch/) });
  });

  it("reports up-to-date and missing configuration", async () => {
    expect(await make("https://files.corp/flash", () => resp(200, JSON.stringify(manifest("0.3.0")))).u.check()).toMatchObject({ status: "up-to-date" });
    expect(await make("", () => resp(404, "")).u.check()).toMatchObject({ status: "disabled" });
  });

  it("portable: swaps the running exe in place and restarts it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "port-"));
    const cur = join(dir, "TheFlashMaster.exe");
    writeFileSync(cur, "old build");
    const { u, spawned } = make("https://files.corp/flash", (url) => url.endsWith("latest.json") ? resp(200, JSON.stringify(manifest())) : resp(200, exe), { mode: "portable", portablePath: cur });
    await u.check();
    await u.download();
    u.install();
    expect(readFileSync(cur).toString()).toBe(exe.toString());
    expect(existsSync(`${cur}.old`)).toBe(true);
    expect(spawned[0]).toEqual({ cmd: cur, args: [] });
  });
});
