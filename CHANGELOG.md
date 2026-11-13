# Changelog

## Unreleased
- **Chat artifacts & diff viewer:** an **Artifacts** button in every chat opens a panel with four tabs:
  - **Changes:** every file agents created or edited, captured from ACP `diff` tool content and from writes through the app. One entry per file per turn, with a +/− stat.
  - **Git:** uncommitted changes in the project folder, HEAD vs. working copy.
  - **Saved:** reports agents stored with `save_artifact`.
  - **Code:** code blocks from replies.
  - **Viewer:** side-by-side or unified diff with line numbers, word-level highlights, wrap and full-file toggles. Download the file, a `.patch`, or all changes of the chat as one patch.
- **IBM DOORS Next requirements** (Jazz Requirements Management):
  - **Sign-in:** uses the same Jazz sign-in (form, Basic, Windows or browser SSO). The `/rm` server is derived from the Jazz URL. There are an optional project filter and an optional configuration (stream/baseline/GC) for configuration-managed projects.
  - **Data:** projects come from the OSLC RM catalog. Modules and their contents (document order, sections, types, attributes, links) come from the read-only Reportable REST API, with paging. Contents are cached on disk.
  - **Requirements tab on the IBM Jazz page:**
    - module list, document view with collapsible headings, ranked search, detail panel
    - select requirements and **Analyse** with any agent, scoped to a code project and an optional goal
    - create a task, copy, open in DOORS Next
  - **Requirement retrieval tools for agents:**
    - `rm_modules`, `rm_outline`, `rm_search` (BM25 with stemming, exact id hits first, short text) and `rm_get` (full text, attributes, links)
    - agents fetch only the requirements relevant to the question, never whole modules
    - the analyst, tester, architect, reviewer, challenger, RCA and AUTOSAR agents have them
- **Your profile:** in Settings → General you can set a display name (shown instead of "You") and a profile picture. Upload, drop or paste an image; it is centre-cropped, downscaled and stored only on this PC. Without a picture, your initials appear on a colour you choose. Your avatar shows on your chat messages and at the bottom of the sidebar; click either to change it.
- **Chat management:**
  - **Right-click menus** on chats: rename, pin to top, reset context, copy as Markdown, archive/restore, delete. The same menu opens from the "…" button and the chat header.
  - Right-click menu on projects: new chat, rename, open folder, show archived, remove.
  - Chats can be renamed by double-click, F2, or the ✎ in the header. Archived chats are hidden behind "Show archived".
- **Reset context:** a ↺ button next to the chat box. The chat's agent sessions are closed and not resumed, and a divider marks the reset. Earlier messages stay visible but are no longer sent, which saves tokens when the topic changes.
- **Documentation section:**
  - Install Copilot CLI from the official GitHub release downloads (x64/ARM64), then pick copilot.exe. No winget, npm or terminal.
  - Sign in through "Open Copilot CLI" and `/login`, or with an encrypted fine-grained token (Copilot Requests permission).
  - A live setup checklist, a full user guide and troubleshooting.
  - Common unzip locations of copilot.exe are found automatically.
- **Copilot usage bar:** now always shows its state (checking, unavailable with the reason, or the numbers). It checks when a chat opens if the data is stale, finds Copilot even if it was set up after start, and reads more output formats.
- **New look:**
  - Lucide line icons throughout, and gradient role badges with drawn icons for the built-in specialists.
  - Motion: animated brand mark and splash, view and message entrances, context-menu pop, toast slide, a rewind spin on context reset, a flying Autopilot plane, a theme-toggle spin and smooth chevrons.
  - Honours the Windows "reduce motion" setting.
- **Recommended MCP servers** (Settings → MCP), installed automatically and attached per agent role so tool definitions don't bloat every context:
  - **Context7** (current library docs), **Sequential Thinking** and **MarkItDown** (read Word/Excel/PowerPoint/PDF) are on by default.
  - **Fetch**, **Git**, **Memory** and **Playwright** are one click away.
  - npm servers are downloaded once into the app data folder and run with Electron's built-in Node; Python servers go into the private venv.
  - Corporate npm/PyPI mirrors and the proxy are respected. Each server has a role picker, an optional API key field and Install/Update.
  - Custom MCP servers can now be attached by role list (`*` = all agents).
- **Copilot usage meter:** premium-request usage taken only from Copilot CLI's own `/usage` (a short background ACP session), shown as a progress bar under the chat box (green/amber/red, reset date). The bar links to Settings → Usage, which shows the full detail, every line `/usage` printed and the raw output. Refreshes every 30 min (configurable) or manually. By default `/usage` is sent only when Copilot lists it as a built-in command, so a check never spends a premium request.
- **IBM Jazz:**
  - **HTTP 401 handling:** expired form sessions log in again automatically. The client falls back to Basic once when the server asks for it. For Kerberos/NTLM ("Negotiate") and Jazz Authorization Server tokens you get a message saying exactly what to change.
  - **New authentication:** Windows (integrated). It uses your domain login with no password.
  - **New authentication: Browser sign-in (SSO)** for servers behind the Jazz Authorization Server / OIDC (HTTP 401 "Bearer"). You log in once in a sign-in window (company SSO, MFA) and the API reuses that session. When the session expires, a **Sign in to Jazz** button appears on the Jazz page.
  - **Multiple project areas:** configure several in Settings (with "↻ From server" to load them). The old single value is migrated.
  - **Rewritten Jazz page:**
    - always-visible project-area picker (configured areas and every area on the server)
    - filters for open/closed/all, owner (mine/unassigned), type, and an advanced reportable-API filter; sorting
    - detail view with all fields and the discussion
    - actions: add comments, edit the summary, run workflow actions, analyse with an agent (scoped to the area), create a task, open in Jazz, copy link
  - **Agent tools:** `jazz_query` accepts projectArea/state/type/owner, and `jazz_get` can include comments.
- **Chat:**
  - **Ordering fix:** replies no longer stream into an earlier message.
  - **Steering for all harnesses:** native steering on Pi; interrupt-and-redirect on the others.
  - **Attachments:** images and files (📎, paste, drop).
  - **Refined chat bar.**
  - **Drive modes:** LOCAL / ECO / COMFORT / SPORT buttons, configurable in Settings → Modes & chat.
  - **Autopilot toggle:** auto-approves tool calls and tells the agent not to stop for feedback.
- **Marketplace:** department marketplaces on local servers (IP:port), configured in Settings → Marketplace (name, department, IP:port). Plugins bundle agents, workflows (slash commands), team instructions and optional MCP servers (off unless allowed). Browse, search, install, update all, uninstall. Packages are checked against their published sha256, validated before writing and tracked for clean uninstall. Updates are checked at startup, marketplace hosts bypass the proxy, and the list is lockable by enterprise policy. Publishing script `scripts/marketplace/build-index.mjs` and `marketplace-example/`.
- **Light mode:** one-click ☀/🌙 toggle in the sidebar, a polished light theme, and "System" follows Windows live.
- **Clean instruction mode (default):** harness-preloaded instructions, skills and extensions are switched off per harness: Copilot `--no-custom-instructions`; OpenCode clean global-config copy + `OPENCODE_DISABLE_PROJECT_CONFIG` / `OPENCODE_DISABLE_CLAUDE_CODE`; Pi `--no-context-files --no-skills --no-extensions --no-prompt-templates`; Duo partial. Option to keep project AGENTS.md. **Team rules** are sent to every agent. Settings → Agents shows what is applied per harness.
- **Animations:** the spinning ring is replaced by a soft pulsing halo and a breathing icon; avatars are round.

## 0.3.0 — 2026-11-13
- **Pi:** native `pi --mode rpc` adapter. Pi is now found when only `pi` is installed (no `pi-acp` needed). It streams, supports abort, reports usage, resumes sessions, and read-only mode uses Pi's read-only tool set.
- **Models:** discovered from each harness (ACP `availableModels` or a model config option; Pi `get_available_models`; `opencode models` as a fallback), cached, and suggested in the chat header, Settings → Harnesses and per-agent overrides. The selected model is applied via `session/set_config_option` or `set_model`.
- **New specialist:** 🥊 Challenger (adversarial review of plans and implementations). The coordinator and the plan workflow consult it.
- **Activity animations:** specialist list, streaming avatars, agent chips and status pills.
- **IBM Jazz fix:** login no longer uses manual redirects, which Electron cancels ("redirect was canceled"). Jazz now has its own persistent cookie session, detects login success or failure from EWM auth headers, and gives a clear error for OIDC/JAS redirects.
- **Proxy:** standard `https_proxy`/`http_proxy`/`no_proxy` are used everywhere, and the Electron binary download is repaired automatically.

## 0.2.0 — 2026-11-13
- **New specialists:** 📊 Presentation Expert (PowerPoint create/edit via the new `office` MCP server: outline, slide detail, create from a corporate template, targeted edits, tables, images, notes, native Ishikawa slides) and 🧭 NOW Analysis & RCA (NOW format, Ishikawa + 5 Whys, INCOSE practice).
- **Ishikawa diagrams in chat:** a fenced `ishikawa` block renders as a fishbone; confirmed causes are highlighted and ruled-out causes struck through. Also exported as SVG or PowerPoint shapes.
- **Bring your own agents:** an editable template, live validation, import from the editor, files or drag-and-drop, plus export and remove. Agents can declare skills that load on their first turn.
- **Progress flowchart:** per agent, it shows the plan steps (from ACP plan updates or the new `report_progress` tool), delegations as branches, approvals, the outcome and an activity timeline. Open it from chats, agent chips or the Agents overview.
- **Branding:** no third-party branding in the app; it is TheFlashMaster throughout.

## 0.1.0 — 2026-11-12
First release.

- **Harnesses:** GitHub Copilot CLI, OpenCode and Pi via ACP; GitLab Duo CLI via headless mode; an offline mock harness.
- **Projects and chats:** projects with chats, streaming, threads, reactions (✅/❌ answer approvals), @mentions and slash commands.
- **Coordination:** TheFlashMaster coordinator with delegation through the flashmaster-core MCP server, and eight specialist roles.
- **Agent control:** an agents overview with pause/resume/stop, a usage dashboard and a SQLite task board.
- **Integrations:** IBM Jazz (EWM/RTC); Vector/AUTOSAR tools (DBC, ARXML, CDD, CAPL, CANoe, DaVinci); winIDEA debugging (isystem.connect).
- **Workflow and settings:** the superpowers workflow on demand, token-efficiency engine, comprehensive settings and an enterprise policy file.
- **Pipelines:** local CI, a GitHub Actions CI on Windows and Linux, and a Windows x64 release (portable exe + per-user installer).
