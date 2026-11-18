/**
 * End to end against the REAL Python server (flash-server/server): the app's own client code submits a plugin, the
 * admin reviews it over the admin API, the app installs it from the private marketplace and updates from the private
 * feed. Unit tests use fakes; this one catches drift between flash-server/API.md, the server and the app.
 * Skipped when no Python 3.10+ is on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { FlashServerClient, submissionNotice } from "../src/main/flash-server";
import { packageFromFolder } from "../src/main/plugin-builder";
import { Marketplace } from "../src/main/marketplace";
import { Updater } from "../src/main/updater";
import { loadRoles } from "../src/main/roles";

const ROOT = join(__dirname, "..");
const PACK = join(ROOT, "marketplace-example", "plugins-src", "body-sw-test-pack");
const python = (process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"], ["python"]])
  .find(([cmd, ...pre]) => spawnSync(cmd!, [...pre, "-c", "import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 10) else 1)"]).status === 0);

const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });

describe.skipIf(!python)("app ↔ real Flash server", () => {
  const data = mkdtempSync(join(tmpdir(), "flash-e2e-"));
  const env = { ...process.env, PYTHONPATH: join(ROOT, "flash-server", "server"), PYTHONDONTWRITEBYTECODE: "1" };
  let proc: ChildProcess | undefined;
  let base = "";
  let admin = "";
  const cli = (...args: string[]) => {
    const [cmd, ...pre] = python!;
    const r = spawnSync(cmd!, [...pre, "-m", "flashserver", ...args, "--data-dir", data, "--json"], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`flashserver ${args[0]} failed: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
  };
  const adminCall = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${admin}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: raw ? new Uint8Array(raw) : body ? JSON.stringify(body) : undefined });
    const json = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`);
    return json;
  };

  beforeAll(async () => {
    admin = cli("init", "--admin-name", "mari").adminToken;
    const port = await freePort();
    const [cmd, ...pre] = python!;
    proc = spawn(cmd!, [...pre, "-m", "flashserver", "serve", "--data-dir", data, "--host", "127.0.0.1", "--port", String(port)], { env, stdio: "ignore" });
    base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/v1/health`)).ok) return; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("server did not start");
  }, 30000);
  afterAll(() => { proc?.kill(); });

  it("submit → review with feedback → install from the private marketplace", async () => {
    const { token } = await adminCall("POST", "/api/v1/admin/users", { name: "ana", role: "user" });
    const app = new FlashServerClient({ fetch: fetch as any, config: () => ({ url: base, token }) });
    expect(await app.test()).toMatchObject({ ok: true, user: { name: "ana", role: "user" } });

    const { pkg, problems } = packageFromFolder(PACK);
    expect(problems).toEqual([]);
    const sub = await app.submit(pkg, "First version");
    expect(sub).toMatchObject({ status: "pending", pluginId: pkg.id, author: "ana" });
    expect(sub.kinds).toEqual(expect.arrayContaining(["agent", "workflow", "skill", "script"]));

    // Admin asks for changes, the app shows the feedback; the author resubmits; admin approves.
    await adminCall("POST", `/api/v1/admin/submissions/${sub.id}/review`, { decision: "changes_requested", feedback: "Add a timeout to collect-logs.py\nThanks!" });
    const [changed] = await app.submissions();
    expect(changed).toMatchObject({ status: "changes_requested", feedback: expect.stringContaining("timeout"), reviewer: "mari" });
    expect(submissionNotice(changed!)?.text).toMatch(/needs changes: Add a timeout/);
    const again = await app.submit(pkg, "Timeout added");
    expect(again.id).toBe(sub.id); // a pending/changes-requested one for the same version is replaced
    const detail = await adminCall("GET", `/api/v1/admin/submissions/${sub.id}`);
    expect(detail.diff.files.length).toBeGreaterThan(0);
    await adminCall("POST", `/api/v1/admin/submissions/${sub.id}/review`, { decision: "approve", feedback: "Published" });
    expect((await app.submissions())[0]).toMatchObject({ status: "approved", feedback: "Published" });

    // The app's marketplace reads the server's index with the token and installs everything in the package.
    const dir = mkdtempSync(join(tmpdir(), "flash-e2e-app-"));
    mkdirSync(join(dir, "agents")); // the app creates its roles folder at startup
    const mp = new Marketplace({ dataDir: dir, rolesDir: join(dir, "agents"), skillsDir: join(dir, "skills"), fetch: fetch as any,
      policy: () => ({ allowMcpServers: false }), knownTools: () => ["flashmaster-core"], builtinRoles: () => loadRoles(join(ROOT, "agents"), "/none").map((r) => r.name),
      addMcpServers: () => {}, removeMcpServers: () => {} });
    const src = { id: "flash-server", name: "Flash server", url: `${base}/marketplace`, department: "", enabled: true, token };
    const listing = await mp.fetchIndex(src);
    expect(listing.error).toBeNull();
    expect(listing.plugins.map((p) => p.id)).toEqual([pkg.id]);
    const installed = await mp.install(src, pkg.id);
    expect(installed.skills.length).toBeGreaterThan(0);
    expect(installed.scripts.length).toBeGreaterThan(0);
    for (const s of installed.scripts) expect(existsSync(join(dir, "plugins", pkg.id, "scripts", s))).toBe(true);

    // Without a token the private server answers 401, so the listing reports it instead of showing nothing.
    expect((await mp.fetchIndex({ ...src, token: "" })).error).toMatch(/401/);
  }, 30000);

  it("updates come from the private feed with the token and are verified", async () => {
    const exe = Buffer.from("MZ installer bytes for 9.0.0");
    const name = "TheFlashMaster-9.0.0-x64-setup.exe";
    const sha = createHash("sha256").update(exe).digest("hex");
    await adminCall("PUT", `/api/v1/admin/releases/9.0.0/files/${name}?sha256=${sha}`, undefined, exe);
    await adminCall("POST", "/api/v1/admin/releases/9.0.0/publish", { channel: "stable", notes: "Private build" });
    const { token } = await adminCall("POST", "/api/v1/admin/users", { name: "bo", role: "user" });

    const dataDir = mkdtempSync(join(tmpdir(), "flash-e2e-upd-"));
    const u = new Updater({ fetch: fetch as any, version: "0.3.0", mode: "installer", dataDir, emit: () => {}, spawnDetached: () => {}, quit: () => {},
      feed: () => ({ url: "", channel: "stable", token: "", server: { url: base, token } }) });
    expect(await u.check()).toMatchObject({ status: "available", latest: "9.0.0", source: "server", notes: "Private build" });
    // download() refuses in dev mode only; installer mode streams and verifies the SHA-256.
    expect(await u.download()).toMatchObject({ status: "ready" });
    expect(readFileSync(join(dataDir, "updates", name))).toEqual(exe);
  }, 30000);
});
