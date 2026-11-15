import type { ToolRun } from "@shared/types";

/** Short verb shown on a tool call's badge, so a call reads as a tool call and not as prose. */
const KIND_LABEL: Record<string, string> = {
  execute: "Run", read: "Read", edit: "Edit", delete: "Delete", move: "Move", search: "Search", fetch: "Fetch", think: "Think",
};
export const toolKindLabel = (kind: string): string => KIND_LABEL[kind] ?? "Tool";

/** One-line preview of a call's arguments for the collapsed row; empty when it would only repeat the title. */
export function toolArgsPreview(run: Pick<ToolRun, "title" | "input">, max = 140): string {
  const flat = (run.input ?? "").replace(/\s+/g, " ").trim();
  if (!flat || flat === run.title.trim()) return "";
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Header for a group of calls: "Tool call" / "3 tool calls", plus how many are still running or failed. */
export function toolCallsSummary(tools: Pick<ToolRun, "status">[]): { label: string; detail: string } {
  const n = tools.length;
  const running = tools.filter((t) => t.status === "pending" || t.status === "in_progress").length;
  const failed = tools.filter((t) => t.status === "failed").length;
  const detail = [running && `${running} running`, failed && `${failed} failed`].filter(Boolean).join(" · ");
  return { label: n === 1 ? "Tool call" : `${n} tool calls`, detail };
}
