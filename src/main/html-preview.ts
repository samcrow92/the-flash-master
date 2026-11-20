import { randomBytes } from "node:crypto";
import { posix, win32 } from "node:path";
import { HTML_EXT } from "@shared/links";
import { resolveLink, type LinkEnv } from "./links";

/**
 * HTML reports shown inside the app (the chat's report card and the full-window viewer). The renderer can't load files,
 * so a report's folder is served on the private `flash-report://<token>/…` scheme, and the page shows it in a sandboxed
 * iframe (scripts on, no same-origin, no top navigation). Pure parts live here so the rules are tested without Electron.
 *
 * - Only a local .html/.htm file that a link click could open is served (same rules as src/main/links.ts).
 * - Each report folder gets an unguessable token; requests can't leave that folder (no `..`, no other drive).
 * - Every response carries REPORT_CSP: inline scripts/styles and diagrams render, but nothing reaches the network.
 */

export const REPORT_SCHEME = "flash-report";

/** Offline by design: reports render their inline scripts, styles, SVG and local images, and can't phone home. */
export const REPORT_CSP = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${REPORT_SCHEME}:`,
  `style-src 'self' 'unsafe-inline' ${REPORT_SCHEME}:`,
  `img-src 'self' data: blob: ${REPORT_SCHEME}:`,
  `font-src 'self' data: ${REPORT_SCHEME}:`,
  `media-src 'self' data: blob: ${REPORT_SCHEME}:`,
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Larger pages are not previewed (they can still be opened in the browser). */
export const MAX_REPORT_BYTES = 40 * 1024 * 1024;

export const REPORT_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", csv: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8",
  mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav",
};

export type HtmlTarget = { ok: true; path: string; dir: string; file: string } | { ok: false; reason: string };

/** Which local HTML file a chat link names, if it may be previewed. */
export function resolveHtml(raw: string, env: LinkEnv): HtmlTarget {
  const a = resolveLink(raw, env);
  if (a.kind === "refuse") return { ok: false, reason: a.reason };
  if (a.kind === "web") return { ok: false, reason: "web pages are opened in the browser" };
  if (a.kind === "reveal" || !HTML_EXT.test(a.path)) return { ok: false, reason: "not an HTML file" };
  const P = env.platform === "win32" ? win32 : posix;
  return { ok: true, path: a.path, dir: P.dirname(a.path), file: P.basename(a.path) };
}

/** Folder ⇄ token registry for the report scheme. A folder keeps its token for the app's lifetime. */
export class ReportFolders {
  private byDir = new Map<string, string>();
  private byToken = new Map<string, string>();
  constructor(private platform: NodeJS.Platform = process.platform, private newToken = () => randomBytes(12).toString("hex")) {}

  private key(dir: string): string { return this.platform === "win32" ? dir.toLowerCase() : dir; }

  /** The URL of `file` inside `dir`. */
  urlFor(dir: string, file: string): string {
    const k = this.key(dir);
    let token = this.byDir.get(k);
    if (!token) { token = this.newToken(); this.byDir.set(k, token); this.byToken.set(token, dir); }
    return `${REPORT_SCHEME}://${token}/${encodeURIComponent(file)}`;
  }

  /** The local file a scheme URL asks for, or null when it isn't a registered folder or leaves it. */
  fileFor(url: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== `${REPORT_SCHEME}:`) return null;
    const dir = this.byToken.get(u.hostname);
    if (!dir) return null;
    return reportFile(dir, u.pathname, this.platform);
  }
}

/** `pathname` (URL-encoded, from a request) resolved inside `dir`; null if it is empty, malformed or escapes `dir`. */
export function reportFile(dir: string, pathname: string, platform: NodeJS.Platform): string | null {
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  if (rel.includes("\0")) return null;
  rel = rel.replace(/^\/+/, "");
  if (!rel) return null;
  const P = platform === "win32" ? win32 : posix;
  if (platform === "win32" && (/^[A-Za-z]:/.test(rel) || rel.startsWith("\\"))) return null;
  const root = P.resolve(dir);
  const full = P.resolve(root, rel);
  const back = P.relative(root, full);
  if (!back || back.startsWith("..") || P.isAbsolute(back)) return null;
  return full;
}

/** Content type for a served file (unknown types are sent as bytes, which the frame won't run). */
export function reportMime(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
  return REPORT_MIME[ext] ?? "application/octet-stream";
}

/** May a report frame navigate to this URL? Only within the report scheme; web links go to the browser instead. */
export function reportNavigation(url: string): "allow" | "browser" | "block" {
  if (url.startsWith(`${REPORT_SCHEME}://`)) return "allow";
  if (/^https?:\/\//i.test(url)) return "browser";
  return "block";
}
