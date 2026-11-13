import { useEffect, useState } from "react";
import { useStore } from "../store";
import { ThreadPanel } from "./ChatView";
import { ContextMenuHost } from "../components/ContextMenu";
import { Zap } from "../components/icons";

/** Parses `#thread/<chatId>/<rootId>`: the main process opens a thread window on that hash. */
export function threadRoute(hash: string): { chatId: string; rootId: string } | null {
  const m = /^#thread\/([^/]+)\/([^/]+)$/.exec(hash);
  return m ? { chatId: decodeURIComponent(m[1]!), rootId: decodeURIComponent(m[2]!) } : null;
}

/** A popped-out thread: the same live thread column as the side panel, filling its own window. */
export function ThreadWindow({ chatId, rootId }: { chatId: string; rootId: string }) {
  const { apply, toasts } = useStore();
  const [ready, setReady] = useState(false);
  const title = useStore((s) => s.chatById[chatId]?.title);

  useEffect(() => {
    const off = window.flash.onEvent((e) => apply(e));
    const st = useStore.getState();
    // init() loads roles, settings, theme and chats (and opens the chat, which also loads its messages).
    void st.init()
      .then(() => { useStore.setState({ sideThread: { chatId, rootId } }); return useStore.getState().loadThread(chatId, rootId); })
      .catch((e) => useStore.getState().toast("error", String(e?.message ?? e)))
      .finally(() => setReady(true));
    return off;
  }, [chatId, rootId, apply]);
  useEffect(() => { document.title = title ? `Thread — ${title}` : "Thread"; }, [title]);

  if (!ready) return <div className="splash"><div className="logo-big"><Zap size={44} strokeWidth={1.6} /></div><div className="splash-bar"><i /></div></div>;
  return (
    <div className="thread-window">
      <ThreadPanel chatId={chatId} rootId={rootId} standalone />
      <ContextMenuHost />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast toast-${t.level}`}>{t.text}</div>)}</div>
    </div>
  );
}
