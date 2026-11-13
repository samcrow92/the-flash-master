import type { HarnessId, HarnessStatus } from "@shared/types";
import type { Settings } from "@shared/settings";
import { AcpAdapter } from "./acp";
import { DuoAdapter } from "./duo";
import { PiAdapter } from "./pi";
import { MockAdapter } from "./mock";
import type { HarnessAdapter } from "./types";

export class HarnessRegistry {
  private adapters = new Map<HarnessId, HarnessAdapter>();
  private status = new Map<HarnessId, HarnessStatus>();

  constructor(extra: HarnessAdapter[] = []) {
    const defaults: HarnessAdapter[] = [
      new AcpAdapter("copilot", "GitHub Copilot CLI", ["copilot", ...copilotZipLocations()], ["--acp"],
        "Copilot CLI not found — see Documentation → Install Copilot CLI (official download from GitHub), then choose copilot.exe."),
      new AcpAdapter("opencode", "OpenCode", ["opencode"], ["acp"],
        "Install OpenCode (npm i -g opencode-ai) and run `opencode auth login` once."),
      new AcpAdapter("cursor", "Cursor Agent", ["cursor-agent", ...homeBin("cursor-agent")], ["acp"],
        "Install Cursor Agent (curl https://cursor.com/install -fsS | bash; on Windows: irm 'https://cursor.com/install?win32=true' | iex) and run `cursor-agent login` once."),
      new AcpAdapter("claude", "Claude Code", ["claude-agent-acp", ...homeBin("claude-agent-acp")], [],
        "Install Claude Code and sign in (`claude`, then /login), then add its ACP bridge: npm i -g @agentclientprotocol/claude-agent-acp"),
      new PiAdapter(),
      new DuoAdapter(),
      new MockAdapter(),
    ];
    for (const a of [...defaults, ...extra]) this.adapters.set(a.id, a);
  }

  get(id: HarnessId): HarnessAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`unknown harness ${id}`);
    return a;
  }

  async detectAll(settings: Settings): Promise<HarnessStatus[]> {
    const out = await Promise.all([...this.adapters.values()].map(async (a) => {
      const hs = settings.harnesses[a.id];
      const st = hs && !hs.enabled
        ? { id: a.id, label: a.label, available: false, version: null, path: null, protocol: a.protocol, detail: "Disabled in settings" }
        : await a.detect(hs?.path ?? "").catch((e) => ({ id: a.id, label: a.label, available: false, version: null, path: null,
          protocol: a.protocol, detail: String(e) }) as HarnessStatus);
      this.status.set(a.id, st);
      return st;
    }));
    return out;
  }

  cached(id: HarnessId): HarnessStatus | undefined {
    return this.status.get(id);
  }

  /** Pick a usable harness: requested → default setting → first available real → mock. */
  resolve(requested: HarnessId | null | undefined, settings: Settings): HarnessId {
    const ok = (id: HarnessId | null | undefined): id is HarnessId => !!id && settings.harnesses[id]?.enabled !== false &&
      (this.status.get(id)?.available ?? id === "mock");
    if (ok(requested)) return requested;
    if (ok(settings.general.defaultHarness)) return settings.general.defaultHarness;
    for (const id of ["copilot", "opencode", "cursor", "claude", "pi", "duo"] as HarnessId[]) if (ok(id)) return id;
    return "mock";
  }
}

/** Where people usually unzip the official copilot-win32-*.zip download (checked after PATH). */
function copilotZipLocations(): string[] {
  if (process.platform !== "win32") return [];
  const home = process.env.USERPROFILE ?? "";
  const local = process.env.LOCALAPPDATA ?? "";
  return [
    `${local}\\Programs\\copilot\\copilot.exe`,
    `${home}\\Documents\\Tools\\copilot\\copilot.exe`,
    `${home}\\Tools\\copilot\\copilot.exe`,
    ...["x64", "arm64"].flatMap((a) => [`${home}\\Downloads\\copilot-win32-${a}\\copilot.exe`, `${home}\\Downloads\\copilot-win32-${a}\\copilot-win32-${a}\\copilot.exe`]),
  ].filter((p) => !p.startsWith("\\"));
}

/** Per-user install folders a GUI launch may not have on PATH (installers for Cursor Agent, Claude Code, npm -g on macOS). */
function homeBin(name: string): string[] {
  if (process.platform === "win32") return [];
  const home = process.env.HOME ?? "";
  if (!home) return [];
  return [`${home}/.local/bin/${name}`, `${home}/.npm-global/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
}
