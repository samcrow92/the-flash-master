/**
 * McpBootstrap — makes sure the custom tool servers exist at startup and builds the per-session MCP list.
 *  - bundled-node   : flashmaster-core, jazz (shipped JS, run with Electron-as-Node: no Node install needed)
 *  - bundled-python : vector-autosar, winidea (copied to app data; private venv created and requirements installed once)
 *  - catalog        : recommended servers (Context7, MarkItDown, …) installed once into app data, attached per role
 *  - external       : user-defined servers from Settings → MCP
 * Servers are attached per ACP session (session/new mcpServers), so the user's global harness configs stay untouched.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { McpServerStatus, RoleDef } from "@shared/types";
import type { Settings } from "@shared/settings";
import type { McpServerSpec } from "./harness/types";
import { runCapture, splitArgs, which } from "./harness/process";
import { networkEnv } from "./orchestrator";
import { MCP_CATALOG, catalogState, roleMatches, type CatalogServer } from "@shared/mcp-catalog";

interface Paths {
  nodeEntry: (name: string) => string; // path of bundled JS server
  nodeExec: string; // process.execPath (Electron) or node
  nodeEnv: Record<string, string>; // ELECTRON_RUN_AS_NODE=1 when using Electron
  pythonSrc: string; // folder containing vector-autosar/, winidea/, pycommon/
  dataDir: string; // app data root
}

const PY_SERVERS = [
  { id: "vector-autosar", label: "Vector / AUTOSAR tools (DBC, ARXML, CDD, CAPL, CANoe, DaVinci)" },
  { id: "winidea", label: "winIDEA debugger (isystem.connect SDK)" },
  { id: "office", label: "PowerPoint & diagrams (python-pptx, Ishikawa)" },
];

export class McpBootstrap {
  private status = new Map<string, McpServerStatus>();
  private python: string | null = null;
  private bridge = { url: "", token: "" };

  constructor(private p: Paths, private settings: () => Settings, private onStatus: (s: McpServerStatus[]) => void) {
    this.set({ id: "flashmaster-core", label: "TheFlashMaster core (delegation, tasks, artifacts)", kind: "bundled-node", state: "ready", detail: null });
    this.set({ id: "jazz", label: "IBM Jazz / EWM work items", kind: "bundled-node", state: "ready", detail: null });
    for (const s of PY_SERVERS) this.set({ id: s.id, label: s.label, kind: "bundled-python", state: "missing", detail: "Not installed yet" });
    for (const c of MCP_CATALOG) this.set({ id: c.id, label: c.label, kind: "catalog", state: this.catalogReady(c) ? "ready" : "missing", detail: this.catalogReady(c) ? null : "Not installed yet" });
  }

  setBridge(url: string, token: string): void {
    this.bridge = { url, token };
  }

  list(): McpServerStatus[] {
    const disabled = new Set(this.settings().mcp.disabled);
    for (const c of MCP_CATALOG) if (!catalogState(c, this.settings().mcp.catalog).enabled) disabled.add(c.id);
    const ext: McpServerStatus[] = this.settings().mcp.external.map((e) => ({ id: e.id, label: e.label || e.id, kind: "external", state: "ready", detail: e.command }));
    return [...this.status.values(), ...ext].map((s) => (disabled.has(s.id) && s.id !== "flashmaster-core" ? { ...s, state: "disabled" } : s));
  }

  /** Called at app start (non-blocking for the UI). */
  async ensure(force = false): Promise<McpServerStatus[]> {
    await this.ensureBundled(force);
    await this.ensureCatalog(force);
    return this.list();
  }

  private async ensureBundled(force: boolean): Promise<McpServerStatus[]> {
    const s = this.settings();
    if ((!s.mcp.autoInstall || s.network.offline) && !force) {
      for (const p of PY_SERVERS) if (this.isInstalled(p.id)) this.set({ ...this.status.get(p.id)!, state: "ready", detail: null });
      return this.list();
    }
    const py = await this.findPython();
    if (!py) {
      for (const p of PY_SERVERS) this.set({ ...this.status.get(p.id)!, state: "error", detail: "Python 3.10+ not found — set its path in Settings → MCP" });
      return this.list();
    }
    const root = join(this.p.dataDir, "mcp");
    mkdirSync(root, { recursive: true });
    for (const dir of ["pycommon", ...PY_SERVERS.map((x) => x.id)]) {
      const src = join(this.p.pythonSrc, dir);
      if (existsSync(src)) cpSync(src, join(root, dir), { recursive: true, filter: (f) => !f.includes("__pycache__") && !f.includes(".venv") });
    }
    const venv = join(root, ".venv");
    const vpy = venvPython(venv);
    try {
      if (!existsSync(vpy)) {
        for (const p of PY_SERVERS) this.set({ ...this.status.get(p.id)!, state: "installing", detail: "Creating Python environment…" });
        const r = await runCapture(py.cmd, [...py.args, "-m", "venv", venv], 180000);
        if (r.code !== 0) throw new Error(`venv failed: ${r.out.slice(-300)}`);
      }
      for (const p of PY_SERVERS) {
        const req = join(root, p.id, "requirements.txt");
        const hash = existsSync(req) ? createHash("sha1").update(readFileSync(req)).digest("hex") : "none";
        const marker = join(root, p.id, ".installed");
        if (!force && existsSync(marker) && readFileSync(marker, "utf8") === hash) { this.set({ ...this.status.get(p.id)!, state: "ready", detail: null }); continue; }
        this.set({ ...this.status.get(p.id)!, state: "installing", detail: "Installing Python packages…" });
        const args = ["-m", "pip", "install", "--disable-pip-version-check", "-r", req];
        if (s.mcp.pipIndexUrl) args.push("--index-url", s.mcp.pipIndexUrl);
        if (s.network.proxy) args.push("--proxy", s.network.proxy);
        if (s.network.caBundlePath) args.push("--cert", s.network.caBundlePath);
        const r = await runCapture(vpy, args, 600000);
        if (r.code !== 0) { this.set({ ...this.status.get(p.id)!, state: "error", detail: `pip failed: ${r.out.trim().slice(-300)}` }); continue; }
        writeFileSync(marker, hash);
        this.set({ ...this.status.get(p.id)!, state: "ready", detail: null });
      }
    } catch (e: any) {
      for (const p of PY_SERVERS) this.set({ ...this.status.get(p.id)!, state: "error", detail: String(e?.message ?? e) });
    }
    return this.list();
  }

  /** Install the enabled catalog servers that are not installed yet (npm into app data, pip into the private venv). */
  async ensureCatalog(force = false, only?: string): Promise<void> {
    const s = this.settings();
    const offline = (!s.mcp.autoInstall || s.network.offline) && !force;
    for (const c of MCP_CATALOG) {
      if (only && c.id !== only) continue;
      const st = catalogState(c, s.mcp.catalog);
      if (!st.enabled) continue;
      if (this.catalogReady(c) && !(force && (only === c.id || !only))) { this.set({ ...this.status.get(c.id)!, state: "ready", detail: null }); continue; }
      if (offline) { this.set({ ...this.status.get(c.id)!, state: "missing", detail: "Not installed (automatic install is off)" }); continue; }
      this.set({ ...this.status.get(c.id)!, state: "installing", detail: `Installing ${c.package}…` });
      try {
        if (c.runtime === "npm") await this.npmInstall(c);
        else await this.pipInstall(c);
        this.set({ ...this.status.get(c.id)!, state: "ready", detail: null });
      } catch (e: any) {
        this.set({ ...this.status.get(c.id)!, state: "error", detail: String(e?.message ?? e).slice(0, 400) });
      }
    }
  }

  private npmDir(c: CatalogServer): string {
    return join(this.p.dataDir, "mcp", "npm", c.id);
  }

  private async npmInstall(c: CatalogServer): Promise<void> {
    const s = this.settings();
    const npm = await which(process.platform === "win32" ? "npm.cmd" : "npm") ?? await which("npm");
    if (!npm) throw new Error("npm not found — install Node.js LTS (only needed once, to download this server)");
    const dir = this.npmDir(c);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `flash-mcp-${c.id}`, private: true }));
    const env: Record<string, string> = { ...networkEnv(s) };
    const proxy = s.network.proxy || process.env.https_proxy || process.env.HTTPS_PROXY || "";
    if (proxy) Object.assign(env, { npm_config_proxy: proxy, npm_config_https_proxy: proxy });
    if (s.network.caBundlePath) env.npm_config_cafile = s.network.caBundlePath;
    if (s.mcp.npmRegistry) env.npm_config_registry = s.mcp.npmRegistry;
    const r = await runCapture(npm, ["install", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error", c.package], 600000, dir, env);
    if (r.code !== 0 || !this.npmBin(c)) throw new Error(`npm install failed: ${r.out.trim().slice(-300) || `exit ${r.code}`}`);
    writeFileSync(join(dir, ".installed"), c.package);
  }

  /** Absolute path of the package's bin script (resolved from its package.json). */
  npmBin(c: CatalogServer): string | null {
    const pkgDir = join(this.npmDir(c), "node_modules", ...c.package.split("/"));
    try {
      const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
      const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[c.bin ?? ""] ?? Object.values(pkg.bin ?? {})[0];
      const file = bin ? join(pkgDir, String(bin)) : null;
      return file && existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }

  private async pipInstall(c: CatalogServer): Promise<void> {
    const s = this.settings();
    const vpy = venvPython(join(this.p.dataDir, "mcp", ".venv"));
    if (!existsSync(vpy)) {
      const py = await this.findPython();
      if (!py) throw new Error("Python 3.10+ not found — set its path in Settings → MCP");
      mkdirSync(join(this.p.dataDir, "mcp"), { recursive: true });
      const v = await runCapture(py.cmd, [...py.args, "-m", "venv", join(this.p.dataDir, "mcp", ".venv")], 180000);
      if (v.code !== 0) throw new Error(`venv failed: ${v.out.slice(-300)}`);
    }
    const args = ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", c.package];
    if (s.mcp.pipIndexUrl) args.push("--index-url", s.mcp.pipIndexUrl);
    if (s.network.proxy) args.push("--proxy", s.network.proxy);
    if (s.network.caBundlePath) args.push("--cert", s.network.caBundlePath);
    const r = await runCapture(vpy, args, 900000, undefined, networkEnv(s));
    if (r.code !== 0) throw new Error(`pip failed: ${r.out.trim().slice(-300)}`);
    mkdirSync(join(this.p.dataDir, "mcp", "pip"), { recursive: true });
    writeFileSync(join(this.p.dataDir, "mcp", "pip", `${c.id}.installed`), c.package);
  }

  private catalogReady(c: CatalogServer): boolean {
    if (c.runtime === "npm") return existsSync(join(this.npmDir(c), ".installed")) && !!this.npmBin(c);
    return existsSync(join(this.p.dataDir, "mcp", "pip", `${c.id}.installed`)) && existsSync(venvPython(join(this.p.dataDir, "mcp", ".venv")));
  }

  private catalogSpec(c: CatalogServer, env: string): McpServerSpec | null {
    const s = this.settings();
    const base = { ...networkEnv(s), ...parseEnv(env) };
    if (c.id === "memory") base.MEMORY_FILE_PATH ??= join(this.p.dataDir, "mcp", "memory.jsonl");
    if (c.runtime === "npm") {
      const bin = this.npmBin(c);
      return bin ? { name: c.id, command: this.p.nodeExec, args: [bin, ...(c.args ?? [])], env: { ...this.p.nodeEnv, ...base } } : null;
    }
    const vpy = venvPython(join(this.p.dataDir, "mcp", ".venv"));
    return { name: c.id, command: vpy, args: ["-m", c.module!, ...(c.args ?? [])], env: { PYTHONUTF8: "1", ...base } };
  }

  /** MCP servers to attach for a role: flashmaster-core always, plus the ready servers the role declares. */
  specsFor(role: RoleDef, agentId: string): McpServerSpec[] {
    const s = this.settings();
    const ready = new Set(this.list().filter((x) => x.state === "ready").map((x) => x.id));
    const wanted = new Set(["flashmaster-core", ...role.tools]);
    for (const c of MCP_CATALOG) if (roleMatches(catalogState(c, s.mcp.catalog).roles, role.name)) wanted.add(c.id);
    for (const e of s.mcp.external) if (e.roles && roleMatches(e.roles.split(/[\s,]+/).filter(Boolean), role.name)) wanted.add(e.id);
    const out: McpServerSpec[] = [];
    const bridgeEnv = { FLASH_BRIDGE_URL: this.bridge.url, FLASH_BRIDGE_TOKEN: this.bridge.token, FLASH_AGENT_ID: agentId };
    for (const id of wanted) {
      if (!ready.has(id)) continue;
      if (id === "flashmaster-core" || id === "jazz") {
        out.push({ name: id, command: this.p.nodeExec, args: [this.p.nodeEntry(id)], env: { ...this.p.nodeEnv, ...bridgeEnv } });
      } else if (PY_SERVERS.some((p) => p.id === id)) {
        const root = join(this.p.dataDir, "mcp");
        out.push({ name: id, command: venvPython(join(root, ".venv")), args: [join(root, id, "server.py")], env: { ...networkEnv(s), ...this.pyEnv(id, root) } });
      } else if (MCP_CATALOG.some((c) => c.id === id)) {
        const c = MCP_CATALOG.find((x) => x.id === id)!;
        const spec = this.catalogSpec(c, catalogState(c, s.mcp.catalog).env);
        if (spec) out.push(spec);
      } else {
        const e = s.mcp.external.find((x) => x.id === id);
        if (e) out.push({ name: id, command: e.command, args: splitArgs(e.args), env: parseEnv(e.env) });
      }
    }
    return out;
  }

  private pyEnv(id: string, root: string): Record<string, string> {
    const s = this.settings();
    const sep = process.platform === "win32" ? ";" : ":";
    const paths = [join(root, "pycommon")];
    const env: Record<string, string> = { PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
    if (id === "winidea") {
      if (s.winidea.sdkPath) paths.push(s.winidea.sdkPath);
      Object.assign(env, { WINIDEA_PATH: s.winidea.installPath, WINIDEA_WORKSPACE: s.winidea.workspace });
    }
    if (id === "office") env.FLASH_CLIP_CHARS = String(s.tokens.clipOutputChars);
    if (id === "vector-autosar") {
      Object.assign(env, { CANOE_PATH: s.vector.canoePath, CANOE_VERSION: s.vector.canoeVersion, DAVINCI_CLI: s.vector.davinciCliPath,
        CAPL_INCLUDE: s.vector.caplIncludePaths, FLASH_CLIP_CHARS: String(s.tokens.clipOutputChars) });
    }
    env.PYTHONPATH = paths.join(sep);
    return env;
  }

  private isInstalled(id: string): boolean {
    return existsSync(join(this.p.dataDir, "mcp", id, ".installed")) && existsSync(venvPython(join(this.p.dataDir, "mcp", ".venv")));
  }

  private async findPython(): Promise<{ cmd: string; args: string[] } | null> {
    if (this.python) return { cmd: this.python, args: [] };
    const configured = this.settings().mcp.pythonPath;
    const candidates: { cmd: string; args: string[] }[] = configured ? [{ cmd: configured, args: [] }]
      : process.platform === "win32" ? [{ cmd: "py", args: ["-3"] }, { cmd: "python", args: [] }] : [{ cmd: "python3", args: [] }, { cmd: "python", args: [] }];
    for (const c of candidates) {
      const exe = await which(c.cmd);
      if (!exe) continue;
      const r = await runCapture(exe, [...c.args, "-c", "import sys;print(sys.version_info[:2]>=(3,10))"], 10000);
      if (r.out.includes("True")) return { cmd: exe, args: c.args };
    }
    return null;
  }

  private set(s: McpServerStatus): void {
    this.status.set(s.id, s);
    this.onStatus(this.list());
  }
}

export const venvPython = (venv: string) => (process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"));

function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split(/\r?\n|;/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
