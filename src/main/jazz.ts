/**
 * IBM Engineering Workflow Management (Jazz / RTC) client.
 *  - read:   Reportable REST API  /rpt/repository/workitem  (XML, simple and stable across EWM versions)
 *  - write:  OSLC CM v2           /resource/itemName/com.ibm.team.workitem.WorkItem/<id>  (+ comments)
 *  - auth:   form-based (j_security_check, the EWM default) or HTTP basic.
 * `fetchImpl` is injected: Electron's net.fetch in the app (system proxy + Windows certificate store), a fake in tests.
 */
import type { JazzWorkItem } from "@shared/types";

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual" | "follow" }) =>
  Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null; getSetCookie?: () => string[] }; text(): Promise<string> }>;

export interface JazzConfig {
  serverUrl: string;
  projectArea: string;
  authType: "form" | "basic";
  username: string;
  password: string;
}

const FIELDS = "(id|summary|description|state/name|type/name|owner/name|itemId)";

export class JazzClient {
  private cookies = new Map<string, string>();
  private authed = false;

  constructor(private cfg: JazzConfig, private fetchImpl: FetchLike) {
    this.cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, "");
  }

  async test(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.login();
      const r = await this.req("GET", "/rpt/repository/workitem?size=1&fields=workitem/workItem/(id)");
      return { ok: r.ok, detail: r.ok ? "Connected" : `HTTP ${r.status}` };
    } catch (e: any) {
      return { ok: false, detail: String(e?.message ?? e) };
    }
  }

  async get(id: string): Promise<JazzWorkItem> {
    const items = await this.rpt(`[id=${Number(id)}]`);
    if (!items[0]) throw new Error(`work item ${id} not found`);
    return items[0];
  }

  /**
   * query forms:
   *   "123, 456"                          → by ids
   *   "state/group='open' and owner/userId='me'"  → raw reportable-API filter (scoped to the project area if set)
   *   "brake light"                       → text match on summary within open items of the project area
   */
  async query(q: string, max = 50): Promise<JazzWorkItem[]> {
    const t = q.trim();
    if (/^\d+(\s*,\s*\d+)*$/.test(t)) {
      const ids = t.split(",").map((s) => Number(s.trim()));
      return (await Promise.all(ids.map((i) => this.get(String(i)).catch(() => null)))).filter((x): x is JazzWorkItem => !!x);
    }
    const scope = this.cfg.projectArea ? `projectArea/name='${esc(this.cfg.projectArea)}'` : "";
    if (/[=<>]/.test(t)) return this.rpt(`[${[scope, t].filter(Boolean).join(" and ")}]`, max);
    const open = await this.rpt(`[${[scope, "state/group='open'"].filter(Boolean).join(" and ")}]`, 500);
    const words = t.toLowerCase().split(/\s+/).filter(Boolean);
    return open.filter((w) => words.every((x) => `${w.title} ${w.description}`.toLowerCase().includes(x))).slice(0, max);
  }

  /** Partial update via OSLC. `attributes` uses OSLC property names, e.g. {"dcterms:title": "...", "rtc_cm:due": "..."}. */
  async update(id: string, attributes: Record<string, unknown>, action?: string): Promise<JazzWorkItem> {
    await this.login();
    const path = `/resource/itemName/com.ibm.team.workitem.WorkItem/${Number(id)}`;
    const cur = await this.req("GET", path, undefined, { Accept: "application/json" });
    if (!cur.ok) throw new Error(`cannot read work item ${id}: HTTP ${cur.status}`);
    const etag = cur.headers.get("etag") ?? "";
    const props = Object.keys(attributes).join(",");
    const qs = [props ? `oslc.properties=${encodeURIComponent(props)}` : "", action ? `_action=${encodeURIComponent(action)}` : ""].filter(Boolean).join("&");
    const r = await this.req("PUT", `${path}${qs ? "?" + qs : ""}`, JSON.stringify(attributes), {
      Accept: "application/json", "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}),
    });
    if (!r.ok) throw new Error(`update failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return this.get(id);
  }

  async comment(id: string, text: string): Promise<void> {
    await this.login();
    const r = await this.req("POST", `/oslc/workitems/${Number(id)}/rtc_cm:comments`, JSON.stringify({ "dcterms:description": text }), {
      Accept: "application/json", "Content-Type": "application/json",
    });
    if (!r.ok) throw new Error(`comment failed: HTTP ${r.status}`);
  }

  // ---------------------------------------------------------------- internals

  private async rpt(filter: string, size = 50): Promise<JazzWorkItem[]> {
    await this.login();
    const r = await this.req("GET", `/rpt/repository/workitem?size=${size}&fields=${encodeURIComponent(`workitem/workItem${filter}/${FIELDS}`)}`,
      undefined, { Accept: "text/xml" });
    if (!r.ok) throw new Error(`Jazz query failed: HTTP ${r.status}`);
    return parseWorkItems(await r.text(), this.cfg.serverUrl);
  }

  private async login(): Promise<void> {
    if (this.authed || this.cfg.authType === "basic") return;
    await this.req("GET", "/authenticated/identity", undefined, {}, "manual");
    const body = `j_username=${encodeURIComponent(this.cfg.username)}&j_password=${encodeURIComponent(this.cfg.password)}`;
    const r = await this.req("POST", "/j_security_check", body, { "Content-Type": "application/x-www-form-urlencoded" }, "manual");
    const loc = r.headers.get("location") ?? "";
    if (r.headers.get("x-com-ibm-team-repository-web-auth-msg") === "authfailed" || /authfailed/.test(loc)) throw new Error("Jazz login failed — check user/password");
    this.authed = true;
  }

  private async req(method: string, path: string, body?: string, headers: Record<string, string> = {}, redirect: "manual" | "follow" = "follow") {
    const h: Record<string, string> = { "OSLC-Core-Version": "2.0", "X-Requested-With": "XMLHttpRequest", ...headers };
    if (this.cfg.authType === "basic") h.Authorization = "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64");
    if (this.cookies.size) h.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await this.fetchImpl(this.cfg.serverUrl + path, { method, headers: h, body, redirect });
    const set = r.headers.getSetCookie?.() ?? (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")!] : []);
    for (const c of set) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) this.cookies.set(m[1]!.trim(), m[2]!);
    }
    return r;
  }
}

const esc = (s: string) => s.replace(/'/g, "''");

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, path: string[]): string => {
  let cur = xml;
  for (const t of path) {
    const m = new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`).exec(cur);
    if (!m) return "";
    cur = m[1]!;
  }
  return decode(cur.trim());
};

export function parseWorkItems(xml: string, serverUrl: string): JazzWorkItem[] {
  const out: JazzWorkItem[] = [];
  const re = /<workItem(?:\s[^>]*)?>([\s\S]*?)<\/workItem>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const x = m[1]!;
    const id = tag(x, ["id"]);
    out.push({
      id,
      title: tag(x, ["summary"]),
      description: tag(x, ["description"]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      state: tag(x, ["state", "name"]),
      type: tag(x, ["type", "name"]),
      owner: tag(x, ["owner", "name"]) || null,
      url: id ? `${serverUrl}/resource/itemName/com.ibm.team.workitem.WorkItem/${id}` : null,
    });
  }
  return out;
}
