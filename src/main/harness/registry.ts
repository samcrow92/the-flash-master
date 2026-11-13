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
      new AcpAdapter("copilot", "GitHub Copilot CLI", ["copilot"], ["--acp"],
        "Install GitHub Copilot CLI (npm i -g @github/copilot) and run `copilot` once to sign in."),
      new AcpAdapter("opencode", "OpenCode", ["opencode"], ["acp"],
        "Install OpenCode (npm i -g opencode-ai) and run `opencode auth login` once."),
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
    for (const id of ["copilot", "opencode", "pi", "duo"] as HarnessId[]) if (ok(id)) return id;
    return "mock";
  }
}
