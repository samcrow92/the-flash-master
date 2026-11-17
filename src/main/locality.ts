/**
 * Agents that must run on a local model. A role (or one delegation) can require local inference; the app then picks a
 * local runtime itself instead of whatever the chat, mode or default harness would be, and never a hosted harness:
 * a "local only" Scout launched on GitLab Duo can only refuse the work.
 */
import type { HarnessId, RoleDef } from "@shared/types";
import type { ModeProfile } from "@shared/settings";

/** Harnesses that can run a model on the user's own machine or server (given a local provider/model). */
export const LOCAL_HARNESSES: HarnessId[] = ["pi", "opencode"];
export const isLocalHarness = (h: string | null | undefined): h is HarnessId => !!h && (LOCAL_HARNESSES as string[]).includes(h);

const LOCAL_TERM = /\b(?:local(?:ly)?[- ](?:inference|model|llm|serving|served|hosted model|backend)s?|on-?prem(?:ise)?s?[- ](?:model|inference|llm)s?|run(?:s|ning)? locally|PI_PROVIDER)\b/i;
const DEMAND = /\b(?:only|must|requires?|required|never|no hosted|not (?:a |any )?hosted|before any|verif(?:y|ied))\b/i;

/** True for instructions that demand local inference ("must run on a verified local model only"), sentence by sentence. */
export function needsLocalInference(text: string): boolean {
  return text.split(/(?<=[.!?])\s+|\n/).some((sentence) => LOCAL_TERM.test(sentence) && DEMAND.test(sentence));
}

export interface LocalPick { harness: HarnessId; model: string; source: "delegation" | "role" | "local-mode" }

/**
 * Where a local-only agent runs: the coordinator's model (on its harness, or a local one), else the role's own local
 * harness and model, else the LOCAL drive mode. Only candidates whose harness is usable count. A harness without a
 * model doesn't count either: Pi and OpenCode would start on their default model, which is often hosted.
 */
export function pickLocalRuntime(o: { role: Pick<RoleDef, "harness" | "model">; pick?: { harness?: HarnessId; model: string | null };
  localMode: ModeProfile | undefined; usable: (h: HarnessId) => boolean }): LocalPick | { error: string } {
  const roleLocal = isLocalHarness(o.role.harness) ? o.role.harness : null;
  const modeLocal = isLocalHarness(o.localMode?.harness) ? o.localMode!.harness as HarnessId : null;
  const candidates: LocalPick[] = [];
  if (o.pick?.model && (!o.pick.harness || isLocalHarness(o.pick.harness))) {
    for (const h of [o.pick.harness, roleLocal, modeLocal, ...LOCAL_HARNESSES]) if (isLocalHarness(h)) candidates.push({ harness: h, model: o.pick.model, source: "delegation" });
  }
  if (roleLocal && o.role.model) candidates.push({ harness: roleLocal, model: o.role.model, source: "role" });
  if (modeLocal && o.localMode?.model) candidates.push({ harness: modeLocal, model: o.localMode.model, source: "local-mode" });
  const found = candidates.find((c) => o.usable(c.harness));
  if (found) return found;
  const why = candidates.length
    ? `the local runtime${candidates.length > 1 ? "s" : ""} it could use (${[...new Set(candidates.map((c) => `${c.harness} · ${c.model}`))].join(", ")}) ${candidates.length > 1 ? "are" : "is"} not available (not installed or disabled in Settings → Harnesses)`
    : "no local model is set up";
  return { error: `it must run on a local model (its instructions require local inference), but ${why}. `
    + "Set Settings → Modes → LOCAL to Pi or OpenCode with the local model (e.g. ollama/qwen3-coder), or delegate with harness pi and model provider/model of a local provider. "
    + "It was not started on a hosted harness, which it would refuse." };
}

/** First-turn note for a local-only agent: what it runs on, so it can check its locality rule without guessing. */
export function localRuntimeNote(harness: HarnessId, model: string | null, source: LocalPick["source"] | null): string {
  const from = source === "local-mode" ? "the user's LOCAL model profile (Settings → Modes → LOCAL)" : source === "role" ? "your role's configured local model" : "the local model the delegating agent chose";
  return `## Runtime (from TheFlashMaster, the launcher)\nYou run on ${harness === "pi" ? "Pi" : "OpenCode"} with model ${model ?? "(default)"}, ${from}. `
    + "TheFlashMaster runs this agent only on a local runtime: it never routes it to a hosted harness (GitLab Duo, Copilot, Cursor, Claude Code)" + (harness === "pi" ? ", " : ". ")
    + (harness === "pi" ? "and Pi fails the start rather than fall back to another model. " : "") + "Treat this as the launcher's evidence for your locality rule and do the task.";
}
