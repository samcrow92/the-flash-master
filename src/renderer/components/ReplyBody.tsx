import { useLayoutEffect, useRef, useState } from "react";
import type { ToolRun } from "@shared/types";
import { replySegments } from "@shared/replySegments";
import { Markdown } from "./Markdown";
import { ReplyText } from "./ReplyParts";
import { useKeptState } from "./virtual";
import { ToolRuns } from "./ToolRuns";
import { Brain, ChevronDown, ChevronUp } from "./icons";

/** An agent reply in the order it happened: paragraphs, the commands run between them, and the model's reasoning. */
export function ReplyBody({ content, tools, messageId, live, chatId, threadId }: { content: string; tools?: ToolRun[]; messageId?: string; live?: boolean; chatId?: string; threadId?: string | null }) {
  const segs = replySegments(content, tools);
  return (
    <div className="reply-body">
      {segs.map((s, i) => s.kind === "text" ? <ReplyText key={`t${i}`} id={`${messageId ?? "m"}:t${i}`} text={s.text} chatId={chatId} threadId={threadId} />
        : s.kind === "tools" ? <ToolRuns key={s.tools[0]!.id} tools={s.tools} messageId={messageId} live={live} />
        : <Thought key={s.run.id} run={s.run} />)}
    </div>
  );
}

/** Reasoning stays visible (muted, set off by a rule); long blocks are clipped until "Show all". */
function Thought({ run }: { run: ToolRun }) {
  const [all, setAll] = useKeptState(`thought-all:${run.id}`, false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const running = run.status === "pending" || run.status === "in_progress";
  useLayoutEffect(() => { const el = body.current; if (el) setLong(el.scrollHeight > el.clientHeight + 4); }, [run.output, all]);
  return (
    <div className={`thought ${running ? "running" : ""} ${all ? "all" : long ? "clip" : ""}`}>
      <div className="thought-head"><Brain size={13} /><span className={running ? "shimmer" : ""}>{running ? "Thinking…" : "Thought"}</span></div>
      <div className="thought-body" ref={body}><Markdown text={run.output ?? ""} /></div>
      {(long || all) && (
        <button className="link small thought-more" onClick={() => setAll((a) => !a)}>
          {all ? <><ChevronUp size={12} /> Show less</> : <><ChevronDown size={12} /> Show all</>}
        </button>
      )}
    </div>
  );
}
