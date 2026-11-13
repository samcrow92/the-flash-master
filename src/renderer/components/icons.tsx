/**
 * App icon set: thin Lucide line icons (SF Symbols-like, 1.6 stroke via LucideProvider) on iOS-style glass tiles.
 * No emoji anywhere: custom roles get a bot glyph tinted by a hue derived from their name, and reaction emoji
 * (stored as text, e.g. ✅ / ❌ approvals) are drawn as animated line icons.
 */
import type { CSSProperties } from "react";
import {
  Check, Eye, Heart, PartyPopper, Rocket, ThumbsDown, ThumbsUp, X, CircleCheck, CircleX, CircleAlert,
  Bot, Building2, Car, ClipboardList, ClipboardCheck, CodeXml, FlaskConical, Fish, ListChecks, Presentation, ScanSearch, Swords, Bug, Zap,
  type LucideIcon,
} from "lucide-react";

export * from "lucide-react";

const ROLE_ICONS: Record<string, { icon: LucideIcon; hue: number }> = {
  flashmaster: { icon: Zap, hue: 45 },
  "autosar-vector": { icon: Car, hue: 210 },
  challenger: { icon: Swords, hue: 355 },
  reviewer: { icon: ScanSearch, hue: 175 },
  "jazz-analyst": { icon: ClipboardList, hue: 235 },
  "rca-analyst": { icon: Fish, hue: 25 },
  "presentation-expert": { icon: Presentation, hue: 320 },
  analyst: { icon: ListChecks, hue: 190 },
  architect: { icon: Building2, hue: 265 },
  "software-expert": { icon: CodeXml, hue: 145 },
  tester: { icon: FlaskConical, hue: 90 },
  "winidea-debugger": { icon: Bug, hue: 38 },
  "exam-test-agent": { icon: ClipboardCheck, hue: 120 },
};

/** Stable hue for a custom role, so each one keeps its own tint. */
const hueOf = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Role avatar: an iOS-style glass squircle tinted per role, with a thin line icon. Custom roles get a bot glyph. */
export function RoleIcon({ role, size = 22, className = "" }: { role: string | null | undefined; emoji?: string; size?: number; className?: string }) {
  const def = role ? ROLE_ICONS[role] : undefined;
  const hue = def?.hue ?? (role ? hueOf(role) : 220);
  const style = { width: size, height: size, "--hue": hue } as CSSProperties;
  const I = def?.icon ?? Bot;
  return <span className={`role-badge ${def ? "" : "custom"} ${className}`} style={style}><I size={Math.round(size * 0.56)} strokeWidth={1.8} /></span>;
}

/** Reaction emoji → line icon + tint + its own little animation (see .rx-* in styles.css). Unknown emoji fall back to text. */
export const REACTIONS: Record<string, { icon: LucideIcon; label: string; cls: string }> = {
  "👍": { icon: ThumbsUp, label: "Like", cls: "rx-like" },
  "👎": { icon: ThumbsDown, label: "Dislike", cls: "rx-dislike" },
  "✅": { icon: Check, label: "Approve", cls: "rx-ok" },
  "❌": { icon: X, label: "Deny", cls: "rx-no" },
  "🎉": { icon: PartyPopper, label: "Celebrate", cls: "rx-party" },
  "👀": { icon: Eye, label: "Looking", cls: "rx-eyes" },
  "❤️": { icon: Heart, label: "Love", cls: "rx-love" },
  "🚀": { icon: Rocket, label: "Ship it", cls: "rx-rocket" },
};
export function ReactionIcon({ emoji, size = 14 }: { emoji: string; size?: number }) {
  const r = REACTIONS[emoji];
  if (!r) return <span className="rx-text">{emoji}</span>;
  const I = r.icon;
  return <span className={`rx ${r.cls}`}><I size={size} strokeWidth={2} /></span>;
}

/** ok / warn / fail mark in place of ✅ ⚠️ ❌ in status text. */
export function StatusMark({ state, size = 14 }: { state: "ok" | "warn" | "fail"; size?: number }) {
  const I = state === "ok" ? CircleCheck : state === "warn" ? CircleAlert : CircleX;
  return <I size={size} className={`mark mark-${state}`} />;
}

export const DefaultAgentIcon = Bot;

/** Status text that may start with ✅ / ⚠️ / ❌ (from test buttons): the emoji is drawn as a StatusMark. */
export function MarkText({ text }: { text: string | undefined }) {
  if (!text) return null;
  const m = /^(✅|⚠️|⚠|❌)\s*/.exec(text);
  if (!m) return <>{text}</>;
  const state = m[1] === "✅" ? "ok" : m[1] === "❌" ? "fail" : "warn";
  return <span className="mark-text"><StatusMark state={state} size={13} /> {text.slice(m[0].length)}</span>;
}
