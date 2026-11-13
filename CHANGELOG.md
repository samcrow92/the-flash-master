# Changelog

## Unreleased
- **Marketplace:** department marketplaces on local servers (IP:port), configured in Settings → Marketplace with an optional encrypted token. Plugins bundle agents, workflows (slash commands), team instructions and optional MCP servers (opt-in by policy). Browse, search, install, update all, uninstall. sha256 integrity checks, atomic validation, provenance tracking, startup update check or auto-update, proxy bypass for marketplace hosts, lockable by enterprise policy. Publishing script `scripts/marketplace/build-index.mjs` and `marketplace-example/`.
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
