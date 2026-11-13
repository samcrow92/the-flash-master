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
// @electron/get only reads GLOBAL_AGENT_* proxy variables: map the standard http_proxy/https_proxy/no_proxy onto them.
const e = process.env;
const pick = (...names) => names.map((n) => e[n]).find((v) => v);
const env = { ...e, ELECTRON_GET_USE_PROXY: e.ELECTRON_GET_USE_PROXY ?? "1" };
const httpsProxy = pick("GLOBAL_AGENT_HTTPS_PROXY", "https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY");
const httpProxy = pick("GLOBAL_AGENT_HTTP_PROXY", "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY");
const noProxy = pick("GLOBAL_AGENT_NO_PROXY", "no_proxy", "NO_PROXY");
if (httpsProxy) env.GLOBAL_AGENT_HTTPS_PROXY = httpsProxy;
if (httpProxy) env.GLOBAL_AGENT_HTTP_PROXY = httpProxy;
if (noProxy) env.GLOBAL_AGENT_NO_PROXY = noProxy;
if (httpsProxy) console.log(`  using proxy ${httpsProxy.replace(/\/\/[^@/]*@/, "//***@")}`);
const r = spawnSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit", env });
if (r.status === 0 && ok()) { console.log("✔ Electron ready"); process.exit(0); }

console.error(`
✖ Could not download the Electron binary.
  Behind a corporate proxy: set https_proxy / http_proxy (e.g. $env:https_proxy = "http://proxy:port") and retry.
  Or use an internal mirror:
    $env:ELECTRON_MIRROR = "https://<your-mirror>/electron/"; npm run dev
  Also check: npm config get ignore-scripts   (true = npm skipped the download)
`);
process.exit(1);
