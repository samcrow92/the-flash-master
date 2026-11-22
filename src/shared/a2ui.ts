/**
 * A2UI (Agent-to-User Interface, https://a2ui.org, Apache-2.0) for chat replies: the agent writes A2UI v1.0 messages in an
 * ```a2ui fenced block and the chat renders them as native components (src/renderer/components/A2ui.tsx).
 *
 * This file is the renderer-independent half: parsing the block (JSONL, a JSON array, pretty-printed objects, or the
 * spec's `{messages: [...]}` example shape; a block still streaming in parses up to its last complete message), applying
 * the four surface messages (createSurface, updateComponents, updateDataModel, deleteSurface), data binding with JSON
 * Pointers and the basic catalog's functions. UI is data, never code: nothing here evaluates agent-written script.
 */

export const A2UI_VERSION = "1.0";
export const A2UI_BASIC_CATALOG = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";

/** Components of the basic catalog that the chat renders. Anything else shows as a small "unsupported" chip. */
export const A2UI_COMPONENTS = ["Text", "Image", "Icon", "Video", "AudioPlayer", "Row", "Column", "List", "Card", "Tabs", "Modal", "Divider",
  "Button", "TextField", "CheckBox", "ChoicePicker", "Slider", "DateTimeInput"] as const;

export interface A2uiComponent { id: string; component: string; [prop: string]: unknown }
export interface A2uiSurface {
  id: string;
  catalogId: string;
  components: Record<string, A2uiComponent>;
  data: Record<string, unknown>;
  sendDataModel: boolean;
}
export interface A2uiDoc {
  surfaces: A2uiSurface[];
  /** Problems worth showing (malformed JSON, unknown message types); the rest of the block still renders. */
  errors: string[];
  /** The block ends in the middle of a message (still streaming). */
  incomplete: boolean;
}

// ---------------------------------------------------------------- parsing

/** Top-level JSON values in `src`, in order. A trailing value that never closes is reported as incomplete. */
export function scanJsonValues(src: string): { values: unknown[]; errors: string[]; incomplete: boolean } {
  const values: unknown[] = [];
  const errors: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s|,/.test(src[i]!)) i++;
    if (i >= n) break;
    const open = src[i];
    if (open !== "{" && open !== "[") {
      // Stray text (a comment line, "json" left over from a fence): skip the line.
      const nl = src.indexOf("\n", i);
      errors.push(`Skipped text that is not JSON: ${src.slice(i, nl < 0 ? n : nl).trim().slice(0, 60)}`);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    let depth = 0, str = false, esc = false, end = -1;
    for (let j = i; j < n; j++) {
      const c = src[j]!;
      if (str) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") str = false; continue; }
      if (c === "\"") str = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    if (end < 0) return { values, errors, incomplete: true };
    const chunk = src.slice(i, end);
    try { values.push(JSON.parse(chunk)); } catch (e) { errors.push(`Invalid JSON: ${(e as Error).message}`); }
    i = end;
  }
  return { values, errors, incomplete: false };
}

const MESSAGE_KEYS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;
const IGNORED_KEYS = ["callRendererFunction", "agentFunctionResponse"];

/** The A2UI messages in a block, flattened from arrays and `{messages: [...]}` wrappers. */
export function parseA2uiMessages(src: string): { messages: Record<string, any>[]; errors: string[]; incomplete: boolean } {
  const { values, errors, incomplete } = scanJsonValues(src);
  const messages: Record<string, any>[] = [];
  const add = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, any>;
    if (Array.isArray(o.messages)) { o.messages.forEach(add); return; }
    if (MESSAGE_KEYS.some((k) => k in o)) messages.push(o);
    else if (!IGNORED_KEYS.some((k) => k in o)) errors.push(`Not an A2UI message: ${JSON.stringify(o).slice(0, 60)}`);
  };
  values.forEach(add);
  return { messages, errors, incomplete };
}

/** Apply a stream of messages in order. Surfaces keep the order they were created in. */
export function applyA2uiMessages(messages: Record<string, any>[]): { surfaces: A2uiSurface[]; errors: string[] } {
  const surfaces = new Map<string, A2uiSurface>();
  const errors: string[] = [];
  const surface = (id: unknown): A2uiSurface | null => {
    const sid = typeof id === "string" && id ? id : null;
    if (!sid) { errors.push("A message without surfaceId was ignored."); return null; }
    let s = surfaces.get(sid);
    // Lenient: an update for a surface that was never created creates it (the spec allows pre-existing surfaces).
    if (!s) { s = { id: sid, catalogId: A2UI_BASIC_CATALOG, components: {}, data: {}, sendDataModel: false }; surfaces.set(sid, s); }
    return s;
  };
  const putComponents = (s: A2uiSurface, list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (c && typeof c === "object" && typeof (c as A2uiComponent).id === "string" && typeof (c as A2uiComponent).component === "string") {
        s.components[(c as A2uiComponent).id] = c as A2uiComponent;
      } else errors.push(`A component without id or type was ignored: ${JSON.stringify(c).slice(0, 60)}`);
    }
  };
  for (const m of messages) {
    if (m.createSurface) {
      const c = m.createSurface;
      const s = surface(c.surfaceId);
      if (!s) continue;
      if (typeof c.catalogId === "string") s.catalogId = c.catalogId;
      s.sendDataModel = !!c.sendDataModel;
      // dataModel is applied before components, so components bind against it on first render.
      if (c.dataModel && typeof c.dataModel === "object") s.data = structuredClone(c.dataModel);
      putComponents(s, c.components);
    } else if (m.updateComponents) {
      const s = surface(m.updateComponents.surfaceId);
      if (s) putComponents(s, m.updateComponents.components);
    } else if (m.updateDataModel) {
      const u = m.updateDataModel;
      const s = surface(u.surfaceId);
      if (s) s.data = setPointer(s.data, typeof u.path === "string" ? u.path : "/", u.value) as Record<string, unknown>;
    } else if (m.deleteSurface) {
      surfaces.delete(m.deleteSurface.surfaceId);
    }
  }
  return { surfaces: [...surfaces.values()], errors };
}

/** Parse and apply one fenced block. */
export function a2uiDoc(src: string): A2uiDoc {
  const p = parseA2uiMessages(src);
  const a = applyA2uiMessages(p.messages);
  return { surfaces: a.surfaces, errors: [...p.errors, ...a.errors], incomplete: p.incomplete };
}

/** Does this JSON look like A2UI? Lets a ```json block that holds A2UI messages render too. */
export function looksLikeA2ui(src: string): boolean {
  return /"(?:createSurface|updateComponents)"\s*:/.test(src) && /"surfaceId"\s*:/.test(src);
}

// ---------------------------------------------------------------- JSON Pointer

const unescapePtr = (s: string) => s.replace(/~1/g, "/").replace(/~0/g, "~");
export function pointerParts(ptr: string): string[] {
  return ptr.split("/").filter((p, i) => i > 0 || p !== "").filter((p) => p !== "").map(unescapePtr);
}

/** Join a base scope (absolute pointer) with a path; paths that start with "/" are absolute. */
export function joinPointer(scope: string, path: string): string {
  if (path.startsWith("/")) return path;
  const base = scope.endsWith("/") ? scope.slice(0, -1) : scope;
  return path ? `${base}/${path}` : base || "/";
}

export function getPointer(data: unknown, ptr: string): unknown {
  let cur: any = data;
  for (const p of pointerParts(ptr)) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Immutable set; `null` deletes the key (A2UI updateDataModel semantics). */
export function setPointer(data: unknown, ptr: string, value: unknown): unknown {
  const parts = pointerParts(ptr);
  if (!parts.length) return value === null ? {} : value;
  const rec = (cur: any, i: number): any => {
    const key = parts[i]!;
    const arr = Array.isArray(cur);
    const copy: any = arr ? [...cur] : cur && typeof cur === "object" ? { ...cur } : /^\d+$/.test(key) ? [] : {};
    if (i === parts.length - 1) {
      if (value === null) { if (Array.isArray(copy)) copy.splice(Number(key), 1); else delete copy[key]; }
      else copy[key] = value;
    } else copy[key] = rec(copy[key], i + 1);
    return copy;
  };
  return rec(data, 0);
}

// ---------------------------------------------------------------- dynamic values and functions

export interface A2uiScope { data: unknown; base: string; index?: number }

const isBinding = (v: unknown): v is { "@path": string } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as any)["@path"] === "string";
const isCall = (v: unknown): v is { "@call": string; args?: Record<string, unknown> } => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as any)["@call"] === "string";

/** The absolute pointer a bound property reads and writes, or null for a literal. */
export function bindingPath(v: unknown, scope: A2uiScope): string | null {
  return isBinding(v) ? joinPointer(scope.base, v["@path"]) : null;
}

/** Resolve a Dynamic* value: a literal, `{"@path"}` (relative paths resolve inside list templates) or `{"@call"}`. */
export function resolveValue(v: unknown, scope: A2uiScope): unknown {
  if (isBinding(v)) return getPointer(scope.data, joinPointer(scope.base, v["@path"]));
  if (isCall(v)) return callFunction(v["@call"], v.args ?? {}, scope);
  return v;
}

export function resolveString(v: unknown, scope: A2uiScope): string {
  const r = resolveValue(v, scope);
  if (r == null) return "";
  if (typeof r === "object") return JSON.stringify(r);
  return String(r);
}

/** DynamicBoolean coercion: a validation result counts as its `valid` flag. */
export function resolveBool(v: unknown, scope: A2uiScope): boolean {
  const r = resolveValue(v, scope);
  if (r && typeof r === "object" && "valid" in (r as object)) return !!(r as { valid: unknown }).valid;
  if (typeof r === "string") return r !== "" && r !== "false";
  return !!r;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const valid = (ok: boolean) => ({ valid: ok });

/** Basic catalog functions. openUrl is handled by the renderer (it needs a user gesture), so here it returns nothing. */
export function callFunction(name: string, rawArgs: Record<string, unknown>, scope: A2uiScope): unknown {
  const arg = (k: string) => resolveValue(rawArgs[k], scope);
  switch (name) {
    case "@index": return scope.index ?? null;
    case "required": { const v = arg("value"); return valid(!(v == null || v === "" || (Array.isArray(v) && !v.length))); }
    case "regex": {
      const p = String(rawArgs.pattern ?? "");
      if (p.length > 256) return valid(false);
      try { return valid(new RegExp(p, "u").test(String(arg("value") ?? ""))); } catch { return valid(false); }
    }
    case "length": {
      const len = [...String(arg("value") ?? "")].length;
      const min = rawArgs.min == null ? 0 : num(rawArgs.min), max = rawArgs.max == null ? Infinity : num(rawArgs.max);
      return valid(len >= min && len <= max);
    }
    case "numeric": {
      const v = num(arg("value"));
      const min = rawArgs.min == null ? -Infinity : num(rawArgs.min), max = rawArgs.max == null ? Infinity : num(rawArgs.max);
      return valid(Number.isFinite(v) && v >= min && v <= max);
    }
    case "email": return valid(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(arg("value") ?? "")));
    case "and": return Array.isArray(rawArgs.values) && rawArgs.values.every((x) => resolveBool(x, scope));
    case "or": return Array.isArray(rawArgs.values) && rawArgs.values.some((x) => resolveBool(x, scope));
    case "not": return !resolveBool(rawArgs.value, scope);
    case "formatString": return formatTemplate(String(arg("value") ?? ""), scope);
    case "formatNumber": {
      const v = num(arg("value"));
      if (!Number.isFinite(v)) return "";
      const d = rawArgs.decimals == null ? undefined : num(arg("decimals"));
      const grouping = rawArgs.grouping == null ? true : resolveBool(rawArgs.grouping, scope);
      return new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d ?? 3, useGrouping: grouping }).format(v);
    }
    case "formatCurrency": {
      const v = num(arg("value"));
      if (!Number.isFinite(v)) return "";
      const d = rawArgs.decimals == null ? undefined : num(arg("decimals"));
      const grouping = rawArgs.grouping == null ? true : resolveBool(rawArgs.grouping, scope);
      try {
        return new Intl.NumberFormat(undefined, { style: "currency", currency: String(arg("currency") ?? "USD"), minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: grouping }).format(v);
      } catch { return `${v} ${String(arg("currency") ?? "")}`.trim(); }
    }
    case "formatDate": return formatDate(arg("value"), String(arg("format") ?? "yyyy-MM-dd"));
    case "pluralize": {
      const v = num(arg("value"));
      const cat = v === 0 && rawArgs.zero != null ? "zero" : new Intl.PluralRules().select(v);
      const pick = rawArgs[cat] != null ? cat : "other";
      return resolveString(rawArgs[pick], scope);
    }
    case "openUrl": return null;
    default: return null;
  }
}

/** formatString: `${/abs/path}`, `${relative}` and `${@index}` placeholders; `\${` keeps a literal. */
export function formatTemplate(tpl: string, scope: A2uiScope): string {
  return tpl.replace(/(\\?)\$\{([^}]*)\}/g, (all, bs: string, expr: string) => {
    if (bs) return all.slice(1);
    const e = expr.trim();
    if (e === "@index") return String(scope.index ?? "");
    const v = getPointer(scope.data, joinPointer(scope.base, e));
    return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A small TR35 subset (y M d E H h m s a), enough for chat cards. Unparseable dates come back unchanged. */
export function formatDate(value: unknown, pattern: string): string {
  const d = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value ?? ""));
  if (Number.isNaN(d.getTime())) return String(value ?? "");
  const pad = (x: number, w = 2) => String(x).padStart(w, "0");
  const h12 = d.getHours() % 12 || 12;
  return pattern.replace(/'([^']*)'|y{1,4}|M{1,4}|d{1,2}|E{1,4}|H{1,2}|h{1,2}|m{1,2}|s{1,2}|a/g, (t, lit: string | undefined) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case "yyyy": case "yyy": case "y": return String(d.getFullYear());
      case "yy": return pad(d.getFullYear() % 100);
      case "MMMM": return MONTHS[d.getMonth()]!;
      case "MMM": return MONTHS[d.getMonth()]!.slice(0, 3);
      case "MM": return pad(d.getMonth() + 1);
      case "M": return String(d.getMonth() + 1);
      case "dd": return pad(d.getDate());
      case "d": return String(d.getDate());
      case "EEEE": return DAYS[d.getDay()]!;
      case "EEE": case "EE": case "E": return DAYS[d.getDay()]!.slice(0, 3);
      case "HH": return pad(d.getHours());
      case "H": return String(d.getHours());
      case "hh": return pad(h12);
      case "h": return String(h12);
      case "mm": return pad(d.getMinutes());
      case "m": return String(d.getMinutes());
      case "ss": return pad(d.getSeconds());
      case "s": return String(d.getSeconds());
      case "a": return d.getHours() < 12 ? "AM" : "PM";
      default: return t;
    }
  });
}

/** Failed checks of an input component (`@checks`), as messages. */
export function failedChecks(c: A2uiComponent, scope: A2uiScope): string[] {
  const checks = c["@checks"];
  if (!Array.isArray(checks)) return [];
  return checks.filter((k) => k && typeof k === "object" && !resolveBool((k as any).condition, scope))
    .map((k) => String((k as any).message ?? "Invalid value"));
}

/** The children of a container: static ids, or one template instance per item of a data list. */
export function childList(children: unknown, scope: A2uiScope): { id: string; scope: A2uiScope; key: string }[] {
  if (Array.isArray(children)) return children.filter((x): x is string => typeof x === "string").map((id) => ({ id, scope, key: id }));
  if (children && typeof children === "object" && typeof (children as any).componentId === "string" && typeof (children as any).path === "string") {
    const tpl = (children as any).componentId as string;
    const listPtr = joinPointer(scope.base, (children as any).path);
    const list = getPointer(scope.data, listPtr);
    const keys = Array.isArray(list) ? list.map((_, i) => String(i)) : list && typeof list === "object" ? Object.keys(list) : [];
    return keys.map((k, i) => ({ id: tpl, key: `${tpl}:${k}`, scope: { data: scope.data, base: `${listPtr === "/" ? "" : listPtr}/${k}`, index: i } }));
  }
  return [];
}

/** The resolved event context of a Button action. */
export function actionEvent(action: unknown, scope: A2uiScope): { name: string; userMessage: string | null; context: Record<string, unknown> } | null {
  const ev = action && typeof action === "object" ? (action as any).event : null;
  if (!ev || typeof ev.name !== "string") return null;
  const context: Record<string, unknown> = {};
  if (ev.context && typeof ev.context === "object") for (const [k, v] of Object.entries(ev.context)) context[k] = resolveValue(v, scope);
  const um = ev.userMessage == null ? null : resolveString(ev.userMessage, scope).trim() || null;
  return { name: ev.name, userMessage: um, context };
}

/** The message a clicked button sends back to the agent: the human-readable line, then the A2UI action (and, when the
 *  surface asked for it with sendDataModel, its data model) in an ```a2ui-action block. The chat shows only the first line. */
export function actionMessage(surfaceId: string, sourceComponentId: string, ev: { name: string; userMessage: string | null; context: Record<string, unknown> },
  dataModel?: Record<string, unknown>): string {
  const action = { version: A2UI_VERSION, action: { name: ev.name, surfaceId, sourceComponentId, timestamp: new Date().toISOString(), context: ev.context,
    ...(ev.userMessage ? { userMessage: ev.userMessage } : {}) } };
  const ctx = Object.entries(ev.context).map(([k, v]) => `${k} = ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(", ");
  const head = ev.userMessage ?? `${humanize(ev.name)}${ctx ? `: ${ctx}` : ""}`;
  const meta = dataModel ? `\n${JSON.stringify({ surfaceId, dataModel })}` : "";
  return `${head}\n\n\`\`\`a2ui-action\n${JSON.stringify(action)}${meta}\n\`\`\``;
}

const ACTION_FENCE = /\n*```a2ui-action[^\n]*\n[\s\S]*?(?:```|$(?![\s\S]))/g;
/** A user message without its machine-readable ```a2ui-action block (what the chat shows for a button click). */
export function stripA2uiAction(text: string): string {
  return text.includes("```a2ui-action") ? text.replace(ACTION_FENCE, "").trimEnd() : text;
}

const humanize = (s: string) => s.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());

// ---------------------------------------------------------------- plain-text fallback

/** Readable text of every surface in a reply (for previews, notifications, history summaries and copy). */
export function a2uiPlainText(src: string): string {
  const doc = a2uiDoc(src);
  const lines: string[] = [];
  for (const s of doc.surfaces) {
    const seen = new Set<string>();
    const walk = (id: string, scope: A2uiScope, depth: number): void => {
      const c = s.components[id];
      if (!c || depth > 40 || seen.has(`${id}@${scope.base}`)) return;
      seen.add(`${id}@${scope.base}`);
      const str = (k: string) => resolveString(c[k], scope).trim();
      switch (c.component) {
        case "Text": { const t = str("text"); if (t) lines.push(t); break; }
        case "Button": if (typeof c.child === "string") { const before = lines.length; walk(c.child, scope, depth + 1); if (lines.length > before) lines[lines.length - 1] = `[${lines[lines.length - 1]}]`; } return;
        case "TextField": case "DateTimeInput": case "Slider": { const l = str("label"); if (l) lines.push(`${l}: ${str("value")}`); break; }
        case "CheckBox": lines.push(`${resolveBool(c.value, scope) ? "[x]" : "[ ]"} ${str("label")}`); break;
        case "ChoicePicker": {
          const l = str("label");
          const opts = Array.isArray(c.options) ? c.options.map((o: any) => resolveString(o?.label, scope)).filter(Boolean) : [];
          lines.push(`${l ? `${l}: ` : ""}${opts.join(" / ")}`);
          break;
        }
        case "Tabs": if (Array.isArray(c.tabs)) for (const t of c.tabs as any[]) { lines.push(resolveString(t?.title, scope)); if (typeof t?.child === "string") walk(t.child, scope, depth + 1); } return;
        case "Modal": if (typeof c.trigger === "string") walk(c.trigger, scope, depth + 1); if (typeof c.content === "string") walk(c.content, scope, depth + 1); return;
        case "Image": { const d = str("description"); if (d) lines.push(`[image: ${d}]`); break; }
        default: break;
      }
      if (typeof c.child === "string") walk(c.child, scope, depth + 1);
      if (c.children) for (const ch of childList(c.children, scope)) walk(ch.id, ch.scope, depth + 1);
    };
    walk("root", { data: s.data, base: "" }, 0);
  }
  return lines.join("\n");
}

/** A2UI fences in a reply: ```a2ui, or a ```json block that holds A2UI messages. */
const FENCE = /```(a2ui|json)[^\S\n]*\n([\s\S]*?)(?:\n[^\S\n]*```|$(?![\s\S]))/g;

/** The reply with every A2UI block replaced by its readable text: what a preview, a notification or a summary shows. */
export function stripA2ui(text: string): string {
  if (!text.includes("```")) return text;
  return text.replace(FENCE, (all, lang: string, body: string) => (lang === "json" && !looksLikeA2ui(body) ? all : a2uiPlainText(body)));
}

/** A message as history and summaries carry it: surfaces as readable text, button clicks as their one-line message. */
export function a2uiForHistory(text: string): string {
  return stripA2uiAction(stripA2ui(text));
}
