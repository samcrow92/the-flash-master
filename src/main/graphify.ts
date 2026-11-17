/**
 * Code graph for a project's knowledge base, built on demand with graphify (https://github.com/Graphify-Labs/graphify,
 * Apache-2.0; installed from PyPI as `graphifyy` into the app's own Python environment, never vendored).
 *
 * "Scan code" runs `graphify update .` in the project: a local tree-sitter pass, no LLM and no API key. The graph,
 * its cache and the interactive graph.html stay local in `<project>/.flashmaster/graphify` (ignored by git). Its report
 * is summarised into the knowledge base entry `code-map`, which syncs to `.flashmaster/knowledge/code-map.md` like
 * every entry, so the team shares it and agents get it in recall. Agents ask the full graph with the code_graph tool.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CodeGraphStatus } from "@shared/types";
import type { Db } from "./db";
import { ensureFlashmasterIgnore, type KnowledgeBase } from "./knowledge";
import { MAX_KNOWLEDGE_CHARS } from "./memory";
import { runCapture } from "./harness/process";

/** PyPI name (the `graphify` name is being reclaimed upstream; the CLI and module are still `graphify`). */
export const GRAPHIFY_PACKAGE = "graphifyy";
export const GRAPHIFY_MIN_PYTHON: [number, number] = [3, 11];
/** Knowledge base entry that holds the summary. */
export const CODE_MAP_SLUG = "code-map";
/** Repo-relative output folder (inside .flashmaster, which git ignores except for the knowledge folder). */
export const GRAPH_DIR = ".flashmaster/graphify";

export const CODE_GRAPH_COMMANDS = ["query", "explain", "path", "god_nodes", "affected"] as const;
export type CodeGraphCommand = (typeof CODE_GRAPH_COMMANDS)[number];

type Run = typeof runCapture;

export interface CodeGraphDeps {
  db: Db;
  knowledge: KnowledgeBase;
  /** graphify's Python if installed, else null. */
  python: () => string | null;
  /** Install graphify (first scan only) and return its Python; pip's output goes to onOutput as it comes. */
  install: (onPhase: (phase: string) => void, onOutput?: (chunk: string) => void) => Promise<string>;
  run?: Run;
  onStatus?: (s: CodeGraphStatus) => void;
}

/** Where graphify's scan output says it is (0…1), or undefined for a line that doesn't tell. */
export function scanProgress(line: string): number | undefined {
  const ext = /AST extraction:\s*(\d+)\s*\/\s*(\d+)/.exec(line);
  if (ext && Number(ext[2]) > 0) return 0.08 + 0.77 * Math.min(1, Number(ext[1]) / Number(ext[2]));
  if (/AST cache:/.test(line)) return 0.08;
  if (/not classified|Updating code graph/.test(line)) return 0.04;
  if (/Rebuilt:|No code-graph topology|graph\.json, graph\.html|Code graph updated/.test(line)) return 0.9;
  return undefined;
}

/** pip's current step in plain words ("Downloading tree-sitter-cpp…"), or undefined. */
export function pipStep(line: string): string | undefined {
  const m = /^\s*(Collecting|Downloading|Installing collected packages|Building wheel for|Using cached)\s*:?\s*([^\s(]*)/.exec(line);
  if (!m) return undefined;
  if (m[1] === "Installing collected packages") return "Installing packages…";
  const pkg = m[2]!.replace(/^.*\//, "").replace(/-\d.*$/, "").replace(/[<>=!~;[].*$/, "");
  return `${m[1] === "Using cached" || m[1] === "Collecting" ? "Getting" : m[1]} ${pkg || "packages"}…`;
}

/** Calls onLine for each complete line of streamed output (\n or \r: progress lines often rewrite themselves). */
function lines(onLine: (l: string) => void): (chunk: string) => void {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    const parts = buf.split(/\r\n|\r|\n/);
    buf = parts.pop() ?? "";
    for (const l of parts) if (l.trim()) onLine(l);
  };
}

interface GraphMeta { nodes: number; edges: number; communities: number; commit: string | null; version: string | null }

/** Counts of a graph.json (networkx node-link data). */
export function graphMeta(raw: string): GraphMeta {
  const j = JSON.parse(raw);
  const nodes: any[] = Array.isArray(j?.nodes) ? j.nodes : [];
  const edges: any[] = Array.isArray(j?.links) ? j.links : Array.isArray(j?.edges) ? j.edges : [];
  const communities = new Set(nodes.map((n) => n?.community).filter((c) => c !== undefined && c !== null)).size;
  const commit = typeof j?.built_at_commit === "string" && /^[0-9a-f]{7,64}$/i.test(j.built_at_commit) ? j.built_at_commit : null;
  return { nodes: nodes.length, edges: edges.length, communities, commit, version: typeof j?.graph?.graphify_version === "string" ? j.graph.graphify_version : null };
}

/** `## Heading` → body, in order. */
function sections(md: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = md.replace(/\r\n?/g, "\n").split(/^## /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const head = (nl < 0 ? p : p.slice(0, nl)).trim();
    out.set(head.replace(/\s*\(.*\)\s*$/, "").toLowerCase(), (nl < 0 ? "" : p.slice(nl + 1)).trim());
  }
  return out;
}

/** "### Community 3 - "acp.ts"\nCohesion…\nNodes (36): a, b (+28 more)" → "- **acp.ts** (36): a, b (+28 more)". */
function communityLines(body: string): string[] {
  const out: string[] = [];
  for (const block of body.split(/^### /m).slice(1)) {
    const name = /^Community\s+\S+\s*-\s*"?(.*?)"?\s*$/m.exec(block)?.[1] ?? block.split("\n")[0]!.trim();
    const nodes = /^Nodes\s*\((\d+)\):\s*(.*)$/m.exec(block);
    out.push(nodes ? `- **${name}** (${nodes[1]}): ${nodes[2]!.trim()}` : `- **${name}**`);
  }
  return out;
}

/**
 * The knowledge entry for a graphify report. Deterministic for a given report (no timestamps), so two teammates
 * scanning the same commit write the same file. Communities come last and are cut to fit the entry size limit.
 */
export function codeMapEntry(report: string, meta: GraphMeta, limit = MAX_KNOWLEDGE_CHARS - 200): string {
  const sec = sections(report);
  const head = [
    "# Code map (graphify)", "",
    `Generated by graphify${meta.commit ? ` from commit ${meta.commit.slice(0, 10)}` : ""}: `
      + `${meta.nodes} symbols, ${meta.edges} relations and ${meta.communities} communities, from a local AST pass (no LLM). `
      + "Agents ask the full graph with the code_graph tool (query, explain, path, god_nodes, affected). "
      + "Rescan with Scan code on the Memory page; a rescan replaces this entry, so don't edit it by hand. "
      + "Tool: https://github.com/Graphify-Labs/graphify", "",
  ];
  const pick = (key: string, title: string) => {
    const body = sec.get(key);
    return body ? [`## ${title}`, "", body.replace(/^_.*_\s*\n+/, ""), ""] : [];
  };
  const parts = [
    ...head,
    ...pick("god nodes", "Most connected (core abstractions)"),
    ...pick("surprising connections", "Surprising connections"),
    ...pick("import cycles", "Import cycles"),
    ...pick("suggested questions", "Questions the graph answers well"),
  ];
  let text = parts.join("\n").trimEnd();
  if (text.length > limit) text = `${text.slice(0, limit).replace(/\n[^\n]*$/, "")}\n\n…`;
  const comms = communityLines(sec.get("communities") ?? "");
  if (comms.length) {
    const lines = ["", "", "## Communities (modules that belong together)", ""];
    let size = text.length + lines.join("\n").length;
    let shown = 0;
    for (const l of comms) {
      if (size + l.length + 1 > limit - 40) break;
      lines.push(l);
      size += l.length + 1;
      shown++;
    }
    if (shown) {
      if (shown < comms.length) lines.push(`- … and ${comms.length - shown} more (ask code_graph)`);
      text += lines.join("\n");
    }
  }
  return `${text}\n`;
}

export class CodeGraph {
  private running = new Map<string, string>();
  private progress = new Map<string, number | null>();
  private errors = new Map<string, string>();
  private run: Run;

  constructor(private d: CodeGraphDeps) {
    this.run = d.run ?? runCapture;
  }

  private project(projectId: string) {
    const p = this.d.db.getProject(projectId);
    if (!p) throw new Error("the code graph needs a project folder: open a project chat");
    return p;
  }

  outDir(projectId: string): string {
    return join(this.project(projectId).path, ".flashmaster", "graphify");
  }

  status(projectId: string): CodeGraphStatus {
    const out = this.outDir(projectId);
    const file = join(out, "graph.json");
    let graph: CodeGraphStatus["graph"] = null;
    try { graph = { ...graphMeta(readFileSync(file, "utf8")), at: statSync(file).mtimeMs }; } catch { /* no graph yet */ }
    const html = join(out, "graph.html");
    const running = this.running.get(projectId) ?? null;
    return { projectId, installed: !!this.d.python(), running, progress: running ? this.progress.get(projectId) ?? null : null, graph, error: this.errors.get(projectId) ?? null, html: existsSync(html) ? html : null };
  }

  /** Report a step; progress undefined keeps the current value, null = can't be measured. Unchanged reports are dropped. */
  private phase(projectId: string, phase: string | null, progress?: number | null): void {
    const p = progress === undefined ? this.progress.get(projectId) ?? null : progress === null ? null : Math.round(Math.min(1, Math.max(0, progress)) * 100) / 100;
    if (phase && this.running.get(projectId) === phase && this.progress.get(projectId) === p) return;
    if (phase) { this.running.set(projectId, phase); this.progress.set(projectId, p); } else { this.running.delete(projectId); this.progress.delete(projectId); }
    this.d.onStatus?.(this.status(projectId));
  }

  /** Scan the project's code with graphify (installing it the first time) and write the code-map knowledge entry. */
  async scan(projectId: string): Promise<CodeGraphStatus> {
    const p = this.project(projectId);
    if (this.running.has(projectId)) throw new Error("a scan of this project is already running");
    this.errors.delete(projectId);
    try {
      this.phase(projectId, "Starting…", 0);
      const py = this.d.python() ?? await this.d.install((ph) => this.phase(projectId, `${ph} (first scan only)`, null),
        lines((l) => { const step = pipStep(l); if (step) this.phase(projectId, `Installing graphify: ${step}`, null); }));
      const out = this.outDir(projectId);
      mkdirSync(out, { recursive: true });
      ensureFlashmasterIgnore(p.path); // the graph and its cache stay out of git
      // graphify reads per-folder ignore files: keep it out of .flashmaster (its own output, the knowledge files).
      const ignore = join(p.path, ".flashmaster", ".graphifyignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "# TheFlashMaster: graphify skips this folder (its output and the knowledge base live here).\n*\n");
      this.phase(projectId, "Scanning the code…", 0.02);
      const r = await this.run(py, ["-m", "graphify", "update", ".", "--force"], 30 * 60_000, p.path,
        { GRAPHIFY_OUT: out, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        lines((l) => {
          const at = scanProgress(l);
          if (at === undefined) return;
          const files = /AST extraction:\s*(\d+)\s*\/\s*(\d+)/.exec(l);
          this.phase(projectId, files ? `Scanning the code: ${files[1]} of ${files[2]} files` : at >= 0.9 ? "Building the graph…" : "Scanning the code…", at);
        }));
      if (r.code !== 0) throw new Error(`graphify failed${r.code === null ? " (timed out)" : ""}: ${r.out.trim().split(/\r?\n/).slice(-4).join(" ").slice(-400) || `exit ${r.code}`}`);
      let report: string, meta: GraphMeta;
      try {
        report = readFileSync(join(out, "GRAPH_REPORT.md"), "utf8");
        meta = graphMeta(readFileSync(join(out, "graph.json"), "utf8"));
      } catch {
        throw new Error(`graphify wrote no graph: ${r.out.trim().split(/\r?\n/).slice(-3).join(" ").slice(-300)}`);
      }
      this.phase(projectId, "Writing the knowledge base…", 0.96);
      this.d.knowledge.write(projectId, { slug: CODE_MAP_SLUG, content: codeMapEntry(report, meta), kind: "fact", tags: ["code-map", "graphify", "architecture"], importance: 4 },
        { role: null });
    } catch (e: any) {
      this.errors.set(projectId, String(e?.message ?? e));
      throw e;
    } finally {
      this.phase(projectId, null);
    }
    return this.status(projectId);
  }

  /** Ask the project's graph (agents' code_graph tool). Output is graphify's compact text, capped by the token budget. */
  async ask(projectId: string, cmd: CodeGraphCommand, a: { question?: string; node?: string; from?: string; to?: string; budget?: number; top?: number }): Promise<string> {
    const p = this.project(projectId);
    const py = this.d.python();
    if (!py) throw new Error("graphify is not installed: ask the user to press Scan code on the Memory page (Knowledge base)");
    const graph = join(this.outDir(projectId), "graph.json");
    if (!existsSync(graph)) throw new Error("this project has no code graph yet: ask the user to press Scan code on the Memory page (Knowledge base)");
    const need = (v: unknown, what: string) => { const s = String(v ?? "").trim(); if (!s) throw new Error(`${cmd} needs ${what}`); return s; };
    const budget = String(Math.min(8000, Math.max(200, Math.round(Number(a.budget) || 1500))));
    const args = cmd === "query" ? ["query", need(a.question, "a question"), "--budget", budget]
      : cmd === "explain" ? ["explain", need(a.node, "a node (symbol, file or label)")]
      : cmd === "path" ? ["path", need(a.from, "from"), need(a.to, "to"), "--undirected"]
      : cmd === "affected" ? ["affected", need(a.node, "a node (symbol, file or label)")]
      : ["god-nodes", "--top", String(Math.min(50, Math.max(1, Math.round(Number(a.top) || 15))))];
    const r = await this.run(py, ["-m", "graphify", ...args, "--graph", graph], 120_000, p.path, { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });
    const text = r.out.replace(/^\[graphify\] note:.*\n?/gm, "").trim();
    // 3: ambiguous name (candidates listed), 4: no match. Both are answers the agent can act on.
    if (r.code !== 0 && r.code !== 3 && r.code !== 4) throw new Error(`graphify ${args[0]} failed: ${text.slice(-400) || `exit ${r.code}`}`);
    return text.length > 24_000 ? `${text.slice(0, 24_000)}\n… (cut: narrow the question or lower the budget)` : text;
  }
}
