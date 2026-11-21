import type { UiPhase } from "@/lib/types";
import { PHASE_LABEL } from "./sides";

const COLOR: Partial<Record<UiPhase, string>> = { betting: "bg-gold", debate: "bg-win", judging: "bg-court-light", results: "bg-gold", cancelled: "bg-ink" };

export function PhaseBadge({ phase, className = "" }: { phase: UiPhase; className?: string }) {
  return (
    <span key={phase} className={`animate-pop inline-block rounded-full px-3 py-1 text-sm font-black uppercase tracking-wide text-white ${COLOR[phase] ?? "bg-white/20"} ${className}`}>
      {PHASE_LABEL[phase]}
    </span>
  );
}

/** Big punchy banner that re-animates whenever the phase changes. */
export function PhaseBanner({ phase, sub, className = "" }: { phase: UiPhase; sub?: string; className?: string }) {
  return (
    <div key={phase} className={`animate-banner text-center ${className}`}>
      <h1 className="text-4xl md:text-6xl font-black drop-shadow-[0_4px_0_rgba(0,0,0,0.25)]">{PHASE_LABEL[phase]}</h1>
      {sub && <p className="mt-1 text-lg md:text-2xl font-bold text-white/80">{sub}</p>}
    </div>
  );
}
