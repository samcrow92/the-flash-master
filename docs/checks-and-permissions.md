# Checks before merge, permission rules and hooks

Code owns the mechanics: whether a branch builds and passes its tests, and whether a command may run, are decided by the
app on every harness, not by an instruction an agent may skip.

## Checks before merge

When a code-writing specialist finishes and its branch holds new work, TheFlashMaster runs the project's own checks in the
specialist's worktree. A failure goes straight back to that specialist with the end of the output ("round 1 of 2"), and
only after the last fix round does the result reach the coordinator, with a `checks:` line saying how it went.

Merge (Agents page and Review page) waits for a green run of the branch's current commit. If the last run is missing or
out of date, Merge runs the checks first. When they fail you can still choose **Merge anyway**; agents never can.

Where the commands come from, first match wins:

1. `.flashmaster/checks.json` in the project, shared with the team through git:

   ```json
   { "checks": [
       { "name": "Build", "command": "cmake --build build", "timeoutMinutes": 20 },
       { "name": "Unit tests", "command": "ctest --test-dir build --output-on-failure" },
       { "name": "MISRA", "command": "cppcheck --addon=misra --error-exitcode=1 src" }
   ] }
   ```

2. **Settings → Checks → Default check commands**, one per line, optionally `Name: command`.

Each command runs through the platform shell (cmd.exe on Windows) in the worktree with `CI=1` and the app's proxy
settings. Exit code 0 passes. Settings → Checks also sets the fix rounds, the timeout and whether Merge is gated.

## Permission rules

**Settings → Permissions → Permission rules**, one per line:

```
[role:] allow|ask|deny [kind] pattern
deny git push *--force*        # a command (execute calls)
ask  git push *                # "x *" also matches x alone; ask asks even on Autopilot
tester: allow npm test *       # only for the tester role
deny edit **/*.pem             # a path rule for edit / delete / move / read calls
deny fetch *                   # any web fetch
```

Commands are split at `&&`, `||`, `;`, `|` and `&`, tokenized with quotes respected, and wrappers such as `sudo`,
`env X=1`, `cmd /c`, `powershell -Command` and `bash -c` are peeled off, so `cmd /c "git push -f"` still matches. Matching
ignores case. deny beats ask beats allow; a compound command is allowed by rules only when every part is. Calls no rule
decides follow **Tool approval**. Use **Try a command** under the rules to see what they decide.

The defaults deny `rm -rf /`, `format c:`, force pushes, `git clean -fdx` and edits inside `.git`. **Blocked commands
(legacy)** still denies any call containing its text.

## Hooks

**Settings → Permissions → Hooks**, one per line: `<event> [match] => <command>`.

| Event | When | Can it decide? |
|---|---|---|
| `pre_tool` | before a tool call the agent asks to run | yes: exit 2 denies (stderr is the reason), or print `{"decision":"allow"\|"ask"\|"deny","reason":"…"}` |
| `post_tool` | after a tool call completed or failed | no |
| `turn_end` | an agent finished a turn | no |
| `checks_done` | the checks ran on an agent's worktree | no |

`match` is a command pattern (as in rules) for execute calls, or a tool kind (`edit`, `read`, `fetch`, …); leave it out
for all. The event arrives as JSON on stdin and as `FLASH_HOOK_EVENT`, `FLASH_AGENT`, `FLASH_ROLE`, `FLASH_CWD`,
`FLASH_TOOL_KIND`, `FLASH_COMMAND`, `FLASH_PATHS`, `FLASH_STATUS` and `FLASH_OK`. A hook that crashes or times out (15 s)
is logged and ignored, so it never stalls an agent.

```
pre_tool  git push *  => node C:\tools\guard-release-branch.js
post_tool edit        => npx prettier --write "%FLASH_PATHS%"
checks_done           => powershell -File C:\tools\post-to-teams.ps1
```
