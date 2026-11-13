/**
 * IBM Engineering Requirements Management DOORS Next — read access for analysis.
 *  - projects : OSLC RM service provider catalog  /rm/oslc_rm/catalog
 *  - modules  : Reportable REST API               /rm/publish/modules?projectURI=…
 *  - content  : Reportable REST API               /rm/publish/resources?moduleURI=… (ordered, with section/depth)
 * The Reportable REST API is read-only, needs no OSLC header and accepts oslc_config.context for configuration-managed
 * projects. Module contents are cached on disk and searched locally (BM25), so agents retrieve only the requirements
 * relevant to a question instead of loading whole modules into their context.
 */
import { configUri } from "@shared/rm-config";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

/** Cache key per module and configuration (the same module differs between streams). */
const cacheKey = (m: { uuid: string; config?: string }) => `${m.uuid}${m.config ? `@${createHash("sha1").update(m.config).digest("hex").slice(0, 10)}` : ""}`.replace(/[^\w.@-]/g, "_");
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

/**
 * Accepts the server root or any DOORS Next link copied from the browser, e.g.
 *   https://alm.example.com/rm1/web#action=…&componentURI=https%3A%2F%2F…%2Frm1%2Fcm%2Fcomponent%2F_abc&oslc_config.context=…
 * and returns the context root plus the scope found in the link.
 */
export function parseRmLink(input: string): { base: string; componentUri: string; projectId: string; config: string } {
  const raw = input.trim();
  if (!raw) return { base: "", componentUri: "", projectId: "", config: "" };
  let u: URL;
  try { u = new URL(raw); } catch { return { base: raw.replace(/[#?].*$/, "").replace(/\/+$/, ""), componentUri: "", projectId: "", config: "" }; }
  const params = new URLSearchParams([u.search.slice(1), u.hash.replace(/^#/, "")].filter(Boolean).join("&"));
  const get = (...k: string[]) => { for (const x of k) { const v = params.get(x); if (v) return v; } return ""; };
  const root = u.pathname.split("/").filter(Boolean)[0] ?? "";
  const componentUri = get("componentURI", "componentUri");
  const project = get("projectURI", "projectUri", "projectAreaURI");
  return {
    base: `${u.origin}${root ? `/${root}` : ""}`,
    componentUri,
    projectId: /(_[\w-]+)\/?$/.exec(project)?.[1] ?? project,
    config: configUri(raw) !== raw ? configUri(raw) : get("oslc_config.context", "vvc.configuration", "configURI"),
  };
}

/** Jazz process API fallback: <jp:project-area jp:name="…" jp:url="…/process/project-areas/_id"> */
export function parseProjectAreas(xml: string): RmProject[] {
  const out = new Map<string, RmProject>();
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?project-area\b([^>]*)>/g)) {
    const name = /(?:[\w.-]+:)?name="([^"]+)"/.exec(m[1]!)?.[1];
    const id = /project-areas\/(_[^"/]+)/.exec(m[1]!)?.[1] ?? /(?:[\w.-]+:)?itemId="(_[^"]+)"/.exec(m[1]!)?.[1];
    if (name && id) out.set(id, { id, title: decode(name) });
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** Component (OSLC config) → project area, title and its configurations container. */
export function parseComponent(rdf: string): { title: string; projectId: string; configurations: string } {
  return {
    title: htmlToText(el(rdf, "title")),
    projectId: /project-areas\/(_[^"/<]+)/.exec(rdf)?.[1] ?? /oslc_rm\/(_[^/"]+)\/services/.exec(rdf)?.[1] ?? "",
    configurations: /<(?:[\w.-]+:)?configurations\b[^>]*resource="([^"]+)"/.exec(rdf)?.[1] ?? "",
  };
}
/** First stream in a configurations container (members or ldp:contains). */
export function pickStream(rdf: string): string {
  const all = [...rdf.matchAll(/resource="([^"]+\/cm\/stream\/[^"]+)"/g)].map((m) => m[1]!);
  return all[0] ?? "";
}

// ------------------------------------------------------------------ OSLC RM (fallback when the Reportable REST API is missing)

const RDF_PREFIXES = "dcterms=<http://purl.org/dc/terms/>,oslc_rm=<http://open-services.net/ns/rm#>,rdf=<http://www.w3.org/1999/02/22-rdf-syntax-ns#>,jazz_rm=<http://jazz.net/ns/rm#>";
/** Resources described in an OSLC query result / RDF document: about + title + identifier. */
export function parseOslcResources(rdf: string): { uri: string; title: string; identifier: string }[] {
  const out = new Map<string, { uri: string; title: string; identifier: string }>();
  for (const m of rdf.matchAll(/<([\w.-]+:[\w.-]+)\b[^>]*?about="([^"]+)"[^>]*?(\/?)>/g)) {
    const end = m[3] ? -1 : rdf.indexOf(`</${m[1]}>`, m.index! + m[0].length);
    m[3] = end < 0 ? "" : rdf.slice(m.index! + m[0].length, end); // element body (nested resources are matched on their own)
    const uri = decode(m[2]!);
    if (!/\/resources\//.test(uri)) continue;
    const body = m[3] ?? "";
    const prev = out.get(uri);
    const title = htmlToText(el(body, "title")) || prev?.title || "";
    const identifier = decode(el(body, "identifier")).trim() || prev?.identifier || "";
    out.set(uri, { uri, title, identifier });
  }
  return [...out.values()];
}
export const nextPage = (rdf: string) => decode(/<(?:[\w.-]+:)?nextPage\b[^>]*resource="([^"]+)"/.exec(rdf)?.[1] ?? "");
export const usesOf = (rdf: string) => [...new Set([...rdf.matchAll(/<(?:[\w.-]+:)?uses\b[^>]*resource="([^"]+)"/g)].map((m) => decode(m[1]!)))];
/** One artifact fetched with OSLC (GET artifact, RDF/XML). */
export function parseOslcArtifact(rdf: string, uri: string): Omit<Requirement, "type" | "heading"> & { shape: string } {
  const primary = el(rdf, "primaryText");
  const title = htmlToText(el(rdf, "title"));
  return {
    id: decode(el(rdf, "identifier")).trim(), uri, title, text: (htmlToText(primary) || htmlToText(el(rdf, "description")) || title).slice(0, 8000),
    section: "", depth: 0, attrs: {}, links: [],
    shape: decode(/<(?:[\w.-]+:)?instanceShape\b[^>]*resource="([^"]+)"/.exec(rdf)?.[1] ?? ""),
  };
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}
const missingApi = (e: unknown) => /HTTP (400|404|405|406|500|501)/.test(String((e as Error)?.message ?? e));

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

  private scope: { key: string; title: string; projectId: string; stream: string } | null = null;
  private noReportable = false;
  /** What the last module listing tried (shown in the UI when nothing is found). */
  lastLog: string[] = [];
  private shapes = new Map<string, Promise<string>>();

  /** OSLC Query for modules of a project (configuration-aware). */
  private async oslcModules(projectId: string, log: string[] = [], cfg = this.config()): Promise<{ uri: string; title: string; identifier: string }[]> {
    const api = this.need();
    const base = await this.queryBase(projectId, cfg, log);
    log.push(`oslc query capability: ${base.slice(0, 160)}`);
    const q = (where: string) => `${base}${base.includes("?") ? "&" : "?"}oslc.prefix=${encodeURIComponent(RDF_PREFIXES)}`
      + `&oslc.select=${encodeURIComponent("dcterms:title,dcterms:identifier")}&oslc.where=${encodeURIComponent(where)}&oslc.pageSize=200${this.cfgParam(cfg)}`;
    for (const where of ["rdf:type=jazz_rm:Module", "rdf:type=<http://jazz.net/ns/rm#Module>", "rdf:type=oslc_rm:RequirementCollection"]) {
      try {
        const all: { uri: string; title: string; identifier: string }[] = [];
        let url: string = q(where);
        for (let page = 0; url && page < 25; page++) {
          const rdf = await api.getText(url, "application/rdf+xml", true);
          all.push(...parseOslcResources(rdf));
          url = nextPage(rdf);
        }
        log.push(`oslc where ${where}: ${all.length} modules`);
        if (all.length) return [...new Map(all.map((x) => [x.uri, x])).values()];
      } catch (e) { log.push(`oslc where ${where}: ${String((e as Error)?.message ?? e).slice(0, 320)}`); if (!missingApi(e)) throw e; }
    }
    return [];
  }
  /** Components of a project area (/cm/component/ldpc?project=…) with the default stream of each. */
  private async projectStreams(projectId: string, log: string[]): Promise<{ config: string; component: string }[]> {
    const api = this.need();
    const svc = await api.getText(`/oslc_rm/${projectId}/services.xml`, "application/rdf+xml", true).catch(() => "");
    const root = /^(https?:\/\/[^"]+?)\/oslc_rm\//.exec(svc)?.[1] ?? /about="(https?:\/\/[^"]+?)\/oslc_rm\//.exec(svc)?.[1] ?? "";
    const paUrl = `${root}/process/project-areas/${projectId}`;
    const rdf = await api.getText(`/cm/component/ldpc?project=${encodeURIComponent(paUrl)}`, "application/rdf+xml", true);
    const comps = [...new Set([...rdf.matchAll(/resource="([^"]+\/cm\/component\/_[^"/]+)"/g), ...rdf.matchAll(/about="([^"]+\/cm\/component\/_[^"/]+)"/g)].map((m) => decode(m[1]!)))];
    log.push(`component discovery: ${comps.length} component(s) in the project`);
    const out: { config: string; component: string }[] = [];
    for (const c of comps.slice(0, 12)) {
      const info = parseComponent(await api.getText(c, "application/rdf+xml", true).catch(() => ""));
      const stream = info.configurations ? pickStream(await api.getText(info.configurations, "application/rdf+xml", true).catch(() => "")) : "";
      log.push(`  component “${info.title || c}”: ${stream ? `stream ${stream}` : "no stream found"}`);
      if (stream) out.push({ config: stream, component: info.title || c });
    }
    return out;
  }

  /** Query capability of a project (from its services document, else the well-known DOORS Next /views URL). */
  private async queryBase(projectId: string, config = this.config(), log: string[] = []): Promise<string> {
    const api = this.need();
    const cfg = config ? `?oslc_config.context=${encodeURIComponent(config)}` : "";
    const svc = await api.getText(`/oslc_rm/${projectId}/services.xml${cfg}`, "application/rdf+xml", true)
      .catch((e) => { log.push(`services document: ${String((e as Error)?.message ?? e).slice(0, 240)}`); return ""; });
    const qb = /<(?:[\w.-]+:)?queryBase\b[^>]*resource="([^"]+)"/.exec(svc)?.[1];
    if (qb) return decode(qb);
    // DOORS Next wants an absolute project URL in projectURL.
    const root = (/^(https?:\/\/[^"]+?)\/oslc_rm\//.exec(svc)?.[1]) ?? this.serverRoot().replace(/\/+$/, "");
    return `${root}/views?oslc.query=true&projectURL=${encodeURIComponent(`${root}/process/project-areas/${projectId}`)}`;
  }
  /** Module contents via OSLC: the module's oslc_rm:uses list, then each artifact (unordered: sorted by id). */
  private async oslcModuleContent(mod: RmModule, config = this.config()): Promise<Requirement[]> {
    const api = this.need();
    const cfg = config ? `${mod.uri.includes("?") ? "&" : "?"}oslc_config.context=${encodeURIComponent(config)}` : "";
    const uses = usesOf(await api.getText(mod.uri + cfg, "application/rdf+xml", true)).slice(0, 3000);
    const reqs = await mapLimit(uses, 6, async (u) => {
      const rdf = await api.getText(u + (config ? `${u.includes("?") ? "&" : "?"}oslc_config.context=${encodeURIComponent(config)}` : ""), "application/rdf+xml", true).catch(() => "");
      if (!rdf) return null;
      const a = parseOslcArtifact(rdf, u);
      if (a.shape && !this.shapes.has(a.shape)) {
        this.shapes.set(a.shape, api.getText(a.shape, "application/rdf+xml", true).then((x) => htmlToText(el(x, "title")) || "Requirement", () => "Requirement"));
      }
      const type = a.shape ? await this.shapes.get(a.shape)! : "Requirement";
      const { shape: _s, ...r } = a;
      return { ...r, type: type || "Requirement", heading: /heading/i.test(type ?? "") } as Requirement;
    });
    return reqs.filter((r): r is Requirement => !!r).sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
  }

  constructor(private api: () => RmFetcher | null, private cacheDir: string, private userConfig: () => string,
    private component: () => string = () => "", private serverRoot: () => string = () => "") {
    mkdirSync(cacheDir, { recursive: true });
  }

  /** Configuration used for reads: the one set by the user, else the default stream of the configured component. */
  private config(): string {
    return configUri(this.userConfig()) || (this.scope?.key === this.component() ? this.scope.stream : "");
  }

  /** Resolve the component from the link (title, project area, default stream) once. */
  async resolveComponent(): Promise<{ title: string; projectId: string; stream: string } | null> {
    const c = this.component().trim();
    if (!c) return null;
    if (this.scope?.key === c) return this.scope;
    const api = this.need();
    const info = parseComponent(await api.getText(c, "application/rdf+xml", true));
    let stream = "";
    if (info.configurations) stream = pickStream(await api.getText(info.configurations, "application/rdf+xml", true).catch(() => ""));
    this.scope = { key: c, title: info.title, projectId: info.projectId, stream };
    return this.scope;
  }

  private need(): RmFetcher {
    const a = this.api();
    if (!a) throw new Error("IBM DOORS Next is not configured (Settings → Integrations → IBM Jazz → Requirements)");
    return a;
  }
  private cfgParam(config = this.config()): string {
    const c = config.trim();
    return c ? `&oslc_config.context=${encodeURIComponent(c)}` : "";
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const comp = await this.resolveComponent().catch((e) => { throw new Error(`Component link not readable: ${String(e?.message ?? e)}`); });
      const p = await this.projects();
      if (!p.length) return { ok: false, detail: "Reached the server but found no requirements projects — check that the URL is the DOORS Next root (e.g. https://alm.company.com/rm) and that you have access." };
      return { ok: true, detail: `Connected — ${p.length} requirements project${p.length === 1 ? "" : "s"} visible${comp ? ` · component “${comp.title || "?"}”${comp.stream ? " (default stream)" : " — no stream found, set Configuration"}` : ""}` };
    } catch (e: any) { return { ok: false, detail: String(e?.message ?? e) }; }
  }

  async projects(): Promise<RmProject[]> {
    const api = this.need();
    const body = await api.getText("/oslc_rm/catalog", "application/rdf+xml", true);
    if (/<html[\s>]/i.test(body) && !/ServiceProvider/i.test(body)) throw new Error("The requirements URL returned a web page, not the API — use the DOORS Next root, e.g. https://alm.company.com/rm (any DOORS Next link also works; it is shortened automatically)");
    let list = parseProjects(body);
    if (!list.length) list = parseProjectAreas(await api.getText("/process/project-areas", "application/xml").catch(() => ""));
    const comp = await this.resolveComponent().catch(() => null);
    if (comp?.projectId) {
      const own = list.find((p) => p.id === comp.projectId);
      // Scoped by a component link: show that project first (and only it, if the catalog did not list it).
      list = own ? [own, ...list.filter((p) => p !== own)] : [{ id: comp.projectId, title: comp.title || comp.projectId }, ...list];
    }
    return list;
  }

  async modules(projectId: string, refresh = false): Promise<RmModule[]> {
    if (!refresh && this.modulesByProject.has(projectId)) return this.modulesByProject.get(projectId)!;
    const log: string[] = [];
    this.lastLog = log;
    const comp = await this.resolveComponent().catch((e) => { log.push(`component: could not read (${String(e?.message ?? e).slice(0, 160)})`); return null; });
    if (comp) log.push(`component: “${comp.title || "?"}” project=${comp.projectId || "?"} stream=${comp.stream || "none found"}`);
    // Which configurations to read: the user's, else the linked component's stream (same project), else every
    // component of the project with its default stream (DOORS Next query capabilities are component-specific).
    // Global configurations (…/gc/configuration/…) span all contributing components; local streams one component.
    const user = configUri(this.userConfig());
    const isGc = (c: string) => /\/gc\/configuration\//i.test(c);
    const discover = async () => (await this.projectStreams(projectId, log).catch((e) => { log.push(`component discovery: ${String(e?.message ?? e).slice(0, 160)}`); return []; }));
    const scopes: { config: string; component?: string }[] = [];
    if (user) scopes.push({ config: user, component: isGc(user) ? "Global configuration" : undefined });
    if (!user || isGc(user)) scopes.push({ config: "__discover__" });
    const mods: RmModule[] = [];
    const queue = [...scopes];
    for (let n = 0; queue.length && n < 16; n++) {
      const sc = queue.shift()!;
      if (sc.config === "__discover__") {
        // Local component streams: only needed when a global configuration did not cover this project
        if (mods.length && user) continue;
        let found = await discover();
        if (!found.length && comp?.stream && (!comp.projectId || comp.projectId === projectId)) found = [{ config: comp.stream, component: comp.title }];
        queue.push(...(found.length ? found : user ? [] : [{ config: "" }]));
        continue;
      }
      log.push(`— configuration: ${sc.config || "(none — default)"}${sc.component ? ` (component “${sc.component}”)` : ""}`);
      const toMods = (rs: { uri: string; title: string; identifier: string }[]): RmModule[] =>
        rs.map((r) => ({ uri: r.uri, uuid: uuidOf(r.uri), identifier: r.identifier, title: r.title || r.identifier || uuidOf(r.uri), projectId, config: sc.config || undefined, component: sc.component }));
      let found: RmModule[] = [];
      // 1) Reportable REST API
      if (!this.noReportable) {
        const path = `/publish/modules?projectURI=${encodeURIComponent(projectId)}${this.cfgParam(sc.config)}`;
        try {
          const xml = await this.need().getText(path, "application/xml");
          const arts = splitArtifacts(xml).map(parseArtifact);
          found = toMods(arts.filter((a) => a.uri && (/module/i.test(a.format) || /module/i.test(a.type) || a.format === ""))
            .map((a) => ({ uri: a.uri, identifier: a.id, title: a.title || a.text.slice(0, 80) })));
          log.push(`  reportable /publish/modules: ${xml.length} bytes, ${arts.length} artifacts, ${found.length} modules`);
          if (!arts.length && xml.length < 400) log.push(`    response: ${xml.replace(/\s+/g, " ").slice(0, 300)}`);
        } catch (e) {
          log.push(`  reportable /publish/modules: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          if (!missingApi(e)) throw e;
          this.noReportable = true;
        }
      }
      // 2) OSLC Query (also when the Reportable API answered with an empty list)
      if (!found.length) {
        try { found = toMods(await this.oslcModules(projectId, log, sc.config)); }
        catch (e) { log.push(`  oslc query: ${String((e as Error)?.message ?? e).slice(0, 200)}`); }
      }
      mods.push(...found);
    }
    log.push(`result: ${mods.length} modules`);
    const uniq = [...new Map(mods.map((m) => [`${m.uri}|${m.config ?? ""}`, m])).values()].sort((a, b) => a.title.localeCompare(b.title));
    this.modulesByProject.set(projectId, uniq);
    return uniq;
  }

  /** Module content in document order, cached on disk (refresh = fetch again). */
  async module(ref: string, refresh = false, maxAgeH = 24, config?: string): Promise<RmModuleData> {
    await this.resolveComponent().catch(() => null);
    const known = this.findModule(ref, config);
    const cached = known ? this.cached(cacheKey(known)) : this.cachedByRef(ref);
    const modCfg = known?.config ?? cached?.module.config ?? this.config();
    if (!refresh && cached && Date.now() - cached.fetchedAt < maxAgeH * 3600000 && cached.config === modCfg) return cached;
    const mod = known ?? cached?.module;
    if (!mod) throw new Error(`Unknown module "${ref}" — list modules first (rm_modules) or use its URL`);
    const reqs = new Map<string, Requirement>();
    const size = 500;
    try {
      if (this.noReportable) throw new Error("HTTP 404 (cached)");
      for (let pos = 0; pos < 20000; pos += size) {
        const xml = await this.need().getText(`/publish/resources?moduleURI=${encodeURIComponent(mod.uri)}${this.cfgParam(modCfg)}&size=${size}&pos=${pos}`, "application/xml");
        const arts = splitArtifacts(xml).map(parseArtifact).filter((a) => a.uri && a.uri !== mod.uri && !/^module$/i.test(a.format));
        const before = reqs.size;
        for (const a of arts) { const { format: _f, ...r } = a; if (!reqs.has(r.uri)) reqs.set(r.uri, r); }
        if (arts.length < size || reqs.size === before) break;
      }
    } catch (e) {
      if (!missingApi(e)) throw e;
      this.noReportable = true;
      for (const r of await this.oslcModuleContent(mod, modCfg)) reqs.set(r.uri, r);
    }
    const data: RmModuleData = { module: mod, fetchedAt: Date.now(), requirements: [...reqs.values()], config: modCfg };
    this.mem.set(cacheKey(mod), data);
    writeFileSync(join(this.cacheDir, `${cacheKey(mod)}.json`), JSON.stringify(data));
    return data;
  }

  /** Module refs: identifier, uuid, URL or (part of) the title. */
  findModule(ref: string, config?: string): RmModule | undefined {
    const all = [...this.modulesByProject.values()].flat().concat(this.allCached().map((d) => d.module))
      .filter((m) => config === undefined || (m.config ?? "") === config);
    const r = ref.trim().toLowerCase();
    return all.find((m) => m.uri === ref || m.uuid === ref || m.identifier === ref)
      ?? all.find((m) => m.title.toLowerCase() === r) ?? all.find((m) => m.title.toLowerCase().includes(r));
  }

  cached(uuid: string): RmModuleData | null {
    if (this.mem.has(uuid)) return this.mem.get(uuid)!;
    const f = join(this.cacheDir, `${uuid.replace(/[^\w.@-]/g, "_")}.json`);
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
