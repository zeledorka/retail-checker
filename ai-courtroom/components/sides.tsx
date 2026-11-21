// Agent A = RED + triangle, Agent B = BLUE + diamond. Always pair colour with icon + label.
import type { Side, UiPhase } from "@/lib/types";

export const SIDE = {
  A: { name: "Agent A", short: "A", bg: "bg-agent-a", bgDark: "bg-agent-a-dark", text: "text-agent-a", border: "border-agent-a", ring: "ring-agent-a", hex: "#e21b3c" },
  B: { name: "Agent B", short: "B", bg: "bg-agent-b", bgDark: "bg-agent-b-dark", text: "text-agent-b", border: "border-agent-b", ring: "ring-agent-b", hex: "#1368ce" },
} as const;

export function AgentIcon({ side, className = "w-6 h-6", color = "white" }: { side: Side; className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      {side === "A" ? <polygon points="16,3 30,28 2,28" fill={color} /> : <polygon points="16,2 30,16 16,30 2,16" fill={color} />}
    </svg>
  );
}

/** Coloured chip: icon + "Agent A". */
export function AgentTag({ side, className = "" }: { side: Side; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-black text-white ${SIDE[side].bg} ${className}`}>
      <AgentIcon side={side} className="w-4 h-4" />
      {SIDE[side].name}
    </span>
  );
}

export const PHASE_LABEL: Record<UiPhase, string> = {
  lobby: "Lobby", reveal: "The Case", betting: "Place your bets", openings: "Opening statements", debate: "The debate",
  judging: "The judge deliberates", results: "Verdict", cancelled: "Round cancelled", game_over: "Game over",
};
