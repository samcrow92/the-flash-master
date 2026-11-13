/**
 * IBM Engineering Requirements Management DOORS Next — read access for analysis.
 *  - projects : OSLC RM service provider catalog  /rm/oslc_rm/catalog
 *  - modules  : Reportable REST API               /rm/publish/modules?projectURI=…
 *  - content  : Reportable REST API               /rm/publish/resources?moduleURI=… (ordered, with section/depth)
 * The Reportable REST API is read-only, needs no OSLC header and accepts oslc_config.context for configuration-managed
 * projects. Module contents are cached on disk and searched locally (BM25), so agents retrieve only the requirements
 * relevant to a question instead of loading whole modules into their context.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Requirement, RmHit, RmModule, RmModuleData, RmProject } from "@shared/types";

export interface RmFetcher { getText(path: string, accept: string, oslc?: boolean): Promise<string> }

// ------------------------------------------------------------------ XML helpers (tolerant, namespace-prefix agnostic)

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const htmlToText = (s: string) => decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "• ")
  .replace(/<[^>]+>/g, " ")).replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
/** First element <prefix:name> (any prefix) at the top level of `xml`. */
const el = (xml: string, name: string): string => {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`).exec(xml);
  return m?.[1] ?? "";
};
const attr = (tag: string, name: string): string => new RegExp(`(?:[\\w.-]+:)?${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
const strip = (xml: string, names: string[]) =>
  names.reduce((x, n) => x.replace(new RegExp(`<(?:[\\w.-]+:)?${n}(?:\\s[^>]*)?>[\\s\\S]*?</(?:[\\w.-]+:)?${n}>`, "g"), ""), xml);

/** Top-level <…:artifact> elements (handles nested artifacts by depth counting). */
export function splitArtifacts(xml: string): string[] {
  const out: string[] = [];
  const re = /<(\/?)(?:[\w.-]+:)?artifact\b[^>]*?(\/?)>/g;
  let depth = 0, start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const closing = m[1] === "/", selfClose = m[2] === "/";
    if (!closing && !selfClose) { if (depth === 0) start = m.index; depth++; }
    else if (closing) { depth--; if (depth === 0 && start >= 0) { out.push(xml.slice(start, m.index + m[0].length)); start = -1; } }
  }
  return out;
}

const uuidOf = (uri: string) => /\/(?:resources|modules)\/([^/?#]+)/.exec(uri)?.[1] ?? uri.split("/").pop() ?? uri;

export function parseArtifact(a: string): Requirement & { format: string } {
  const body = a.replace(/^<[^>]+>/, "").replace(/<\/[^>]+>$/, "");
  const links = [...body.matchAll(/<(?:[\w.-]+:)?Link\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Link>/g)].map((l) => ({
    type: decode(el(l[1]!, "title") || el(l[1]!, "linkType") || "link").trim(),
    target: decode(el(l[1]!, "about") || attr(l[0], "about") || "").trim(),
    title: decode(el(strip(l[1]!, ["title"]), "title")).trim() || undefined,
  })).filter((l) => l.target);
  const core = strip(body, ["traceability", "collaboration", "location", "revisions", "comments", "artifact"]);
  const content = el(core, "content");
  const ot = /<(?:[\w.-]+:)?objectType\b[^>]*>/.exec(core)?.[0] ?? "";
  const attrs: Record<string, string> = {};
  for (const m of core.matchAll(/<(?:[\w.-]+:)?(?:customAttribute|attribute)\b[^>]*\/?>/g)) {
    const name = attr(m[0], "name"), value = attr(m[0], "value") || attr(m[0], "literalName");
    if (name && value && Object.keys(attrs).length < 30) attrs[decode(name)] = decode(value).slice(0, 200);
  }
  const type = decode(attr(ot, "name")) || decode(el(core, "format")) || "Artifact";
  const title = htmlToText(el(core, "title"));
  const text = htmlToText(content) || title;
  const uri = decode(el(core, "about") || attr(a.slice(0, a.indexOf(">") + 1), "about")).trim();
  const isHeading = /heading/i.test(type) || /true/i.test(el(core, "isHeading"));
  return {
    id: decode(el(core, "identifier")).trim(), uri, title, text: text.slice(0, 8000), type, heading: isHeading,
    section: decode(el(core, "section")).trim(), depth: Number(el(core, "depth")) || 0, attrs, links: links.slice(0, 40),
    format: decode(el(core, "format")).trim(),
  };
}

export function parseProjects(rdf: string): RmProject[] {
  const out = new Map<string, RmProject>();
  for (const m of rdf.matchAll(/<(?:[\w.-]+:)?ServiceProvider\b[^>]*about="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ServiceProvider>/g)) {
    const id = /oslc_rm\/([^/]+)\/services/.exec(m[1]!)?.[1] ?? /project-areas\/([^/?]+)/.exec(m[2]!)?.[1];
    const title = htmlToText(el(m[2]!, "title"));
    if (id && title) out.set(id, { id, title });
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// ------------------------------------------------------------------ search

const STOP = new Set("a an and are as at be by can do for from has have if in into is it its not of on or shall should that the then this to was when which will with within without must may".split(" "));
const tokens = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}_.-]+/gu, " ").split(/\s+/)
  .map((t) => t.replace(/^[.-]+|[.-]+$/g, "")).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
/** Light English stemming so "debounced" / "debouncing" / "debounce" meet. */
function stem(t: string): string {
  if (t.length < 5 || /\d/.test(t)) return t;
  return t.replace(/(ational|ations?|ings?|ments?|ness|ies|ied|ed|es|e|s)$/, "") || t;
}

/** BM25 ranking over requirements; exact identifier matches go first. Headings are skipped unless asked for. */
export function rankRequirements(reqs: { req: Requirement; module: RmModule }[], query: string, o: { top?: number; type?: string; headings?: boolean } = {}): RmHit[] {
  const ids = new Set(query.split(/[\s,;]+/).filter((x) => /^\d+$/.test(x)));
  const q = tokens(query);
  const pool = reqs.filter(({ req }) => (o.headings || !req.heading) && (!o.type || req.type.toLowerCase().includes(o.type.toLowerCase())));
  const docs = pool.map(({ req }) => tokens(`${req.title} ${req.text} ${req.type} ${Object.values(req.attrs).join(" ")}`));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.4, b = 0.75, N = docs.length;
  const scored = pool.map((p, i) => {
    let score = ids.has(p.req.id) ? 1000 : 0;
    const d = docs[i]!;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of q) {
      const f = tf.get(t) ?? [...tf.keys()].filter((k) => k.length > 3 && t.length > 3 && (k.startsWith(t) || t.startsWith(k))).reduce((n, k) => n + tf.get(k)! * 0.6, 0);
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0.5) + 0.5) / ((df.get(t) ?? 0.5) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / avg));
    }
    return { p, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, o.top ?? 10);
  return scored.map(({ p, score }) => ({
    id: p.req.id, module: p.module.identifier || p.module.uuid, moduleTitle: p.module.title, section: p.req.section, type: p.req.type,
    text: p.req.text.length > 320 ? `${p.req.text.slice(0, 320)}…` : p.req.text, score: Math.round(score * 100) / 100,
  }));
}

// ------------------------------------------------------------------ service (API + cache)

export class Requirements {
  private modulesByProject = new Map<string, RmModule[]>();
  private mem = new Map<string, RmModuleData>();

  constructor(private api: () => RmFetcher | null, private cacheDir: string, private config: () => string) {
    mkdirSync(cacheDir, { recursive: true });
  }

  private need(): RmFetcher {
    const a = this.api();
    if (!a) throw new Error("IBM DOORS Next is not configured (Settings → Integrations → IBM Jazz → Requirements)");
    return a;
  }
  private cfgParam(): string {
    const c = this.config().trim();
    return c ? `&oslc_config.context=${encodeURIComponent(c)}` : "";
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try { const p = await this.projects(); return { ok: true, detail: `Connected — ${p.length} requirements project${p.length === 1 ? "" : "s"} visible` }; }
    catch (e: any) { return { ok: false, detail: String(e?.message ?? e) }; }
  }

  async projects(): Promise<RmProject[]> {
    return parseProjects(await this.need().getText("/oslc_rm/catalog", "application/rdf+xml", true));
  }

  async modules(projectId: string, refresh = false): Promise<RmModule[]> {
    if (!refresh && this.modulesByProject.has(projectId)) return this.modulesByProject.get(projectId)!;
    const xml = await this.need().getText(`/publish/modules?projectURI=${encodeURIComponent(projectId)}${this.cfgParam()}`, "application/xml");
    const mods = splitArtifacts(xml).map(parseArtifact).filter((a) => a.uri && (/module/i.test(a.format) || /module/i.test(a.type) || a.format === ""))
      .map((a) => ({ uri: a.uri, uuid: uuidOf(a.uri), identifier: a.id, title: a.title || a.text.slice(0, 80), projectId, modified: undefined }));
    const uniq = [...new Map(mods.map((m) => [m.uri, m])).values()].sort((a, b) => a.title.localeCompare(b.title));
    this.modulesByProject.set(projectId, uniq);
    return uniq;
  }

  /** Module content in document order, cached on disk (refresh = fetch again). */
  async module(ref: string, refresh = false, maxAgeH = 24): Promise<RmModuleData> {
    const known = this.findModule(ref);
    const cached = known ? this.cached(known.uuid) : this.cachedByRef(ref);
    if (!refresh && cached && Date.now() - cached.fetchedAt < maxAgeH * 3600000 && cached.config === this.config()) return cached;
    const mod = known ?? cached?.module;
    if (!mod) throw new Error(`Unknown module "${ref}" — list modules first (rm_modules) or use its URL`);
    const reqs = new Map<string, Requirement>();
    const size = 500;
    for (let pos = 0; pos < 20000; pos += size) {
      const xml = await this.need().getText(`/publish/resources?moduleURI=${encodeURIComponent(mod.uri)}${this.cfgParam()}&size=${size}&pos=${pos}`, "application/xml");
      const arts = splitArtifacts(xml).map(parseArtifact).filter((a) => a.uri && a.uri !== mod.uri && !/^module$/i.test(a.format));
      const before = reqs.size;
      for (const a of arts) { const { format: _f, ...r } = a; if (!reqs.has(r.uri)) reqs.set(r.uri, r); }
      if (arts.length < size || reqs.size === before) break;
    }
    const data: RmModuleData = { module: mod, fetchedAt: Date.now(), requirements: [...reqs.values()], config: this.config() };
    this.mem.set(mod.uuid, data);
    writeFileSync(join(this.cacheDir, `${mod.uuid.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify(data));
    return data;
  }

  /** Module refs: identifier, uuid, URL or (part of) the title. */
  findModule(ref: string): RmModule | undefined {
    const all = [...this.modulesByProject.values()].flat().concat(this.allCached().map((d) => d.module));
    const r = ref.trim().toLowerCase();
    return all.find((m) => m.uri === ref || m.uuid === ref || m.identifier === ref)
      ?? all.find((m) => m.title.toLowerCase() === r) ?? all.find((m) => m.title.toLowerCase().includes(r));
  }

  cached(uuid: string): RmModuleData | null {
    if (this.mem.has(uuid)) return this.mem.get(uuid)!;
    const f = join(this.cacheDir, `${uuid.replace(/[^\w.-]/g, "_")}.json`);
    if (!existsSync(f)) return null;
    try { const d = JSON.parse(readFileSync(f, "utf8")) as RmModuleData; this.mem.set(uuid, d); return d; } catch { return null; }
  }
  private cachedByRef(ref: string): RmModuleData | null {
    return this.allCached().find((d) => d.module.uri === ref || d.module.uuid === ref || d.module.identifier === ref || d.module.title.toLowerCase().includes(ref.toLowerCase())) ?? null;
  }
  allCached(): RmModuleData[] {
    for (const f of readdirSync(this.cacheDir).filter((x) => x.endsWith(".json"))) this.cached(f.replace(/\.json$/, ""));
    return [...this.mem.values()];
  }

  /** Ranked retrieval across the given modules (loaded on demand) or every cached module. */
  async search(query: string, o: { modules?: string[]; top?: number; type?: string; headings?: boolean } = {}): Promise<RmHit[]> {
    const datas = o.modules?.length ? await Promise.all(o.modules.map((m) => this.module(m))) : this.allCached();
    if (!datas.length) throw new Error("No requirements modules loaded yet — open a module first (rm_modules, then rm_search with module)");
    return rankRequirements(datas.flatMap((d) => d.requirements.map((req) => ({ req, module: d.module }))), query, o);
  }

  /** Full requirements by identifier (optionally within one module). */
  async get(ids: string[], moduleRef?: string): Promise<(Requirement & { module: string })[]> {
    const datas = moduleRef ? [await this.module(moduleRef)] : this.allCached();
    const want = new Set(ids.map(String));
    return datas.flatMap((d) => d.requirements.filter((r) => want.has(r.id)).map((r) => ({ ...r, module: d.module.title })));
  }

  /** Heading structure of a module: cheap orientation for agents. */
  async outline(moduleRef: string, maxDepth = 3): Promise<{ module: string; count: number; headings: { section: string; title: string; depth: number; reqs: number }[] }> {
    const d = await this.module(moduleRef);
    const out: { section: string; title: string; depth: number; reqs: number }[] = [];
    for (const r of d.requirements) {
      if (r.heading) { if (!r.depth || r.depth <= maxDepth) out.push({ section: r.section, title: r.title || r.text.slice(0, 80), depth: r.depth, reqs: 0 }); }
      else if (out.length) out[out.length - 1]!.reqs++;
    }
    return { module: d.module.title, count: d.requirements.filter((r) => !r.heading).length, headings: out.slice(0, 200) };
  }
}
