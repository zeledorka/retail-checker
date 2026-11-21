import type { Side, UiCase } from "@/lib/types";
import { AgentIcon, SIDE } from "./sides";

/** `fit` = projector case-reveal sizing (clamp/vh) so long real positions (~200 chars) fit 1080p next to the case. */
export function PositionCard({ side, text, big = false, dim = false, delay = 0, fit = false }: { side: Side; text: string; big?: boolean; dim?: boolean; delay?: number; fit?: boolean }) {
  const pad = fit ? "p-[2vh]" : big ? "p-6" : "p-4";
  const icon = fit ? "h-[clamp(1.6rem,3.6vh,2.5rem)] w-[clamp(1.6rem,3.6vh,2.5rem)]" : big ? "w-10 h-10" : "w-6 h-6";
  const head = fit ? "text-[clamp(1.2rem,1.7vw,2.1rem)]" : big ? "text-3xl" : "text-lg";
  const body = fit ? "mt-[1vh] text-[clamp(1.05rem,1.45vw,1.85rem)]" : big ? "text-3xl mt-3" : "text-lg mt-1";
  return (
    <div className={`animate-pop rounded-2xl text-white shadow-[0_6px_0_rgba(0,0,0,0.25)] ${SIDE[side].bg} ${pad} ${dim ? "opacity-50" : ""}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-2">
        <AgentIcon side={side} className={icon} />
        <span className={`font-black uppercase tracking-wide ${head}`}>{SIDE[side].name} argues</span>
      </div>
      <p className={`font-extrabold leading-snug ${body}`}>{text}</p>
    </div>
  );
}

export function PositionsPanel({ c, big = false, highlight }: { c: UiCase; big?: boolean; highlight?: Side | null }) {
  return (
    <div className={`grid gap-3 ${big ? "grid-cols-2 gap-6" : "grid-cols-1"}`}>
      <PositionCard side="A" text={c.positionA} big={big} dim={!!highlight && highlight !== "A"} delay={100} />
      <PositionCard side="B" text={c.positionB} big={big} dim={!!highlight && highlight !== "B"} delay={250} />
    </div>
  );
}
