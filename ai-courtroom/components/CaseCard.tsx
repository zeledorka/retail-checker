"use client";
import { useState } from "react";
import type { UiCase } from "@/lib/types";

/**
 * Slim banner shown instead of the image when the case has none (imageUrl null, the usual case today) or the image
 * fails to load. Deliberately short so the evidence gets the space. Never a broken image.
 */
function ImagePlaceholder({ big }: { big: boolean }) {
  return (
    <div className={`flex w-full items-center justify-center gap-[0.8em] rounded-t-[1.25rem] bg-gradient-to-r from-court-dark via-court to-court-dark text-white ${big ? "h-[6vh] text-[clamp(1.4rem,2.4vh,2.2rem)]" : "h-11 text-xl"}`} aria-hidden>
      <span className="rotate-[-12deg]">🔍</span>
      <span className="grid aspect-square h-[1.6em] place-items-center rounded-full bg-white/95 shadow-[0_3px_0_rgba(0,0,0,0.3)]">⚖️</span>
      <span className="rotate-[10deg]">📁</span>
    </div>
  );
}

/**
 * Case reveal card: image (or the slim placeholder), optional title, the scenario, then every evidence item as its own
 * numbered row. `big` = projector sizing (vh/clamp, evidence in two columns so 6 items fit 1920x1080 without
 * scrolling). No overflow clipping anywhere: on a phone the page simply scrolls.
 */
export function CaseCard({ c, big = false, showTitle = false, className = "" }: { c: UiCase; big?: boolean; showTitle?: boolean; className?: string }) {
  // Remember which URL failed, so a new case with a different image is tried again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = !!c.imageUrl && failedUrl !== c.imageUrl;
  return (
    <div className={`card animate-slide-up ${className}`}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- external case image URL (Supabase Storage etc.), unknown host
        <img src={c.imageUrl!} alt="" onError={() => setFailedUrl(c.imageUrl)}
          className={`w-full rounded-t-[1.25rem] object-cover ${big ? "h-[18vh]" : "h-32"}`} />
      ) : (
        <ImagePlaceholder big={big} />
      )}
      <div className={big ? "p-[2.2vh]" : "p-4"}>
        {showTitle && (
          <h2 className={`font-black leading-tight text-ink ${big ? "mb-[0.8vh] text-[clamp(1.6rem,2.4vw,3rem)]" : "mb-1 text-2xl"}`}>{c.title}</h2>
        )}
        <p className={`font-bold leading-snug text-ink ${big ? "text-[clamp(1rem,1.25vw,1.6rem)]" : "text-base"}`}>{c.description}</p>
        {c.evidence.length > 0 && (
          <ol className={`grid ${big ? "mt-[1.6vh] grid-cols-2 gap-[1vh]" : "mt-3 gap-2"}`} aria-label="Evidence">
            {c.evidence.map((e, i) => (
              <li key={i} className={`animate-slide-up flex items-start gap-2 rounded-xl bg-court/10 font-bold leading-snug text-ink ${big ? "p-[1vh] text-[clamp(0.9rem,1.05vw,1.35rem)]" : "p-2 text-sm"}`}
                style={{ animationDelay: `${150 + i * 90}ms` }}>
                <span className="shrink-0 rounded-md bg-court px-[0.5em] font-black text-white">{i + 1}</span>
                <span>{e}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
