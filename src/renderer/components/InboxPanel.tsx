import { useEffect, useState } from "react";
import type { InboxItem } from "@shared/types";
import { CircleAlert, CircleHelp, GitMerge, Inbox, ListTree } from "./icons";
import { api, ago, useStore } from "../store";

const ICON = { ask: CircleHelp, plan: ListTree, checks: CircleAlert, merge: GitMerge } as const;
const RELOAD_ON = new Set(["message.created", "message.updated", "plan.updated", "agent.updated", "checks.updated"]);

/** Everything waiting on you across chats, most urgent first; click one to go to it. */
export function InboxPanel() {
  const st = useStore();
  const [items, setItems] = useState<InboxItem[]>([]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const load = () => void api().inbox().then(setItems).catch(() => undefined);
    load();
    const off = window.flash.onEvent((e) => { if (RELOAD_ON.has(e.type) && !t) t = setTimeout(() => { t = null; load(); }, 600); });
    return () => { off(); if (t) clearTimeout(t); };
  }, []);
  if (!items.length) return null;
  const go = (i: InboxItem) => {
    if ((i.kind === "merge" || i.kind === "checks") && i.agentId) { st.setView({ kind: "review", agentId: i.agentId }); return; }
    if (i.chatId) st.setView({ kind: "chat", chatId: i.chatId });
  };
  return (
    <section className="inbox">
      <div className="inbox-head"><Inbox size={15} /> <b>Waiting on you</b> <span className="muted small">{items.length}</span></div>
      {items.slice(0, 12).map((i) => {
        const I = ICON[i.kind];
        return (
          <button key={i.id} className={`inbox-item k-${i.kind}`} onClick={() => go(i)}>
            <I size={15} />
            <span className="inbox-title">{i.title}</span>
            <span className="muted small inbox-detail">{i.detail}</span>
            <span className="muted small">{ago(i.at)}</span>
          </button>
        );
      })}
    </section>
  );
}
