import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { iconCandidates } from "../src/main/app-icon";

describe("iconCandidates", () => {
  it("prefers the .ico on Windows, in resources first, then the source folders", () => {
    const c = iconCandidates({ platform: "win32", dirs: ["/res", undefined, "/repo", "/repo"] });
    expect(c).toEqual([join("/res", "build", "icon.ico"), join("/repo", "build", "icon.ico"), join("/res", "build", "icon.png"), join("/repo", "build", "icon.png")]);
  });
  it("uses the PNG elsewhere", () => {
    expect(iconCandidates({ platform: "darwin", dirs: ["/a"] })).toEqual([join("/a", "build", "icon.png")]);
  });
});
