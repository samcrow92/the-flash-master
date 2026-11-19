// Fake `DUO_WORKFLOW_GOAL=<text> duo run` for tests: streams the goal back word by word (slowly when it contains SLOW).
// The goal must come from the environment: a goal on the command line fails the run (spawn ENAMETOOLONG on Windows).
// A goal that points at a .flashmaster-duo file is read from that file, like the real CLI's read_file tool would.
// TOOLS in the goal: logs tool calls on stderr the way headless Duo does.
// QUIET in a new session's goal: logs a step on stderr like the real CLI and prints a STATUS line, then says nothing for a
// while (Duo thinking), until it is killed. A resumed session (--existing-session-id) answers at once.
// Every run ends by echoing its goal, so tests can see what reached it.
// Each run is a new process, like the real CLI: only a resumed session (--existing-session-id) has seen earlier goals.
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--goal") || args.includes("-g")) {
  process.stderr.write("2026-11-17T09:59:59:000 [error]: the goal must come from DUO_WORKFLOW_GOAL, not the command line\n");
  process.exit(3);
}
let goal = process.env.DUO_WORKFLOW_GOAL ?? "";
const goalFile = /(\.flashmaster-duo\/goal-[\w-]+\.md)/.exec(goal)?.[1];
if (goalFile) goal = `(from file) ${readFileSync(goalFile, "utf8")}`;
const slow = goal.includes("SLOW");
const resumed = args.includes("--existing-session-id");
// Like duo-cli 9.x: the session (workflow) id only appears in these log lines. NOSESSION in the goal: no id is logged.
const resumeId = resumed ? args[args.indexOf("--existing-session-id") + 1] : null;
if (!goal.includes("NOSESSION")) {
  process.stderr.write(resumed
    ? `2026-11-17T09:59:59:000 [info]: Workflow source=local (resume); attaching to ${resumeId} (definition: chat, flow: chat)\n`
    : "2026-11-17T09:59:59:000 [info]: Workflow source=local (fresh); created 4122303 (flow: chat), capabilities=[none]\n");
}
if (goal.includes("QUIET") && !resumed) {
  process.stderr.write("2026-11-17T10:00:00:000 [debug]: polling workflow\n");
  process.stderr.write("2026-11-17T10:00:01:000 [info]: Reading src/brake_light.c\n");
  process.stdout.write("STATUS: reading the brake light sources\n");
  await new Promise((r) => setTimeout(r, 20000));
}
if (goal.includes("TOOLS")) {
  const log = (l) => process.stderr.write(`2026-11-19T07:00:00.000Z [info]: ${l}\n`);
  log("Tool started: read_file");
  log('Tool input: {"file_path":"src/brake_light.c"}');
  log("Tool completed: toolu_1");
  log("Tool started: run_command");
  log('Tool input: {"program":"make","args":["test"]}');
  process.stderr.write("2026-11-19T07:00:01.000Z [info]: Tool completed: toolu_2\n2026-11-19T07:00:01.000Z [info]: Tool started: grep\n");
  log('Tool input: {"pattern":"TODO"}');
  log("Tool completed: toolu_3");
  log("Tool started: edit_file");
  log('Tool input: {"file_path":"README.md"}');
  log("Tool completed: toolu_4"); // the real CLI logs a failed call as completed, then its error
  process.stderr.write("2026-11-19T07:00:03.000Z [error]: Tool error: file is read-only\n");
}
const words = ["Duo ", "is ", "working ", "on ", "it ", "step ", "by ", "step ", "and ", "then ", "done."];
for (const w of words) {
  process.stdout.write(w);
  await new Promise((r) => setTimeout(r, slow ? 150 : 1));
}
process.stdout.write(`\n${resumed ? "(resumed) " : ""}Goal was: ${goal.replace(/\s+/g, " ").slice(0, 400)}\n`);
