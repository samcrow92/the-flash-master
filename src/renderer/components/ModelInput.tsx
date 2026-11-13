import { useEffect, useId } from "react";
import type { HarnessId } from "@shared/types";
import { api, useStore } from "../store";
import { RefreshCw } from "./icons";

/**
 * Model field with suggestions discovered from the harness (Copilot/OpenCode via ACP, Pi via RPC).
 * Free text stays allowed: harnesses accept ids that are not advertised.
 */
export function ModelInput({ harness, value, onChange, placeholder, className, disabled }: {
  harness: HarnessId | null; value: string; onChange: (v: string) => void; placeholder?: string; className?: string; disabled?: boolean;
}) {
  const listId = useId();
  const state = useStore((s) => (harness ? s.models[harness] : undefined));
  // Load the cached list (or discover it once) when a harness is selected.
  useEffect(() => { if (harness && !state) void api().listModels(harness, false).then((m) => useStore.getState().setModels(m)); }, [harness, state]);
  const current = state?.models.find((m) => m.current);
  const ph = placeholder ?? (current ? `default (${current.id})` : "default");
  return (
    <span className={`model-input-wrap ${className ?? ""}`}>
      <input key={`${harness}:${value}`} list={listId} defaultValue={value} placeholder={ph} disabled={disabled}
        title={state?.error ?? (state?.models.length ? `${state.models.length} models reported by ${harness}` : "Type a model id")}
        onBlur={(e) => { if (e.target.value.trim() !== value) onChange(e.target.value.trim()); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <datalist id={listId}>
        {state?.models.map((m) => <option key={m.id} value={m.id}>{m.name !== m.id ? m.name : ""}{m.current ? " • default" : ""}</option>)}
      </datalist>
      {harness && (
        <button type="button" className={`icon-btn refresh ${state?.loading ? "spinning" : ""}`} disabled={disabled || state?.loading}
          title={state?.loading ? "Asking the harness for its models…" : `Refresh models from ${harness}`}
          onClick={() => void api().listModels(harness, true).then((m) => useStore.getState().setModels(m))}><RefreshCw size={13} /></button>
      )}
    </span>
  );
}
