/**
 * Marketplace — team/department plugin catalogues hosted on a plain local server (any static HTTP server at an IP).
 *
 *   <url>/index.json                     { name, description, plugins: PluginEntry[] }
 *   <url>/<entry.package>                PluginPackage (agents, workflows, instructions, optional MCP servers; inline content)
 *
 * Installing a plugin writes its agents into the user roles folder and its workflows into the user skills folder,
 * stores its instructions (merged into the team rules while enabled) and records provenance in plugins/installed.json,
 * so uninstall/update remove exactly what was installed. MCP servers are added disabled unless policy allows them.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXAM_PRESET_KEYS, type ExamPreset, type InstalledPlugin, type MarketplaceListing, type PluginEntry, type PluginKind, type PluginPackage } from "@shared/types";
import type { FetchLike } from "./jazz";
import { validateRole, ROLE_NAME_RE, parseFrontmatter } from "./roles";

/** `token` is set only for the Flash server source (Bearer); settings-defined marketplaces have none. */
export interface MarketplaceSource { id: string; name: string; url: string; department: string; enabled: boolean; token?: string }

export interface MarketplaceDeps {
  dataDir: string;
  rolesDir: string; // user roles folder (agents)
  skillsDir: string; // user skills folder (workflows)
  fetch: FetchLike;
  policy: () => { allowMcpServers: boolean };
  knownTools: () => string[];
  builtinRoles: () => string[];
  addMcpServers: (servers: { id: string; label: string; command: string; args: string; env: string }[], enabled: boolean) => void;
  removeMcpServers: (ids: string[]) => void;
  /** Apply a team EXAM preset (fill empty EXAM settings, run the setup). */
  applyExamPreset?: (preset: ExamPreset) => void;
}

/** Keep only known EXAM keys with plain values; resolve a relative plugin package against the marketplace URL. */
export function cleanExamPreset(raw: unknown, baseUrl: string): ExamPreset | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, string | number> = {};
  for (const k of EXAM_PRESET_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if ((k === "licensePort" || k === "restPort") ? typeof v === "number" && v > 0 && v < 65536 : typeof v === "string" && v.trim()) out[k] = typeof v === "string" ? v.trim() : v as number;
  }
  const pkg = out.pluginPackage as string | undefined;
  if (pkg && !/^(https?:\/\/|\\\\|[a-z]:[\\/]|\/)/i.test(pkg)) out.pluginPackage = `${baseUrl}/${pkg.replace(/^\.?\/+/, "")}`;
  return Object.keys(out).length ? out as ExamPreset : null;
}

export const MAX_PACKAGE = 2_000_000;
export const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const FILE_RE = /^[\w.-]+\.md$/;
export const SCRIPT_RE = /^[\w.-]+\.(py|ps1|sh|js|mjs|bat|cmd|txt|json|ya?ml)$/;
export const MAX_SCRIPT = 200_000;
export const VERSION_RE = /^\d+\.\d+\.\d+([-+][\w.-]+)?$/;

export interface ValidateContext {
  knownTools: string[];
  builtinRoles: string[];
  /** Installing on this PC: also refuse to overwrite the user's own agents or items another plugin owns. */
  local?: { installed: InstalledPlugin[]; rolesDir: string };
  /** Submitting to a Flash server: id, version and size are checked too (the server checks them again). */
  submit?: boolean;
}
export interface ValidatedPackage {
  agents: { name: string; content: string }[];
  workflows: { command: string; content: string }[];
  skills: { command: string; content: string }[];
  scripts: { file: string; content: string }[];
  mcp: NonNullable<PluginPackage["mcpServers"]>;
  kinds: PluginKind[];
  /** Short labels of what is inside ("agent @hil-tester", "script flash.ps1"). */
  items: string[];
  errors: string[];
}

/** Skill command: the header's `command:`, else the file name without .md. */
export const skillCommand = (file: string, content: string) => String(parseFrontmatter(content).meta.command || file.replace(/\.md$/i, "")).toLowerCase();

/**
 * The install rules as a pure check (no writes): used by install and by the submission dry run, so a package that
 * passes here installs the same way on every user's PC.
 */
export function validatePackage(pkg: PluginPackage, ctx: ValidateContext): ValidatedPackage {
  const errors: string[] = [];
  const list = ctx.local?.installed ?? [];
  const previous = list.find((p) => p.id === pkg.id);
  const others = list.filter((p) => p.id !== pkg.id);
  if (!ID_RE.test(String(pkg.id ?? ""))) errors.push(`id "${pkg.id ?? ""}" is not allowed: lowercase letters, digits, . _ - (2–64 chars, starting with a letter or digit)`);
  if (ctx.submit) {
    if (!VERSION_RE.test(String(pkg.version ?? ""))) errors.push(`version "${pkg.version ?? ""}" must be semver, e.g. 1.0.0`);
    if (!String(pkg.name ?? "").trim()) errors.push("name is required");
    const size = Buffer.byteLength(JSON.stringify(pkg));
    if (size > MAX_PACKAGE) errors.push(`package is ${Math.round(size / 1000)} KB; the limit is ${MAX_PACKAGE / 1_000_000} MB`);
  }
  const agents: ValidatedPackage["agents"] = [];
  for (const a of pkg.agents ?? []) {
    if (!FILE_RE.test(a.file)) { errors.push(`agent file name not allowed: ${a.file}`); continue; }
    const v = validateRole(String(a.content ?? ""), ctx.knownTools, ctx.builtinRoles);
    if (!v.ok || !v.role) { errors.push(`${a.file}: ${v.errors.join("; ")}`); continue; }
    if (agents.some((x) => x.name === v.role!.name)) { errors.push(`agent "${v.role.name}" is in the package twice`); continue; }
    if (others.some((p) => p.agents.includes(v.role!.name))) { errors.push(`agent "${v.role.name}" is already provided by another plugin`); continue; }
    if (ctx.local && existsSync(join(ctx.local.rolesDir, `${v.role.name}.md`)) && !previous?.agents.includes(v.role.name)) { errors.push(`agent "${v.role.name}" already exists as one of your own agents — remove it first`); continue; }
    agents.push({ name: v.role.name, content: a.content });
  }
  const commands = new Set<string>();
  const ownedCommand = (c: string) => others.some((p) => p.workflows.includes(c) || (p.skills ?? []).includes(c));
  const workflows: ValidatedPackage["workflows"] = [];
  for (const w of pkg.workflows ?? []) {
    if (!FILE_RE.test(w.file)) { errors.push(`workflow file name not allowed: ${w.file}`); continue; }
    const { meta, body } = parseFrontmatter(String(w.content ?? ""));
    const command = String(meta.command ?? "").toLowerCase();
    if (!ROLE_NAME_RE.test(command)) { errors.push(`${w.file}: workflow needs a "command:" (lowercase, dashes) in its header`); continue; }
    if (!body.trim()) { errors.push(`${w.file}: workflow body is empty`); continue; }
    if (commands.has(command)) { errors.push(`"/${command}" is in the package twice`); continue; }
    if (ownedCommand(command)) { errors.push(`workflow "/${command}" is already provided by another plugin`); continue; }
    commands.add(command);
    workflows.push({ command, content: w.content });
  }
  const skills: ValidatedPackage["skills"] = [];
  for (const k of pkg.skills ?? []) {
    if (!FILE_RE.test(k.file)) { errors.push(`skill file name not allowed: ${k.file}`); continue; }
    const content = String(k.content ?? "");
    const command = skillCommand(k.file, content);
    if (!ROLE_NAME_RE.test(command)) { errors.push(`${k.file}: skill command "${command}" must be lowercase letters, digits and dashes (set "command:" in the header or rename the file)`); continue; }
    if (!parseFrontmatter(content).body.trim()) { errors.push(`${k.file}: skill body is empty`); continue; }
    if (commands.has(command)) { errors.push(`"/${command}" is in the package twice`); continue; }
    if (ownedCommand(command)) { errors.push(`skill "/${command}" is already provided by another plugin`); continue; }
    commands.add(command);
    skills.push({ command, content });
  }
  const scripts: ValidatedPackage["scripts"] = [];
  for (const x of pkg.scripts ?? []) {
    if (!SCRIPT_RE.test(x.file)) { errors.push(`script file name not allowed: ${x.file} (letters, digits, . _ - and one of .py .ps1 .sh .js .mjs .bat .cmd .txt .json .yml .yaml)`); continue; }
    const content = String(x.content ?? "");
    if (Buffer.byteLength(content) > MAX_SCRIPT) { errors.push(`script ${x.file} is larger than ${MAX_SCRIPT / 1000} KB`); continue; }
    if (scripts.some((y) => y.file.toLowerCase() === x.file.toLowerCase())) { errors.push(`script ${x.file} is in the package twice`); continue; }
    scripts.push({ file: x.file, content });
  }
  const mcp = (pkg.mcpServers ?? []).filter((m) => m && ID_RE.test(m.id) && m.command);
  if (ctx.submit) for (const m of pkg.mcpServers ?? []) if (!m || !ID_RE.test(String(m.id ?? "")) || !m.command) errors.push(`mcp server "${m?.id ?? "?"}" needs an id (lowercase) and a command`);
  const hasInstructions = !!pkg.instructions?.trim();
  if (!agents.length && !workflows.length && !skills.length && !scripts.length && !hasInstructions && !mcp.length && !pkg.exam && !errors.length)
    errors.push(`plugin ${pkg.id} contains nothing to install`);
  const kinds = ([[agents.length, "agent"], [workflows.length, "workflow"], [skills.length, "skill"], [scripts.length, "script"],
    [hasInstructions, "instructions"], [mcp.length, "mcp"], [pkg.exam, "exam"]] as [unknown, PluginKind][]).filter(([n]) => !!n).map(([, k]) => k);
  const items = [...agents.map((a) => `agent @${a.name}`), ...workflows.map((w) => `workflow /${w.command}`), ...skills.map((k) => `skill /${k.command}`),
    ...scripts.map((x) => `script ${x.file}`), ...(hasInstructions ? ["instructions"] : []), ...mcp.map((m) => `tool server ${m.id}`), ...(pkg.exam ? ["EXAM setup"] : [])];
  return { agents, workflows, skills, scripts, mcp, kinds, items, errors };
}

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
    let raw: InstalledPlugin[];
    try { raw = JSON.parse(readFileSync(this.file, "utf8")); } catch { return []; }
    // Records written before skills/scripts existed.
    return Array.isArray(raw) ? raw.map((p) => ({ ...p, skills: p.skills ?? [], scripts: p.scripts ?? [] })) : [];
  }

  private saveInstalled(list: InstalledPlugin[]): void {
    writeFileSync(this.file, JSON.stringify(list, null, 2));
  }

  cached(): MarketplaceListing[] {
    return [...this.listings.values()];
  }

  /** Instructions of enabled plugins, merged into the team rules every agent receives. */
  instructions(): string {
    return this.installed().filter((p) => p.instructionsEnabled && (p.hasInstructions || p.scripts.length)).map((p) => {
      const f = join(this.d.dataDir, "plugins", p.id, "instructions.md");
      const text = p.hasInstructions && existsSync(f) ? readFileSync(f, "utf8").trim() : "";
      const scripts = p.scripts.length ? `Scripts from this plugin (run them with the matching interpreter): ${p.scripts.map((x) => `\`${this.scriptPath(p.id, x)}\``).join(", ")}` : "";
      const body = [text, scripts].filter(Boolean).join("\n");
      return body ? `### ${p.name} (${p.team})\n${body}` : "";
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
    // The publishing script writes a sha256 per package; when present it must match (protects against half-copied files).
    const sha = createHash("sha256").update(raw).digest("hex");
    if (entry.sha256 && entry.sha256.toLowerCase() !== sha) throw new Error(`${pluginId}: package does not match the marketplace index (re-run the publishing script on the server)`);
    const pkg = JSON.parse(raw) as PluginPackage;
    if (pkg.id !== entry.id) throw new Error(`package id "${pkg.id}" does not match index id "${entry.id}"`);
    const exam = cleanExamPreset(pkg.exam, listing.url);
    return this.apply(src, listing.sourceName, entry, { ...pkg, exam: exam ?? undefined });
  }

  /** Validate everything first (validatePackage), then write — a bad plugin never half-installs. */
  private apply(src: MarketplaceSource, sourceName: string, entry: PluginEntry, pkg: PluginPackage): InstalledPlugin {
    const list = this.installed();
    const previous = list.find((p) => p.id === pkg.id);
    const v = validatePackage(pkg, { knownTools: this.d.knownTools(), builtinRoles: this.d.builtinRoles(), local: { installed: list, rolesDir: this.d.rolesDir } });
    if (v.errors.length) throw new Error(`plugin ${pkg.id} was not installed:\n- ${v.errors.join("\n- ")}`);
    const { agents, workflows, skills, scripts, mcp } = v;

    if (previous) this.removeFiles(previous);
    for (const a of agents) writeFileSync(join(this.d.rolesDir, `${a.name}.md`), a.content.replace(/\r\n/g, "\n"));
    for (const w of [...workflows, ...skills]) writeFileSync(join(this.d.skillsDir, `${w.command}.md`), w.content.replace(/\r\n/g, "\n"));
    const dir = join(this.d.dataDir, "plugins", pkg.id);
    mkdirSync(dir, { recursive: true });
    if (pkg.instructions?.trim()) writeFileSync(join(dir, "instructions.md"), pkg.instructions.trim() + "\n");
    if (scripts.length) {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      for (const x of scripts) writeFileSync(join(dir, "scripts", x.file), x.content);
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    const mcpIds = mcp.map((m) => `${pkg.id}.${m.id}`);
    if (mcp.length) this.d.addMcpServers(mcp.map((m) => ({ id: `${pkg.id}.${m.id}`, label: m.label ?? m.id, command: m.command, args: m.args ?? "", env: m.env ?? "" })), this.d.policy().allowMcpServers);

    const rec: InstalledPlugin = {
      id: pkg.id, name: pkg.name ?? entry.name, version: entry.version, team: pkg.team ?? entry.team, sourceId: src.id, sourceName,
      installedAt: Date.now(), agents: agents.map((a) => a.name), workflows: workflows.map((w) => w.command), skills: skills.map((w) => w.command),
      scripts: scripts.map((x) => x.file),
      hasInstructions: !!pkg.instructions?.trim(), instructionsEnabled: previous?.instructionsEnabled ?? true, mcpServers: mcpIds,
    };
    this.saveInstalled([...list.filter((p) => p.id !== pkg.id), rec]);
    if (pkg.exam) this.d.applyExamPreset?.(pkg.exam);
    return rec;
  }

  /** Where an installed plugin's script lives (agents get these paths in their team rules). */
  scriptPath(pluginId: string, file: string): string {
    return join(this.d.dataDir, "plugins", pluginId, "scripts", file);
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
    for (const w of [...p.workflows, ...p.skills]) { const f = join(this.d.skillsDir, `${w}.md`); if (existsSync(f)) unlinkSync(f); }
    rmSync(join(this.d.dataDir, "plugins", p.id, "scripts"), { recursive: true, force: true });
    if (p.mcpServers.length) this.d.removeMcpServers(p.mcpServers);
  }

  /** The source's token (the Flash server's) goes only to URLs under that source. */
  private async get(src: MarketplaceSource, url: string): Promise<string> {
    const own = !!src.token && url.startsWith(`${normaliseUrl(src.url)}/`);
    const r = await this.d.fetch(url, { method: "GET", headers: { Accept: "application/json", ...(own ? { Authorization: `Bearer ${src.token}` } : {}) } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}${r.status === 401 && src.token !== undefined ? " — check the Flash server token (Settings → Flash server)" : ""}`);
    return r.text();
  }
}
