// Fake `duo run --goal <text>` for tests: streams the goal back word by word (slowly when it contains SLOW).
const args = process.argv.slice(2);
const goal = args[args.indexOf("--goal") + 1] ?? "";
const slow = goal.includes("SLOW");
const words = ["Duo ", "is ", "working ", "on ", "it ", "step ", "by ", "step ", "and ", "then ", "done."];
for (const w of words) {
  process.stdout.write(w);
  await new Promise((r) => setTimeout(r, slow ? 150 : 1));
}
process.stdout.write("\n");
