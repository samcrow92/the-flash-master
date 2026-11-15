/**
 * App icon set: thin monochrome Lucide line icons (SF Symbols-like, 1.6 stroke via LucideProvider).
 * No emoji anywhere: custom roles get a bot glyph, and reaction emoji
 * (stored as text, e.g. ✅ / ❌ approvals) are drawn as animated line icons.
 */
import {
  Check, Eye, Heart, PartyPopper, Rocket, ThumbsDown, ThumbsUp, X, CircleCheck, CircleX, CircleAlert,
  Bot, Building2, Car, ClipboardList, ClipboardCheck, CodeXml, FlaskConical, Fish, ListChecks, Presentation, ScanSearch, Swords, Bug, Zap,
  type LucideIcon,
} from "lucide-react";

export * from "lucide-react";

const ROLE_ICONS: Record<string, LucideIcon> = {
  flashmaster: Zap,
  "autosar-vector": Car,
  challenger: Swords,
  reviewer: ScanSearch,
  "jazz-analyst": ClipboardList,
  "rca-analyst": Fish,
  "presentation-expert": Presentation,
  analyst: ListChecks,
  architect: Building2,
  "software-expert": CodeXml,
  tester: FlaskConical,
  "winidea-debugger": Bug,
  "exam-test-agent": ClipboardCheck,
};

export type RoleIconState = "working" | "paused";

/**
 * Role icon: a monochrome line glyph in the current text colour, like the sidebar and title bar icons.
 * `framed` puts it on a neutral hairline tile (message avatars, docs cards). Activity follows the glyph's own shape:
 * while working, an echo of the same glyph swells out of it and fades; while paused, the glyph rests in amber.
 */
export function RoleIcon({ role, size = 22, className = "", framed = false, state }: {
  role: string | null | undefined; emoji?: string; size?: number; className?: string; framed?: boolean; state?: RoleIconState;
}) {
  const I = (role && ROLE_ICONS[role]) || Bot;
  const g = Math.round(size * (framed ? 0.56 : 0.74));
  const cls = ["role-badge", framed && "framed", state && `is-${state}`, className].filter(Boolean).join(" ");
  return (
    <span className={cls} style={{ width: size, height: size }}>
      <I size={g} className="role-glyph" />
      {state === "working" && <I size={g} className="role-echo" aria-hidden />}
    </span>
  );
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
