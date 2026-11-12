import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SETTINGS, flattenKeys, mergeSettings, type DeepPartial, type Settings } from "@shared/settings";

/**
 * Settings = defaults ← user file ← enterprise policy (policy keys are locked).
 * Policy file (optional): { "settings": { ...partial }, "lock": ["network.proxy", "permissions"] }
 * A lock entry locks that key and everything under it. If "lock" is omitted every key in "settings" is locked.
 */
export class SettingsStore {
  private user: DeepPartial<Settings> = {};
  private policy: DeepPartial<Settings> = {};
  private lockPrefixes: string[] = [];
  private listeners = new Set<(s: Settings) => void>();

  constructor(private file: string, policyFile: string | null) {
    this.user = readJson(file) ?? {};
    const pol = policyFile ? readJson(policyFile) : null;
    if (pol) {
      this.policy = pol.settings ?? {};
      this.lockPrefixes = Array.isArray(pol.lock) ? pol.lock : flattenKeys(this.policy).filter(Boolean);
    }
  }

  get(): Settings {
    return mergeSettings(mergeSettings(DEFAULT_SETTINGS, this.user), this.policy);
  }

  locked(): string[] {
    return flattenKeys(DEFAULT_SETTINGS).filter((k) => this.isLocked(k));
  }

  isLocked(key: string): boolean {
    return this.lockPrefixes.some((p) => key === p || key.startsWith(p + "."));
  }

  update(patch: DeepPartial<Settings>): Settings {
    const allowed = stripLocked(patch, "", (k) => this.isLocked(k));
    this.user = mergeSettings(this.user, allowed);
    this.save();
    const s = this.get();
    for (const l of this.listeners) l(s);
    return s;
  }

  reset(): Settings {
    this.user = {};
    this.save();
    const s = this.get();
    for (const l of this.listeners) l(s);
    return s;
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.user, null, 2));
    renameSync(tmp, this.file);
  }
}

function readJson(file: string): any {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
}

function stripLocked(obj: any, prefix: string, locked: (k: string) => boolean): any {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (locked(key)) continue;
    out[k] = stripLocked(v, key, locked);
  }
  return out;
}
