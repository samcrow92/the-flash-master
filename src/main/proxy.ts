/**
 * Proxy handling for Electron's (Chromium's) network stack.
 *
 * Chromium only understands `host:port`, `socks4://`, `socks5://`, `https://` proxies or a PAC script. Values copied
 * from environment variables often aren't in that form (`http://user:pass@proxy:8080/`, `socks5h://…`, a PAC URL,
 * several entries) and then every request fails with `net::ERR_NO_SUPPORTED_PROXIES`. The same error appears when a
 * Windows system PAC returns only entries Chromium can't use. This module normalises the value and decides the
 * fallback order used when a request still fails that way.
 */

export type ProxyMode = "fixed_servers" | "system" | "direct" | "pac_script" | "auto_detect";
export interface ProxyCfg { mode: ProxyMode; proxyRules?: string; proxyBypassRules?: string; pacScript?: string }
export interface ParsedProxy {
  config: ProxyCfg;
  /** Credentials found in the value (`http://user:pass@host`): Chromium can't take them in the rules; answered on the proxy's login challenge instead. */
  credentials?: { username: string; password: string };
  /** For logs and the UI: the value without the password. */
  display: string;
  warnings: string[];
}

const SCHEME_MAP: Record<string, string> = {
  http: "", https: "", // HTTPS in env vars almost always means "the proxy for https traffic", which is a plain HTTP proxy
  socks: "socks5://", socks5: "socks5://", socks5h: "socks5://", socks4: "socks4://", socks4a: "socks4://",
};

/** Hide the password in `scheme://user:pass@host`. */
export const redact = (v: string) => v.replace(/\/\/([^:@/]*):[^@/]*@/g, "//$1:***@");

function isPac(v: string): boolean {
  return /^(pac\+)?(https?|file):\/\/.*(\.pac|\.dat|wpad[^/]*)(\?.*)?$/i.test(v) || /^pac\+/i.test(v);
}

/** One proxy entry → Chromium rule (`host:port`, `socks5://host:port`), or "" when it can't be used. */
function entry(raw: string, out: ParsedProxy): string {
  let v = raw.trim();
  if (!v) return "";
  if (/^direct$/i.test(v)) return "direct://";
  let prefix = "";
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (!(scheme in SCHEME_MAP)) { out.warnings.push(`unsupported proxy type "${scheme}://" ignored`); return ""; }
    prefix = SCHEME_MAP[scheme]!;
    if (scheme === "socks5h" || scheme === "socks4a") out.warnings.push(`${scheme}:// treated as ${prefix.slice(0, -3)}://`);
    v = v.slice(m[0].length);
  }
  // user:pass@host
  const at = v.lastIndexOf("@");
  if (at >= 0) {
    const cred = v.slice(0, at);
    v = v.slice(at + 1);
    if (!out.credentials) {
      const i = cred.indexOf(":");
      const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
      out.credentials = { username: dec(i >= 0 ? cred.slice(0, i) : cred), password: dec(i >= 0 ? cred.slice(i + 1) : "") };
    }
  }
  v = v.replace(/[/?#].*$/, ""); // path, query, trailing slash
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9_.-]+)(:\d{1,5})?$/i.test(v)) { out.warnings.push(`"${redact(raw.trim())}" is not a proxy address`); return ""; }
  return prefix + v;
}

/**
 * Parse a proxy setting / environment value. Accepts
 *  - `proxy:8080`, `http://proxy:8080/`, `http://user:pass@proxy:8080`
 *  - `socks5://…`, `socks5h://…`, `socks4://…`
 *  - a PAC/WPAD URL (`http://wpad/wpad.dat`, `…/proxy.pac`, `pac+https://…`) or `pac:<url>`
 *  - Chromium rule syntax (`http=a:1;https=b:2`) and several entries separated by commas/semicolons/spaces (tried in order)
 * Returns null for an empty value.
 */
export function parseProxy(value: string, bypass = ""): ParsedProxy | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  const out: ParsedProxy = { config: { mode: "fixed_servers" }, display: redact(v), warnings: [] };
  const pac = /^pac:/i.test(v) ? v.slice(4).trim() : isPac(v) ? v.replace(/^pac\+/i, "") : "";
  if (pac) { out.config = { mode: "pac_script", pacScript: pac }; return out; }
  // Chromium per-scheme syntax: normalise each value but keep the scheme= keys.
  if (/(^|;)\s*(http|https|ftp|socks)=/i.test(v)) {
    const parts = v.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return entry(p, out);
      const rule = p.slice(eq + 1).split(",").map((x) => entry(x, out)).filter(Boolean).join(",");
      return rule ? `${p.slice(0, eq).trim().toLowerCase()}=${rule}` : "";
    }).filter(Boolean);
    if (!parts.length) return { ...out, config: { mode: "system" }, warnings: [...out.warnings, "no usable proxy in the value; using the system proxy"] };
    out.config = { mode: "fixed_servers", proxyRules: parts.join(";"), proxyBypassRules: bypass };
    return out;
  }
  const rules = v.split(/[,;\s]+/).map((x) => entry(x, out)).filter(Boolean);
  if (!rules.length) return { ...out, config: { mode: "system" }, warnings: [...out.warnings, "no usable proxy in the value; using the system proxy"] };
  out.config = { mode: "fixed_servers", proxyRules: [...new Set(rules)].join(","), proxyBypassRules: bypass };
  return out;
}

/** Errors where the proxy setup itself (not the server) is the problem, and another proxy mode may work. */
export function isProxySetupError(e: unknown): boolean {
  const s = String((e as { message?: string })?.message ?? e);
  return /ERR_NO_SUPPORTED_PROXIES|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_PAC_SCRIPT_FAILED|ERR_PAC_NOT_IN_DHCP/i.test(s);
}

/** Modes to try, in order, after `primary` failed with a proxy setup error. */
export function fallbacks(primary: ProxyCfg): ProxyCfg[] {
  const bypass = primary.proxyBypassRules;
  const direct: ProxyCfg = { mode: "direct" };
  if (primary.mode === "system") return [{ mode: "auto_detect", proxyBypassRules: bypass }, direct];
  if (primary.mode === "direct") return [];
  return [{ mode: "system" }, direct];
}

export const describe = (c: ProxyCfg): string =>
  c.mode === "fixed_servers" ? `proxy ${redact(c.proxyRules ?? "")}` : c.mode === "pac_script" ? `PAC ${c.pacScript}` : c.mode === "system" ? "Windows system proxy" : c.mode === "auto_detect" ? "auto-detect (WPAD)" : "direct (no proxy)";

/** Explain a Chromium proxy error in plain words. */
export function explainProxyError(e: unknown, resolved?: string): string {
  const s = String((e as { message?: string })?.message ?? e);
  if (/ERR_NO_SUPPORTED_PROXIES/i.test(s))
    return `The proxy configuration gives no proxy the app can use${resolved ? ` (resolved to "${resolved}")` : ""}. Set Settings → Network → HTTP(S) proxy to host:port (e.g. proxy.company.com:8080), or ask IT for the PAC file URL and enter it there.`;
  if (/ERR_PROXY_CONNECTION_FAILED/i.test(s)) return `The proxy${resolved ? ` (${resolved})` : ""} can't be reached. Check Settings → Network → HTTP(S) proxy.`;
  if (/PAC/i.test(s)) return "The proxy auto-configuration (PAC) script couldn't be loaded. Enter the proxy directly in Settings → Network.";
  return s;
}

/**
 * The proxy as a URL for command-line tools (Copilot/Node, npm, pip): `http://[user:pass@]host:port`.
 * "" when the value is a PAC file or unusable — those tools can't use PAC, so they fall back to their environment.
 */
export function cliProxyUrl(value: string): string {
  const p = parseProxy(value);
  if (!p || p.config.mode !== "fixed_servers" || !p.config.proxyRules) return "";
  const first = p.config.proxyRules.split(";").pop()!.replace(/^[a-z]+=/i, "").split(",")[0]!;
  if (!first || first === "direct://") return "";
  const url = /^socks/i.test(first) ? first : `http://${first}`;
  if (!p.credentials) return url;
  const enc = encodeURIComponent;
  return url.replace("://", `://${enc(p.credentials.username)}${p.credentials.password ? `:${enc(p.credentials.password)}` : ""}@`);
}
