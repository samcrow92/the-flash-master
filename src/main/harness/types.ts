import type { HarnessId, HarnessStatus, ModelInfo } from "@shared/types";
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
  | { type: "plan"; entries: { title: string; status: "pending" | "in_progress" | "completed" | "failed" }[] }
  | { type: "log"; text: string };

export interface TurnResult {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "refusal" | "error" | string;
  usage?: { tokensIn: number; tokensOut: number };
  error?: string;
}

export interface PromptAttachment {
  kind: "image" | "file";
  name: string;
  mime: string;
  path: string;
}

export interface SessionOptions {
  cwd: string;
  model: string | null;
  thinking?: string | null; // reasoning effort: minimal | low | medium | high | xhigh
  extraArgs: string;
  executable: string | null; // resolved path override
  mcpServers: McpServerSpec[];
  env: Record<string, string>;
  resumeSessionId: string | null;
  policy: { approval: ApprovalPolicy; readOnly: boolean; blocked: string[]; projectRoot: string | null; extraRoots?: string[] };
  onEvent: (e: HarnessEvent) => void;
  /** Ask the user (returns true = allow). Only called when policy says "ask". */
  askPermission: (r: PermissionRequest) => Promise<boolean>;
}

export interface HarnessSession {
  readonly sessionId: string | null;
  /** Models reported while the session started (ACP), so the cache refreshes for free. */
  readonly models?: ModelInfo[];
  prompt(text: string, attachments?: PromptAttachment[]): Promise<TurnResult>;
  /** Inject a message into the running turn. Only harnesses with native support implement it (Pi `steer`). */
  steer?(text: string): Promise<boolean>;
  cancel(): Promise<void>;
  close(): void;
  readonly alive: boolean;
}

export interface ProbeOptions {
  executable: string | null;
  cwd: string;
  env: Record<string, string>;
  extraArgs: string;
}

export interface HarnessAdapter {
  /** Models this harness can use, as reported by the harness itself. Empty when it cannot tell. */
  listModels?(o: ProbeOptions): Promise<ModelInfo[]>;
  readonly id: HarnessId;
  readonly label: string;
  readonly protocol: HarnessStatus["protocol"];
  detect(pathOverride: string): Promise<HarnessStatus>;
  start(opts: SessionOptions): Promise<HarnessSession>;
}
