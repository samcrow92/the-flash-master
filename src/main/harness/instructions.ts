/**
 * Instruction isolation: run harnesses with TheFlashMaster's instructions only ("clean" mode), instead of whatever
 * AGENTS.md / custom rules / skills / extensions each CLI preloads. Logins are never touched.
 *
 *  copilot  → --no-custom-instructions (repo AGENTS.md/CLAUDE.md/.github instructions and ~/.copilot instructions)
 *  opencode → OPENCODE_DISABLE_CLAUDE_CODE=1; OPENCODE_DISABLE_PROJECT_CONFIG=1 (project AGENTS.md);
 *             XDG_CONFIG_HOME → app-managed folder with a copy of the user's global opencode config minus
 *             `instructions` and without the global AGENTS.md (auth lives in XDG_DATA_HOME, unaffected)
 *  cursor   → no switch exists: partial (AGENTS.md and .cursor/rules still load; precedence statement in the prompt)
 *  claude   → no switch in the ACP bridge: partial (CLAUDE.md and ~/.claude settings still load; precedence statement)
 *  pi       → --no-context-files --no-skills --no-extensions --no-prompt-templates
 *  duo      → no switch exists: partial (TheFlashMaster's precedence statement in the prompt)
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "@shared/types";

export type InstructionMode = "clean" | "harness";

export interface InstructionSetup {
  args: string[];
  env: Record<string, string>;
  coverage: "full" | "partial" | "none";
  note: string;
}

export interface InstructionOptions {
  mode: InstructionMode;
  keepProject: boolean;
  dataDir: string;
  env?: NodeJS.ProcessEnv; // for tests
}

export function prepareInstructions(h: HarnessId, o: InstructionOptions): InstructionSetup {
  const none: InstructionSetup = { args: [], env: {}, coverage: "none", note: "Harness defaults (its own instruction files are loaded)." };
  if (o.mode !== "clean") return none;
  switch (h) {
    case "copilot":
      return o.keepProject
        ? { args: [], env: {}, coverage: "partial", note: "Copilot cannot keep project instructions without also loading ~/.copilot instructions — both stay on." }
        : { args: ["--no-custom-instructions"], env: {}, coverage: "full", note: "--no-custom-instructions: AGENTS.md, CLAUDE.md, .github instructions and ~/.copilot instructions are ignored." };
    case "opencode": {
      const env: Record<string, string> = { OPENCODE_DISABLE_CLAUDE_CODE: "1" };
      if (!o.keepProject) env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
      const clean = cleanOpencodeConfig(o.dataDir, o.env ?? process.env);
      if (clean.ok) env.XDG_CONFIG_HOME = clean.dir;
      return {
        args: [], env, coverage: clean.ok ? "full" : "partial",
        note: clean.ok
          ? `Global AGENTS.md and config instructions removed (clean config in ${clean.dir})${o.keepProject ? "; project AGENTS.md kept" : "; project AGENTS.md/config ignored"}; ~/.claude compatibility off.`
          : `Could not prepare a clean global config (${clean.error}); project and ~/.claude instructions are off, the global AGENTS.md may still load.`,
      };
    }
    case "pi":
      return {
        args: [...(o.keepProject ? [] : ["--no-context-files"]), "--no-skills", "--no-extensions", "--no-prompt-templates"],
        env: {}, coverage: "full",
        note: `Pi skills, extensions and prompt templates off${o.keepProject ? "; AGENTS.md/CLAUDE.md context files kept" : "; AGENTS.md/CLAUDE.md context files off"}.`,
      };
    case "cursor":
      return { args: [], env: {}, coverage: "partial", note: "Cursor Agent has no switch to skip AGENTS.md and .cursor/rules; TheFlashMaster's instructions are given precedence in the prompt." };
    case "claude":
      return { args: [], env: {}, coverage: "partial", note: "The Claude Code ACP bridge always loads CLAUDE.md and ~/.claude settings; TheFlashMaster's instructions are given precedence in the prompt." };
    case "duo":
      return { args: [], env: {}, coverage: "partial", note: "GitLab Duo has no switch to skip chat-rules.md/AGENTS.md; TheFlashMaster's instructions are given precedence in the prompt." };
    default:
      return { args: [], env: {}, coverage: "full", note: "Built-in mock harness has no instructions of its own." };
  }
}

/** Copy the user's global OpenCode config (providers, models, permissions…) without `instructions` and without AGENTS.md. */
export function cleanOpencodeConfig(dataDir: string, env: NodeJS.ProcessEnv): { ok: boolean; dir: string; error?: string } {
  const dir = join(dataDir, "harness-config", "opencode-clean");
  const target = join(dir, "opencode");
  try {
    const src = join(env.XDG_CONFIG_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".config"), "opencode");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    if (existsSync(src)) {
      for (const f of readdirSync(src)) {
        if (/^agents?\.md$/i.test(f) || /^claude\.md$/i.test(f)) continue; // the instructions we drop
        if (/^(opencode|config)\.jsonc?$/i.test(f)) {
          const cfg = parseJsonc(readFileSync(join(src, f), "utf8"));
          delete cfg.instructions;
          writeFileSync(join(target, f.replace(/\.jsonc$/i, ".json")), JSON.stringify(cfg, null, 2));
        } else if (/^(agent|agents|command|commands|mode|modes|plugin|plugins)$/i.test(f)) {
          continue; // user-level custom agents/commands/plugins carry their own prompts
        } else if (!f.startsWith(".")) {
          try { copyFileSync(join(src, f), join(target, f)); } catch { /* directories and the like are skipped */ }
        }
      }
    }
    return { ok: true, dir };
  } catch (e: any) {
    return { ok: false, dir, error: String(e?.message ?? e) };
  }
}

/** JSON with comments and trailing commas (opencode.jsonc). */
export function parseJsonc(src: string): Record<string, any> {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!, n = src[i + 1];
    if (inStr) { out += c; if (c === "\\") { out += n ?? ""; i++; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1") || "{}");
}
