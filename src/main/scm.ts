/**
 * IBM Engineering Workflow Management source control, read-only: streams, components, folders and file contents.
 * Nothing here checks in, delivers or changes a stream.
 *  - streams / components : Reportable REST API  <ccm>/rpt/repository/scm?fields=scm/workspace[stream='true']/…
 *                           (fallback for components: <ccm>/service/com.ibm.team.scm.common.internal.rest.IScmRestService2/workspace?workspaceItemId=…)
 *  - file contents        : <ccm>/service/com.ibm.team.filesystem.service.internal.rest.IFilesystemContentService/<streamId>/<componentId>/<path>
 *  - folder listing       : EWM has no public REST call for it. The file content service sends a folder as a zip
 *                           (…/<stream>/<component>/<path or ->?itemType=com.ibm.team.scm.Folder&contextType=…&format=zip
 *                           [&itemId=<folder>], the web UI's "Download as zip"), which gives the listing, file search
 *                           and the files of a folder link. The EWM SCM command line is only a fallback.
 * HTTP goes through the shared Jazz client (same sign-in, cookies, proxy and certificates as work items).
 */
import type { JazzHttp } from "./etm";
import { readZip, type ZipEntry } from "./scm-zip";

export interface ScmStream { id: string; name: string; description?: string; components?: ScmComponent[] }
export interface ScmComponent { id: string; name: string }
export interface ScmEntry { path: string; folder: boolean }
export type CliRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => decode(new RegExp(`<(?:[\\w.-]+:)?${name}>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`).exec(xml)?.[1]?.trim() ?? "");
const RPT = "/rpt/repository/scm";
const CONTENT = "/service/com.ibm.team.filesystem.service.internal.rest.IFilesystemContentService";
const SCM2 = "/service/com.ibm.team.scm.common.internal.rest.IScmRestService2";

/** Components inside a fragment: <components>/<component> blocks that carry an itemId and a name. */
export function parseComponents(xml: string): ScmComponent[] {
  const out = new Map<string, ScmComponent>();
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?components?\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?components?>/g)) {
    const id = tag(m[1]!, "itemId"), name = tag(m[1]!, "name");
    if (id && name) out.set(id, { id, name });
  }
  if (!out.size) {
    // JSON shape of the web client's service ({"components":[{"itemId":"_…","name":"…"}]}).
    for (const m of xml.matchAll(/\{[^{}]*"itemId"\s*:\s*"(_[^"]+)"[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*\}/g)) out.set(m[1]!, { id: m[1]!, name: m[2]! });
  }
  return [...out.values()];
}

/** <workspace> elements of the reportable SCM feed (components stripped before reading the stream's own fields). */
export function parseStreams(xml: string): ScmStream[] {
  const out: ScmStream[] = [];
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?workspace\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?workspace>/g)) {
    const own = m[1]!.replace(/<(?:[\w.-]+:)?components?\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?components?>/g, "").replace(/<(?:[\w.-]+:)?(projectArea|teamArea|owner)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?\1>/g, "");
    const id = tag(own, "itemId"), name = tag(own, "name");
    if (!id || !name) continue;
    const components = parseComponents(m[1]!);
    out.push({ id, name, ...(tag(own, "description") ? { description: tag(own, "description").slice(0, 200) } : {}), ...(components.length ? { components } : {}) });
  }
  return out;
}

/** Entries from `scm list remotefiles --json` (shape varies by version: walk for objects with a path), or its text output. */
export function parseRemoteFiles(out: string): ScmEntry[] {
  const seen = new Map<string, ScmEntry>();
  const add = (p: string) => { const path = p.replace(/\\/g, "/"); if (path && path !== "/") seen.set(path, { path: path.replace(/\/$/, "") || "/", folder: path.endsWith("/") }); };
  try {
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.path === "string") add(o.path);
        Object.values(o).forEach(walk);
      }
    };
    walk(JSON.parse(out));
  } catch {
    for (const line of out.split(/\r?\n/)) { const m = /^\s*(\/\S.*?)\s*$/.exec(line); if (m) add(m[1]!); }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

const globRe = (g: string) => new RegExp(`(^|/)${g.split("**/").join("**").split("**").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("(?:.*/)?")}$`, "i");

export class ScmClient {
  private streamCache: { at: number; list: ScmStream[] } | null = null;
  private listCache = new Map<string, { at: number; entries: ScmEntry[] }>();
  private zipCache = new Map<string, { at: number; entries: ZipEntry[] }>();

  constructor(private http: JazzHttp, private cli: () => { run: CliRunner; repo: string } | null) {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const s = await this.streams({ max: 500 }, true);
      const cli = this.cli();
      return { ok: true, detail: `Connected · ${s.length} stream${s.length === 1 ? "" : "s"} visible · reading files works through REST · folder listings use EWM's zip download · changes (workspaces, check-in, accept, deliver) ${cli ? "use the EWM SCM command line" : "need the EWM SCM command line (scm/lscm), not found"}` };
    } catch (e: any) {
      return { ok: false, detail: String(e?.message ?? e) };
    }
  }

  async streams(o: { text?: string; max?: number } = {}, refresh = false): Promise<ScmStream[]> {
    if (!this.streamCache || refresh || Date.now() - this.streamCache.at > 5 * 60000) {
      let list: ScmStream[] | null = null;
      let err: unknown;
      for (const fields of ["scm/workspace[stream='true']/(itemId|name|description)", "scm/workspace[stream='true']/*"]) {
        try { list = parseStreams(await this.get(`${RPT}?fields=${encodeURIComponent(fields)}`)); break; } catch (e) { err = e; if (/HTTP 40[13]/.test(String((e as Error)?.message))) throw e; }
      }
      if (!list) throw err;
      this.streamCache = { at: Date.now(), list };
    }
    const words = (o.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    return this.streamCache.list.filter((s) => words.every((w) => `${s.name} ${s.description ?? ""}`.toLowerCase().includes(w)))
      .slice(0, Math.min(Math.max(o.max ?? 50, 1), 500)).map(({ components: _c, ...s }) => s);
  }

  async stream(ref: string): Promise<ScmStream> {
    const r = ref.trim();
    await this.streams({ max: 1 });
    const all = this.streamCache!.list;
    const hit = all.find((s) => s.id === r) ?? all.find((s) => s.name === r) ?? all.find((s) => s.name.toLowerCase() === r.toLowerCase());
    if (hit) return hit;
    if (/^_[\w-]{10,}$/.test(r)) return { id: r, name: r };
    const near = all.filter((s) => s.name.toLowerCase().includes(r.toLowerCase())).slice(0, 5).map((s) => s.name);
    throw new Error(`stream “${ref}” not found${near.length ? ` — did you mean: ${near.join(", ")}` : ""}`);
  }

  async components(streamRef: string): Promise<ScmComponent[]> {
    const s = await this.stream(streamRef);
    if (s.components?.length) return s.components;
    const tries = [
      () => this.get(`${RPT}?fields=${encodeURIComponent(`scm/workspace[itemId='${s.id}']/components/(itemId|name)`)}`),
      () => this.get(`${RPT}?fields=${encodeURIComponent(`scm/workspace[itemId='${s.id}']/*/*`)}`),
      () => this.get(`${SCM2}/workspace?workspaceItemId=${encodeURIComponent(s.id)}`, "text/json, application/json, text/xml"),
    ];
    for (const t of tries) {
      const body = await t().catch((e) => { if (/HTTP 40[13]/.test(String(e?.message))) throw e; return ""; });
      const comps = parseComponents(body);
      if (comps.length) { s.components = comps; return comps; }
    }
    throw new Error(`could not read the components of stream “${s.name}”`);
  }

  async component(streamRef: string, ref: string): Promise<{ stream: ScmStream; component: ScmComponent }> {
    const stream = await this.stream(streamRef);
    const r = ref.trim();
    if (/^_[\w-]{10,}$/.test(r)) return { stream, component: stream.components?.find((c) => c.id === r) ?? { id: r, name: r } };
    const comps = await this.components(stream.id);
    const hit = comps.find((c) => c.name === r) ?? comps.find((c) => c.name.toLowerCase() === r.toLowerCase());
    if (!hit) throw new Error(`component “${ref}” is not in stream “${stream.name}” — it has: ${comps.map((c) => c.name).slice(0, 30).join(", ")}`);
    return { stream, component: hit };
  }

  /**
   * File text (latest state in the stream). Lines can be windowed for big files. With `folder` (a folder's item id, from a
   * link) the path is relative to that folder and the file comes from the folder's archive, so no full path is needed.
   */
  async readFile(streamRef: string, compRef: string, path: string, o: { startLine?: number; lines?: number; maxChars?: number; folder?: string } = {}):
    Promise<{ path: string; stream: string; component: string; totalLines: number; startLine: number; text: string; truncated: boolean }> {
    const f = await this.fileBytes(streamRef, compRef, path, o.folder);
    const body = f.data.toString("utf8");
    if (f.data.includes(0)) throw new Error(`${f.path} is a binary file (${f.data.length} bytes); only text files can be read. Copy it into your working folder with scm_download instead.`);
    const all = body.split(/\r?\n/);
    const start = Math.max(1, Math.floor(o.startLine ?? 1));
    const count = Math.max(1, Math.min(Math.floor(o.lines ?? 400), 4000));
    let text = all.slice(start - 1, start - 1 + count).join("\n");
    const maxChars = o.maxChars ?? 60000;
    const truncated = start - 1 + count < all.length || text.length > maxChars;
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return { path: f.path, stream: f.stream, component: f.component, totalLines: all.length, startLine: start, text, truncated };
  }

  /** Whole file text, for downloads. */
  async fileText(streamRef: string, compRef: string, path: string, folder?: string): Promise<string> {
    const r = await this.readFile(streamRef, compRef, path, { startLine: 1, lines: 4000, maxChars: 20_000_000, folder });
    if (r.totalLines > 4000) {
      const rest = await this.readFile(streamRef, compRef, path, { startLine: 4001, lines: 4000, maxChars: 20_000_000, folder }).catch(() => null);
      if (r.totalLines > 8000 || !rest) throw new Error(`${r.path} has ${r.totalLines} lines — read it in windows with startLine/lines`);
      return `${r.text}\n${rest.text}`;
    }
    return r.text;
  }

  /** A file's bytes (text or binary): by path through the content service, or from a folder's archive. */
  async fileBytes(streamRef: string, compRef: string, path: string, folder?: string): Promise<{ path: string; stream: string; component: string; data: Buffer }> {
    const { stream, component } = await this.component(streamRef, compRef);
    const clean = normPath(path);
    if (!clean) throw new Error("path is required: a file path (relative to the folder in the link, or to the component root). List the folder with scm_list first.");
    if (folder) {
      const a = await this.folderArchive(stream.id, component.id, { folder });
      const e = pickEntry(a.entries, clean);
      return { path: e.path, stream: stream.name, component: component.name, data: e.data() };
    }
    const url = `${CONTENT}/${encodeURIComponent(stream.id)}/${encodeURIComponent(component.id)}/${clean.split("/").map(encodeURIComponent).join("/")}`;
    const r = await this.http.request("GET", url, undefined, { Accept: "*/*", "OSLC-Core-Version": "none" });
    if (r.status === 404) throw new Error(`file not found: ${clean} in ${component.name} (${stream.name})`);
    if (!r.ok) throw new Error(`EWM: HTTP ${r.status} reading ${clean}`);
    const data = await bytes(r);
    signInPage(data);
    return { path: clean, stream: stream.name, component: component.name, data };
  }

  /**
   * Every file and folder under a folder, from the file content service's zip download (what the EWM web UI's
   * "Download as zip" calls). Needs no command line. The folder is its item id (from a link) or its path; neither = root.
   * Paths come back relative to that folder.
   */
  async folderArchive(streamRef: string, compRef: string, o: { folder?: string; path?: string } = {}): Promise<{ entries: ZipEntry[] }> {
    const { stream, component } = await this.component(streamRef, compRef);
    const clean = o.path ? normPath(o.path) : "";
    const key = `${stream.id}|${component.id}|${o.folder ?? ""}|${clean}`;
    const hit = this.zipCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return { entries: hit.entries };
    const isStream = this.streamCache?.list.some((s) => s.id === stream.id);
    const contexts = (isStream === false ? "Workspace Stream" : "Stream Workspace").split(" ");
    const seg = clean ? clean.split("/").map(encodeURIComponent).join("/") : "-";
    const tried: string[] = [];
    for (const ctx of contexts) {
      const q = new URLSearchParams({ itemType: "com.ibm.team.scm.Folder", contextType: `com.ibm.team.scm.${ctx}`, format: "zip", ...(o.folder ? { itemId: o.folder } : {}) });
      const r = await this.http.request("GET", `${CONTENT}/${encodeURIComponent(stream.id)}/${encodeURIComponent(component.id)}/${seg}?${q}`, undefined,
        { Accept: "application/zip, application/octet-stream, */*", "OSLC-Core-Version": "none" });
      if (r.status === 401 || r.status === 403) throw new Error(`EWM: HTTP ${r.status} downloading the folder — check the Jazz sign-in and your access to this stream`);
      if (!r.ok) { tried.push(`${ctx}: HTTP ${r.status}`); continue; }
      const data = await bytes(r);
      signInPage(data);
      if (data.length > MAX_ARCHIVE) throw new Error(`the folder is too big to read in one go (${Math.round(data.length / 1e6)} MB); use a link to a smaller folder`);
      let entries: ZipEntry[];
      try { entries = data.length >= 4 && data.readUInt32LE(0) === 0x06054b50 ? [] : readZip(data); } catch (e: any) { tried.push(`${ctx}: ${e?.message ?? e}`); continue; }
      entries = withFolders(stripRoot(entries, clean.split("/").pop() || "", !!o.folder || !clean));
      this.zipCache.set(key, { at: Date.now(), entries });
      return { entries };
    }
    throw new Error(`EWM did not send the folder (${tried.join("; ")})`);
  }

  /**
   * Folder contents. Uses EWM's own zip download of the folder (no command line needed); the EWM SCM command line is
   * only a fallback when the server refuses that. `folder` is a folder's item id from a link; then `path` is inside it.
   */
  async list(streamRef: string, compRef: string, path = "/", depth = 1, folder?: string): Promise<ScmEntry[]> {
    const { stream, component } = await this.component(streamRef, compRef);
    const d = Math.max(1, Math.min(Math.floor(depth), 50));
    const sub = normPath(path);
    try {
      const a = await this.folderArchive(stream.id, component.id, folder ? { folder } : { path: sub });
      const base = folder ? sub : "";
      const out: ScmEntry[] = [];
      for (const e of a.entries) {
        if (base && !e.path.startsWith(`${base}/`)) continue;
        const rel = base ? e.path.slice(base.length + 1) : e.path;
        if (rel.split("/").length > d) continue;
        out.push({ path: `/${folder ? e.path : [sub, e.path].filter(Boolean).join("/")}`, folder: e.folder });
      }
      return out.sort((x, y) => x.path.localeCompare(y.path));
    } catch (e: any) {
      const cli = this.cli();
      if (!cli || folder) throw new Error(`could not list ${sub ? `/${sub}` : "the folder"} in ${component.name} (${stream.name}): ${e?.message ?? e}`, { cause: e });
      return this.listCli(stream, component, cli, sub, d);
    }
  }

  private async listCli(stream: ScmStream, component: ScmComponent, cli: { run: CliRunner; repo: string }, sub: string, d: number): Promise<ScmEntry[]> {
    const key = `${stream.id}|${component.id}|${sub}|${d}`;
    const hit = this.listCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.entries;
    const args = ["list", "remotefiles", "-r", cli.repo, "--json", "--depth", String(d), stream.name, component.name, ...(sub ? [`/${sub}`] : [])];
    const r = await cli.run(args);
    if (r.code !== 0) throw new Error(`scm list remotefiles failed (${r.code}): ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400)}`);
    const entries = parseRemoteFiles(r.stdout);
    this.listCache.set(key, { at: Date.now(), entries });
    return entries;
  }

  /** Files whose path matches a glob (*.c, src/**\/can*.h) or contains the words. */
  async find(streamRef: string, compRef: string, pattern: string, path = "/", depth = 50, folder?: string): Promise<ScmEntry[]> {
    const all = await this.list(streamRef, compRef, path, depth, folder);
    const p = pattern.trim();
    const match = /[*?]/.test(p) ? ((e: ScmEntry) => globRe(p).test(e.path)) : ((e: ScmEntry) => p.toLowerCase().split(/\s+/).every((w) => e.path.toLowerCase().includes(w)));
    return all.filter((e) => !e.folder && match(e));
  }

  private async get(path: string, accept = "text/xml"): Promise<string> {
    const r = await this.http.request("GET", path, undefined, { Accept: accept, "OSLC-Core-Version": "none" });
    if (!r.ok) throw new Error(`EWM: HTTP ${r.status} for ${path.split("?")[0]}`);
    return r.text();
  }
}

/** Folder archives bigger than this are refused (they are held in memory). */
const MAX_ARCHIVE = 300_000_000;

async function bytes(r: { text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }): Promise<Buffer> {
  return r.arrayBuffer ? Buffer.from(await r.arrayBuffer()) : Buffer.from(await r.text(), "utf8");
}
function signInPage(data: Buffer): void {
  const head = data.subarray(0, 2000).toString("utf8");
  if (/^\s*<(!doctype html|html)/i.test(head) && /j_security_check|authrequired|login/i.test(head)) throw new Error("EWM returned a sign-in page — check the Jazz sign-in (Settings → Integrations → IBM Jazz)");
}
/** Drops the folder's own name when the archive wraps everything in it (only one top folder, named like the folder). */
export function stripRoot(entries: ZipEntry[], name: string, anyName: boolean): ZipEntry[] {
  const tops = new Set(entries.map((e) => e.path.split("/")[0]!));
  if (tops.size !== 1) return entries;
  const top = [...tops][0]!;
  if (!(anyName || top === name) || !entries.some((e) => e.path.includes("/"))) return entries;
  return entries.filter((e) => e.path !== top).map((e) => ({ ...e, path: e.path.slice(top.length + 1) }));
}
/** Adds the folders that only appear as parts of file paths. */
export function withFolders(entries: ZipEntry[]): ZipEntry[] {
  const have = new Set(entries.map((e) => e.path));
  const out = [...entries];
  for (const e of entries) {
    const parts = e.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const f = parts.slice(0, i).join("/");
      if (!have.has(f)) { have.add(f); out.push({ path: f, folder: true, size: 0, data: () => Buffer.alloc(0) }); }
    }
  }
  return out;
}
/** The archive entry for a path: exact, else the one file whose path ends with it. */
export function pickEntry(entries: ZipEntry[], path: string): ZipEntry {
  const files = entries.filter((e) => !e.folder);
  const exact = files.find((e) => e.path === path) ?? files.find((e) => e.path.toLowerCase() === path.toLowerCase());
  if (exact) return exact;
  const tail = files.filter((e) => e.path.toLowerCase().endsWith(`/${path.toLowerCase()}`));
  if (tail.length === 1) return tail[0]!;
  if (tail.length > 1) throw new Error(`${path} matches several files: ${tail.slice(0, 10).map((e) => e.path).join(", ")} — pass the full path`);
  const near = files.filter((e) => e.path.toLowerCase().includes(path.split("/").pop()!.toLowerCase())).slice(0, 10).map((e) => e.path);
  throw new Error(`file not found: ${path}${near.length ? ` — did you mean: ${near.join(", ")}` : ` (the folder has ${files.length} files; list them with scm_list)`}`);
}

/** Repository path without a leading slash; rejects parent references. */
export function normPath(p: string): string {
  const parts = String(p ?? "").replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (parts.includes("..")) throw new Error("paths may not contain ..");
  return parts.join("/");
}

/** What an EWM link names: the server (…/ccm) and, when present, the stream or workspace, component, path and change set. */
export interface ScmLink { repo: string; stream?: string; component?: string; path?: string; changeset?: string; folder?: string }
const ITEM_ID = /^_[\w-]{6,}$/;

/**
 * Reads an EWM web or REST link: the web UI (…/ccm/web/projects/<area>#action=com.ibm.team.scm.browseElement&workspaceItemId=_…
 * &componentItemId=_…&path=…), a stream/workspace/change set page (…#action=…&id=_…), or a file content URL
 * (…/IFilesystemContentService/<stream>/<component>/<path>). Any other Jazz link still gives the server. Null if not a URL.
 */
export function parseScmLink(input: unknown): ScmLink | null {
  const raw = String(input ?? "").trim();
  const base = /^(https?:\/\/[^/?#\s]+\/[^/?#\s]+)/i.exec(raw);
  if (!base) return null;
  const out: ScmLink = { repo: base[1]!.replace(/\/web$/i, "") };
  const content = /IFilesystemContentService\/(_[\w-]+)\/(_[\w-]+)\/?([^?#]*)/.exec(raw);
  if (content) {
    out.stream = content[1]; out.component = content[2];
    if (content[3]) out.path = decodeURIComponent(content[3]);
    return out;
  }
  const params = new Map<string, string>();
  for (const part of raw.split(/[?#&]/).slice(1)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    let v = part.slice(i + 1);
    try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch { /* keep as is */ }
    params.set(part.slice(0, i).toLowerCase(), v);
  }
  const action = params.get("action") ?? "";
  const id = params.get("id") ?? params.get("itemid");
  const pick = (...keys: string[]) => keys.map((k) => params.get(k.toLowerCase())).find((v) => v && ITEM_ID.test(v));
  const stream = pick("workspaceItemId", "streamItemId", "contextItemId", "workspaceId", "streamId") ?? (/stream|workspace/i.test(action) && id && ITEM_ID.test(id) ? id : undefined);
  const component = pick("componentItemId", "componentId");
  const changeset = pick("changeSetItemId", "changeSetId") ?? (/changeset/i.test(action) && id && ITEM_ID.test(id) ? id : undefined);
  const path = params.get("path") ?? params.get("filepath");
  const itemType = params.get("itemtype") ?? "";
  const folder = /\.Folder$/i.test(itemType) ? pick("itemId") : undefined;
  if (stream) out.stream = stream;
  if (component) out.component = component;
  if (path && path !== "/") out.path = path;
  if (changeset) out.changeset = changeset;
  if (folder) out.folder = folder;
  return out;
}

const isUrl = (v: unknown) => typeof v === "string" && /^https?:\/\//i.test(v.trim());

/**
 * Fills stream / workspace / component / path / changeset from a link the user gave (the `link` argument, or a URL pasted
 * into one of those fields). Values the caller gave explicitly win. `repo` is the server the link points at.
 */
export function scmTarget<T extends Record<string, any>>(a: T): T & { repo?: string } {
  const src = [a.link, a.stream, a.workspace, a.component, a.path, a.changeset].find(isUrl);
  const l = src ? parseScmLink(src) : null;
  if (!l) return a;
  const out: Record<string, any> = { ...a, repo: l.repo };
  for (const k of "stream workspace component path changeset folder".split(" ")) if (isUrl(out[k])) delete out[k];
  out.stream ??= l.stream;
  out.workspace ??= l.stream;
  out.component ??= l.component;
  out.path ??= l.path;
  out.changeset ??= l.changeset;
  out.folder ??= l.folder;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T & { repo?: string };
}
