import type { DriveMode, HarnessId } from "./types";

export type ThinkingLevel = "" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ModeProfile {
  harness: HarnessId | ""; // "" = the chat's harness / default harness
  model: string;
  thinking: ThinkingLevel;
}

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
  /** How you appear in chats. The picture is a small square image stored as a data URL (≤ ~40 KB). */
  profile: { name: string; avatar: string; hue: number };
  harnesses: Record<HarnessId, HarnessSettings>;
  modes: Record<DriveMode, ModeProfile>;
  chat: {
    maxAttachmentMB: number;
    defaultSendWhileBusy: "queue" | "steer"; // what Enter does while an agent is still working
  };
  agents: {
    maxConcurrent: number;
    roleOverrides: Record<string, { harness?: HarnessId; model?: string; maxResultTokens?: number }>;
    delegationDepth: number; // how deep sub-agents may delegate further
    autoTaskFromDelegation: boolean; // create a task per delegation
    instructionMode: "clean" | "harness"; // clean = TheFlashMaster instructions only (harness AGENTS.md/rules/skills off)
    keepProjectInstructions: boolean; // in clean mode, still load the project's AGENTS.md / instruction files
    houseRules: string; // extra rules sent to every agent (your workflow/setup)
  };
  updates: {
    autoCheck: boolean; // check at startup and every few hours
    autoDownload: boolean; // download in the background; installing always asks
    channel: "stable" | "beta"; // beta = include pre-releases
    feedUrl: string; // override of the repository's update source (package.json → flashmaster.updates.url)
    hasToken: boolean; // a read-only GitHub token is stored (encrypted)
  };
  usage: {
    copilotMeter: boolean; // show Copilot premium-request usage (from Copilot's /usage) under the chat box
    refreshMinutes: number; // 0 = only manual refresh
    onlyIfAdvertised: boolean; // never send /usage unless Copilot lists it as a command (so no premium request is used)
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
    npmRegistry: string; // empty = npm default (or your .npmrc); e.g. an internal Artifactory/Nexus mirror
    /** Recommended servers (Context7, …): per-id overrides of enabled / roles ("*" = all agents) / env lines. */
    catalog: Record<string, { enabled?: boolean; roles?: string; env?: string }>;
    external: { id: string; label: string; command: string; args: string; env: string; roles?: string }[];
  };
  jazz: {
    enabled: boolean;
    serverUrl: string; // e.g. https://jazz.company.com/ccm
    projectArea: string; // legacy single area (migrated into projectAreas)
    projectAreas: string[];
    /** DOORS Next (Jazz Requirements Management). Uses the same sign-in as Jazz work items. */
    rm: { enabled: boolean; serverUrl: string; projects: string[]; config: string; cacheHours: number; component: string };
    authType: "form" | "basic" | "windows" | "browser"; // windows = integrated Kerberos/NTLM; browser = SSO window (Jazz Authorization Server / OIDC)
    username: string;
    hasPassword: boolean; // password stored encrypted via safeStorage, never in settings
    defaultQuery: string;
  };
  marketplace: {
    sources: { id: string; name: string; url: string; department: string; enabled: boolean }[];
    autoCheckUpdates: boolean; // check marketplaces for plugin updates at startup
    allowMcpServers: boolean; // allow plugins to add MCP tool servers (they run programs on this PC)
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
  profile: { name: "", avatar: "", hue: 210 },
  harnesses: {
    copilot: harness(true),
    opencode: harness(true),
    pi: harness(true),
    duo: harness(true),
    mock: harness(true),
  },
  modes: {
    local: { harness: "opencode", model: "", thinking: "" }, // e.g. an on-prem / Ollama model configured in OpenCode or Pi
    eco: { harness: "", model: "luna", thinking: "medium" },
    comfort: { harness: "", model: "sol", thinking: "low" },
    sport: { harness: "", model: "claude-opus-5.5", thinking: "" },
  },
  chat: { maxAttachmentMB: 20, defaultSendWhileBusy: "steer" },
  agents: { maxConcurrent: 4, roleOverrides: {}, delegationDepth: 2, autoTaskFromDelegation: true, instructionMode: "clean", keepProjectInstructions: false, houseRules: "" },
  updates: { autoCheck: true, autoDownload: true, channel: "stable", feedUrl: "", hasToken: false },
  usage: { copilotMeter: true, refreshMinutes: 30, onlyIfAdvertised: true },
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
  mcp: { autoInstall: true, pythonPath: "", pipIndexUrl: "", disabled: [], npmRegistry: "", catalog: {}, external: [] },
  jazz: {
    enabled: false,
    serverUrl: "",
    projectArea: "",
    projectAreas: [],
    rm: { enabled: false, serverUrl: "", projects: [], config: "", cacheHours: 24, component: "" },
    authType: "basic",
    username: "",
    hasPassword: false,
    defaultQuery: "",
  },
  marketplace: { sources: [], autoCheckUpdates: true, allowMcpServers: false },
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
