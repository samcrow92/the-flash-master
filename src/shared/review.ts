/** Line comments on an agent's changes (the Review page), turned into one request the agent can act on. */

export interface ReviewComment {
  path: string;
  /** Line number in the agent's version ("new") or, for a removed line, in the original ("old"). */
  line: number;
  side: "new" | "old";
  /** The line's code, so the agent finds the spot even if line numbers moved. */
  code: string;
  text: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The message sent to the agent: every comment with file, line and code, then the general note. Pure, so it is unit-tested. */
export function buildFixRequest(branch: string, comments: ReviewComment[], note = ""): string {
  const list = comments.filter((c) => c.text.trim());
  const general = note.trim();
  if (!list.length && !general) throw new Error("add a comment first");
  const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const items = sorted.map((c, i) => {
    const where = `\`${c.path}\` ${c.side === "old" ? "removed line" : "line"} ${c.line}`;
    const code = c.code.trim() ? ` (\`${clip(c.code.trim().replace(/`/g, "'"), 120)}\`)` : "";
    return `${i + 1}. ${where}${code}: ${c.text.trim()}`;
  });
  return [
    `**Review of your changes on \`${branch}\`.** Please address ${list.length === 1 ? "this comment" : list.length ? `these ${list.length} comments` : "this"}, then commit on the same branch.`,
    items.join("\n"),
    general ? `${list.length ? "Also: " : ""}${general}` : "",
  ].filter(Boolean).join("\n\n");
}
