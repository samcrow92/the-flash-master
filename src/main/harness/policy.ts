import { isAbsolute, relative, resolve } from "node:path";
import { evaluateRules } from "./rules";
import type { SessionOptions, ToolKind } from "./types";

export type Decision = "allow" | "deny" | "ask";

export interface PolicyVerdict {
  decision: Decision;
  /** The rule line that decided (an `ask` rule asks even on Autopilot). */
  rule?: string;
}

const READ_KINDS: ToolKind[] = ["read", "search", "think", "fetch"];
const WRITE_KINDS: ToolKind[] = ["edit", "delete", "move", "execute"];

export function decidePermission(policy: SessionOptions["policy"], kind: ToolKind, text: string, call?: { command?: string | null; paths?: string[] }): Decision {
  return decideCall(policy, kind, text, call).decision;
}

/**
 * Order: legacy blocked substrings and deny rules, then read-only mode, then ask rules (they ask even when everything
 * is auto-approved), then allow rules (they skip asking), then the approval setting.
 */
export function decideCall(policy: SessionOptions["policy"], kind: ToolKind, text: string, call?: { command?: string | null; paths?: string[] }): PolicyVerdict {
  const lower = text.toLowerCase();
  if (policy.blocked.some((b) => b.trim() && lower.includes(b.trim().toLowerCase()))) return { decision: "deny", rule: "blocked commands" };
  const r = policy.rules?.length ? evaluateRules(policy.rules, { kind, command: call?.command, paths: call?.paths, title: text, role: policy.role }) : null;
  if (r?.decision === "deny") return { decision: "deny", rule: r.rule };
  if (policy.readOnly && WRITE_KINDS.includes(kind)) return { decision: "deny", rule: "read-only mode" };
  if (r?.decision === "ask") return { decision: "ask", rule: r.rule };
  if (r?.decision === "allow") return { decision: "allow", rule: r.rule };
  if (policy.approval === "auto-all") return { decision: "allow" };
  if (policy.approval === "auto-read" && READ_KINDS.includes(kind)) return { decision: "allow" };
  return { decision: "ask" };
}

/** True when `target` resolves inside `root`. Used to confine fs/* requests to the project folder. */
export function insideRoot(root: string | null, target: string): boolean {
  if (!root) return false;
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const rel = relative(resolve(root), abs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
