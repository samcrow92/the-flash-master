# Changelog

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
