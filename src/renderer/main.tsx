import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ChatWindow, chatRoute } from "./views/ChatWindow";
import "./styles.css";
import { applyPanelSizes } from "./panelSize";

applyPanelSizes();

const chat = chatRoute(location.hash);
// Thin, SF Symbols-like strokes everywhere (icons that pass their own strokeWidth keep it).
createRoot(document.getElementById("root")!).render(
  <LucideProvider strokeWidth={1.6}>
    <ErrorBoundary name="TheFlashMaster" full>
      {chat ? <ChatWindow chatId={chat.chatId} /> : <App />}
    </ErrorBoundary>
  </LucideProvider>,
);
