import type { RoleDef } from "@shared/types";

/**
 * Agents that have no hand-written documentation page: the user's own, Marketplace plugins', and those TheFlashMaster
 * created (saved or temporary). Pure, so the rule "every agent the app knows is listed" is unit-tested.
 * Matching is by name, so a user file that overrides a built-in stays on the built-in's page (marked customised).
 */
export function customAgents(roles: RoleDef[], documented: Iterable<string>): RoleDef[] {
  const docs = new Set(documented);
  return roles.filter((r) => !docs.has(r.name)).sort((a, b) => a.title.localeCompare(b.title));
}
