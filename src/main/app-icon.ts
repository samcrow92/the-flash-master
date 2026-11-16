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


/** The release app ID (electron-builder appId; the installer's Start-menu shortcut carries it). */
export const APP_ID = "com.theflashmaster.app";

/**
 * The Windows taskbar button doesn't always draw the window's icon: once the process has an explicit AppUserModelID it
 * resolves the button through that ID, i.e. a shortcut carrying it (pinned or Start menu, with whatever icon Windows
 * cached for it) or else the running executable. From source that executable is electron.exe, so the button showed
 * Electron's atom even though the window had the bolt. Each window therefore gets the bolt as its relaunch icon
 * (System.AppUserModel.RelaunchIconResource), which the taskbar uses for the button and for pinning.
 * Source runs use their own ID so they never borrow an installed copy's shortcut (and its cached icon).
 */
export function windowsAppDetails(o: { packaged: boolean; execPath: string; appPath: string; iconFile: string; portableExe?: string }): {
  appId: string; appIconPath?: string; appIconIndex?: number; relaunchCommand: string; relaunchDisplayName: string;
} {
  const exe = o.packaged ? o.portableExe || o.execPath : o.execPath;
  return {
    appId: o.packaged ? APP_ID : `${APP_ID}.dev`,
    ...(o.iconFile ? { appIconPath: o.iconFile, appIconIndex: 0 } : {}),
    relaunchCommand: o.packaged ? `"${exe}"` : `"${exe}" "${o.appPath}"`,
    relaunchDisplayName: o.packaged ? "TheFlashMaster" : "TheFlashMaster (dev)",
  };
}
