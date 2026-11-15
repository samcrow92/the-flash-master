/**
 * Available Copilot credits, read with the sign-in Copilot CLI already has (nothing for the user to paste).
 * The token is found the way Copilot CLI itself looks for it: COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, the token
 * saved in this app for Copilot, Copilot's entry in the system keychain (service "copilot-cli"), its plain-text
 * fallback in ~/.copilot/config.json, then GitHub CLI's login. With it, Copilot's own entitlement endpoint (the one
 * its editors use for their quota display) says how many credits the plan has and how many are left.
 */
import { join } from "node:path";

export type Exec = (cmd: string, args: string[]) => Promise<string>;
export type ReadText = (path: string) => Promise<string>;
export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export interface Quota {
  entitlement: number | null; // credits (or premium requests) per month; null = unlimited
  remaining: number | null;
  unlimited: boolean;
  overage: number; // used beyond the plan (pay as you go)
  unit: "credits" | "requests";
  resetAt: string | null;
  plan: string | null;
}

const TOKEN = /^(gh[oupsr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})$/;

/** Any GitHub token stored in Copilot's config.json (its plain-text fallback when no keychain is available). */
export function tokenFromConfig(json: string): string | null {
  let cfg: unknown;
  // config.json may hold comments (JSONC); drop whole-line ones.
  try { cfg = JSON.parse(json.replace(/^\s*\/\/.*$/gm, "")); } catch { return null; }
  const seen: string[] = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === "string") { if (TOKEN.test(v.trim()) && (/token|auth|cred/i.test(key) || seen.length === 0)) seen.push(v.trim()); }
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${key}.${k}`);
  };
  walk(cfg, "");
  return seen[0] ?? null;
}

// Windows: read the credential Copilot saved in Credential Manager (target starts with "copilot-cli").
const WIN_CRED = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class FmCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct C { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttrCount; public IntPtr Attrs; public string Alias; public string User; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredEnumerate(string filter, int flags, out int count, out IntPtr creds);
  public static string Get(string filter) {
    int n; IntPtr p; if (!CredEnumerate(filter, 0, out n, out p) || n == 0) return "";
    IntPtr first = Marshal.ReadIntPtr(p); C c = (C)Marshal.PtrToStructure(first, typeof(C));
    byte[] b = new byte[c.BlobSize]; Marshal.Copy(c.Blob, b, 0, c.BlobSize);
    string s = System.Text.Encoding.Unicode.GetString(b); if (!s.StartsWith("gh") && !s.StartsWith("github_pat_")) s = System.Text.Encoding.UTF8.GetString(b);
    return s;
  }
}
"@
[Console]::Out.Write([FmCred]::Get("copilot-cli*"))`;

/** Copilot's token from the system keychain; "" when there is none or access was refused. */
export async function tokenFromKeychain(exec: Exec, platform: string = process.platform): Promise<string> {
  const tries: [string, string[]][] = platform === "darwin" ? [["security", ["find-generic-password", "-s", "copilot-cli", "-w"]]]
    : platform === "win32" ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_CRED]]]
    : [["secret-tool", ["lookup", "service", "copilot-cli"]]];
  for (const [cmd, args] of tries) {
    try {
      const out = (await exec(cmd, args)).trim();
      if (TOKEN.test(out)) return out;
    } catch { /* not there */ }
  }
  return "";
}

/** The token Copilot CLI would use, in Copilot's own order. `from` says where it came from (for the details view). */
export async function findCopilotToken(o: { env: Record<string, string | undefined>; appToken: string; copilotDir: string; exec: Exec; readText: ReadText; platform?: string }):
  Promise<{ token: string; from: string } | null> {
  for (const k of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) if (o.env[k]?.trim()) return { token: o.env[k]!.trim(), from: k };
  if (o.appToken) return { token: o.appToken, from: "the token saved for Copilot in this app" };
  const kc = await tokenFromKeychain(o.exec, o.platform);
  if (kc) return { token: kc, from: "Copilot's sign-in (system keychain)" };
  const cfg = await o.readText(join(o.copilotDir, "config.json")).then(tokenFromConfig, () => null);
  if (cfg) return { token: cfg, from: "Copilot's sign-in (config.json)" };
  try {
    const gh = (await o.exec("gh", ["auth", "token"])).trim();
    if (TOKEN.test(gh)) return { token: gh, from: "GitHub CLI's sign-in" };
  } catch { /* no gh */ }
  return null;
}

/** Copilot's quota from its entitlement response; null when it has no credit / premium quota. */
export function parseQuota(body: any): Quota | null {
  const snaps = body?.quota_snapshots;
  if (!snaps || typeof snaps !== "object") return null;
  const key = ["ai_credits", "credits", "premium_interactions", "premium_requests"].find((k) => snaps[k])
    ?? Object.keys(snaps).find((k) => /credit|premium/i.test(k) || /credit|premium/i.test(String(snaps[k]?.quota_id ?? "")));
  const s = key ? snaps[key] : null;
  if (!s) return null;
  const unlimited = !!s.unlimited;
  const entitlement = unlimited ? null : Number(s.entitlement ?? NaN);
  const remaining = typeof s.remaining === "number" ? s.remaining
    : typeof s.percent_remaining === "number" && entitlement ? Math.round((s.percent_remaining / 100) * entitlement * 100) / 100 : null;
  return {
    entitlement: entitlement !== null && Number.isFinite(entitlement) ? entitlement : null, remaining, unlimited,
    overage: Number(s.overage_count ?? 0) || 0,
    unit: /credit/i.test(`${key} ${s.quota_id ?? ""}`) ? "credits" : "requests",
    resetAt: body.quota_reset_date ?? s.quota_reset_date ?? null,
    plan: body.copilot_plan ?? null,
  };
}

export class QuotaError extends Error {}

/** Asks Copilot how many credits are left. Throws QuotaError with a readable message. */
export async function fetchQuota(fetch: Fetch, token: string, api = "https://api.github.com"): Promise<Quota> {
  const r = await fetch(`${api.replace(/\/+$/, "")}/copilot_internal/user`, { headers: { Authorization: `token ${token}`, Accept: "application/json" } });
  if (r.status === 401) throw new QuotaError("Copilot's sign-in has expired. Sign in to Copilot again (run copilot, then /login).");
  if (!r.ok) throw new QuotaError(`Copilot did not share your credits (HTTP ${r.status}). This sign-in may not be a Copilot login; sign in to Copilot with /login.`);
  const q = parseQuota(await r.json());
  if (!q) throw new QuotaError("Copilot answered, but without a credit count for this account.");
  return q;
}
