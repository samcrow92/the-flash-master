import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { AppEvent } from "@shared/types";

/** The parts of node-pty this module uses (loaded lazily: it is a native module, and most sessions never open a terminal). */
interface Pty {
  pid: number;
  onData(cb: (d: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
type Spawn = (file: string, args: string[], opts: Record<string, unknown>) => Pty;

export interface ShellChoice { file: string; args: string[]; name: string }

/** First executable named `name` on PATH, or null. */
function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** The user's shell: PowerShell 7 if installed, else Windows PowerShell; on macOS/Linux their login shell. */
export function defaultShell(platform = process.platform, env = process.env): ShellChoice {
  if (platform === "win32") {
    const pwsh = onPath("pwsh.exe", env);
    if (pwsh) return { file: pwsh, args: ["-NoLogo"], name: "PowerShell" };
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const ps = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (platform !== process.platform || existsSync(ps)) return { file: ps, args: ["-NoLogo"], name: "Windows PowerShell" };
    return { file: env.ComSpec ?? "cmd.exe", args: [], name: "Command Prompt" };
  }
  const file = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return { file, args: platform === "darwin" ? ["-l"] : [], name: file.split("/").pop() ?? file };
}

/**
 * Integrated terminals: real shells in pseudo-terminals (ConPTY on Windows), streamed to the renderer's xterm.js.
 * Output is coalesced per session for a few milliseconds so a noisy command doesn't flood IPC with tiny messages.
 */
export class Terminals {
  private sessions = new Map<string, { pty: Pty; buf: string; timer: NodeJS.Timeout | null }>();
  private seq = 0;
  private spawnFn: Spawn | null = null;

  constructor(private send: (e: AppEvent) => void, private loadSpawn: () => Promise<Spawn> = loadNodePty) {}

  async open(input: { cols: number; rows: number; cwd?: string | null }): Promise<{ id: string; shell: string; cwd: string }> {
    this.spawnFn ??= await this.loadSpawn();
    const shell = defaultShell();
    const cwd = input.cwd && isDir(input.cwd) ? input.cwd : homedir();
    const env = { ...process.env, TERM_PROGRAM: "TheFlashMaster", COLORTERM: "truecolor" } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const pty = this.spawnFn(shell.file, shell.args, {
      name: "xterm-256color", cols: clamp(input.cols), rows: clamp(input.rows), cwd, env, useConpty: true,
    });
    const id = `t${++this.seq}`;
    const s = { pty, buf: "", timer: null as NodeJS.Timeout | null };
    this.sessions.set(id, s);
    pty.onData((d) => {
      s.buf += d;
      s.timer ??= setTimeout(() => this.flush(id), 6);
    });
    pty.onExit(({ exitCode }) => {
      this.flush(id);
      this.sessions.delete(id);
      this.send({ type: "terminal.exit", id, code: exitCode });
    });
    return { id, shell: shell.name, cwd };
  }

  write(id: string, data: string): void { this.sessions.get(id)?.pty.write(data); }

  resize(id: string, cols: number, rows: number): void {
    try { this.sessions.get(id)?.pty.resize(clamp(cols), clamp(rows)); } catch { /* the shell exited between events */ }
  }

  close(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.sessions.delete(id);
    try { s.pty.kill(); } catch { /* already gone */ }
  }

  closeAll(): void { for (const id of [...this.sessions.keys()]) this.close(id); }

  get count(): number { return this.sessions.size; }

  private flush(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    if (!s.buf) return;
    const data = s.buf;
    s.buf = "";
    this.send({ type: "terminal.data", id, data });
  }
}

const clamp = (n: number) => Math.max(2, Math.min(1000, Math.floor(Number(n) || 0) || 80));
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

async function loadNodePty(): Promise<Spawn> {
  if (process.platform === "darwin") ensureSpawnHelper();
  const mod = (await import("node-pty")) as unknown as { spawn?: Spawn; default?: { spawn: Spawn } };
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (!spawn) throw new Error("node-pty did not load");
  return spawn;
}

/**
 * node-pty 1.1.0 ships its macOS spawn-helper without the executable bit ("posix_spawnp failed" on every spawn).
 * scripts/fix-node-pty.mjs fixes it at install time; this repeats it at runtime in case an install skipped scripts.
 */
function ensureSpawnHelper(): void {
  try {
    const dir = join(createRequire(import.meta.url).resolve("node-pty/package.json"), "..").replace("app.asar", "app.asar.unpacked");
    for (const sub of [join("build", "Release"), join("prebuilds", `darwin-${process.arch}`)]) {
      const helper = join(dir, sub, "spawn-helper");
      if (existsSync(helper)) chmodSync(helper, 0o755);
    }
  } catch { /* read-only install: the install-time fix applies */ }
}
