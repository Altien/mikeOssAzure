"use client";

import { useState } from "react";
import { cn } from "@/app/lib/utils";

// Dark enough for white initials in either theme. Never use a random colour:
// normalized email identifies the same person across every roster and session.
const COLOURS = [
  "bg-slate-700", "bg-red-700", "bg-orange-700", "bg-amber-800",
  "bg-emerald-700", "bg-teal-700", "bg-cyan-800", "bg-indigo-700",
  "bg-violet-700", "bg-pink-700",
];

export function avatarColour(email?: string | null, name?: string | null) {
  const key = email?.trim().toLowerCase() || name?.trim().toLowerCase() || "user";
  let hash = 0;
  for (const character of key) hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;
  return COLOURS[hash % COLOURS.length];
}

export function avatarInitials(name?: string | null, email?: string | null) {
  const label = name?.trim() || email?.trim().split("@")[0] || "?";
  const words = label.split(/[\s._-]+/u).filter(Boolean);
  return (Array.from(words[0] || "?")[0] +
    (words.length > 1 ? Array.from(words[words.length - 1])[0] : "")).toUpperCase();
}

/** A photo with a deterministic, accessible fallback, including broken images. */
export function UserAvatar({ photo, name, email, className }: {
  photo?: string | null;
  name?: string | null;
  email?: string | null;
  className?: string;
}) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const source = photo && /^data:image\/(png|jpeg|webp);base64,/.test(photo) && photo !== failedPhoto
    ? photo : null;
  return (
    <span
      role="img"
      aria-label={name?.trim() || email?.trim() || "User"}
      data-slot="user-avatar"
      className={cn("inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full font-serif text-[10px] font-medium text-white", avatarColour(email, name), className)}
    >
      {source ? (
        // Already cropped to a small raster data URL; no external fetch or optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={source} alt="" className="h-full w-full object-cover" onError={() => setFailedPhoto(source)} />
      ) : <span aria-hidden="true">{avatarInitials(name, email)}</span>}
    </span>
  );
}
