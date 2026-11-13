---
# ─────────────────────────────────────────────────────────────────────────────
# TheFlashMaster agent template
# Edit this file (yourself or with an LLM), then import it: Settings → Agents → Import,
# the ＋ next to "Specialists" in the sidebar, or drag the .md file onto the app window.
# Lines starting with # inside this header are comments and are ignored.
# ─────────────────────────────────────────────────────────────────────────────

# Unique id: lowercase letters, digits and dashes. Used for @mentions (@my-agent).
# Reusing a built-in id (e.g. reviewer) overrides that built-in agent.
name: my-agent

# Display name and icon (one emoji) shown in the specialist list.
title: My Agent
icon: 🤖

# One sentence: what this agent is for. The coordinator reads it to decide when to delegate here.
description: Describe what this agent does and when to use it.

# Optional: pin a harness (copilot | opencode | pi | duo | mock) and a model id. Remove these lines to use the defaults.
# harness: copilot
# model: gpt-5

# MCP tool servers the agent may use. Built-in: flashmaster-core (always on), jazz, vector-autosar, winidea, office.
# Your own servers from Settings → MCP servers can be listed by their id too.
tools: [flashmaster-core]

# Optional: set to true if this agent changes code. When it is delegated in a git project it then works in its own
# worktree and branch, so agents running in parallel don't overwrite each other (Settings → Agents).
# isolate: true

# Upper bound for the summary this agent returns to whoever delegated to it (token efficiency).
maxResultTokens: 400

# Optional workflow skills loaded on this agent's first turn: brainstorm, plan, execute, tdd, debug, review, verify.
skills: []
---
You are <role>. Write the agent's instructions here, in the second person.

Recommended structure (keep it short — this text is sent at the start of every session):
1. Mission: what you produce and for whom.
2. Method: the steps you follow, and the tools you use for each step.
3. Quality bar: the rules your output must satisfy.
4. Output: the exact format you answer in (TheFlashMaster adds the <result> block contract automatically).
5. Boundaries: what you must never do (e.g. edit files, change Jazz items without being asked).
