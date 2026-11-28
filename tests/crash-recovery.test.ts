import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RELOAD_LIMIT, RELOAD_WINDOW_MS, ReloadBudget, consoleLine } from "../src/main/crash-guard";

const read = (p: string) => readFileSync(p, "utf8");

describe("the window never sits on a blank screen", () => {
  it("reloads a crashed renderer, but gives up when it keeps crashing", () => {
    const b = new ReloadBudget();
    expect(b.take("clean-exit", 0)).toBe("ignore");
    for (let i = 0; i < RELOAD_LIMIT; i++) expect(b.take("crashed", i * 1000)).toBe("reload");
    expect(b.take("oom", 5000)).toBe("give-up");
    expect(b.take("crashed", RELOAD_WINDOW_MS + 5000)).toBe("reload"); // old crashes age out
  });

  it("keeps renderer errors and warnings in main.log, not chatter", () => {
    expect(consoleLine("error", "Maximum update depth exceeded", "file:///app/out/renderer/assets/index.js", 12))
      .toBe("renderer error: Maximum update depth exceeded (index.js:12)");
    expect(consoleLine("warning", "w", "", 0)).toBe("renderer warning: w");
    expect(consoleLine("info", "hi", "x.js", 1)).toBeNull();
    expect(consoleLine("debug", "hi", "x.js", 1)).toBeNull();
  });

  it("every window is guarded, and GPU crashes are logged", () => {
    const main = read("src/main/index.ts");
    // App windows (they load the renderer through our preload): the main window, and openPopout() for chat windows.
    const windows = main.split("new BrowserWindow({").slice(1).filter((c) => c.slice(0, c.indexOf("});")).includes("preload:"));
    expect(windows.length).toBe(2);
    expect(main.match(/guardWebContents\(/g)?.length).toBe(windows.length);
    expect(main).not.toContain("openThreadWindow"); // reply-thread windows went with reply threads (2026-11-28)
    expect(main).toMatch(/function openChatWindow[^]*?openPopout\(/);
    expect(main).toMatch(/app\.on\("child-process-gone"/);
  });

  it("render errors are caught by boundaries around the whole app and around each view", () => {
    expect(read("src/renderer/main.tsx")).toMatch(/<ErrorBoundary name="TheFlashMaster" full>/);
    expect(read("src/renderer/App.tsx")).toMatch(/<main className="main"[^>]*>\s*<ErrorBoundary [^>]*resetKey=/);
    const eb = read("src/renderer/components/ErrorBoundary.tsx");
    expect(eb).toMatch(/getDerivedStateFromError/);
    expect(eb).toMatch(/console\.error\(/); // reaches main.log through the console-message guard
  });
});
