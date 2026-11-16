import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { APP_ID, iconCandidates, windowsAppDetails } from "../src/main/app-icon";

describe("iconCandidates", () => {
  it("prefers the .ico on Windows, in resources first, then the source folders", () => {
    const c = iconCandidates({ platform: "win32", dirs: ["/res", undefined, "/repo", "/repo"] });
    expect(c).toEqual([join("/res", "build", "icon.ico"), join("/repo", "build", "icon.ico"), join("/res", "build", "icon.png"), join("/repo", "build", "icon.png")]);
  });
  it("uses the PNG elsewhere", () => {
    expect(iconCandidates({ platform: "darwin", dirs: ["/a"] })).toEqual([join("/a", "build", "icon.png")]);
  });
});

describe("windowsAppDetails", () => {
  // The taskbar showed Electron's atom from source: the button follows the app ID's executable unless each window carries
  // the bolt as its relaunch icon.
  it("gives every window the bolt as its taskbar icon, with the release ID when packaged", () => {
    expect(windowsAppDetails({ packaged: true, execPath: "C:\\App\\TheFlashMaster.exe", appPath: "C:\\App\\resources\\app.asar", iconFile: "C:\\App\\resources\\build\\icon.ico" })).toEqual({
      appId: APP_ID, appIconPath: "C:\\App\\resources\\build\\icon.ico", appIconIndex: 0,
      relaunchCommand: '"C:\\App\\TheFlashMaster.exe"', relaunchDisplayName: "TheFlashMaster",
    });
  });
  it("relaunches the portable exe, not its temporary unpacked copy", () => {
    const d = windowsAppDetails({ packaged: true, execPath: "C:\\Temp\\x\\TheFlashMaster.exe", appPath: "", iconFile: "i.ico", portableExe: "D:\\TheFlashMaster-portable.exe" });
    expect(d.relaunchCommand).toBe('"D:\\TheFlashMaster-portable.exe"');
  });
  it("uses its own ID from source, so it never takes an installed copy's shortcut icon", () => {
    const d = windowsAppDetails({ packaged: false, execPath: "C:\\repo\\node_modules\\electron\\dist\\electron.exe", appPath: "C:\\repo", iconFile: "C:\\repo\\build\\icon.ico" });
    expect(d.appId).toBe(`${APP_ID}.dev`);
    expect(d.appIconPath).toBe("C:\\repo\\build\\icon.ico");
    expect(d.relaunchCommand).toBe('"C:\\repo\\node_modules\\electron\\dist\\electron.exe" "C:\\repo"');
  });
  it("sets no relaunch icon without a readable .ico", () => {
    expect(windowsAppDetails({ packaged: true, execPath: "a.exe", appPath: "", iconFile: "" }).appIconPath).toBeUndefined();
  });
});
