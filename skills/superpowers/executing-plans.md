---
name: Executing plans
command: execute
description: Execute a plan task by task, delegating independent work
---
- Take tasks in order. For independent tasks, delegate each one to a specialist with a precise brief (task text,
  files, acceptance), using `wait: false`, then collect the results.
- After each task: run its verification command, and get a review (reviewer role) for non-trivial changes.
- Update the task board as you go. Stop and report if a task's assumptions turn out wrong. Do not improvise scope.
