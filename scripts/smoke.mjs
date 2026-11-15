// Launches the built app in smoke mode: it renders, takes a screenshot and exits 0 if the UI booted.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
// On failure, show what the app logged (smoke steps and errors): CI keeps no other trace of why it failed.
if (r.status !== 0) {
  try {
    const lines = readFileSync(join(data, "logs", "main.log"), "utf8").split("\n").filter((l) => / ERROR |smoke/.test(l));
    console.log(lines.slice(-40).join("\n"));
  } catch { console.log("(no main.log)"); }
}
process.exit(r.status ?? 1);
