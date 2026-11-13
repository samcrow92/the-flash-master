/**
 * App icon set: Lucide line icons (consistent 1.75 stroke) plus coloured role badges.
 * Built-in roles get a drawn icon on a soft gradient; imported/custom roles keep their emoji.
 */
import type { CSSProperties } from "react";
import {
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

/** Role avatar: gradient badge with a line icon (built-in roles) or the role's emoji (custom roles). */
export function RoleIcon({ role, emoji, size = 22, className = "" }: { role: string | null | undefined; emoji?: string; size?: number; className?: string }) {
  const def = role ? ROLE_ICONS[role] : undefined;
  const style = { width: size, height: size, "--hue": def?.hue ?? 220 } as CSSProperties;
  if (!def) {
    return <span className={`role-badge emoji ${className}`} style={style}><span style={{ fontSize: size * 0.62 }}>{emoji || "🤖"}</span></span>;
  }
  const I = def.icon;
  return <span className={`role-badge ${className}`} style={style}><I size={Math.round(size * 0.58)} strokeWidth={2} /></span>;
}

export const DefaultAgentIcon = Bot;
