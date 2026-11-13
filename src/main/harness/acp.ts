/**
 * Minimal Agent Client Protocol (ACP) client: JSON-RPC 2.0, newline-delimited over stdio.
 * Works with `copilot --acp`, `opencode acp` and `pi-acp`. Streaming chunks arrive as `session/update`
 * notifications; the turn ends when `session/prompt` resolves.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { HarnessId, HarnessStatus } from "@shared/types";
import { detectExecutable, killTree, spawnTool, splitArgs } from "./process";
import { decidePermission, insideRoot } from "./policy";
import type { HarnessAdapter, HarnessSession, SessionOptions, ToolKind, TurnResult } from "./types";

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
    await this.peer.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: !this.o.policy.readOnly }, terminal: false },
      clientInfo: { name: "TheFlashMaster", version: "0.1.0" },
    });
    const mcpServers = this.o.mcpServers.map((s) => ({
      name: s.name, command: s.command, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })),
    }));
    if (this.o.resumeSessionId) {
      try {
        await this.peer.request("session/load", { sessionId: this.o.resumeSessionId, cwd: this.o.cwd, mcpServers });
        this.sessionId = this.o.resumeSessionId;
      } catch { /* agent may not support loadSession — fall through to a new session */ }
    }
    if (!this.sessionId) {
      const r = await this.peer.request<{ sessionId: string }>("session/new", { cwd: this.o.cwd, mcpServers });
      this.sessionId = r.sessionId;
    }
    if (this.o.model) {
      // Unstable in the spec; harnesses that do not support it simply reject — model can still be set via args.
      await this.peer.request("session/set_model", { sessionId: this.sessionId, modelId: this.o.model }).catch(() => undefined);
    }
  }

  async prompt(text: string): Promise<TurnResult> {
    try {
      const r = await this.peer.request<Json>("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
      const u = r?.usage ?? r?._meta?.usage;
      const usage = u ? { tokensIn: Number(u.inputTokens ?? u.input_tokens ?? 0), tokensOut: Number(u.outputTokens ?? u.output_tokens ?? 0) } : undefined;
      return { stopReason: r?.stopReason ?? "end_turn", usage };
    } catch (e: any) {
      return { stopReason: "error", error: String(e?.message ?? e) };
    }
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
      case "agent_message_chunk":
        if (u.content?.type === "text") this.o.onEvent({ type: "text", text: u.content.text });
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.o.onEvent({ type: "thought", text: u.content.text });
        break;
      case "tool_call":
      case "tool_call_update":
        this.o.onEvent({ type: "tool", title: u.title ?? u.toolCallId ?? "tool", status: u.status ?? "pending", kind: asKind(u.kind) });
        break;
      case "plan":
        this.o.onEvent({ type: "plan", entries: (u.entries ?? []).map((e: Json) => ({ title: String(e.content ?? ""),
          status: ["pending", "in_progress", "completed", "failed"].includes(e.status) ? e.status : "pending" })) });
        break;
    }
  }

  private async onRequest(method: string, p: Json): Promise<any> {
    const root = this.o.policy.projectRoot;
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
        if (!insideRoot(root, p.path)) throw new Error("path outside project folder");
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
        await writeFile(p.path, p.content, "utf8");
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
