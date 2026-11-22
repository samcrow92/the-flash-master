import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  A2UI_BASIC_CATALOG, a2uiDoc, actionEvent, actionMessage, bindingPath, childList, failedChecks, resolveBool, resolveString, resolveValue, setPointer,
  type A2uiComponent, type A2uiScope, type A2uiSurface,
} from "@shared/a2ui";
import { Markdown } from "./Markdown";
import { useKeptState } from "./virtual";
import * as L from "./icons";

/**
 * A2UI v1.0 surfaces rendered with the app's own components and theme (glass cards, CSS variables, light and dark),
 * following the spec's "native rendering" model instead of shipping the reference web-component renderer.
 * Inputs bind two ways to the surface's data model; a button's event goes back to the agent as a chat message.
 * When a block can't be read as A2UI, its source shows as a code block (plain-text fallback).
 */
export function A2uiBlock({ source, open, id, chatId, threadId }: { source: string; open: boolean; id: string; chatId?: string; threadId?: string | null }) {
  const doc = useMemo(() => a2uiDoc(source), [source]);
  if (!doc.surfaces.length) {
    if (open || doc.incomplete) return <div className="a2ui-building shimmer">Building the view…</div>;
    return <div className="a2ui-fallback"><Markdown text={"```json\n" + source + "\n```"} />
      <div className="muted small">{doc.errors[0] ? `Couldn't show this as UI: ${doc.errors[0]}` : "Couldn't show this as UI."}</div></div>;
  }
  return <>{doc.surfaces.map((s) => <Surface key={s.id} s={s} streaming={open || doc.incomplete} id={`${id}:${s.id}`} chatId={chatId} threadId={threadId ?? null} />)}</>;
}

interface Ctx {
  s: A2uiSurface;
  data: Record<string, unknown>;
  setData: (path: string, value: unknown) => void;
  streaming: boolean;
  id: string;
  act: (componentId: string, scope: A2uiScope, action: unknown) => void;
  sent: Record<string, boolean>;
}

function Surface({ s, streaming, id, chatId, threadId }: { s: A2uiSurface; streaming: boolean; id: string; chatId?: string; threadId: string | null }) {
  // The user's edits survive scrolling the message out of view and back; a new data model from the agent resets them.
  const seed = useMemo(() => JSON.stringify(s.data), [s.data]);
  const [kept, setKept] = useKeptState<{ seed: string; data: Record<string, unknown> } | null>(`a2ui:${id}`, null);
  const data = kept && kept.seed === seed ? kept.data : s.data;
  const [sent, setSent] = useKeptState<Record<string, boolean>>(`a2ui-sent:${id}`, {});
  const setData = (path: string, value: unknown) => setKept({ seed, data: setPointer(data, path, value) as Record<string, unknown> });
  const act = (componentId: string, scope: A2uiScope, action: unknown) => {
    const fc = action && typeof action === "object" ? (action as any).functionCall : null;
    if (fc && fc["@call"] === "openUrl") {
      const url = resolveString(fc.args?.url, scope);
      if (url) void import("../store").then(({ api }) => api().openLink(url, chatId ?? null));
      return;
    }
    const ev = actionEvent(action, scope);
    if (!ev || !chatId) return;
    const content = actionMessage(s.id, componentId, ev, s.sendDataModel ? data : undefined);
    const k = `${componentId}@${scope.base}`;
    setSent((p) => ({ ...p, [k]: true }));
    void import("../store").then(({ api, useStore }) => api().sendMessage({ chatId, content, parentId: threadId }).catch((e) => {
      setSent((p) => ({ ...p, [k]: false }));
      useStore.getState().toast("warn", String(e?.message ?? e));
    }));
  };
  const ctx: Ctx = { s, data, setData, streaming, id, act, sent };
  const foreign = s.catalogId !== A2UI_BASIC_CATALOG && !/basic/i.test(s.catalogId);
  return (
    <div className="a2ui-surface" data-surface={s.id}>
      <Node ctx={ctx} cid="root" scope={{ data, base: "" }} depth={0} />
      {foreign && <div className="muted small a2ui-note">Rendered with the basic catalog (asked for {s.catalogId}).</div>}
    </div>
  );
}

const JUSTIFY: Record<string, string> = { start: "flex-start", end: "flex-end", center: "center", spaceBetween: "space-between", spaceAround: "space-around", spaceEvenly: "space-evenly", stretch: "stretch" };
const ALIGN: Record<string, string> = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch" };

function Node({ ctx, cid, scope, depth }: { ctx: Ctx; cid: string; scope: A2uiScope; depth: number }): ReactNode {
  const c = ctx.s.components[cid];
  if (!c) return ctx.streaming ? <span className="a2ui-pending shimmer" /> : null;
  if (depth > 40) return null;
  const scoped = { ...scope, data: ctx.data };
  const style = typeof c.weight === "number" ? { flex: `${c.weight} 1 0`, minWidth: 0 } : undefined;
  const a11y = c["@accessibility"] as { label?: unknown; hidden?: unknown } | undefined;
  if (a11y?.hidden && resolveBool(a11y.hidden, scoped)) return null;
  const label = a11y?.label ? resolveString(a11y.label, scoped) : undefined;
  return <div className={`a2ui-node a2ui-${c.component}`} style={style} aria-label={label}>{renderComponent(ctx, c, scoped, depth)}</div>;
}

function kids(ctx: Ctx, c: A2uiComponent, scope: A2uiScope, depth: number): ReactNode[] {
  return childList(c.children, scope).map((ch) => <Node key={ch.key} ctx={ctx} cid={ch.id} scope={ch.scope} depth={depth + 1} />);
}

function renderComponent(ctx: Ctx, c: A2uiComponent, scope: A2uiScope, depth: number): ReactNode {
  const str = (k: string) => resolveString(c[k], scope);
  const child = (k: string) => typeof c[k] === "string" ? <Node ctx={ctx} cid={c[k] as string} scope={scope} depth={depth + 1} /> : null;
  switch (c.component) {
    case "Text": return <div className={`a2ui-text ${c.variant === "caption" ? "caption" : ""} ${c.weight === "bold" ? "bold" : ""}`}><Markdown text={str("text")} /></div>;
    case "Row": case "Column": case "List": {
      const horizontal = c.component === "Row" || (c.component === "List" && c.direction === "horizontal");
      return <div className={`a2ui-flex ${horizontal ? "row" : "col"} ${c.component === "List" ? "list" : ""}`}
        style={{ justifyContent: JUSTIFY[String(c.justify ?? "start")], alignItems: ALIGN[String(c.align ?? (horizontal ? "center" : "stretch"))] }}>{kids(ctx, c, scope, depth)}</div>;
    }
    case "Card": return <div className="a2ui-card">{child("child")}</div>;
    case "Divider": return <hr className={`a2ui-divider ${c.axis === "vertical" ? "vertical" : ""}`} />;
    case "Icon": return <A2Icon name={resolveValue(c.name, scope)} />;
    case "Image": {
      const url = str("url"), alt = str("description");
      return url ? <div className={`a2ui-image ${String(c.variant ?? "")}`}><Markdown text={`![${alt.replace(/[[\]]/g, "")}](${url})`} /></div> : null;
    }
    case "Video": case "AudioPlayer": {
      const url = str("url"), d = str("description") || (c.component === "Video" ? "Video" : "Audio");
      return url ? <div className="a2ui-media"><L.CirclePlay size={15} /><Markdown text={`[${d.replace(/[[\]]/g, "")}](${url})`} /></div> : null;
    }
    case "Tabs": return <A2Tabs ctx={ctx} c={c} scope={scope} depth={depth} />;
    case "Modal": return <A2Modal ctx={ctx} c={c} scope={scope} depth={depth} />;
    case "Button": return <A2Button ctx={ctx} c={c} scope={scope} depth={depth} />;
    case "TextField": return <A2TextField ctx={ctx} c={c} scope={scope} />;
    case "CheckBox": {
      const path = bindingPath(c.value, scope);
      return <label className="a2ui-check"><input type="checkbox" checked={resolveBool(c.value, scope)} disabled={!path}
        onChange={(e) => path && ctx.setData(path, e.target.checked)} /><span>{str("label")}</span></label>;
    }
    case "ChoicePicker": return <A2Choice ctx={ctx} c={c} scope={scope} />;
    case "Slider": {
      const path = bindingPath(c.value, scope);
      const min = Number(c.min ?? 0), max = Number(c.max ?? 100);
      const v = Number(resolveValue(c.value, scope) ?? min);
      const step = typeof c.steps === "number" && c.steps > 0 ? (max - min) / c.steps : "any";
      return <label className="a2ui-field"><span className="a2ui-label">{str("label")} <b>{Number.isFinite(v) ? v : ""}</b></span>
        <input type="range" min={min} max={max} step={step} value={Number.isFinite(v) ? v : min} disabled={!path} onChange={(e) => path && ctx.setData(path, Number(e.target.value))} /></label>;
    }
    case "DateTimeInput": {
      const path = bindingPath(c.value, scope);
      const type = c.enableDate && c.enableTime ? "datetime-local" : c.enableTime ? "time" : "date";
      return <label className="a2ui-field">{str("label") && <span className="a2ui-label">{str("label")}</span>}
        <input type={type} value={str("value")} disabled={!path} onChange={(e) => path && ctx.setData(path, e.target.value)} /></label>;
    }
    default: return <span className="a2ui-unsupported" title="This component isn't in the basic catalog">{c.component}</span>;
  }
}

function A2Button({ ctx, c, scope, depth }: { ctx: Ctx; c: A2uiComponent; scope: A2uiScope; depth: number }) {
  const errors = failedChecks(c, scope);
  const key = `${c.id}@${scope.base}`;
  const done = !!ctx.sent[key];
  const variant = String(c.variant ?? "default");
  return (
    <button type="button" className={`a2ui-button ${variant} ${done ? "done" : ""}`} disabled={errors.length > 0 || ctx.streaming}
      title={errors[0] ?? (done ? "Sent to the agent" : undefined)} onClick={() => ctx.act(c.id, scope, c.action)}>
      {done && <L.Check size={13} />}{typeof c.child === "string" ? <Node ctx={ctx} cid={c.child} scope={scope} depth={depth + 1} /> : "OK"}
    </button>
  );
}

function A2TextField({ ctx, c, scope }: { ctx: Ctx; c: A2uiComponent; scope: A2uiScope }) {
  const path = bindingPath(c.value, scope);
  const value = resolveString(c.value, scope);
  const [touched, setTouched] = useState(false);
  const errors = touched ? failedChecks(c, scope) : [];
  const v = String(c.variant ?? "shortText");
  const common = { value, placeholder: resolveString(c.placeholder, scope), disabled: !path, "aria-invalid": errors.length > 0 || undefined,
    onBlur: () => setTouched(true) };
  const set = (x: string) => path && ctx.setData(path, v === "number" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : x);
  return (
    <label className="a2ui-field">
      {resolveString(c.label, scope) && <span className="a2ui-label">{resolveString(c.label, scope)}</span>}
      {v === "longText" ? <textarea rows={3} {...common} onChange={(e) => set(e.target.value)} />
        : <input type={v === "obscured" ? "password" : v === "number" ? "number" : "text"} {...common} onChange={(e) => set(e.target.value)} />}
      {errors.map((e) => <span key={e} className="a2ui-error">{e}</span>)}
    </label>
  );
}

function A2Choice({ ctx, c, scope }: { ctx: Ctx; c: A2uiComponent; scope: A2uiScope }) {
  const path = bindingPath(c.value, scope);
  const raw = resolveValue(c.value, scope);
  const selected = Array.isArray(raw) ? raw.map(String) : raw == null || raw === "" ? [] : [String(raw)];
  const multi = c.variant === "multipleSelection";
  const opts = Array.isArray(c.options) ? (c.options as { label: unknown; value: string }[]) : [];
  const toggle = (val: string) => {
    if (!path) return;
    ctx.setData(path, multi ? (selected.includes(val) ? selected.filter((x) => x !== val) : [...selected, val]) : [val]);
  };
  const chips = c.displayStyle !== "checkbox";
  return (
    <div className="a2ui-field" role="group" aria-label={resolveString(c.label, scope)}>
      {resolveString(c.label, scope) && <span className="a2ui-label">{resolveString(c.label, scope)}</span>}
      <div className={chips ? "a2ui-chips" : "a2ui-flex col"}>
        {opts.map((o) => {
          const on = selected.includes(String(o.value));
          return chips
            ? <button key={o.value} type="button" className={`a2ui-chip ${on ? "on" : ""}`} aria-pressed={on} disabled={!path} onClick={() => toggle(String(o.value))}>
              {on && <L.Check size={12} />}{resolveString(o.label, scope)}</button>
            : <label key={o.value} className="a2ui-check"><input type={multi ? "checkbox" : "radio"} checked={on} disabled={!path} onChange={() => toggle(String(o.value))} />
              <span>{resolveString(o.label, scope)}</span></label>;
        })}
      </div>
    </div>
  );
}

function A2Tabs({ ctx, c, scope, depth }: { ctx: Ctx; c: A2uiComponent; scope: A2uiScope; depth: number }) {
  const tabs = Array.isArray(c.tabs) ? (c.tabs as { title: unknown; child: string }[]) : [];
  const [at, setAt] = useKeptState(`a2ui-tab:${ctx.id}:${c.id}@${scope.base}`, 0);
  const cur = tabs[Math.min(at, tabs.length - 1)];
  return (
    <div className="a2ui-tabs">
      <div className="a2ui-tabbar" role="tablist">
        {tabs.map((t, i) => <button key={i} type="button" role="tab" aria-selected={i === at} className={i === at ? "on" : ""} onClick={() => setAt(i)}>{resolveString(t.title, scope)}</button>)}
      </div>
      {cur && <div role="tabpanel"><Node ctx={ctx} cid={cur.child} scope={scope} depth={depth + 1} /></div>}
    </div>
  );
}

function A2Modal({ ctx, c, scope, depth }: { ctx: Ctx; c: A2uiComponent; scope: A2uiScope; depth: number }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  return <>
    <div className="a2ui-modal-trigger" onClickCapture={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(true); }}>
      {typeof c.trigger === "string" && <Node ctx={ctx} cid={c.trigger} scope={scope} depth={depth + 1} />}
    </div>
    {open && <div className="a2ui-modal-backdrop" onClick={() => setOpen(false)}>
      <div className="a2ui-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="a2ui-modal-close" aria-label="Close" onClick={() => setOpen(false)}><L.X size={14} /></button>
        {typeof c.content === "string" && <Node ctx={ctx} cid={c.content} scope={scope} depth={depth + 1} />}
      </div>
    </div>}
  </>;
}

/** The basic catalog's icon names, drawn with the app's Lucide line icons. */
const ICONS: Record<string, L.LucideIcon> = {
  accountCircle: L.CircleUser, add: L.Plus, arrowBack: L.ArrowLeft, arrowForward: L.ArrowRight, attachFile: L.Paperclip, calendarToday: L.Calendar,
  call: L.Phone, camera: L.Camera, check: L.Check, close: L.X, delete: L.Trash2, download: L.Download, edit: L.Pencil, event: L.CalendarDays,
  error: L.CircleX, fastForward: L.FastForward, favorite: L.Heart, favoriteOff: L.HeartOff, folder: L.Folder, help: L.CircleHelp, home: L.House,
  info: L.Info, locationOn: L.MapPin, lock: L.Lock, lockOpen: L.LockOpen, mail: L.Mail, menu: L.Menu, moreVert: L.EllipsisVertical, moreHoriz: L.Ellipsis,
  notificationsOff: L.BellOff, notifications: L.Bell, pause: L.Pause, payment: L.CreditCard, person: L.User, phone: L.Smartphone, photo: L.Image,
  play: L.Play, print: L.Printer, refresh: L.RefreshCw, rewind: L.Rewind, search: L.Search, send: L.Send, settings: L.Settings, share: L.Share2,
  shoppingCart: L.ShoppingCart, skipNext: L.SkipForward, skipPrevious: L.SkipBack, star: L.Star, starHalf: L.StarHalf, starOff: L.StarOff, stop: L.Square,
  upload: L.Upload, visibility: L.Eye, visibilityOff: L.EyeOff, volumeDown: L.Volume1, volumeMute: L.VolumeX, volumeOff: L.VolumeOff, volumeUp: L.Volume2,
  warning: L.TriangleAlert,
};

function A2Icon({ name }: { name: unknown }) {
  if (name && typeof name === "object" && typeof (name as any).svgPath === "string") {
    return <svg className="a2ui-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={(name as any).svgPath} /></svg>;
  }
  const I = ICONS[String(name ?? "")] ?? L.Circle;
  return <I className="a2ui-icon" size={16} aria-hidden="true" />;
}
