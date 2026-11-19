/**
 * `/commands` and `@mentions` anywhere in a message, not only at its start.
 *
 * A trigger counts only at the start of the text or right after whitespace (or an opening bracket for @), so URLs
 * (`https://x/y`), emails (`me@corp.com`) and paths (`a/b`, `./x`) never open the picker or run a command.
 * Code spans and fenced blocks are ignored when a sent message is parsed. Pure, so the composer and the
 * orchestrator share it and tests can pin it down.
 */

/** Built-in chat commands handled by the orchestrator (skills add their own `/command`s). */
export const BUILTIN_COMMANDS: { c: string; d: string }[] = [
  { c: "superpowers", d: "toggle the superpowers workflow for this chat" },
  { c: "stop", d: "stop agents in this chat" },
  { c: "help", d: "list commands and specialists" },
  { c: "kb", d: "build or update this project's knowledge base (add words to focus it)" },
  { c: "kb-sync", d: "sync the knowledge base with .flashmaster/knowledge in the repo" },
];
/** Built-ins plus their long aliases (accepted when typed, not offered in the picker). */
export const BUILTIN_COMMAND_NAMES = [...BUILTIN_COMMANDS.map((x) => x.c), "knowledge", "knowledge-sync"];

export interface ComposerToken {
  /** "@" for a mention, "/" for a command. */
  kind: "@" | "/";
  /** What is typed after the trigger, up to the caret. */
  query: string;
  /** Range of the whole token (trigger + word, including any part after the caret). */
  start: number;
  end: number;
}

/** The `@word` or `/word` the caret is in, if it starts at the beginning of the text or after whitespace. */
export function tokenAt(text: string, caret: number): ComposerToken | null {
  const at = Math.max(0, Math.min(caret, text.length));
  const m = /(^|[\s(])([@/])([\w-]*)$/.exec(text.slice(0, at));
  if (!m) return null;
  const kind = m[2] as "@" | "/";
  if (kind === "/" && m[1] === "(") return null;
  const start = at - m[2]!.length - m[3]!.length;
  const tail = /^[\w-]*/.exec(text.slice(at))![0];
  // "/foo/bar" or "@a@b" mid-word: not a command or a mention.
  const next = text[at + tail.length];
  if (next === "/" || next === "@") return null;
  return { kind, query: m[3]!, start, end: at + tail.length };
}

/** Replace the token with the picked suggestion (e.g. "@reviewer "); returns the new text and caret. */
export function applyToken(text: string, tok: ComposerToken, insert: string): { text: string; caret: number } {
  const after = text.slice(tok.end);
  // Don't double the space when one already follows the token: step the caret over it instead.
  const reuse = insert.endsWith(" ") && /^\s/.test(after);
  const ins = reuse ? insert.slice(0, -1) : insert;
  return { text: text.slice(0, tok.start) + ins + after, caret: tok.start + insert.length };
}

/** The @ and / buttons: put the trigger at the caret (with a space before it mid-word), replacing any selection. */
export function insertTrigger(text: string, selStart: number, selEnd: number, ch: "@" | "/"): { text: string; caret: number } {
  const a = Math.max(0, Math.min(selStart, text.length));
  const b = Math.max(a, Math.min(selEnd, text.length));
  const before = text.slice(0, a);
  const pad = before && !/\s$/.test(before) ? " " : "";
  const out = `${before}${pad}${ch}${text.slice(b)}`;
  return { text: out, caret: a + pad.length + 1 };
}

/** Blank out `code spans` and ``` fenced blocks (same length) so their contents never count as commands or mentions. */
export function maskCode(s: string): string {
  return s.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The first `@name` (at the start or after whitespace / an opening bracket) for which `ok` holds. */
export function findMention(input: string, ok: (name: string) => boolean): { name: string; index: number; length: number } | null {
  const re = /(^|[\s(])@([a-z][\w-]*)(?=$|[\s,.;:!?)])/gi;
  const masked = maskCode(input);
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const name = m[2]!.toLowerCase();
    if (ok(name)) return { name, index: m.index + m[1]!.length, length: m[2]!.length + 1 };
  }
  return null;
}

/** The first `/command` (at the start or after whitespace, followed by whitespace or the end) for which `ok` holds. */
export function findCommand(input: string, ok: (name: string) => boolean): { name: string; index: number; length: number } | null {
  const re = /(^|\s)\/([a-z][\w-]*)(?=$|\s)/gi;
  const masked = maskCode(input);
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const name = m[2]!.toLowerCase();
    if (ok(name)) return { name, index: m.index + m[1]!.length, length: m[2]!.length + 1 };
  }
  return null;
}

/** Cut `length` chars at `index` and tidy the spaces around the gap (line breaks are kept). */
export function cutToken(input: string, index: number, length: number): string {
  const before = input.slice(0, index).replace(/[ \t]+$/, "");
  const after = input.slice(index + length).replace(/^[ \t]+/, "");
  const sep = before && after && !/\n$/.test(before) && !/^\n/.test(after) ? " " : "";
  return `${before}${sep}${after}`.trim();
}
