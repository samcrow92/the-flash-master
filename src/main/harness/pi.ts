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
import { imageBlockMarkdown } from "../images";

type Json = Record<string, any>;

type PiTurn = { resolve: (r: TurnResult) => void; tokensIn: number; tokensOut: number; stop: string; error?: string; accepted: boolean; cmd: Json };
/** Pi's refusal of a prompt sent while it is still running (its error asks for a streamingBehavior). */
export const PI_STILL_RUNNING = /already processing|streamingBehavior/i;
/**
 * Waits before re-sending a refused prompt. Pi turns idle only once its agent_end work is done (that can include
 * compacting the session), so keep trying about every second for up to 5 minutes. Never fall back to
 * streamingBehavior "followUp": a follow-up queued after the run's last check waits for a next prompt, and the turn would hang.
 */
/** Starts the run that answers a steering message Pi received just as its last run ended. */
export const STEER_FOLLOW_UP = "(The user sent the message above while you were finishing. Take it into account and continue.)";
const PROMPT_RETRY_DELAYS = [25, 50, 100, 200, 400, 800, ...Array<number>(300).fill(1000)];

const TOOL_KIND: Record<string, ToolKind> = { bash: "execute", read: "read", write: "edit", edit: "edit", grep: "search", find: "search", ls: "search" };

export class PiSession implements HarnessSession {
  sessionId: string | null = null;
  resumed = false;
  private child: ChildProcess;
  private buf = "";
  private exited = false;
  private stderrTail = "";
  private nextId = 1;
  private toolTitles = new Map<string, string>(); // tool_execution_end carries no args: reuse the title from start
  private pending = new Map<string, (r: Json) => void>();
  private pendingSteers = 0;
  private userMsgsThisTurn = 0;
  private turn: PiTurn | null = null;

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
    this.resumed = !!this.o.resumeSessionId && this.sessionId === this.o.resumeSessionId;
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
      const turn: PiTurn = { resolve, tokensIn: 0, tokensOut: 0, stop: "end_turn", accepted: false, cmd: { type: "prompt", message, ...(images.length ? { images } : {}) } };
      this.turn = turn;
      this.userMsgsThisTurn = 0;
      this.sendPrompt(turn, 0);
    });
  }

  /**
   * Pi emits agent_end a moment before it is ready for the next prompt, so a prompt sent right away (queued message,
   * steering redirect, stopped tool call) is refused with "Agent is already processing. Specify streamingBehavior…".
   * Wait and try again until Pi is idle.
   */
  private sendPrompt(turn: PiTurn, attempt: number): void {
    const sent = turn.cmd;
    // The answer is handled synchronously, in the same pass over Pi's output: a quick run's events (up to agent_end)
    // can arrive in the same chunk right behind it and must already count for this turn, or the turn never ends.
    this.request(sent, (r) => {
      if (this.turn !== turn) {
        // Stopped while Pi was taking the prompt: stop the run it just started too.
        if (r.success) this.write({ type: "abort" });
        return;
      }
      if (r.success) {
        turn.accepted = true;
        // A steering message joined the prompt while this attempt was on its way: deliver it the normal way.
        const extra = String(turn.cmd.message).slice(String(sent.message).length).trim();
        if (extra) void this.command({ type: "steer", message: extra });
        return;
      }
      if (attempt < PROMPT_RETRY_DELAYS.length && !this.exited && PI_STILL_RUNNING.test(String(r.error ?? ""))) {
        setTimeout(() => { if (this.turn === turn) this.sendPrompt(turn, attempt + 1); }, PROMPT_RETRY_DELAYS[attempt]);
        return;
      }
      turn.resolve({ stopReason: "error", error: r.error ?? "prompt rejected" });
      this.turn = null;
    });
  }

  async cancel(): Promise<void> {
    // Still waiting for Pi to take the prompt: nothing runs yet, so the turn ends here.
    const t = this.turn;
    if (t && !t.accepted) { this.turn = null; t.resolve({ stopReason: "cancelled" }); return; }
    if (!this.exited) this.write({ type: "abort" });
  }

  /** Native steering: Pi delivers it after the current tool calls, before the next model call. */
  async steer(text: string): Promise<boolean> {
    if (this.exited || !this.turn) return false;
    // Pi has not taken this turn's prompt yet (it was still finishing the last one): the message joins that prompt.
    if (!this.turn.accepted) {
      this.turn.cmd = { ...this.turn.cmd, message: `${this.turn.cmd.message}\n\n${text}` };
      queueMicrotask(() => this.o.onEvent({ type: "steer_ack" }));
      return true;
    }
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
    return new Promise((resolve) => this.request(cmd, resolve));
  }

  /** Send a command; `onResponse` runs synchronously when Pi's response line is read, before the lines after it. */
  private request(cmd: Json, onResponse: (r: Json) => void): void {
    const id = `fm-${this.nextId++}`;
    this.pending.set(id, onResponse);
    this.write({ id, ...cmd });
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
        if (msg.role === "assistant" && t?.accepted) {
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
        this.o.onEvent({ type: "tool", id: m.toolCallId, title, status: "in_progress", kind: TOOL_KIND[m.toolName] ?? "other", input: piToolInput(m.toolName, m.args) });
        break;
      }
      case "tool_execution_update": {
        const out = piToolOutput(m.partialResult);
        if (out) this.o.onEvent({ type: "tool", id: m.toolCallId, title: this.toolTitles.get(m.toolCallId) ?? toolTitle(m.toolName, m.args), status: "in_progress", kind: TOOL_KIND[m.toolName] ?? "other", output: out });
        break;
      }
      case "tool_execution_end": {
        const title = this.toolTitles.get(m.toolCallId) ?? toolTitle(m.toolName, m.args);
        this.toolTitles.delete(m.toolCallId);
        this.o.onEvent({ type: "tool", id: m.toolCallId, title, status: m.isError ? "failed" : "completed", kind: TOOL_KIND[m.toolName] ?? "other", output: piToolOutput(m.result) });
        break;
      }
      case "auto_retry_start":
        this.o.onEvent({ type: "log", text: "retrying after a transient error" });
        break;
      case "extension_ui_request":
        void this.onUiRequest(m);
        break;
      case "agent_end":
        // Not yet accepted = the end of the run before ours, which Pi was still finishing.
        if (t?.accepted) {
          if (this.pendingSteers > 0 && t.stop === "end_turn" && !this.exited) {
            // The run ended before Pi took the steering message (it keeps it for the next run): start that run now,
            // in the same turn, so the message is answered instead of waiting for the user's next one.
            t.accepted = false;
            t.cmd = { type: "prompt", message: STEER_FOLLOW_UP };
            this.sendPrompt(t, 0);
            break;
          }
          this.pendingSteers = 0;
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

  /** Starts the Pi process (tests swap in a fake Pi here). */
  protected session(exe: string, args: string[], o: SessionOptions): PiSession {
    return new PiSession(exe, args, o);
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    const args = ["--mode", "rpc"];
    const want = piModelArgs(o.model);
    args.push(...want.args);
    if (o.thinking) args.push("--thinking", o.thinking);
    if (o.policy.readOnly) args.push("--tools", "read,grep,find,ls");
    if (o.resumeSessionId) args.push("--session", o.resumeSessionId);
    args.push(...splitArgs(o.extraArgs));
    const s = this.session(o.executable ?? "pi", args, o);
    try {
      await Promise.race([s.init(), new Promise((_, rej) => setTimeout(() => rej(new Error("pi did not answer within 60s")), 60000))]);
      // Pi falls back to its default model when it can't find the one asked for: say so instead of silently running on another one.
      const problem = piModelMismatch(want, s.currentModel);
      if (problem) throw new Error(problem);
    } catch (e) {
      s.close();
      throw e;
    }
    return s;
  }
}

/**
 * Pi launch arguments for a model id. `provider/model` (what Pi lists, e.g. qwen-local-8800/qwen3.8:27b) becomes
 * `--provider <provider> --model <model>`, so a model id with a colon is never read as Pi's `model:thinking` shorthand.
 */
export function piModelArgs(model: string | null | undefined): { provider: string | null; model: string | null; args: string[] } {
  const m = model?.trim();
  if (!m) return { provider: null, model: null, args: [] };
  const slash = m.indexOf("/");
  if (slash > 0 && slash < m.length - 1) {
    const provider = m.slice(0, slash), id = m.slice(slash + 1);
    return { provider, model: id, args: ["--provider", provider, "--model", id] };
  }
  return { provider: null, model: m, args: ["--model", m] };
}

/** Why Pi is not running on the model that was asked for (null when it is, or when Pi didn't say). */
export function piModelMismatch(want: { provider: string | null; model: string | null }, current: string | null): string | null {
  if (!want.model || !current) return null;
  const slash = current.indexOf("/");
  const provider = slash > 0 ? current.slice(0, slash) : "";
  const id = slash > 0 ? current.slice(slash + 1) : current;
  const okProvider = !want.provider || provider.toLowerCase() === want.provider.toLowerCase();
  const okModel = id.toLowerCase() === want.model.toLowerCase() || id.toLowerCase().includes(want.model.toLowerCase());
  if (okProvider && okModel) return null;
  const asked = want.provider ? `${want.provider}/${want.model}` : want.model;
  return `Pi started on ${current} instead of ${asked}: Pi doesn't know that model or provider. `
    + "Check the provider name and model id in Pi's models.json (Pi lists them with `pi --list-models`), then try again.";
}

/** Pi tool arguments as shown when the call is expanded: the bash command as is, other tools as JSON. */
export function piToolInput(tool: string, args: unknown): string | undefined {
  if (args == null) return undefined;
  const a = args as Record<string, unknown>;
  if (tool === "bash" && typeof a.command === "string") return a.command;
  try { return JSON.stringify(args, null, 1); } catch { return undefined; }
}
/** Text of a Pi tool result ({ content: [{ type: "text", text }] }). */
export function piToolOutput(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  const c = (result as { content?: unknown }).content;
  const t = Array.isArray(c) ? c.map((x: any) => (x?.type === "text" ? x.text : x?.type === "image" ? (imageBlockMarkdown(x) ?? "(image)") : "")).filter(Boolean).join("\n") : "";
  return t || undefined;
}
