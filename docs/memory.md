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
