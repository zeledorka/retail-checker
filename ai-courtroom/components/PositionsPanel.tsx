import type { Side, UiCase } from "@/lib/types";
import { AgentIcon, SIDE } from "./sides";

export function PositionCard({ side, text, big = false, dim = false, delay = 0 }: { side: Side; text: string; big?: boolean; dim?: boolean; delay?: number }) {
  return (
    <div className={`animate-pop rounded-2xl text-white shadow-[0_6px_0_rgba(0,0,0,0.25)] ${SIDE[side].bg} ${big ? "p-6" : "p-4"} ${dim ? "opacity-50" : ""}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center gap-2">
        <AgentIcon side={side} className={big ? "w-10 h-10" : "w-6 h-6"} />
        <span className={`font-black uppercase tracking-wide ${big ? "text-3xl" : "text-lg"}`}>{SIDE[side].name} argues</span>
      </div>
      <p className={`font-extrabold leading-snug ${big ? "text-3xl mt-3" : "text-lg mt-1"}`}>{text}</p>
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
