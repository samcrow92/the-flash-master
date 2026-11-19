import type { ModelInfo } from "./types";

/**
 * One entry per model id, first wins (a later duplicate only adds `current`). Harnesses can list the same id
 * more than once (e.g. Cursor's "auto" in several option groups); duplicates would also clash as React keys.
 */
export function uniqueModels(models: ModelInfo[]): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const m of models) {
    const seen = byId.get(m.id);
    if (!seen) byId.set(m.id, m);
    else if (m.current && !seen.current) byId.set(m.id, { ...seen, current: true });
  }
  return [...byId.values()];
}
