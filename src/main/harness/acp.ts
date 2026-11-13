/**
 * Minimal Agent Client Protocol (ACP) client: JSON-RPC 2.0, newline-delimited over stdio.
 * Works with `copilot --acp`, `opencode acp` and `pi-acp`. Streaming chunks arrive as `session/update`
 * notifications; the turn ends when `session/prompt` resolves.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HarnessId, HarnessStatus, ModelInfo } from "@shared/types";
import { detectExecutable, killTree, spawnTool, splitArgs } from "./process";
import { decidePermission, insideRoot } from "./policy";
import type { HarnessAdapter, HarnessSession, ProbeOptions, PromptAttachment, SessionOptions, ToolKind, TurnResult } from "./types";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Pick the option of a select config whose value/name matches a wanted level (e.g. thinking "medium"). */
export function pickOption(opt: Json | undefined, wanted: string): string | null {
  if (!opt || !wanted) return null;
  const flat: Json[] = (opt.options ?? []).flatMap((o: Json) => (Array.isArray(o.options) ? o.options : [o]));
  const w = wanted.toLowerCase();
  const hit = flat.find((o) => String(o.value).toLowerCase() === w) ?? flat.find((o) => String(o.name ?? "").toLowerCase() === w)
    ?? flat.find((o) => String(o.value).toLowerCase().includes(w) || String(o.name ?? "").toLowerCase().includes(w));
  return hit ? String(hit.value) : null;
}

/** ACP prompt content: text, images inline (when the agent accepts images), files as resource links (agent reads ranges). */
export function promptBlocks(text: string, atts: PromptAttachment[] | undefined, caps: { image: boolean }): Json[] {
  const blocks: Json[] = [{ type: "text", text }];
  const fallback: string[] = [];
  for (const a of atts ?? []) {
    if (a.kind === "image" && caps.image) {
      try { blocks.push({ type: "image", mimeType: a.mime, data: readFileSync(a.path).toString("base64") }); continue; } catch { /* fall back to a link */ }
    }
    blocks.push({ type: "resource_link", uri: pathToFileURL(a.path).href, name: a.name, mimeType: a.mime });
    fallback.push(`- ${a.name}: ${a.path}`);
  }
  // Agents that ignore resource links still get the paths in plain text.
  if (fallback.length) blocks[0] = { type: "text", text: `${text}\n\nAttached files (read only what you need):\n${fallback.join("\n")}` };
  return blocks;
}
import { runCapture } from "./process";

/** Read models from an ACP session response: `models.availableModels` or a select config option of category "model". */
export function modelsFromSession(r: Json | undefined): { models: ModelInfo[]; modelOptionId: string | null } {
  const out: ModelInfo[] = [];
  const cur = r?.models?.currentModelId;
  for (const m of r?.models?.availableModels ?? []) {
    if (m?.modelId) out.push({ id: String(m.modelId), name: String(m.name ?? m.modelId), description: m.description ?? null, current: m.modelId === cur });
  }
  let modelOptionId: string | null = null;
  const opt = (r?.configOptions ?? []).find((o: Json) => o?.type === "select" && (o.category === "model" || o.id === "model"));
  if (opt) {
    modelOptionId = String(opt.id);
    if (!out.length) {
      const flat: Json[] = (opt.options ?? []).flatMap((o: Json) => (Array.isArray(o.options) ? o.options : [o]));
      for (const o of flat) if (o?.value) out.push({ id: String(o.value), name: String(o.name ?? o.value), description: o.description ?? null, current: o.value === opt.currentValue });
    }
  }
  return { models: out.slice(0, 256), modelOptionId };
}

type Json = Record<string, any>;

export class JsonRpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  onRequest: (method: string, params: Json) => Promise<any> = async () => { throw new Error("method not found"); };
  onNotification: (method: string, params: Json) => void = () => {};
  onClose: (reason: string) => void = () => {};

  constructor(private write: (line: string) => void) {}

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { continue; } // tolerate stray log lines on stdout
      void this.dispatch(msg);
    }
  }

  private async dispatch(msg: Json): Promise<void> {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "rpc error"), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {
      try {
        const result = await this.onRequest(msg.method, msg.params ?? {});
        this.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: result ?? null }));
      } catch (e: any) {
        this.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }));
      }
      return;
    }
    if (msg.method) this.onNotification(msg.method, msg.params ?? {});
  }

  request<T = any>(method: string, params: Json): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params: Json): void {
    this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  failAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
    this.onClose(reason);
  }
}

const KINDS: ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];
const asKind = (k: unknown): ToolKind => (KINDS.includes(k as ToolKind) ? (k as ToolKind) : "other");

export class AcpSession implements HarnessSession {
  sessionId: string | null = null;
  models: ModelInfo[] = [];
  private seenDiffs = new Set<string>();
  private toolTitles = new Map<string, string>();
  /** Slash commands the agent advertised (available_commands_update), without the leading "/". */
  commands: string[] = [];
  private commandWaiters: (() => void)[] = [];
  private modelOptionId: string | null = null;
  private caps = { image: false };
  private child: ChildProcess;
  private peer: JsonRpcPeer;
  private exited = false;
  private stderrTail = "";

  constructor(command: string, args: string[], private o: SessionOptions) {
    this.child = spawnTool(command, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.peer = new JsonRpcPeer((line) => { if (!this.exited) this.child.stdin?.write(line + "\n"); });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (d: string) => this.peer.feed(d));
    this.child.stderr?.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    this.child.on("error", (e) => { this.exited = true; this.peer.failAll(`failed to start: ${e.message}`); });
    this.child.on("exit", (code) => { this.exited = true; this.peer.failAll(`harness exited (${code}). ${this.stderrTail.trim().slice(-400)}`); });
    this.peer.onNotification = (m, p) => this.onNotification(m, p);
    this.peer.onRequest = (m, p) => this.onRequest(m, p);
  }

  get alive(): boolean {
    return !this.exited;
  }

  async init(): Promise<void> {
    const init = await this.peer.request<Json>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: !this.o.policy.readOnly }, terminal: false },
      clientInfo: { name: "TheFlashMaster", version: "0.1.0" },
    });
    this.caps.image = !!init?.agentCapabilities?.promptCapabilities?.image;
    const mcpServers = this.o.mcpServers.map((s) => ({
      name: s.name, command: s.command, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
    }));
    let resp: Json | undefined;
    if (this.o.resumeSessionId) {
      try {
        resp = await this.peer.request("session/load", { sessionId: this.o.resumeSessionId, cwd: this.o.cwd, mcpServers });
        this.sessionId = this.o.resumeSessionId;
      } catch { /* agent may not support loadSession — fall through to a new session */ }
    }
    if (!this.sessionId) {
      resp = await this.peer.request<Json>("session/new", { cwd: this.o.cwd, mcpServers });
      this.sessionId = resp.sessionId;
    }
    const found = modelsFromSession(resp);
    this.models = found.models;
    this.modelOptionId = found.modelOptionId;
    if (this.o.model) {
      // Newer agents expose the model as a session config option; older ones use the (unstable) set_model method.
      if (this.modelOptionId) {
        await this.peer.request("session/set_config_option", { sessionId: this.sessionId, configId: this.modelOptionId, value: this.o.model })
          .catch(() => this.peer.request("session/set_model", { sessionId: this.sessionId, modelId: this.o.model }).catch(() => undefined));
      } else {
        await this.peer.request("session/set_model", { sessionId: this.sessionId, modelId: this.o.model }).catch(() => undefined);
      }
    }
    // Reasoning effort: ACP agents expose it as a select config option of category "thought_level".
    if (this.o.thinking) {
      const opt = (resp?.configOptions ?? []).find((o: Json) => o?.type === "select" && (o.category === "thought_level" || /thought|reason|effort|think/i.test(String(o.id))));
      const value = pickOption(opt, this.o.thinking);
      if (opt && value) await this.peer.request("session/set_config_option", { sessionId: this.sessionId, configId: opt.id, value }).catch(() => undefined);
    }
  }

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    try {
      const r = await this.peer.request<Json>("session/prompt", { sessionId: this.sessionId, prompt: promptBlocks(text, attachments, this.caps) });
      const u = r?.usage ?? r?._meta?.usage;
      const usage = u ? { tokensIn: Number(u.inputTokens ?? u.input_tokens ?? 0), tokensOut: Number(u.outputTokens ?? u.output_tokens ?? 0) } : undefined;
      return { stopReason: r?.stopReason ?? "end_turn", usage };
    } catch (e: any) {
      return { stopReason: "error", error: String(e?.message ?? e) };
    }
  }

  /** Resolves once the agent has advertised its slash commands, or after `ms`. */
  waitForCommands(ms: number): Promise<string[]> {
    if (this.commands.length) return Promise.resolve(this.commands);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(this.commands), ms);
      this.commandWaiters.push(() => { clearTimeout(t); resolve(this.commands); });
    });
  }

  async cancel(): Promise<void> {
    if (this.sessionId && this.alive) this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  close(): void {
    this.exited = true;
    killTree(this.child);
  }

  private onNotification(method: string, p: Json): void {
    if (method !== "session/update") return;
    const u = p.update ?? {};
    switch (u.sessionUpdate) {
      case "available_commands_update":
        this.commands = (u.availableCommands ?? []).map((c: Json) => String(c?.name ?? "").replace(/^\//, "")).filter(Boolean);
        for (const w of this.commandWaiters.splice(0)) w();
        break;
      case "agent_message_chunk":
        if (u.content?.type === "text") this.o.onEvent({ type: "text", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.o.onEvent({ type: "thought", text: u.content.text });
        break;
      case "tool_call":
      case "tool_call_update":
        if (u.title || u.status || u.sessionUpdate === "tool_call" || u.content || u.rawOutput || u.rawInput) {
          const prev = this.toolTitles.get(u.toolCallId);
          const title = u.title ?? prev ?? u.toolCallId ?? "tool";
          if (u.toolCallId && u.title) this.toolTitles.set(u.toolCallId, u.title);
          this.o.onEvent({ type: "tool", id: u.toolCallId, title, status: u.status ?? (u.sessionUpdate === "tool_call" ? "pending" : ""), kind: asKind(u.kind),
            input: toolInputText(u.rawInput), output: toolOutputText(u.content, u.rawOutput) });
        }
        // File edits come as diff content (ACP ToolCallContent "diff": path, oldText, newText)
        for (const c of Array.isArray(u.content) ? u.content : []) {
          if (c?.type !== "diff" || typeof c.path !== "string" || typeof c.newText !== "string") continue;
          const key = `${u.toolCallId}|${c.path}|${c.newText.length}`;
          if (this.seenDiffs.has(key)) continue;
          this.seenDiffs.add(key);
          this.o.onEvent({ type: "diff", path: c.path, oldText: typeof c.oldText === "string" ? c.oldText : null, newText: c.newText });
        }
        break;
      default: {
        const t = u.content?.text ?? (Array.isArray(u.content) ? u.content.map((c: Json) => c?.text ?? c?.content?.text ?? "").join("") : "");
        if (typeof t === "string" && t) this.o.onEvent({ type: "log", text: t });
        break;
      }
      case "plan":
        this.o.onEvent({ type: "plan", entries: (u.entries ?? []).map((e: Json) => ({ title: String(e.content ?? ""),
          status: ["pending", "in_progress", "completed", "failed"].includes(e.status) ? e.status : "pending" })) });
        break;
    }
  }

  private async onRequest(method: string, p: Json): Promise<any> {
    const root = this.o.policy.projectRoot;
    const allowed = (path: string) => insideRoot(root, path) || (this.o.policy.extraRoots ?? []).some((r) => insideRoot(r, path));
    switch (method) {
      case "session/request_permission": {
        const tc = p.toolCall ?? {};
        const kind = asKind(tc.kind);
        const detail = JSON.stringify(tc.rawInput ?? tc.locations ?? {}).slice(0, 500);
        const title = String(tc.title ?? "tool call");
        let decision = decidePermission(this.o.policy, kind, `${title} ${detail}`);
        if (decision === "ask") decision = (await this.o.askPermission({ title, kind, detail })) ? "allow" : "deny";
        const options: Json[] = p.options ?? [];
        const pick = options.find((o) => o.kind === (decision === "allow" ? "allow_once" : "reject_once"))
          ?? options.find((o) => String(o.kind).startsWith(decision === "allow" ? "allow" : "reject"));
        return pick ? { outcome: { outcome: "selected", optionId: pick.optionId } } : { outcome: { outcome: "cancelled" } };
      }
      case "fs/read_text_file": {
        if (!allowed(p.path)) throw new Error("path outside project folder");
        const text = await readFile(p.path, "utf8");
        if (p.line || p.limit) {
          const lines = text.split("\n");
          const start = Math.max(0, (p.line ?? 1) - 1);
          return { content: lines.slice(start, p.limit ? start + p.limit : undefined).join("\n") };
        }
        return { content: text };
      }
      case "fs/write_text_file": {
        if (this.o.policy.readOnly) throw new Error("read-only mode is on");
        if (!insideRoot(root, p.path)) throw new Error("path outside project folder");
        await mkdir(dirname(p.path), { recursive: true });
        const before = await readFile(p.path, "utf8").catch(() => null);
        await writeFile(p.path, p.content, "utf8");
        if (before !== p.content) this.o.onEvent({ type: "diff", path: p.path, oldText: before, newText: p.content });
        return null;
      }
      default:
        throw new Error(`unsupported method ${method}`);
    }
  }
}

export class AcpAdapter implements HarnessAdapter {
  readonly protocol = "acp" as const;
  constructor(readonly id: HarnessId, readonly label: string, private candidates: string[], private baseArgs: string[],
    private hint: string) {}

  detect(pathOverride: string): Promise<HarnessStatus> {
    return detectExecutable({ id: this.id, label: this.label, protocol: "acp", candidates: this.candidates, pathOverride, hint: this.hint });
  }

  /** Start a throw-away ACP session just to read the advertised models, then close it. */
  async listModels(p: ProbeOptions): Promise<ModelInfo[]> {
    const s = new AcpSession(p.executable ?? this.candidates[0]!, [...this.baseArgs, ...splitArgs(p.extraArgs)], {
      cwd: p.cwd, model: null, extraArgs: "", executable: p.executable, mcpServers: [], env: p.env, resumeSessionId: null,
      policy: { approval: "ask", readOnly: true, blocked: [], projectRoot: null }, onEvent: () => {}, askPermission: async () => false,
    });
    try {
      await withTimeout(s.init(), 45000, `${this.label} did not report models within 45s`);
      if (s.models.length) return s.models;
    } finally {
      s.close();
    }
    // OpenCode also lists models on its CLI (provider/model per line).
    if (this.id === "opencode") {
      const r = await runCapture(p.executable ?? "opencode", ["models"], 30000, p.cwd);
      return r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/[\w.:@-]+$/.test(l)).slice(0, 256).map((id) => ({ id, name: id }));
    }
    return [];
  }

  /**
   * Run one slash command (e.g. "usage") in a throw-away session and return the text it printed.
   * With `onlyIfAdvertised` the command is sent only when the agent lists it, so it is handled locally by the CLI
   * and never reaches a model (no premium request is spent).
   */
  async runCommand(p: ProbeOptions, command: string, onlyIfAdvertised: boolean): Promise<{ advertised: boolean; commands: string[]; text: string }> {
    let text = "";
    let thought = "";
    const s = new AcpSession(p.executable ?? this.candidates[0]!, [...this.baseArgs, ...splitArgs(p.extraArgs)], {
      cwd: p.cwd, model: null, extraArgs: "", executable: p.executable, mcpServers: [], env: p.env, resumeSessionId: null,
      policy: { approval: "ask", readOnly: true, blocked: [], projectRoot: null },
      onEvent: (e) => { if (e.type === "text" || e.type === "log") text += e.text; else if (e.type === "thought" && !text) thought += e.text; },
      askPermission: async () => false,
    });
    try {
      await withTimeout(s.init(), 45000, `${this.label} did not start within 45s`);
      const commands = await s.waitForCommands(4000);
      const advertised = commands.includes(command);
      if (!advertised && onlyIfAdvertised) return { advertised, commands, text: "" };
      const r = await withTimeout(s.prompt(`/${command}`), 60000, `/${command} did not answer within 60s`);
      if (r.stopReason === "error") throw new Error(r.error ?? `/${command} failed`);
      return { advertised, commands, text: text || thought };
    } finally {
      s.close();
    }
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    const exe = o.executable ?? this.candidates[0]!;
    const s = new AcpSession(exe, [...this.baseArgs, ...splitArgs(o.extraArgs)], o);
    try {
      await withTimeout(s.init(), 60000, `${this.label} did not finish ACP initialisation within 60s`);
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The command line or arguments of an ACP tool call (rawInput), as shown when the call is expanded. */
export function toolInputText(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  if (typeof raw === "string") return raw;
  const r = raw as Record<string, unknown>;
  const cmd = r.command ?? r.cmd ?? r.commandLine;
  if (Array.isArray(cmd)) return cmd.map(String).join(" ");
  if (typeof cmd === "string") return [cmd, ...(Array.isArray(r.args) ? r.args.map(String) : [])].join(" ");
  try { const j = JSON.stringify(raw, null, 1); return j === "{}" ? undefined : j; } catch { return undefined; }
}

/** Text output of an ACP tool call: content blocks ("content" text, diffs as a summary) and rawOutput. */
export function toolOutputText(content: unknown, raw: unknown): string | undefined {
  const parts: string[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    const x = c as Record<string, any>;
    if (x?.type === "content" && x.content?.type === "text" && typeof x.content.text === "string") parts.push(x.content.text);
    else if (x?.type === "text" && typeof x.text === "string") parts.push(x.text);
    else if (x?.type === "diff" && typeof x.path === "string") parts.push(`(edited ${x.path})`);
  }
  if (!parts.length && raw != null) {
    if (typeof raw === "string") parts.push(raw);
    else {
      const r = raw as Record<string, unknown>;
      const t = [r.output, r.stdout, r.stderr, r.content, r.result, r.text].filter((v) => typeof v === "string" && v) as string[];
      if (t.length) parts.push(t.join("\n"));
      else { try { parts.push(JSON.stringify(raw, null, 1)); } catch { /* ignore */ } }
    }
  }
  const out = parts.join("\n");
  return out ? out : undefined;
}
