import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../src/shared/types";
import { chatThreads, messageSide, previewText } from "../src/renderer/threadList";

let seq = 0;
const msg = (id: string, author: Message["author"], over: Partial<Message> = {}): Message => ({
  id, chatId: "c", parentId: null, author, agentId: null, role: author === "agent" ? "reviewer" : null, content: `${id} text`,
  status: "done", tokensIn: 0, tokensOut: 0, estimated: false, createdAt: 1000 + seq, seq: ++seq, attachments: [], steer: false,
  reactions: [], replyCount: 0, ...over,
});

describe("messenger layout", () => {
  it("puts your messages on the right and agent / system messages on the left", () => {
    expect(messageSide({ author: "user" })).toBe("right");
    expect(messageSide({ author: "agent" })).toBe("left");
    expect(messageSide({ author: "system" })).toBe("left");
  });

  it("mirrors the right side in CSS and tags every message (main list and threads) with its side", () => {
    const root = join(__dirname, "..");
    const css = readFileSync(join(root, "src/renderer/styles.css"), "utf8");
    expect(css).toMatch(/\.msg\.side-right > \.avatar \{[^}]*grid-column: 2/);
    expect(css).toMatch(/\.msg\.side-right > \.msg-body \{[^}]*align-items: flex-end/);
    // Thread columns use narrower avatars; their rules must still keep the avatar on the right.
    expect(css).toMatch(/\.thread-side \.msg\.side-right, \.threads-panel \.msg\.side-right \{ grid-template-columns: minmax\(0, 1fr\) 24px; \}/);
    const tsx = readFileSync(join(root, "src/renderer/views/ChatView.tsx"), "utf8");
    expect(tsx).toContain("side-${messageSide(m)}");
  });
});

describe("Threads panel", () => {
  it("lists messages with replies in chat order, with reply counts, latest activity and live replies", () => {
    const a = msg("a", "user", { replyCount: 2 });
    const b = msg("b", "agent");
    const c = msg("c", "agent", { replyCount: 1 });
    const r1 = msg("r1", "agent", { parentId: "a", createdAt: 5000 });
    const r2 = msg("r2", "user", { parentId: "a", createdAt: 6000, status: "streaming" });
    const list = chatThreads([a, b, c], { a: [a, r1, r2] });
    expect(list.map((t) => t.rootId)).toEqual(["a", "c"]);
    expect(list[0]).toMatchObject({ replyCount: 2, lastAt: 6000, working: true, preview: "a text" });
    expect(list[1]).toMatchObject({ replyCount: 1, lastAt: c.createdAt, working: false });
  });

  it("includes a thread opened without replies yet, and skips divider rows", () => {
    const a = msg("a", "agent");
    const d = msg("d", "system", { marker: "context-reset", replyCount: 3 });
    expect(chatThreads([a, d], {}, { a: true }).map((t) => t.rootId)).toEqual(["a"]);
    expect(chatThreads([a, d], {})).toEqual([]);
  });

  it("previews the first line without Markdown punctuation", () => {
    expect(previewText("## **Plan**: check [CAN](http://x) signals\nmore")).toBe("Plan: check CAN signals");
    expect(previewText("```ts\ncode\n```\n- first item")).toBe("first item");
    expect(previewText("x".repeat(200), 20)).toHaveLength(20);
  });

});
