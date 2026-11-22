import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HarnessId, RoleDef, SkillDef } from "@shared/types";
import { needsLocalInference } from "./locality";

/** Tiny frontmatter parser: `key: value`, `key: [a, b]`. Enough for role/skill files; no YAML dependency. */
export function parseFrontmatter(src: string): { meta: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string | string[]> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const v = kv[2]!.trim();
    meta[kv[1]!] = v.startsWith("[") && v.endsWith("]")
      ? v.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
      : v.replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2]!.trim() };
}

const str = (v: string | string[] | undefined, d = ""): string => (Array.isArray(v) ? v.join(", ") : (v ?? d));
const arr = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);

export function parseRole(src: string, fallbackName: string, source: RoleDef["source"]): RoleDef {
  const { meta, body } = parseFrontmatter(src);
  return {
    name: str(meta.name, fallbackName).toLowerCase(),
    title: str(meta.title, fallbackName),
    icon: str(meta.icon, "🤖"),
    description: str(meta.description),
    harness: (str(meta.harness) || undefined) as HarnessId | undefined,
    model: str(meta.model) || undefined,
    tools: arr(meta.tools),
    maxResultTokens: Number(str(meta.maxResultTokens, "400")) || 400,
    skills: arr(meta.skills),
    prompt: body,
    source,
    ...(str(meta.isolate) === "true" ? { isolate: true } : {}),
    ...(arr(meta.requires).length ? { requires: arr(meta.requires).map((x) => x.toLowerCase()) } : {}),
    // `local: false` opts out of the instruction check; `local: true` (or instructions that demand local inference) opts in.
    ...((str(meta.local) ? str(meta.local) === "true" : needsLocalInference(body)) ? { local: true } : {}),
  };
}

function readDir(dir: string): { name: string; src: string }[] {
  if (!existsSync(dir)) return [];
  // Files starting with "_" (e.g. _template.md) are never loaded as roles.
  return readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => ({ name: basename(f, ".md"), src: readFileSync(join(dir, f), "utf8") }));
}

/** Built-in roles, overridden/extended by files in the user's roles folder. */
export function loadRoles(builtinDir: string, userDir: string): RoleDef[] {
  const map = new Map<string, RoleDef>();
  for (const f of readDir(builtinDir)) { const r = parseRole(f.src, f.name, "builtin"); map.set(r.name, r); }
  for (const f of readDir(userDir)) { const r = parseRole(f.src, f.name, "user"); map.set(r.name, r); }
  const order = ["flashmaster"];
  return [...map.values()].sort((a, b) => (order.indexOf(b.name) - order.indexOf(a.name)) || a.title.localeCompare(b.title));
}

export function loadSkills(dir: string): SkillDef[] {
  return readDir(dir).filter((f) => f.name.toLowerCase() !== "readme").map((f) => {
    const { meta, body } = parseFrontmatter(f.src);
    return { name: str(meta.name, f.name), command: str(meta.command, f.name), description: str(meta.description), body };
  });
}

/** Folders a project keeps Agent Skills in (each skill is a folder with a SKILL.md). */
export const PROJECT_SKILL_DIRS = [".flashmaster/skills", ".claude/skills", ".agents/skills"];

/**
 * Agent Skills (the SKILL.md format): every `<dir>/<skill>/SKILL.md`, with YAML front matter `name` and `description`.
 * Only the name and description go into prompts; an agent loads the body (and sees the folder's other files) with use_skill.
 */
export function loadAgentSkills(dir: string, source: NonNullable<SkillDef["source"]>): SkillDef[] {
  if (!existsSync(dir)) return [];
  const out: SkillDef[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const folder = join(dir, e.name);
    const file = ["SKILL.md", "skill.md"].map((f) => join(folder, f)).find((f) => existsSync(f));
    if (!file) continue;
    try {
      const { meta, body } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = str(meta.name, e.name);
      out.push({ name, command: slugRole(str(meta.command, name)) || slugRole(e.name), description: str(meta.description).slice(0, 1024), body,
        dir: folder, files: listFiles(folder).filter((f) => f.toLowerCase() !== "skill.md"), source });
    } catch { /* unreadable skill: skipped */ }
  }
  return out;
}

function listFiles(root: string, rel = "", depth = 0, out: string[] = []): string[] {
  if (depth > 3 || out.length >= 60) return out;
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(root, r, depth + 1, out); else out.push(r);
    if (out.length >= 60) break;
  }
  return out;
}

/** The skills index an agent sees on a new session: names and one-line descriptions only. */
export function skillsIndex(skills: SkillDef[], max = 30): string {
  const list = skills.filter((k) => k.dir).slice(0, max);
  if (!list.length) return "";
  return ["## Skills", "Packaged instructions for specific tasks. When one fits what you are doing, load it with use_skill (name) before you start, and follow it.",
    ...list.map((k) => `- ${k.name}: ${k.description.replace(/\s+/g, " ").slice(0, 200)}`)].join("\n");
}

export const ROLE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const HARNESSES = ["copilot", "opencode", "cursor", "claude", "pi", "duo", "mock"];

export interface RoleValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  role: RoleDef | null;
}

/** Validate an agent definition (imported by users or written by their LLM). */
export function validateRole(src: string, knownTools: string[], builtinNames: string[], knownSkills: string[] = []): RoleValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/^\s*---\r?\n[\s\S]*?\r?\n---/.test(src)) {
    return { ok: false, errors: ["Missing the --- header block at the top (see the template)."], warnings, role: null };
  }
  const { meta } = parseFrontmatter(src.trimStart());
  const role = parseRole(src.trimStart(), str(meta.name), "user");
  if (!meta.name) errors.push("`name` is required.");
  else if (!ROLE_NAME_RE.test(role.name)) errors.push("`name` must be 2–41 chars: lowercase letters, digits, dashes, starting with a letter.");
  if (!meta.title) errors.push("`title` is required.");
  if (role.prompt.length < 20) errors.push("The instructions below the header are missing or too short.");
  if (role.prompt.includes("Write the agent's instructions here")) warnings.push("The instructions still contain template placeholder text.");
  if (role.name === "my-agent") warnings.push("`name` is still the template default (my-agent).");
  if (role.maxResultTokens < 50 || role.maxResultTokens > 4000) errors.push("`maxResultTokens` must be between 50 and 4000.");
  if (role.harness && !HARNESSES.includes(role.harness)) errors.push(`\`harness\` must be one of ${HARNESSES.join(", ")}.`);
  for (const t of role.tools) if (!knownTools.includes(t)) warnings.push(`Tool server "${t}" is not installed/known — it will be ignored until it exists.`);
  for (const k of role.skills) if (knownSkills.length && !knownSkills.includes(k)) warnings.push(`Skill "${k}" is unknown and will be ignored.`);
  if (builtinNames.includes(role.name)) warnings.push(`Overrides the built-in agent "${role.name}".`);
  if (role.prompt.length > 12000) warnings.push("Long instructions cost tokens on every session — consider trimming.");
  return { ok: errors.length === 0, errors, warnings, role: errors.length ? null : role };
}

/** A role an agent defines at run time (coordinator's `create_agent` / text-mode AGENT block). */
export interface AgentSpec {
  name: string; title?: string; description?: string; icon?: string; instructions: string;
  tools?: string[]; harness?: string; model?: string; skills?: string[]; maxResultTokens?: number; local?: boolean;
}

export const slugRole = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

/** The role file for a spec (same format as agents/*.md), marked as created by an agent. */
export function roleMarkdown(spec: AgentSpec, createdBy: string): string {
  const name = slugRole(spec.name);
  const title = (spec.title || name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())).replace(/\n/g, " ");
  const lines = [
    "---", `name: ${name}`, `title: ${title}`, `icon: ${(spec.icon || "🧩").replace(/\n/g, "")}`,
    `description: ${(spec.description || title).replace(/\n/g, " ").slice(0, 200)}`,
    `tools: [${["flashmaster-core", ...(spec.tools ?? []).filter((t) => t !== "flashmaster-core")].join(", ")}]`,
    ...(spec.harness ? [`harness: ${spec.harness}`] : []), ...(spec.model ? [`model: ${spec.model}`] : []),
    ...(spec.local ? ["local: true"] : []),
    ...(spec.skills?.length ? [`skills: [${spec.skills.join(", ")}]`] : []),
    `maxResultTokens: ${spec.maxResultTokens ?? 400}`, `createdBy: ${createdBy}`, "---",
    spec.instructions.trim(), "",
  ];
  return lines.join("\n");
}
