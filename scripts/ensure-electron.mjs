// Ensures the Electron binary is present before dev/build. npm skips Electron's download when
// install scripts are disabled (ignore-scripts=true) or a proxy blocked it, which ends in "Error: Electron uninstall".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const dir = join(process.cwd(), "node_modules", "electron");
const ok = () => {
  try {
    const p = readFileSync(join(dir, "path.txt"), "utf8").trim();
    return existsSync(join(dir, "dist", p));
  } catch { return false; }
};

if (!existsSync(dir)) {
  console.error("✖ node_modules/electron is missing — run `npm ci` first.");
  process.exit(1);
}
if (ok()) process.exit(0);

console.log("⚙ Electron binary not downloaded yet — downloading it now…");
const r = spawnSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit", env: { ...process.env, ELECTRON_GET_USE_PROXY: process.env.ELECTRON_GET_USE_PROXY ?? "1" } });
if (r.status === 0 && ok()) { console.log("✔ Electron ready"); process.exit(0); }

console.error(`
✖ Could not download the Electron binary.
  Behind a corporate proxy (PowerShell):
    $env:GLOBAL_AGENT_HTTPS_PROXY = "http://proxy:port"; npm run dev
  Or use an internal mirror:
    $env:ELECTRON_MIRROR = "https://<your-mirror>/electron/"; npm run dev
  Also check: npm config get ignore-scripts   (true = npm skipped the download)
`);
process.exit(1);
