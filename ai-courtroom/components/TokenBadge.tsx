"use client";
import { useEffect, useRef, useState } from "react";

/** Coin + amount. Counts up/down smoothly when the server balance changes. */
export function TokenBadge({ tokens, className = "" }: { tokens: number; className?: string }) {
  const [shown, setShown] = useState(tokens);
  const from = useRef(tokens);
  useEffect(() => {
    const start = from.current, diff = tokens - start;
    if (!diff) return;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      setShown(Math.round(start + diff * k));
      if (k < 1) raf = requestAnimationFrame(step); else from.current = tokens;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = tokens; };
  }, [tokens]);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-gold px-3 py-1 font-black text-ink shadow-[0_3px_0_var(--color-gold-dark)] ${className}`} aria-label={`${tokens} tokens`}>
      <span className="grid h-5 w-5 place-items-center rounded-full bg-yellow-200 text-[11px]">🪙</span>
      {shown}
    </span>
  );
}

/** Big number that counts from `from` to `to` once (instant under prefers-reduced-motion). */
export function CountUp({ from, to, className = "" }: { from: number; to: number; className?: string }) {
  const [shown, setShown] = useState(from);
  useEffect(() => {
    if (from === to || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(to); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0 - 400) / 1200); // short pause, then count
      setShown(Math.round(from + (to - from) * Math.max(0, k)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to]);
  return <span className={className}>{shown}</span>;
}

export function Delta({ value, className = "" }: { value: number; className?: string }) {
  const cls = value > 0 ? "text-win bg-green-100" : value < 0 ? "text-agent-a bg-red-100" : "text-ink bg-gray-100";
  return <span className={`animate-pop inline-block rounded-full px-3 py-1 font-black ${cls} ${className}`}>{value > 0 ? "+" : ""}{value}</span>;
}
