"use client";
import { useEffect, useRef } from "react";
import type { PublicArgument, Side } from "@/lib/types";
import { SpeechBubble, ThinkingBubble } from "./SpeechBubble";

/** Ordered by sequence; newest animates in; shows who is thinking next. Auto-scrolls to the newest. */
export function Transcript({ items, thinking, big = false, className = "" }: { items: PublicArgument[]; thinking?: Side | null; big?: boolean; className?: string }) {
  const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
  const end = useRef<HTMLDivElement>(null);
  const last = sorted.at(-1)?.key;
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [last, thinking]);
  return (
    <div className={`flex flex-col gap-3 overflow-y-auto no-scrollbar ${className}`}>
      {sorted.length === 0 && !thinking && <p className="text-center font-bold text-white/70">The court is waiting for the first statement…</p>}
      {sorted.map((a) => <SpeechBubble key={a.key} arg={a} big={big} newest={a.key === last} />)}
      {thinking && <ThinkingBubble side={thinking} big={big} />}
      <div ref={end} />
    </div>
  );
}
