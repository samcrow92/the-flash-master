# pstack skills (bundled)

`unslop.md` is the `unslop` skill from [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan, MIT licensed (see `LICENSE` in this folder).
Taken from cursor/plugins at commit e1cc031 (2026-11-16). Only the frontmatter differs from upstream, so the app can load it as a skill.

How it is used:
- It is sent to every agent on its first turn, as a writing rule for everything the agent writes, including text it writes through tools (commit messages, PR descriptions, comments, files, reports).
- Turn it off in Settings > Agents > "Unslop writing style" (`agents.unslop`).
- `/unslop` loads it for one message, for example to clean up a draft.
