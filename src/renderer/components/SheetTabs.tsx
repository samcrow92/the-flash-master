import type { ReactNode } from "react";
import { useStore } from "../store";
import type { SheetTab } from "../layout";
import { Compass, MessagesSquare, Package, X } from "./icons";

/** Switch the chat's side sheet to a tab (or close it). Threads, Progress and Artifacts share the one floating sheet. */
export function showSheet(chatId: string, tab: SheetTab | null): void {
  const st = useStore.getState();
  if (tab === "threads") { st.setThreadsPanel(true, chatId); return; }
  if (tab === "progress") { st.openFlow(chatId, st.flowPanel?.chatId === chatId ? st.flowPanel.agentId : null); return; }
  if (tab === "artifacts") { useStore.setState({ artifactsPanel: chatId, flowPanel: null }); return; }
  // Closing: the Threads tab stays closed until you open it again (remembered), Progress / Artifacts just close.
  useStore.setState({ flowPanel: null, artifactsPanel: null });
  st.setThreadsPanel(false);
}

const TABS: { id: SheetTab; label: string; icon: typeof Compass; tip: string }[] = [
  { id: "threads", label: "Threads", icon: MessagesSquare, tip: "Every thread in this chat" },
  { id: "progress", label: "Progress", icon: Compass, tip: "Flow chart of where the agents are in their task" },
  { id: "artifacts", label: "Artifacts", icon: Package, tip: "Files changed, saved artifacts and code from this chat" },
];

/** The tab strip at the top of the side sheet, with the sheet's close button at the far end. */
export function SheetTabs({ chatId, current, children }: { chatId: string; current: SheetTab; children?: ReactNode }) {
  return (
    <header className="sheet-head">
      <div className="sheet-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon, tip }) => (
          <button key={id} role="tab" aria-selected={current === id} className={current === id ? "on" : ""} title={tip}
            onClick={() => showSheet(chatId, id)}><Icon size={13} /> {label}</button>
        ))}
      </div>
      <span className="sheet-tools">
        {children}
        <button className="it-collapse" title="Close (Esc)" aria-label="Close side sheet" onClick={() => showSheet(chatId, null)}><X size={15} /></button>
      </span>
    </header>
  );
}
