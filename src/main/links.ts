import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { WEB_LINK, WIN_ABS } from "@shared/links";

/**
 * What a click on a link in a chat reply may do. Pure (fs and platform injected) so the rules are tested without Electron.
 * - http(s)/mailto → system browser / mail app.
 * - Local files and folders → opened with their default app (an .html report opens in the browser). Programs and scripts
 *   (.exe, .bat, .ps1, .lnk, …) are never launched: their folder is shown with the file selected instead.
 * - Refused: other schemes (javascript:, data:, ms-*), UNC/network paths, relative paths that leave the project, missing files.
 */
export type LinkAction =
  | { kind: "web"; url: string }
  | { kind: "open"; path: string }
  | { kind: "reveal"; path: string }
  | { kind: "refuse"; reason: string };

export interface LinkEnv {
  platform: NodeJS.Platform;
  /** Folders a relative path may be resolved against (the chat's project first). */
  bases: string[];
  home: string;
  exists(path: string): boolean;
}

/** Launching these would run code; they are shown in their folder instead. */
const RUNNABLE = new Set([
  "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "mjs", "cjs", "wsf", "wsh", "msi", "msp", "msix", "appx",
  "scr", "lnk", "url", "hta", "cpl", "jar", "reg", "sh", "bash", "zsh", "command", "app", "appimage", "desktop", "pif", "application",
  "gadget", "scf", "inf", "dll", "sys", "py", "pyw", "rb", "pl", "applescript", "workflow", "run", "bin", "deb", "rpm", "pkg", "dmg", "iso",
  "settingcontent-ms", "library-ms", "search-ms",
]);

export function resolveLink(raw: string, env: LinkEnv): LinkAction {
  let t = String(raw ?? "").trim().replace(/^<(.*)>$/, "$1").replace(/^["'](.*)["']$/, "$1");
  if (!t) return { kind: "refuse", reason: "empty link" };
  if (WEB_LINK.test(t)) {
    try { const u = new URL(t); return { kind: "web", url: u.toString() }; } catch { return { kind: "refuse", reason: "malformed URL" }; }
  }
  const win = env.platform === "win32";
  const P = win ? win32 : posix;
  if (/^file:/i.test(t)) {
    try { t = fileURLToPath(t, { windows: win }); } catch { return { kind: "refuse", reason: "malformed file:// URL" }; }
    if (win && /^[\\/]{2}/.test(t)) return { kind: "refuse", reason: "network paths are not opened" };
  } else if (WIN_ABS.test(t)) {
    if (!win) return { kind: "refuse", reason: "Windows path on another system" };
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    return { kind: "refuse", reason: "unsupported link type" };
  }
  if (/^[\\/]{2}/.test(t)) return { kind: "refuse", reason: "network paths are not opened" };
  if (t.includes("\0")) return { kind: "refuse", reason: "invalid path" };
  t = t.replace(/#L?\d+(?:-L?\d+)?$/, "");
  if (t.startsWith("~/") || t.startsWith("~\\")) t = P.join(env.home, t.slice(2));

  const candidates: string[] = [];
  if (P.isAbsolute(t) && (!win || WIN_ABS.test(t))) {
    const n = P.normalize(t);
    candidates.push(n.length > P.parse(n).root.length ? n.replace(/[\\/]+$/, "") : n);
  } else if (!P.isAbsolute(t)) {
    for (const base of env.bases.filter(Boolean)) {
      const root = P.resolve(base);
      const full = P.resolve(root, t);
      const rel = P.relative(root, full);
      if (rel.startsWith("..") || P.isAbsolute(rel)) return { kind: "refuse", reason: "path leaves the project folder" };
      candidates.push(full);
    }
    if (!candidates.length) return { kind: "refuse", reason: "relative path with no project folder" };
  } else return { kind: "refuse", reason: "unsupported path" }; // e.g. a rooted "\foo" on Windows

  // "src/app.ts:42" or ":42:7" from an agent: try the path as written, then without the line suffix.
  const tries = candidates.flatMap((c) => { const s = c.replace(/:\d+(?::\d+)?$/, ""); return s !== c ? [c, s] : [c]; });
  const path = tries.find((c) => env.exists(c));
  if (!path) return { kind: "refuse", reason: `not found: ${candidates[0]}` };
  const ext = P.extname(path).slice(1).toLowerCase();
  return RUNNABLE.has(ext) ? { kind: "reveal", path } : { kind: "open", path };
}
