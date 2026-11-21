"use client";
import { useEffect, useState } from "react";
import type { CriterionScores, UiVerdict } from "@/lib/types";
import { AgentIcon, SIDE } from "./sides";

const DIMS: { key: keyof CriterionScores; label: string }[] = [
  { key: "evidence", label: "Evidence" }, { key: "logic", label: "Logic" },
  { key: "rebuttal", label: "Rebuttal" }, { key: "persuasion", label: "Persuasion" },
];

/** Sum of the four 0-10 dimensions, for DISPLAY only (the judge's winner rule is applied server-side). */
export const scoreTotal = (s: CriterionScores) => s.evidence + s.logic + s.rebuttal + s.persuasion;

export function WinnerReveal({ v, big = false }: { v: UiVerdict; big?: boolean }) {
  const s = SIDE[v.winner];
  return (
    <div className={`animate-pop rounded-3xl text-center text-white shadow-[0_8px_0_rgba(0,0,0,0.3)] ${s.bg} ${big ? "p-8" : "p-5"}`}>
      <p className={`font-black uppercase tracking-[0.3em] text-white/80 ${big ? "text-2xl" : "text-sm"}`}>⚖️ The court finds for</p>
      <div className="mt-2 flex items-center justify-center gap-3">
        <AgentIcon side={v.winner} className={big ? "w-16 h-16" : "w-10 h-10"} />
        <span className={`font-black ${big ? "text-7xl" : "text-4xl"}`}>{s.name}</span>
      </div>
      {v.summary && <p className={`mt-2 font-bold text-white/90 ${big ? "text-2xl" : "text-base"}`}>{v.summary}</p>}
    </div>
  );
}

/** Horizontal, short winner banner for the projector so the rest of the verdict fits on one 16:9 screen. */
export function WinnerBanner({ v }: { v: UiVerdict }) {
  const s = SIDE[v.winner];
  return (
    <div className={`animate-pop flex items-center gap-5 rounded-3xl px-6 py-4 text-white shadow-[0_8px_0_rgba(0,0,0,0.3)] ${s.bg}`}>
      <AgentIcon side={v.winner} className="h-16 w-16 shrink-0" />
      <div className="min-w-0">
        <p className="text-[clamp(0.9rem,1.1vw,1.4rem)] font-black uppercase tracking-[0.25em] text-white/80">⚖️ The court finds for</p>
        <p className="text-[clamp(2.2rem,3.6vw,4.5rem)] font-black leading-none">{s.name}</p>
      </div>
      {v.summary && <p className="ml-auto max-w-[45%] text-right text-[clamp(1rem,1.4vw,1.8rem)] font-bold leading-snug text-white/90">{v.summary}</p>}
    </div>
  );
}

/** Per-side strengths / weaknesses and the decisive exchange, if the verdict has them. Never truncated. */
export function JudgeNotes({ v, className = "" }: { v: UiVerdict; className?: string }) {
  const has = v.strengths || v.weaknesses || v.decisiveExchange;
  if (!has) return null;
  return (
    <div className={`grid gap-3 ${className}`}>
      {(v.strengths || v.weaknesses) && (
        <div className="grid grid-cols-2 gap-4">
          {(["A", "B"] as const).map((side) => (
            <div key={side} className={`rounded-xl border-l-8 bg-gray-50 p-3 ${SIDE[side].border}`}>
              <p className={`flex items-center gap-1.5 font-black ${SIDE[side].text}`}>
                <AgentIcon side={side} className="h-4 w-4" color={SIDE[side].hex} /> {SIDE[side].name}
              </p>
              <ul className="mt-1 grid gap-0.5">
                {v.strengths?.[side]?.map((t, i) => <li key={`s${i}`}>✅ {t}</li>)}
                {v.weaknesses?.[side]?.map((t, i) => <li key={`w${i}`}>⚠️ {t}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
      {v.decisiveExchange && <p><span className="font-black text-court">Decisive moment:</span> {v.decisiveExchange.description}</p>}
    </div>
  );
}

export function IncompleteNotice({ v, big = false }: { v: UiVerdict; big?: boolean }) {
  if (v.complete) return null;
  return (
    <div className={`rounded-2xl bg-gold/90 font-black text-ink ${big ? "p-4 text-2xl" : "p-3 text-sm"}`}>
      ⏱️ Debate cut short: judged on {v.turnsCompleted} of {v.maxTurns} debate turns.
    </div>
  );
}

/** Four dimensions, A vs B, bars grow in after mount. */
export function ScoreBars({ v, big = false }: { v: UiVerdict; big?: boolean }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), 300); return () => clearTimeout(t); }, []);
  if (!v.scores) return null;
  const sc = v.scores;
  // Totals are for DISPLAY only (never used for payouts). The server's `overall` average is shown only if present.
  const label = (s: "A" | "B") => `${scoreTotal(sc[s])}/40${v.overall ? ` · avg ${v.overall[s]}` : ""}`;
  return (
    <div className={`card ${big ? "p-6" : "p-4"}`}>
      <div className={`mb-2 flex justify-between font-black ${big ? "text-2xl" : "text-sm"}`}>
        <span className="flex items-center gap-1 text-agent-a"><AgentIcon side="A" className="w-4 h-4" color={SIDE.A.hex} /> A {label("A")}</span>
        <span className="text-ink/60">Score /10</span>
        <span className="flex items-center gap-1 text-agent-b">{label("B")} B <AgentIcon side="B" className="w-4 h-4" color={SIDE.B.hex} /></span>
      </div>
      <div className={`grid ${big ? "gap-4" : "gap-2"}`}>
        {DIMS.map((d, i) => (
          <div key={d.key} className={`grid grid-cols-[1fr_auto_1fr] items-center gap-2 font-black ${big ? "text-xl" : "text-xs"}`}>
            <div className="flex items-center justify-end gap-2">
              <span>{sc.A[d.key]}</span>
              <div className={`${big ? "h-6" : "h-4"} w-full rounded-full bg-gray-200 flex justify-end overflow-hidden`}>
                <div className="h-full rounded-full bg-agent-a" style={{ width: on ? `${sc.A[d.key] * 10}%` : "0%", transition: `width 800ms cubic-bezier(.2,1.2,.4,1) ${i * 150}ms` }} />
              </div>
            </div>
            <span className={`text-center uppercase text-ink/70 ${big ? "w-36" : "w-20"}`}>{d.label}</span>
            <div className="flex items-center gap-2">
              <div className={`${big ? "h-6" : "h-4"} w-full rounded-full bg-gray-200 overflow-hidden`}>
                <div className="h-full rounded-full bg-agent-b" style={{ width: on ? `${sc.B[d.key] * 10}%` : "0%", transition: `width 800ms cubic-bezier(.2,1.2,.4,1) ${i * 150}ms` }} />
              </div>
              <span>{sc.B[d.key]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function VerdictPanel({ v, big = false, showExplanation = true }: { v: UiVerdict; big?: boolean; showExplanation?: boolean }) {
  return (
    <div className={`grid ${big ? "gap-5" : "gap-3"}`}>
      <WinnerReveal v={v} big={big} />
      <IncompleteNotice v={v} big={big} />
      <ScoreBars v={v} big={big} />
      {showExplanation && v.explanation && (
        <div className={`card animate-slide-up ${big ? "p-6 text-2xl" : "p-4 text-base"} font-bold`}>
          <p className={`font-black uppercase tracking-widest text-court ${big ? "text-lg" : "text-xs"}`}>Judge&apos;s reasoning</p>
          <p className="mt-1">{v.explanation}</p>
        </div>
      )}
    </div>
  );
}
