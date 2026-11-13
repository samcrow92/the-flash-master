/**
 * Marketplace — team/department plugin catalogues hosted on a plain local server (any static HTTP server at an IP).
 *
 *   <url>/index.json                     { name, description, plugins: PluginEntry[] }
 *   <url>/<entry.package>                PluginPackage (agents, workflows, instructions, optional MCP servers; inline content)
 *
 * Installing a plugin writes its agents into the user roles folder and its workflows into the user skills folder,
 * stores its instructions (merged into the team rules while enabled) and records provenance in plugins/installed.json,
 * so uninstall/update remove exactly what was installed. MCP servers are added disabled-by-policy unless allowed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledPlugin, MarketplaceListing, PluginEntry, PluginPackage } from "@shared/types";
import type { FetchLike } from "./jazz";
import { validateRole, ROLE_NAME_RE, parseFrontmatter } from "./roles";

export interface MarketplaceSource { id: string; name: string; url: string; department: string; enabled: boolean }

export interface MarketplaceDeps {
  dataDir: string;
  rolesDir: string; // user roles folder (agents)
  skillsDir: string; // user skills folder (workflows)
  fetch: FetchLike;
  token: (sourceId: string) => string;
  policy: () => { requireIntegrity: boolean; allowMcpServers: boolean };
  knownTools: () => string[];
  builtinRoles: () => string[];
  addMcpServers: (servers: { id: string; label: string; command: string; args: string; env: string }[], enabled: boolean) => void;
  removeMcpServers: (ids: string[]) => void;
}

const MAX_PACKAGE = 2_000_000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const FILE_RE = /^[\w.-]+\.md$/;

/** Semver-style comparison: numeric parts first; a pre-release (1.0.0-beta) is older than the release (1.0.0). */
export function compareVersions(a: string, b: string): number {
  const [ma = "", pa] = a.trim().split("-", 2);
  const [mb = "", pb] = b.trim().split("-", 2);
  const na = ma.split(".").map((x) => Number(x) || 0), nb = mb.split(".").map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

export function normaliseUrl(u: string): string {
  const t = u.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

export class Marketplace {
  private listings = new Map<string, MarketplaceListing>();
  private file: string;

  constructor(private d: MarketplaceDeps) {
    mkdirSync(join(d.dataDir, "plugins"), { recursive: true });
    mkdirSync(d.skillsDir, { recursive: true });
    this.file = join(d.dataDir, "plugins", "installed.json");
  }

  installed(): InstalledPlugin[] {
    try { return JSON.parse(readFileSync(this.file, "utf8")); } catch { return []; }
  }

  private saveInstalled(list: InstalledPlugin[]): void {
    writeFileSync(this.file, JSON.stringify(list, null, 2));
  }

  cached(): MarketplaceListing[] {
    return [...this.listings.values()];
  }

  /** Instructions of enabled plugins, merged into the team rules every agent receives. */
  instructions(): string {
    return this.installed().filter((p) => p.hasInstructions && p.instructionsEnabled).map((p) => {
      const f = join(this.d.dataDir, "plugins", p.id, "instructions.md");
      return existsSync(f) ? `### ${p.name} (${p.team})\n${readFileSync(f, "utf8").trim()}` : "";
    }).filter(Boolean).join("\n\n");
  }

  async fetchIndex(src: MarketplaceSource): Promise<MarketplaceListing> {
    const url = normaliseUrl(src.url);
    const base: MarketplaceListing = { sourceId: src.id, sourceName: src.name, department: src.department, url, description: "", plugins: [], error: null, fetchedAt: Date.now() };
    try {
      const idx = JSON.parse(await this.get(src, `${url}/index.json`)) as { name?: string; description?: string; plugins?: PluginEntry[] };
      const plugins = (idx.plugins ?? []).filter((p) => p && ID_RE.test(String(p.id)) && p.version && p.package).map((p) => ({
        ...p, name: String(p.name ?? p.id), description: String(p.description ?? ""), team: String(p.team ?? ""),
        kinds: Array.isArray(p.kinds) ? p.kinds : [], tags: Array.isArray(p.tags) ? p.tags : [],
      }));
      const l = { ...base, sourceName: src.name || idx.name || url, description: String(idx.description ?? ""), plugins };
      this.listings.set(src.id, l);
      return l;
    } catch (e: any) {
      const l = { ...base, error: String(e?.message ?? e) };
      this.listings.set(src.id, l);
      return l;
    }
  }

  async refresh(sources: MarketplaceSource[]): Promise<MarketplaceListing[]> {
    for (const id of [...this.listings.keys()]) if (!sources.some((s) => s.id === id)) this.listings.delete(id);
    return Promise.all(sources.filter((s) => s.enabled && s.url).map((s) => this.fetchIndex(s)));
  }

  /** Plugins with a newer version in their source marketplace. */
  updates(): { plugin: InstalledPlugin; entry: PluginEntry }[] {
    const out: { plugin: InstalledPlugin; entry: PluginEntry }[] = [];
    for (const p of this.installed()) {
      const entry = this.listings.get(p.sourceId)?.plugins.find((e) => e.id === p.id);
      if (entry && compareVersions(entry.version, p.version) > 0) out.push({ plugin: p, entry });
    }
    return out;
  }

  async install(src: MarketplaceSource, pluginId: string): Promise<InstalledPlugin> {
    const listing = this.listings.get(src.id) ?? await this.fetchIndex(src);
    if (listing.error) throw new Error(`marketplace "${src.name}" is unreachable: ${listing.error}`);
    const entry = listing.plugins.find((p) => p.id === pluginId);
    if (!entry) throw new Error(`plugin ${pluginId} not found in ${src.name}`);
    const pkgUrl = /^https?:\/\//i.test(entry.package) ? entry.package : `${listing.url}/${entry.package.replace(/^\/+/, "")}`;
    const raw = await this.get(src, pkgUrl);
    if (raw.length > MAX_PACKAGE) throw new Error("plugin package is too large");
    const policy = this.d.policy();
    const sha = createHash("sha256").update(raw).digest("hex");
    if (entry.sha256 && entry.sha256.toLowerCase() !== sha) throw new Error(`integrity check failed for ${pluginId} (sha256 mismatch) — not installed`);
    if (!entry.sha256 && policy.requireIntegrity) throw new Error(`${pluginId} has no sha256 in the marketplace index and integrity checks are required (Settings → Marketplace)`);
    const pkg = JSON.parse(raw) as PluginPackage;
    if (pkg.id !== entry.id) throw new Error(`package id "${pkg.id}" does not match index id "${entry.id}"`);
    return this.apply(src, listing.sourceName, entry, pkg);
  }

  /** Validate everything first, then write — a bad plugin never half-installs. */
  private apply(src: MarketplaceSource, sourceName: string, entry: PluginEntry, pkg: PluginPackage): InstalledPlugin {
    const list = this.installed();
    const previous = list.find((p) => p.id === pkg.id);
    const ownedByOthers = (kind: "agents" | "workflows", name: string) => list.some((p) => p.id !== pkg.id && p[kind].includes(name));
    const errors: string[] = [];
    const agents: { name: string; content: string }[] = [];
    for (const a of pkg.agents ?? []) {
      if (!FILE_RE.test(a.file)) { errors.push(`agent file name not allowed: ${a.file}`); continue; }
      const v = validateRole(a.content, this.d.knownTools(), this.d.builtinRoles());
      if (!v.ok || !v.role) { errors.push(`${a.file}: ${v.errors.join("; ")}`); continue; }
      if (ownedByOthers("agents", v.role.name)) { errors.push(`agent "${v.role.name}" is already provided by another plugin`); continue; }
      const existing = join(this.d.rolesDir, `${v.role.name}.md`);
      if (existsSync(existing) && !previous?.agents.includes(v.role.name)) { errors.push(`agent "${v.role.name}" already exists as one of your own agents — remove it first`); continue; }
      agents.push({ name: v.role.name, content: a.content });
    }
    const workflows: { command: string; content: string }[] = [];
    for (const w of pkg.workflows ?? []) {
      if (!FILE_RE.test(w.file)) { errors.push(`workflow file name not allowed: ${w.file}`); continue; }
      const { meta, body } = parseFrontmatter(w.content);
      const command = String(meta.command ?? "").toLowerCase();
      if (!ROLE_NAME_RE.test(command)) { errors.push(`${w.file}: workflow needs a "command:" (lowercase, dashes) in its header`); continue; }
      if (!body.trim()) { errors.push(`${w.file}: workflow body is empty`); continue; }
      if (ownedByOthers("workflows", command)) { errors.push(`workflow "/${command}" is already provided by another plugin`); continue; }
      workflows.push({ command, content: w.content });
    }
    const mcp = (pkg.mcpServers ?? []).filter((m) => m && ID_RE.test(m.id) && m.command);
    if (errors.length) throw new Error(`plugin ${pkg.id} was not installed:\n- ${errors.join("\n- ")}`);
    if (!agents.length && !workflows.length && !pkg.instructions?.trim() && !mcp.length) throw new Error(`plugin ${pkg.id} contains nothing to install`);

    if (previous) this.removeFiles(previous);
    for (const a of agents) writeFileSync(join(this.d.rolesDir, `${a.name}.md`), a.content.replace(/\r\n/g, "\n"));
    for (const w of workflows) writeFileSync(join(this.d.skillsDir, `${w.command}.md`), w.content.replace(/\r\n/g, "\n"));
    const dir = join(this.d.dataDir, "plugins", pkg.id);
    mkdirSync(dir, { recursive: true });
    if (pkg.instructions?.trim()) writeFileSync(join(dir, "instructions.md"), pkg.instructions.trim() + "\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    const mcpIds = mcp.map((m) => `${pkg.id}.${m.id}`);
    if (mcp.length) this.d.addMcpServers(mcp.map((m) => ({ id: `${pkg.id}.${m.id}`, label: m.label ?? m.id, command: m.command, args: m.args ?? "", env: m.env ?? "" })), this.d.policy().allowMcpServers);

    const rec: InstalledPlugin = {
      id: pkg.id, name: pkg.name ?? entry.name, version: entry.version, team: pkg.team ?? entry.team, sourceId: src.id, sourceName,
      installedAt: Date.now(), agents: agents.map((a) => a.name), workflows: workflows.map((w) => w.command),
      hasInstructions: !!pkg.instructions?.trim(), instructionsEnabled: previous?.instructionsEnabled ?? true, mcpServers: mcpIds,
    };
    this.saveInstalled([...list.filter((p) => p.id !== pkg.id), rec]);
    return rec;
  }

  uninstall(pluginId: string): void {
    const list = this.installed();
    const p = list.find((x) => x.id === pluginId);
    if (!p) throw new Error(`plugin ${pluginId} is not installed`);
    this.removeFiles(p);
    rmSync(join(this.d.dataDir, "plugins", p.id), { recursive: true, force: true });
    this.saveInstalled(list.filter((x) => x.id !== pluginId));
  }

  setInstructionsEnabled(pluginId: string, enabled: boolean): void {
    this.saveInstalled(this.installed().map((p) => (p.id === pluginId ? { ...p, instructionsEnabled: enabled } : p)));
  }

  private removeFiles(p: InstalledPlugin): void {
    for (const a of p.agents) { const f = join(this.d.rolesDir, `${a}.md`); if (existsSync(f)) unlinkSync(f); }
    for (const w of p.workflows) { const f = join(this.d.skillsDir, `${w}.md`); if (existsSync(f)) unlinkSync(f); }
    if (p.mcpServers.length) this.d.removeMcpServers(p.mcpServers);
  }

  private async get(src: MarketplaceSource, url: string): Promise<string> {
    const token = this.d.token(src.id);
    const r = await this.d.fetch(url, { method: "GET", headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return r.text();
  }
}
