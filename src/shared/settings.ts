import type { Chat, DriveMode, DuoMode, HarnessId } from "./types";

export type ThinkingLevel = "" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface ModeProfile {
  harness: HarnessId | ""; // "" = the chat's harness / default harness
  model: string;
  thinking: ThinkingLevel;
}

/** A GitLab Duo mode: a Duo model id (GitLab's `gitlab_identifier`, e.g. claude_opus_5_5) and a thinking level. */
export interface DuoModeProfile {
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
    /** New chats start with Autopilot on (agents and specialists work without asking for approval or feedback). */
    autopilotDefault: boolean;
    defaultHarness: HarnessId;
    restoreLastChat: boolean;
    /** Translucent "liquid glass" window: the desktop shows through, blurred (Windows 11 acrylic / macOS vibrancy). Applied at the next start. */
    windowGlass: boolean;
  };
  /** How you appear in chats. The picture is a small square image stored as a data URL (≤ ~40 KB). */
  profile: { name: string; avatar: string; hue: number };
  harnesses: Record<HarnessId, HarnessSettings>;
  modes: Record<DriveMode, ModeProfile>;
  /** GitLab Duo agents only start in GitLab repos (see harness/duo.ts). */
  duo: {
    hosts: string; // extra host names that are GitLab (self-managed), besides gitlab.com and hosts named gitlab…
    /**
     * Run the chat's coordinator on GitLab Duo in project chats. Duo starts by itself in the project folder when the chat
     * opens or Duo is picked. Only project chats: the master chat and chats without a project keep their usual harness.
     */
    coordinator: boolean;
    /** Model for a coordinator on Duo when the chat names none (default Opus 5.5). */
    coordinatorModel: string;
    /** Extra instructions for the coordinator on Duo, sent after its orchestrator brief (how you want it to plan and delegate). */
    orchestratorRules: string;
    /** The ECO / COMFORT / SPORT row under the chat bar while the chat runs on Duo: model + thinking for its Duo agents. */
    modes: Record<DuoMode, DuoModeProfile>;
  };
  chat: {
    maxAttachmentMB: number;
    defaultSendWhileBusy: "queue" | "steer"; // what Enter does while an agent is still working
  };
  agents: {
    maxConcurrent: number;
    /** Specialists one coordinator may have working at once (0 = no limit); further delegations wait for one to finish. */
    maxParallelSpecialists: number;
    roleOverrides: Record<string, { harness?: HarnessId; model?: string; maxResultTokens?: number }>;
    delegationDepth: number; // levels of delegation: 1 = only the coordinator, 2 = specialists start helpers, 3 = helpers start helpers
    /**
     * How agents reach TheFlashMaster's own tools (delegate, create_agent, tasks, artifacts, Jazz, DOORS Next):
     * "text" = plain-text DELEGATE / AGENT / TOOL lines the app carries out (works everywhere, also where MCP is blocked);
     * "auto" = as MCP tools, falling back to text when they don't load.
     */
    toolMode: "text" | "auto";
    autoTaskFromDelegation: boolean; // create a task per delegation
    instructionMode: "clean" | "harness"; // clean = TheFlashMaster instructions only (harness AGENTS.md/rules/skills off)
    keepProjectInstructions: boolean; // in clean mode, still load the project's AGENTS.md / instruction files
    houseRules: string; // extra rules sent to every agent (your workflow/setup)
    /** HTML files and reports agents create must include diagrams (Ishikawa for root causes, flowcharts, timelines, sequences). */
    reportDiagrams: boolean;
    /** Warn when a working agent has produced no output for this many minutes (0 = off). */
    stuckAfterMinutes: number;
    /** Stop a single tool call that has run this long without finishing, and let the agent carry on without it (0 = off). */
    toolTimeoutMinutes: number;
    /**
     * A delegated specialist that ends without a report (empty reply, error, crash) or stalls is recovered this many times
     * (first a reminder to deliver, then a restart) before the user gets a "needs you" card. 0 = no recovery, card at once.
     */
    recoveryAttempts: number;
    /** Close delegated specialists that finished and sat idle this long (0 = never); work waiting for review is kept. */
    closeIdleAfterMinutes: number;
    /** Code-writing specialists (roles with `isolate: true`) work in their own git worktree and branch when delegated. */
    isolateWriters: boolean;
    /** Folder agents work in when their chat has no project ("" = C:\\Data\\.wt on Windows, ~/Data/.wt on macOS/Linux). */
    noProjectFolder: string;
    /** Send pstack's unslop writing rules (skills/pstack/unslop.md) to every agent, for replies and for text written through tools. */
    unslop: boolean;
  };
  /** Task board auto-cleanup; Review tasks and tasks with a working agent are always kept. */
  tasks: {
    /** Delete finished tasks this long after they finished: done, or their agent stopped / failed / ended (0 = never). */
    deleteFinishedAfterMinutes: number;
    /** Delete open tasks (to do, in progress, blocked) nobody touched for this many days (0 = never). */
    deleteStaleAfterDays: number;
  };
  updates: {
    autoCheck: boolean; // check at startup and every few hours
    autoDownload: boolean; // download in the background; installing always asks
    channel: "stable" | "beta"; // beta = include pre-releases
    feedUrl: string; // override of the repository's update source (package.json → flashmaster.updates.url)
    hasToken: boolean; // a read-only GitHub token is stored (encrypted)
  };
  /** Flash server (flash-server/API.md): updates, marketplace source "flash-server", submissions. Default url: package.json → flashmaster.server.url. */
  server: {
    url: string; // "" = the repository's default (package.json → flashmaster.server.url), if any
    hasToken: boolean; // the server token is stored (encrypted), like the updater token
  };
  usage: {
    copilotMeter: boolean; // show Copilot usage (from Copilot's /usage and session log) under the chat box
    refreshMinutes: number; // 0 = only manual refresh
    onlyIfAdvertised: boolean; // never send /usage unless Copilot lists it as a built-in command (so it never reaches a model)
    includedCredits: number; // credits available per month (usage is computed from them); 0 = not set
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
    /** Engineering Test Management (ETM / RQM): test plans, suites, cases, scripts, execution records and results. Same sign-in. */
    qm: { enabled: boolean; serverUrl: string; projectArea: string; config: string };
    /**
     * EWM source control: streams, components, files (REST), plus repository workspaces, check-in, change sets and accept
     * through the SCM command line. Always on with the Jazz connection; `enabled` is no longer read (kept for old settings
     * files). cliPath: lscm/scm; blank = find it on PATH. deliver: agents may deliver to streams.
     */
    scm: { enabled: boolean; cliPath: string; deliver: boolean };
    /** Accept a self-signed or company-CA certificate from the Jazz servers (ccm, qm, rm hosts only) that Windows doesn't trust. */
    trustServerCert: boolean;
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
  /** EXAM test automation (MicroNova / VW Group), reached through the EXAM RESTapi plugin. */
  exam: {
    installPath: string; // folder containing EXAM.exe (only needed to start EXAM from the app)
    restPort: number; // RESTapi port (Jenkins plugin default 8085)
    licenseHost: string;
    licensePort: number;
    modelName: string; // default model on the EXAM application server
    targetEndpoint: string; // URL of the EXAM application server
    modelConfigUuid: string; // ModelConfiguration UUID (EXAM 4.6+ with versioning)
    systemConfig: string; // default system configuration (UUID, ID or full scoped name)
    reportProject: string; // report project name ("" = no report DB)
    pythonPath: string; // Python EXAM uses for test execution ("" = EXAM's own setting)
    workspace: string; // EXAM workspace folder for headless runs ("" = temp folder)
    javaOpts: string;
    /** RESTapi plugin (.jar/.zip, licensed from MicroNova): file share path or http(s) URL, e.g. a department server. */
    pluginPackage: string;
    autoSetup: boolean; // at start: detect EXAM, fill the install folder, install the plugin when missing
  };
  vector: {
    canoePath: string;
    canoeVersion: string;
    davinciCliPath: string;
    caplIncludePaths: string;
    /** Vector's official MCP servers (CANoe 20 SP2+, CANoe AI Package): connect them and give their tools to every agent. */
    mcpEnabled: boolean;
    mcpAutoDetect: boolean; // look for Vector's mcp.json / MCP executables in the CANoe and AI Package folders
    mcpConfigPath: string; // Vector's mcp.json (or the AI Package folder)
    canoeMcp: string; // CANoe MCP Server: http(s) URL or command line ("" = auto-detect)
    canoeDocsMcp: string; // CANoe Documentation MCP Server: http(s) URL or command line
  };
  network: {
    proxy: string;
    noProxy: string;
    caBundlePath: string;
    offline: boolean;
  };
  /** Agent memory (Memory page): what agents save and get reminded of. */
  memory: {
    enabled: boolean; // memory tools for agents + reminders
    autoInject: boolean; // put relevant memories in front of agents before they work
    maxInjected: number; // memories per reminder
    shortTermDays: number; // a chat's short-term memories expire after this many days unless promoted
    captureResults: boolean; // save each specialist's result summary as a short-term memory of the chat
    knowledgeSync: boolean; // keep each project's knowledge base in step with .flashmaster/knowledge in its repo (at start and every few minutes)
    knowledgeSyncMinutes: number;
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

/**
 * Opus 5.5, the default model of a coordinator that runs on GitLab Duo. `duo run --model` takes GitLab's model
 * identifier (the `gitlab_identifier` in GitLab's ai_gateway/model_selection/models.yml): underscores, not dashes.
 */
/**
 * Agents get the Jazz tools (work items, DOORS Next, ETM, EWM source control): Jazz is turned on, or a server or sign-in
 * is filled in. Source control also works from a link the user gives, so the top switch alone must not hide the tools.
 */
export function jazzToolsOn(j: Settings["jazz"]): boolean {
  return j.enabled || !!j.serverUrl.trim() || !!j.username.trim();
}

export const DUO_COORDINATOR_MODEL = "claude_opus_5_5";

/**
 * Mari's Duo modes. ECO is Grok 4.7 as asked, although GitLab Duo listed no Grok model when this was added (2026-11-19).
 * duo-cli 9.16 has no way to pass a thinking effort, so the levels are kept for when Duo accepts one.
 */
export const DUO_MODE_DEFAULTS: Record<DuoMode, DuoModeProfile> = {
  eco: { model: "grok_4_7", thinking: "high" },
  comfort: { model: DUO_COORDINATOR_MODEL, thinking: "medium" },
  sport: { model: DUO_COORDINATOR_MODEL, thinking: "xhigh" },
};

/**
 * A model id as Duo wants it: Anthropic-style ids (claude-opus-5-5, claude-opus-5.5) become GitLab identifiers
 * (claude_opus_5_5). Ids that already have underscores, or a provider prefix (vendor/model), are left alone.
 */
export function duoModelId(model: string): string {
  const m = model.trim();
  if (!m || m.includes("_") || m.includes("/")) return m;
  return /^[a-z][a-z0-9]*([-.][a-z0-9]+)+$/i.test(m) ? m.replace(/[-.]/g, "_").toLowerCase() : m;
}

/**
 * True when the chat is a GitLab Duo chat: Duo picked for the chat, or "Coordinator on Duo" in a project chat (the master
 * chat and chats without a project keep their usual harness). The Duo mode row shows then, whatever drive mode is picked:
 * a drive mode never hides it (Mari, 2026-11-19).
 */
export function chatOnDuo(chat: Pick<Chat, "harness" | "projectId">, settings: Pick<Settings, "duo">): boolean {
  if (!chat.projectId) return false;
  return chat.harness === "duo" || (settings.duo.coordinator && !chat.harness);
}

/**
 * The chat patch for a click on a drive mode or a Duo mode. The two rows can't both steer the coordinator: a Duo mode
 * drops a drive mode that moves the chat to another harness, and such a drive mode drops the Duo mode.
 */
export function modeClickPatch(chat: Pick<Chat, "mode" | "duoMode">, settings: Pick<Settings, "modes">,
  click: { mode: DriveMode | null } | { duoMode: DuoMode | null }): Partial<Pick<Chat, "mode" | "duoMode">> {
  const offDuo = (m: DriveMode | null | undefined) => {
    const h = m ? settings.modes[m]?.harness : "";
    return !!h && h !== "duo";
  };
  if ("mode" in click) return offDuo(click.mode) && chat.duoMode ? { mode: click.mode, duoMode: null } : { mode: click.mode };
  return click.duoMode && offDuo(chat.mode) ? { duoMode: click.duoMode, mode: null } : { duoMode: click.duoMode };
}

const harness = (enabled: boolean, defaultModel = ""): HarnessSettings => ({ enabled, path: "", args: "", defaultModel });

export const DEFAULT_SETTINGS: Settings = {
  general: { theme: "dark", notifications: true, confirmStop: true, autopilotDefault: true, defaultHarness: "copilot", restoreLastChat: true, windowGlass: true },
  profile: { name: "", avatar: "", hue: 210 },
  harnesses: {
    copilot: harness(true),
    opencode: harness(true),
    cursor: harness(true),
    claude: harness(true),
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
  duo: { hosts: "", coordinator: false, coordinatorModel: DUO_COORDINATOR_MODEL, orchestratorRules: "", modes: DUO_MODE_DEFAULTS },
  chat: { maxAttachmentMB: 20, defaultSendWhileBusy: "steer" },
  agents: { maxConcurrent: 4, maxParallelSpecialists: 3, toolMode: "text", roleOverrides: {}, delegationDepth: 3, autoTaskFromDelegation: true, instructionMode: "clean", keepProjectInstructions: false, houseRules: "", reportDiagrams: true, stuckAfterMinutes: 10, toolTimeoutMinutes: 0, recoveryAttempts: 2, closeIdleAfterMinutes: 30, isolateWriters: true, noProjectFolder: "", unslop: true },
  tasks: { deleteFinishedAfterMinutes: 60, deleteStaleAfterDays: 3 },
  updates: { autoCheck: true, autoDownload: true, channel: "stable", feedUrl: "", hasToken: false },
  server: { url: "", hasToken: false },
  usage: { copilotMeter: true, refreshMinutes: 30, onlyIfAdvertised: true, includedCredits: 0 },
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
  permissions: { approval: "auto-all", readOnly: false, blockedCommands: "rm -rf /\nformat c:\ngit push --force" },
  mcp: { autoInstall: true, pythonPath: "", pipIndexUrl: "", disabled: [], npmRegistry: "", catalog: {}, external: [] },
  jazz: {
    enabled: false,
    serverUrl: "",
    projectArea: "",
    projectAreas: [],
    rm: { enabled: false, serverUrl: "", projects: [], config: "", cacheHours: 24, component: "" },
    qm: { enabled: false, serverUrl: "", projectArea: "", config: "" },
    scm: { enabled: false, cliPath: "", deliver: false },
    trustServerCert: false,
    authType: "basic",
    username: "",
    hasPassword: false,
    defaultQuery: "",
  },
  marketplace: { sources: [], autoCheckUpdates: true, allowMcpServers: false },
  winidea: { installPath: "", workspace: "", sdkPath: "" },
  exam: { installPath: "", restPort: 8085, licenseHost: "", licensePort: 5053, modelName: "", targetEndpoint: "", modelConfigUuid: "",
    systemConfig: "", reportProject: "", pythonPath: "", workspace: "", javaOpts: "",
    pluginPackage: "", autoSetup: true },
  vector: { canoePath: "", canoeVersion: "", davinciCliPath: "", caplIncludePaths: "",
    mcpEnabled: true, mcpAutoDetect: true, mcpConfigPath: "", canoeMcp: "", canoeDocsMcp: "" },
  network: { proxy: "", noProxy: "", caBundlePath: "", offline: false }, // empty = use https_proxy/no_proxy env vars
  memory: { enabled: true, autoInject: true, maxInjected: 6, shortTermDays: 7, captureResults: true, knowledgeSync: true, knowledgeSyncMinutes: 2 },
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
