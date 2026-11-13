#!/usr/bin/env node
// Writes release/latest.json for the in-app updater: version + installer/portable file names, SHA-256 and size.
// Run after `electron-builder --win` in your release pipeline, then attach latest.json together with the two .exe
// files to the release tagged v<version> (the version in package.json). Options: --notes "text", --dir release
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dir = arg("dir", "release");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const files = readdirSync(dir).filter((f) => f.endsWith(".exe") && f.includes(version)).map((name) => {
  const p = join(dir, name);
  return {
    kind: /portable/i.test(name) ? "portable" : "setup",
    name,
    sha256: createHash("sha256").update(readFileSync(p)).digest("hex"),
    size: statSync(p).size,
  };
});
if (!files.length) { console.error(`No ${version} .exe files in ${dir}/ — run electron-builder first`); process.exit(1); }
const manifest = { version, date: new Date().toISOString(), notes: arg("notes", ""), files };
writeFileSync(join(dir, "latest.json"), JSON.stringify(manifest, null, 2));
console.log(`${dir}/latest.json: ${version} — ${files.map((f) => `${f.kind} ${f.name}`).join(", ")}`);
