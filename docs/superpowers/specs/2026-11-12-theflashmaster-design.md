# TheFlashMaster — Design

Date: 2026-11-12 · Status: approved for autonomous build (owner: Mari, "build this end to end")

## 1. Intent

TheFlashMaster is a Windows x64 desktop app, in the spirit of Codex Desktop and Claude Desktop. It orchestrates AI coding agents **through the agent CLIs already installed and signed in on the user's machine**: GitHub Copilot CLI, OpenCode, Pi and GitLab Duo CLI. It never calls a model API itself and stores no model credentials.
It runs in an automotive enterprise environment: AUTOSAR/Vector toolchains, IBM Jazz (EWM/RTC) for work items, and iSYSTEM/TASKING winIDEA for debugging.
The main orchestrator agent and the tool share the name **TheFlashMaster**.

**Why:** one place where a developer points a team of specialised agents at a local project. They coordinate the agents, watch and steer them, and keep token spend low. Model access stays whatever the company already licensed.

## 2. Goals / Non-goals / Anti-goals

**Goals**
- Projects = local folders; several chats per project; threads (replies); emoji reactions; **streaming** output.
- A **master chat** for the coordinator (TheFlashMaster), which delegates to specialists.
- Specialist agents always at hand: sidebar palette, `@mention`, and coordinator delegation.
- An overview of running agents with **pause / resume / stop**.
- A **central dashboard** of usage across agents, projects and harnesses.
- A **task system** backed by a local database (SQLite).
- The superpowers workflow, **on demand only**.
- Custom tools as MCP servers, auto-installed at startup when missing.
- IBM Jazz integration: fetch work items, use them in workflows, update them.
- Specialists: reviewer, architect, analyst, software expert, tester, AUTOSAR/Vector expert (DBC, ARXML, CDD, DaVinci, CANoe, CAPL), and a winIDEA debugger using the winIDEA Python SDK.
- **Token efficiency designed in from the ground up** (§7).
- Comprehensive settings, a local CI pipeline, and a release pipeline producing an x64 `.exe`.

**Non-goals:** login or accounts, multi-user sync, a cloud backend, direct model API calls, mobile.

**Anti-goals** (the build fails if any of these happen, even if the features work):
- Setup that needs more than "install and pick a folder".
- Silently editing the user's global harness configs.
- Agents shipping whole transcripts or giant files to each other.
- Telemetry.

## 3. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Full fork of T3 Code | Polished on day one, but ~230k LOC of Effect-TS, mobile and marketing code; heavy upstream churn; costly for agents to navigate | rejected |
| **B** | **Lean app reusing T3 Code's ideas (MIT): ACP-based harness layer, chat patterns** | Small codebase the owner and agents can read; built around these features; less polish at first | **chosen by owner** |
| C | Qt/QML native app | Native and small, but every chat/streaming/markdown feature built from scratch; slow to iterate | rejected |

## 4. Architecture

```
┌──────────────── Electron main process (Node, TypeScript) ───────────────┐
│ Db (SQLite, better-sqlite3)   SettingsStore (JSON + policy overrides)   │
│ HarnessRegistry ─ AcpAdapter (copilot --acp, opencode acp, pi-acp)      │
│                 ─ DuoAdapter (duo run --goal, --existing-session-id)    │
│                 ─ MockAdapter (offline demo + tests)                    │
│ AgentManager  (spawn / stream / pause / resume / stop / budgets)        │
│ ContextEngine (briefs, compaction, output clipping, usage accounting)   │
│ Coordinator   (TheFlashMaster role + delegation through Bridge)         │
│ Bridge (127.0.0.1 HTTP + token)  ◄── flashmaster-core MCP (stdio)       │
│ McpBootstrap (ensures bundled/external MCP servers + Python venv)       │
│ Jazz client (OSLC/REST)                                                  │
└───────────── IPC (contextBridge, typed) + event stream ─────────────────┘
                React renderer (Vite, Zustand, plain CSS)
```

- **Stack:** Electron + electron-vite, React 18, TypeScript (strict), Zustand, better-sqlite3, Vitest. Python 3.10+ for the AUTOSAR/Vector and winIDEA MCP servers.
- **Harness protocol:** the Agent Client Protocol (ACP, JSON-RPC over stdio).
  - Copilot CLI (`copilot --acp --stdio`) and OpenCode (`opencode acp`) speak it natively. Pi speaks it via `pi-acp`.
  - ACP gives streaming chunks, tool-call events, `session/cancel`, and per-session `mcpServers`. So our MCP tools are injected **per session, without touching global configs**.
  - GitLab Duo CLI has no ACP mode. It uses headless `duo run --goal`, with `--existing-session-id` for continuity, and stdout is streamed.
- **Pause/resume:** the harnesses have no true suspend. *Pause* cancels the current turn at the next safe point (`session/cancel`), keeps the session alive and queues new input. *Resume* sends a compact "continue" brief. *Stop* cancels and kills the process tree.
- **Delegation:** every agent session gets the `flashmaster-core` MCP server. Its tools (`delegate`, `list_agents`, `get_result`, `create_task`, `update_task`, `list_tasks`, `fetch_artifact`, `jazz_*`) call back into the app over a loopback HTTP bridge guarded by a per-run random token. The coordinator delegates by calling `delegate(role, brief)`. Specialists return a **structured result** (summary ≤ N tokens, artifacts by reference).

## 5. Data model (SQLite, `%APPDATA%/TheFlashMaster/flashmaster.db`)

- `projects`(id, name, path, created_at)
- `chats`(id, project_id NULL = master chat, title, kind master|project, agent_role, superpowers 0/1, created_at)
- `messages`(id, chat_id, parent_id NULL → thread reply, author user|agent|system, agent_id, role, content, status streaming|done|error, tokens_in, tokens_out, created_at)
- `reactions`(message_id, emoji, created_at); a primary key of message+emoji means toggle
- `agents`(id, project_id, chat_id, role, harness, model, status idle|running|paused|stopped|error|done, parent_agent_id, session_id, brief, result_summary, tokens_in, tokens_out, est 0/1, started_at, ended_at)
- `tasks`(id, project_id, title, description, status todo|in_progress|blocked|review|done, priority, assignee_role, agent_id, parent_id, jazz_id, created_at, updated_at)
- `usage`(id, agent_id, project_id, harness, role, tokens_in, tokens_out, estimated, at): feeds the dashboard
- `artifacts`(id, agent_id, kind, title, content, bytes, created_at): large tool outputs, fetched by reference

## 6. Agents

Roles are Markdown files with frontmatter in `agents/`. The user can edit them, and copies in `%APPDATA%/TheFlashMaster/agents` override the shipped defaults. Frontmatter keys: `name, title, icon, harness?, model?, tools, maxResultTokens, skills`. Shipped roles:
`flashmaster` (coordinator), `reviewer`, `architect`, `analyst`, `software-expert`, `tester`, `autosar-vector` (DBC/ARXML/CDD/DaVinci/CANoe/CAPL), `winidea-debugger`, `jazz-analyst`.
Role prompts are short. Domain knowledge lives in skill files that load on demand (progressive disclosure).

**Superpowers** (`skills/superpowers/*.md`: brainstorming, writing-plans, executing-plans, TDD, systematic-debugging, code-review, verification) is **off by default**. It turns on per chat via a toggle, `/superpowers`, or a single-step command (`/brainstorm`, `/plan`, `/tdd`, `/debug`, `/review`, `/verify`).

## 7. Token efficiency (ground-up)

1. **Briefs, not transcripts.** Delegation sends a compact brief: goal, constraints, relevant file paths, acceptance criteria. Never the parent's history.
2. **Structured, capped results.** Specialists must answer with `{summary, findings[], artifacts[]}`, with the summary capped at `maxResultTokens`. Long material goes to `artifacts` and is fetched by id only when needed.
3. **Output clipping.** Tool and process outputs above the clip size are stored as artifacts, and the agent sees a head/tail excerpt plus the artifact id.
4. **Rolling compaction.** When a chat's context estimate exceeds the threshold, older turns are replaced by a stored summary. The full history stays in the DB and the UI.
5. **Stable prompt prefixes.** The role prompt and tool list are byte-identical across turns, which keeps provider prompt caches warm.
6. **On-demand skills and MCP tools.** Only the tools a role declares are attached to its session.
7. **Domain tools return queries, not files.** ARXML/DBC/CDD tools answer targeted questions (signals of message X, SWC ports) instead of dumping files.
8. **Budgets.** Per-agent, per-project and daily token budgets. A warning shows at a threshold, then a hard stop or pause, depending on settings.
9. **Model routing.** Each role can pin a cheaper harness or model; triage and summaries go to the "economy" model.
10. **Measurement.** Uses real usage where the harness reports it, otherwise an estimate (chars/4, flagged *est.*). Shown per message, per agent, per project and on the dashboard.

## 8. MCP servers (auto-ensured at startup)

| Server | Lang | Purpose |
|---|---|---|
| `flashmaster-core` | TS (bundled) | delegation, tasks, artifacts, Jazz passthrough |
| `jazz` | TS (bundled) | EWM/RTC work items: query, get, update, comment |
| `vector-autosar` | Python | DBC (cantools), ARXML (lxml), CDD, CAPL lint/index, CANoe COM automation (pywin32), DaVinci CLI |
| `winidea` | Python | winIDEA SDK (`isystem.connect`): connect, download, run/halt, breakpoints, step, read vars/memory, call stack |

The startup bootstrap:
1. Copies bundled servers to app data.
2. Creates a Python venv and pip-installs the requirements if missing; the enterprise pip index URL and proxy come from settings.
3. Health-checks each server and shows its status in Settings → MCP.

User-added MCP servers go in the same list. Registering servers into global harness configs is an explicit opt-in action.

## 9. UI

The left sidebar holds:
- the master chat
- projects and their chats
- the specialist palette
- links to Agents, Dashboard, Tasks, Jazz and Settings

The **chat view** has:
- streaming markdown with code blocks, and token counts per message
- hover actions: reply in thread, react, copy
- `@role` autocomplete and slash commands
- a superpowers toggle
- a harness/model picker

The **thread panel** opens on the right. The **Agents overview** is a live table: role, project, harness, status, tokens, elapsed time, and pause/resume/stop buttons. The **Dashboard** shows totals plus by-project, by-role, by-harness and per-day charts. **Tasks** is a kanban board with filters, Jazz links, and assignment to a role. The **Jazz** view runs queries and has "Analyse with agent…" and "Create task" actions.

## 10. Settings (all persisted; enterprise policy file can lock keys)

- **General:** theme, language, notifications, data folder, start behaviour
- **Harnesses:** enable each one, executable path, extra args, default model, detection status
- **Agents:** harness/model per role, max result tokens, concurrency limit, edit role files
- **Token efficiency:** budgets, warn %, hard-stop vs pause, compaction threshold, clip size, economy model
- **Permissions:** tool approval policy (ask / auto-approve reads / auto-approve all), read-only mode, blocked commands
- **MCP:** server list, auto-install toggle, Python path, pip index URL, health check
- **Integrations:**
  - Jazz: server URL, project area, auth type, user; the password is kept with Electron `safeStorage`
  - winIDEA: install path, workspace, SDK path
  - Vector: CANoe path/version, DaVinci Configurator CLI path, CAPL include paths
- **Network:** HTTP(S) proxy, custom CA bundle, offline mode
- **Data:** retention days, export/import, reset
- **Advanced:** log level, dev tools, mock harness

The enterprise policy file is `%PROGRAMDATA%/TheFlashMaster/policy.json`. It overrides and locks keys.

## 11. Delivery

- **Local CI:** `npm run ci` runs typecheck, lint, unit tests (Vitest), Python tests (pytest), then build.
- **GitHub Actions:**
  - `ci.yml` runs on push/PR, on Windows and Ubuntu.
  - `release.yml` runs on a `v*` tag, on `windows-latest`. It builds `TheFlashMaster-<ver>-x64-portable.exe` (no install) and `TheFlashMaster-<ver>-x64-setup.exe` (per-user NSIS, no admin rights), then attaches both to a GitHub Release.

## 12. Decisions made by the builder (owner to review)

- No login: single local user. Jazz credentials are integration secrets, not an app login.
- Pause = interrupt at a safe point plus hold input, because no harness supports true suspend.
- Duo uses the headless adapter (no ACP available). It auto-approves tools in headless mode, so Duo agents get a warning badge and default to read-only prompts.
- Python is required only for the AUTOSAR/winIDEA servers. The app works without it and shows those servers as unavailable.
- Superpowers skills are concise rewrites of the obra/superpowers workflow (MIT, credited), not copies.
- Release is unsigned by default. Code signing hooks exist (CSC_LINK) for the enterprise certificate.

## 13. Requirements checklist

| # | Requirement | Where |
|---|---|---|
| 1 | Windows desktop app like Codex/Claude Desktop | Electron app, §4, §9 |
| 2 | Uses Copilot/OpenCode/Pi/GitLab Duo, already authenticated | §4 harness adapters, no credentials stored |
| 3 | Custom tools as MCP servers auto-installed at start | §8 McpBootstrap |
| 4 | Local project folder, agents pointed there, chats per project | `projects`, `chats`, cwd = project path |
| 5 | Threads | `messages.parent_id`, thread panel |
| 6 | Stop and pause agents | AgentManager + overview buttons |
| 7 | Overview of running agents | Agents view |
| 8 | Master chat for coordinator | master chat, `flashmaster` role |
| 9 | Superpowers on demand only | §6 |
| 10 | Token efficiency from the ground up | §7 |
| 11 | Reactions and replies | `reactions`, threads |
| 12 | IBM Jazz work items fetch/update/analysis | `jazz` MCP + Jazz view |
| 13 | Specialists: review, architecture, analyst, software expert, testing | `agents/` |
| 14 | AUTOSAR/Vector expert (DBC, ARXML, CDD, DaVinci, CANoe, CAPL) | `autosar-vector` role + server |
| 15 | winIDEA Python SDK + debug agent | `winidea` server + role |
| 16 | Best practices in orchestration | briefs, structured results, delegation via MCP, budgets |
| 17 | Public GitHub repo, everything implemented there | samcrow92/the-flash-master |
| 18 | Local CI + release with x64 exe | §11 |
| 19 | Named TheFlashMaster (orchestrator + tool) | app name, coordinator role |
| 20 | Comprehensive settings | §10 |
| 21 | Enterprise environment | policy file, proxy/CA, no telemetry, per-user install |
| 22 | Specialists at hand | palette, @mentions, delegation |
| 23 | Central dashboard across agents/projects | Dashboard |
| 24 | Task system with a database | `tasks` + kanban |
| 25 | No login, simple | §2, §12 |
| 26 | Chat streaming and reactions | ACP chunk streaming → IPC events |

## 14. Additions (2026-11-13)

| # | Requirement | Where |
|---|---|---|
| 27 | Presentation expert (PowerPoint create/edit) | `agents/presentation-expert.md`, `mcp-servers/office` |
| 28 | NOW-format analysis with Ishikawa RCA, INCOSE practice | `agents/rca-analyst.md`; fishbone rendering in chat (`ishikawa` block), SVG and PPTX |
| 29 | Users import their own agents from an editable template | `agents/_template.md`, `validateRole`, import dialog / files / drag-and-drop, Settings → Agents |
| 30 | Easy-to-reach flowchart of where an agent is in its task | `agent_events` + `agents.plan` (migration v2), `report_progress` tool, 🧭 Progress panel in chats, flow page |
| 31 | No third-party branding in the app | About page and README credit only TheFlashMaster and the MIT superpowers workflow |

Builder decision: "NOW" was not found as a published standard, so it is defined as **N**ow (current situation) · **O**bjective
(target state) · **W**ay forward (actions). The definitions live at the top of the agent file, so they can be edited in one place.
