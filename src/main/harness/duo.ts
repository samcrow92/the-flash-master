/**
 * GitLab Duo CLI adapter. Duo has no ACP mode, so each turn runs headless:
 *   duo run --goal "<text>" [--existing-session-id <id>]     (or: glab duo cli run ...)
 * stdout is streamed as message text. Headless Duo auto-approves its own tools, so the UI flags Duo agents.
 */
import type { ChildProcess } from "node:child_process";
import type { HarnessStatus } from "@shared/types";
import { detectExecutable, killTree, spawnTool, splitArgs } from "./process";
import type { HarnessAdapter, HarnessSession, SessionOptions, TurnResult } from "./types";

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

  prompt(text: string): Promise<TurnResult> {
    const args = [...this.prefixArgs, "run", "--goal", text, ...splitArgs(this.o.extraArgs)];
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
        errTail = (errTail + s).slice(-1500);
        const sid = SESSION_RE.exec(s)?.[1];
        if (sid) this.sessionId = sid;
      });
      (child as any).__cancel = () => { cancelled = true; };
      child.on("error", (e) => resolve({ stopReason: "error", error: e.message }));
      child.on("close", (code) => {
        this.current = null;
        if (cancelled) resolve({ stopReason: "cancelled" });
        else if (code === 0) resolve({ stopReason: "end_turn" });
        else resolve({ stopReason: "error", error: `duo exited with ${code}: ${errTail.trim().slice(-400)}` });
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

  detect(pathOverride: string): Promise<HarnessStatus> {
    return detectExecutable({
      id: "duo", label: this.label, protocol: "headless", candidates: ["duo", "glab"], pathOverride,
      hint: "Install the GitLab Duo CLI (duo) or glab, then sign in once in a terminal.",
    });
  }

  async start(o: SessionOptions): Promise<HarnessSession> {
    const exe = o.executable ?? "duo";
    const viaGlab = /glab(\.exe)?$/i.test(exe);
    return new DuoSession(exe, viaGlab ? ["duo", "cli"] : [], o);
  }
}
