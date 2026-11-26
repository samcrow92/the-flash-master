/**
 * No telemetry: TheFlashMaster sends nothing about its users anywhere. The app itself has no analytics, crash reporting
 * or usage pings; this module also asks the programs it starts (agent CLIs, MCP servers, npm/pip installs, checks,
 * hooks, the terminal) not to send theirs. Each variable is a documented opt-out of that tool. A value the user set in
 * their own environment always wins.
 */
export const TELEMETRY_OPT_OUT: Readonly<Record<string, string>> = {
  // Generic (https://consoledonottrack.com), honoured by many CLIs.
  DO_NOT_TRACK: "1",
  // Claude Code: no telemetry, no error reports, no other non-essential traffic (update checks, /bug).
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // OpenCode: no self-update check. (Session sharing is turned off in its clean config, see instructions.ts.)
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  // npm / pip: no update notifier, funding or audit calls when the app installs MCP servers.
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  NO_UPDATE_NOTIFIER: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  // Tools the agents commonly run in a project.
  POWERSHELL_TELEMETRY_OPTOUT: "1",
  POWERSHELL_UPDATECHECK: "Off",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  AZURE_CORE_COLLECT_TELEMETRY: "0",
  VCPKG_DISABLE_METRICS: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  CHECKPOINT_DISABLE: "1",
  SAM_CLI_TELEMETRY: "0",
  SCARF_ANALYTICS: "false",
  DISABLE_OPENCOLLECTIVE: "1",
};

/** The opt-outs the user hasn't set themselves, to add to a child process's environment. */
export function telemetryOptOutEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(TELEMETRY_OPT_OUT)) if (env[k] === undefined) out[k] = v;
  return out;
}
