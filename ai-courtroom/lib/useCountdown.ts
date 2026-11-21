"use client";
import { useEffect, useState } from "react";

/**
 * Countdown to a SERVER deadline. serverNow ~= Date.now() + offset, so remaining = deadline - (Date.now() + offset).
 * Never starts a local timer from a click: it only ever reads the server's timestamps.
 *
 * The clock is read ONLY in effects (never during render / in a useState initializer), so the prerendered HTML and
 * the first client render match. Until mounted it returns a deterministic placeholder (full duration, isReady: false).
 */
export function useCountdown(deadline: number | null | undefined, offset: number, start?: number | null) {
  // `for` = the deadline this reading belongs to, so a reading taken before the deadline changed is never used.
  const [tick, setTick] = useState<{ now: number; for: number | null } | null>(null);
  useEffect(() => {
    const d = deadline ?? null;
    setTick({ now: Date.now(), for: d });
    if (!d) return;
    const id = setInterval(() => setTick({ now: Date.now(), for: d }), 250);
    return () => clearInterval(id);
  }, [deadline]);

  const now = tick && tick.for === (deadline ?? null) ? tick.now : null;
  if (!deadline) return { msLeft: null, seconds: null, fraction: null, expired: false, isReady: tick !== null };
  const total = start ? Math.max(1, deadline - start) : null;
  if (now === null) {
    // Placeholder before mount: same on server and client.
    return { msLeft: total, seconds: total !== null ? Math.ceil(total / 1000) : null, fraction: total !== null ? 1 : null, expired: false, isReady: false };
  }
  const msLeft = Math.max(0, deadline - (now + offset));
  return {
    msLeft,
    seconds: Math.ceil(msLeft / 1000),
    /** 1 -> 0 over the phase, when the start is known. */
    fraction: total ? Math.min(1, msLeft / total) : null,
    expired: msLeft <= 0,
    isReady: true,
  };
}
