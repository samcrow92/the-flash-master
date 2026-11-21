/**
 * Each agent's working state (goal, decisions, done, next, files, open questions, notes). The agent keeps it current with
 * update_state; the app adds the goal and the files it edits. A fresh session (after a rollover, a crash or an idle close)
 * gets it in its first prompt, so it picks up where the last session left off instead of starting from the brief.
 */
import type { AgentState } from "@shared/types";

const LIST_MAX = 25;
const ITEM_MAX = 300;

export function emptyState(goal = ""): AgentState {
  return { goal, decisions: [], done: [], next: [], files: [], questions: [], notes: "", updatedAt: 0 };
}

const list = (v: unknown): string[] | undefined => Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, ITEM_MAX)).filter(Boolean)
  : typeof v === "string" && v.trim() ? v.split("\n").map((x) => x.replace(/^\s*[-*]\s*/, "").trim().slice(0, ITEM_MAX)).filter(Boolean) : undefined;

/**
 * Merge an update. `decisions`, `done` and `files` add to what is there (deduplicated, newest kept); `next` and
 * `questions` replace (they are the current to-do); `notes` replaces; `goal` replaces when given.
 */
export function mergeState(prev: AgentState | null, u: Record<string, unknown>, now = Date.now()): AgentState {
  const s = prev ? { ...prev } : emptyState();
  const add = (a: string[], b: string[] | undefined) => b ? [...new Set([...a.filter((x) => !b.includes(x)), ...b])].slice(-LIST_MAX) : a;
  s.decisions = add(s.decisions, list(u.decisions));
  s.done = add(s.done, list(u.done));
  s.files = add(s.files, list(u.files));
  const next = list(u.next); if (next) s.next = next.slice(0, LIST_MAX);
  const qs = list(u.questions); if (qs) s.questions = qs.slice(0, LIST_MAX);
  if (typeof u.notes === "string") s.notes = u.notes.trim().slice(0, 2000);
  if (typeof u.goal === "string" && u.goal.trim()) s.goal = u.goal.trim().slice(0, 2000);
  s.updatedAt = now;
  return s;
}

export function isEmpty(s: AgentState | null): boolean {
  return !s || (!s.decisions.length && !s.done.length && !s.next.length && !s.files.length && !s.questions.length && !s.notes);
}

/** The state as a prompt section ("" when there is nothing beyond the goal). */
export function renderState(s: AgentState | null): string {
  if (isEmpty(s)) return "";
  const sec = (h: string, xs: string[]) => xs.length ? `${h}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "";
  return ["## Your working state (from your earlier session; continue from here)",
    s!.goal ? `Goal: ${s!.goal}` : "", sec("Done", s!.done), sec("Decisions", s!.decisions), sec("Next", s!.next), sec("Files you touched", s!.files),
    sec("Open questions", s!.questions), s!.notes ? `Notes: ${s!.notes}` : ""].filter(Boolean).join("\n\n");
}

export const STATE_RULES = "Keep your working state current with update_state (done, decisions, next, open questions) after each meaningful step: "
  + "if your session is restarted to save context, that state is what you continue from.";
