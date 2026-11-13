import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";
import { App } from "./App";
import "./styles.css";

// Thin, SF Symbols-like strokes everywhere (icons that pass their own strokeWidth keep it).
createRoot(document.getElementById("root")!).render(<LucideProvider strokeWidth={1.6}><App /></LucideProvider>);
