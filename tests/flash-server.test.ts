/**
 * Flash server (flash-server/API.md) on the app side: update feed + fallback, the "flash-server" marketplace source,
 * the submission package builder and dry run, the submissions client, and status-change notices.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Updater, type Fetch } from "../src/main/updater";
import { Marketplace, validatePackage } from "../src/main/marketplace";
import { FlashServerClient, SubmissionWatcher, submissionNotice } from "../src/main/flash-server";
import { draftFor, guessKind, packageFromFiles, packageFromFolder } from "../src/main/plugin-builder";
import { loadRoles, loadSkills } from "../src/main/roles";
import type { FetchLike } from "../src/main/jazz";
import type { PluginPackage, Submission } from "../src/shared/types";

const ROOT = join(__dirname, "..");
const PACK = join(ROOT, "marketplace-example", "plugins-src", "body-sw-test-pack");
const builtin = loadRoles(join(ROOT, "agents"), "/none").map((r) => r.name);
const tools = ["flashmaster-core", "vector-autosar"];

// ---------------------------------------------------------------- updates
const exe = Buffer.from("MZ fake installer v0.9.0");
const sha = createHash("sha256").update(exe).digest("hex");
const manifest = (v = "0.9.0") => ({ version: v, notes: "From the server", files: [{ kind: "setup", name: `TheFlashMaster-${v}-x64-setup.exe`, sha256: sha, size: exe.length }] });
const resp = (status: number, body: string | Buffer, type = "application/json") => ({
  ok: status < 400, status, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? type : null) },
  text: async () => body.toString(), arrayBuffer: async () => { const b = Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }, body: null,
});
type Route = (url: string) => ReturnType<typeof resp> | "down";
function updater(o: { repo: string; ghToken?: string; server?: string; serverToken?: string }, route: Route) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const r = route(url);
    if (r === "down") throw new Error("connect ECONNREFUSED");
    return r as any;
  };
  const u = new Updater({ fetch, version: "0.3.0", mode: "installer", dataDir: mkdtempSync(join(tmpdir(), "upd-")),
    feed: () => ({ url: o.repo, channel: "stable", token: o.ghToken ?? "", server: o.server ? { url: o.server, token: o.serverToken ?? "" } : undefined }),
    emit: () => {}, spawnDetached: () => {}, quit: () => {} });
  return { u, calls };
}
const GH = "https://github.hella.com/ele/tfm";
const ghRelease = { tag_name: "v0.9.0", draft: false, assets: [
  { name: "latest.json", url: "https://github.hella.com/api/v3/repos/ele/tfm/releases/assets/1", browser_download_url: "x" },
  { name: "TheFlashMaster-0.9.0-x64-setup.exe", url: "https://github.hella.com/api/v3/repos/ele/tfm/releases/assets/2", browser_download_url: "y" }] };
const ghRoute = (url: string) => url.endsWith("/releases/latest") ? resp(200, JSON.stringify(ghRelease))
  : url.endsWith("/assets/1") ? resp(200, JSON.stringify(manifest())) : url.endsWith("/assets/2") ? resp(200, exe) : resp(404, "");

describe("updates from the Flash server", () => {
  it("checks <server>/updates/<channel>/latest.json with the server token and downloads from it", async () => {
    const { u, calls } = updater({ repo: GH, ghToken: "ghtok", server: "flash.corp:8787/", serverToken: "fs_abc" }, (url) =>
      url === "http://flash.corp:8787/updates/stable/latest.json" ? resp(200, JSON.stringify(manifest()))
      : url === "http://flash.corp:8787/updates/stable/TheFlashMaster-0.9.0-x64-setup.exe" ? resp(200, exe, "application/octet-stream") : resp(404, "{}"));
    expect(await u.check()).toMatchObject({ status: "available", latest: "0.9.0", source: "server", feed: "http://flash.corp:8787" });
    expect(await u.download()).toMatchObject({ status: "ready", source: "server" });
    expect(calls.map((c) => c.headers.Authorization)).toEqual(["Bearer fs_abc", "Bearer fs_abc"]);
    expect(calls.every((c) => !c.url.includes("github"))).toBe(true);
  });

  it.each([["network error", "down" as const], ["HTTP 503", resp(503, JSON.stringify({ error: "maintenance", code: "invalid" }))]])(
    "falls back to the repository feed on a %s, keeping each token on its own host", async (_l, failure) => {
      const { u, calls } = updater({ repo: GH, ghToken: "ghtok", server: "http://flash.corp:8787", serverToken: "fs_abc" }, (url) =>
        url.startsWith("http://flash.corp:8787/") ? failure : ghRoute(url));
      const st = await u.check();
      expect(st).toMatchObject({ status: "available", source: "repository", feed: GH });
      expect(st.serverError).toMatch(failure === "down" ? /cannot reach/ : /HTTP 503.*maintenance/);
      expect(await u.download()).toMatchObject({ status: "ready" });
      for (const c of calls) {
        if (c.url.startsWith("http://flash.corp")) expect(c.headers.Authorization).toBe("Bearer fs_abc");
        else expect(c.headers.Authorization).toBe("token ghtok");
      }
      expect(calls.filter((c) => !c.url.startsWith("http://flash.corp")).length).toBeGreaterThanOrEqual(3);
    });

  it("reports the server's error when there is no repository feed to fall back to", async () => {
    const { u } = updater({ repo: "", server: "http://flash.corp:8787", serverToken: "bad" }, () => resp(401, JSON.stringify({ error: "invalid token", code: "unauthorized" })));
    expect(await u.check()).toMatchObject({ status: "error", source: "server", error: expect.stringMatching(/Flash server: HTTP 401.*invalid token.*token/) });
  });

  it("without a server keeps the repository behaviour (and says so)", async () => {
    const { u, calls } = updater({ repo: GH, ghToken: "ghtok" }, ghRoute);
    expect(await u.check()).toMatchObject({ status: "available", source: "repository" });
    expect(calls.every((c) => c.headers.Authorization === "token ghtok")).toBe(true);
  });
});

// ---------------------------------------------------------------- marketplace source "flash-server"
let server: Server;
let port = 0;
let market = "";
const seen: { url: string; auth?: string }[] = [];
beforeAll(async () => {
  market = mkdtempSync(join(tmpdir(), "fsmp-"));
  cpSync(join(ROOT, "marketplace-example", "plugins-src"), join(market, "plugins-src"), { recursive: true });
  cpSync(join(ROOT, "marketplace-example", "files"), join(market, "files"), { recursive: true });
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", "marketplace", "build-index.mjs"), market], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  // A private server: /marketplace/* needs "Bearer fs_good".
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const path = (req.url ?? "/").split("?")[0]!;
    if (!path.startsWith("/marketplace/")) { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== "Bearer fs_good") { res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "token required", code: "unauthorized" })); return; }
    const f = join(market, decodeURIComponent(path.slice("/marketplace".length)));
    if (!f.startsWith(market) || !existsSync(f)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" }).end(readFileSync(f));
  });
  await new Promise<void>((r2) => server.listen(0, "127.0.0.1", () => r2()));
  port = (server.address() as any).port;
});
afterAll(() => server?.close());

const realFetch: FetchLike = async (url, init) => {
  const r = await fetch(url, { method: init?.method, headers: init?.headers, body: init?.body });
  return { status: r.status, ok: r.ok, headers: { get: (n: string) => r.headers.get(n) }, text: () => r.text() };
};
function mpSetup() {
  const data = mkdtempSync(join(tmpdir(), "fsdata-"));
  const rolesDir = join(data, "agents"), skillsDir = join(data, "skills");
  mkdirSync(rolesDir, { recursive: true });
  const mp = new Marketplace({ dataDir: data, rolesDir, skillsDir, fetch: realFetch, policy: () => ({ allowMcpServers: false }), knownTools: () => tools,
    builtinRoles: () => builtin, addMcpServers: () => {}, removeMcpServers: () => {} });
  return { mp, data, rolesDir, skillsDir };
}

describe("Flash server as a marketplace source", () => {
  it("sends the token with index and package requests, and installs skills and scripts from it", async () => {
    const { mp, data, skillsDir } = mpSetup();
    const src = { id: "flash-server", name: "Body hub", url: `http://127.0.0.1:${port}/marketplace`, department: "", enabled: true, token: "fs_good" };
    seen.length = 0;
    const l = await mp.fetchIndex(src);
    expect(l.error).toBeNull();
    expect(l.sourceName).toBe("Body hub");
    const rec = await mp.install(src, "body-sw-test-pack");
    expect(rec).toMatchObject({ sourceId: "flash-server", skills: ["hil-report"], scripts: ["collect-logs.py"] });
    expect(seen.map((x) => x.auth)).toEqual(["Bearer fs_good", "Bearer fs_good"]);
    expect(loadSkills(skillsDir).map((s) => s.command)).toContain("hil-report");
    expect(existsSync(join(data, "plugins", "body-sw-test-pack", "scripts", "collect-logs.py"))).toBe(true);
  });

  it("explains a missing or wrong token", async () => {
    const { mp } = mpSetup();
    const l = await mp.fetchIndex({ id: "flash-server", name: "Flash server", url: `http://127.0.0.1:${port}/marketplace`, department: "", enabled: true, token: "" });
    expect(l.error).toMatch(/HTTP 401.*Flash server token/);
  });

  it("never sends the token to a package URL outside the server", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const idx = { plugins: [{ id: "x-pack", name: "X", version: "1.0.0", package: "https://elsewhere.example/x.json", kinds: [], tags: [] }] };
    const fake: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {} });
      const body = url.endsWith("index.json") ? JSON.stringify(idx) : JSON.stringify({ id: "x-pack", name: "X", version: "1.0.0", instructions: "Be nice." });
      return { status: 200, ok: true, headers: { get: () => "application/json" }, text: async () => body };
    };
    const data = mkdtempSync(join(tmpdir(), "fsx-"));
    const mp = new Marketplace({ dataDir: data, rolesDir: join(data, "a"), skillsDir: join(data, "s"), fetch: fake, policy: () => ({ allowMcpServers: false }),
      knownTools: () => [], builtinRoles: () => [], addMcpServers: () => {}, removeMcpServers: () => {} });
    await mp.install({ id: "flash-server", name: "F", url: "http://flash.corp:8787/marketplace", department: "", enabled: true, token: "fs_secret" }, "x-pack");
    expect(calls[0]!.headers.Authorization).toBe("Bearer fs_secret");
    expect(calls[1]!.url).toBe("https://elsewhere.example/x.json");
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });
});

// ---------------------------------------------------------------- package builder + dry run
describe("submission package builder", () => {
  it("builds a package from a plugins-src/<id>/ folder (marketplace-example) that passes the install rules", () => {
    const { pkg, problems } = packageFromFolder(PACK);
    expect(problems).toEqual([]);
    expect(pkg).toMatchObject({ id: "body-sw-test-pack", version: "1.0.0", team: "Body SW Validation", tags: ["hil", "canoe", "testing"] });
    expect(pkg.agents!.map((a) => a.file)).toEqual(["hil-tester.md"]);
    expect(pkg.workflows!.map((a) => a.file)).toEqual(["hil-campaign.md"]);
    expect(pkg.skills!.map((a) => a.file)).toEqual(["hil-report.md"]);
    expect(pkg.scripts!.map((a) => a.file)).toEqual(["collect-logs.py"]);
    const v = validatePackage(pkg, { knownTools: tools, builtinRoles: builtin, submit: true });
    expect(v.errors).toEqual([]);
    expect(v.kinds).toEqual(["agent", "workflow", "skill", "script"]);
    expect(v.items).toEqual(["agent @hil-tester", "workflow /hil-campaign", "skill /hil-report", "script collect-logs.py"]);
    // The folder's package is byte-for-byte the content build-index.mjs publishes.
    const published = JSON.parse(readFileSync(join(ROOT, "marketplace-example", "plugins", "body-sw-test-pack-1.0.0.json"), "utf8")) as PluginPackage;
    expect(pkg.skills).toEqual(published.skills);
    expect(pkg.scripts).toEqual(published.scripts);
  });

  it("form fields override plugin.json, and the dialog draft lists what was found", () => {
    expect(packageFromFolder(PACK, { version: "1.1.0" }).pkg.version).toBe("1.1.0");
    const d = draftFor({ kind: "folder", path: PACK });
    expect(d.meta).toMatchObject({ id: "body-sw-test-pack", version: "1.0.0" });
    expect(d.items).toEqual(["agents/hil-tester.md", "workflows/hil-campaign.md", "skills/hil-report.md", "scripts/collect-logs.py"]);
  });

  it("builds from single files with a kind per file", () => {
    const files = [join(PACK, "agents", "hil-tester.md"), join(PACK, "skills", "hil-report.md"), join(PACK, "workflows", "hil-campaign.md"), join(PACK, "scripts", "collect-logs.py")];
    expect(files.map((f) => guessKind(f))).toEqual(["agent", "skill", "workflow", "script"]);
    const d = draftFor({ kind: "files", files: files.map((p) => ({ path: p, name: p, kind: guessKind(p) })) });
    expect(d.meta).toMatchObject({ id: "hil-tester", name: "HIL Test Engineer (Body)" });
    const { pkg } = packageFromFiles(files.map((p) => ({ path: p, kind: guessKind(p) })), { ...d.meta, version: "0.1.0" });
    expect(validatePackage(pkg, { knownTools: tools, builtinRoles: builtin, submit: true })).toMatchObject({ errors: [], kinds: ["agent", "workflow", "skill", "script"] });
  });

  it("dry run reports every problem precisely, with the same rules install uses", () => {
    const bad: PluginPackage = { id: "Bad Id", name: "", version: "one",
      agents: [{ file: "x.txt", content: "" }],
      workflows: [{ file: "w.md", content: "---\ncommand: dup\n---\nDo it." }],
      skills: [{ file: "dup.md", content: "---\nname: Dup\n---\nAgain." }, { file: "empty.md", content: "---\nname: E\n---\n" }, { file: "Bad Name.md", content: "x" }],
      scripts: [{ file: "run.exe", content: "MZ" }, { file: "big.py", content: "x".repeat(200_001) }] };
    const v = validatePackage(bad, { knownTools: tools, builtinRoles: builtin, submit: true });
    expect(v.errors).toEqual([
      expect.stringMatching(/^id "Bad Id" is not allowed/),
      expect.stringMatching(/^version "one" must be semver/),
      "name is required",
      "agent file name not allowed: x.txt",
      "\"/dup\" is in the package twice",
      "empty.md: skill body is empty",
      "skill file name not allowed: Bad Name.md",
      expect.stringMatching(/^script file name not allowed: run\.exe/),
      "script big.py is larger than 200 KB",
    ]);
    // install (no submit flag) does not insist on the version format; ownership checks need a local install
    expect(validatePackage({ id: "ok-pack", name: "Ok", version: "x", instructions: "Rules." }, { knownTools: [], builtinRoles: [] }).errors).toEqual([]);
    expect(validatePackage({ id: "ok-pack", name: "Ok", version: "1.0.0" }, { knownTools: [], builtinRoles: [] }).errors).toEqual(["plugin ok-pack contains nothing to install"]);
  });

  it("install refuses a skill whose command another plugin owns", async () => {
    const { mp } = mpSetup();
    const owner = { id: "other", name: "Other", version: "1.0.0", team: "", sourceId: "s", sourceName: "S", installedAt: 0, agents: [], workflows: ["hil-report"], skills: [], scripts: [],
      hasInstructions: false, instructionsEnabled: true, mcpServers: [] };
    const v = validatePackage(packageFromFolder(PACK).pkg, { knownTools: tools, builtinRoles: builtin, local: { installed: [owner], rolesDir: "/none" } });
    expect(v.errors).toEqual(['skill "/hil-report" is already provided by another plugin']);
    expect(mp.installed()).toEqual([]);
  });
});

// ---------------------------------------------------------------- submissions client + notices
const sub = (over: Partial<Submission> = {}): Submission => ({ id: 12, pluginId: "body-sw-test-pack", version: "1.2.0", name: "Body SW test pack", kinds: ["agent"], status: "pending",
  notes: "", feedback: null, author: "ana", createdAt: "2026-11-18T06:00:00Z", reviewedAt: null, reviewer: null, ...over });

function fakeServer(handler: (method: string, path: string, body: any, headers: Record<string, string>) => [number, unknown] | "down") {
  const calls: { method: string; url: string; headers: Record<string, string>; body: any }[] = [];
  const f: FetchLike = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", url, headers: init?.headers ?? {}, body });
    const r = handler(init?.method ?? "GET", new URL(url).pathname, body, init?.headers ?? {});
    if (r === "down") throw new Error("getaddrinfo ENOTFOUND flash.corp");
    return { status: r[0], ok: r[0] < 400, headers: { get: () => "application/json" }, text: async () => JSON.stringify(r[1]) };
  };
  return { f, calls };
}

describe("Flash server client", () => {
  it("submits, lists and withdraws with the Bearer token", async () => {
    const { f, calls } = fakeServer((m, p, body) =>
      m === "POST" && p === "/api/v1/submissions" ? [201, sub({ name: body.package.name })]
      : m === "GET" && p === "/api/v1/submissions" ? [200, { submissions: [sub()] }]
      : m === "DELETE" && p === "/api/v1/submissions/12" ? [200, sub({ status: "withdrawn" })] : [404, { error: "no", code: "not_found" }]);
    const c = new FlashServerClient({ fetch: f, config: () => ({ url: "http://flash.corp:8787/", token: "fs_t" }) });
    const pkg = packageFromFolder(PACK).pkg;
    expect(await c.submit(pkg, "first version")).toMatchObject({ id: 12, status: "pending", name: pkg.name });
    expect(calls[0]).toMatchObject({ url: "http://flash.corp:8787/api/v1/submissions", body: { package: pkg, notes: "first version" } });
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer fs_t", "Content-Type": "application/json; charset=utf-8" });
    expect(await c.submissions()).toHaveLength(1);
    expect(await c.withdraw(12)).toMatchObject({ status: "withdrawn" });
    expect(calls.map((x) => x.method)).toEqual(["POST", "GET", "DELETE"]);
  });

  it("turns server errors into precise messages", async () => {
    const answers: Record<string, [number, unknown] | "down"> = {
      a: [409, { error: "version 1.2.0 of body-sw-test-pack is already published", code: "conflict" }],
      b: [403, { error: "body-sw-test-pack is owned by mari", code: "forbidden" }],
      c: [401, { error: "invalid token", code: "unauthorized" }],
      d: "down",
    };
    for (const [k, msg] of [["a", /^HTTP 409 conflict: version 1\.2\.0 .* already published$/], ["b", /^HTTP 403 forbidden: .*owned by mari$/],
      ["c", /^HTTP 401 unauthorized: invalid token — the token was not accepted/], ["d", /^Cannot reach http:\/\/flash\.corp: getaddrinfo ENOTFOUND/]] as const) {
      const c = new FlashServerClient({ fetch: fakeServer(() => answers[k]!).f, config: () => ({ url: "flash.corp", token: "fs_t" }) });
      await expect(c.submit({ id: "x", name: "x", version: "1.0.0" }, "")).rejects.toThrow(msg);
    }
  });

  it("tests the connection: health without the token, then /me with it", async () => {
    const { f, calls } = fakeServer((_m, p) => p === "/api/v1/health" ? [200, { ok: true, name: "Body hub", version: "1.0.0", publicRead: false }]
      : p === "/api/v1/me" ? [200, { id: 3, name: "ana", role: "user" }] : [404, {}]);
    const c = new FlashServerClient({ fetch: f, config: () => ({ url: "http://flash.corp:8787", token: "fs_t" }) });
    expect(await c.test()).toMatchObject({ ok: true, serverName: "Body hub", user: { name: "ana", role: "user" }, detail: 'Signed in to "Body hub" as ana (user)' });
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(calls[1]!.headers.Authorization).toBe("Bearer fs_t");
    const noToken = new FlashServerClient({ fetch: f, config: () => ({ url: "http://flash.corp:8787", token: "" }) });
    expect(await noToken.test()).toMatchObject({ ok: false, detail: expect.stringMatching(/no token is set/) });
    const down = new FlashServerClient({ fetch: fakeServer(() => "down").f, config: () => ({ url: "http://flash.corp:8787", token: "fs_t" }) });
    expect(await down.test()).toMatchObject({ ok: false, detail: expect.stringMatching(/^Health check failed — Cannot reach/) });
  });

  it("emits a notice only when a submission's status changes since last seen (persisted)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "seen-")), "server", "submissions-seen.json");
    const w = new SubmissionWatcher(file);
    expect(w.update([sub(), sub({ id: 7, status: "approved", version: "1.0.0" })])).toEqual([]); // first poll = baseline
    expect(w.update([sub()])).toEqual([]);
    const later = new SubmissionWatcher(file); // app restarted
    const n = later.update([sub({ status: "changes_requested", feedback: "Please add a description to hil-tester.\nAlso bump the version." }), sub({ id: 7, status: "approved", version: "1.0.0" }),
      sub({ id: 13, status: "approved", version: "1.3.0" })]);
    expect(n.map((x) => [x.level, x.text])).toEqual([
      ["warn", "Your plugin Body SW test pack 1.2.0 needs changes: Please add a description to hil-tester."],
      ["info", "Your plugin Body SW test pack 1.3.0 was approved"],
    ]);
    expect(later.update([sub({ status: "changes_requested" })])).toEqual([]);
    expect(submissionNotice(sub({ status: "withdrawn" }))).toBeNull();
    expect(submissionNotice(sub({ status: "rejected", feedback: "Duplicate of diag-team-rules" }))?.text).toBe("Your plugin Body SW test pack 1.2.0 was rejected: Duplicate of diag-team-rules");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ 12: "changes_requested", 13: "approved" });
  });
});

describe("example marketplace", () => {
  it("build-index.mjs rejects script types the app would refuse", () => {
    const m = mkdtempSync(join(tmpdir(), "bi-"));
    const dir = join(m, "plugins-src", "bad-pack");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "plugin.json"), JSON.stringify({ id: "bad-pack", name: "Bad", version: "1.0.0" }));
    writeFileSync(join(dir, "scripts", "tool.exe"), "MZ");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "marketplace", "build-index.mjs"), m], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/scripts\/tool\.exe: file type not allowed/);
  });
});
