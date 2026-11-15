#!/usr/bin/env node
// node-pty 1.1.0 publishes its macOS spawn-helper without the executable bit, so every spawn fails with
// "posix_spawnp failed". Restore it after install (packaging copies these permissions into the app).
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "node_modules", "node-pty");
const dirs = [join(root, "build", "Release"), ...(existsSync(join(root, "prebuilds")) ? readdirSync(join(root, "prebuilds")).map((d) => join(root, "prebuilds", d)) : [])];
for (const dir of dirs) {
  const helper = join(dir, "spawn-helper");
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
