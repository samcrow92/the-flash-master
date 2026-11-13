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
  authType: "form" | "basic" | "windows";
  username: string;
  password: string;
}

const LIST_FIELDS = "(id|summary|description|state/name|type/name|owner/name|owner/userId|projectArea/name|priority/name|severity/name|modified|itemId)";
const DETAIL_FIELDS = "(id|summary|description|state/name|type/name|owner/name|projectArea/name|priority/name|severity/name|category/name|target/name|creator/name|creationDate|modified|tags|comments/(content|creator/name|creationDate))";

export class JazzClient {
  private cookies = new Map<string, string>();
  private authed = false;
  private basicFallback = false;
  private me: string | null = null;

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
    if (this.cfg.authType !== "windows" && this.cfg.username) return (this.me = this.cfg.username);
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
    const xml = await this.rptXml(`[id=${Number(id)}]`, DETAIL_FIELDS, 1);
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
    const parts: string[] = [];
    if (areas.length) parts.push(`(${areas.map((a) => `projectArea/name='${esc(a)}'`).join(" or ")})`);
    if ((s.state ?? "open") !== "all") parts.push(`state/group='${s.state ?? "open"}'`);
    if (s.type) parts.push(`type/name='${esc(s.type)}'`);
    if (s.owner === "me") { const me = await this.whoAmI(); if (me) parts.push(`owner/userId='${esc(me)}'`); }
    if (s.owner === "unassigned") parts.push(`owner/userId='unassigned'`);
    if (s.raw?.trim()) parts.push(`(${s.raw.trim()})`);
    const filter = parts.length ? `[${parts.join(" and ")}]` : "";
    if (!text) return parseWorkItems(await this.rptXml(filter, LIST_FIELDS, max), this.cfg.serverUrl);
    // The reportable API has no full-text operator: fetch the filtered set and match words locally.
    const all = parseWorkItems(await this.rptXml(filter, LIST_FIELDS, 1000), this.cfg.serverUrl);
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((w) => words.every((x) => `${w.id} ${w.title} ${w.description}`.toLowerCase().includes(x))).slice(0, max);
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

  // ---------------------------------------------------------------- internals

  private async rptXml(filter: string, fields: string, size: number): Promise<string> {
    const r = await this.send("GET", `/rpt/repository/workitem?size=${size}&fields=${encodeURIComponent(`workitem/workItem${filter}/${fields}`)}`,
      undefined, { Accept: "text/xml" });
    if (!r.ok) throw new Error(`Jazz query failed: HTTP ${r.status}`);
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
        ? `Jazz redirected the login to ${host} (OIDC / Jazz Authorization Server). Form login is not possible there — try Authentication: Windows or Basic, or ask for an app password.`
        : check.status === 401 ? explain401(401, check.headers.get("www-authenticate") ?? "", "form") : "Jazz login did not complete — check user/password and the server URL (…/ccm)");
    }
    this.authed = true;
  }

  private async req(method: string, path: string, body?: string, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { "OSLC-Core-Version": "2.0", "X-Requested-With": "XMLHttpRequest", ...headers };
    if (this.cfg.authType === "basic" || this.basicFallback) h.Authorization = "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
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

const needsAuth = (r: { status: number; headers: { get(n: string): string | null } }) => r.status === 401 || r.headers.get(AUTH_MSG) === "authrequired";

/** Turn a 401 into an actionable message based on what the server asked for. */
export function explain401(status: number, scheme: string, authType: string): string {
  const s = scheme.toLowerCase();
  const asked = scheme ? ` (server asked for: ${scheme.split(/[\s,]/)[0]})` : "";
  if (/negotiate|ntlm|kerberos/.test(s)) {
    return authType === "windows"
      ? `HTTP ${status}: Windows sign-in was rejected${asked}. Make sure you are logged in to the company domain and that the Jazz server allows Kerberos/NTLM for this PC; restart TheFlashMaster after changing the server URL.`
      : `HTTP ${status}: the Jazz server uses Windows sign-in${asked}. Set Authentication to "Windows (integrated)" in Settings → Integrations → IBM Jazz and restart TheFlashMaster.`;
  }
  if (/jauth|bearer|oauth/.test(s)) return `HTTP ${status}: the server uses the Jazz Authorization Server / tokens${asked}. Try Authentication "Windows (integrated)", or "Basic" with an application password from your Jazz admin.`;
  if (/basic/.test(s)) return `HTTP ${status}: user or password rejected${asked}. Check them in Settings → Integrations → IBM Jazz (Authentication: Basic).`;
  if (authType === "form") return `HTTP ${status}: Jazz rejected the session after login. Check user/password; if your company uses single sign-on, try Authentication "Windows (integrated)".`;
  return `HTTP ${status}: not authorised${asked}. Check the authentication settings and your access to the project area.`;
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
