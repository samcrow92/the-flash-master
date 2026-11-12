import crossSpawn from "cross-spawn";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import type { HarnessStatus } from "@shared/types";

const isWin = process.platform === "win32";

/** Spawn safely on all platforms. cross-spawn handles Windows .cmd shims and argument escaping (no shell injection). */
export function spawnTool(command: string, args: string[], opts: SpawnOptions): ChildProcess {
  return crossSpawn(command, args, { windowsHide: true, ...opts, detached: !isWin });
}

/** Kill a process and its children. */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

export function runCapture(command: string, args: string[], timeoutMs = 8000, cwd?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ChildProcess;
    try {
      child = spawnTool(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd });
    } catch (e) {
      resolve({ code: -1, out: String(e) });
      return;
    }
    const t = setTimeout(() => { killTree(child); resolve({ code: null, out }); }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out: out + String(e) }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

/** Locate an executable on PATH (or accept an explicit path). */
export async function which(name: string): Promise<string | null> {
  if (name.includes("/") || name.includes("\\")) return existsSync(name) ? name : null;
  const r = await runCapture(isWin ? "where" : "which", [name], 4000);
  if (r.code !== 0) return null;
  const lines = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // On Windows prefer .cmd/.exe over extension-less shell scripts.
  return lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) ?? lines[0] ?? null;
}

export async function detectExecutable(o: { id: HarnessStatus["id"]; label: string; protocol: HarnessStatus["protocol"];
  candidates: string[]; pathOverride: string; versionArgs?: string[]; hint: string }): Promise<HarnessStatus> {
  const names = o.pathOverride ? [o.pathOverride] : o.candidates;
  for (const n of names) {
    const p = await which(n);
    if (!p) continue;
    const v = await runCapture(p, o.versionArgs ?? ["--version"], 8000);
    const version = /\d+\.\d+(\.\d+)?[\w.-]*/.exec(v.out)?.[0] ?? null;
    return { id: o.id, label: o.label, available: true, version, path: p, protocol: o.protocol, detail: null };
  }
  return { id: o.id, label: o.label, available: false, version: null, path: null, protocol: o.protocol, detail: o.hint };
}

export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
