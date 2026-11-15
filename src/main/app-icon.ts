import { join } from "node:path";

/**
 * Where the lightning-bolt icon lives. Windows takes the taskbar icon from the window, so a missing or unreadable file
 * means Electron's default icon (or none). Packaged builds ship build/ in resources (electron-builder extraResources);
 * from source it sits in the repo root, which is the app path for `electron .` / electron-vite, and ../../build from
 * out/main when Electron is started on the entry file directly. The first folder that has the file wins.
 */
export function iconCandidates(opts: { platform: NodeJS.Platform; dirs: (string | undefined)[] }): string[] {
  const names = opts.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  const dirs = [...new Set(opts.dirs.filter((d): d is string => !!d))];
  return names.flatMap((n) => dirs.map((d) => join(d, "build", n)));
}

