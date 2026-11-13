/**
 * DOORS Next / GCM configurations: turn whatever the user pasted into the configuration URI the APIs expect.
 *  - https://alm/gc/configuration/51068                                     → as is
 *  - https://alm/gc/web/projects/X%20(GC)#action=gc.viewConfiguration&path=https%3A%2F%2Falm%2Fgc%2Fconfiguration%2F51068
 *                                                                           → https://alm/gc/configuration/51068
 *  - https://alm/rm/web#…&oslc_config.context=https%3A%2F%2Falm%2Frm%2Fcm%2Fstream%2F_abc → …/rm/cm/stream/_abc
 * Anything else is returned trimmed.
 */
const CONFIG_RE = /\/(?:gc\/configuration|cm\/(?:stream|baseline|changeset))\/[^/?#\s]+/i;

export function configUri(input: string): string {
  let v = (input ?? "").trim();
  if (!v) return "";
  // Pasted URL-encoded (https%3A%2F%2F…): decode first.
  if (/^https?%3A/i.test(v)) { try { v = decodeURIComponent(v); } catch { /* keep as is */ } }
  let u: URL;
  try { u = new URL(v); } catch { return v; }
  const params = new URLSearchParams([u.search.slice(1), u.hash.replace(/^#/, "")].filter(Boolean).join("&"));
  for (const k of ["oslc_config.context", "vvc.configuration", "configURI", "configuration", "path"]) {
    const c = params.get(k);
    if (c && CONFIG_RE.test(c)) { try { const cu = new URL(c); return `${cu.origin}${cu.pathname}`.replace(/\/+$/, ""); } catch { /* not absolute */ } }
  }
  if (CONFIG_RE.test(u.pathname)) return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  return v;
}

/** True when the link is a GCM web page (…/gc/web/…), i.e. it names a configuration, not the requirements server. */
export const isGcWebLink = (input: string) => /\/gc\/(web|configuration)\b/i.test(input);
