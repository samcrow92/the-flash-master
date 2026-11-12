import type { HarnessId, HarnessStatus } from "@shared/types";
import type { ApprovalPolicy } from "@shared/settings";

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

export interface PermissionRequest {
  title: string;
  kind: ToolKind;
  detail: string;
}

export type HarnessEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; title: string; status: string; kind: ToolKind }
  | { type: "plan"; entries: string[] }
  | { type: "log"; text: string };

export interface TurnResult {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "refusal" | "error" | string;
  usage?: { tokensIn: number; tokensOut: number };
  error?: string;
}

export interface SessionOptions {
  cwd: string;
  model: string | null;
  extraArgs: string;
  executable: string | null; // resolved path override
  mcpServers: McpServerSpec[];
  env: Record<string, string>;
  resumeSessionId: string | null;
  policy: { approval: ApprovalPolicy; readOnly: boolean; blocked: string[]; projectRoot: string | null };
  onEvent: (e: HarnessEvent) => void;
  /** Ask the user (returns true = allow). Only called when policy says "ask". */
  askPermission: (r: PermissionRequest) => Promise<boolean>;
}

export interface HarnessSession {
  readonly sessionId: string | null;
  prompt(text: string): Promise<TurnResult>;
  cancel(): Promise<void>;
  close(): void;
  readonly alive: boolean;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly label: string;
  readonly protocol: HarnessStatus["protocol"];
  detect(pathOverride: string): Promise<HarnessStatus>;
  start(opts: SessionOptions): Promise<HarnessSession>;
}
