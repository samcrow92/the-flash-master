/**
 * Proxy sign-in → Windows user environment (Documentation → Proxy setup).
 *
 * Writes HTTP_PROXY and HTTPS_PROXY = http://user:pass@host:port to the user's environment (HKCU\Environment) with
 * [Environment]::SetEnvironmentVariable(…, 'User'), which also broadcasts WM_SETTINGCHANGE so newly started programs
 * see the change. Windows variable names are case-insensitive, so http_proxy / https_proxy are the same entries.
 *
 * The credentials never appear on a command line or in a log: the value reaches PowerShell through the child's own
 * environment, and every message passes through redact().
 */
import { redact } from "./proxy";
import { normaliseProxyAddress, validateProxyInput, type ProxyEnvErrors, type ProxyEnvInput } from "@shared/proxy-input";

export { normaliseProxyAddress, validateProxyInput, type ProxyEnvErrors, type ProxyEnvInput };

export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY"] as const;

/** `http://user:pass@host:port`, with special characters in the user name and password percent-encoded. */
export function buildProxyUrl(i: ProxyEnvInput): string {
  const host = normaliseProxyAddress(i.address);
  if (!host) throw new Error("Invalid proxy address");
  // encodeURIComponent leaves !'()* alone; encode them too so every proxy client reads the value the same way.
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `http://${enc(i.username.trim())}:${enc(i.password)}@${host}`;
}

/** What the environment holds now, without the password (prefills the form). */
export function currentProxyEnv(env: NodeJS.ProcessEnv = process.env): { address: string; username: string; set: boolean } {
  const v = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || "";
  if (!v) return { address: "", username: "", set: false };
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:([^:@/]*)(?::[^@/]*)?@)?([^/]+)/i.exec(v.trim());
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  return { address: m?.[2] ?? "", username: m?.[1] ? dec(m[1]) : "", set: true };
}

export type RunPowerShell = (script: string, env: NodeJS.ProcessEnv) => Promise<void>;

const SET_SCRIPT =
  "$ErrorActionPreference='Stop'; $v=$env:FLASH_PROXY_VALUE; " +
  `foreach($n in ${PROXY_ENV_NAMES.map((n) => `'${n}'`).join(",")}){ [Environment]::SetEnvironmentVariable($n,$v,'User') }`;

const defaultRun: RunPowerShell = async (script, env) => {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { env, timeout: 30000, windowsHide: true, encoding: "utf8" },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve())));
};

/**
 * Validate, build the URL and write it to the Windows user environment, then update this process's environment so
 * the app and the agents it starts use it right away. Never throws; the result carries the message.
 */
export async function setProxyEnv(
  i: ProxyEnvInput,
  opts: { platform?: NodeJS.Platform; run?: RunPowerShell; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; detail: string; display: string; errors?: ProxyEnvErrors }> {
  const errors = validateProxyInput(i);
  if (Object.keys(errors).length) return { ok: false, detail: "Check the highlighted fields", display: "", errors };
  const url = buildProxyUrl(i);
  const display = redact(url);
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { ok: false, detail: "Setting Windows environment variables only works on Windows", display };
  const env = opts.env ?? process.env;
  try {
    await (opts.run ?? defaultRun)(SET_SCRIPT, { ...env, FLASH_PROXY_VALUE: url });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).split(url).join(display);
    return { ok: false, detail: `Couldn't set the environment variables: ${redact(msg)}`, display };
  }
  for (const n of PROXY_ENV_NAMES) env[n] = url;
  return { ok: true, detail: `Set ${PROXY_ENV_NAMES.join(" and ")} for your Windows user. Programs you start from now on use the proxy; restart open terminals and editors to pick it up.`, display };
}
