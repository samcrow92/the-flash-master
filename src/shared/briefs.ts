/**
 * Where a text-mode DELEGATE brief ends. Shared by the app, which runs the brief (src/main/context.ts), and the chat,
 * which shows it as a card (src/shared/replyParts.ts), so both always agree on the same text.
 *
 * A brief starts after `DELEGATE <role>:` and may span paragraphs, lists and code blocks. It ends at:
 * - a line with only END (consumed), the clearest end, also before text for the user;
 * - the next DELEGATE, AGENT or TOOL line, or a <result> block;
 * - the end of the reply. A last paragraph of a single plain line there (after a blank line) is a note for the user
 *   ("Then I'll integrate."), not part of the brief.
 * Blank lines used to end a brief, which cut a coordinator's brief after its first list (Mari, 2026-11-19).
 */

const BLOCK_START = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:DELEGATE|AGENT|TOOL)(?:\*\*)?\s/;
const END_LINE = /^\s*(?:\*\*)?END(?:\*\*)?\s*$/;
const RESULT = /^\s*<\/?result>/;
const FENCE = /^\s*```/;
/** A line that reads as part of a brief's structure, not as a closing remark: a list, heading, label, quote, code, indent. */
const STRUCTURED = /^(?:\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|```|\|)|\s{2,}\S|\t|\s*[A-Z][\w /&()'"-]{0,40}:(?:\s|$))/;

/**
 * The brief whose first line is `lines[start]` (the DELEGATE line itself): its continuation lines, and the index of the
 * first line after it (past a closing END line).
 */
export function briefBody(lines: string[], start: number): { body: string[]; next: number } {
  let fence = false;
  let j = start + 1;
  for (; j < lines.length; j++) {
    const l = lines[j]!;
    if (FENCE.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    if (END_LINE.test(l)) return { body: span(lines, start + 1, j), next: j + 1 };
    if (BLOCK_START.test(l) || RESULT.test(l)) break;
  }
  let to = j;
  while (to > start + 1 && !lines[to - 1]!.trim()) to--;
  // At the end of the reply, a closing one-line remark after a blank line is for the user.
  const hasText = /:\s*\S/.test(lines[start]!) || lines.slice(start + 1, to - 2).some((l) => l.trim());
  if (j === lines.length && to - 2 > start && hasText && !lines[to - 2]!.trim() && !STRUCTURED.test(lines[to - 1]!)) {
    to -= 1;
    while (to > start + 1 && !lines[to - 1]!.trim()) to--;
  }
  return { body: span(lines, start + 1, to), next: to };
}

/** lines[from, to) without trailing blank lines, each without trailing spaces (callers trim the joined brief). */
function span(lines: string[], from: number, to: number): string[] {
  while (to > from && !lines[to - 1]!.trim()) to--;
  return lines.slice(from, to).map((l) => l.trimEnd());
}
