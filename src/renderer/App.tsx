import { ImageViewer } from "./components/ImageViewer";
import { HtmlViewer } from "./components/HtmlViewer";
import { useEffect, useReducer } from "react";
import { dragReducer, hasFiles, idle } from "./fileDrag";
import { reportImports } from "./components/AgentImport";
import { api, applyWindow, useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/ChatView";
import { AgentsView } from "./views/AgentsView";
import { ReviewView } from "./views/ReviewView";
import { DashboardView } from "./views/DashboardView";
import { TimelineView } from "./views/TimelineView";
import { EvalsView } from "./views/EvalsView";
import { TasksView } from "./views/TasksView";
import { MemoryView } from "./views/MemoryView";
import { JazzView } from "./views/JazzView";
import { SettingsView } from "./views/SettingsView";
import { FlowPage } from "./views/FlowView";
import { MarketplaceView } from "./views/MarketplaceView";
import { DocsView } from "./views/DocsView";
import { ContextMenuHost } from "./components/ContextMenu";
import { CommandPalette, useShortcuts } from "./components/CommandPalette";
import { SearchDialog } from "./components/SearchDialog";
import { TitleBar } from "./components/TitleBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { Dots } from "./components/Dots";
import { X, Zap } from "./components/icons";
import { ErrorBoundary } from "./components/ErrorBoundary";

export function App() {
  const { ready, view, toasts, init, apply, toast, sidebarCollapsed } = useStore();
  const [drag, dispatch] = useReducer(dragReducer, idle);
  const dragging = drag.active;
  useShortcuts();

  // File-drag overlay: window-level tracking so a drag that leaves for (or ends in) another window never sticks.
  useEffect(() => {
    const end = () => dispatch({ type: "end" });
    const onEnter = (e: DragEvent) => dispatch({ type: "enter", files: hasFiles(e.dataTransfer), at: Date.now() });
    const onOver = (e: DragEvent) => dispatch({ type: "over", files: hasFiles(e.dataTransfer), at: Date.now() });
    const onLeave = (e: DragEvent) => dispatch({ type: "leave", outside: !e.relatedTarget });
    const onMove = (e: MouseEvent) => { if (e.buttons === 0) end(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(); };
    const timer = window.setInterval(() => dispatch({ type: "tick", at: Date.now() }), 250);
    const on: [string, EventListener][] = [
      ["dragenter", onEnter as EventListener], ["dragover", onOver as EventListener], ["dragleave", onLeave as EventListener],
      ["drop", end], ["dragend", end], ["blur", end], ["mousemove", onMove as EventListener], ["mousedown", end], ["keydown", onKey as EventListener],
    ];
    for (const [t, f] of on) window.addEventListener(t, f, true);
    return () => { window.clearInterval(timer); for (const [t, f] of on) window.removeEventListener(t, f, true); };
  }, []);

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
    <TitleBar terminal sidebar />
    <TerminalPanel />
    <div className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      onDragOver={(e) => { if (hasFiles(e.dataTransfer)) e.preventDefault(); }}
      onDrop={async (e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith(".md"));
        dispatch({ type: "end" });
        if (!files.length) return;
        e.preventDefault();
        reportImports(await Promise.all(files.map(async (f) => api().importAgentText(await f.text(), f.name))), toast);
      }}>
      {dragging && (
        <div className="drop-hint" onClick={() => dispatch({ type: "end" })}>
          <button className="drop-hint-close" title="Dismiss (Esc)" aria-label="Dismiss" onClick={() => dispatch({ type: "end" })}><X size={14} /></button>
          <div>Drop agent .md files to import them</div>
          <div className="drop-hint-sub">Esc to dismiss</div>
        </div>
      )}
      {!sidebarCollapsed && <Sidebar />}
      <main className="main" key={view.kind === "chat" ? "chat" : view.kind}>
        <ErrorBoundary name="this view" resetKey={JSON.stringify(view)}>
        {view.kind === "chat" && <ChatView key={view.chatId} chatId={view.chatId} />}
        {view.kind === "agents" && <AgentsView />}
        {view.kind === "review" && <ReviewView agentId={view.agentId} />}
        {view.kind === "dashboard" && <DashboardView />}
        {view.kind === "timeline" && <TimelineView key={view.traceId ?? ""} traceId={view.traceId} />}
        {view.kind === "evals" && <EvalsView />}
        {view.kind === "tasks" && <TasksView />}
        {view.kind === "memory" && <MemoryView />}
        {view.kind === "jazz" && <JazzView />}
        {view.kind === "settings" && <SettingsView initialTab={view.tab} />}
        {view.kind === "flow" && <FlowPage key={view.agentId} agentId={view.agentId} />}
        {view.kind === "marketplace" && <MarketplaceView />}
        {view.kind === "docs" && <DocsView initialPage={view.page} />}
        </ErrorBoundary>
      </main>
      <ContextMenuHost />
      <CommandPalette />
      <SearchDialog />
      <ImageViewer />
      <HtmlViewer />
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.level}`}>{t.text}</div>)}
      </div>
    </div>
    </div>
  );
}
