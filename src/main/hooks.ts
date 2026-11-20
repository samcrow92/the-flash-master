/**
 * User hooks: your own scripts that run around agent work, so team rules hold on every harness without growing any
 * prompt. One hook per line in Settings → Permissions → Hooks:
 *
 *   <event> [match] => <command>
 *   pre_tool  git push *  => node C:\tools\guard-push.js
 *   post_tool edit        => npx prettier --write "$FLASH_PATHS"
 *   turn_end              => powershell -File C:\tools\notify.ps1
 *   checks_done           => python ci/report.py
 *
 * Events: pre_tool (before a tool call the agent asks to run; it can allow, ask or deny it), post_tool (after a tool
 * call finished), turn_end (an agent finished a turn), checks_done (the app's checks ran on an agent's worktree).
 * `match` is a command pattern for execute calls, or a tool kind (edit, read, fetch, …); omit it or use * for all.
 *
 * The hook gets the event as JSON on stdin and in FLASH_* environment variables. A pre_tool hook denies with exit code 2
 * (its stderr/stdout is the reason) or prints {"decision":"allow"|"ask"|"deny","reason":"…"}. Other failures are logged
 * and ignored, so a broken hook never stalls an agent.
 */
import { spawnTool, killTree } from "./harness/process";
import { commandParts, matchCommand, tokenize, type RuleAction } from "./harness/rules";
import type { ToolKind } from "./harness/types";

export type HookEvent = "pre_tool" | "post_tool" | "turn_end" | "checks_done";
export const HOOK_EVENTS: HookEvent[] = ["pre_tool", "post_tool", "turn_end", "checks_done"];
const KINDS: ToolKind[] = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"];

export interface Hook { event: HookEvent; match: string; command: string; source: string }

export interface HookPayload {
  event: HookEvent;
  agentId?: string;
  agent?: string;
  role?: string;
  cwd?: string | null;
  kind?: ToolKind;
  title?: string;
  command?: string | null;
  paths?: string[];
  status?: string;
  output?: string;
  result?: string;
  ok?: boolean;
}

export interface HookOutcome { hook: string; code: number | null; output: string; decision: RuleAction | null; reason: string | null }

export type HookRunner = (command: string, stdin: string, env: Record<string, string>, cwd: string | undefined, timeoutMs: number) => Promise<{ code: number | null; out: string; err: string }>;

/** Parse the hooks text; bad lines come back in `errors`. */
export function parseHooks(text: string): { hooks: Hook[]; errors: string[] } {
  const hooks: Hook[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const at = line.indexOf("=>");
    if (at < 0) { errors.push(`line ${i + 1}: write <event> [match] => <command>`); return; }
    const [event, ...match] = line.slice(0, at).trim().split(/\s+/);
    const command = line.slice(at + 2).trim();
    if (!HOOK_EVENTS.includes(event as HookEvent)) { errors.push(`line ${i + 1}: event must be one of ${HOOK_EVENTS.join(", ")}`); return; }
    if (!command) { errors.push(`line ${i + 1}: missing the command after =>`); return; }
    hooks.push({ event: event as HookEvent, match: match.join(" ") || "*", command, source: line });
  });
  return { hooks, errors };
}

/** True when the hook applies to this payload. */
export function hookMatches(h: Hook, p: HookPayload): boolean {
  if (h.event !== p.event) return false;
  const m = h.match.trim();
  if (!m || m === "*") return true;
  if (KINDS.includes(m.toLowerCase() as ToolKind)) return p.kind === m.toLowerCase();
  if (p.kind !== "execute") return false;
  const line = p.command || p.title || "";
  return commandParts(line).some((t) => matchCommand(m, t)) || matchCommand(m, tokenize(line));
}

/** Run a command line through the platform shell (cmd.exe on Windows, /bin/sh elsewhere), the way Node's `shell: true` does. */
export const shellCommand = (command: string): [string, string[]] =>
  process.platform === "win32" ? [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`]] : ["/bin/sh", ["-c", command]];

export const defaultHookRunner: HookRunner = (command, stdin, env, cwd, timeoutMs) => new Promise((resolve) => {
  const [cmd, args] = shellCommand(command);
  let out = "", err = "";
  let child: ReturnType<typeof spawnTool>;
  try {
    child = spawnTool(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd, env: { ...process.env, ...env }, windowsVerbatimArguments: process.platform === "win32" });
  } catch (e) { resolve({ code: -1, out: "", err: String(e) }); return; }
  const t = setTimeout(() => { killTree(child); resolve({ code: null, out, err: err + "\n(timed out)" }); }, timeoutMs);
  child.stdout?.on("data", (d) => { out += d; });
  child.stderr?.on("data", (d) => { err += d; });
  child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e) }); });
  child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  child.stdin?.on("error", () => { /* the hook may not read stdin */ });
  child.stdin?.end(stdin);
});

function envFor(p: HookPayload): Record<string, string> {
  const e: Record<string, string> = { FLASH_HOOK_EVENT: p.event };
  const set = (k: string, v: unknown) => { if (v !== undefined && v !== null && v !== "") e[k] = String(v).slice(0, 8000); };
  set("FLASH_AGENT_ID", p.agentId); set("FLASH_AGENT", p.agent); set("FLASH_ROLE", p.role); set("FLASH_CWD", p.cwd);
  set("FLASH_TOOL_KIND", p.kind); set("FLASH_TOOL_TITLE", p.title); set("FLASH_COMMAND", p.command);
  set("FLASH_PATHS", p.paths?.join(process.platform === "win32" ? ";" : ":")); set("FLASH_STATUS", p.status);
  if (p.ok !== undefined) e.FLASH_OK = p.ok ? "1" : "0";
  return e;
}

/** Read a pre_tool hook's verdict: exit 2 = deny; JSON {"decision": …} on stdout; anything else = no opinion. */
export function hookVerdict(code: number | null, out: string, err: string): { decision: RuleAction | null; reason: string | null } {
  const text = (err.trim() || out.trim()).slice(0, 400) || null;
  if (code === 2) return { decision: "deny", reason: text };
  const last = out.trim().split(/\r?\n/).pop() ?? "";
  if (last.startsWith("{")) {
    try {
      const j = JSON.parse(last) as { decision?: string; reason?: string };
      if (j.decision === "allow" || j.decision === "ask" || j.decision === "deny") return { decision: j.decision, reason: j.reason ?? null };
    } catch { /* not JSON */ }
  }
  return { decision: null, reason: null };
}

const RANK: Record<RuleAction, number> = { allow: 1, ask: 2, deny: 3 };

/** Runs the configured hooks. `hooks` is read on every call, so edits in Settings apply right away. */
export class HookRunnerHost {
  constructor(private hooks: () => Hook[], private run: HookRunner = defaultHookRunner, private onLog: (line: string) => void = () => {},
    private timeoutMs = 15_000) {}

  /** Run every matching hook for the event; resolves with each outcome (in order). */
  async fire(p: HookPayload): Promise<HookOutcome[]> {
    const list = this.hooks().filter((h) => hookMatches(h, p));
    const out: HookOutcome[] = [];
    for (const h of list) {
      const r = await this.run(h.command, JSON.stringify(p), envFor(p), p.cwd ?? undefined, this.timeoutMs);
      const v = p.event === "pre_tool" ? hookVerdict(r.code, r.out, r.err) : { decision: null, reason: null };
      if (r.code !== 0 && v.decision === null) this.onLog(`hook "${h.source}" exited ${r.code}: ${(r.err || r.out).trim().slice(0, 200)}`);
      out.push({ hook: h.source, code: r.code, output: (r.out + r.err).trim().slice(0, 2000), ...v });
    }
    return out;
  }

  /** pre_tool: the strongest verdict of the matching hooks (deny > ask > allow), or null when none has an opinion. */
  async preTool(p: Omit<HookPayload, "event">): Promise<{ decision: RuleAction; reason: string | null; hook: string } | null> {
    if (!this.hooks().some((h) => h.event === "pre_tool")) return null;
    let best: { decision: RuleAction; reason: string | null; hook: string } | null = null;
    for (const o of await this.fire({ ...p, event: "pre_tool" })) {
      if (o.decision && (!best || RANK[o.decision] > RANK[best.decision])) best = { decision: o.decision, reason: o.reason, hook: o.hook };
    }
    return best;
  }

  has(event: HookEvent): boolean { return this.hooks().some((h) => h.event === event); }
}
