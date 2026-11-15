import type { WebContents } from "electron";
import type { Level } from "./log";

/** Reload a gone renderer at most this many times within the window; past that, stop and tell the user. */
export const RELOAD_LIMIT = 3;
export const RELOAD_WINDOW_MS = 120_000;

/**
 * Decides whether a renderer that died should be reloaded. Keeps the times of recent reloads so a renderer that dies on
 * every start doesn't spin forever. `clean-exit` is a normal close, not a crash.
 */
export class ReloadBudget {
  private times: number[] = [];
  constructor(private limit = RELOAD_LIMIT, private windowMs = RELOAD_WINDOW_MS) {}
  take(reason: string, now = Date.now()): "reload" | "give-up" | "ignore" {
    if (reason === "clean-exit") return "ignore";
    this.times = this.times.filter((t) => now - t < this.windowMs);
    if (this.times.length >= this.limit) return "give-up";
    this.times.push(now);
    return "reload";
  }
}

/** One line for main.log from a renderer console message; only errors and warnings are worth keeping. */
export function consoleLine(level: string, message: string, sourceId: string, line: number): string | null {
  if (level !== "error" && level !== "warning") return null;
  const where = sourceId ? ` (${sourceId.replace(/^.*\/(?=[^/]+$)/, "")}:${line})` : "";
  return `renderer ${level}: ${message.slice(0, 4000)}${where}`;
}

/**
 * Keeps a window from sitting on a blank screen: logs renderer errors to main.log, and reloads the page when the
 * renderer process crashes, runs out of memory or is killed (the window would otherwise stay an empty frame).
 */
export function guardWebContents(wc: WebContents, name: string, log: (lvl: Level, msg: string) => void, giveUp: (reason: string) => void): void {
  const budget = new ReloadBudget();
  wc.on("console-message", (e) => {
    const line = consoleLine(e.level, e.message, e.sourceId, e.lineNumber);
    if (line) log(e.level === "error" ? "error" : "warn", `${name} ${line}`);
  });
  wc.on("render-process-gone", (_e, d) => {
    const action = budget.take(d.reason);
    log(action === "ignore" ? "info" : "error", `${name} renderer gone: ${d.reason} (exit ${d.exitCode}) → ${action}`);
    if (action === "reload" && !wc.isDestroyed()) wc.reload();
    else if (action === "give-up") giveUp(d.reason);
  });
  wc.on("unresponsive", () => log("warn", `${name} renderer unresponsive`));
  wc.on("responsive", () => log("info", `${name} renderer responsive again`));
  wc.on("preload-error", (_e, path, err) => log("error", `${name} preload error in ${path}: ${err.message}`));
}
