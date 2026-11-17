// Fake `duo run --goal <text>` for tests: streams the goal back word by word (slowly when it contains SLOW).
// QUIET in a new session's goal: logs a step on stderr like the real CLI and prints a STATUS line, then says nothing for a
// while (Duo thinking), until it is killed. A resumed session (--existing-session-id) answers at once.
// Every run ends by echoing its goal, so tests can see what reached it.
const args = process.argv.slice(2);
const goal = args[args.indexOf("--goal") + 1] ?? "";
const slow = goal.includes("SLOW");
const resumed = args.includes("--existing-session-id");
process.stderr.write("2026-11-17T09:59:59:000 [info]: Session ID: fakesession42\n");
if (goal.includes("QUIET") && !resumed) {
  process.stderr.write("2026-11-17T10:00:00:000 [debug]: polling workflow\n");
  process.stderr.write("2026-11-17T10:00:01:000 [info]: Reading src/brake_light.c\n");
  process.stdout.write("STATUS: reading the brake light sources\n");
  await new Promise((r) => setTimeout(r, 20000));
}
const words = ["Duo ", "is ", "working ", "on ", "it ", "step ", "by ", "step ", "and ", "then ", "done."];
for (const w of words) {
  process.stdout.write(w);
  await new Promise((r) => setTimeout(r, slow ? 150 : 1));
}
process.stdout.write(`\n${resumed ? "(resumed) " : ""}Goal was: ${goal.replace(/\s+/g, " ").slice(0, 400)}\n`);
