/**
 * App updates from GitHub releases (github.com or GitHub Enterprise Server) or any web folder (internal mirror).
 *
 * The feed is set in the repository (package.json → "flashmaster": { "updates": { "url": … } }), so every build knows
 * where it comes from; a policy/setting can override it. Each release carries `latest.json` (written by
 * scripts/release-manifest.mjs) next to the installer and the portable exe:
 *   { "version": "0.5.0", "date": "…", "notes": "…", "files": [{ "kind": "setup"|"portable", "name": "…exe", "sha256": "…", "size": n }] }
 *
 * Access: public repos need nothing; private/internal repos use either the user's GitHub web session (sign in once in an
 * app window — company SSO works) or a read-only token (REST API, incl. GHES /api/v3). Downloads are verified (SHA-256).
 * Install: the NSIS installer runs silently and restarts the app; the portable exe replaces itself and restarts.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, copyFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "./marketplace";
import { bearer, serverBase } from "./flash-server";
import type { UpdateState } from "@shared/types";

export interface UpdateFile { kind: "setup" | "portable"; name: string; sha256: string; size: number; url?: string }
export interface UpdateManifest { version: string; date?: string; notes?: string; files: UpdateFile[]; baseUrl?: string }
export type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; url?: string; headers: { get(n: string): string | null };
  text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; body?: ReadableStream<Uint8Array> | null }>;

/**
 * url/token = the repository feed (GitHub or web folder) and its GitHub token.
 * server = the Flash server (flash-server/API.md), tried first when set; its token is a different credential.
 * The two tokens never cross: the server token only goes to server URLs, the GitHub token only to the repository feed.
 */
export interface Feed { url: string; channel: "stable" | "beta"; token: string; server?: { url: string; token: string } }

/** github.com / GitHub Enterprise repo URL → { web, api, owner, repo }; anything else is a plain web folder. */
export function parseFeed(url: string): { kind: "github"; web: string; api: string; owner: string; repo: string } | { kind: "folder"; base: string } | null {
  const u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  if (!u) return null;
  let p: URL;
  try { p = new URL(u); } catch { return null; }
  const parts = p.pathname.split("/").filter(Boolean);
  // github.com, GitHub Enterprise Server (github.company.com) and GitHub Enterprise Cloud with data residency (<name>.ghe.com).
  const ghe = /\.ghe\.com$/i.test(p.hostname);
  const looksGithub = (/github/i.test(p.hostname) || ghe) && parts.length >= 2 && !/\.json$/i.test(p.pathname);
  if (looksGithub) {
    const [owner, repo] = parts;
    const api = p.hostname === "github.com" || p.hostname === "www.github.com" ? "https://api.github.com"
      : ghe ? `https://api.${p.hostname.replace(/^api\./i, "")}` : `${p.origin}/api/v3`;
    return { kind: "github", web: `${p.origin}/${owner}/${repo}`, api, owner: owner!, repo: repo! };
  }
  return { kind: "folder", base: /\.json$/i.test(p.pathname) ? u.slice(0, u.lastIndexOf("/")) : u };
}

const isLoginPage = (r: { url?: string; headers: { get(n: string): string | null } }, body: string) =>
  /\/login|\/session|saml|sso/i.test(r.url ?? "") || (/text\/html/i.test(r.headers.get("content-type") ?? "") && /<form[^>]+(login|session)/i.test(body));

export class Updater {
  state: UpdateState;
  private manifest: UpdateManifest | null = null;
  private file: UpdateFile | null = null;
  private downloaded: string | null = null;
  /** Which feed the current manifest came from (decides which credential the download carries). */
  private source: "server" | "repository" = "repository";
  private sourceUrl = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private d: {
    fetch: Fetch; version: string; mode: "installer" | "portable" | "dev"; dataDir: string; feed: () => Feed;
    emit: (s: UpdateState) => void; log?: (m: string) => void;
    spawnDetached: (cmd: string, args: string[]) => void; quit: () => void; portablePath?: string;
  }) {
    const f = d.feed();
    this.state = { status: "idle", current: d.version, mode: d.mode, feed: serverBase(f.server?.url ?? "") || f.url };
    this.cleanupOldPortable();
  }

  private set(p: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...p, current: this.d.version, mode: this.d.mode, feed: this.sourceUrl || this.d.feed().url };
    this.d.emit(this.state);
    return this.state;
  }

  schedule(hours: number, autoDownload: () => boolean): void {
    if (this.timer) clearInterval(this.timer);
    const run = async () => {
      const s = await this.check().catch(() => this.state);
      if (s.status === "available" && autoDownload() && this.d.mode !== "dev") await this.download().catch(() => undefined);
    };
    setTimeout(() => void run(), 15000);
    if (hours > 0) this.timer = setInterval(() => void run(), hours * 3600000);
  }

  /** api = GitHub REST API; web = a release download link or web folder (GitHub's web answers HTTP 406 to "Accept: application/json"). */
  private headers(kind: boolean | "api" | "web", via: "server" | "repository" = "repository"): Record<string, string> {
    const accept = kind === "api" ? "application/vnd.github+json" : kind === "web" ? "*/*" : kind ? "application/json" : "application/octet-stream";
    const feed = this.d.feed();
    const auth = via === "server" ? bearer(feed.server?.token ?? "") : feed.token ? { Authorization: `token ${feed.token}` } : {};
    return { ...auth, Accept: accept, "User-Agent": "TheFlashMaster-updater" };
  }

  /** Find the newest release manifest: the Flash server first (when set), else / on failure the repository feed. */
  async check(): Promise<UpdateState> {
    const feed = this.d.feed();
    const server = serverBase(feed.server?.url ?? "");
    const f = parseFeed(feed.url);
    if (!server && !f) { this.sourceUrl = ""; return this.set({ status: "disabled", source: undefined, serverError: undefined, error: "No update source configured (package.json → flashmaster.updates.url, Settings → Flash server, or Settings → About)." }); }
    this.set({ status: "checking", error: undefined });
    let serverError: string | undefined;
    if (server) {
      try {
        const m = await this.serverManifest(server, feed.channel);
        return this.found(m, "server", server, undefined);
      } catch (e: any) {
        serverError = String(e?.message ?? e);
        this.d.log?.(`updates: Flash server failed (${serverError})${f ? " — trying the repository feed" : ""}`);
        if (!f) { this.sourceUrl = server; return this.set({ status: "error", source: "server", serverError, error: `Flash server: ${serverError}`, needsSignIn: false, checkedAt: Date.now() }); }
      }
    }
    const repo = f!;
    try {
      const m = repo.kind === "folder" ? await this.folderManifest(repo.base) : await this.githubManifest(repo, feed);
      return this.found(m, "repository", feed.url, serverError);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      this.sourceUrl = feed.url;
      return this.set({ status: "error", source: "repository", serverError, error: serverError ? `${msg} (Flash server: ${serverError})` : msg,
        needsSignIn: /sign[ -]?in|private|401|403|404|login/i.test(msg) && repo.kind === "github", checkedAt: Date.now() });
    }
  }

  private found(m: UpdateManifest, source: "server" | "repository", url: string, serverError: string | undefined): UpdateState {
    this.manifest = m;
    this.source = source;
    this.sourceUrl = url;
    const file = m.files.find((x) => x.kind === (this.d.mode === "portable" ? "portable" : "setup")) ?? null;
    this.file = file;
    const base = { source, serverError, needsSignIn: false, error: undefined, checkedAt: Date.now() };
    const newer = compareVersions(m.version, this.d.version) > 0;
    if (!newer) return this.set({ ...base, status: "up-to-date", latest: m.version, notes: m.notes });
    if (!file) return this.set({ ...base, status: "error", latest: m.version, error: `Release ${m.version} has no ${this.d.mode === "portable" ? "portable" : "installer"} file in latest.json` });
    const ready = this.cachedDownload(file);
    if (ready) { this.downloaded = ready; return this.set({ ...base, status: "ready", latest: m.version, notes: m.notes }); }
    return this.set({ ...base, status: "available", latest: m.version, notes: m.notes, size: file.size });
  }

  /** Flash server: <url>/updates/<channel>/latest.json with the server token; files next to it. */
  private async serverManifest(server: string, channel: "stable" | "beta"): Promise<UpdateManifest> {
    const dir = `${server}/updates/${channel}`;
    const url = `${dir}/latest.json`;
    let r: Awaited<ReturnType<Fetch>>;
    try { r = await this.d.fetch(url, { headers: this.headers(true, "server") }); }
    catch (e: any) { throw new Error(`cannot reach ${server}: ${String(e?.message ?? e)}`, { cause: e }); }
    const body = await r.text();
    if (!r.ok) {
      let detail = "";
      try { detail = String(JSON.parse(body)?.error ?? ""); } catch { /* not JSON */ }
      throw new Error(`HTTP ${r.status} for ${url}${detail ? ` — ${detail}` : ""}${r.status === 401 ? " (check the token in Settings → Flash server)" : ""}`);
    }
    let m: UpdateManifest;
    try { m = JSON.parse(body) as UpdateManifest; } catch { throw new Error(`Not JSON at ${url}`); }
    validate(m);
    m.files.forEach((x) => { x.url = new URL(encodeURIComponent(x.name), `${m.baseUrl ?? dir}/`).toString(); });
    return m;
  }

  private async getJson(url: string, api: boolean): Promise<any> {
    const r = await this.d.fetch(url, { headers: this.headers(api ? "api" : "web") });
    const body = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.replace(/\?.*$/, "")}${r.status === 404 && !api ? " — no release with latest.json, or the repository needs sign-in" : ""}`
      + (r.status === 406 && !api ? " — this looks like a GitHub repository page, not a folder with latest.json; use the repository URL (https://host/owner/repo)" : ""));
    // A private/internal repository answers an anonymous request with its (SSO) sign-in page instead of the file.
    const html = /text\/html/i.test(r.headers.get("content-type") ?? "") || /^\s*<(!doctype|html)/i.test(body);
    if (isLoginPage(r, body) || html) throw new Error("The repository is private: sign in once with “Sign in to GitHub” (company SSO works), or set a read-only token below");
    try { return JSON.parse(body); } catch { throw new Error(`Not JSON at ${url}`); }
  }

  private async folderManifest(base: string): Promise<UpdateManifest> {
    const m = (await this.getJson(`${base}/latest.json`, false)) as UpdateManifest;
    validate(m);
    m.files.forEach((x) => { x.url ??= new URL(x.name, `${m.baseUrl ?? base}/`).toString(); });
    return m;
  }

  private async githubManifest(f: { web: string; api: string; owner: string; repo: string }, feed: Feed): Promise<UpdateManifest> {
    // With a token (or for beta) use the REST API; otherwise the web "latest" download link (works with an SSO web session).
    if (feed.token || feed.channel === "beta") {
      const rel = feed.channel === "beta"
        ? ((await this.getJson(`${f.api}/repos/${f.owner}/${f.repo}/releases?per_page=10`, true)) as any[]).find((r) => !r.draft)
        : await this.getJson(`${f.api}/repos/${f.owner}/${f.repo}/releases/latest`, true);
      if (!rel) throw new Error("No releases found");
      const asset = (rel.assets ?? []).find((a: any) => a.name === "latest.json");
      if (!asset) throw new Error(`Release ${rel.tag_name} has no latest.json — add scripts/release-manifest.mjs to the release pipeline`);
      const m = JSON.parse(await this.downloadText(asset.url, feed.token ? asset.url : asset.browser_download_url)) as UpdateManifest;
      validate(m);
      for (const x of m.files) {
        const a = (rel.assets ?? []).find((y: any) => y.name === x.name);
        x.url = a ? (feed.token ? a.url : a.browser_download_url) : `${f.web}/releases/download/${rel.tag_name}/${x.name}`;
      }
      return m;
    }
    const m = (await this.getJson(`${f.web}/releases/latest/download/latest.json`, false)) as UpdateManifest;
    validate(m);
    const tag = `v${m.version}`;
    m.files.forEach((x) => { x.url ??= `${f.web}/releases/download/${tag}/${x.name}`; });
    return m;
  }

  private async downloadText(apiUrl: string, fallback: string): Promise<string> {
    const r = await this.d.fetch(apiUrl, { headers: this.headers(false) });
    if (r.ok) return r.text();
    const r2 = await this.d.fetch(fallback, { headers: this.headers(false) });
    if (!r2.ok) throw new Error(`HTTP ${r2.status} downloading latest.json`);
    return r2.text();
  }

  private dir(): string {
    const p = join(this.d.dataDir, "updates");
    mkdirSync(p, { recursive: true });
    return p;
  }
  private cachedDownload(file: UpdateFile): string | null {
    const p = join(this.dir(), file.name);
    if (!existsSync(p) || statSync(p).size !== file.size) return null;
    return sha256File(p) === file.sha256.toLowerCase() ? p : null;
  }

  /** Download the release file for this install type and verify its SHA-256. */
  async download(): Promise<UpdateState> {
    if (!this.file || !this.manifest) await this.check();
    const file = this.file;
    if (!file?.url) return this.state;
    if (this.d.mode === "dev") return this.set({ status: "error", error: "Updates install only in the packaged app (running from source)." });
    this.set({ status: "downloading", progress: 0 });
    try {
      // The file carries the credential of the feed it came from (and only to that feed's own host).
      const via = this.source === "server" && file.url.startsWith(`${this.sourceUrl}/`) ? "server" : "repository";
      const r = await this.d.fetch(file.url, { headers: via === "server" ? this.headers(false, "server") : this.source === "server" ? { Accept: "application/octet-stream", "User-Agent": "TheFlashMaster-updater" } : this.headers(false) });
      if (!r.ok) throw new Error(`HTTP ${r.status} downloading ${file.name}${via === "server" ? " from the Flash server" : ""}`);
      const target = join(this.dir(), file.name);
      const part = `${target}.part`;
      const hash = createHash("sha256");
      const out = createWriteStream(part);
      let got = 0, last = 0;
      if (r.body) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value); out.write(value); got += value.length;
          if (Date.now() - last > 300) { last = Date.now(); this.set({ status: "downloading", progress: file.size ? Math.min(99, Math.round((got / file.size) * 100)) : undefined }); }
        }
      } else {
        const buf = Buffer.from(await r.arrayBuffer());
        hash.update(buf); out.write(buf); got = buf.length;
      }
      await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
      const sum = hash.digest("hex");
      if (sum !== file.sha256.toLowerCase()) { unlinkSync(part); throw new Error(`Checksum mismatch for ${file.name} — download rejected`); }
      if (existsSync(target)) unlinkSync(target);
      renameSync(part, target);
      this.downloaded = target;
      return this.set({ status: "ready", progress: 100 });
    } catch (e: any) {
      return this.set({ status: "error", error: String(e?.message ?? e) });
    }
  }

  /** Install the downloaded update and restart. */
  install(): void {
    if (!this.downloaded || this.state.status !== "ready") return;
    if (this.d.mode === "installer") {
      // electron-builder NSIS: /S = silent (same per-user location), --updated, --force-run = start the app afterwards
      this.d.spawnDetached(this.downloaded, ["/S", "--updated", "--force-run"]);
      this.d.quit();
      return;
    }
    if (this.d.mode === "portable" && this.d.portablePath) {
      // A running exe can be renamed on Windows: keep the same path for the user's shortcut.
      const cur = this.d.portablePath;
      const old = `${cur}.old`;
      if (existsSync(old)) try { unlinkSync(old); } catch { /* locked: keep */ }
      renameSync(cur, old);
      copyFileSync(this.downloaded, cur);
      this.d.spawnDetached(cur, []);
      this.d.quit();
    }
  }

  private cleanupOldPortable(): void {
    const p = this.d.portablePath;
    if (p && existsSync(`${p}.old`)) setTimeout(() => { try { unlinkSync(`${p}.old`); } catch { /* still locked */ } }, 5000);
  }
}

function validate(m: UpdateManifest): void {
  if (!m || typeof m.version !== "string" || !Array.isArray(m.files)) throw new Error("latest.json is not a valid update manifest");
}
export function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}
