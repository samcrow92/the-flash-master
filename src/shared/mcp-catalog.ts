/**
 * Recommended third-party MCP servers. They are installed once into the app data folder (npm packages are run
 * with Electron-as-Node, so users need npm only for the install; pip packages go into the private Python venv)
 * and attached only to the roles listed, because every server adds its tool definitions to the agent's context.
 */
export interface CatalogServer {
  id: string;
  label: string;
  description: string;
  runtime: "npm" | "pip";
  package: string; // npm package or pip requirement
  bin?: string; // npm: bin name (default: the package's only/first bin)
  module?: string; // pip: run as `python -m <module>`
  args?: string[];
  env?: { key: string; label: string; optional: boolean; secret?: boolean }[];
  roles: string[]; // default roles, "*" = every agent
  defaultEnabled: boolean;
  homepage: string;
}

export const MCP_CATALOG: CatalogServer[] = [
  {
    id: "context7", label: "Context7 — up-to-date library docs",
    description: "Fetches current, version-specific documentation and code examples for libraries and frameworks, so agents stop guessing APIs.",
    runtime: "npm", package: "@upstash/context7-mcp", bin: "context7-mcp",
    env: [{ key: "CONTEXT7_API_KEY", label: "API key (optional, higher rate limits)", optional: true, secret: true }],
    roles: ["flashmaster", "software-expert", "architect", "reviewer", "tester", "challenger", "winidea-debugger"], defaultEnabled: true,
    homepage: "https://github.com/upstash/context7",
  },
  {
    id: "sequential-thinking", label: "Sequential Thinking — structured reasoning",
    description: "A scratchpad tool for breaking hard problems into revisable steps. Useful for design, challenge and root-cause work.",
    runtime: "npm", package: "@modelcontextprotocol/server-sequential-thinking",
    roles: ["architect", "challenger", "rca-analyst", "analyst"], defaultEnabled: true,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
  },
  {
    id: "markitdown", label: "MarkItDown — read Office & PDF documents",
    description: "Converts Word, Excel, PowerPoint, PDF, HTML and more to Markdown so agents can read specifications, requirements and reports.",
    runtime: "pip", package: "markitdown-mcp", module: "markitdown_mcp",
    roles: ["analyst", "jazz-analyst", "rca-analyst", "presentation-expert", "autosar-vector", "reviewer", "architect"], defaultEnabled: true,
    homepage: "https://github.com/microsoft/markitdown",
  },
  {
    id: "fetch", label: "Fetch — read web pages",
    description: "Fetches a URL and returns it as Markdown (internal wikis, vendor docs). Respects the proxy settings.",
    runtime: "pip", package: "mcp-server-fetch", module: "mcp_server_fetch",
    roles: ["analyst", "software-expert", "architect"], defaultEnabled: false,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
  },
  {
    id: "git", label: "Git — repository history",
    description: "Log, diff, blame-style inspection and branch info through structured tools (read-mostly use for reviews).",
    runtime: "pip", package: "mcp-server-git", module: "mcp_server_git",
    roles: ["reviewer", "software-expert", "challenger"], defaultEnabled: false,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
  },
  {
    id: "memory", label: "Memory — shared knowledge graph",
    description: "A local knowledge graph (entities, relations, notes) the coordinator can keep across sessions. Stored in the app data folder.",
    runtime: "npm", package: "@modelcontextprotocol/server-memory",
    roles: ["flashmaster"], defaultEnabled: false,
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
  },
  {
    id: "playwright", label: "Playwright — browser automation",
    description: "Drives a real browser (uses the installed Chrome/Edge) to test web UIs, dashboards and HMI web pages.",
    runtime: "npm", package: "@playwright/mcp",
    roles: ["tester"], defaultEnabled: false,
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
];

export interface CatalogState { enabled: boolean; roles: string[]; env: string }

/** Effective settings of a catalog server (defaults + user overrides). */
export function catalogState(c: CatalogServer, overrides: Record<string, { enabled?: boolean; roles?: string; env?: string }> | undefined): CatalogState {
  const o = overrides?.[c.id] ?? {};
  const roles = o.roles !== undefined ? o.roles.split(/[\s,]+/).filter(Boolean) : c.roles;
  return { enabled: o.enabled ?? c.defaultEnabled, roles, env: o.env ?? "" };
}

export const roleMatches = (roles: string[], role: string) => roles.includes("*") || roles.includes(role);
