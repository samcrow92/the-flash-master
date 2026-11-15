import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { defaultShell, Terminals } from "../src/main/terminal";
import type { AppEvent } from "../src/shared/types";

describe("defaultShell", () => {
  it("uses PowerShell on Windows, preferring PowerShell 7 on PATH", () => {
    const ps = defaultShell("win32", { SystemRoot: "C:\\Windows", PATH: "" });
    expect(ps.name).toBe("Windows PowerShell");
    expect(ps.file).toMatch(/WindowsPowerShell.v1\.0.powershell\.exe$/);
  });
  it("uses the login shell on macOS and $SHELL on Linux", () => {
    expect(defaultShell("darwin", { SHELL: "/bin/zsh" })).toEqual({ file: "/bin/zsh", args: ["-l"], name: "zsh" });
    expect(defaultShell("darwin", {}).file).toBe("/bin/zsh");
    expect(defaultShell("linux", { SHELL: "/usr/bin/fish" }).name).toBe("fish");
  });
});

function fakePty() {
  const h: { data?: (d: string) => void; exit?: (e: { exitCode: number }) => void } = {};
  const pty = {
    pid: 1, written: [] as string[], size: [0, 0], killed: false,
    onData: (cb: (d: string) => void) => { h.data = cb; },
    onExit: (cb: (e: { exitCode: number }) => void) => { h.exit = cb; },
    write(d: string) { this.written.push(d); },
    resize(c: number, r: number) { this.size = [c, r]; },
    kill() { this.killed = true; },
  };
  return { pty, h };
}

describe("Terminals", () => {
  it("coalesces output, forwards input and resizes, and reports exit", async () => {
    vi.useFakeTimers();
    const events: AppEvent[] = [];
    const { pty, h } = fakePty();
    const spawn = vi.fn((_file: string, _args: string[], _opts: Record<string, unknown>) => pty);
    const t = new Terminals((e) => events.push(e), async () => spawn);
    const s = await t.open({ cols: 120, rows: 30, cwd: tmpdir() });
    expect(s.cwd).toBe(tmpdir());
    expect(spawn.mock.calls[0]![2]).toMatchObject({ cols: 120, rows: 30, name: "xterm-256color" });
    h.data!("a"); h.data!("b"); h.data!("c");
    expect(events).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(events).toEqual([{ type: "terminal.data", id: s.id, data: "abc" }]);
    t.write(s.id, "ls\r");
    t.resize(s.id, 0, 99999);
    expect(pty.written).toEqual(["ls\r"]);
    expect(pty.size).toEqual([80, 1000]);
    h.data!("tail");
    h.exit!({ exitCode: 3 });
    expect(events.slice(1)).toEqual([{ type: "terminal.data", id: s.id, data: "tail" }, { type: "terminal.exit", id: s.id, code: 3 }]);
    expect(t.count).toBe(0);
    vi.useRealTimers();
  });

  it("falls back to the home folder for a missing cwd and kills shells on closeAll", async () => {
    const { pty } = fakePty();
    const t = new Terminals(() => undefined, async () => () => pty);
    const s = await t.open({ cols: 80, rows: 24, cwd: "/definitely/not/here" });
    expect(s.cwd).not.toBe("/definitely/not/here");
    t.closeAll();
    expect(pty.killed).toBe(true);
    expect(t.count).toBe(0);
  });

  it("starts a real shell through node-pty", async () => {
    const events: AppEvent[] = [];
    const t = new Terminals((e) => events.push(e));
    const s = await t.open({ cols: 80, rows: 24 });
    t.write(s.id, process.platform === "win32" ? "Write-Output ('pty'+'-ok'); exit\r" : "echo pty''-ok; exit\r");
    await vi.waitFor(() => expect(events.some((e) => e.type === "terminal.exit")).toBe(true), { timeout: 20000 });
    const out = events.map((e) => (e.type === "terminal.data" ? e.data : "")).join("");
    expect(out).toContain("pty-ok");
  }, 30000);
});
