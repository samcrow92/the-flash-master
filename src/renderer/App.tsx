import { useEffect, useState } from "react";
import { reportImports } from "./components/AgentImport";
import { api, applyWindow, useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/ChatView";
import { AgentsView } from "./views/AgentsView";
import { DashboardView } from "./views/DashboardView";
import { TasksView } from "./views/TasksView";
import { JazzView } from "./views/JazzView";
import { SettingsView } from "./views/SettingsView";
import { FlowPage } from "./views/FlowView";
import { MarketplaceView } from "./views/MarketplaceView";
import { DocsView } from "./views/DocsView";
import { ContextMenuHost } from "./components/ContextMenu";
import { TitleBar } from "./components/TitleBar";
import { Dots } from "./components/Dots";
import { Zap } from "./components/icons";

export function App() {
  const { ready, view, toasts, init, apply, toast } = useStore();
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const off = window.flash.onEvent((e) => apply(e));
    // Before init: the splash already needs the title bar (the window has no native frame).
    void api().windowState().then((w) => { useStore.setState({ window: w }); applyWindow(w); }).catch(() => undefined);
    void init().catch((e) => useStore.getState().toast("error", String(e?.message ?? e)));
    return off;
  }, [init, apply]);

  if (!ready) return (
    <div className="shell">
      <TitleBar />
      <div className="splash"><div className="logo-big"><Zap size={52} strokeWidth={1.5} /></div><div className="splash-title">TheFlashMaster</div><Dots pattern="auto" cycle size={8} /></div>
    </div>
  );

  return (
    <div className="shell">
    <TitleBar />
    <div className="app"
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === "file")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={async (e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith(".md"));
        setDragging(false);
        if (!files.length) return;
        e.preventDefault();
        reportImports(await Promise.all(files.map(async (f) => api().importAgentText(await f.text(), f.name))), toast);
      }}>
      {dragging && <div className="drop-hint">Drop agent .md files to import them</div>}
      <Sidebar />
      <main className="main" key={view.kind === "chat" ? "chat" : view.kind}>
        {view.kind === "chat" && <ChatView key={view.chatId} chatId={view.chatId} />}
        {view.kind === "agents" && <AgentsView />}
        {view.kind === "dashboard" && <DashboardView />}
        {view.kind === "tasks" && <TasksView />}
        {view.kind === "jazz" && <JazzView />}
        {view.kind === "settings" && <SettingsView initialTab={view.tab} />}
        {view.kind === "flow" && <FlowPage key={view.agentId} agentId={view.agentId} />}
        {view.kind === "marketplace" && <MarketplaceView />}
        {view.kind === "docs" && <DocsView initialPage={view.page} />}
      </main>
      <ContextMenuHost />
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.level}`}>{t.text}</div>)}
      </div>
    </div>
    </div>
  );
}
