/**
 * Flash server client (contract: flash-server/API.md): account check, submissions, and the status-change notices.
 *
 * Every request carries the server token as `Authorization: Bearer <token>`; the token is only ever sent to the
 * configured server URL. Errors are turned into one precise line ("HTTP 403 forbidden: …", "Cannot reach …").
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginPackage, ServerTestResult, Submission, SubmissionStatus } from "@shared/types";
import type { FetchLike } from "./jazz";

export interface ServerConfig { url: string; token: string }

/** "host:8787/" → "http://host:8787"; "" stays "". */
export function serverBase(url: string): string {
  const t = url.trim().replace(/\/+$/, "");
  if (!t) return "";
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

export const bearer = (token: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

export class FlashServerError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}

export class FlashServerClient {
  constructor(private d: { fetch: FetchLike; config: () => ServerConfig }) {}

  base(): string { return serverBase(this.d.config().url); }
  configured(): boolean { return !!this.base(); }

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const base = this.base();
    if (!base) throw new FlashServerError("No Flash server configured (Settings → Flash server)", 0, "not_configured");
    const headers: Record<string, string> = { Accept: "application/json", ...(auth ? bearer(this.d.config().token) : {}) };
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    let r: Awaited<ReturnType<FetchLike>>;
    try {
      r = await this.d.fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (e: any) {
      throw new FlashServerError(`Cannot reach ${base}: ${String(e?.message ?? e)}`, 0, "network");
    }
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      const code = String(json?.code ?? (r.status === 401 ? "unauthorized" : r.status === 403 ? "forbidden" : r.status === 404 ? "not_found" : "error"));
      const msg = json?.error ? String(json.error) : text.trim().slice(0, 200) || "no details";
      const hint = r.status === 401 ? (this.d.config().token ? " — the token was not accepted (ask the admin for a new one)" : " — set your token in Settings → Flash server") : "";
      throw new FlashServerError(`HTTP ${r.status} ${code}: ${msg}${hint}`, r.status, code);
    }
    if (json === null) throw new FlashServerError(`${path}: the server did not answer with JSON — is ${base} a Flash server?`, r.status, "invalid");
    return json as T;
  }

  health(): Promise<{ ok: boolean; name: string; version: string; publicRead: boolean }> { return this.call("GET", "/api/v1/health", undefined, false); }
  me(): Promise<{ id: number; name: string; role: "user" | "admin" }> { return this.call("GET", "/api/v1/me"); }

  /** Health (no auth) then /me (token): name/role, or the precise step that failed. */
  async test(): Promise<ServerTestResult> {
    const url = this.base();
    if (!url) return { ok: false, url, detail: "No server URL set" };
    let h: Awaited<ReturnType<FlashServerClient["health"]>>;
    try { h = await this.health(); } catch (e: any) { return { ok: false, url, detail: `Health check failed — ${String(e?.message ?? e)}` }; }
    const info = { url, serverName: String(h.name ?? ""), serverVersion: String(h.version ?? "") };
    if (!this.d.config().token) return { ok: false, ...info, detail: `Reached "${info.serverName || url}" ${info.serverVersion}, but no token is set` };
    try {
      const me = await this.me();
      return { ok: true, ...info, user: me, detail: `Signed in to "${info.serverName || url}" as ${me.name} (${me.role})` };
    } catch (e: any) {
      return { ok: false, ...info, detail: `Reached "${info.serverName || url}", but sign-in failed — ${String(e?.message ?? e)}` };
    }
  }

  submit(pkg: PluginPackage, notes: string): Promise<Submission> { return this.call("POST", "/api/v1/submissions", { package: pkg, notes }); }
  async submissions(): Promise<Submission[]> { return (await this.call<{ submissions?: Submission[] }>("GET", "/api/v1/submissions")).submissions ?? []; }
  withdraw(id: number): Promise<Submission> { return this.call("DELETE", `/api/v1/submissions/${encodeURIComponent(String(id))}`); }
}

const firstLine = (s: string | null | undefined) => (s ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";

/** The notice text for a submission whose status just changed (null = nothing worth telling). */
export function submissionNotice(s: Submission): { level: "info" | "warn"; text: string } | null {
  const what = `Your plugin ${s.name || s.pluginId} ${s.version}`;
  const fb = firstLine(s.feedback);
  if (s.status === "approved") return { level: "info", text: `${what} was approved` };
  if (s.status === "changes_requested") return { level: "warn", text: `${what} needs changes${fb ? `: ${fb}` : ""}` };
  if (s.status === "rejected") return { level: "warn", text: `${what} was rejected${fb ? `: ${fb}` : ""}` };
  return null;
}

/**
 * Remembers the last status seen per submission (persisted in dataDir) and reports changes since then.
 * The very first poll only records a baseline, so installing the app doesn't replay old reviews.
 */
export class SubmissionWatcher {
  constructor(private file: string) {}

  private read(): Record<string, SubmissionStatus> | null {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : null; } catch { return null; }
  }

  /** Statuses that changed since the last call (new reviewed submissions count as changed after the baseline). */
  update(list: Submission[]): { level: "info" | "warn"; text: string; submission: Submission }[] {
    const prev = this.read();
    const out: { level: "info" | "warn"; text: string; submission: Submission }[] = [];
    if (prev) {
      for (const s of list) {
        const was = prev[String(s.id)];
        if (was === s.status) continue;
        if (was === undefined && s.status === "pending") continue;
        const n = submissionNotice(s);
        if (n) out.push({ ...n, submission: s });
      }
    }
    const next: Record<string, SubmissionStatus> = { ...(prev ?? {}) };
    for (const s of list) next[String(s.id)] = s.status;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2));
    return out;
  }
}
