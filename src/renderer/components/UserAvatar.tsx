import type { CSSProperties } from "react";
import { useStore } from "../store";
import { User } from "./icons";

export const initials = (name: string) =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

/** Your avatar: uploaded picture, else initials on your colour, else a person icon. */
export function UserAvatar({ size = 32, className = "", profile }: { size?: number; className?: string; profile?: { name: string; avatar: string; hue: number } }) {
  const stored = useStore((s) => s.settings?.profile);
  const p = profile ?? stored ?? { name: "", avatar: "", hue: 210 };
  const style = { width: size, height: size, "--hue": p.hue } as CSSProperties;
  if (p.avatar) return <span className={`user-avatar img ${className}`} style={style}><img src={p.avatar} alt={p.name || "You"} draggable={false} /></span>;
  const ini = initials(p.name);
  return (
    <span className={`user-avatar ${className}`} style={style}>
      {ini ? <span style={{ fontSize: size * (ini.length > 1 ? 0.38 : 0.46) }}>{ini}</span> : <User size={Math.round(size * 0.5)} />}
    </span>
  );
}

/** Center-crop and downscale an image file to a square WebP/JPEG data URL. */
export async function toAvatarDataUrl(file: Blob, px = 192): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("This file is not an image the app can read"));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = c.height = px;
    const g = c.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px);
    const webp = c.toDataURL("image/webp", 0.86);
    return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}
