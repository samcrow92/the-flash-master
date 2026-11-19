/**
 * Vector's official MCP servers (Vector Informatik): the CANoe MCP Server that ships with CANoe 20 SP2 and later, and
 * the CANoe Documentation MCP Server from the free CANoe AI Package (vector.com/canoe-ai). Both are local, licensed
 * Windows installs, so the app does not bundle them: it finds them (Vector's own mcp.json, or an MCP executable in
 * the CANoe / AI Package folders), or uses the endpoint set in Settings → Integrations → Vector toolchain.
 *
 * The app is the MCP client. It connects once (stdio or Streamable HTTP), lists the tools and registers them on the
 * bridge as the "vector" set, prefixed (canoe_…, canoe_docs_…). From there every agent gets them the same way it gets
 * Flash Master's own tools: ACP harnesses through the bundled `vector` forwarder, text mode, Pi and GitLab Duo
 * through TOOL lines. One connection to CANoe serves all agents, so parallel specialists don't each start a server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { McpServerStatus } from "@shared/types";
import type { Settings } from "@shared/settings";
import type { ToolDef } from "./bridge";
import { splitArgs } from "./harness/process";

export interface VectorServerConfig {
  id: string; // status id, e.g. vector-canoe
  label: string;
  prefix: string; // tool-name prefix, e.g. canoe
  url?: string; // Streamable HTTP endpoint
  command?: string; // stdio
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  source: string; // where the config came from (shown in Settings)
}

export interface McpTool { name: string; description?: string; inputSchema?: Record<string, unknown> }

/** Settings value → server: an http(s) URL is a Streamable HTTP endpoint, anything else a command line. */
export function parseEndpoint(id: string, label: string, prefix: string, value: string, source = "Settings"): VectorServerConfig | null {
  const v = value.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return { id, label, prefix, url: v, source };
  const parts = splitArgs(v);
  if (!parts.length) return null;
  return { id, label, prefix, command: parts[0], args: parts.slice(1), source };
}

/** Lowercase id usable in a tool name: "CANoe Docs" → canoe_docs. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "vector";
}

/** Prefixed tool name within the 64-character, [A-Za-z0-9_-] limit most clients enforce. */
export function toolName(prefix: string, name: string): string {
  const clean = name.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = clean.toLowerCase().startsWith(`${prefix}_`) ? clean : `${prefix}_${clean}`;
  return full.slice(0, 64);
}

/** Which official server a name from Vector's mcp.json is: the docs server or CANoe itself. */
function classify(key: string): { id: string; label: string; prefix: string } {
  const k = key.toLowerCase();
  if (/doc|help|rag/.test(k)) return { id: "vector-canoe-docs", label: "Vector CANoe Documentation MCP Server", prefix: "canoe_docs" };
  if (/canoe/.test(k)) return { id: "vector-canoe", label: "Vector CANoe MCP Server", prefix: "canoe" };
  return { id: `vector-${slug(key)}`, label: `Vector MCP: ${key}`, prefix: slug(key) };
}

/**
 * Read an mcp.json in the VS Code shape ({ servers: { name: { type, url | command, args, env, headers } } }) or the
 * Claude / Cursor shape ({ mcpServers: { … } }) — the formats a vendor's AI package hands to MCP clients.
 * ${env:NAME} and %NAME% are expanded; ${workspaceFolder} becomes the file's folder.
 */
export function readMcpJson(path: string, env: NodeJS.ProcessEnv = process.env): VectorServerConfig[] {
  let doc: any;
  try { doc = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/^\s*\/\/.*$/gm, "")); } catch { return []; }
  const servers = doc?.servers ?? doc?.mcpServers ?? doc?.mcp?.servers ?? {};
  const expand = (s: unknown): string => String(s ?? "")
    .replace(/\$\{workspaceFolder\}/g, basename(dirname(path)) === ".vscode" ? dirname(dirname(path)) : dirname(path))
    .replace(/\$\{env:([^}]+)\}/g, (_, n) => env[n] ?? "")
    .replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, n) => env[n] ?? m);
  const out: VectorServerConfig[] = [];
  const used = new Set<string>();
  for (const [key, raw] of Object.entries<any>(servers)) {
    if (!raw || typeof raw !== "object" || raw.disabled) continue;
    const c = classify(key);
    let id = c.id;
    for (let i = 2; used.has(id); i++) id = `${c.id}-${i}`;
    used.add(id);
    const prefix = id === c.id ? c.prefix : `${c.prefix}${id.slice(c.id.length).replace(/-/g, "_")}`;
    const base = { id, label: c.label, prefix, source: path };
    const env2 = raw.env && typeof raw.env === "object" ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, expand(v)])) : undefined;
    if (raw.url || raw.serverUrl) {
      const headers = raw.headers && typeof raw.headers === "object" ? Object.fromEntries(Object.entries(raw.headers).map(([k, v]) => [k, expand(v)])) : undefined;
      out.push({ ...base, url: expand(raw.url ?? raw.serverUrl), headers });
    } else if (raw.command) {
      out.push({ ...base, command: expand(raw.command), args: Array.isArray(raw.args) ? raw.args.map(expand) : [], env: env2 });
    }
  }
  return out;
}

/** Folders where Vector installs CANoe and where the CANoe AI Package is usually unpacked (Windows). */
export function candidateDirs(s: Settings["vector"], env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [s.canoePath, s.mcpConfigPath && !/\.json$/i.test(s.mcpConfigPath) ? s.mcpConfigPath : ""];
  if (process.platform === "win32" || env.FLASH_VECTOR_SCAN_ROOTS) {
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData, env.PUBLIC && join(env.PUBLIC, "Documents"), env.USERPROFILE && join(env.USERPROFILE, "Documents"), env.LOCALAPPDATA, env.USERPROFILE && join(env.USERPROFILE, "Downloads")]) {
      if (!root) continue;
      for (const name of safeList(root)) if (/vector|canoe/i.test(name)) dirs.push(join(root, name));
    }
    for (const extra of (env.FLASH_VECTOR_SCAN_ROOTS ?? "").split(/[;\n]/)) if (extra.trim()) dirs.push(extra.trim());
  }
  return [...new Set(dirs.filter((d): d is string => !!d && existsSync(d)))];
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * Look for Vector's MCP servers below the given folders (bounded: depth 4, 4000 entries): mcp.json files that name a
 * CANoe server, and executables whose name says MCP (e.g. a *Mcp*.exe next to CANoe64.exe).
 */
export function discover(dirs: string[], maxDepth = 4, budget = 4000): { configs: string[]; executables: string[] } {
  const configs: string[] = [], executables: string[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    for (const name of safeList(dir)) {
      if (++seen > budget) return;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (depth < maxDepth && !/^(node_modules|\.git|__pycache__|Logs?|Temp|Cache)$/i.test(name)) walk(p, depth + 1);
      } else if (/^mcp\.json$|^\.?mcp[._-]?servers?\.json$|mcp[._-]?config\.json$/i.test(name)) {
        try { if (/canoe|vector/i.test(readFileSync(p, "utf8"))) configs.push(p); } catch { /* unreadable */ }
      } else if (/mcp/i.test(name) && /\.(exe|cmd|bat)$/i.test(name) && !/uninst|setup|install/i.test(name)) {
        executables.push(p);
      }
    }
  };
  for (const d of dirs) walk(d, 0);
  return { configs: [...new Set(configs)], executables: [...new Set(executables)] };
}

/** The servers to connect: explicit settings first, then Vector's mcp.json, then discovered executables. */
export function resolveServers(s: Settings["vector"], scan: () => { configs: string[]; executables: string[] }): VectorServerConfig[] {
  const out = new Map<string, VectorServerConfig>();
  const add = (c: VectorServerConfig | null) => { if (c && !out.has(c.id)) out.set(c.id, c); };
  add(parseEndpoint("vector-canoe", "Vector CANoe MCP Server", "canoe", s.canoeMcp));
  add(parseEndpoint("vector-canoe-docs", "Vector CANoe Documentation MCP Server", "canoe_docs", s.canoeDocsMcp));
  if (s.mcpConfigPath && /\.json$/i.test(s.mcpConfigPath)) for (const c of readMcpJson(s.mcpConfigPath)) add(c);
  if (s.mcpAutoDetect) {
    const found = scan();
    for (const f of found.configs) for (const c of readMcpJson(f)) add(c);
    for (const exe of found.executables) {
      const c = classify(basename(exe).replace(/\.(exe|cmd|bat)$/i, ""));
      add({ ...c, command: exe, args: [], source: exe });
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// Minimal MCP client (no SDK: the main bundle inlines dependencies, and this needs only initialize/list/call).

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

class StdioTransport implements Transport {
  private child: ChildProcess;
  private buf = "";
  private err = "";
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(c: VectorServerConfig, baseEnv: Record<string, string>) {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(c.command!);
    this.child = spawn(c.command!, c.args ?? [], { env: { ...baseEnv, ...c.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell, cwd: existsSync(dirname(c.command!)) ? dirname(c.command!) : undefined });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
        if (p && (m.result !== undefined || m.error)) { this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message ?? "MCP error")); else p.resolve(m.result); }
      }
    });
    this.child.stderr!.on("data", (d) => { this.err = (this.err + d).slice(-1500); });
    const fail = (why: string) => { for (const p of this.pending.values()) p.reject(new Error(why)); this.pending.clear(); };
    this.child.on("error", (e) => fail(`cannot start ${c.command}: ${e.message}`));
    this.child.on("exit", (code) => fail(`server exited (${code})${this.err ? `: ${this.err.trim().slice(-300)}` : ""}`));
  }
  get alive(): boolean { return this.child.exitCode === null && !this.child.killed; }
  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async notify(method: string, params?: unknown): Promise<void> {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
  }
  close(): void { try { this.child.kill(); } catch { /* gone */ } }
}

/** MCP Streamable HTTP: POST JSON-RPC, the answer comes back as JSON or as an SSE stream; Mcp-Session-Id is kept. */
class HttpTransport implements Transport {
  private session: string | null = null;
  private seq = 0;
  private protocol = "2025-06-18";
  constructor(private c: VectorServerConfig, private fetchImpl: typeof fetch = fetch) {}
  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.protocol,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}), ...this.c.headers };
  }
  async request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = ++this.seq;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.c.url!, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: ctl.signal });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.session = sid;
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.c.url}`);
      const type = res.headers.get("content-type") ?? "";
      const msgs: any[] = [];
      if (type.includes("text/event-stream")) {
        const text = await readSseUntil(res, id);
        for (const m of text) msgs.push(m);
      } else {
        const body = await res.json();
        msgs.push(...(Array.isArray(body) ? body : [body]));
      }
      const m = msgs.find((x) => x && x.id === id);
      if (!m) throw new Error(`no answer to ${method}`);
      if (m.error) throw new Error(m.error.message ?? "MCP error");
      if (method === "initialize" && m.result?.protocolVersion) this.protocol = m.result.protocolVersion;
      return m.result;
    } catch (e: any) {
      if (e?.name === "AbortError") throw new Error(`no answer to ${method} within ${Math.round(timeoutMs / 1000)}s`, { cause: e });
      throw e;
    } finally { clearTimeout(t); }
  }
  async notify(method: string, params?: unknown): Promise<void> {
    await this.fetchImpl(this.c.url!, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) })
      .then((r) => r.body?.cancel()).catch(() => undefined);
  }
  close(): void {
    if (this.session) void this.fetchImpl(this.c.url!, { method: "DELETE", headers: this.headers() }).catch(() => undefined);
  }
}

/** Read SSE events until the JSON-RPC answer with this id arrives (then stop reading). */
async function readSseUntil(res: Response, id: number): Promise<any[]> {
  const out: any[] = [];
  const reader = res.body?.getReader();
  if (!reader) return out;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
      const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try { const m = JSON.parse(data); out.push(...(Array.isArray(m) ? m : [m])); } catch { /* not JSON */ }
      if (out.some((m) => m?.id === id)) { void reader.cancel().catch(() => undefined); return out; }
    }
    if (done) return out;
  }
}

/** The tool ran and reported a failure (as opposed to a lost connection). */
export class ToolError extends Error {}

export class McpClient {
  private t: Transport | null = null;
  tools: McpTool[] = [];
  serverName = "";
  constructor(readonly c: VectorServerConfig, private baseEnv: Record<string, string>, private fetchImpl?: typeof fetch) {}

  get connected(): boolean { return !!this.t && (!(this.t instanceof StdioTransport) || this.t.alive); }

  async connect(timeoutMs = 20000): Promise<McpTool[]> {
    this.close();
    const t: Transport = this.c.url ? new HttpTransport(this.c, this.fetchImpl) : new StdioTransport(this.c, this.baseEnv);
    try {
      const init = await t.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "TheFlashMaster", version: "0.1.0" } }, timeoutMs);
      this.serverName = String(init?.serverInfo?.name ?? "");
      await t.notify("notifications/initialized");
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await t.request("tools/list", cursor ? { cursor } : {}, timeoutMs);
        tools.push(...(r?.tools ?? []));
        cursor = r?.nextCursor;
        if (!cursor) break;
      }
      this.t = t;
      this.tools = tools;
      return tools;
    } catch (e) {
      t.close();
      throw e;
    }
  }

  async call(name: string, args: unknown, timeoutMs: number): Promise<unknown> {
    if (!this.connected) await this.connect();
    const r = await this.t!.request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
    const text = resultText(r);
    if (r?.isError) throw new ToolError(text || "tool failed");
    return text;
  }

  close(): void {
    this.t?.close();
    this.t = null;
  }
}

/** MCP tool result → compact text for the agent (text parts, structured content, placeholders for binary parts). */
export function resultText(r: any): string {
  const parts: string[] = [];
  for (const c of r?.content ?? []) {
    if (c?.type === "text") parts.push(String(c.text ?? ""));
    else if (c?.type === "resource") parts.push(String(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`));
    else if (c?.type === "resource_link") parts.push(`[resource ${c.uri ?? ""}${c.name ? ` ${c.name}` : ""}]`);
    else if (c?.type) parts.push(`[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`);
  }
  if (!parts.length && r?.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------

export interface VectorMcpDeps {
  settings: () => Settings;
  baseEnv: () => Record<string, string>;
  register: (defs: ToolDef[]) => void;
  unregister: (set: ToolDef["set"]) => void;
  onStatus: (list: McpServerStatus[]) => void;
  scan?: () => { configs: string[]; executables: string[] };
  fetchImpl?: typeof fetch;
}

/** Connects Vector's MCP servers and publishes their tools as the bridge's "vector" set. */
export class VectorMcp {
  private clients = new Map<string, McpClient>();
  private status = new Map<string, McpServerStatus>();
  private key = "";
  private running: Promise<void> | null = null;

  constructor(private d: VectorMcpDeps) {}

  list(): McpServerStatus[] { return [...this.status.values()]; }

  /** Number of tools currently published. */
  toolCount(): number {
    const off = new Set(this.disabled());
    return [...this.clients.values()].reduce((n, c) => n + (c.connected && !off.has(c.c.id) ? c.tools.length : 0), 0);
  }

  /** (Re)connect when the Vector settings changed, or always with force. */
  refresh(force = false): Promise<void> {
    const v = this.d.settings().vector;
    const key = JSON.stringify([v.mcpEnabled, v.mcpAutoDetect, v.mcpConfigPath, v.canoeMcp, v.canoeDocsMcp, v.canoePath, this.disabled()]);
    if (!force && key === this.key) return this.running ?? Promise.resolve();
    this.key = key;
    const run = (this.running ?? Promise.resolve()).then(() => this.connectAll()).catch(() => undefined);
    this.running = run;
    return run;
  }

  private async connectAll(): Promise<void> {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
    this.status.clear();
    this.d.unregister("vector");
    const s = this.d.settings();
    if (!s.vector.mcpEnabled) { this.emit(); return; }
    const configs = resolveServers(s.vector, this.d.scan ?? (() => discover(candidateDirs(s.vector))));
    if (!configs.length) {
      this.status.set("vector-canoe", { id: "vector-canoe", label: "Vector CANoe MCP Server", kind: "vendor", state: "missing",
        detail: "Not found: needs CANoe 20 SP2 or later (and the CANoe AI Package for the docs server). Set the endpoint in Settings → Integrations → Vector toolchain." });
      this.emit();
      return;
    }
    for (const c of configs) this.status.set(c.id, { id: c.id, label: c.label, kind: "vendor", state: "installing", detail: `Connecting… (${describe(c)})` });
    this.emit();
    await Promise.all(configs.map(async (c) => {
      const client = new McpClient(c, this.d.baseEnv(), this.d.fetchImpl);
      try {
        const tools = await client.connect();
        this.clients.set(c.id, client);
        this.status.set(c.id, { id: c.id, label: c.label, kind: "vendor", state: "ready", detail: `${tools.length} tool${tools.length === 1 ? "" : "s"} · ${describe(c)}` });
      } catch (e: any) {
        this.status.set(c.id, { id: c.id, label: c.label, kind: "vendor", state: "error",
          detail: `${String(e?.message ?? e).slice(0, 300)} · ${describe(c)}${c.id === "vector-canoe" ? " · is CANoe running?" : ""}` });
      }
    }));
    this.publish();
    this.emit();
  }

  /** Vector servers switched off in Settings → MCP servers. */
  private disabled(): string[] {
    return this.d.settings().mcp.disabled.filter((x) => x.startsWith("vector-")).sort();
  }

  private publish(): void {
    const defs: ToolDef[] = [];
    const off = new Set(this.disabled());
    const taken = new Set<string>();
    const clip = this.d.settings().tokens.clipOutputChars;
    for (const client of this.clients.values()) {
      if (off.has(client.c.id)) continue;
      for (const tool of client.tools) {
        let name = toolName(client.c.prefix, tool.name);
        for (let i = 2; taken.has(name); i++) name = `${name.slice(0, 60)}_${i}`;
        taken.add(name);
        defs.push({
          set: "vector", name,
          description: `[${client.c.label}] ${tool.description ?? tool.name}`.slice(0, 2000),
          inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
          handler: async (args) => {
            try {
              const out = String(await client.call(tool.name, args, 10 * 60_000));
              return clip > 0 && out.length > clip ? `${out.slice(0, clip)}\n… [clipped ${out.length - clip} chars]` : out;
            } catch (e: any) {
              // A restarted CANoe drops the session: reconnect once and retry.
              if (!(e instanceof ToolError) && /exited|ECONNREFUSED|ECONNRESET|fetch failed|HTTP 404|cannot start/i.test(String(e?.message ?? e))) {
                await client.connect();
                return String(await client.call(tool.name, args, 10 * 60_000));
              }
              throw e;
            }
          },
        });
      }
    }
    this.d.register(defs);
  }

  private emit(): void { this.d.onStatus(this.list()); }

  close(): void {
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
  }
}

function describe(c: VectorServerConfig): string {
  return c.url ? c.url : basename(c.command ?? "");
}
