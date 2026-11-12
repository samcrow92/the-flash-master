---
name: Writing plans
command: plan
description: Turn an approved design into small verifiable tasks
---
Write an implementation plan a capable engineer with no context could follow.
- Tasks of 2–10 minutes each, in dependency order. Mark which tasks are independent (they can run in parallel).
- For each task: files to touch, the change, the test to write first, and the exact command proving it works.
- YAGNI: nothing beyond the approved design. DRY: reuse what exists.
- Save the plan as an artifact (or in docs/plans/) and give a short summary.
