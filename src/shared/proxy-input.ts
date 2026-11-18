/** Proxy sign-in form (Documentation → Proxy setup): validation shared by the form and the main process. */
export interface ProxyEnvInput { address: string; username: string; password: string }
export type ProxyEnvErrors = Partial<Record<keyof ProxyEnvInput, string>>;

/** `proxy.company.com:3128`, `http://proxy:8080/` → `host:port`; null when it isn't a proxy address with a port. */
export function normaliseProxyAddress(raw: string): string | null {
  let v = (raw ?? "").trim();
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (m) {
    if (!/^https?$/i.test(m[1]!)) return null;
    v = v.slice(m[0].length);
  }
  v = v.replace(/\/+$/, "");
  const hp = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9_.-]*[a-z0-9])?):(\d{1,5})$/i.exec(v);
  if (!hp) return null;
  const port = Number(hp[3]);
  return port >= 1 && port <= 65535 ? `${hp[1]!.toLowerCase()}:${port}` : null;
}

/** Field-by-field problems; empty when everything is fine. */
export function validateProxyInput(i: ProxyEnvInput): ProxyEnvErrors {
  const e: ProxyEnvErrors = {};
  const a = (i.address ?? "").trim();
  if (!a) e.address = "Enter the proxy address";
  else if (a.includes("@")) e.address = "Enter only host:port here; the user name and password have their own fields";
  else if (!normaliseProxyAddress(a)) e.address = "Use host:port, for example proxy.company.com:3128";
  if (!(i.username ?? "").trim()) e.username = "Enter your user name";
  else if (/\s/.test(i.username.trim())) e.username = "The user name can't contain spaces";
  if (!i.password) e.password = "Enter your password";
  return e;
}
