/**
 * Links in agent replies: web URLs and local files (reports, HTML pages, docs) the agent produced. Shared by the chat
 * renderer (what becomes clickable) and the main process (src/main/links.ts decides what may actually be opened).
 */

/** Web links opened in the system browser. Everything else with a scheme (javascript:, data:, ms-*:, …) is refused. */
export const WEB_LINK = /^(https?:\/\/|mailto:)/i;

/** A Windows drive path (C:\… or C:/…). */
export const WIN_ABS = /^[A-Za-z]:[\\/]/;

/** True for text that names a local file or folder: file:// URLs, drive paths, POSIX absolute paths, ./ or ../ paths and
 *  relative paths with a file extension (reports/rca.html). Bare words and anything with another URL scheme are not. */
export function isLocalPathLink(s: string): boolean {
  const t = s.trim();
  if (!t || /\s{2}|[\n<>"|*?]/.test(t)) return false;
  if (/^file:\/\//i.test(t)) return true;
  if (WIN_ABS.test(t)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false; // another scheme
  if (t.startsWith("\\\\") || t.startsWith("//")) return false; // UNC / network paths are never opened
  if (t.startsWith("/") || t.startsWith("~/")) return /\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$/.test(t) || t.endsWith("/");
  if (/^\.\.?[\\/]/.test(t)) return true;
  // Relative: needs a folder part or a known-looking extension, so "e.g." or "v1.2" stay text.
  return /^[\w@.-]+(?:[\\/][\w@. -]+)*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?$/.test(t) && /[\\/]/.test(t);
}

/** Bare local paths worth auto-linking inside plain text: file:// URLs and Windows drive paths (no spaces). */
export const BARE_LOCAL_PATH = /(?:file:\/\/\/?[^\s<>"'`)\]]+|(?<![\w/\\:])[A-Za-z]:[\\/][^\s<>"'`|?*)\]]*)/;

/** Trailing sentence punctuation is not part of a bare path ("see C:\out\report.html."). */
export function trimTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!]+$/, "");
}

/** Image files shown inline in chats (agent screenshots, diagrams, pasted pictures). */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
/** data: images the renderer may show directly (the page's CSP allows data: images; SVG in <img> runs no script). */
export const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml|avif);base64,[A-Za-z0-9+/=\s]+$/i;

/** True for a local path / file:// URL that names an image file (a `:line` suffix or `#anchor` is not an image). */
export function isLocalImage(s: string): boolean {
  const t = s.trim();
  return isLocalPathLink(t) && IMAGE_EXT.test(t.replace(/[?#].*$/, ""));
}

/** Local image paths mentioned in plain text (tool output, logs), in order, without repeats. */
export function imagePathsIn(text: string, max = 8): string[] {
  const out: string[] = [];
  const re = /(?:file:\/\/\/?[^\s<>"'`)\]]+|(?<![\w/\\:])[A-Za-z]:[\\/][^\s<>"'`|?*)\]]*|(?<![\w:/\\.])\/[^\s<>"'`|?*)\]]+)/g;
  for (const m of text.matchAll(re)) {
    const p = trimTrailingPunctuation(m[0]);
    if (isLocalImage(p) && !out.includes(p)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** HTML pages (agent analysis reports) previewed inside the app (src/main/html-preview.ts). */
export const HTML_EXT = /\.html?$/i;

/** True for a local path / file:// URL that names an HTML file. */
export function isLocalHtml(s: string): boolean {
  const t = s.trim();
  return isLocalPathLink(t) && HTML_EXT.test(t.replace(/[?#].*$/, ""));
}
