/**
 * Names for specialist instances. The coordinator can run several copies of one specialist at once (two Coders on two
 * tasks); each gets its own given name so they can be told apart, and the role title stays as the suffix
 * ("Nova · Coder") next to the role's icon so the kind of specialist is still obvious.
 */
export const INSTANCE_NAMES = [
  "Ada", "Nova", "Orion", "Iris", "Atlas", "Juno", "Felix", "Luna", "Milo", "Vera", "Otto", "Cleo", "Hugo", "Ruby", "Leo", "Maya",
  "Theo", "Zara", "Ezra", "Nina", "Kai", "Lena", "Oscar", "Sage", "Remy", "Tess", "Ivan", "Mira", "Noah", "Pia", "Axel", "Ines",
] as const;

/** The first name not already used in the chat; after the list runs out, names repeat with a number ("Ada 2"). */
export function pickInstanceName(taken: Iterable<string | null | undefined>): string {
  const used = new Set<string>();
  for (const t of taken) if (t) used.add(t);
  for (let round = 1; ; round++) {
    for (const n of INSTANCE_NAMES) {
      const name = round === 1 ? n : `${n} ${round}`;
      if (!used.has(name)) return name;
    }
  }
}

/** What the UI calls an agent: "Nova · Coder" for a named instance, else the role title. */
export function agentLabel(agent: { name?: string | null } | null | undefined, roleTitle: string): string {
  return agent?.name ? `${agent.name} · ${roleTitle}` : roleTitle;
}
