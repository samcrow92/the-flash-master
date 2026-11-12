#!/usr/bin/env node
// Local CI pipeline — the same steps GitHub Actions runs.
//   npm run ci                 typecheck → lint → unit/integration tests → python tests → build
//   npm run ci -- --smoke      + launch the built app headlessly and check the UI boots (needs a display / xvfb on Linux)
//   npm run ci -- --dist       + package the Windows x64 portable exe and installer (Windows host)
import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const steps = [
  ["Typecheck", "npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]],
  ["Lint", "npx", ["eslint", "."]],
  ["Unit & integration tests", "npx", ["vitest", "run"]],
  ["Python MCP server tests", "node", ["scripts/run-pytest.mjs"]],
  ["Build", "npx", ["electron-vite", "build"]],
];
if (args.has("--smoke")) steps.push(["Smoke test (launch app)", "node", ["scripts/smoke.mjs"]]);
if (args.has("--dist")) steps.push(["Package Windows x64", "npx", ["electron-builder", "--win", "--x64", "--publish", "never"]]);

const started = Date.now();
for (const [name, cmd, a] of steps) {
  const t = Date.now();
  console.log(`\n▶ ${name}`);
  const r = spawnSync(cmd, a, { stdio: "inherit", shell: isWin });
  if (r.status !== 0) {
    console.error(`\n✖ ${name} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  console.log(`✔ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}
console.log(`\n✔ CI passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
