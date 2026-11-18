/**
 * Build a PluginPackage for a Flash server submission, from either
 *  - a folder in the marketplace `plugins-src/<id>/` layout (same as scripts/marketplace/build-index.mjs):
 *      plugin.json, agents/*.md, workflows/*.md, skills/*.md, scripts/*, instructions.md, mcp.json, exam.json
 *  - or single files (an agent .md, a workflow / skill .md, a script, instructions) plus the form fields.
 * Reading only; validation with the install rules is validatePackage() in marketplace.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { PluginPackage, SubmitDraft, SubmitFileKind, SubmitMeta, SubmitSource } from "@shared/types";
import { FILE_RE, MAX_SCRIPT, SCRIPT_RE } from "./marketplace";
import { parseFrontmatter } from "./roles";

const MAX_FILE = 2_000_000;
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const readText = (p: string) => lf(readFileSync(p, "utf8"));

function readJson(p: string, problems: string[], label: string): any {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e: any) { problems.push(`${label}: not valid JSON (${String(e?.message ?? e)})`); return null; }
}

/** Files of a subfolder that match `re`, sorted; other files are reported (they would be silently ignored otherwise). */
function readDirFiles(dir: string, re: RegExp, label: string, problems: string[], max = MAX_FILE): { file: string; content: string }[] {
  if (!existsSync(dir)) return [];
  const out: { file: string; content: string }[] = [];
  for (const file of readdirSync(dir).sort()) {
    const p = join(dir, file);
    if (!statSync(p).isFile() || file.startsWith(".")) continue;
    if (!re.test(file)) { problems.push(`${label}/${file}: file name not allowed here`); continue; }
    if (statSync(p).size > max) { problems.push(`${label}/${file}: larger than ${Math.round(max / 1000)} KB`); continue; }
    out.push({ file, content: readText(p) });
  }
  return out;
}

const emptyMeta = (): SubmitMeta => ({ id: "", name: "", version: "1.0.0", description: "", team: "", tags: [] });

/** plugin.json → form fields (missing values stay empty). */
export function readFolderMeta(dir: string): { meta: SubmitMeta; problems: string[] } {
  const problems: string[] = [];
  const f = join(dir, "plugin.json");
  if (!existsSync(f)) return { meta: { ...emptyMeta(), id: basename(dir).toLowerCase() }, problems: ["plugin.json is missing — fill the fields below"] };
  const m = readJson(f, problems, "plugin.json") ?? {};
  return {
    meta: { id: String(m.id ?? basename(dir)), name: String(m.name ?? ""), version: String(m.version ?? "1.0.0"), description: String(m.description ?? ""),
      team: String(m.team ?? ""), tags: Array.isArray(m.tags) ? m.tags.map(String) : [] },
    problems,
  };
}

/** The package for a plugins-src/<id>/ folder; `meta` (from the form) wins over plugin.json. */
export function packageFromFolder(dir: string, meta?: Partial<SubmitMeta>): { pkg: PluginPackage; problems: string[] } {
  const base = readFolderMeta(dir);
  const problems = base.problems.filter((p) => !/plugin\.json is missing/.test(p) || !meta?.id);
  const m = { ...base.meta, ...Object.fromEntries(Object.entries(meta ?? {}).filter(([, v]) => v !== undefined)) } as SubmitMeta;
  const agents = readDirFiles(join(dir, "agents"), FILE_RE, "agents", problems);
  const workflows = readDirFiles(join(dir, "workflows"), FILE_RE, "workflows", problems);
  const skills = readDirFiles(join(dir, "skills"), FILE_RE, "skills", problems);
  const scripts = readDirFiles(join(dir, "scripts"), SCRIPT_RE, "scripts", problems, MAX_SCRIPT);
  const instructions = existsSync(join(dir, "instructions.md")) ? readText(join(dir, "instructions.md")) : "";
  const mcp = existsSync(join(dir, "mcp.json")) ? readJson(join(dir, "mcp.json"), problems, "mcp.json") : null;
  if (mcp !== null && !Array.isArray(mcp)) problems.push("mcp.json: must be a list of { id, label, command, args, env }");
  const exam = existsSync(join(dir, "exam.json")) ? readJson(join(dir, "exam.json"), problems, "exam.json") : null;
  return { pkg: assemble(m, { agents, workflows, skills, scripts, instructions, mcpServers: Array.isArray(mcp) ? mcp : [], exam }), problems };
}

/** The package for single files; each file's kind comes from the dialog (guessKind suggests one). */
export function packageFromFiles(files: { path: string; kind: SubmitFileKind }[], meta: SubmitMeta): { pkg: PluginPackage; problems: string[] } {
  const problems: string[] = [];
  const parts = { agents: [] as { file: string; content: string }[], workflows: [] as { file: string; content: string }[], skills: [] as { file: string; content: string }[],
    scripts: [] as { file: string; content: string }[], instructions: "" };
  for (const f of files) {
    const file = basename(f.path);
    if (!existsSync(f.path)) { problems.push(`${file}: file not found`); continue; }
    const size = statSync(f.path).size;
    if (size > (f.kind === "script" ? MAX_SCRIPT : MAX_FILE)) { problems.push(`${file}: larger than ${Math.round((f.kind === "script" ? MAX_SCRIPT : MAX_FILE) / 1000)} KB`); continue; }
    const content = readText(f.path);
    if (f.kind === "instructions") parts.instructions = [parts.instructions, content].filter((x) => x.trim()).join("\n\n");
    else parts[f.kind === "agent" ? "agents" : f.kind === "workflow" ? "workflows" : f.kind === "skill" ? "skills" : "scripts"].push({ file, content });
  }
  return { pkg: assemble(meta, { ...parts, mcpServers: [], exam: null }), problems };
}

function assemble(m: SubmitMeta, p: { agents: { file: string; content: string }[]; workflows: { file: string; content: string }[]; skills: { file: string; content: string }[];
  scripts: { file: string; content: string }[]; instructions: string; mcpServers: NonNullable<PluginPackage["mcpServers"]>; exam: any }): PluginPackage {
  return {
    id: m.id.trim(), name: m.name.trim() || m.id.trim(), version: m.version.trim(), description: m.description.trim(), team: m.team.trim(),
    ...(m.tags.length ? { tags: m.tags } : {}),
    agents: p.agents, workflows: p.workflows,
    ...(p.skills.length ? { skills: p.skills } : {}),
    ...(p.scripts.length ? { scripts: p.scripts } : {}),
    ...(p.instructions.trim() ? { instructions: p.instructions } : {}),
    ...(p.mcpServers.length ? { mcpServers: p.mcpServers } : {}),
    ...(p.exam ? { exam: p.exam } : {}),
  };
}

/** Suggest a kind for a picked file: scripts by extension, .md by header (command: → workflow, title: → agent, else skill). */
export function guessKind(path: string, content?: string): SubmitFileKind {
  const file = basename(path);
  if (!/\.md$/i.test(file)) return "script";
  if (/^instructions\.md$/i.test(file)) return "instructions";
  const text = content ?? (existsSync(path) ? readFileSync(path, "utf8").slice(0, 4000) : "");
  const { meta } = parseFrontmatter(lf(text));
  if (meta.command) return "workflow";
  if (meta.title && meta.name) return "agent";
  return "skill";
}

/** Draft for the dialog: fields prefilled (plugin.json, or the first agent/skill's header) and a list of what was found. */
export function draftFor(source: SubmitSource): SubmitDraft {
  if (source.kind === "folder") {
    const { meta, problems: metaProblems } = readFolderMeta(source.path);
    const { pkg, problems } = packageFromFolder(source.path);
    return { source, meta, items: listItems(pkg), problems: [...new Set([...metaProblems, ...problems])] };
  }
  const first = source.files.find((f) => f.kind !== "script");
  const head = first ? parseFrontmatter(lf(readFileSync(first.path, "utf8"))).meta : {};
  const nameOf = String(head.name ?? head.command ?? (first ? basename(first.path, ".md") : source.files[0] ? basename(source.files[0].path).replace(/\.[^.]+$/, "") : ""));
  const meta: SubmitMeta = { ...emptyMeta(), id: nameOf.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""),
    name: String(head.title ?? head.name ?? nameOf), description: String(head.description ?? "") };
  const { pkg, problems } = packageFromFiles(source.files, meta);
  return { source, meta, items: listItems(pkg), problems };
}

export function listItems(pkg: PluginPackage): string[] {
  return [...(pkg.agents ?? []).map((x) => `agents/${x.file}`), ...(pkg.workflows ?? []).map((x) => `workflows/${x.file}`), ...(pkg.skills ?? []).map((x) => `skills/${x.file}`),
    ...(pkg.scripts ?? []).map((x) => `scripts/${x.file}`), ...(pkg.instructions?.trim() ? ["instructions.md"] : []), ...(pkg.mcpServers?.length ? ["mcp.json"] : []), ...(pkg.exam ? ["exam.json"] : [])];
}

export function buildPackage(source: SubmitSource, meta: SubmitMeta): { pkg: PluginPackage; problems: string[] } {
  return source.kind === "folder" ? packageFromFolder(source.path, meta) : packageFromFiles(source.files, meta);
}
