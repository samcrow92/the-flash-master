import { ImageViewer } from "../components/ImageViewer";
import { HtmlViewer } from "../components/HtmlViewer";
import { useEffect, useState } from "react";
import { useStore } from "../store";
import { ChatView } from "./ChatView";
import { ContextMenuHost } from "../components/ContextMenu";
import { Zap } from "../components/icons";

export { chatRoute } from "../agentChat";

/** A popped-out chat: the same live chat view as the main window, for one chat, filling its own window. */
export function ChatWindow({ chatId }: { chatId: string }) {
  const { apply, toasts } = useStore();
  const [ready, setReady] = useState(false);
  const chat = useStore((s) => s.chatById[chatId]);
  const roleTitle = useStore((s) => s.roles.find((r) => r.name === chat?.agentRole)?.title);

  useEffect(() => {
    const off = window.flash.onEvent((e) => apply(e));
    void useStore.getState().init({ chatId })
      .catch((e) => useStore.getState().toast("error", String(e?.message ?? e)))
      .finally(() => setReady(true));
    return off;
  }, [chatId, apply]);
  useEffect(() => { document.title = chat ? `${chat.kind === "master" ? "TheFlashMaster" : roleTitle ?? chat.title} — ${chat.title}` : "Chat"; }, [chat, roleTitle]);

  if (!ready) return <div className="splash"><div className="logo-big"><Zap size={44} strokeWidth={1.6} /></div><div className="splash-bar"><i /></div></div>;
  return (
    <div className="chat-window">
      {chat ? <ChatView chatId={chatId} popout /> : <div className="splash muted">This chat no longer exists.</div>}
      <ContextMenuHost />
      <ImageViewer />
      <HtmlViewer />
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`toast toast-${t.level}`}>{t.text}</div>)}</div>
    </div>
  );
}
