---
name: Systematic debugging
command: debug
description: Find the root cause before fixing
---
1. Reproduce reliably and capture the exact symptom (message, values, conditions).
2. Read the code path. List 2–3 hypotheses ranked by likelihood.
3. Design the cheapest observation that discriminates between them (log, assert, breakpoint, test).
4. Confirm the root cause with evidence. Do not stack fixes on guesses.
5. Write a failing test for the bug, fix it, run the full relevant suite, and explain why it happened.
