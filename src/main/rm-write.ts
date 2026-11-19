/**
 * IBM DOORS Next — create, edit and delete requirements inside a changeset (OSLC RM 2.0 + OSLC configuration management).
 *  - changeset : …/rm/cm/changeset/_id. Every request carries it as the Configuration-Context header (vvc.configuration for
 *                older servers), so nothing reaches a stream until the user delivers the changeset in DOORS Next.
 *                Streams, baselines and global configurations are refused: writes never happen without a changeset.
 *  - project   : changeset → oslc_config:component → project area; its services document gives the requirement creation
 *                factory, the query capability (find a requirement by its id) and the artifact types (resource shapes).
 *  - create    : POST RDF/XML to the creation factory (instanceShape = the artifact type), 201 + Location.
 *  - edit      : GET the artifact's RDF (ETag), change only the properties asked for, PUT it back with If-Match, so every
 *                attribute and link the tool does not know about is kept as the server sent it.
 *  - delete    : the caller must repeat the requirement's id as `confirm`; modules and collections are refused.
 * The HTTP layer (sign-in, cookies, proxy, certificates) is the shared Jazz client on the /rm context root.
 */
import { configUri } from "@shared/rm-config";
import { children, esc, type JazzHttp } from "./etm";
import { serverMessage } from "./jazz";
import { parseComponent, parseOslcResources } from "./requirements";

export const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  dcterms: "http://purl.org/dc/terms/",
  oslc: "http://open-services.net/ns/core#",
  oslc_rm: "http://open-services.net/ns/rm#",
  oslc_config: "http://open-services.net/ns/config#",
  jazz_rm: "http://jazz.net/ns/rm#",
  nav: "http://com.ibm.rdm/navigation#",
  xhtml: "http://www.w3.org/1999/xhtml",
};
/** OSLC RM link properties agents may add or remove by short name (any absolute predicate URI works too). */
export const RM_LINK_TYPES = ["satisfies", "satisfiedBy", "elaborates", "elaboratedBy", "specifies", "specifiedBy", "decomposes", "decomposedBy",
  "constrains", "constrainedBy", "affectedBy", "trackedBy", "implementedBy", "validatedBy"] as const;

export interface RmLinkChange { type: string; target: string }
export interface RmWrite {
  title?: string;
  /** Requirement text (plain text; blank lines start a new paragraph). Stored as the artifact's primary text (XHTML). */
  text?: string;
  description?: string;
  /** Attributes by their name as shown in DOORS Next (e.g. {"Priority": "High"}); enumerations by their label. */
  attributes?: Record<string, string>;
  addLinks?: RmLinkChange[];
  removeLinks?: RmLinkChange[];
}
export interface RmArtifact { id: string; url: string; type: string; title: string; text: string; attributes: Record<string, string>; links: { type: string; target: string }[] }
export interface RmShape { url: string; title: string; props: RmShapeProp[]; labels: Map<string, string> }
export interface RmShapeProp { title: string; name: string; predicate: string; allowed: string[]; resource: boolean }
export interface RmChangesetInfo { changeset: string; title: string; component: string; componentTitle: string; projectId: string; factory: string; queryBase: string; shapes: RmShape[] }

// ------------------------------------------------------------------ changeset

const CHANGESET_RE = /\/cm\/changeset\/[^/?#\s]+$/i;

/** The changeset URI from whatever was pasted (URL, DOORS Next link with oslc_config.context, encoded). Throws otherwise. */
export function changesetUri(input: unknown): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("a changeset is required: pass the DOORS Next changeset URL (…/rm/cm/changeset/_…) or a DOORS Next link opened in that changeset. Writes are never made directly in a stream.");
  const uri = configUri(raw);
  if (CHANGESET_RE.test(uri)) return uri;
  const what = /\/cm\/stream\//i.test(uri) ? "a stream" : /\/cm\/baseline\//i.test(uri) ? "a baseline" : /\/gc\/configuration\//i.test(uri) ? "a global configuration" : "not a changeset";
  throw new Error(`refused: "${raw.slice(0, 160)}" is ${what}. Create or open a changeset in DOORS Next and pass its URL (…/rm/cm/changeset/_…); writes are only made inside a changeset.`);
}

// ------------------------------------------------------------------ RDF/XML helpers (namespace aware, keep everything else)

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const htmlText = (s: string) => decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " "))
  .replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const attrOf = (open: string, name: string) => {
  const v = new RegExp(`\\s(?:[\\w.-]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(open)?.[1] ?? new RegExp(`\\s(?:[\\w.-]+:)?${name}\\s*=\\s*'([^']*)'`).exec(open)?.[1];
  return v === undefined ? undefined : decode(v);
};
/** Every xmlns:prefix declaration in the document (first one wins). */
export function namespaces(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/\sxmlns:([\w.-]+)\s*=\s*["']([^"']*)["']/g)) if (!out.has(m[1]!)) out.set(m[1]!, decode(m[2]!));
  return out;
}
/** Split a predicate URI into namespace + local name. */
export function splitUri(uri: string): { ns: string; local: string } {
  const i = Math.max(uri.lastIndexOf("#"), uri.lastIndexOf("/"));
  return { ns: uri.slice(0, i + 1), local: uri.slice(i + 1) };
}

interface Located { open: string; inner: string; start: number; innerStart: number; end: number; name: string; prefix: string }

/** The description of `uri` inside an RDF/XML document (rdf:about match), else the first described resource. */
export function locate(xml: string, uri?: string): Located {
  const root = children(xml).find((c) => c.name === "RDF") ?? null;
  const offset = root ? root.start + root.open.length : 0;
  const scope = root ? root.inner : xml;
  const kids = children(scope).filter((c) => attrOf(c.open, "about") !== undefined);
  const hit = (uri ? kids.find((c) => sameUri(attrOf(c.open, "about")!, uri)) : undefined) ?? kids.find((c) => !c.open.endsWith("/>")) ?? kids[0];
  if (!hit) throw new Error("DOORS Next returned no artifact description (RDF/XML)");
  const start = offset + hit.start;
  return { open: hit.open, inner: hit.inner, start, innerStart: start + hit.open.length, end: offset + hit.end, name: hit.name, prefix: hit.prefix };
}
const sameUri = (a: string, b: string) => a.replace(/[?#].*$/, "").replace(/\/+$/, "") === b.replace(/[?#].*$/, "").replace(/\/+$/, "");

/** Child elements of a resource description that are the property {ns, local}. */
function propsOf(inner: string, nsMap: Map<string, string>, ns: string, local: string) {
  return children(inner).filter((c) => c.name === local
    && (attrOf(c.open, c.prefix ? `xmlns:${c.prefix}` : "xmlns") ?? (c.prefix ? nsMap.get(c.prefix) : undefined)) === ns);
}
/** Values of a property: literal text or rdf:resource. */
export function propValues(xml: string, uri: string | undefined, ns: string, local: string): string[] {
  const r = locate(xml, uri);
  return propsOf(r.inner, namespaces(xml), ns, local).map((c) => attrOf(c.open, "resource") ?? htmlText(c.inner));
}

/** Element text for a property, using an existing prefix for the namespace or a local xmlns declaration. */
function propElement(nsMap: Map<string, string>, ns: string, local: string, body: { literal?: string; xml?: string; resource?: string }): string {
  const prefix = [...nsMap].find(([, v]) => v === ns)?.[0];
  const rdf = [...nsMap].find(([, v]) => v === NS.rdf)?.[0] ?? "rdf";
  const tag = prefix ? `${prefix}:${local}` : `fm:${local}`;
  const decl = prefix ? "" : ` xmlns:fm="${esc(ns)}"`;
  if (body.resource !== undefined) return `<${tag}${decl} ${rdf}:resource="${esc(body.resource)}"/>`;
  if (body.xml !== undefined) return `<${tag}${decl} ${rdf}:parseType="Literal">${body.xml}</${tag}>`;
  return `<${tag}${decl}>${esc(body.literal ?? "")}</${tag}>`;
}

/** Edits the description of `uri`: set (replace all values of) or add/remove properties. Everything else is kept byte for byte. */
export class RdfDoc {
  constructor(public xml: string, private uri?: string) {}
  private get ns() { return namespaces(this.xml); }
  private splice(fn: (inner: string) => string) {
    const r = locate(this.xml, this.uri);
    if (r.open.endsWith("/>")) {
      const open = r.open.replace(/\s*\/>$/, ">");
      const close = `</${r.prefix ? `${r.prefix}:` : ""}${r.name}>`;
      this.xml = this.xml.slice(0, r.start) + open + fn("") + close + this.xml.slice(r.end);
      return;
    }
    this.xml = this.xml.slice(0, r.innerStart) + fn(r.inner) + this.xml.slice(r.innerStart + r.inner.length);
  }
  values(ns: string, local: string): string[] { return propValues(this.xml, this.uri, ns, local); }
  set(ns: string, local: string, body: { literal?: string; xml?: string; resource?: string }) {
    const nsMap = this.ns;
    this.splice((inner) => {
      const old = propsOf(inner, nsMap, ns, local);
      const el = propElement(nsMap, ns, local, body);
      if (!old.length) return `${inner.replace(/\s*$/, "")}\n    ${el}\n  `;
      let out = inner;
      for (const c of [...old].reverse()) out = out.slice(0, c.start) + (c === old[0] ? el : "") + out.slice(c.end);
      return out;
    });
  }
  add(ns: string, local: string, resource: string) {
    if (this.values(ns, local).some((v) => sameUri(v, resource))) return;
    const nsMap = this.ns;
    this.splice((inner) => `${inner.replace(/\s*$/, "")}\n    ${propElement(nsMap, ns, local, { resource })}\n  `);
  }
  remove(ns: string, local: string, resource: string): boolean {
    const nsMap = this.ns;
    let removed = false;
    this.splice((inner) => {
      let out = inner;
      for (const c of propsOf(inner, nsMap, ns, local).reverse()) {
        if (sameUri(attrOf(c.open, "resource") ?? "", resource)) { out = out.slice(0, c.start) + out.slice(c.end); removed = true; }
      }
      return out;
    });
    return removed;
  }
}

/** Plain text → the XHTML DOORS Next keeps as primary text. */
export function textToXhtml(text: string): string {
  const paras = String(text).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return `<div xmlns="${NS.xhtml}">${(paras.length ? paras : [""]).map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`).join("")}</div>`;
}

// ------------------------------------------------------------------ services document and shapes

/** Requirement creation factory + query capability from an OSLC RM services document. */
export function parseServices(rdf: string): { factory: string; shapes: string[]; queryBase: string } {
  const blocks = (name: string) => [...rdf.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "g"))].map((m) => m[1]!);
  const res = (body: string, name: string) => [...body.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*resource="([^"]+)"`, "g"))].map((m) => decode(m[1]!));
  const isReq = (b: string) => res(b, "resourceType").some((t) => /rm#Requirement$/.test(t));
  const factories = blocks("CreationFactory");
  const f = factories.find(isReq) ?? factories.find((b) => !res(b, "resourceType").some((t) => /Collection/.test(t))) ?? "";
  const queries = blocks("QueryCapability");
  const q = queries.find(isReq) ?? queries[0] ?? "";
  return { factory: res(f, "creation")[0] ?? "", shapes: [...new Set(res(f, "resourceShape"))], queryBase: res(q, "queryBase")[0] ?? "" };
}

/** An artifact type (resource shape): its title, attributes (properties) and the labels of enumeration values. */
export function parseShape(rdf: string, url: string): RmShape {
  const labels = new Map<string, string>();
  // Every described resource (enumeration values may be nested in the shape or listed beside it): its own first label.
  for (const m of rdf.matchAll(/<([\w.-]+:[\w.-]+)\b[^>]*?about="([^"]+)"[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    const from = m.index! + m[0].length;
    const end = rdf.indexOf(`</${m[1]}>`, from);
    const body = rdf.slice(from, end < 0 ? undefined : end);
    const label = htmlText(/<(?:[\w.-]+:)?(?:label|title)\b[^>]*>([\s\S]*?)<\//.exec(body)?.[1] ?? "");
    if (label && !labels.has(decode(m[2]!))) labels.set(decode(m[2]!), label);
  }
  const props: RmShapeProp[] = [];
  for (const m of rdf.matchAll(/<(?:[\w.-]+:)?Property\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Property>/g)) {
    const b = m[1]!;
    const lit = (n: string) => htmlText(new RegExp(`<(?:[\\w.-]+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${n}>`).exec(b)?.[1] ?? "");
    const res = (n: string) => [...b.matchAll(new RegExp(`<(?:[\\w.-]+:)?${n}\\b[^>]*resource="([^"]+)"`, "g"))].map((x) => decode(x[1]!));
    const predicate = res("propertyDefinition")[0];
    if (!predicate) continue;
    const allowed = res("allowedValue");
    const valueType = res("valueType")[0] ?? "";
    props.push({ title: lit("title") || lit("name") || splitUri(predicate).local, name: lit("name"), predicate, allowed,
      resource: allowed.length > 0 || /#(Resource|AnyResource|LocalResource)$/.test(valueType) });
  }
  return { url, title: htmlText(/<(?:[\w.-]+:)?title\b[^>]*>([\s\S]*?)<\//.exec(rdf)?.[1] ?? "") || splitUri(url).local, props, labels };
}

/** The artifact-type name a caller gave → the shape (exact, then contains). */
export function pickShape(shapes: RmShape[], type: string | undefined): RmShape {
  if (!shapes.length) throw new Error("the project offers no requirement types to create (no resource shapes in its creation factory)");
  const t = String(type ?? "").trim().toLowerCase();
  if (!t) {
    const def = shapes.find((s) => /^(system |software )?requirement$/i.test(s.title)) ?? shapes.find((s) => /requirement/i.test(s.title) && !/heading|module|collection/i.test(s.title));
    if (def) return def;
    throw new Error(`pass type: one of ${shapes.map((s) => s.title).join(", ")}`);
  }
  const hit = shapes.find((s) => s.title.toLowerCase() === t) ?? shapes.find((s) => s.title.toLowerCase().includes(t));
  if (!hit) throw new Error(`unknown artifact type "${type}" — use one of ${shapes.map((s) => s.title).join(", ")}`);
  return hit;
}

/** An attribute name + value → the RDF property to write, checked against the type's shape. */
export function attributeWrite(shape: RmShape, name: string, value: string): { ns: string; local: string; body: { literal?: string; resource?: string } } {
  const n = name.trim().toLowerCase();
  const p = shape.props.find((x) => x.title.toLowerCase() === n || x.name.toLowerCase() === n || x.predicate === name);
  if (!p) throw new Error(`"${shape.title}" has no attribute "${name}" — attributes: ${shape.props.map((x) => x.title).filter((t, i, a) => a.indexOf(t) === i).slice(0, 40).join(", ")}`);
  const { ns, local } = splitUri(p.predicate);
  if (!p.resource) return { ns, local, body: { literal: value } };
  if (/^https?:\/\//i.test(value)) return { ns, local, body: { resource: value } };
  const options = p.allowed.map((u) => ({ u, label: shape.labels.get(u) ?? splitUri(u).local }));
  const hit = options.find((o) => o.label.toLowerCase() === value.trim().toLowerCase());
  if (!hit) throw new Error(`"${value}" is not a value of "${p.title}" — use one of ${options.map((o) => o.label).join(", ") || "(no values listed; pass the value's URL)"}`);
  return { ns, local, body: { resource: hit.u } };
}

/** Link short name or predicate URI → {ns, local}. */
export function linkPredicate(type: string): { ns: string; local: string } {
  const t = String(type ?? "").trim();
  if (/^https?:\/\//i.test(t)) return splitUri(t);
  const hit = RM_LINK_TYPES.find((x) => x.toLowerCase() === t.toLowerCase().replace(/[\s_-]+/g, ""));
  if (!hit) throw new Error(`unknown link type "${type}" — use one of ${RM_LINK_TYPES.join(", ")} or a link type URI`);
  return { ns: NS.oslc_rm, local: hit };
}

/** Compact summary of an artifact's RDF for agents. */
export function summarizeArtifact(rdf: string, url: string, shapes: RmShape[] = []): RmArtifact {
  const doc = new RdfDoc(rdf, url);
  const one = (ns: string, l: string) => doc.values(ns, l)[0] ?? "";
  const shapeUrl = one(NS.oslc, "instanceShape");
  const shape = shapes.find((s) => s.url === shapeUrl);
  const attributes: Record<string, string> = {};
  for (const p of shape?.props ?? []) {
    if (/^(title|identifier|description|primary text)$/i.test(p.title)) continue;
    const { ns, local } = splitUri(p.predicate);
    const v = doc.values(ns, local)[0];
    if (v && Object.keys(attributes).length < 30) attributes[p.title] = (shape!.labels.get(v) ?? v).slice(0, 200);
  }
  const links: { type: string; target: string }[] = [];
  for (const l of RM_LINK_TYPES) for (const t of doc.values(NS.oslc_rm, l)) links.push({ type: l, target: t });
  return {
    id: one(NS.dcterms, "identifier"), url, type: shape?.title ?? (shapeUrl ? splitUri(shapeUrl).local : ""), title: one(NS.dcterms, "title"),
    text: (one(NS.jazz_rm, "primaryText") || one(NS.dcterms, "description")).slice(0, 4000), attributes, links: links.slice(0, 40),
  };
}

// ------------------------------------------------------------------ client

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]!); } }));
  return out;
}

export class RmWriter {
  private info = new Map<string, Promise<RmChangesetInfo>>();
  constructor(private http: () => JazzHttp | null) {}

  private need(): JazzHttp {
    const h = this.http();
    if (!h) throw new Error("IBM DOORS Next is not configured (Settings → Integrations → IBM Jazz → Requirements)");
    return h;
  }
  /** Request inside the changeset. */
  private async call(cs: string, method: string, url: string, body?: string, extra: Record<string, string> = {}) {
    const r = await this.need().request(method, url, body, {
      Accept: "application/rdf+xml", "OSLC-Core-Version": "2.0", "Configuration-Context": cs, "vvc.configuration": cs, "DoorsRP-Request-Type": "public 2.0",
      ...(body !== undefined ? { "Content-Type": "application/rdf+xml" } : {}), ...extra,
    });
    return r;
  }
  private async fail(r: { status: number; text(): Promise<string> }, what: string): Promise<never> {
    const why = serverMessage(await r.text().catch(() => ""));
    const hint = r.status === 412 || r.status === 409 ? " — the artifact changed since it was read; read it again and retry"
      : r.status === 403 ? " — your user may not modify this project or changeset"
      : r.status === 404 ? " — not found in this changeset (wrong id, or it belongs to another component)" : "";
    throw new Error(`${what}: HTTP ${r.status}${hint}${why && !/^<!doctype|^<html/i.test(why) ? ` (${why})` : ""}`);
  }
  private async rdf(cs: string, url: string): Promise<{ body: string; etag: string | null }> {
    const r = await this.call(cs, "GET", url);
    if (!r.ok) await this.fail(r, `cannot read ${url}`);
    return { body: await r.text(), etag: r.headers.get("etag") };
  }

  /** Validates the changeset and resolves its component, project, creation factory and artifact types (cached). */
  changeset(input: unknown): Promise<RmChangesetInfo> {
    const cs = changesetUri(input);
    if (!this.info.has(cs)) {
      const p = this.load(cs);
      this.info.set(cs, p);
      p.catch(() => this.info.delete(cs));
    }
    return this.info.get(cs)!;
  }
  private async load(cs: string): Promise<RmChangesetInfo> {
    const r = await this.call(cs, "GET", cs);
    if (r.status === 404 || r.status === 410) throw new Error(`changeset not found: ${cs} — it may have been delivered or discarded; open a new one`);
    if (!r.ok) await this.fail(r, "cannot read the changeset");
    const body = await r.text();
    const one = (n: string) => new RegExp(`<(?:[\\w.-]+:)?${n}\\b[^>]*resource="([^"]+)"`).exec(body)?.[1];
    const lit = (n: string) => htmlText(new RegExp(`<(?:[\\w.-]+:)?${n}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${n}>`).exec(body)?.[1] ?? "");
    if (lit("committed")) throw new Error(`the changeset "${lit("title") || cs}" is already delivered (committed) — open a new changeset`);
    const component = decode(one("component") ?? "");
    if (!component) throw new Error("the changeset does not name its component (oslc_config:component)");
    const comp = parseComponent((await this.rdf(cs, component)).body);
    if (!comp.projectId) throw new Error(`cannot tell which project the changeset's component belongs to (${component})`);
    const svcRes = await this.call(cs, "GET", `/oslc_rm/${comp.projectId}/services.xml`);
    if (!svcRes.ok) await this.fail(svcRes, "cannot read the project's OSLC services");
    const svc = parseServices(await svcRes.text());
    if (!svc.factory) throw new Error("the project offers no requirement creation factory (OSLC RM) — is it a DOORS Next project with write access?");
    const shapes = (await mapLimit(svc.shapes.slice(0, 60), 6, async (u) => {
      const s = await this.call(cs, "GET", u).catch(() => null);
      return s?.ok ? parseShape(await s.text(), u) : null;
    })).filter((x): x is RmShape => !!x);
    return { changeset: cs, title: lit("title"), component, componentTitle: comp.title, projectId: comp.projectId, factory: svc.factory, queryBase: svc.queryBase, shapes };
  }

  /** Requirement URL from its id (numeric identifier, looked up in the changeset) or URL. */
  async resolve(info: RmChangesetInfo, ref: string): Promise<string> {
    const r = String(ref ?? "").trim();
    if (/^https?:\/\//i.test(r)) return r.replace(/[?#].*$/, "");
    if (!/^\d+$/.test(r)) throw new Error(`requirement "${ref}": pass its numeric id or URL`);
    const base = info.queryBase || `${this.need().baseUrl}/views?oslc.query=true&projectURL=${encodeURIComponent(`${this.need().baseUrl}/process/project-areas/${info.projectId}`)}`;
    const q = `${base}${base.includes("?") ? "&" : "?"}oslc.prefix=${encodeURIComponent("dcterms=<http://purl.org/dc/terms/>")}`
      + `&oslc.select=${encodeURIComponent("dcterms:identifier,dcterms:title")}&oslc.where=${encodeURIComponent(`dcterms:identifier=${r}`)}`;
    const res = await this.call(info.changeset, "GET", q);
    if (!res.ok) await this.fail(res, `cannot look up requirement ${r}`);
    const hits = parseOslcResources(await res.text()).filter((x) => x.identifier === r);
    if (!hits.length) throw new Error(`requirement ${r} not found in component "${info.componentTitle}" (in this changeset)`);
    return hits[0]!.uri;
  }

  async read(changeset: unknown, ref: string): Promise<RmArtifact> {
    const info = await this.changeset(changeset);
    const url = await this.resolve(info, ref);
    return summarizeArtifact((await this.rdf(info.changeset, url)).body, url, info.shapes);
  }

  async create(changeset: unknown, w: RmWrite & { type?: string; folder?: string }): Promise<RmArtifact> {
    if (!String(w.title ?? "").trim() && !String(w.text ?? "").trim()) throw new Error("a new requirement needs a title or text");
    const info = await this.changeset(changeset);
    const shape = pickShape(info.shapes, w.type);
    const doc = new RdfDoc(`<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="${NS.rdf}" xmlns:dcterms="${NS.dcterms}" xmlns:oslc="${NS.oslc}" xmlns:oslc_rm="${NS.oslc_rm}" xmlns:jazz_rm="${NS.jazz_rm}" xmlns:nav="${NS.nav}">
  <oslc_rm:Requirement rdf:about="">
    <oslc:instanceShape rdf:resource="${esc(shape.url)}"/>
  </oslc_rm:Requirement>
</rdf:RDF>`, "");
    if (w.folder) doc.set(NS.nav, "parent", { resource: String(w.folder) });
    this.apply(doc, shape, w);
    const r = await this.call(info.changeset, "POST", info.factory, doc.xml);
    if (r.status !== 201 && !r.ok) await this.fail(r, `cannot create the ${shape.title}`);
    const url = r.headers.get("location") ?? r.headers.get("content-location");
    if (!url) throw new Error(`DOORS Next accepted the new ${shape.title} but did not say where it is (no Location header)`);
    return summarizeArtifact((await this.rdf(info.changeset, url)).body, url, info.shapes);
  }

  async update(changeset: unknown, ref: string, w: RmWrite): Promise<RmArtifact> {
    if (w.title === undefined && w.text === undefined && w.description === undefined && !Object.keys(w.attributes ?? {}).length && !w.addLinks?.length && !w.removeLinks?.length) {
      throw new Error("nothing to change: pass title, text, description, attributes, addLinks or removeLinks");
    }
    const info = await this.changeset(changeset);
    const url = await this.resolve(info, ref);
    const cur = await this.rdf(info.changeset, url);
    const doc = new RdfDoc(cur.body, url);
    const shapeUrl = doc.values(NS.oslc, "instanceShape")[0] ?? "";
    let shape = info.shapes.find((s) => s.url === shapeUrl);
    if (!shape && shapeUrl && Object.keys(w.attributes ?? {}).length) {
      shape = parseShape((await this.rdf(info.changeset, shapeUrl)).body, shapeUrl);
      info.shapes.push(shape);
    }
    this.apply(doc, shape ?? { url: shapeUrl, title: "artifact", props: [], labels: new Map() }, w);
    const r = await this.call(info.changeset, "PUT", url, doc.xml, cur.etag ? { "If-Match": cur.etag } : {});
    if (!r.ok) await this.fail(r, `cannot update requirement ${ref}`);
    return summarizeArtifact((await this.rdf(info.changeset, url)).body, url, info.shapes);
  }

  async remove(changeset: unknown, ref: string, confirm: unknown): Promise<{ deleted: string; title: string; changeset: string; undo: string }> {
    const info = await this.changeset(changeset);
    const url = await this.resolve(info, ref);
    const cur = await this.rdf(info.changeset, url);
    const a = summarizeArtifact(cur.body, url, info.shapes);
    const id = a.id || url;
    if (String(confirm ?? "").trim() !== id) {
      throw new Error(`not deleted: to delete requirement ${id} ("${a.title.slice(0, 80)}") pass confirm: "${id}". Check with the user first if they did not ask for this deletion.`);
    }
    const loc = locate(cur.body, url);
    const types = new RdfDoc(cur.body, url).values(NS.rdf, "type");
    if (/RequirementCollection|Module/i.test(`${loc.name} ${types.join(" ")} ${a.type}`)) {
      throw new Error(`refused: ${id} is a module or collection, not a requirement — delete modules in DOORS Next itself`);
    }
    const r = await this.call(info.changeset, "DELETE", url, undefined, cur.etag ? { "If-Match": cur.etag } : {});
    if (!r.ok && r.status !== 204) await this.fail(r, `cannot delete requirement ${id}`);
    return { deleted: id, title: a.title, changeset: info.title || info.changeset, undo: "Only the changeset changed: discard the changeset (or restore the artifact in it) in DOORS Next before it is delivered to undo." };
  }

  private apply(doc: RdfDoc, shape: RmShape, w: RmWrite) {
    if (w.title !== undefined) doc.set(NS.dcterms, "title", { literal: String(w.title) });
    if (w.description !== undefined) doc.set(NS.dcterms, "description", { literal: String(w.description) });
    if (w.text !== undefined) doc.set(NS.jazz_rm, "primaryText", { xml: textToXhtml(String(w.text)) });
    for (const [k, v] of Object.entries(w.attributes ?? {})) {
      const a = attributeWrite(shape, k, String(v));
      doc.set(a.ns, a.local, a.body);
    }
    for (const l of w.addLinks ?? []) { const p = linkPredicate(l.type); doc.add(p.ns, p.local, String(l.target)); }
    for (const l of w.removeLinks ?? []) {
      const p = linkPredicate(l.type);
      if (!doc.remove(p.ns, p.local, String(l.target))) throw new Error(`no ${l.type} link to ${l.target} on this requirement`);
    }
  }
}
