import type { PublicArgument, Side } from "@/lib/types";
import { AgentIcon, SIDE } from "./sides";

export const argLabel = (a: PublicArgument) => (a.stage === "opening" ? "Opening" : `Turn ${a.sequence}`);

export function SpeechBubble({ arg, newest = false, big = false, align }: { arg: PublicArgument; newest?: boolean; big?: boolean; align?: "left" | "right" }) {
  const s = SIDE[arg.side];
  const side = align ?? (arg.side === "A" ? "left" : "right");
  return (
    <div className={`animate-slide-up flex ${side === "right" ? "justify-end" : "justify-start"}`}>
      <div className={`relative max-w-[92%] rounded-2xl text-white shadow-[0_5px_0_rgba(0,0,0,0.25)] ${s.bg} ${big ? "px-6 py-4" : "px-4 py-3"} ${newest ? "ring-4 ring-white" : "opacity-95"}`}>
        <div className={`flex items-center gap-2 font-black uppercase tracking-wide text-white/90 ${big ? "text-lg" : "text-xs"}`}>
          <AgentIcon side={arg.side} className={big ? "w-5 h-5" : "w-3.5 h-3.5"} />
          {s.name} · {argLabel(arg)}
        </div>
        <p className={`font-bold leading-snug ${big ? "text-2xl mt-1" : "text-base mt-0.5"} ${newest ? "reveal-text" : ""}`}>{arg.text}</p>
      </div>
    </div>
  );
}

export function ThinkingBubble({ side, big = false, slow = false }: { side: Side; big?: boolean; slow?: boolean }) {
  const s = SIDE[side];
  return (
    <div className={`flex ${side === "A" ? "justify-start" : "justify-end"}`} aria-live="polite">
      <div className={`flex items-center gap-3 rounded-2xl border-4 border-dashed bg-white/10 ${s.border} ${big ? "px-6 py-4 text-2xl" : "px-4 py-2 text-sm"} font-black`}>
        <AgentIcon side={side} className={big ? "w-6 h-6" : "w-4 h-4"} color={s.hex} />
        <span>{s.name} is {slow ? "still thinking" : "thinking"}</span>
        <span className="inline-flex gap-1">
          {[0, 1, 2].map((i) => <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-white" style={{ animationDelay: `${i * 150}ms` }} />)}
        </span>
      </div>
    </div>
  );
}
