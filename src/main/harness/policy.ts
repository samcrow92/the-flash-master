import { isAbsolute, relative, resolve } from "node:path";
import type { SessionOptions, ToolKind } from "./types";

export type Decision = "allow" | "deny" | "ask";

const READ_KINDS: ToolKind[] = ["read", "search", "think", "fetch"];
const WRITE_KINDS: ToolKind[] = ["edit", "delete", "move", "execute"];

export function decidePermission(policy: SessionOptions["policy"], kind: ToolKind, text: string): Decision {
  const lower = text.toLowerCase();
  if (policy.blocked.some((b) => b.trim() && lower.includes(b.trim().toLowerCase()))) return "deny";
  if (policy.readOnly && WRITE_KINDS.includes(kind)) return "deny";
  if (policy.approval === "auto-all") return "allow";
  if (policy.approval === "auto-read" && READ_KINDS.includes(kind)) return "allow";
  return "ask";
}

/** True when `target` resolves inside `root`. Used to confine fs/* requests to the project folder. */
export function insideRoot(root: string | null, target: string): boolean {
  if (!root) return false;
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const rel = relative(resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
