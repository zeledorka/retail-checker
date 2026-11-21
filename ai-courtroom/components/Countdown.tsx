"use client";
import { useCountdown } from "@/lib/useCountdown";

/** Circular timer driven by the server deadline + measured clock offset. */
export function Countdown({ deadline, start, offset, size = 64, className = "" }: { deadline: number | null | undefined; start?: number | null; offset: number; size?: number; className?: string }) {
  const { seconds, fraction } = useCountdown(deadline, offset, start);
  if (seconds === null) return null;
  const r = 44, c = 2 * Math.PI * r;
  const urgent = seconds <= 5;
  return (
    <div className={`relative shrink-0 ${urgent && seconds > 0 ? "animate-pulse" : ""} ${className}`} style={{ width: size, height: size }} role="timer" aria-label={`${seconds} seconds left`}>
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle cx="50" cy="50" r="48" style={{ fill: urgent ? "var(--color-agent-a)" : "var(--color-court-dark)" }} />
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="8" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="white" strokeWidth="8" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - (fraction ?? 1))} style={{ transition: "stroke-dashoffset 250ms linear" }} />
      </svg>
      <span className="absolute inset-0 grid place-items-center font-black text-white" style={{ fontSize: size * 0.38 }}>{seconds}</span>
    </div>
  );
}
