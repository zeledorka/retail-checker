import type { UiLeaderboardEntry } from "@/lib/types";

/** Small +/- chip for a per-round token change (only rendered when the server provided one). */
function DeltaChip({ d, big }: { d?: number; big: boolean }) {
  if (d === undefined) return null;
  const cls = d > 0 ? "bg-win" : d < 0 ? "bg-agent-a" : "bg-white/30";
  return <span className={`animate-pop ml-2 inline-block rounded-full px-2 font-black text-white ${cls} ${big ? "text-lg" : "text-[10px]"}`}>{d > 0 ? "+" : ""}{d}</span>;
}

const PODIUM = [
  { place: 2, h: "h-28", bg: "bg-gray-300", medal: "🥈" },
  { place: 1, h: "h-40", bg: "bg-gold", medal: "🥇" },
  { place: 3, h: "h-20", bg: "bg-orange-400", medal: "🥉" },
];

/** Top 3 on a podium, the rest in a list. */
export function Podium({ entries, big = false, maxRest = 5, showDeltas = false }: { entries: UiLeaderboardEntry[]; big?: boolean; maxRest?: number; showDeltas?: boolean }) {
  const top = entries.slice(0, 3);
  const rest = entries.slice(3, 3 + maxRest);
  return (
    <div className="grid gap-4">
      <div className="flex items-end justify-center gap-3">
        {PODIUM.map((p, i) => {
          const e = top[p.place - 1];
          if (!e) return <div key={p.place} className={big ? "w-56" : "w-24"} />;
          return (
            <div key={p.place} className={`animate-slide-up flex flex-col items-center ${big ? "w-56" : "w-24"}`} style={{ animationDelay: `${300 + i * 250}ms` }}>
              <span className={big ? "text-5xl" : "text-2xl"}>{p.medal}</span>
              <span className={`max-w-full truncate font-black ${big ? "text-2xl" : "text-sm"} ${e.isMe ? "underline decoration-4" : ""}`}>{e.nickname}</span>
              <span className={`font-extrabold text-white/80 ${big ? "text-xl" : "text-xs"}`}>🪙 {e.tokens}{showDeltas && <DeltaChip d={e.roundDelta} big={big} />}</span>
              <div className={`mt-1 w-full rounded-t-xl ${p.bg} ${big ? "" : p.h} grid place-items-center text-ink shadow-[0_6px_0_rgba(0,0,0,0.25)]`}
                style={big ? { height: p.place === 1 ? 200 : p.place === 2 ? 150 : 110 } : undefined}>
                <span className={`font-black ${big ? "text-6xl" : "text-3xl"}`}>{p.place}</span>
              </div>
            </div>
          );
        })}
      </div>
      {rest.length > 0 && (
        <ol className="grid gap-1.5">
          {rest.map((e, i) => (
            <li key={e.nickname + i} className={`animate-slide-up flex items-center justify-between rounded-xl px-4 py-2 font-black ${e.isMe ? "bg-white text-ink" : "bg-white/15"} ${big ? "text-2xl" : "text-sm"}`} style={{ animationDelay: `${900 + i * 80}ms` }}>
              <span>{i + 4}. {e.nickname}{e.isMe ? " (you)" : ""}</span>
              <span>🪙 {e.tokens}{showDeltas && <DeltaChip d={e.roundDelta} big={big} />}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function rankOf(entries: UiLeaderboardEntry[]) {
  const i = entries.findIndex((e) => e.isMe);
  return i < 0 ? null : i + 1;
}
