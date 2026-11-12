import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { HarnessId, RoleDef, SkillDef } from "@shared/types";

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
  };
}

function readDir(dir: string): { name: string; src: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: basename(f, ".md"), src: readFileSync(join(dir, f), "utf8") }));
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
