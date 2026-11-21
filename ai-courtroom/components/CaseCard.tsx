import type { UiCase } from "@/lib/types";

/** Ends each evidence line with punctuation so the lines read as one paragraph. */
const asSentence = (s: string) => {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/**
 * Case reveal card: image (if the case has one), the scenario text, then the evidence as one flowing paragraph.
 * No label/title/bullets, on purpose. `big` = projector sizing.
 */
export function CaseCard({ c, big = false, className = "" }: { c: UiCase; big?: boolean; className?: string }) {
  const evidence = c.evidence.map(asSentence).join(" ");
  return (
    <div className={`card animate-slide-up overflow-hidden ${className}`}>
      {c.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- external case image URL, unknown host
        <img src={c.imageUrl} alt="" className={`w-full object-cover ${big ? "h-64" : "h-40"}`} />
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
