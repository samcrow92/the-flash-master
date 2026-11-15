import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { SearchHit } from "@shared/types";
import { ago, api, roleOf, useStore } from "../store";
import { UserAvatar } from "./UserAvatar";
import { Archive, MessageCircle, RoleIcon, Search } from "./icons";

/** FTS5 / LIKE snippets mark matches with \u0002…\u0003: draw those parts highlighted. */
export function highlight(snippet: string): ReactNode[] {
  const out: ReactNode[] = [];
  let k = 0;
  for (const part of snippet.split("\u0002")) {
    const end = part.indexOf("\u0003");
    if (end < 0) { if (part) out.push(part); continue; }
    out.push(<mark key={k++}>{part.slice(0, end)}</mark>);
    if (end + 1 < part.length) out.push(part.slice(end + 1));
  }
  return out;
}

/** Search across all chats (Ctrl/Cmd+Shift+F): type, pick with ↑↓ / Enter or click, and the chat opens at that message. */
export function SearchDialog() {
  const open = useStore((s) => s.searchOpen);
  if (!open) return null;
  return <SearchBox />;
}

function SearchBox() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ searchOpen: false });

  useEffect(() => {
    if (!q.trim()) { setHits(null); return; }
    let live = true;
    const t = setTimeout(() => {
      void api().searchMessages(q, 60).then((h) => { if (live) { setHits(h); setSel(0); } }).catch(() => { if (live) setHits([]); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  useEffect(() => { list.current?.querySelector(".sr-item.sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const go = (h: SearchHit | undefined) => { if (h) void useStore.getState().jumpTo(h); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, (hits?.length ?? 1) - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(hits?.[sel]); }
  };

  return (
    <div className="modal-back search-back" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="search-box" role="dialog" aria-label="Search chats">
        <label className="sr-input">
          <Search size={17} />
          <input autoFocus value={q} placeholder="Search all chats…" onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} spellCheck={false} />
          <kbd>Esc</kbd>
        </label>
        <div className="sr-list" ref={list}>
          {hits === null ? <div className="sr-empty">Find any message — yours or an agent's — across every chat and thread.</div>
            : hits.length === 0 ? <div className="sr-empty">No messages match “{q.trim()}”.</div>
            : hits.map((h, i) => <Hit key={h.messageId} h={h} sel={i === sel} onPick={() => go(h)} onHover={() => setSel(i)} />)}
        </div>
      </div>
    </div>
  );
}

function Hit({ h, sel, onPick, onHover }: { h: SearchHit; sel: boolean; onPick: () => void; onHover: () => void }) {
  const project = useStore((s) => (h.projectId ? s.projects.find((p) => p.id === h.projectId)?.name : null));
  const master = useStore((s) => s.masterChatId === h.chatId);
  const who = h.author === "user" ? <UserAvatar size={22} /> : <RoleIcon role={h.role} emoji={roleOf(h.role)?.icon} size={22} />;
  return (
    <button className={`sr-item ${sel ? "sel" : ""}`} onClick={onPick} onMouseMove={onHover}>
      <span className="sr-who">{who}</span>
      <span className="sr-main">
        <span className="sr-meta">
          <span className="sr-chat">{master ? "Master chat" : h.chatTitle}</span>
          {project && <span className="muted">· {project}</span>}
          {h.parentId && <span className="sr-tag"><MessageCircle size={11} /> thread</span>}
          {h.archived && <span className="sr-tag"><Archive size={11} /> archived</span>}
          <span className="sr-when muted">{ago(h.createdAt)} ago</span>
        </span>
        <span className="sr-snip">{highlight(h.snippet)}</span>
      </span>
    </button>
  );
}
