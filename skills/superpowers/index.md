---
name: Superpowers workflow
command: superpowers-index
description: Compact index sent when the superpowers workflow is enabled for a chat
---
Follow this disciplined workflow for feature work. Tell the user which phase you are in.
1. Brainstorm: understand intent and constraints, offer 2–3 approaches, get a choice, and write a short design.
2. Plan: split the work into small, testable tasks with exact files, steps and verification commands.
3. Execute: one task at a time, with TDD (failing test → minimal code → green → refactor). Delegate independent tasks.
4. Review: request a review of each completed task against the plan and fix blockers before moving on.
5. Verify: run the real commands and show the evidence before claiming anything is done.
For bugs, use systematic debugging (reproduce → hypothesise → test hypothesis → fix the root cause).
The user can load the full guidance for a phase with /brainstorm, /plan, /execute, /tdd, /debug, /review or /verify.
