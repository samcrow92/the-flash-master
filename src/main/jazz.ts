/**
 * IBM Engineering Workflow Management (Jazz / RTC) client.
 *  - read:   Reportable REST API  /rpt/repository/workitem  (XML, simple and stable across EWM versions)
 *  - write:  OSLC CM v2           /resource/itemName/com.ibm.team.workitem.WorkItem/<id>  (+ comments)
 *  - auth:   form (j_security_check, EWM default), HTTP basic, or Windows integrated (Kerberos/NTLM via Chromium).
 * HTTP 401 is handled from the server's WWW-Authenticate header: re-login for expired form sessions, a one-time
 * Basic fallback when the server asks for it, and a precise message for Negotiate/NTLM or Jazz Authorization Server.
 * `fetchImpl` is injected: Electron's session.fetch in the app (system proxy + Windows certificate store), a fake in tests.
 */
import type { JazzComment, JazzSearch, JazzWorkItem } from "@shared/types";

/**
 * Electron's net/session.fetch cancels requests made with redirect: "manual" ("Redirect was cancelled"), so the client
 * always follows redirects and relies on a cookie-keeping session (persist:jazz) for the login cookies set on 302s.
 */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; ok: boolean; url?: string; headers: { get(name: string): string | null; getSetCookie?: () => string[] }; text(): Promise<string> }>;

const AUTH_MSG = "x-com-ibm-team-repository-web-auth-msg";

export interface JazzConfig {
  serverUrl: string;
  projectAreas: string[];
  authType: "form" | "basic" | "windows" | "browser";
  username: string;
  password: string;
}

const BASIC_FIELDS = "(id|summary|description|state/name|type/name|owner/name|projectArea/name)";
const CLOSED_STATE = /resolv|clos|done|verif|invalid|reject|duplicat|obsolet|cancel|complet|finish|fixed|works ?as ?designed/i;
/** Query shapes tried in order when a server rejects one (fields or filters unsupported by that EWM version). */
type QueryLevel = 0 | 1 | 2 | 3;

export class JazzQueryError extends Error {
  constructor(readonly status: number, readonly serverMessage: string) {
    super(`Jazz query failed: HTTP ${status}${serverMessage ? ` — ${serverMessage}` : ""}`);
  }
}

const LIST_FIELDS = "(id|summary|description|state/name|type/name|owner/name|owner/userId|projectArea/name|priority/name|severity/name|modified|itemId)";
const DETAIL_FIELDS = "(id|summary|description|state/name|type/name|owner/name|projectArea/name|priority/name|severity/name|category/name|target/name|creator/name|creationDate|modified|tags|comments/(content|creator/name|creationDate))";

export class JazzClient {
  private cookies = new Map<string, string>();
  private authed = false;
  private basicFallback = false;
  private me: string | null = null;
  private level: QueryLevel = 0; // first query shape this server accepted

  constructor(private cfg: JazzConfig, private fetchImpl: FetchLike) {
    this.cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, "");
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      const r = await this.send("GET", "/rpt/repository/workitem?size=1&fields=workitem/workItem/(id)", undefined, { Accept: "text/xml" });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      const user = await this.whoAmI().catch(() => null);
      return { ok: true, detail: `Connected${user ? ` as ${user}` : ""}${this.basicFallback ? " (server asked for Basic authentication — switch Authentication to Basic)" : ""}` };
    } catch (e: any) {
      return { ok: false, detail: String(e?.message ?? e) };
    }
  }

  /** User id of the signed-in user (owner "me"). */
  async whoAmI(): Promise<string | null> {
    if (this.me) return this.me;
    if ((this.cfg.authType === "form" || this.cfg.authType === "basic") && this.cfg.username) return (this.me = this.cfg.username);
    const r = await this.send("GET", "/authenticated/identity", undefined, { Accept: "application/json" });
    const body = await r.text();
    let id: string | null;
    try { id = JSON.parse(body)?.userId ?? null; } catch { id = /"userId"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? null; }
    return (this.me = id);
  }

  /** Project areas visible to the user (for the settings picker). */
  async listProjectAreas(): Promise<string[]> {
    const r = await this.send("GET", "/process/project-areas", undefined, { Accept: "text/xml" });
    if (!r.ok) throw new Error(`could not list project areas: HTTP ${r.status}`);
    const xml = await r.text();
    const names = [...xml.matchAll(/<(?:\w+:)?project-area\b[^>]*\b(?:\w+:)?name="([^"]+)"/g)].map((m) => decode(m[1]!));
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  }

  async get(id: string): Promise<JazzWorkItem> {
    return (await this.detail(id)).item;
  }

  /** Full work item with its comments. */
  async detail(id: string): Promise<{ item: JazzWorkItem; comments: JazzComment[] }> {
    const f = `[id=${Number(id)}]`;
    let xml: string;
    try { xml = await this.rptXml(f, DETAIL_FIELDS, 1); }
    catch (e) {
      if (!(e instanceof JazzQueryError)) throw e;
      // Older servers reject some detail fields: fall back to the basics, then add comments if possible.
      xml = await this.rptXml(f, LIST_FIELDS, 1).catch(() => this.rptXml(f, BASIC_FIELDS, 1));
      const c = await this.rptXml(f, "(id|comments/(content|creator/name|creationDate))", 1).catch(() => "");
      const item = parseWorkItems(xml, this.cfg.serverUrl)[0];
      if (!item) throw new Error(`work item ${id} not found`, { cause: e });
      return { item, comments: c ? parseComments(c) : [] };
    }
    const item = parseWorkItems(xml, this.cfg.serverUrl)[0];
    if (!item) throw new Error(`work item ${id} not found`);
    return { item, comments: parseComments(xml) };
  }

  /** Structured search across the configured project areas. */
  async search(s: JazzSearch): Promise<JazzWorkItem[]> {
    const max = Math.min(Math.max(s.max ?? 50, 1), 500);
    const text = (s.text ?? "").trim();
    if (/^\d+(\s*,\s*\d+)*$/.test(text)) {
      const ids = text.split(",").map((x) => Number(x.trim()));
      return parseWorkItems(await this.rptXml(`[${ids.map((i) => `id=${i}`).join(" or ")}]`, LIST_FIELDS, ids.length), this.cfg.serverUrl);
    }
    const areas = s.projectAreas?.length ? s.projectAreas : this.cfg.projectAreas;
    const me = s.owner === "me" ? await this.whoAmI() : null;
    // The reportable API has no full-text operator: with words, fetch a larger filtered set and match locally.
    const all = await this.list({ areas, state: s.state ?? "open", type: s.type, owner: s.owner, me, raw: s.raw?.trim() }, text ? 1000 : max);
    if (!text) return all.slice(0, max);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((w) => words.every((x) => `${w.id} ${w.title} ${w.description}`.toLowerCase().includes(x))).slice(0, max);
  }

  /**
   * Work item list with graceful degradation. EWM versions differ in which reportable fields and filter attributes
   * they accept (an unknown one gives HTTP 500), so the query is retried in simpler shapes and the remaining
   * conditions are applied locally. The first shape that works is remembered for this server.
   */
  private async list(q: { areas: string[]; state: "open" | "closed" | "all"; type?: string; owner?: "me" | "unassigned" | ""; me: string | null; raw?: string },
    size: number): Promise<JazzWorkItem[]> {
    const areaCond = q.areas.length ? `(${q.areas.map((a) => `projectArea/name='${esc(a)}'`).join(" or ")})` : "";
    const serverConds = [
      areaCond,
      q.state !== "all" ? `state/group='${q.state}'` : "",
      q.type ? `type/name='${esc(q.type)}'` : "",
      q.owner === "me" && q.me ? `owner/userId='${esc(q.me)}'` : q.owner === "unassigned" ? "owner/userId='unassigned'" : "",
      q.raw ? `(${q.raw})` : "",
    ].filter(Boolean);
    const shapes: { level: QueryLevel; filter: string; fields: string; size: number; local: boolean }[] = [
      { level: 0, filter: serverConds.length ? `[${serverConds.join(" and ")}]` : "", fields: LIST_FIELDS, size, local: false },
      { level: 1, filter: serverConds.length ? `[${serverConds.join(" and ")}]` : "", fields: BASIC_FIELDS, size, local: false },
      { level: 2, filter: [areaCond, q.raw ? `(${q.raw})` : ""].filter(Boolean).length ? `[${[areaCond, q.raw ? `(${q.raw})` : ""].filter(Boolean).join(" and ")}]` : "", fields: BASIC_FIELDS, size: Math.min(Math.max(size * 4, 200), 1000), local: true },
      { level: 3, filter: areaCond ? `[${areaCond}]` : "", fields: BASIC_FIELDS, size: Math.min(Math.max(size * 4, 200), 1000), local: true },
    ];
    let first: JazzQueryError | null = null;
    for (const sh of shapes.filter((x) => x.level >= this.level)) {
      try {
        let items = parseWorkItems(await this.rptXml(sh.filter, sh.fields, sh.size), this.cfg.serverUrl);
        this.level = sh.level;
        if (sh.local) {
          items = items.filter((w) =>
            (q.state === "all" || (q.state === "closed") === CLOSED_STATE.test(w.state)) &&
            (!q.type || w.type.toLowerCase() === q.type.toLowerCase()) &&
            (q.owner !== "unassigned" || !w.owner || /unassigned/i.test(w.owner)) &&
            (q.owner !== "me" || !q.me || (!!w.owner && (w.owner.toLowerCase() === q.me.toLowerCase() || q.me.toLowerCase().endsWith(w.owner.toLowerCase().replace(/\s+/g, "")))))
          );
        }
        return items;
      } catch (e) {
        if (!(e instanceof JazzQueryError) || e.status === 401 || e.status === 403) throw e;
        first ??= e;
      }
    }
    throw first ?? new Error("Jazz query failed");
  }

  /** Back-compat entry used by agents: ids, a raw filter (contains = < >) or words. */
  async query(q: string, max = 50, projectArea?: string): Promise<JazzWorkItem[]> {
    const t = q.trim();
    const areas = projectArea ? [projectArea] : undefined;
    if (/[=<>]/.test(t) && !/^\d/.test(t)) return this.search({ raw: t, state: "all", projectAreas: areas, max });
    return this.search({ text: t, state: /^\d+(\s*,\s*\d+)*$/.test(t) ? "all" : "open", projectAreas: areas, max });
  }

  /** Partial update via OSLC. `attributes` uses OSLC property names, e.g. {"dcterms:title": "..."}; `action` = workflow action id. */
  async update(id: string, attributes: Record<string, unknown>, action?: string): Promise<JazzWorkItem> {
    const path = `/resource/itemName/com.ibm.team.workitem.WorkItem/${Number(id)}`;
    const cur = await this.send("GET", path, undefined, { Accept: "application/json" });
    if (!cur.ok) throw new Error(`cannot read work item ${id}: HTTP ${cur.status}`);
    const etag = cur.headers.get("etag") ?? "";
    const props = Object.keys(attributes).join(",");
    const qs = [props ? `oslc.properties=${encodeURIComponent(props)}` : "", action ? `_action=${encodeURIComponent(action)}` : ""].filter(Boolean).join("&");
    const r = await this.send("PUT", `${path}${qs ? "?" + qs : ""}`, JSON.stringify(attributes), {
      Accept: "application/json", "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}),
    });
    if (!r.ok) throw new Error(`update failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return this.get(id);
  }

  async comment(id: string, text: string): Promise<void> {
    const r = await this.send("POST", `/oslc/workitems/${Number(id)}/rtc_cm:comments`, JSON.stringify({ "dcterms:description": text }), {
      Accept: "application/json", "Content-Type": "application/json",
    });
    if (!r.ok) throw new Error(`comment failed: HTTP ${r.status}`);
  }

  /** Authenticated GET returning the body (used by the DOORS Next client on the /rm context root). */
  async getText(path: string, accept: string, oslc = false): Promise<string> {
    const r = await this.send("GET", path, undefined, { Accept: accept, "OSLC-Core-Version": oslc ? "2.0" : "none" });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path.split("?")[0]}`);
    return r.text();
  }

  // ---------------------------------------------------------------- internals

  private async rptXml(filter: string, fields: string, size: number): Promise<string> {
    const r = await this.send("GET", `/rpt/repository/workitem?size=${size}&fields=${encodeURIComponent(`workitem/workItem${filter}/${fields}`)}`,
      undefined, { Accept: "text/xml" });
    if (!r.ok) throw new JazzQueryError(r.status, serverMessage(await r.text().catch(() => "")));
    return r.text();
  }

  /** Authenticated request with 401 recovery driven by WWW-Authenticate. */
  private async send(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
    await this.login();
    let r = await this.req(method, path, body, headers);
    if (!needsAuth(r)) return r;
    const scheme = r.headers.get("www-authenticate") ?? "";
    if (this.cfg.authType === "form") {
      this.authed = false; // expired session → log in again once, skipping the "already signed in" shortcut
      await this.login(true);
      r = await this.req(method, path, body, headers);
      if (!needsAuth(r)) return r;
    }
    if (this.cfg.authType === "browser") throw new JazzSignInRequired();
    if (/basic/i.test(scheme) && this.cfg.authType !== "basic" && !this.basicFallback && this.cfg.username && this.cfg.password) {
      this.basicFallback = true; // server explicitly asks for Basic
      r = await this.req(method, path, body, headers);
      if (!needsAuth(r)) return r;
      this.basicFallback = false;
    }
    throw new Error(explain401(r.status, scheme, this.cfg.authType));
  }

  /**
   * EWM form-based login, redirect-following:
   *   GET  /authenticated/identity  → already signed in (200, no auth header) or "authrequired"
   *   POST /j_security_check        → "authfailed" header on the final response when credentials are wrong
   *   GET  /authenticated/identity  → must no longer say "authrequired"
   */
  private async login(force = false): Promise<void> {
    if (this.authed || this.cfg.authType !== "form") return;
    const first = await this.req("GET", "/authenticated/identity");
    if (!force && first.ok && first.headers.get(AUTH_MSG) !== "authrequired" && !isLoginPage(first)) { this.authed = true; return; }
    if (first.status === 401 && !/jazzformauth|form/i.test(first.headers.get("www-authenticate") ?? "form")) {
      throw new Error(explain401(401, first.headers.get("www-authenticate") ?? "", "form"));
    }
    if (!this.cfg.password) throw new Error("Jazz password not set (Settings → Integrations → IBM Jazz)");
    const form = `j_username=${encodeURIComponent(this.cfg.username)}&j_password=${encodeURIComponent(this.cfg.password)}`;
    const r = await this.req("POST", "/j_security_check", form, { "Content-Type": "application/x-www-form-urlencoded" });
    if (r.headers.get(AUTH_MSG) === "authfailed" || /authfailed/i.test(r.url ?? "")) throw new Error("Jazz login failed — check user/password");
    const check = await this.req("GET", "/authenticated/identity");
    if (check.headers.get(AUTH_MSG) === "authrequired" || isLoginPage(check) || check.status === 401) {
      const host = hostOf(check.url);
      throw new Error(host && host !== hostOf(this.cfg.serverUrl)
        ? `Jazz redirected the login to ${host} (OIDC / Jazz Authorization Server). Form login is not possible there — set Authentication to "Browser sign-in (SSO)" and click “Sign in to Jazz”.`
        : check.status === 401 ? explain401(401, check.headers.get("www-authenticate") ?? "", "form") : "Jazz login did not complete — check user/password and the server URL (…/ccm)");
    }
    this.authed = true;
  }

  private async req(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { "OSLC-Core-Version": "2.0", "X-Requested-With": "XMLHttpRequest", ...headers };
    if (h["OSLC-Core-Version"] === "none") delete h["OSLC-Core-Version"];
    if (this.cfg.authType === "basic" || this.basicFallback) h.Authorization = "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");
    if (this.cookies.size && this.cfg.authType !== "browser") h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await this.fetchImpl(this.cfg.serverUrl + path, { method, headers: h, body });
    if (this.authed && r.headers.get(AUTH_MSG) === "authrequired") this.authed = false;
    const set = r.headers.getSetCookie?.() ?? (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")!] : []);
    for (const c of set) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) this.cookies.set(m[1]!.trim(), m[2]!);
    }
    return r;
  }
}

/** Browser sign-in (SSO / Jazz Authorization Server) has expired or never happened. */
export class JazzSignInRequired extends Error {
  readonly code = "JAZZ_SIGNIN";
  constructor() { super("Jazz sign-in needed — click “Sign in to Jazz” (Jazz page or Settings → Integrations → IBM Jazz)."); }
}

const needsAuth = (r: { status: number; headers: { get(n: string): string | null } }) => r.status === 401 || r.headers.get(AUTH_MSG) === "authrequired";

/** Turn a 401 into an actionable message based on what the server asked for. */
export function explain401(status: number, scheme: string, authType: string): string {
  const s = scheme.toLowerCase();
  const asked = scheme ? ` (server asked for: ${scheme.split(/[\s,]/)[0]})` : "";
  if (/negotiate|ntlm|kerberos/.test(s)) {
    return authType === "windows"
      ? `HTTP ${status}: Windows sign-in was rejected${asked}. Try Authentication "Browser sign-in (SSO)". Make sure you are logged in to the company domain and that the Jazz server allows Kerberos/NTLM for this PC; restart TheFlashMaster after changing the server URL.`
      : `HTTP ${status}: the Jazz server uses Windows sign-in${asked}. Set Authentication to "Windows (integrated)" in Settings → Integrations → IBM Jazz and restart TheFlashMaster.`;
  }
  if (/jauth|bearer|oauth/.test(s)) return `HTTP ${status}: the server signs in through the Jazz Authorization Server (single sign-on)${asked}. Set Authentication to "Browser sign-in (SSO)" in Settings → Integrations → IBM Jazz and click “Sign in to Jazz”.`;
  if (/basic/.test(s)) return `HTTP ${status}: user or password rejected${asked}. Check them in Settings → Integrations → IBM Jazz (Authentication: Basic).`;
  if (authType === "form") return `HTTP ${status}: Jazz rejected the session after login. Check user/password; if your company uses single sign-on, try Authentication "Windows (integrated)".`;
  return `HTTP ${status}: not authorised${asked}. Check the authentication settings and your access to the project area.`;
}

/** The useful line of a Jazz error page / XML (exception message), short. */
export function serverMessage(body: string): string {
  const m = /<(?:\w+:)?(?:message|errorMessage|detail)[^>]*>([\s\S]*?)<\/(?:\w+:)?(?:message|errorMessage|detail)>/i.exec(body)?.[1]
    ?? /"(?:errorMessage|message)"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? body;
  return decode(m.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 240);
}

const esc = (s: string) => s.replace(/'/g, "''");
const hostOf = (u: string | undefined) => { try { return u ? new URL(u).host : ""; } catch { return ""; } };
const isLoginPage = (r: { url?: string }) => /\/(auth\/authrequired|secure\/authenticated\/login|jts\/auth|oidc\/endpoint)/i.test(r.url ?? "");

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, path: string[]): string => {
  let cur = xml;
  for (const t of path) {
    const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`).exec(cur);
    if (!m) return "";
    cur = m[1]!;
  }
  return decode(cur.trim());
};
const html2text = (s: string) => s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s+/g, "\n").trim();

export function parseWorkItems(xml: string, serverUrl: string): JazzWorkItem[] {
  const out: JazzWorkItem[] = [];
  const re = /<workItem(?:\s[^>]*)?>([\s\S]*?)<\/workItem>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const x = m[1]!.replace(/<comments(?:\s[^>]*)?>[\s\S]*?<\/comments>/g, "");
    const id = tag(x, ["id"]);
    const opt = (v: string) => v || undefined;
    out.push({
      id,
      title: tag(x, ["summary"]),
      description: html2text(tag(x, ["description"])),
      state: tag(x, ["state", "name"]),
      type: tag(x, ["type", "name"]),
      owner: tag(x, ["owner", "name"]) || null,
      url: id ? `${serverUrl}/resource/itemName/com.ibm.team.workitem.WorkItem/${id}` : null,
      projectArea: opt(tag(x, ["projectArea", "name"])),
      priority: opt(tag(x, ["priority", "name"])),
      severity: opt(tag(x, ["severity", "name"])),
      category: opt(tag(x, ["category", "name"])),
      plannedFor: opt(tag(x, ["target", "name"])),
      creator: opt(tag(x, ["creator", "name"])),
      created: opt(tag(x, ["creationDate"])),
      modified: opt(tag(x, ["modified"])),
      tags: opt(tag(x, ["tags"])),
    });
  }
  return out;
}

export function parseComments(xml: string): JazzComment[] {
  return [...xml.matchAll(/<comments(?:\s[^>]*)?>([\s\S]*?)<\/comments>/g)].map((m) => ({
    author: tag(m[1]!, ["creator", "name"]),
    date: tag(m[1]!, ["creationDate"]),
    text: html2text(tag(m[1]!, ["content"])),
  })).filter((c) => c.text);
}
