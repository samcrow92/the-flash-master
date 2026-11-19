import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyToken, cutToken, findCommand, findMention, insertTrigger, maskCode, tokenAt } from "../src/shared/inline-commands";
import { parseMention, parseSlash } from "../src/main/context";

const at = (s: string) => { const i = s.indexOf("|"); return tokenAt(s.replace("|", ""), i); };

describe("composer picker: / and @ anywhere in the message", () => {
  it("opens at the start, after a space and at the start of a new line", () => {
    expect(at("/|")).toMatchObject({ kind: "/", query: "", start: 0 });
    expect(at("@rev|")).toMatchObject({ kind: "@", query: "rev", start: 0, end: 4 });
    expect(at("please ask @rev|")).toMatchObject({ kind: "@", query: "rev", start: 11 });
    expect(at("fix the parser /td|")).toMatchObject({ kind: "/", query: "td", start: 15 });
    expect(at("line one\n/he|")).toMatchObject({ kind: "/", query: "he", start: 9 });
    expect(at("(cc @rev|)")).toMatchObject({ kind: "@", query: "rev" });
  });

  it("stays closed in URLs, emails and paths", () => {
    expect(at("see https://example.com/|")).toBeNull();
    expect(at("see https:/|")).toBeNull();
    expect(at("mail me@corp|")).toBeNull();
    expect(at("open src/main|")).toBeNull();
    expect(at("open ./x|")).toBeNull();
    expect(at("C:\\Data\\x/|")).toBeNull();
    expect(at("run /usr/bin|")).toBeNull();
    expect(at("run /usr|/bin")).toBeNull();
  });

  it("covers the word after the caret too", () => {
    expect(at("hi @re|viewer there")).toMatchObject({ query: "re", start: 3, end: 12 });
  });

  it("replaces only the token and keeps the rest of the message", () => {
    const text = "please @re check this";
    const tok = tokenAt(text, 10)!;
    expect(applyToken(text, tok, "@reviewer ")).toEqual({ text: "please @reviewer check this", caret: 17 });
    const t2 = "write tests /td";
    expect(applyToken(t2, tokenAt(t2, t2.length)!, "/tdd ")).toEqual({ text: "write tests /tdd ", caret: 17 });
  });

  it("the @ and / buttons insert at the caret, with a space before mid-word", () => {
    expect(insertTrigger("", 0, 0, "/")).toEqual({ text: "/", caret: 1 });
    expect(insertTrigger("hello", 5, 5, "@")).toEqual({ text: "hello @", caret: 7 });
    expect(insertTrigger("hello world", 6, 6, "@")).toEqual({ text: "hello @world", caret: 7 });
    expect(insertTrigger("hello big world", 6, 9, "/")).toEqual({ text: "hello / world", caret: 7 });
  });
});

describe("sent messages: commands and mentions take effect wherever they appear", () => {
  const roles = ["reviewer", "tester"];
  const known = ["tdd", "stop", "help", "kb"];

  it("keeps the leading forms as before", () => {
    expect(parseMention("@reviewer check this", roles)).toEqual({ role: "reviewer", text: "check this" });
    expect(parseSlash("/tdd write tests", known)).toEqual({ command: "tdd", text: "write tests" });
    expect(parseSlash("/anything at all")).toEqual({ command: "anything", text: "at all" });
  });

  it("routes a mention later in the message and keeps the text", () => {
    expect(parseMention("thanks, @reviewer can you check?", roles)).toEqual({ role: "reviewer", text: "thanks, @reviewer can you check?" });
    expect(parseMention("over to you @tester.", roles).role).toBe("tester");
    expect(parseMention("line one\n@tester run it", roles).role).toBe("tester");
  });

  it("runs a known command later in the message and cuts it from the text", () => {
    expect(parseSlash("write tests for the parser /tdd", known)).toEqual({ command: "tdd", text: "write tests for the parser" });
    expect(parseSlash("please /tdd the parser", known)).toEqual({ command: "tdd", text: "please the parser" });
    expect(parseSlash("first line\n/kb flashing", known)).toEqual({ command: "kb", text: "first line\nflashing" });
  });

  it("ignores emails, URLs, paths, unknown words and code", () => {
    expect(parseMention("mail reviewer@corp.com", roles).role).toBeNull();
    expect(parseMention("ask @nobody", roles).role).toBeNull();
    expect(parseMention("use `@reviewer` literally", roles).role).toBeNull();
    expect(parseSlash("see https://x.com/help", known).command).toBeNull();
    expect(parseSlash("the file is at a/help", known).command).toBeNull();
    expect(parseSlash("look in /usr/stop/x", known).command).toBeNull();
    expect(parseSlash("the /docs page", known).command).toBeNull();
    expect(parseSlash("call it like `x /stop`", known).command).toBeNull();
    expect(parseSlash("```\n/stop\n```", known).command).toBeNull();
    expect(parseSlash("mid /tdd but no list").command).toBeNull();
  });

  it("helpers", () => {
    expect(maskCode("a `b` c")).toBe("a     c");
    expect(findMention("x (@reviewer)", (n) => n === "reviewer")).toEqual({ name: "reviewer", index: 3, length: 9 });
    expect(findCommand("go /stop now", (n) => n === "stop")).toEqual({ name: "stop", index: 3, length: 5 });
    expect(cutToken("a /x b", 2, 2)).toBe("a b");
  });

  it("the composer uses the shared token helpers, not start-only regexes", () => {
    const src = readFileSync("src/renderer/components/Composer.tsx", "utf8");
    expect(src).toContain("tokenAt(");
    expect(src).not.toMatch(/\/\^@|\/\^\\\//);
  });
});
