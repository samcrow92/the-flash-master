/**
 * GitLab Duo CLI adapter. Duo has no ACP mode, so each turn runs headless:
 *   DUO_WORKFLOW_GOAL="<text>" duo run [--existing-session-id <id>]     (or: glab duo cli run ...)
 * The goal goes in the environment, never on the command line: a resumed chat sends rules + history, which is far past
 * Windows' 32,767-character command line (spawn ENAMETOOLONG) and breaks on newlines through a .cmd shim.
 * stdout is streamed as message text; Duo's stderr log becomes activity lines and tool-call blocks.
 * Headless Duo auto-approves its own tools, so the UI flags Duo agents.
 */
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessStatus } from "@shared/types";
import type { Settings } from "@shared/settings";
import { detectExecutable, killTree, runCapture, spawnTool, splitArgs } from "./process";
import type { HarnessAdapter, HarnessEvent, HarnessSession, PromptAttachment, SessionOptions, ToolKind, TurnResult } from "./types";

/**
 * Duo works on the GitLab project behind the folder's git remote, so Duo agents only start in GitLab repos:
 * a folder whose remote is gitlab.com, a host named gitlab…, the instance in GITLAB_BASE_URL / GITLAB_URL, or one of
 * the hosts in Settings → Harnesses → GitLab Duo (for self-managed GitLab on another name).
 */
export type DuoSettings = Pick<Settings["duo"], "hosts">;

/** Hosts of the remotes in `git remote -v` output (https, ssh:// and scp-style git@host:path). */
export function remoteHosts(remotes: string): string[] {
  const hosts = new Set<string>();
  for (const line of remotes.split(/\r?\n/)) {
    const url = line.split(/\s+/)[1];
    if (!url) continue;
    const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(url) ?? /^(?:[^@/]+@)?([^/:]+):/.exec(url);
    if (m?.[1]) hosts.add(m[1].toLowerCase());
  }
  return [...hosts];
}

/** Host names from a comma/space/newline separated list of hosts or URLs. */
export function hostList(text: string): string[] {
  return text.split(/[\s,;]+/).map((h) => h.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^[^@/]+@/, "").replace(/[/:].*$/, ""))
    .filter(Boolean);
}

/** True when a remote points at GitLab: gitlab.com, any host named gitlab, or one of `extraHosts`. */
export function hasGitLabRemote(remotes: string, extraHosts: string[] = []): boolean {
  const extra = new Set(extraHosts.map((h) => h.toLowerCase()));
  return remoteHosts(remotes).some((h) => extra.has(h) || /(^|[.-])gitlab([.-]|$)/.test(h));
}

/** Hosts that count as GitLab besides gitlab.com and hosts named gitlab: the configured ones and the instance in the env. */
export function duoGitlabHosts(settings: DuoSettings | undefined, env: Record<string, string | undefined> = process.env): string[] {
  return hostList([settings?.hosts ?? "", env.GITLAB_BASE_URL ?? "", env.GITLAB_URL ?? ""].join(" "));
}

/** Null when Duo may start in `cwd`, else the message that says why not and what to do. */
export async function gitlabRepoProblem(cwd: string, extraHosts: string[] = []): Promise<string | null> {
  const r = await runCapture("git", ["remote", "-v"], 5000, cwd).catch(() => ({ code: 1, out: "" }));
  const remotes = r.code === 0 ? r.out : "";
  if (hasGitLabRemote(remotes, extraHosts)) return null;
  const hosts = remoteHosts(remotes);
  const why = r.code !== 0 ? "it is not a git repository" : hosts.length ? `its remote is on ${hosts.join(", ")}, not GitLab` : "it has no git remote";
  return `GitLab Duo only runs in GitLab repositories, and ${cwd} is not one: ${why}. ` +
    "Open a project cloned from GitLab, or pick another harness for this agent. " +
    "Self-managed GitLab on another host name? Add it in Settings → Harnesses → GitLab Duo.";
}

const LOG_LINE_RE = /^\s*\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:?\d\d)?\s*\[(\w+)\]:\s*/;

/** The useful part of a failed Duo run: its [error] lines (not the shutdown chatter at the end), plus what to do about it. */
export function duoFailure(log: string, code: number | null): string {
  const lines = log.split(/\r?\n/);
  const errors: string[] = [];
  for (const l of lines) {
    const m = LOG_LINE_RE.exec(l);
    if (m?.[1]?.toLowerCase() === "error") {
      const text = l.slice(m[0].length).trim();
      if (text && !errors.includes(text)) errors.push(text);
    }
  }
  const plain = lines.filter((l) => l.trim() && !LOG_LINE_RE.test(l)).join("\n").trim();
  let msg = errors.length ? errors.slice(-3).join("\n") : (plain || log.trim()).slice(-400);
  if (/workflow id not available|agentic chat is not available|failed to fetch project details/i.test(log)) {
    msg += "\n\nDuo could not use this repository's GitLab project. Check that the duo CLI is signed in to the GitLab instance that hosts it and that GitLab Duo is on for the project.";
  }
  return `duo exited with ${code}: ${msg}`;
}

/**
 * Progress lines from Duo's stderr log, for the orchestrator: the log prefix is stripped, debug/trace chatter and blank
 * lines are dropped. Duo writes nothing on stdout until it answers, so this is how the app sees it working.
 */
export function duoActivity(line: string): string | null {
  const m = LOG_LINE_RE.exec(line);
  const level = m?.[1]?.toLowerCase();
  if (level === "debug" || level === "trace" || level === "verbose" || level === "silly") return null;
  const text = (m ? line.slice(m[0].length) : line).trim();
  if (!text || /^[-=─━\s]+$/.test(text)) return null;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** Goals up to this many characters go straight into DUO_WORKFLOW_GOAL (Windows caps one variable at 32,767). */
export const DUO_GOAL_ENV_MAX = 24_000;
/** Folder (inside the repo, ignored by git) for goals too long for the environment. Duo only reads files in the repo. */
export const DUO_GOAL_DIR = ".flashmaster-duo";

/**
 * How the goal reaches Duo: the environment for DUO_WORKFLOW_GOAL, and the file to write first when the goal is too long
 * for it (the goal then asks Duo to read that file). `stamp` names the file.
 */
export function duoGoal(goal: string, cwd: string, stamp: string): { env: string; file: { path: string; text: string } | null } {
  if (goal.length <= DUO_GOAL_ENV_MAX) return { env: goal, file: null };
  const rel = `${DUO_GOAL_DIR}/goal-${stamp}.md`;
  return {
    env: `Your full instructions for this turn are long, so they were saved in the file ${rel} in this repository. ` +
      "Read that whole file first with your file-reading tool (it can take several reads), then do exactly what it says, " +
      "as if it were this message. Don't edit, move or commit that file.",
    file: { path: join(cwd, rel), text: goal },
  };
}

const TOOL_KINDS: [RegExp, ToolKind][] = [
  [/grep|search|find/i, "search"],
  [/read|list|view|get_|open/i, "read"],
  [/edit|create|write|patch|replace|mkdir/i, "edit"],
  [/delete|remove/i, "delete"],
  [/move|rename/i, "move"],
  [/command|shell|exec|run|git/i, "execute"],
  [/fetch|http|url|web/i, "fetch"],
];

/** The kind of a Duo tool, from its name (read_file → read, run_command → execute, …). */
export function duoToolKind(name: string): ToolKind {
  return TOOL_KINDS.find(([re]) => re.test(name))?.[1] ?? "other";
}

/** The argument worth showing in a tool title: a command, a path, a pattern or a URL. */
function toolArg(input: string): string {
  try {
    const o = JSON.parse(input) as Record<string, unknown>;
    for (const k of ["command", "program", "file_path", "path", "directory", "pattern", "search", "query", "url", "name"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        const args = k === "program" && Array.isArray(o.args) ? ` ${(o.args as unknown[]).join(" ")}` : "";
        return `${v}${args}`.replace(/\s+/g, " ").trim();
      }
    }
  } catch { /* not JSON: show it as it is */ }
  return input.replace(/\s+/g, " ").trim();
}

const TOOL_STARTED_RE = /^Tool started:\s*(.+)$/;
const TOOL_INPUT_RE = /^Tool input:\s*(.*)$/;
const TOOL_DONE_RE = /^Tool completed:\s*(.+)$/;
const TOOL_ERROR_RE = /^Tool error:\s*(.*)$/;
const DELEGATING_RE = /^Delegating to (.+?)\.*$/;

/**
 * Turns Duo's log into tool-call blocks. Headless Duo logs `Tool started: <name>`, `Tool input: <json>`,
 * `Tool completed: <id>` and `Tool error: <text>` (one call at a time), and `Delegating to <agent>...` for subagents.
 */
export class DuoToolLog {
  private n = 0;
  private open: { id: string; name: string; input?: string }[] = [];
  private pendingInput: string | undefined;
  private lastDone: { id: string; name: string; input?: string } | null = null;

  constructor(private prefix = "duo") {}

  feed(line: string): HarnessEvent[] {
    const m = LOG_LINE_RE.exec(line);
    const text = (m ? line.slice(m[0].length) : line).trim();
    let r: RegExpExecArray | null;
    if ((r = TOOL_STARTED_RE.exec(text))) {
      const name = r[1]!.trim();
      const call = { id: `${this.prefix}-${++this.n}`, name, input: this.pendingInput };
      this.pendingInput = undefined;
      this.lastDone = null;
      this.open.push(call);
      return [this.event(call, "in_progress")];
    }
    if ((r = TOOL_INPUT_RE.exec(text))) {
      const input = r[1]!.trim();
      const call = [...this.open].reverse().find((c) => c.input === undefined);
      if (!call) { this.pendingInput = input; return []; }
      call.input = input;
      return [this.event(call, "in_progress")];
    }
    if ((r = TOOL_ERROR_RE.exec(text))) {
      // Duo logs a failed call as completed first, then its error: the error belongs to the call that just ended.
      const call = this.open.shift() ?? this.lastDone;
      this.lastDone = null;
      return call ? [this.event(call, "failed", r[1]!.trim())] : [];
    }
    if (TOOL_DONE_RE.test(text)) {
      const call = this.open.shift();
      this.lastDone = call ?? null;
      return call ? [this.event(call, "completed")] : [];
    }
    if ((r = DELEGATING_RE.exec(text))) {
      const id = `${this.prefix}-${++this.n}`;
      return [{ type: "tool", id, title: `Delegate to ${r[1]!.trim()}`, status: "in_progress", kind: "other" }];
    }
    return [];
  }

  /** Calls still open when the run ends: finished with the run (completed), or failed when it failed. */
  finish(ok: boolean): HarnessEvent[] {
    const left = this.open.splice(0);
    return left.map((c) => this.event(c, ok ? "completed" : "failed"));
  }

  private event(c: { id: string; name: string; input?: string }, status: string, output?: string): HarnessEvent {
    const arg = c.input ? toolArg(c.input) : "";
    const title = arg ? `${c.name}: ${arg.length > 120 ? `${arg.slice(0, 119)}…` : arg}` : c.name;
    return { type: "tool", id: c.id, title, status, kind: duoToolKind(c.name), ...(c.input ? { input: c.input } : {}), ...(output ? { output } : {}) };
  }
}

const SESSION_RE = /session[\s_-]*id[\s:=]+([A-Za-z0-9_-]{6,})/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export class DuoSession implements HarnessSession {
  /** How often a running Duo process reports that it is alive (tests shorten it). */
  static heartbeatMs = 15_000;
  sessionId: string | null;
  private current: ChildProcess | null = null;
  private closed = false;
  private turns = 0;

  constructor(private exe: string, private prefixArgs: string[], private o: SessionOptions) {
    this.sessionId = o.resumeSessionId;
  }

  get alive(): boolean {
    return !this.closed;
  }

  prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    const goal = attachments?.length ? `${text}\n\nAttached files:\n${attachments.map((a) => `- ${a.name}: ${a.path}`).join("\n")}` : text;
    const args = [...this.prefixArgs, "run", ...splitArgs(this.o.extraArgs)];
    if (this.sessionId) args.push("--existing-session-id", this.sessionId);
    if (this.o.model) args.push("--model", this.o.model);
    const turn = ++this.turns;
    const g = duoGoal(goal, this.o.cwd, `${Date.now().toString(36)}-${turn}`);
    if (g.file) {
      try {
        mkdirSync(join(this.o.cwd, DUO_GOAL_DIR), { recursive: true });
        writeFileSync(join(this.o.cwd, DUO_GOAL_DIR, ".gitignore"), "*\n");
        writeFileSync(g.file.path, g.file.text);
      } catch (e) {
        return Promise.resolve({ stopReason: "error", error: `Could not save the long goal for Duo in ${DUO_GOAL_DIR}: ${(e as Error).message}` });
      }
    }
    const dropGoalFile = () => { if (g.file) rmSync(g.file.path, { force: true }); };
    const tools = new DuoToolLog(`duo${turn}`);
    return new Promise((resolve) => {
      let cancelled = false;
      let errTail = "";
      let errLine = "";
      const child = spawnTool(this.exe, args, { cwd: this.o.cwd, env: { ...process.env, ...this.o.env, DUO_WORKFLOW_GOAL: g.env }, stdio: ["ignore", "pipe", "pipe"] });
      this.current = child;
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => {
        const clean = d.replace(ANSI_RE, "");
        const sid = SESSION_RE.exec(clean)?.[1];
        if (sid) this.sessionId = sid;
        this.o.onEvent({ type: "text", text: clean });
      });
      child.stderr?.on("data", (d) => {
        const s = String(d).replace(ANSI_RE, "");
        errTail = (errTail + s).slice(-64000);
        const sid = SESSION_RE.exec(s)?.[1];
        if (sid) this.sessionId = sid;
        const lines = (errLine + s).split(/\r?\n/);
        errLine = (lines.pop() ?? "").slice(-4000);
        for (const l of lines) {
          const a = duoActivity(l);
          if (a) this.o.onEvent({ type: "activity", text: a });
          for (const e of tools.feed(l)) this.o.onEvent(e);
        }
      });
      // Duo can think for minutes without a word: while its process runs, tell the app it is working, not stale.
      const beat = setInterval(() => { if (child.exitCode === null && !cancelled) this.o.onEvent({ type: "heartbeat" }); }, DuoSession.heartbeatMs);
      (beat as { unref?: () => void }).unref?.();
      (child as any).__cancel = () => { cancelled = true; };
      child.on("error", (e) => { clearInterval(beat); dropGoalFile(); resolve({ stopReason: "error", error: e.message }); });
      child.on("close", (code) => {
        clearInterval(beat);
        dropGoalFile();
        this.current = null;
        if (errLine) for (const e of tools.feed(errLine)) this.o.onEvent(e);
        for (const e of tools.finish(code === 0 && !cancelled)) this.o.onEvent(e);
        if (cancelled) resolve({ stopReason: "cancelled" });
        else if (code === 0) resolve({ stopReason: "end_turn" });
        else resolve({ stopReason: "error", error: duoFailure(errTail, code) });
      });
    });
  }

  async cancel(): Promise<void> {
    if (this.current) {
      (this.current as any).__cancel?.();
      killTree(this.current);
    }
  }

  close(): void {
    this.closed = true;
    void this.cancel();
  }
}

export class DuoAdapter implements HarnessAdapter {
  readonly id = "duo" as const;
  readonly label = "GitLab Duo CLI";
  readonly protocol = "headless" as const;

  /** getSettings: Settings → Harnesses → GitLab Duo, read at each start. */
  constructor(private getSettings?: () => DuoSettings | undefined) {}



  detect(pathOverride: string): Promise<HarnessStatus> {
    return detectExecutable({
      id: "duo", label: this.label, protocol: "headless", candidates: ["duo", "glab"], pathOverride,
      hint: "Install the GitLab Duo CLI (duo) or glab, then sign in once in a terminal.",
    });
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    const problem = await gitlabRepoProblem(o.cwd, duoGitlabHosts(this.getSettings?.(), { ...process.env, ...o.env }));
    if (problem) throw new Error(problem);
    const exe = o.executable ?? "duo";
    const viaGlab = /glab(\.exe)?$/i.test(exe);
    return new DuoSession(exe, viaGlab ? ["duo", "cli"] : [], o);
  }
}
