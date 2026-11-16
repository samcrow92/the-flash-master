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

export type DuoContext = Settings["duo"];

/**
 * Duo finds its GitLab project from the folder's git remote, else falls back to your default Duo namespace
 * (GitLab → Preferences). With neither it cannot start a session. Duo's own `--gitlab-project-path` /
 * GITLAB_PROJECT_PATH (and GITLAB_BASE_URL for the instance) name the project directly, so we pass those:
 * no fake remotes, nothing written to the user's repo.
 */
export function parseDuoProject(project: string, instanceUrl = ""): { path: string; baseUrl: string } | null {
  let p = project.trim();
  let baseUrl = instanceUrl.trim().replace(/\/+$/, "");
  const url = /^(https?:\/\/[^/]+)\/(.+)$/i.exec(p);
  if (url) { baseUrl ||= url[1]!; p = url[2]!; }
  p = p.replace(/\/-\/.*$/, "").replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!p.includes("/")) return null; // a project path is always namespace/project
  return { path: p, baseUrl };
}

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

/** True when a remote points at the GitLab instance (or any host named gitlab), so Duo detects the project itself. */
export function hasGitLabRemote(remotes: string, baseUrl: string): boolean {
  const instance = /^https?:\/\/([^/:]+)/i.exec(baseUrl)?.[1]?.toLowerCase() ?? "gitlab.com";
  return remoteHosts(remotes).some((h) => h === instance || /(^|[.-])gitlab([.-]|$)/.test(h));
}

/** Environment that points Duo at the configured project, or {} when none is set or the folder is a GitLab project already. */
export function duoContextEnv(ctx: DuoContext | undefined, remotes: string): Record<string, string> {
  const parsed = ctx?.project ? parseDuoProject(ctx.project, ctx.instanceUrl) : null;
  if (!parsed) return {};
  if (!ctx!.always && hasGitLabRemote(remotes, parsed.baseUrl)) return {};
  return { GITLAB_PROJECT_PATH: parsed.path, ...(parsed.baseUrl ? { GITLAB_BASE_URL: parsed.baseUrl } : {}) };
}

const LOG_LINE_RE = /^\s*\d{4}-\d\d-\d\dT[\d:.]+\s*\[(\w+)\]:\s*/;

/** The useful part of a failed Duo run: its [error] lines (not the shutdown chatter at the end), plus what to do about it. */
export function duoFailure(log: string, code: number | null, projectPath?: string): string {
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
  const noContext = /workflow id not available|agentic chat is not available|default (duo )?namespace|failed to initialize workflow/i;
  if (projectPath && /failed to fetch project details/i.test(log)) {
    msg += `\n\nDuo could not open the GitLab project "${projectPath}". Check the path, the instance URL and that your account can see it (Settings → Harnesses → GitLab Duo).`;
  } else if (!projectPath && noContext.test(log)) {
    msg += "\n\nThis folder is not a GitLab project and Duo has no default namespace to fall back on. " +
      "Set a GitLab project for Duo in Settings → Harnesses → GitLab Duo, or a default GitLab Duo namespace in your GitLab preferences.";
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

  private context: Promise<Record<string, string>> | null = null;

  constructor(private exe: string, private prefixArgs: string[], private o: SessionOptions, private getContext?: () => DuoContext | undefined) {
    this.sessionId = o.resumeSessionId;
  }

  /** Worked out once per session: the folder's remotes don't change mid-chat. */
  private contextEnv(): Promise<Record<string, string>> {
    const ctx = this.getContext?.();
    if (!ctx?.project) return Promise.resolve({});
    this.context ??= runCapture("git", ["remote", "-v"], 5000, this.o.cwd)
      .then((r) => (r.code === 0 ? r.out : ""), () => "")
      .then((remotes) => duoContextEnv(ctx, remotes));
    return this.context;
  }

  get alive(): boolean {
    return !this.closed;
  }

  async prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult> {
    const goal = attachments?.length ? `${text}\n\nAttached files:\n${attachments.map((a) => `- ${a.name}: ${a.path}`).join("\n")}` : text;
    const args = [...this.prefixArgs, "run", "--goal", goal, ...splitArgs(this.o.extraArgs)];
    if (this.sessionId) args.push("--existing-session-id", this.sessionId);
    if (this.o.model) args.push("--model", this.o.model);
    const ctxEnv = await this.contextEnv();
    return new Promise((resolve) => {
      let cancelled = false;
      let errTail = "";
      const child = spawnTool(this.exe, args, { cwd: this.o.cwd, env: { ...process.env, ...this.o.env, ...ctxEnv }, stdio: ["ignore", "pipe", "pipe"] });
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
        else resolve({ stopReason: "error", error: duoFailure(errTail, code, ctxEnv.GITLAB_PROJECT_PATH) });
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

  /** getContext: Settings → Harnesses → GitLab Duo (read at each session start, so changes apply to the next chat). */
  constructor(private getContext?: () => DuoContext | undefined) {}

  detect(pathOverride: string): Promise<HarnessStatus> {
    return detectExecutable({
      id: "duo", label: this.label, protocol: "headless", candidates: ["duo", "glab"], pathOverride,
      hint: "Install the GitLab Duo CLI (duo) or glab, then sign in once in a terminal.",
    });
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    const exe = o.executable ?? "duo";
    const viaGlab = /glab(\.exe)?$/i.test(exe);
    return new DuoSession(exe, viaGlab ? ["duo", "cli"] : [], o, this.getContext);
  }
}
