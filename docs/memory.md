# Agent memory

TheFlashMaster gives every agent a memory that outlives chats and harness sessions. It lives in the app's own SQLite
database (`flashmaster.db`), so it works offline, on Windows, macOS and Linux, with no extra service or runtime dependency.

## Scopes

| Scope | UI name | Who sees it | Lifetime |
|---|---|---|---|
| `user` | About you | every agent, in every project | until deleted |
| `project` | Shared by agents | the coordinator and all specialists of one project (the master chat counts as its own workspace) | until deleted |
| `session` | Short-term | the agents of one chat | `memory.shortTermDays` (default 7) after it was last saved or edited, unless promoted |

Each memory has a kind (`fact`, `preference`, `decision`, `procedure`, `episode`), tags, an importance from 1 to 5 and an
optional pin (pinned memories are always shown to agents).

## Agent tools (flashmaster-core)

`memory_save`, `memory_search`, `memory_list`, `memory_update`, `memory_delete`, `memory_promote`. They reach the app
through the same bridge as the other core tools, so they work on every harness (MCP or text-mode TOOL lines). An agent can
only see and change user memories, its project's memories and its chat's short-term memories.

## What happens automatically

- **Recall.** On the first turn of a harness session the agent gets a `## Relevant memory` block: the pinned memories
  plus the best matches for the request. Later turns only add relevant memories it has not been shown yet.
  `memory.autoInject`, `memory.maxInjected`.
- **Rules.** A short memory rule is added to the team rules once per session, so agents know when to save and to which scope.
- **Results.** A delegated specialist's result summary is saved as a short-term `episode` of the chat, so the other agents
  there know what was done (`memory.captureResults`).
- **Consolidation.** Saving a near-duplicate of a memory in the same scope merges into it (tags joined, highest importance
  kept). Close but different memories are returned as `similar` so the agent can update or replace them (`replaces`).
- **Cleanup.** Expired short-term memories, and memories of deleted chats or projects, are swept at start and hourly.

## Project knowledge base (synced with git)

Each project has a knowledge base: short documents on one topic each (overview, module map, build / test / release,
conventions, gotchas, decisions, glossary) that Flash Master writes and the team reviews and edits in git.

- **Where it lives.** In the app, entries are project memories with a slug (`memories.kb_slug`), so recall, search and the
  Memory page work on them like on any memory. In the repo, each entry is `.flashmaster/knowledge/<slug>.md` (front
  matter: `tags`, `kind`, `importance`, `pinned`; then Markdown starting with `# Title`), plus a generated `README.md`
  index. `.flashmaster/.gitignore` keeps attachments out of git but lets the knowledge folder in (older projects' bare `*`
  is upgraded).
- **Checkpoint.** `.flashmaster/knowledge/manifest.json` holds `indexedCommit`: the commit the knowledge base was last
  built or updated from. The agent sets it with `knowledge_checkpoint` when it finishes.
- **Build / update.** The **Build** / **Update** button on the Memory page (pick a project), the palette command
  *Knowledge base · Build or update*, or `/kb [focus]` in a project chat. The button runs in the project's
  "📚 Knowledge base" chat so the work stays visible. Without a checkpoint it is a full build; with one, Flash Master gets
  the commits and files changed since (`git diff --name-only <checkpoint> HEAD`) and only updates the entries they affect.
- **Sync.** The **Sync** button, *Knowledge base · Sync with the repo*, or `/kb-sync`; also automatic at start and every
  `memory.knowledgeSyncMinutes` (`memory.knowledgeSync`). It is a three-way merge per entry between the database, the file,
  and the hash both had at the last sync (`knowledge_sync` table): only the file changed (a teammate's edit, a pull) →
  imported; only the app changed (an agent or you on the Memory page) → written to the file; deletions follow the same
  rule. Both changed → a conflict: nothing is overwritten and the Memory page offers *Use repo version* / *Keep mine*.
  Files with git merge markers or that can't be read are reported, never imported. Line endings (CRLF checkouts on
  Windows) and a BOM don't count as changes.
- **Code graph (graphify).** **Scan code** on the Memory page (or *Knowledge base · Scan code (graphify)* in the palette)
  runs [graphify](https://github.com/Graphify-Labs/graphify) (Apache-2.0) on the project: `graphify update . --force`, a
  local tree-sitter pass over the code, no LLM and no API key. The first scan installs it from PyPI (`graphifyy`) into its
  own venv in app data (`<data>/graphify/.venv`, Python 3.11+, the proxy / index / CA settings of Settings → MCP apply);
  graphify is installed, never vendored. The graph, its cache and the interactive `graph.html` (*Open graph*) stay local
  in `.flashmaster/graphify` (git-ignored; `.flashmaster/.graphifyignore` keeps graphify out of its own output and the
  knowledge files). Its report becomes the entry `code-map` (hubs, surprising connections, import cycles, suggested
  questions, communities cut to fit), which syncs to the repo like every entry, so teammates and agents' recall get it.
  Agents ask the full graph with `code_graph` (query, explain, path, god_nodes, affected), and a knowledge base build
  starts from `code-map` when it is there. Scans run only when you press the button.
- **Agent tools.** `knowledge_list`, `knowledge_read`, `knowledge_write`, `knowledge_delete`, `knowledge_checkpoint`, `code_graph`.
- **Committing** stays with you: the Memory page shows how many knowledge files are not committed yet.

## Design notes (state of the art, November 2026)

The design borrows the parts of current agent-memory systems that fit a local desktop app:

- **Scoped stores** like Mem0's user / agent / run memory and LangMem's namespaces: here user / project / session.
- **Agent-managed memory** like Letta (MemGPT) and Claude's memory tool: agents decide what to save, update and delete
  through tools, instead of a hidden extractor model. TheFlashMaster has no model of its own to call (it drives agent CLIs),
  so extraction is the agents' job, guided by the memory rule; specialists' results are captured without any model call.
- **Consolidation** like Mem0's ADD / UPDATE / DELETE / NOOP: duplicates merge on save, similar memories come back to the
  agent, and `replaces` deletes facts a new one corrects. Contradiction handling stays with the agent, which has the context.
- **Hybrid retrieval** as in Zep / Graphiti and most RAG stacks: a lexical ranking (SQLite FTS5 with Porter stemming and BM25)
  and a fuzzy ranking (cosine over hashed word + character-trigram vectors, a dependency-free stand-in for embeddings that
  catches typos and inflections) fused with Reciprocal Rank Fusion. Weak fuzzy matches are down-weighted.
- **Scoring** from Generative Agents: final score = 0.65 relevance + 0.2 recency (30-day half-life, refreshed when a memory
  is used) + 0.15 importance, plus a small boost for pinned memories.
- **Short-term memory with promotion** like A-MEM's evolving notes and Letta's core vs archival memory: chat notes expire
  unless an agent or the user promotes them.

Not included yet: a temporal knowledge graph (Zep/Graphiti) and neural embeddings. Both can be added behind `MemoryStore`
without changing the tools; the fuzzy ranking is the place an embedding model would plug in.
