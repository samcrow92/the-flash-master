import { useEffect } from "react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./views/ChatView";
import { AgentsView } from "./views/AgentsView";
import { DashboardView } from "./views/DashboardView";
import { TasksView } from "./views/TasksView";
import { JazzView } from "./views/JazzView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const { ready, view, toasts, init, apply } = useStore();

  useEffect(() => {
    const off = window.flash.onEvent((e) => apply(e));
    void init().catch((e) => useStore.getState().toast("error", String(e?.message ?? e)));
    return off;
  }, [init, apply]);

  if (!ready) return <div className="splash"><div className="logo-big">⚡</div><div>TheFlashMaster</div></div>;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        {view.kind === "chat" && <ChatView key={view.chatId} chatId={view.chatId} />}
        {view.kind === "agents" && <AgentsView />}
        {view.kind === "dashboard" && <DashboardView />}
        {view.kind === "tasks" && <TasksView />}
        {view.kind === "jazz" && <JazzView />}
        {view.kind === "settings" && <SettingsView initialTab={view.tab} />}
      </main>
      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.level}`}>{t.text}</div>)}
      </div>
    </div>
  );
}
