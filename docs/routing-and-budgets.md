# Best of N, routing by difficulty and hard budgets

Code decides where tokens go and when to stop, so the coordinator doesn't spend tokens on it and can't overspend.

## Best of N

The coordinator can pass `attempts: 2` or `3` to `delegate` (text mode: `DELEGATE coder attempts "3": …`) for a hard or
risky change. That many specialists of the role try it independently, each in its own worktree and branch. When all are
done, the app ranks them:

1. checks passed (Settings → Checks or `.flashmaster/checks.json`), then no checks set up, then checks failed;
2. a finished result before an error or a failed one;
3. the smallest real change (an attempt that changed nothing ranks last).

The coordinator gets the winner's result with a comparison of all attempts. Nothing is discarded: the other branches stay
on the Review page for you. Settings → Agents → Best of N caps the number of attempts (3 by default).

## Routing by difficulty

`delegate` takes `mode`: `eco` for simple lookups and edits, `comfort` for ordinary work, `sport` for hard problems. It
runs the specialist on your matching profile in Settings → Modes & chat, unless the coordinator named a harness or model.
With Settings → Agents → **Route by difficulty** on, the app picks the mode itself when the coordinator names none, from
the brief: root cause, design, concurrency, safety, MISRA and similar words go to SPORT; short lookups (find, list,
summarise, rename) go to ECO; the rest to COMFORT. The choice and its reason appear in the coordinator's progress flow.

## Hard budgets

- **Task budget (per request)**, Settings → Token efficiency, 1,000,000 tokens by default: everything one request of yours
  spends, across the coordinator and all its specialists and helpers. Past it, no new specialist starts; the coordinator
  is told to wrap up with what it has and to tell you. Running specialists finish.
- **Time limit per task**, Settings → Agents, 120 minutes by default: a delegated specialist still working after it is
  interrupted and asked to wrap up (commit what it has, report what is left). If it is still working 3 minutes later it
  is stopped, its work is kept on its branch, and its coordinator gets a "time limit" result to act on.
- The daily, per-project and per-agent token budgets work as before.
