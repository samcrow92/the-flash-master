/**
 * GitLab Duo CLI adapter. Duo has no ACP mode, so each turn runs headless:
 *   duo run --goal "<text>" [--existing-session-id <id>]     (or: glab duo cli run ...)
 * stdout is streamed as message text. Headless Duo auto-approves its own tools, so the UI flags Duo agents.
 */
import type { ChildProcess } from "node:child_process";
import type { HarnessStatus } from "@shared/types";
import type { Settings } from "@shared/settings";
import { detectExecutable, killTree, runCapture, spawnTool, splitArgs } from "./process";
import type { HarnessAdapter, HarnessSession, PromptAttachment, SessionOptions, TurnResult } from "./types";

/**
 * Duo works on the GitLab project behind the folder's git remote, so Duo agents only start in GitLab repos:
 * a folder whose remote is gitlab.com, a host named gitlab…, the instance in GITLAB_BASE_URL / GITLAB_URL, or one of
 * the hosts in Settings → Harnesses → GitLab Duo (for self-managed GitLab on another name).
 */
export type DuoSettings = Settings["duo"];

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

const LOG_LINE_RE = /^\s*\d{4}-\d\d-\d\dT[\d:.]+\s*\[(\w+)\]:\s*/;

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

const SESSION_RE = /session[\s_-]*id[\s:=]+([A-Za-z0-9_-]{6,})/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export class DuoSession implements HarnessSession {
  sessionId: string | null;
  private current: ChildProcess | null = null;
  private closed = false;

  constructor(private exe: string, private prefixArgs: string[], private o: SessionOptions) {
    this.sessionId = o.resumeSessionId;
  }

  get alive(): boolean {
    return !this.closed;
  }

  prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    const goal = attachments?.length ? `${text}\n\nAttached files:\n${attachments.map((a) => `- ${a.name}: ${a.path}`).join("\n")}` : text;
    const args = [...this.prefixArgs, "run", "--goal", goal, ...splitArgs(this.o.extraArgs)];
    if (this.sessionId) args.push("--existing-session-id", this.sessionId);
    if (this.o.model) args.push("--model", this.o.model);
    return new Promise((resolve) => {
      let cancelled = false;
      let errTail = "";
      const child = spawnTool(this.exe, args, { cwd: this.o.cwd, env: { ...process.env, ...this.o.env }, stdio: ["ignore", "pipe", "pipe"] });
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
      });
      (child as any).__cancel = () => { cancelled = true; };
      child.on("error", (e) => resolve({ stopReason: "error", error: e.message }));
      child.on("close", (code) => {
        this.current = null;
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
