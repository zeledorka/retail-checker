import type { UiCase } from "@/lib/types";

/** Scenario + evidence (+ image if the case has one). `big` = projector sizing. */
export function CaseCard({ c, big = false, className = "" }: { c: UiCase; big?: boolean; className?: string }) {
  return (
    <div className={`card animate-slide-up overflow-hidden ${className}`}>
      {c.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- external case image URL, unknown host
        <img src={c.imageUrl} alt="" className={`w-full object-cover ${big ? "h-64" : "h-40"}`} />
      )}
      <div className={big ? "p-8" : "p-4"}>
        <p className={`font-black uppercase tracking-widest text-court ${big ? "text-xl" : "text-xs"}`}>📁 Case file</p>
        <h2 className={`font-black leading-tight ${big ? "text-5xl mt-2" : "text-2xl mt-1"}`}>{c.title}</h2>
        <p className={`font-semibold text-ink/80 ${big ? "text-2xl mt-4" : "text-base mt-2"}`}>{c.description}</p>
        <ul className={`grid gap-2 ${big ? "mt-6 text-xl" : "mt-3 text-sm"}`}>
          {c.evidence.map((e, i) => (
            <li key={i} className="animate-slide-up flex gap-2 rounded-xl bg-court/10 p-2 font-bold" style={{ animationDelay: `${150 + i * 120}ms` }}>
              <span className="shrink-0 rounded-md bg-court px-2 text-white">#{i + 1}</span>
              <span>{e}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
