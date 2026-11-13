# Vision

TheFlashMaster lets one engineer run a team of AI agents on their own projects, on their own machine, with the agent CLIs their company already approved.
It is built for enterprise automotive software teams: Windows desktops, corporate proxies, IBM Jazz, AUTOSAR, HiL/SiL test benches and strict IT policies.

## Principles

**Everything visible, everything steerable.**
You can always see what each agent is doing: its progress, tool calls, commands and their output.
You can step in at any moment to pause, steer, approve or stop.
Outcome views and summaries are extra options on top of that detail, never a replacement for it.

**Your machine, your logins.**
The app calls no model API itself, stores no model credentials and has no login.
It drives the CLIs you already signed in to (Copilot, OpenCode, Pi, GitLab Duo) and leaves their configs untouched.

**One coordinator, many specialists.**
You talk to TheFlashMaster, which plans, delegates and integrates.
Specialists get briefs, not transcripts, and return compact, structured results.
When a specialist needs a decision, it says so, and you see the question right away.

**Tokens are a budget.**
Every agent's context stays lean: stable prompt prefixes, on-demand skills and tools, capped results, artifacts by id, rolling compaction, and query tools instead of file dumps.
Usage is measured and shown, and estimates are labelled as estimates.

**Parallel work never collides, and nothing is lost.**
Specialists that change code work in their own git worktree and branch.
Unmerged work is never deleted without your explicit word.
Closing the app interrupts agents instead of throwing their work away, and you can resume them.

**Code owns the mechanics, agents own the judgment.**
Anything exact, such as git, merging, cleanup, budgets, parsing results or detecting a stuck agent, lives in code.
Agents spend tokens only on what needs understanding.

**Rules are checked, not just written.**
A rule that can be tested lives in `tests/invariants.test.ts`, and every bug fix lands with the test that would have caught it.

## A change fits when it

- shows more of what agents do, or makes steering them easier;
- turns more of your intent into finished, checked work per token spent;
- keeps parallel work safe and keeps unmerged work recoverable;
- works behind a corporate proxy, without admin rights, on Windows first;
- keeps working when one harness or vendor degrades;
- moves an exact, repeatable step from a prompt into code.

## A change should be resisted when it

- hides progress, tool output or internals by default;
- sends model traffic or credentials anywhere other than the CLIs you signed in to;
- grows every agent's always-loaded prompt instead of loading on demand;
- lets an agent merge, delete or publish without your word;
- couples the app to a single harness;
- spends tokens on what a script can do exactly.
