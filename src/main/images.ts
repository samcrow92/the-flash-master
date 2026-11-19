import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { IMAGE_EXT } from "@shared/links";
import { resolveLink, type LinkEnv } from "./links";

/**
 * Images in chats. The renderer's CSP only allows `data:` images, so a local picture an agent mentions
 * (`![shot](C:\out\shot.png)`, a bare path, a screenshot from a tool) is read here and handed over as a data URL.
 * The same rules as clicking a link apply (src/main/links.ts): no network paths, relative paths stay in the project.
 */

export const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
};
const EXT_OF: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg", "image/avif": "avif" };

/** Larger files are not inlined (they are still clickable). */
export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;

export type ImageTarget = { ok: true; path: string; mime: string } | { ok: false; reason: string };

/** Which local file an image reference in a chat names, if it may be shown. Pure (fs injected via env). */
export function resolveImage(raw: string, env: LinkEnv): ImageTarget {
  const a = resolveLink(raw, env);
  if (a.kind === "refuse") return { ok: false, reason: a.reason };
  if (a.kind === "web") return { ok: false, reason: "web images are not loaded" };
  const m = IMAGE_EXT.exec(a.path);
  if (!m) return { ok: false, reason: "not an image" };
  return { ok: true, path: a.path, mime: IMAGE_MIME[(m[1] ?? "").toLowerCase()] ?? "application/octet-stream" };
}

let agentImageDir = join(tmpdir(), "flashmaster-images");
/** Where images that agents send as content blocks (screenshots, generated pictures) are kept. */
export function setAgentImageDir(dir: string): void { agentImageDir = dir; }

/** Save an image an agent sent inline (base64) and return its path; the same picture is stored once. */
export function saveAgentImage(dataBase64: string, mime: string, dir = agentImageDir): string | null {
  const ext = EXT_OF[String(mime).toLowerCase()];
  if (!ext || !dataBase64) return null;
  try {
    const buf = Buffer.from(dataBase64, "base64");
    if (!buf.length || buf.length > MAX_INLINE_IMAGE_BYTES) return null;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${createHash("sha256").update(buf).digest("hex").slice(0, 16)}.${ext}`);
    if (!existsSync(path)) writeFileSync(path, buf);
    return path;
  } catch { return null; }
}

/** ACP image content ({type:"image", data, mimeType} or {type:"image", uri}) as Markdown the chat shows inline. */
export function imageBlockMarkdown(c: unknown, dir?: string): string | null {
  const x = c as { type?: string; data?: unknown; mimeType?: unknown; uri?: unknown } | null;
  if (x?.type !== "image") return null;
  if (typeof x.data === "string" && x.data) {
    const p = saveAgentImage(x.data, String(x.mimeType ?? ""), dir);
    return p ? `![image](${pathToFileURL(p).href})` : null;
  }
  if (typeof x.uri === "string" && /^file:/i.test(x.uri)) return `![image](${x.uri})`;
  return null;
}
