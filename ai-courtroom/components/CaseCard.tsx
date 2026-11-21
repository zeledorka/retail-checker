"use client";
import { useState } from "react";
import type { UiCase } from "@/lib/types";

/** Ends each evidence line with punctuation so the lines read as one paragraph. */
const asSentence = (s: string) => {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** Shown instead of the image when the case has none (imageUrl null) or the image fails to load. Never a broken image. */
function ImagePlaceholder({ big }: { big: boolean }) {
  return (
    <div className={`relative grid w-full place-items-center overflow-hidden bg-gradient-to-br from-court to-court-dark ${big ? "h-64" : "h-40"}`} aria-hidden>
      {/* soft spotlight + chunky Kahoot-style emblem */}
      <div className="absolute -top-1/2 left-1/2 h-[200%] w-2/3 -translate-x-1/2 rounded-full bg-gold/15 blur-2xl" />
      <div className={`relative grid place-items-center rounded-full bg-white/95 shadow-[0_6px_0_rgba(0,0,0,0.3)] ${big ? "h-32 w-32 text-7xl" : "h-20 w-20 text-4xl"}`}>⚖️</div>
      <span className={`absolute left-4 top-3 rotate-[-12deg] ${big ? "text-5xl" : "text-3xl"}`}>🔍</span>
      <span className={`absolute bottom-3 right-5 rotate-[10deg] ${big ? "text-5xl" : "text-3xl"}`}>📁</span>
    </div>
  );
}

/**
 * Case reveal card: image (or a styled placeholder), the scenario text, then the evidence as one flowing paragraph.
 * No label/title/bullets, on purpose. `big` = projector sizing.
 */
export function CaseCard({ c, big = false, className = "" }: { c: UiCase; big?: boolean; className?: string }) {
  const evidence = c.evidence.map(asSentence).join(" ");
  // Remember which URL failed, so a new case with a different image is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!c.imageUrl && failedUrl !== c.imageUrl;
  return (
    <div className={`card animate-slide-up overflow-hidden ${className}`}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- external case image URL (Supabase Storage etc.), unknown host
        <img src={c.imageUrl!} alt="" onError={() => setFailedUrl(c.imageUrl)} className={`w-full object-cover ${big ? "h-64" : "h-40"}`} />
      ) : (
        <ImagePlaceholder big={big} />
      )}
      <div className={big ? "p-8" : "p-4"}>
        <p className={`font-bold leading-snug text-ink ${big ? "text-3xl" : "text-lg"}`}>{c.description}</p>
        {evidence && (
          <p className={`animate-slide-up font-semibold leading-snug text-ink/80 ${big ? "mt-5 text-2xl" : "mt-3 text-base"}`} style={{ animationDelay: "200ms" }}>
            {evidence}
          </p>
        )}
      </div>
    </div>
  );
}
