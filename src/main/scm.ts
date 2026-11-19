/**
 * IBM Engineering Workflow Management source control, read-only: streams, components, folders and file contents.
 * Nothing here checks in, delivers or changes a stream.
 *  - streams / components : Reportable REST API  <ccm>/rpt/repository/scm?fields=scm/workspace[stream='true']/…
 *                           (fallback for components: <ccm>/service/com.ibm.team.scm.common.internal.rest.IScmRestService2/workspace?workspaceItemId=…)
 *  - file contents        : <ccm>/service/com.ibm.team.filesystem.service.internal.rest.IFilesystemContentService/<streamId>/<componentId>/<path>
 *  - folder listing       : EWM has no public REST call for it, so it uses the EWM SCM command line when installed
 *                           (`lscm`/`scm list remotefiles --json`), which signs in on its own.
 * HTTP goes through the shared Jazz client (same sign-in, cookies, proxy and certificates as work items).
 */
import type { JazzHttp } from "./etm";

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

  constructor(private http: JazzHttp, private cli: () => { run: CliRunner; repo: string } | null) {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const s = await this.streams({ max: 500 }, true);
      const cli = this.cli();
      return { ok: true, detail: `Connected · ${s.length} stream${s.length === 1 ? "" : "s"} visible · reading files works through REST · folder listings and changes (workspaces, check-in, accept, deliver) ${cli ? "use the EWM SCM command line" : "need the EWM SCM command line (scm/lscm), not found"}` };
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
    if (/^_[\w-]{10,}$/.test(r)) return { stream, component: { id: r, name: r } };
    const comps = await this.components(stream.id);
    const hit = comps.find((c) => c.name === r) ?? comps.find((c) => c.name.toLowerCase() === r.toLowerCase());
    if (!hit) throw new Error(`component “${ref}” is not in stream “${stream.name}” — it has: ${comps.map((c) => c.name).slice(0, 30).join(", ")}`);
    return { stream, component: hit };
  }

  /** File text (latest state in the stream). Lines can be windowed for big files. */
  async readFile(streamRef: string, compRef: string, path: string, o: { startLine?: number; lines?: number; maxChars?: number } = {}):
    Promise<{ path: string; stream: string; component: string; totalLines: number; startLine: number; text: string; truncated: boolean }> {
    const { stream, component } = await this.component(streamRef, compRef);
    const clean = normPath(path);
    const url = `${CONTENT}/${encodeURIComponent(stream.id)}/${encodeURIComponent(component.id)}/${clean.split("/").map(encodeURIComponent).join("/")}`;
    const r = await this.http.request("GET", url, undefined, { Accept: "*/*", "OSLC-Core-Version": "none" });
    if (r.status === 404) throw new Error(`file not found: ${clean} in ${component.name} (${stream.name})`);
    if (!r.ok) throw new Error(`EWM: HTTP ${r.status} reading ${clean}`);
    const body = await r.text();
    if (/^\s*<(!doctype html|html)/i.test(body) && /j_security_check|authrequired|login/i.test(body)) throw new Error("EWM returned a sign-in page — check the Jazz sign-in (Settings → Integrations → IBM Jazz)");
    if (body.includes("\u0000")) throw new Error(`${clean} is a binary file (${body.length} bytes); only text files can be read`);
    const all = body.split(/\r?\n/);
    const start = Math.max(1, Math.floor(o.startLine ?? 1));
    const count = Math.max(1, Math.min(Math.floor(o.lines ?? 400), 4000));
    let text = all.slice(start - 1, start - 1 + count).join("\n");
    const maxChars = o.maxChars ?? 60000;
    const truncated = start - 1 + count < all.length || text.length > maxChars;
    if (text.length > maxChars) text = text.slice(0, maxChars);
    return { path: clean, stream: stream.name, component: component.name, totalLines: all.length, startLine: start, text, truncated };
  }

  /** Whole file text, for downloads. */
  async fileText(streamRef: string, compRef: string, path: string): Promise<string> {
    const r = await this.readFile(streamRef, compRef, path, { startLine: 1, lines: 4000, maxChars: 20_000_000 });
    if (r.totalLines > 4000) {
      const rest = await this.readFile(streamRef, compRef, path, { startLine: 4001, lines: 4000, maxChars: 20_000_000 }).catch(() => null);
      if (r.totalLines > 8000 || !rest) throw new Error(`${r.path} has ${r.totalLines} lines — read it in windows with startLine/lines`);
      return `${r.text}\n${rest.text}`;
    }
    return r.text;
  }

  /** Folder contents through the EWM SCM command line (no public REST call exists for this). */
  async list(streamRef: string, compRef: string, path = "/", depth = 1): Promise<ScmEntry[]> {
    const cli = this.cli();
    if (!cli) throw new Error("Listing folders needs the EWM SCM command line (lscm or scm from the EWM client). Install it or set its path in Settings → Integrations → IBM Jazz → Source control. Reading a file by path works without it.");
    const { stream, component } = await this.component(streamRef, compRef);
    const d = Math.max(1, Math.min(Math.floor(depth), 20));
    const key = `${stream.id}|${component.id}|${normPath(path)}|${d}`;
    const hit = this.listCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.entries;
    const args = ["list", "remotefiles", "-r", cli.repo, "--json", "--depth", String(d), stream.name, component.name, ...(normPath(path) ? [`/${normPath(path)}`] : [])];
    const r = await cli.run(args);
    if (r.code !== 0) throw new Error(`scm list remotefiles failed (${r.code}): ${(r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400)}`);
    const entries = parseRemoteFiles(r.stdout);
    this.listCache.set(key, { at: Date.now(), entries });
    return entries;
  }

  /** Files whose path matches a glob (*.c, src/**\/can*.h) or contains the words. */
  async find(streamRef: string, compRef: string, pattern: string, path = "/", depth = 12): Promise<ScmEntry[]> {
    const all = await this.list(streamRef, compRef, path, depth);
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

/** Repository path without a leading slash; rejects parent references. */
export function normPath(p: string): string {
  const parts = String(p ?? "").replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (parts.includes("..")) throw new Error("paths may not contain ..");
  return parts.join("/");
}
