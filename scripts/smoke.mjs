// Launches the built app in smoke mode: it renders, takes a screenshot and exits 0 if the UI booted.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import electron from "electron";

const data = mkdtempSync(join(tmpdir(), "flash-smoke-"));
const env = { ...process.env, FLASH_DATA_DIR: data, FLASH_SMOKE_SHOT: join(data, "smoke.png") };
const args = [".", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : [])];
const linuxHeadless = process.platform === "linux" && !process.env.DISPLAY;
const r = linuxHeadless
  ? spawnSync("xvfb-run", ["-a", electron, ...args], { stdio: "inherit", env, timeout: 120000 })
  : spawnSync(electron, args, { stdio: "inherit", env, timeout: 120000 });
console.log(`smoke screenshot: ${env.FLASH_SMOKE_SHOT}`);
process.exit(r.status ?? 1);
