/**
 * Pi coding agent adapter — native RPC mode: `pi --mode rpc` (JSONL over stdio, LF-delimited; see Pi's docs/rpc.md).
 *  - prompt → {type:"prompt"}; streaming via message_update/text_delta; turn ends at agent_end
 *  - abort → {type:"abort"}; session continuity via `--session <sessionFile>` (from get_state)
 *  - usage from assistant message_end `usage` (input/output/cache); read-only → `--tools read,grep,find,ls`
 *  - Pi has no MCP by design, so TheFlashMaster MCP tools (delegation, progress, Vector, …) are not attached.
 */
import type { ChildProcess } from "node:child_process";
import type { HarnessStatus, ModelInfo } from "@shared/types";
import { detectExecutable, killTree, spawnTool, splitArgs } from "./process";
import type { HarnessAdapter, HarnessSession, ProbeOptions, PromptAttachment, SessionOptions, ToolKind, TurnResult } from "./types";
import { readFileSync } from "node:fs";

type Json = Record<string, any>;

const TOOL_KIND: Record<string, ToolKind> = { bash: "execute", read: "read", write: "edit", edit: "edit", grep: "search", find: "search", ls: "search" };

export class PiSession implements HarnessSession {
  sessionId: string | null = null;
  private child: ChildProcess;
  private buf = "";
  private exited = false;
  private stderrTail = "";
  private nextId = 1;
  private toolTitles = new Map<string, string>(); // tool_execution_end carries no args: reuse the title from start
  private pending = new Map<string, (r: Json) => void>();
  private pendingSteers = 0;
  private userMsgsThisTurn = 0;
  private turn: { resolve: (r: TurnResult) => void; tokensIn: number; tokensOut: number; stop: string; error?: string } | null = null;

  constructor(exe: string, args: string[], private o: SessionOptions) {
    this.child = spawnTool(exe, args, { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (d: string) => this.feed(d));
    this.child.stderr?.on("data", (d) => { this.stderrTail = (this.stderrTail + d).slice(-2000); });
    const fail = (why: string) => {
      this.exited = true;
      for (const p of this.pending.values()) p({ success: false, error: why });
      this.pending.clear();
      this.turn?.resolve({ stopReason: "error", error: why });
      this.turn = null;
    };
    this.child.on("error", (e) => fail(`failed to start pi: ${e.message}`));
    this.child.on("exit", (code) => fail(`pi exited (${code}). ${this.stderrTail.trim().slice(-400)}`));
  }

  get alive(): boolean {
    return !this.exited;
  }

  async init(): Promise<void> {
    const st = await this.command({ type: "get_state" });
    if (!st.success) throw new Error(`pi did not start: ${st.error ?? "no response"}`);
    this.sessionId = st.data?.sessionFile ?? st.data?.sessionId ?? null;
    this.currentModel = st.data?.model ? `${st.data.model.provider}/${st.data.model.id}` : null;
  }

  currentModel: string | null = null;

  /** `get_available_models` → ids in Pi's `provider/id` form (what --model accepts). */
  async availableModels(): Promise<ModelInfo[]> {
    const r = await this.command({ type: "get_available_models" });
    if (!r.success) return [];
    return (r.data?.models ?? []).slice(0, 256).map((m: Json) => {
      const id = m.provider ? `${m.provider}/${m.id}` : String(m.id);
      return { id, name: m.name ? `${m.name} (${m.provider ?? ""})` : id, description: m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : null, current: id === this.currentModel };
    });
  }

  prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    if (this.exited) return Promise.resolve({ stopReason: "error", error: "pi is not running" });
    const images: Json[] = [];
    const files: string[] = [];
    for (const a of attachments ?? []) {
      if (a.kind === "image") { try { images.push({ type: "image", data: readFileSync(a.path).toString("base64"), mimeType: a.mime }); continue; } catch { /* path instead */ } }
      files.push(`- ${a.name}: ${a.path}`);
    }
    const message = files.length ? `${text}\n\nAttached files (read only what you need):\n${files.join("\n")}` : text;
    return new Promise((resolve) => {
      this.turn = { resolve, tokensIn: 0, tokensOut: 0, stop: "end_turn" };
      this.userMsgsThisTurn = 0;
      void this.command({ type: "prompt", message, ...(images.length ? { images } : {}) }).then((r) => {
        if (!r.success && this.turn) { this.turn.resolve({ stopReason: "error", error: r.error ?? "prompt rejected" }); this.turn = null; }
      });
    });
  }

  async cancel(): Promise<void> {
    if (!this.exited) this.write({ type: "abort" });
  }

  /** Native steering: Pi delivers it after the current tool calls, before the next model call. */
  async steer(text: string): Promise<boolean> {
    if (this.exited || !this.turn) return false;
    const r = await this.command({ type: "steer", message: text });
    if (r.success) this.pendingSteers++;
    return !!r.success;
  }

  close(): void {
    this.exited = true;
    killTree(this.child);
  }

  // ------------------------------------------------------------------ protocol

  private command(cmd: Json): Promise<Json> {
    const id = `fm-${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.write({ id, ...cmd });
    });
  }

  private write(obj: Json): void {
    if (!this.exited) this.child.stdin?.write(JSON.stringify(obj) + "\n");
  }

  /** Strict JSONL: split on LF only (U+2028/2029 may appear inside JSON strings), strip a trailing CR. */
  private feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let msg: Json;
      try { msg = JSON.parse(line); } catch { continue; }
      this.onMessage(msg);
    }
  }

  private onMessage(m: Json): void {
    if (m.type === "response") {
      const p = m.id ? this.pending.get(m.id) : undefined;
      if (p) { this.pending.delete(m.id); p(m); }
      return;
    }
    const t = this.turn;
    switch (m.type) {
      case "message_start":
      case "turn_start": {
        // Pi injects steering before the next model call: either it reports the injected user message
        // (the first user message of a run is the prompt itself) or a new model turn starts with it in context.
        const injected = m.type === "message_start" ? m.message?.role === "user" && ++this.userMsgsThisTurn > 1 : true;
        if (injected && this.pendingSteers > 0) { this.pendingSteers--; this.o.onEvent({ type: "steer_ack" }); }
        break;
      }
      case "message_update": {
        const ev = m.assistantMessageEvent ?? {};
        if (ev.type === "text_delta" && ev.delta) this.o.onEvent({ type: "text", text: ev.delta });
        else if (ev.type === "thinking_delta" && ev.delta) this.o.onEvent({ type: "thought", text: ev.delta });
        break;
      }
      case "message_end": {
        const msg = m.message ?? {};
        if (msg.role === "assistant" && t) {
          const u = msg.usage ?? {};
          t.tokensIn += Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
          t.tokensOut += Number(u.output ?? 0);
          if (msg.stopReason === "aborted") t.stop = "cancelled";
          else if (msg.stopReason === "error") { t.stop = "error"; t.error = msg.errorMessage ?? "pi reported an error"; }
          else if (msg.stopReason === "length") t.stop = "max_tokens";
        }
        break;
      }
      case "tool_execution_start": {
        const title = toolTitle(m.toolName, m.args);
        if (m.toolCallId) this.toolTitles.set(m.toolCallId, title);
        this.o.onEvent({ type: "tool", title, status: "in_progress", kind: TOOL_KIND[m.toolName] ?? "other" });
        break;
      }
      case "tool_execution_end": {
        const title = this.toolTitles.get(m.toolCallId) ?? toolTitle(m.toolName, m.args);
        this.toolTitles.delete(m.toolCallId);
        this.o.onEvent({ type: "tool", title, status: m.isError ? "failed" : "completed", kind: TOOL_KIND[m.toolName] ?? "other" });
        break;
      }
      case "auto_retry_start":
        this.o.onEvent({ type: "log", text: "retrying after a transient error" });
        break;
      case "extension_ui_request":
        void this.onUiRequest(m);
        break;
      case "agent_end":
        if (t) {
          this.turn = null;
          t.resolve({ stopReason: t.stop, error: t.error, usage: t.tokensIn || t.tokensOut ? { tokensIn: t.tokensIn, tokensOut: t.tokensOut } : undefined });
        }
        break;
    }
  }

  /** Extension dialogs: confirmations go through TheFlashMaster's approval flow; other dialogs are dismissed. */
  private async onUiRequest(m: Json): Promise<void> {
    if (m.method === "confirm") {
      const allow = await this.o.askPermission({ title: String(m.title ?? "Confirm"), kind: "other", detail: String(m.message ?? "") });
      this.write({ type: "extension_ui_response", id: m.id, confirmed: allow });
    } else if (["select", "input", "editor"].includes(m.method)) {
      this.write({ type: "extension_ui_response", id: m.id, cancelled: true });
    }
  }
}

function toolTitle(name: string, args: Json | undefined): string {
  const a = args ?? {};
  const detail = a.command ?? a.path ?? a.pattern ?? a.file_path ?? "";
  return `${name}${detail ? ` ${String(detail).slice(0, 80)}` : ""}`;
}

export class PiAdapter implements HarnessAdapter {
  readonly id = "pi" as const;
  readonly label = "Pi coding agent";
  readonly protocol = "rpc" as const;

  detect(pathOverride: string): Promise<HarnessStatus> {
    return detectExecutable({
      id: "pi", label: this.label, protocol: "rpc", candidates: ["pi"], pathOverride,
      hint: "Install Pi (npm i -g @mariozechner/pi-coding-agent) and run `pi` once to sign in. On Windows Pi needs Git Bash (Git for Windows).",
    });
  }

  async listModels(p: ProbeOptions): Promise<ModelInfo[]> {
    const s = new PiSession(p.executable ?? "pi", ["--mode", "rpc", "--no-session", ...splitArgs(p.extraArgs)], {
      cwd: p.cwd, model: null, extraArgs: "", executable: p.executable, mcpServers: [], env: p.env, resumeSessionId: null,
      policy: { approval: "ask", readOnly: true, blocked: [], projectRoot: null }, onEvent: () => {}, askPermission: async () => false,
    });
    try {
      await Promise.race([s.init(), new Promise((_, rej) => setTimeout(() => rej(new Error("pi did not answer within 45s")), 45000))]);
      return await s.availableModels();
    } finally {
      s.close();
    }
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    const args = ["--mode", "rpc"];
    if (o.model) args.push("--model", o.model);
    if (o.thinking) args.push("--thinking", o.thinking);
    if (o.policy.readOnly) args.push("--tools", "read,grep,find,ls");
    if (o.resumeSessionId) args.push("--session", o.resumeSessionId);
    args.push(...splitArgs(o.extraArgs));
    const s = new PiSession(o.executable ?? "pi", args, o);
    try {
      await Promise.race([s.init(), new Promise((_, rej) => setTimeout(() => rej(new Error("pi did not answer within 60s")), 60000))]);
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }
}
