/**
 * IBM Engineering Test Management (ETM, formerly RQM) client for agents: test plans, suites, cases, scripts,
 * execution records (TCER), results, and links to DOORS Next requirements.
 *  - read/write: ETM Reportable REST API (the "RQM integration service"), XML in the qm/v0.1 schema:
 *      <qm>/service/com.ibm.rqm.integration.service.IIntegrationService/projects
 *      <qm>/service/com.ibm.rqm.integration.service.IIntegrationService/resources/<alias>/<type>[/urn:com.ibm.rqm:<type>:<id>]
 *    GET a feed or one resource, POST to the collection to create (server assigns the id), PUT the edited XML back.
 *  - requirement links: OSLC QM 2.0 (oslc_qm:validatesRequirement on the test case's RDF resource, If-Match ETag).
 * Edits are read-modify-write on the server's own XML, so elements the tools don't know about are kept as they are.
 * The HTTP layer (sign-in, cookies, proxy, certificates) is the shared Jazz client on the /qm context root.
 */

export interface JazzHttp {
  request(method: string, path: string, body?: string, headers?: Record<string, string>):
    Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;
  readonly baseUrl: string;
}

export const QM_TYPES = ["testplan", "testsuite", "testcase", "testscript", "executionworkitem", "suiteexecutionrecord", "executionresult", "suiteexecutionresult", "keyword"] as const;
export type QmType = (typeof QM_TYPES)[number];
const ALIASES: Record<string, QmType> = {
  plan: "testplan", "test plan": "testplan", suite: "testsuite", "test suite": "testsuite", case: "testcase", "test case": "testcase",
  script: "testscript", "test script": "testscript", record: "executionworkitem", tcer: "executionworkitem", "execution record": "executionworkitem",
  "test case execution record": "executionworkitem", result: "executionresult", "execution result": "executionresult", tser: "suiteexecutionrecord",
  "suite execution record": "suiteexecutionrecord", "suite result": "suiteexecutionresult",
};
export function qmType(t: string): QmType {
  const k = String(t ?? "").trim().toLowerCase();
  const hit = (QM_TYPES as readonly string[]).includes(k.replace(/\s+/g, "")) ? k.replace(/\s+/g, "") as QmType : ALIASES[k] ?? ALIASES[k.replace(/s$/, "")];
  if (!hit) throw new Error(`unknown ETM type "${t}" — use one of ${QM_TYPES.join(", ")}`);
  return hit;
}

export const NS = {
  qm: "http://jazz.net/xmlns/alm/qm/v0.1/",
  dc: "http://purl.org/dc/elements/1.1/",
  alm: "http://jazz.net/xmlns/alm/v0.1/",
  ts: "http://jazz.net/xmlns/alm/qm/v0.1/testscript/v0.1/",
  xhtml: "http://www.w3.org/1999/xhtml",
};
/** Namespace of a simple field by its element name (everything else is in the qm schema). */
const FIELD_NS: Record<string, string> = { title: NS.dc, description: NS.dc, creator: NS.dc, identifier: NS.dc, owner: NS.alm, state: NS.alm, priority: NS.alm, updated: NS.alm };

export const VERDICTS = ["passed", "failed", "blocked", "incomplete", "inconclusive", "error", "deferred", "perm_failed", "paused", "inprogress"] as const;
const SVC = "/service/com.ibm.rqm.integration.service.IIntegrationService";

/** Which link elements each type carries (element name → target type). */
export const LINKS: Partial<Record<QmType, Record<string, QmType>>> = {
  testplan: { testcase: "testcase", testsuite: "testsuite" },
  testcase: { testscript: "testscript" },
  testsuite: { testcase: "testcase" }, // stored as suiteelements/suiteelement/testcase
  executionworkitem: { testcase: "testcase", testplan: "testplan", testscript: "testscript" },
  suiteexecutionrecord: { testsuite: "testsuite", testplan: "testplan" },
  executionresult: { executionworkitem: "executionworkitem", testcase: "testcase", testplan: "testplan", testscript: "testscript" },
  suiteexecutionresult: { suiteexecutionrecord: "suiteexecutionrecord", testsuite: "testsuite", testplan: "testplan" },
};

export interface QmStep { description: string; expected?: string; name?: string }
export interface QmItem {
  type: QmType; id: string; url: string; title: string; description?: string; state?: string; owner?: string; updated?: string;
  fields?: Record<string, string>; links?: Record<string, { id: string; url: string; title?: string }[]>; steps?: QmStep[];
}
export interface QmListItem { id: string; title: string; updated?: string; state?: string; owner?: string }
export interface QmWrite {
  title?: string; description?: string; owner?: string; state?: string;
  /** Other simple elements by name (qm schema), e.g. {"weight": "5"}; "" removes nothing, it sets empty. */
  fields?: Record<string, string>;
  /** Links to add: element/target type → ids or URLs, e.g. {"testcase": ["12", "13"]}. */
  addLinks?: Record<string, string[]>;
  removeLinks?: Record<string, string[]>;
  /** Test script steps: replaces all steps. */
  steps?: QmStep[];
}

// ------------------------------------------------------------------ XML helpers (prefix agnostic, top level only)

export const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const htmlText = (s: string) => decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&lt;br\s*\/?&gt;/gi, "\n")).replace(/<[^>]+>/g, " ").replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

interface El { prefix: string; name: string; start: number; end: number; open: string; inner: string }

/** Direct children of an XML fragment (comments, CDATA and processing instructions skipped). */
export function children(xml: string): El[] {
  const out: El[] = [];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)(?:([\w.-]+):)?([\w.-]+)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  let depth = 0;
  let cur: { prefix: string; name: string; start: number; open: string; innerStart: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[3] === undefined) continue;
    const closing = m[1] === "/", self = m[4] === "/";
    if (!closing) {
      if (depth === 0) {
        if (self) { out.push({ prefix: m[2] ?? "", name: m[3], start: m.index, end: m.index + m[0].length, open: m[0], inner: "" }); continue; }
        cur = { prefix: m[2] ?? "", name: m[3], start: m.index, open: m[0], innerStart: m.index + m[0].length };
      }
      if (!self) depth++;
    } else {
      depth--;
      if (depth === 0 && cur) {
        out.push({ prefix: cur.prefix, name: cur.name, start: cur.start, end: m.index + m[0].length, open: cur.open, inner: xml.slice(cur.innerStart, m.index) });
        cur = null;
      }
    }
  }
  return out;
}

const attrOf = (open: string, name: string) => new RegExp(`\\s(?:[\\w.-]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(open)?.[1];

/** Root element split into its open tag, inner XML and close tag. */
export function splitRoot(xml: string): { head: string; open: string; inner: string; close: string; name: string; prefix: string } {
  const root = children(xml)[0];
  if (!root) throw new Error("ETM returned no XML document");
  if (!root.open.endsWith("/>")) {
    return { head: xml.slice(0, root.start), open: root.open, inner: root.inner, close: xml.slice(root.start + root.open.length + root.inner.length, root.end), name: root.name, prefix: root.prefix };
  }
  return { head: xml.slice(0, root.start), open: root.open.replace(/\/>$/, ">"), inner: "", close: `</${root.prefix ? root.prefix + ":" : ""}${root.name}>`, name: root.name, prefix: root.prefix };
}

/** Editable view of an ETM resource's XML; every edit keeps the rest of the document untouched. */
export class QmDoc {
  private r: ReturnType<typeof splitRoot>;
  constructor(xml: string) { this.r = splitRoot(xml); }
  get type(): string { return this.r.name; }
  toString(): string { return `${this.r.head}${this.r.open}${this.r.inner}${this.r.close}`; }
  els(name?: string): El[] { return children(this.r.inner).filter((e) => !name || e.name === name); }
  text(name: string): string | undefined {
    const e = this.els(name)[0];
    return e ? htmlText(e.inner) : undefined;
  }
  set(name: string, value: string, opts: { html?: boolean } = {}): this {
    const body = opts.html ? `<div xmlns="${NS.xhtml}">${esc(value).replace(/\n/g, "<br/>")}</div>` : esc(value);
    const e = this.els(name)[0];
    if (e) {
      const open = e.open.replace(/\/>$/, ">");
      const tag = `${e.prefix ? e.prefix + ":" : ""}${e.name}`;
      return this.splice(e.start, e.end, `${open}${body}</${tag}>`);
    }
    return this.insert(`<${name} xmlns="${FIELD_NS[name] ?? NS.qm}">${body}</${name}>`, name);
  }
  hrefs(name: string): string[] { return this.els(name).map((e) => attrOf(e.open, "href")).filter((h): h is string => !!h).map(decode); }
  addLink(name: string, href: string): this {
    if (this.hrefs(name).includes(href)) return this;
    return this.insert(`<${name} xmlns="${NS.qm}" href="${esc(href)}"/>`, name);
  }
  removeLink(name: string, match: (href: string) => boolean): this {
    for (const e of this.els(name).reverse()) { const h = attrOf(e.open, "href"); if (h && match(decode(h))) this.splice(e.start, e.end, ""); }
    return this;
  }
  /** Test cases of a test suite (suiteelements/suiteelement/testcase). */
  suiteCases(): string[] {
    const box = this.els("suiteelements")[0];
    if (!box) return [];
    return children(box.inner).flatMap((se) => children(se.inner).filter((c) => c.name === "testcase").map((c) => decode(attrOf(c.open, "href") ?? ""))).filter(Boolean);
  }
  addSuiteCase(href: string): this {
    if (this.suiteCases().includes(href)) return this;
    const box = this.els("suiteelements")[0];
    const n = box ? children(box.inner).length : 0;
    const el = `<suiteelement xmlns="${NS.qm}" elementindex="${n}"><testcase href="${esc(href)}"/></suiteelement>`;
    if (!box) return this.insert(`<suiteelements xmlns="${NS.qm}">${el}</suiteelements>`, "suiteelements");
    const at = box.start + box.open.length + box.inner.length;
    return this.splice(at, at, el);
  }
  removeSuiteCase(match: (href: string) => boolean): this {
    const box = this.els("suiteelements")[0];
    if (!box) return this;
    const base = box.start + box.open.length;
    for (const se of children(box.inner).reverse()) {
      const tc = children(se.inner).find((c) => c.name === "testcase");
      const h = tc && attrOf(tc.open, "href");
      if (h && match(decode(h))) this.splice(base + se.start, base + se.end, "");
    }
    return this;
  }
  steps(): QmStep[] {
    const box = this.els("steps")[0];
    if (!box) return [];
    return children(box.inner).filter((s) => s.name === "step").map((s) => {
      const kid = (n: string) => { const c = children(s.inner).find((x) => x.name === n); return c ? htmlText(c.inner) : ""; };
      return { ...(kid("name") ? { name: kid("name") } : {}), description: kid("description"), ...(kid("expectedResult") ? { expected: kid("expectedResult") } : {}) };
    });
  }
  setSteps(steps: QmStep[]): this {
    const div = (t: string) => `<div xmlns="${NS.xhtml}">${esc(t).replace(/\n/g, "<br/>")}</div>`;
    const xml = `<steps xmlns="${NS.ts}">${steps.map((s, i) => `<step type="execution" stepIndex="${i + 1}">${s.name ? `<name>${esc(s.name)}</name>` : ""}<description>${div(s.description ?? "")}</description>${s.expected ? `<expectedResult>${div(s.expected)}</expectedResult>` : ""}</step>`).join("")}</steps>`;
    const e = this.els("steps")[0];
    return e ? this.splice(e.start, e.end, xml) : this.insert(xml, "steps");
  }
  /** Insert after the last sibling of the same name, else before the end of the root. */
  private insert(xml: string, name: string): this {
    const same = this.els(name).pop();
    const at = same ? same.end : this.r.inner.length;
    return this.splice(at, at, xml);
  }
  private splice(a: number, b: number, s: string): this { this.r.inner = this.r.inner.slice(0, a) + s + this.r.inner.slice(b); return this; }
}

/** Id from an ETM URL (urn:com.ibm.rqm:<type>:<id>, else the last path segment). */
export function idOf(url: string): string {
  const u = decode(url);
  return /urn:com\.ibm\.rqm:[\w]+:([^/?#]+)/.exec(u)?.[1] ?? /urn%3Acom\.ibm\.rqm%3A\w+%3A([^/?#]+)/i.exec(u)?.[1] ?? u.replace(/[?#].*$/, "").split("/").filter(Boolean).pop() ?? u;
}
const short = (s: string | undefined) => s ? s.replace(/^.*[.:/]/, "") : s; // com.ibm.rqm.execution.common.state.passed → passed

/** Compact view of a resource for agents. */
export function summarize(type: QmType, xml: string, url: string): QmItem {
  const d = new QmDoc(xml);
  const known = new Set(["title", "description", "state", "owner", "updated", "webId", "steps", "suiteelements", "identifier", "stylesheet", "alias"]);
  const fields: Record<string, string> = {};
  const links: Record<string, { id: string; url: string; title?: string }[]> = {};
  for (const e of d.els()) {
    const href = attrOf(e.open, "href");
    if (href) {
      const h = decode(href);
      (links[e.name] ??= []).push({ id: idOf(h), url: h, ...(attrOf(e.open, "summary") ? { title: decode(attrOf(e.open, "summary")!) } : {}) });
      continue;
    }
    if (known.has(e.name) || Object.keys(fields).length >= 30) continue;
    const v = htmlText(e.inner);
    if (v && !children(e.inner).some((c) => children(c.inner).length)) fields[e.name] = v.slice(0, 300);
  }
  const cases = d.suiteCases();
  if (cases.length) links.testcase = cases.map((h) => ({ id: idOf(h), url: h }));
  const steps = d.steps();
  const state = d.text("state");
  return {
    type, id: d.text("webId") || idOf(url), url, title: d.text("title") ?? "",
    ...(d.text("description") ? { description: d.text("description")!.slice(0, 4000) } : {}),
    ...(state ? { state: short(state) } : {}), ...(d.text("owner") ? { owner: d.text("owner") } : {}),
    ...(d.text("updated") ? { updated: d.text("updated") } : {}),
    ...(Object.keys(fields).length ? { fields } : {}), ...(Object.keys(links).length ? { links } : {}), ...(steps.length ? { steps } : {}),
  };
}

/** Atom feed entries (plain or with ?fields= content). */
export function parseFeed(xml: string): { items: QmListItem[]; next?: string } {
  const items: QmListItem[] = [];
  for (const e of xml.matchAll(/<(?:[\w.-]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?entry>/g)) {
    const body = e[1]!;
    const content = /<(?:[\w.-]+:)?content\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?content>/.exec(body)?.[1] ?? "";
    const inner = content ? (children(content)[0]?.inner ?? "") : "";
    const tag = (src: string, n: string) => { const c = children(src).find((x) => x.name === n); return c ? htmlText(c.inner) : ""; };
    const head = body.replace(/<(?:[\w.-]+:)?content\b[\s\S]*?(?:\/>|<\/(?:[\w.-]+:)?content>)/, "");
    const id = tag(inner, "webId") || idOf(tag(head, "id"));
    if (!id) continue;
    items.push({
      id, title: tag(inner, "title") || tag(head, "title"), ...(tag(inner, "updated") || tag(head, "updated") ? { updated: tag(inner, "updated") || tag(head, "updated") } : {}),
      ...(tag(inner, "state") ? { state: short(tag(inner, "state")) } : {}), ...(tag(inner, "owner") ? { owner: tag(inner, "owner") } : {}),
    });
  }
  const next = /<(?:[\w.-]+:)?link\b[^>]*rel="next"[^>]*>/.exec(xml)?.[0];
  return { items, ...(next && attrOf(next, "href") ? { next: decode(attrOf(next, "href")!) } : {}) };
}

/** ETM project areas from the integration service's projects feed (title + URL alias). */
export function parseProjects(xml: string): { title: string; alias: string }[] {
  const out: { title: string; alias: string }[] = [];
  for (const e of xml.matchAll(/<(?:[\w.-]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?entry>/g)) {
    const kids = children(e[1]!);
    const title = htmlText(kids.find((k) => k.name === "title")?.inner ?? "");
    const explicit = htmlText(e[1]!.match(/<(?:[\w.-]+:)?alias\b[^>]*>([\s\S]*?)<\//)?.[1] ?? "");
    const id = htmlText(kids.find((k) => k.name === "id")?.inner ?? "");
    const fromId = /\/(?:projects|resources)\/([^/?#]+)\/?$/.exec(id)?.[1] ?? "";
    const alias = explicit || fromId || encodeURIComponent(title);
    if (title) out.push({ title, alias });
  }
  return out;
}

// ------------------------------------------------------------------ client

export class EtmClient {
  private projectsCache: { title: string; alias: string }[] | null = null;
  private oslcCtx: Map<string, string> | null = null;

  constructor(private http: JazzHttp, private cfg: () => { projectArea: string; config: string }) {}

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const projects = await this.projects(true);
      const want = this.cfg().projectArea;
      if (!want) return { ok: true, detail: `Connected · ${projects.length} ETM project area${projects.length === 1 ? "" : "s"} visible — pick one` };
      const alias = await this.alias();
      const tcs = await this.list("testcase", { max: 3 });
      const plans = await this.list("testplan", { max: 3 });
      return { ok: true, detail: `Connected · project area “${want}” (alias ${decodeURIComponent(alias.replace(/\+/g, " "))}) · test plans ${plans.length ? "found" : "none yet"}, test cases ${tcs.length ? "found" : "none yet"}` };
    } catch (e: any) {
      return { ok: false, detail: String(e?.message ?? e) };
    }
  }

  async projects(refresh = false): Promise<{ title: string; alias: string }[]> {
    if (this.projectsCache && !refresh) return this.projectsCache;
    return (this.projectsCache = parseProjects(await this.get(`${SVC}/projects`)));
  }

  /** URL alias of the configured (or given) project area; a name that isn't listed is used as the alias itself. */
  async alias(projectArea?: string): Promise<string> {
    const want = (projectArea ?? this.cfg().projectArea).trim();
    if (!want) throw new Error("No ETM project area set (Settings → Integrations → IBM Jazz → Test management)");
    const list = await this.projects().catch(() => [] as { title: string; alias: string }[]);
    const hit = list.find((p) => p.title === want) ?? list.find((p) => p.title.toLowerCase() === want.toLowerCase()) ?? list.find((p) => p.alias === want);
    if (hit) return hit.alias;
    return /%[0-9a-f]{2}|\+/i.test(want) ? want : encodeURIComponent(want);
  }

  /** URL of a collection or one resource. id: web id (number), slug, or a full URL. */
  async url(type: QmType, id?: string, projectArea?: string): Promise<string> {
    if (id && /^https?:\/\//i.test(id)) return id;
    const slug = id ? (/^\d+$/.test(id.trim()) ? `urn:com.ibm.rqm:${type}:${id.trim()}` : encodeURIComponent(id.trim()).replace(/%3A/gi, ":")) : "";
    return `${this.http.baseUrl}${SVC}/resources/${await this.alias(projectArea)}/${type}${slug ? "/" + slug : ""}`;
  }

  async list(type: QmType, o: { text?: string; filter?: string; max?: number; projectArea?: string } = {}): Promise<QmListItem[]> {
    const max = Math.min(Math.max(o.max ?? 25, 1), 500);
    const text = (o.text ?? "").trim();
    if (/^\d+(\s*,\s*\d+)*$/.test(text)) {
      const ids = text.split(",").map((x) => x.trim()).slice(0, 25);
      const got = await Promise.all(ids.map((id) => this.item(type, id, o.projectArea).catch(() => null)));
      return got.filter((x): x is QmItem => !!x).map((x) => ({ id: x.id, title: x.title, ...(x.state ? { state: x.state } : {}), ...(x.updated ? { updated: x.updated } : {}) }));
    }
    let next: string | undefined = await this.url(type, undefined, o.projectArea);
    const filter = (o.filter ?? "").trim();
    if (filter) next += `?fields=${encodeURIComponent(`feed/entry/content/${type}${filter.startsWith("[") ? filter : `[${filter}]`}/(webId|title|updated|state|owner)`)}`;
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const out: QmListItem[] = [];
    for (let page = 0; next && page < 20 && out.length < max; page++) {
      const feed = parseFeed(await this.get(next));
      out.push(...feed.items.filter((i) => words.every((w) => `${i.id} ${i.title}`.toLowerCase().includes(w))));
      next = feed.next && feed.next !== next ? feed.next : undefined;
    }
    return out.slice(0, max);
  }

  async item(type: QmType, id: string, projectArea?: string): Promise<QmItem> {
    const url = await this.url(type, id, projectArea);
    return summarize(type, await this.get(url), url);
  }

  async create(type: QmType, w: QmWrite, projectArea?: string): Promise<QmItem> {
    if (!w.title?.trim()) throw new Error("title is required");
    const doc = new QmDoc(`<?xml version="1.0" encoding="UTF-8"?><${type} xmlns="${NS.qm}"></${type}>`);
    await this.apply(doc, type, w, projectArea);
    const coll = await this.url(type, undefined, projectArea);
    let r = await this.http.request("POST", this.withConfig(coll), doc.toString(), { "Content-Type": "application/xml; charset=UTF-8", Accept: "application/xml", "OSLC-Core-Version": "none" });
    let where = r.headers.get("location") ?? r.headers.get("content-location") ?? "";
    if (r.status === 405 || r.status === 501) {
      // Older servers create only with PUT to a client-chosen external id.
      where = `${coll}/flashmaster_${Date.now().toString(36)}`;
      r = await this.http.request("PUT", this.withConfig(where), doc.toString(), { "Content-Type": "application/xml; charset=UTF-8", Accept: "application/xml", "OSLC-Core-Version": "none" });
    }
    if (!r.ok) throw new Error(`creating the ${type} failed: HTTP ${r.status} ${errText(await r.text().catch(() => ""))}`);
    if (!where) {
      const body = await r.text().catch(() => "");
      const webId = /<(?:[\w.-]+:)?webId>(\d+)</.exec(body)?.[1];
      if (webId) return this.item(type, webId, projectArea);
      return { type, id: "?", url: coll, title: w.title!, description: "created, but the server did not say its id — find it with qm_list" };
    }
    return this.item(type, /^https?:/i.test(where) ? where : `${this.http.baseUrl.replace(/^(https?:\/\/[^/]+).*$/, "$1")}${where}`, projectArea);
  }

  async update(type: QmType, id: string, w: QmWrite, projectArea?: string): Promise<QmItem> {
    const url = await this.url(type, id, projectArea);
    const cur = await this.http.request("GET", this.withConfig(url), undefined, { Accept: "application/xml", "OSLC-Core-Version": "none" });
    if (!cur.ok) throw new Error(`cannot read ${type} ${id}: HTTP ${cur.status} ${errText(await cur.text().catch(() => ""))}`);
    const etag = cur.headers.get("etag");
    const doc = new QmDoc(await cur.text());
    await this.apply(doc, type, w, projectArea);
    const r = await this.http.request("PUT", this.withConfig(url), doc.toString(), {
      "Content-Type": "application/xml; charset=UTF-8", Accept: "application/xml", "OSLC-Core-Version": "none", ...(etag ? { "If-Match": etag } : {}),
    });
    if (!r.ok) throw new Error(`updating ${type} ${id} failed: HTTP ${r.status} ${errText(await r.text().catch(() => ""))}`);
    return this.item(type, url, projectArea);
  }

  /**
   * Record a test result: finds the test case's execution record (TCER) in the plan, creating one if needed,
   * then creates an execution result with the verdict.
   */
  async recordResult(a: { testcase: string; testplan?: string; record?: string; verdict: string; title?: string; notes?: string; start?: string; end?: string; projectArea?: string }):
    Promise<{ record: string; createdRecord: boolean; result: QmItem }> {
    const verdict = String(a.verdict ?? "").toLowerCase().replace(/^com\.ibm\.rqm\.execution\.common\.state\./, "").replace(/\s+/g, "_");
    if (!(VERDICTS as readonly string[]).includes(verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
    const tc = await this.item("testcase", a.testcase, a.projectArea);
    let record = a.record ? idOf(a.record) : "";
    let createdRecord = false;
    if (!record) {
      const recs = await this.recordsFor(tc.id, a.testplan ? idOf(a.testplan) : undefined, a.projectArea).catch(() => []);
      record = recs[0] ?? "";
    }
    if (!record) {
      const rec = await this.create("executionworkitem", {
        title: `${tc.title}${a.testplan ? ` (plan ${idOf(a.testplan)})` : ""}`,
        addLinks: { testcase: [tc.id], ...(a.testplan ? { testplan: [a.testplan] } : {}) },
      }, a.projectArea);
      record = rec.id;
      createdRecord = true;
    }
    const now = new Date().toISOString();
    const result = await this.create("executionresult", {
      title: a.title?.trim() || `${tc.title} — ${verdict}`,
      state: `com.ibm.rqm.execution.common.state.${verdict}`,
      fields: { starttime: a.start || now, endtime: a.end || a.start || now },
      addLinks: { executionworkitem: [record], testcase: [tc.id], ...(a.testplan ? { testplan: [a.testplan] } : {}) },
      ...(a.notes ? { notes: a.notes } : {}),
    } as QmWrite & { notes?: string }, a.projectArea);
    return { record, createdRecord, result };
  }

  /** Execution records of a test case (optionally in one plan), newest first as the server lists them. */
  async recordsFor(testcaseId: string, planId?: string, projectArea?: string): Promise<string[]> {
    const coll = await this.url("executionworkitem", undefined, projectArea);
    const out: string[] = [];
    let next: string | undefined = `${coll}?fields=${encodeURIComponent("feed/entry/content/executionworkitem/(webId|testcase|testplan)")}`;
    for (let page = 0; next && page < 10; page++) {
      const xml = await this.get(next);
      for (const e of xml.matchAll(/<(?:[\w.-]+:)?entry\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?entry>/g)) {
        const tcHref = /<(?:[\w.-]+:)?testcase\b[^>]*href="([^"]+)"/.exec(e[1]!)?.[1];
        const planHref = /<(?:[\w.-]+:)?testplan\b[^>]*href="([^"]+)"/.exec(e[1]!)?.[1];
        const id = /<(?:[\w.-]+:)?webId>([^<]+)</.exec(e[1]!)?.[1] ?? idOf(/<(?:[\w.-]+:)?id>([^<]+)</.exec(e[1]!)?.[1] ?? "");
        if (id && tcHref && idOf(tcHref) === testcaseId && (!planId || (planHref && idOf(planHref) === planId))) out.push(id);
      }
      const n = parseFeed(xml).next;
      next = n && n !== next ? n : undefined;
    }
    return out;
  }

  // ---------------------------------------------------------------- requirement links (OSLC QM)

  /** Requirements a test case validates (DOORS Next or other OSLC RM links). */
  async requirementLinks(testcase: string, projectArea?: string): Promise<string[]> {
    const { rdf } = await this.oslcTestCase(testcase, projectArea);
    return [...rdf.body.matchAll(/<(?:[\w.-]+:)?validatesRequirement\b[^>]*resource="([^"]+)"/g)].map((m) => decode(m[1]!));
  }

  async linkRequirement(testcase: string, requirement: string, remove = false, projectArea?: string): Promise<string[]> {
    const req = requirement.trim();
    if (!/^https?:\/\//i.test(req)) throw new Error("requirement must be the requirement's URL (rm_get returns it as url)");
    const { url, rdf } = await this.oslcTestCase(testcase, projectArea);
    const body = remove ? removeValidates(rdf.body, req) : addValidates(rdf.body, url, req);
    if (body !== rdf.body) {
      const r = await this.http.request("PUT", this.withConfig(url), body, {
        "Content-Type": "application/rdf+xml", Accept: "application/rdf+xml", "OSLC-Core-Version": "2.0", ...(rdf.etag ? { "If-Match": rdf.etag } : {}),
      });
      if (!r.ok) throw new Error(`updating the test case's requirement links failed: HTTP ${r.status} ${errText(await r.text().catch(() => ""))}`);
    }
    return this.requirementLinks(url, projectArea);
  }

  private async oslcTestCase(testcase: string, projectArea?: string): Promise<{ url: string; rdf: { body: string; etag: string | null } }> {
    let url = /^https?:\/\/.*\/oslc_qm\//i.test(testcase) ? testcase : "";
    if (!url) {
      const id = idOf(testcase);
      const ctx = await this.oslcContext(projectArea);
      const q = (where: string) => `${this.http.baseUrl}/oslc_qm/contexts/${ctx}/resources/com.ibm.rqm.planning.VersionedTestCase?oslc.prefix=${encodeURIComponent("oslc=<http://open-services.net/ns/core#>,dcterms=<http://purl.org/dc/terms/>")}&oslc.where=${encodeURIComponent(where)}`;
      for (const where of [`oslc:shortId=${id}`, `dcterms:identifier="${id}"`]) {
        const r = await this.http.request("GET", this.withConfig(q(where)), undefined, { Accept: "application/rdf+xml", "OSLC-Core-Version": "2.0" });
        if (!r.ok) continue;
        url = decode(/(?:rdf:about|rdf:resource)="([^"]*VersionedTestCase\/[^"?]+)"/.exec(await r.text())?.[1] ?? "");
        if (url) break;
      }
      if (!url) throw new Error(`test case ${id} was not found through OSLC (needed for requirement links)`);
    }
    const r = await this.http.request("GET", this.withConfig(url), undefined, { Accept: "application/rdf+xml", "OSLC-Core-Version": "2.0" });
    if (!r.ok) throw new Error(`cannot read test case ${testcase} (OSLC): HTTP ${r.status}`);
    return { url, rdf: { body: await r.text(), etag: r.headers.get("etag") } };
  }

  private async oslcContext(projectArea?: string): Promise<string> {
    const want = (projectArea ?? this.cfg().projectArea).trim();
    if (!this.oslcCtx) {
      const rdf = await this.get(`${this.http.baseUrl}/oslc_qm/catalog`, "application/rdf+xml", "2.0");
      this.oslcCtx = new Map();
      for (const m of rdf.matchAll(/<(?:[\w.-]+:)?ServiceProvider\b[^>]*about="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?ServiceProvider>/g)) {
        const title = htmlText(/<(?:[\w.-]+:)?title\b[^>]*>([\s\S]*?)<\//.exec(m[2]!)?.[1] ?? "");
        const ctx = /\/contexts\/([^/]+)/.exec(m[1]!)?.[1];
        if (title && ctx) this.oslcCtx.set(title, ctx);
      }
    }
    const hit = this.oslcCtx.get(want) ?? [...this.oslcCtx].find(([t]) => t.toLowerCase() === want.toLowerCase())?.[1];
    if (!hit) throw new Error(`ETM project area “${want}” not found in the OSLC catalog`);
    return hit;
  }

  // ---------------------------------------------------------------- internals

  /** Sets fields, links and steps on a document (link ids resolve to resource URLs). */
  private async apply(doc: QmDoc, type: QmType, w: QmWrite & { notes?: string }, projectArea?: string): Promise<void> {
    if (w.title !== undefined) doc.set("title", w.title);
    if (w.description !== undefined) doc.set("description", w.description);
    if (w.owner !== undefined) doc.set("owner", w.owner);
    if (w.state !== undefined) doc.set("state", w.state);
    for (const [k, v] of Object.entries(w.fields ?? {})) {
      if (!/^[A-Za-z_][\w.-]*$/.test(k)) throw new Error(`invalid field name ${k}`);
      doc.set(k, String(v));
    }
    if (w.notes) doc.set("details", w.notes, { html: true });
    const allowed = LINKS[type] ?? {};
    const target = async (k: string, ref: string) => {
      const t = allowed[k];
      if (!t) throw new Error(`a ${type} cannot link to “${k}” here — allowed: ${Object.keys(allowed).join(", ") || "none"}${k === "requirement" ? " (use qm_link_requirement)" : ""}`);
      return this.url(t, ref, projectArea);
    };
    const sameItem = (ref: string) => (h: string) => h === ref || idOf(h) === idOf(ref);
    for (const [k, refs] of Object.entries(w.addLinks ?? {})) {
      for (const ref of refs ?? []) {
        const href = await target(k, String(ref));
        if (type === "testsuite" && k === "testcase") doc.addSuiteCase(href); else doc.addLink(k, href);
      }
    }
    for (const [k, refs] of Object.entries(w.removeLinks ?? {})) {
      for (const ref of refs ?? []) {
        await target(k, String(ref));
        if (type === "testsuite" && k === "testcase") doc.removeSuiteCase(sameItem(String(ref))); else doc.removeLink(k, sameItem(String(ref)));
      }
    }
    if (w.steps) {
      if (type !== "testscript") throw new Error("steps belong to a testscript (link it to the test case with addLinks: {testscript: [id]})");
      doc.setSteps(w.steps);
    }
  }

  private withConfig(url: string): string {
    const c = this.cfg().config.trim();
    if (!c || /[?&]oslc_config\.context=/.test(url)) return url;
    return `${url}${url.includes("?") ? "&" : "?"}oslc_config.context=${encodeURIComponent(c)}`;
  }

  private async get(path: string, accept = "application/xml", oslc = "none"): Promise<string> {
    const url = this.withConfig(/^https?:/i.test(path) ? path : `${this.http.baseUrl}${path}`);
    const r = await this.http.request("GET", url, undefined, { Accept: accept, "OSLC-Core-Version": oslc });
    if (!r.ok) {
      const why = errText(await r.text().catch(() => ""));
      throw new Error(r.status === 404 ? `not found in ETM: ${url.replace(/[?].*$/, "").replace(/^.*\/resources\//, "")}${why ? ` (${why})` : ""}` : `ETM: HTTP ${r.status} for ${url.replace(/[?].*$/, "")}${why ? `: ${why}` : ""}`);
    }
    return r.text();
  }
}

export function addValidates(rdf: string, resourceUrl: string, req: string): string {
  if (removeValidates(rdf, req) !== rdf) return rdf; // already linked
  const qm = /xmlns:([\w.-]+)="http:\/\/open-services\.net\/ns\/qm#"/.exec(rdf)?.[1] ?? "oslc_qm";
  const rdfp = /xmlns:([\w.-]+)="http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#"/.exec(rdf)?.[1] ?? "rdf";
  const el = `<${qm}:validatesRequirement ${rdfp}:resource="${esc(req)}"/>`;
  // The test case's own description element: the one about resourceUrl, else the first oslc_qm:TestCase.
  const opens = [...rdf.matchAll(/<([\w.-]+:)?(TestCase|Description)\b[^>]*>/g)];
  const own = opens.find((m) => m[0].includes(`"${resourceUrl}"`)) ?? opens.find((m) => m[2] === "TestCase");
  if (!own) throw new Error("unexpected OSLC test case format (no TestCase element)");
  const close = `</${own[1] ?? ""}${own[2]}>`;
  const at = rdf.indexOf(close, own.index!);
  if (at < 0) throw new Error("unexpected OSLC test case format");
  return rdf.slice(0, at) + el + rdf.slice(at);
}

export function removeValidates(rdf: string, req: string): string {
  const u = req.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return rdf.replace(new RegExp(`<([\\w.-]+:)?validatesRequirement\\b[^>]*resource="(?:${u}|${esc(req).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})"[^>]*?(?:/>|>[\\s\\S]*?</\\1validatesRequirement>)`, "g"), "");
}

const errText = (body: string) => {
  const m = /<(?:[\w.-]+:)?(?:message|errorMessage|detail)[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:message|errorMessage|detail)>/i.exec(body)?.[1]
    ?? /"(?:errorMessage|message)"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? (/^\s*<(!doctype|html)/i.test(body) ? "" : body);
  return decode(m.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 240);
};
