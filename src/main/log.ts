import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export type Level = keyof typeof LEVELS;

/** Tiny rotating file logger (logs/main.log, rotated at 5 MB). */
export function makeLogger(dir: string, level: () => Level) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "main.log");
  return (lvl: Level, msg: string) => {
    if (LEVELS[lvl] > LEVELS[level()]) return;
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 5_000_000) renameSync(file, file + ".1");
      appendFileSync(file, `${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}\n`);
    } catch { /* logging must never break the app */ }
  };
}
