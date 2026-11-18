#!/usr/bin/env node
/**
 * Build a TheFlashMaster marketplace from plain folders.
 *
 *   node scripts/marketplace/build-index.mjs <marketplace-folder> [--name "Body Electronics"] [--description "…"]
 *
 * Input  <folder>/plugins-src/<plugin-id>/
 *          plugin.json        { "id", "name", "version", "description", "team", "tags": [] }
 *          agents/*.md        custom agents (TheFlashMaster agent format, see agents/_template.md)
 *          workflows/*.md     workflows (header needs `command:`; used as /command in chats)
 *          skills/*.md        skills, installed like workflows (command = header `command:` or the file name)
 *          scripts/*          helper scripts (.py .ps1 .sh .js .mjs .bat .cmd .txt .json .yml .yaml, ≤ 200 KB each); installed under
 *                             <dataDir>/plugins/<id>/scripts/ and listed in the plugin's instructions so agents can run them
 *          instructions.md    team instructions added to every agent's rules (optional)
 *          mcp.json           [{ "id", "label", "command", "args", "env" }] tool servers (optional, opt-in per user policy)
 *          exam.json          team EXAM setup (optional): { "pluginPackage": "files/exam-restapi.zip", "targetEndpoint", "licenseHost",
 *                             "licensePort", "modelName", "systemConfig", "reportProject", … } — fills empty Settings → EXAM fields
 *                             and installs the RESTapi plugin. A relative pluginPackage is served from this marketplace folder.
 * Output <folder>/index.json and <folder>/plugins/<id>-<version>.json (with sha256 in the index)
 * Serve  cd <folder> && python -m http.server 8080      → add http://<this-PC-IP>:8080 in Settings → Marketplace
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Buffer } from "node:buffer";

const args = process.argv.slice(2);
const root = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const srcDir = join(root, "plugins-src");
if (!existsSync(srcDir)) { console.error(`✖ ${srcDir} not found`); process.exit(1); }
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
// Same rules as the app (src/main/marketplace.ts: FILE_RE, SCRIPT_RE, MAX_SCRIPT).
const FILE_RE = /^[\w.-]+\.md$/;
const SCRIPT_RE = /^[\w.-]+\.(py|ps1|sh|js|mjs|bat|cmd|txt|json|ya?ml)$/;
const MAX_SCRIPT = 200_000;
const readFiles = (dir, re) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f) && statSync(join(dir, f)).isFile()).sort().map((file) => ({ file, content: readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n") })) : []);
const readMd = (dir) => readFiles(dir, FILE_RE);

const prev = existsSync(join(root, "index.json")) ? JSON.parse(readFileSync(join(root, "index.json"), "utf8")) : {};
mkdirSync(join(root, "plugins"), { recursive: true });
const plugins = [];
let failed = false;
for (const id of readdirSync(srcDir).sort()) {
  const dir = join(srcDir, id);
  const metaFile = join(dir, "plugin.json");
  if (!existsSync(metaFile)) continue;
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  const problems = [];
  if (!ID_RE.test(meta.id ?? "")) problems.push("plugin.json: id must be lowercase letters/digits/.-_ (2-64 chars)");
  if (meta.id !== id) problems.push(`plugin.json id "${meta.id}" must match the folder name "${id}"`);
  if (!/^\d+\.\d+\.\d+/.test(meta.version ?? "")) problems.push("plugin.json: version must be semver, e.g. 1.0.0");
  const agents = readMd(join(dir, "agents"));
  const workflows = readMd(join(dir, "workflows"));
  const skills = readMd(join(dir, "skills"));
  const scripts = readFiles(join(dir, "scripts"), SCRIPT_RE);
  if (existsSync(join(dir, "scripts"))) for (const f of readdirSync(join(dir, "scripts"))) if (!SCRIPT_RE.test(f)) problems.push(`scripts/${f}: file type not allowed (${SCRIPT_RE.source})`);
  for (const x of scripts) if (Buffer.byteLength(x.content) > MAX_SCRIPT) problems.push(`scripts/${x.file}: larger than ${MAX_SCRIPT / 1000} KB`);
  for (const a of agents) if (!/^---\n(?:[\s\S]*?\n)?name:\s*[a-z][a-z0-9-]+[\s\S]*?\n---/.test(a.content)) problems.push(`agents/${a.file}: needs a --- header with name: (see agents/_template.md)`);
  for (const w of workflows) if (!/^---\n(?:[\s\S]*?\n)?command:\s*[a-z][a-z0-9-]+[\s\S]*?\n---/.test(w.content)) problems.push(`workflows/${w.file}: needs a --- header with command:`);
  for (const k of skills) {
    const cmd = (/^---\n(?:[\s\S]*?\n)?command:\s*([^\n]+)/.exec(k.content)?.[1] ?? k.file.replace(/\.md$/, "")).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(cmd)) problems.push(`skills/${k.file}: command "${cmd}" must be lowercase letters, digits and dashes (set command: or rename the file)`);
  }
  const instructions = existsSync(join(dir, "instructions.md")) ? readFileSync(join(dir, "instructions.md"), "utf8").replace(/\r\n/g, "\n") : "";
  const mcpServers = existsSync(join(dir, "mcp.json")) ? JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")) : [];
  const exam = existsSync(join(dir, "exam.json")) ? JSON.parse(readFileSync(join(dir, "exam.json"), "utf8")) : null;
  if (exam?.pluginPackage && !/^(https?:|\\\\|[a-z]:)/i.test(exam.pluginPackage) && !existsSync(join(root, exam.pluginPackage)))
    problems.push(`exam.json: pluginPackage "${exam.pluginPackage}" not found in the marketplace folder`);
  if (problems.length) { failed = true; console.error(`✖ ${id}\n  - ${problems.join("\n  - ")}`); continue; }
  const pkg = { id: meta.id, name: meta.name ?? meta.id, version: meta.version, description: meta.description ?? "", team: meta.team ?? "",
    agents, workflows, ...(skills.length ? { skills } : {}), ...(scripts.length ? { scripts } : {}), ...(instructions.trim() ? { instructions } : {}), ...(mcpServers.length ? { mcpServers } : {}), ...(exam ? { exam } : {}) };
  const body = JSON.stringify(pkg, null, 2);
  const file = `plugins/${meta.id}-${meta.version}.json`;
  writeFileSync(join(root, file), body);
  const kinds = [agents.length && "agent", workflows.length && "workflow", skills.length && "skill", scripts.length && "script", instructions.trim() && "instructions", mcpServers.length && "mcp", exam && "exam"].filter(Boolean);
  plugins.push({ id: meta.id, name: pkg.name, version: meta.version, description: pkg.description, team: pkg.team, kinds, tags: meta.tags ?? [],
    package: file, sha256: createHash("sha256").update(body).digest("hex"), updated: new Date().toISOString().slice(0, 10) });
  console.log(`✔ ${meta.id}@${meta.version}: ${agents.length} agent(s), ${workflows.length} workflow(s)${skills.length ? `, ${skills.length} skill(s)` : ""}${scripts.length ? `, ${scripts.length} script(s)` : ""}${instructions.trim() ? ", instructions" : ""}${mcpServers.length ? `, ${mcpServers.length} MCP server(s)` : ""}`);
}
const index = { name: opt("name") ?? prev.name ?? "Team marketplace", description: opt("description") ?? prev.description ?? "", plugins };
writeFileSync(join(root, "index.json"), JSON.stringify(index, null, 2));
console.log(`\nindex.json written with ${plugins.length} plugin(s). Serve it with:  cd "${root}" && python -m http.server 8080`);
process.exit(failed ? 1 : 0);
