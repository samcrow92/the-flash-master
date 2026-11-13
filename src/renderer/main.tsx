import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThreadWindow, threadRoute } from "./views/ThreadWindow";
import "./styles.css";

const thread = threadRoute(location.hash);
createRoot(document.getElementById("root")!).render(thread ? <ThreadWindow chatId={thread.chatId} rootId={thread.rootId} /> : <App />);
