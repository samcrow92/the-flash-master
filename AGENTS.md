# AGENTS.md — repo map for coding agents (keep reads small)

TheFlashMaster = an Electron (main: TypeScript) + React desktop app that orchestrates agent CLIs over ACP.

- Contracts first: `src/shared/types.ts` (domain), `src/shared/api.ts` (IPC; every method must also be added to `API_METHODS`), `src/shared/settings.ts` (settings + defaults).
- Backend: `src/main/orchestrator.ts` (turn engine), `src/main/harness/*` (ACP / Duo / mock), `src/main/db.ts` (node:sqlite, append migrations — never edit old ones), `src/main/tools.ts` (MCP tools exposed through `bridge.ts`), `src/main/mcp.ts` (server bootstrap), `src/main/index.ts` (wiring + IPC).
- UI: `src/renderer/store.ts` (state + event reducer), `views/*`, `components/*`, `styles.css` (CSS variables, dark/light).
- Python MCP servers: `mcp-servers/{vector-autosar,winidea}`; shared stdio base in `mcp-servers/pycommon/mcp_stdio.py`.
- Roles: `agents/*.md`. Superpowers skills: `skills/superpowers/*.md`.

Verify before claiming done: `npm run ci` (add `-- --smoke` to launch the app headlessly).
Conventions: strict TS, no new runtime deps without need (the main bundle inlines devDependencies), keep tool outputs compact.
