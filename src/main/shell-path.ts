/**
 * macOS (and Linux desktop) apps started from Finder, the Dock or Spotlight get launchd's minimal PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), not the one from the user's shell profile. Agent CLIs live in ~/.local/bin,
 * /opt/homebrew/bin, npm's global bin…, and Node-based ones need `node` on PATH for their `#!/usr/bin/env node` line.
 * So read PATH from a login shell once at startup and merge it in, plus the usual install folders as a fallback.
 */
import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";

const MARK = "__FLASH_PATH__";

export function mergePaths(...lists: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) for (const p of (l ?? "").split(delimiter)) if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  return out.join(delimiter);
}

/** The PATH a login shell sets up, or "" when it can't be read in time. */
export function loginShellPath(shell = process.env.SHELL || "/bin/zsh", timeoutMs = 4000): string {
  try {
    const out = execFileSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
    });
    return new RegExp(`${MARK}(.*)${MARK}`).exec(out)?.[1] ?? "";
  } catch {
    return "";
  }
}

/** Fix process.env.PATH on macOS/Linux so spawned harnesses resolve like they do in Terminal. No-op on Windows. */
export function fixPath(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform === "win32") return;
  const home = env.HOME ?? "";
  const common = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", ...(home ? [`${home}/.local/bin`, `${home}/.npm-global/bin`, `${home}/.bun/bin`, `${home}/.opencode/bin`] : [])];
  env.PATH = mergePaths(loginShellPath(env.SHELL || "/bin/zsh"), env.PATH, common.join(delimiter));
}
