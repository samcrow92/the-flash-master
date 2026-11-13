import type { HarnessId } from "./types";

export interface HarnessSettings {
  enabled: boolean;
  path: string; // empty = auto-detect on PATH
  args: string; // extra CLI args
  defaultModel: string;
}

export type ApprovalPolicy = "ask" | "auto-read" | "auto-all";

export interface Settings {
  general: {
    theme: "dark" | "light" | "system";
    notifications: boolean;
    confirmStop: boolean;
    defaultHarness: HarnessId;
    restoreLastChat: boolean;
  };
  harnesses: Record<HarnessId, HarnessSettings>;
  agents: {
    maxConcurrent: number;
    roleOverrides: Record<string, { harness?: HarnessId; model?: string; maxResultTokens?: number }>;
    delegationDepth: number; // how deep sub-agents may delegate further
    autoTaskFromDelegation: boolean; // create a task per delegation
    instructionMode: "clean" | "harness"; // clean = TheFlashMaster instructions only (harness AGENTS.md/rules/skills off)
    keepProjectInstructions: boolean; // in clean mode, still load the project's AGENTS.md / instruction files
    houseRules: string; // extra rules sent to every agent (your workflow/setup)
  };
  tokens: {
    dailyBudget: number; // 0 = unlimited
    projectBudget: number; // per project per day, 0 = unlimited
    agentBudget: number; // per agent run, 0 = unlimited
    warnAtPercent: number;
    onBudgetExceeded: "pause" | "stop" | "warn";
    compactAfterTokens: number; // rolling compaction threshold for chat context
    keepRecentTurns: number;
    clipOutputChars: number; // larger tool/process outputs become artifacts
    economyHarness: HarnessId | "";
    economyModel: string;
    economyForDelegated: boolean; // run delegated specialists on the economy harness/model
    showTokenCounts: boolean;
  };
  permissions: {
    approval: ApprovalPolicy;
    readOnly: boolean;
    blockedCommands: string; // newline separated substrings
  };
  mcp: {
    autoInstall: boolean;
    pythonPath: string; // empty = auto-detect
    pipIndexUrl: string;
    disabled: string[];
    external: { id: string; label: string; command: string; args: string; env: string }[];
  };
  jazz: {
    enabled: boolean;
    serverUrl: string; // e.g. https://jazz.company.com/ccm
    projectArea: string;
    authType: "form" | "basic";
    username: string;
    hasPassword: boolean; // password stored encrypted via safeStorage, never in settings
    defaultQuery: string;
  };
  marketplace: {
    sources: { id: string; name: string; url: string; department: string; enabled: boolean; hasToken: boolean }[];
    autoCheckUpdates: boolean; // check all marketplaces for updates at startup
    autoUpdate: boolean; // install updates automatically
    requireIntegrity: boolean; // refuse packages whose sha256 does not match the index
    allowMcpServers: boolean; // allow plugins to add MCP servers (they run programs on this PC)
  };
  winidea: {
    installPath: string;
    workspace: string;
    sdkPath: string;
  };
  vector: {
    canoePath: string;
    canoeVersion: string;
    davinciCliPath: string;
    caplIncludePaths: string;
  };
  network: {
    proxy: string;
    noProxy: string;
    caBundlePath: string;
    offline: boolean;
  };
  data: {
    retentionDays: number; // 0 = keep forever
  };
  advanced: {
    logLevel: "error" | "warn" | "info" | "debug";
    devTools: boolean;
    showMockHarness: boolean;
  };
}

const harness = (enabled: boolean, defaultModel = ""): HarnessSettings => ({ enabled, path: "", args: "", defaultModel });

export const DEFAULT_SETTINGS: Settings = {
  general: { theme: "dark", notifications: true, confirmStop: true, defaultHarness: "copilot", restoreLastChat: true },
  harnesses: {
    copilot: harness(true),
    opencode: harness(true),
    pi: harness(true),
    duo: harness(true),
    mock: harness(true),
  },
  agents: { maxConcurrent: 4, roleOverrides: {}, delegationDepth: 2, autoTaskFromDelegation: true, instructionMode: "clean", keepProjectInstructions: false, houseRules: "" },
  tokens: {
    dailyBudget: 0,
    projectBudget: 0,
    agentBudget: 200000,
    warnAtPercent: 80,
    onBudgetExceeded: "pause",
    compactAfterTokens: 24000,
    keepRecentTurns: 6,
    clipOutputChars: 6000,
    economyHarness: "",
    economyModel: "",
    economyForDelegated: false,
    showTokenCounts: true,
  },
  permissions: { approval: "auto-read", readOnly: false, blockedCommands: "rm -rf /\nformat c:\ngit push --force" },
  mcp: { autoInstall: true, pythonPath: "", pipIndexUrl: "", disabled: [], external: [] },
  jazz: {
    enabled: false,
    serverUrl: "",
    projectArea: "",
    authType: "form",
    username: "",
    hasPassword: false,
    defaultQuery: "",
  },
  marketplace: { sources: [], autoCheckUpdates: true, autoUpdate: false, requireIntegrity: true, allowMcpServers: false },
  winidea: { installPath: "", workspace: "", sdkPath: "" },
  vector: { canoePath: "", canoeVersion: "", davinciCliPath: "", caplIncludePaths: "" },
  network: { proxy: "", noProxy: "", caBundlePath: "", offline: false }, // empty = use https_proxy/no_proxy env vars
  data: { retentionDays: 0 },
  advanced: { logLevel: "info", devTools: false, showMockHarness: true },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` onto `base` (arrays replace). Unknown keys are kept so newer files survive downgrades. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeSettings(out[k], v) : v;
  }
  return out as T;
}

/** Flatten to dotted keys ("tokens.dailyBudget") — used by the enterprise policy lock list. */
export function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (!isPlainObject(obj)) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => flattenKeys(v, prefix ? `${prefix}.${k}` : k));
}
