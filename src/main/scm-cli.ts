/**
 * EWM SCM command line (scm / lscm from the EWM client or SCM tools), used only for read-only folder listings.
 * Windows-first: scm.exe is preferred because lscm is a .bat file, which can only run through cmd.exe.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { CliRunner } from "./scm";

const NAMES = process.platform === "win32" ? ["scm.exe", "lscm.bat", "scm.bat"] : ["lscm", "scm"];

/** The configured CLI (file, or folder holding it), else the first one on PATH. */
export function findScmCli(configured: string, path = process.env.PATH ?? "", names = NAMES): string | null {
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  const c = configured.trim().replace(/^"|"$/g, "");
  if (c) {
    if (isFile(c)) return c;
    for (const n of names) if (isFile(join(c, n))) return join(c, n);
    return null;
  }
  for (const dir of path.split(delimiter).filter(Boolean)) for (const n of names) { const p = join(dir, n); if (existsSync(p) && isFile(p)) return p; }
  return null;
}

/** cmd.exe argument quoting for .bat files; refuses characters cmd would still expand. */
export function cmdQuote(a: string): string {
  if (/["%!^\r\n]/.test(a)) throw new Error(`argument not allowed for the SCM command line: ${a.slice(0, 40)}`);
  return /[\s&|<>()]/.test(a) || a === "" ? `"${a}"` : a;
}

/** Runs the CLI with credentials appended after the repository option (when the Jazz user/password are set). */
export function scmCliRunner(exe: string, creds: { user: string; password: string } | null, timeoutMs = 180_000): CliRunner {
  return (args) => new Promise((resolve) => {
    const full = [...args];
    const r = full.indexOf("-r");
    if (creds && r >= 0) full.splice(r + 2, 0, "-u", creds.user, "-P", creds.password);
    const bat = /\.(bat|cmd)$/i.test(exe);
    let child;
    try {
      child = bat
        ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${[cmdQuote(exe), ...full.map(cmdQuote)].join(" ")}"`], { windowsHide: true, windowsVerbatimArguments: true })
        : spawn(exe, full, { windowsHide: true });
    } catch (e: any) {
      resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
      return;
    }
    let stdout = "", stderr = "";
    const cap = 50_000_000;
    child.stdout?.on("data", (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr?.on("data", (d) => { if (stderr.length < 100_000) stderr += d; });
    const timer = setTimeout(() => { child.kill(); stderr += `\ntimed out after ${Math.round(timeoutMs / 1000)} s`; }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Never echo the password back in an error message.
      const hide = (s: string) => creds?.password ? s.split(creds.password).join("***") : s;
      resolve({ code: code ?? -1, stdout, stderr: hide(stderr) });
    });
  });
}
